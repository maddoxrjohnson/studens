/** A dedicated Pi conversation. The service alone applies the returned plan. */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { readLessonSource } from "./lesson-research.ts";
import { privateStatePath, safeStaticFile } from "./paths.ts";
import type { ModelCatalog } from "./teacher-models.ts";
import type { TeacherIdentity } from "./teacher.ts";
import { isRefillOutputSchema } from "./refill-output.ts";
import { isRetrievalOutputSchema } from "./retrieval-output.ts";
import { LESSON_OUTPUT_SCHEMA } from "./lesson-output.ts";

/** Responses supports the lesson's structured unions, which Pi's generic strict
 * schema converter currently refuses. Set strict on the serialized function via
 * the SDK payload hook, preserving our already closed, all-required schema.
 * This is generation enforcement; SDK and service validation still run as usual.
 */
export function piLessonPayload(schema: Record<string, unknown>): SimpleStreamOptions["onPayload"] {
  return (payload, model) => {
    if (
      (schema !== LESSON_OUTPUT_SCHEMA && !isRefillOutputSchema(schema)) ||
      !["openai-codex-responses", "openai-responses"].includes(model.api)
    )
      return;
    if (
      model.compat &&
      "supportsStrictMode" in model.compat &&
      model.compat.supportsStrictMode === false
    )
      throw new Error(
        "Pi lesson/refill authoring requires Responses strict tools. Choose a compatible model and retry explicitly.",
      );
    const body = payload as {
      tools?: Array<{ type?: string; name?: string; parameters?: unknown; strict?: boolean }>;
    };
    const plans = body.tools?.filter(
      (tool) => tool.type === "function" && tool.name === "submit_teacher_plan",
    );
    if (plans?.length !== 1 || JSON.stringify(plans[0].parameters) !== JSON.stringify(schema))
      throw new Error(
        "Pi lesson/refill request did not serialize the current submit_teacher_plan schema. Retry explicitly.",
      );
    plans[0].strict = true;
  };
}

export function piTeacherResources(cwd: string) {
  const source = SettingsManager.create(cwd, getAgentDir());
  const errors = source.drainErrors();
  if (errors.length)
    throw new Error(`Pi configuration: ${errors.map(({ error }) => error.message).join("; ")}`);
  const settings = SettingsManager.inMemory({
    ...source.getGlobalSettings(),
    ...source.getProjectSettings(),
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    cacheWarming: "off",
    // Resource discovery precedes the SDK loader flags and can install packages.
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  return { settings, loader };
}

async function configuration(cwd: string) {
  const { settings, loader } = piTeacherResources(cwd);
  const runtime = await ModelRuntime.create({
    authPath: path.join(getAgentDir(), "auth.json"),
    modelsPath: path.join(getAgentDir(), "models.json"),
  });
  const provider = settings.getDefaultProvider(),
    id = settings.getDefaultModel();
  if (!provider || !id)
    throw new Error(
      "Pi has no configured provider/model. Select one in Pi, then retry explicitly.",
    );
  return { runtime, settings, loader, configuredModel: `${provider}/${id}` };
}
export async function piModels(cwd: string): Promise<ModelCatalog> {
  const { runtime, configuredModel } = await configuration(cwd);
  return {
    configuredModel,
    models: (await runtime.getAvailable()).map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: `${model.name} (${model.provider}/${model.id})`,
    })),
  };
}

/** Construct a fresh request loadout, even when reopening the same saved conversation. */
export function piTeacherTools(
  schema: Record<string, unknown>,
  research = false,
  ownerSignal?: AbortSignal,
) {
  let output: unknown;
  let count = 0;
  let sources = 0;
  let batchHasPlan = false;
  let failure: Error | undefined;
  const requireLive = (toolSignal?: AbortSignal) => {
    if (ownerSignal?.aborted || toolSignal?.aborted)
      throw new Error("Pi teacher request was interrupted. Retry explicitly.");
  };
  const requireOpen = () => {
    if (failure) throw failure;
    if (count) throw new Error("Pi already submitted its plan. End this turn.");
  };
  const customTools: ToolDefinition[] = [
    {
      name: "submit_teacher_plan",
      label: "Submit Teacher Plan",
      description:
        "Return exactly one complete structured result for the current request. This only records output; the service validates and applies it after the turn ends.",
      parameters: schema as any,
      executionMode: "sequential",
      async execute(_id, args, toolSignal) {
        requireLive(toolSignal);
        if (failure) throw failure;
        if (++count !== 1)
          throw new Error("Pi returned more than one teacher plan. Retry explicitly.");
        output = args;
        return {
          content: [{ type: "text", text: "Plan recorded. End this turn." }],
          details: {},
          // Complete the SDK loop; every call already in this batch still runs.
          terminate: true,
        };
      },
    },
  ];
  if (research)
    customTools.push({
      name: "read_lesson_source",
      label: "Read Public Lesson Source",
      description:
        "Read an HTTP(S) public source only for this explicit lesson request. At most five sources, five redirects per source, 2 MB and 30 seconds per network step. Private networks and credentials are refused. Classroom resources are already supplied in the request; this tool cannot read files.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { url: { type: "string" } },
        required: ["url"],
      } as any,
      executionMode: "sequential",
      async execute(_id, args, toolSignal) {
        try {
          requireLive(toolSignal);
          requireOpen();
          if (++sources > 5) throw new Error("Pi lesson research exceeded five sources.");
          const researchSignal =
            ownerSignal && toolSignal
              ? AbortSignal.any([ownerSignal, toolSignal])
              : (ownerSignal ?? toolSignal);
          const text = await readLessonSource(args, researchSignal);
          requireLive(toolSignal);
          return {
            content: [{ type: "text", text }],
            details: {},
            // The SDK stops only if every result in the batch requests it.
            // Research alone must continue; a mixed batch ends after its plan.
            terminate: batchHasPlan,
          };
        } catch (error) {
          failure ??= new Error(
            `Pi lesson research failed: ${error instanceof Error ? error.message : String(error)} Retry explicitly.`,
          );
          throw failure;
        }
      },
    });
  return {
    tools: customTools.map((tool) => tool.name),
    customTools,
    beginBatch(toolNames: string[]) {
      batchHasPlan = toolNames.includes("submit_teacher_plan");
    },
    fail(error: Error) {
      failure ??= error;
    },
    throwFailure() {
      if (failure) throw failure;
    },
    result() {
      if (failure) throw failure;
      requireLive();
      if (count !== 1 || output === undefined)
        throw new Error("Pi teacher returned no single structured plan. Retry explicitly.");
      return output;
    },
  };
}

/** Native validation and tool lookup can fail before a custom execute is called. */
export function observePiTeacherRequest(
  session: Pick<AgentSession, "subscribe" | "abort">,
  loadout: ReturnType<typeof piTeacherTools>,
  interrupt: () => void,
  saveModelOutput?: (value: unknown) => void,
) {
  const fail = (error: Error) => {
    loadout.fail(error);
    interrupt();
    void session.abort();
  };
  return session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant")
      loadout.beginBatch(
        event.message.content.filter((part) => part.type === "toolCall").map((part) => part.name),
      );
    if (event.type === "tool_execution_start" && event.toolName === "submit_teacher_plan") {
      try {
        // Persist the actual arguments before the SDK's own schema validation.
        saveModelOutput?.(event.args);
      } catch (error) {
        fail(
          new Error(
            `Pi teacher could not save raw plan: ${error instanceof Error ? error.message : String(error)} Retry explicitly.`,
          ),
        );
      }
    }
    if (event.type === "tool_execution_end" && event.isError) {
      const result = event.result as { content?: { type: string; text?: string }[] };
      const detail = result.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        // SDK AJV diagnostics append the complete private plan arguments.
        // Keep that dump in SDK history, never in the learner-visible error.
        .split("\n\nReceived arguments:")[0];
      fail(
        new Error(
          `Pi teacher tool ${event.toolName} failed: ${detail || "native SDK tool failure"} Retry explicitly.`,
        ),
      );
    }
  });
}

/** Repeat the current canonical envelope at the request boundary, after older formats. */
export function piTeacherRequestPrompt(
  prompt: string,
  schema: Record<string, unknown>,
  research = false,
): string {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = schema.required;
  const canonical =
    properties &&
    Array.isArray(required) &&
    ["calls", "message", "learning_record", "notes_markdown"].every(
      (name) => Object.hasOwn(properties, name) && required.includes(name),
    );
  const envelope = isRefillOutputSchema(schema)
    ? `\n\nCURRENT submit_teacher_plan refill schema:\n${JSON.stringify(schema)}\nReturn classroom, request_id and variants only. Copy the saved identity and exact variant count. Each variant contains id, html, rubric and task, with direct HTML strings. Earlier canonical calls and lesson envelopes do not apply.`
    : schema === LESSON_OUTPUT_SCHEMA
      ? `\n\nCURRENT submit_teacher_plan lesson schema for this request:\n${JSON.stringify(schema)}\nReturn the typed lesson fields. The inline private-file examples describe the files the host writes, not additional response rows. Each variants item combines quiz, question, id, html, rubric and task in one object, exactly once. Earlier service calls envelopes do not apply to this request.`
      : properties &&
          Object.hasOwn(properties, "dispute_id") &&
          Object.hasOwn(properties, "decision")
        ? `\n\nCURRENT submit_teacher_plan dispute response schema:\n${JSON.stringify(schema)}\nReturn only dispute_id, decision, question and message. Use the exact dispute_id from this schema, not the prefixed queue id. Set question to null for a declined or flagged dispute. Earlier lesson, passage and canonical calls envelopes do not apply.`
        : properties &&
            Array.isArray(required) &&
            ["annotation_id", "answer_markdown"].every(
              (name) => Object.hasOwn(properties, name) && required.includes(name),
            )
          ? `\n\nCURRENT submit_teacher_plan passage answer schema for this request:\n${JSON.stringify(schema)}\nReturn only annotation_id and answer_markdown. The service serializes the operation. Earlier lesson, refill and canonical calls envelopes do not apply to this request.`
          : isRetrievalOutputSchema(schema)
            ? `\n\nCURRENT submit_teacher_plan panel reply schema for this request:\n${JSON.stringify(schema)}\nReturn only message, retrieval_check and notes_markdown. Use retrieval_check: null unless this reply demonstrates understanding; a non-null check carries its learning record. The service supplies the classroom and exact reply and serializes record_retrieval_check. Earlier canonical calls envelopes do not apply to this request.`
            : canonical
              ? `\n\nCURRENT submit_teacher_plan outer envelope and field constraints for this request:\n${JSON.stringify(schema)}\nInclude every required top-level field. When the current schema permits calls: [], a prose-only reply still needs its actual learner-facing message and every other required field. Use learning_record: null when no learning record qualifies, and notes_markdown: "" when there is no note. Do not omit these fields. Follow this current envelope rather than an earlier lesson or refill response format.`
              : "";
  return `${prompt}${research ? "\n\nFor public web research use read_lesson_source. Classroom resources are supplied above. Return the typed lesson data through submit_teacher_plan; it does not publish directly." : ""}${envelope}\n\nReturn your complete structured result by calling submit_teacher_plan exactly once. Do not answer the learner outside that plan. End your turn after the tool accepts it.`;
}

export async function runPi(
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  save: (id: string) => void,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
  active?: (model: string) => void,
  research = false,
  saveModelOutput?: (value: unknown) => void,
): Promise<unknown> {
  const { runtime, settings, loader, configuredModel } = await configuration(cwd);
  const selected = identity.requestedModel ?? configuredModel;
  const split = selected.indexOf("/");
  if (split < 1 || split === selected.length - 1)
    throw new Error(
      `Pi model ${selected} must be an exact provider/model ID. Choose a model and retry explicitly.`,
    );
  const model = runtime.getModel(selected.slice(0, split), selected.slice(split + 1));
  if (
    !model ||
    !(await runtime.getAvailable()).some((m) => m.provider === model.provider && m.id === model.id)
  )
    throw new Error(
      `Pi model ${selected} is unavailable in the configured account/provider catalog. Choose a model and retry explicitly.`,
    );
  const dir = privateStatePath(".pi-teach-service/pi-sessions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let manager: SessionManager;
  if (identity.sessionId) {
    if (
      !/^[a-zA-Z0-9_.-]+\.jsonl$/.test(identity.sessionId) ||
      !safeStaticFile(dir, identity.sessionId)
    )
      throw new Error(
        `Pi teacher session ${identity.sessionId} is missing or unsafe. Restore its saved session before retrying; do not replace the conversation.`,
      );
    manager = SessionManager.open(path.join(dir, identity.sessionId), dir, cwd);
  } else {
    manager = SessionManager.create(cwd, dir);
    // Pi normally delays disk creation until an assistant message. Reserve its header
    // before saving the identity so an interrupted first turn can reopen the same session.
    fs.writeFileSync(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    manager = SessionManager.open(manager.getSessionFile()!, dir, cwd);
    save(path.basename(manager.getSessionFile()!));
  }
  await loader.reload();
  const scope = new AbortController();
  const scopeSignal = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  const loadout = piTeacherTools(schema, research, scopeSignal);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    model,
    modelRuntime: runtime,
    thinkingLevel: settings.getDefaultThinkingLevel(),
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: loader,
    tools: loadout.tools,
    customTools: loadout.customTools,
  });
  session.agent.onPayload = piLessonPayload(schema);
  const unsubscribe = observePiTeacherRequest(
    session,
    loadout,
    () => scope.abort(),
    saveModelOutput,
  );
  const abort = () => {
    loadout.fail(
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("Pi teacher request was interrupted. Retry explicitly."),
    );
    scope.abort();
    void session.abort();
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    loadout.fail(new Error("Pi teacher timed out after 180 seconds. Retry explicitly."));
    scope.abort();
    void session.abort();
  }, 180_000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("Pi teacher request was interrupted. Retry explicitly.");
    if (
      modelFallbackMessage ||
      session.model?.provider !== model.provider ||
      session.model?.id !== model.id
    )
      throw new Error(
        `Pi did not select ${selected}: ${modelFallbackMessage ?? "unexpected model"}. Choose a model and retry explicitly.`,
      );
    const actualTools = session.getActiveToolNames();
    if (JSON.stringify([...actualTools].sort()) !== JSON.stringify([...loadout.tools].sort()))
      throw new Error("Pi teacher exposed tools outside this request. Retry explicitly.");
    manager.appendCustomEntry("studens_teacher_scope", {
      research,
      tools: actualTools,
      selectedModel: selected,
      thinkingLevel: session.thinkingLevel,
    });
    await session.prompt(piTeacherRequestPrompt(prompt, schema, research));
    loadout.throwFailure();
    if (timedOut) throw new Error("Pi teacher timed out after 180 seconds. Retry explicitly.");
    if (signal?.aborted) throw new Error("Pi teacher request was interrupted. Retry explicitly.");
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason))
      throw new Error(
        `Pi teacher failed: ${last.errorMessage ?? last.stopReason}. Retry explicitly.`,
      );
    const output = loadout.result();
    // SDK selection only: this Pi provider does not independently report the
    // provider-resolved response model. Do not present it as that attestation.
    active?.(selected);
    return output;
  } catch (error) {
    loadout.throwFailure();
    throw error;
  } finally {
    unsubscribe();
    scope.abort(new Error("Pi teacher request ended."));
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}
