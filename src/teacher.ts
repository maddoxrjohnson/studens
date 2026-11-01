import { refillOutputPlan, refillOutputSchema } from "./refill-output.ts";
import type { RefillOutputTarget } from "./refill-output.ts";
/** Dedicated teachers return a plan. Only the classroom service applies it. */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { joinPrompt, splitPrompt } from "./prompt-split.ts";
import { JsonObjectStream } from "./json-object-stream.ts";
import { readConfig } from "./config.ts";
import { cachedClaudeModels, claudeModels } from "./teacher-models.ts";
import type { ModelCatalog, ModelChoice } from "./teacher-models.ts";
import { TeacherDeadline } from "./teacher-deadline.ts";
import { LESSON_OUTPUT_SCHEMA, lessonModelPlan } from "./lesson-output.ts";
import { passageAnswerSchema, passageAnswerPlan } from "./passage-answer.ts";
import { disputeOutputSchema, disputeOutputPlan } from "./dispute-output.ts";
import type { DisputeOutputTarget } from "./dispute-output.ts";
import {
  retrievalOutputPlan,
  retrievalOutputSchema,
  returnsRetrievalCheck,
} from "./retrieval-output.ts";
import type { RetrievalOutputTarget } from "./retrieval-output.ts";

/** Process-wide discovery precedes per-thread settings; keep apps and plugins off at both boundaries. */
export const CODEX_TEACHER_DISABLED_FEATURES = [
  "apps",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "shell_tool",
  "unified_exec",
  "multi_agent",
  "browser_use",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "view_image",
] as const;
export const CODEX_TEACHER_ARGS = [
  "app-server",
  "--stdio",
  ...CODEX_TEACHER_DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
];
export const CODEX_TEACHER_FEATURES = Object.fromEntries(
  CODEX_TEACHER_DISABLED_FEATURES.map((name) => [name, false]),
);

export type Backend = "codex" | "claude" | "pi";
export interface TeacherIdentity {
  backend: Backend;
  sessionId?: string;
  requestedModel?: string | null;
  /** Transient per-request effort from `teacherRequestOverrides`; never saved. */
  requestEffort?: string;
  selectionRevision?: number;
  activeModel?: string;
  activeRequestedModel?: string | null;
  activeModelAt?: number;
}
export interface TeacherPlan {
  calls: Array<{ name: string; arguments_json: string }>;
  message: string;
  learning_record: string;
  notes_markdown: string;
}
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            enum: [
              "answer_lesson_question",
              "grade_lesson_quiz",
              "grade_quiz_answers",
              "record_retrieval_check",
              "publish_review",
              "publish_lesson",
              "resolve_grade_dispute",
            ],
          },
          arguments_json: { type: "string" },
        },
        required: ["name", "arguments_json"],
      },
    },
    message: { type: "string" },
    learning_record: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: { markdown: { type: "string", minLength: 1, pattern: "\\S" } },
          required: ["markdown"],
        },
      ],
    },
    notes_markdown: { type: "string" },
  },
  required: ["calls", "message", "learning_record", "notes_markdown"],
};
export type TeacherOperation = TeacherPlan["calls"][number]["name"];
export interface PlanContract {
  operations: TeacherOperation[];
  /** Selected by the current request, never inferred from model output or saved plans. */
  response?: "passage-answer" | "dispute-resolution" | "review-variants" | "retrieval-check";
  passageAnnotationId?: string;
  retrievalTarget?: RetrievalOutputTarget;
  disputeTarget?: DisputeOutputTarget;
  refillTarget?: RefillOutputTarget;
  required?: boolean;
  messageRequired?: boolean;
  notesAllowed?: boolean;
  research?: boolean;
}

/** Limit structured output to operations permitted by the current request. */
export function planSchema(contract: PlanContract) {
  if (contract.response === "review-variants") return refillOutputSchema(contract.refillTarget);
  if (contract.response === "retrieval-check")
    return retrievalOutputSchema(contract.retrievalTarget);
  if (contract.response === "dispute-resolution")
    return disputeOutputSchema(contract.disputeTarget);
  if (contract.response === "passage-answer")
    return passageAnswerSchema(contract.passageAnnotationId);
  if (contract.operations.length === 1 && contract.operations[0] === "publish_lesson")
    return LESSON_OUTPUT_SCHEMA;
  const calls = PLAN_SCHEMA.properties.calls;
  return {
    ...PLAN_SCHEMA,
    properties: {
      ...PLAN_SCHEMA.properties,
      notes_markdown: contract.notesAllowed
        ? PLAN_SCHEMA.properties.notes_markdown
        : { type: "string", enum: [""] },
      message: contract.messageRequired
        ? { type: "string", minLength: 1, pattern: "\\S" }
        : PLAN_SCHEMA.properties.message,
      calls: {
        ...calls,
        minItems: contract.required ? 1 : 0,
        ...(contract.required
          ? { maxItems: 1 }
          : contract.operations.length
            ? {}
            : { maxItems: 0 }),
        items: {
          ...calls.items,
          properties: {
            ...calls.items.properties,
            name: contract.operations.length
              ? { type: "string", enum: contract.operations }
              : { type: "string" },
          },
        },
      },
    },
  };
}
export type RunTeacher = (
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  saveIdentity: (sessionId: string) => void,
  signal: AbortSignal | undefined,
  contract: PlanContract,
  saveModelOutput?: (value: unknown) => void,
  saveActiveModel?: (model: string) => void,
  saveStreamDigest?: (digest: StreamDigest) => void,
) => Promise<TeacherPlan>;

/** A small private summary of a Claude stream, saved so a failure can be diagnosed later. */
export interface StreamDigest {
  text: Array<{ chars: number; start: string }>;
  tools: string[];
  toolErrors: string[];
  /** Start of the final result text when the CLI reported an error. */
  resultError?: string;
}
/** Plan operations are returned in the structured plan; a native call to one is a failure. */
export interface StreamGuard {
  operations: readonly string[];
  /** Whether the final structured output returned this operation. */
  returned: (output: unknown, operation: string) => boolean;
  saveDigest?: (digest: StreamDigest) => void;
}
/** Whether raw structured output includes an operation, by this request's response format. */
export function returnsOperation(contract: PlanContract, output: unknown, operation: string) {
  if (contract.response === "retrieval-check")
    return operation === "record_retrieval_check" && returnsRetrievalCheck(output);
  // Other typed responses always encode their single operation; their decoders validate it.
  if (contract.response || contract.operations[0] === "publish_lesson") return true;
  const calls = (output as { calls?: unknown } | null)?.calls;
  return (
    Array.isArray(calls) &&
    calls.some((call) => (call as { name?: unknown } | null)?.name === operation)
  );
}

export function parsePlan(value: unknown): TeacherPlan {
  if (!value || typeof value !== "object") throw new Error("Teacher returned no plan.");
  const p = value as TeacherPlan;
  if (
    !Array.isArray(p.calls) ||
    typeof p.message !== "string" ||
    typeof p.learning_record !== "string" ||
    typeof p.notes_markdown !== "string" ||
    p.calls.some((c) => !c || typeof c.name !== "string" || typeof c.arguments_json !== "string")
  ) {
    throw new Error("Teacher returned an invalid plan.");
  }
  return p;
}

/** Decode explicit absence without treating descriptive text as an absent record. */
export function parseModelPlan(value: unknown): TeacherPlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Teacher returned no plan.");
  const record = (value as Record<string, unknown>).learning_record;
  if (
    record !== null &&
    (!record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 1 ||
      !("markdown" in record) ||
      typeof record.markdown !== "string" ||
      !record.markdown.trim())
  )
    throw new Error("Teacher learning_record must be null or an object with nonblank markdown.");
  return parsePlan({ ...value, learning_record: record === null ? "" : record.markdown });
}

export const runTeacher: RunTeacher = async (
  identity,
  prompt,
  cwd,
  saveIdentity,
  signal,
  contract,
  saveModelOutput,
  saveActiveModel,
  saveStreamDigest,
) => {
  const raw = await runStructured(
    identity,
    contract.response === "review-variants"
      ? prompt +
          "\n\nCurrent response format: typed refill data only: classroom, request_id, variants. Each variant contains id, html, rubric, task. Return direct HTML strings, not calls or arguments_json. The host supplies original objective and independent support and serializes the canonical call. Use null for absent grading. Supply criteria on each rubric. Expected answers use the same typed data as lesson output: direct strings/lists/numeric objects, and {entries:[{key,value}]} only for keyed match/cloze maps."
      : contract.operations.includes("save_review_variants")
        ? prompt +
          "\n\nCurrent response format: canonical service plan and save_review_variants plan operation arguments. The earlier explicit-lesson response schema applies only to publish_lesson. Here rubric.expected uses canonical private keys directly: a string option id for choice, id arrays for multi/order/locate, a value/tolerance/unit object for numeric, or keyed objects for match/cloze. Never use lesson-transport wrappers such as kind/value or entries around an expected answer. Follow this request's plan operation definitions and inline canonical contract. They are plan fields, not tools to call."
        : prompt,
    cwd,
    saveIdentity,
    planSchema(contract),
    signal,
    saveActiveModel,
    contract.research,
    saveModelOutput,
    {
      operations: contract.operations,
      returned: (output, operation) => returnsOperation(contract, output, operation),
      saveDigest: saveStreamDigest,
    },
  );
  saveModelOutput?.(raw);
  if (contract.response === "review-variants") return refillOutputPlan(raw, contract.refillTarget);
  if (contract.response === "retrieval-check")
    return retrievalOutputPlan(raw, contract.retrievalTarget);
  if (contract.response === "passage-answer") return passageAnswerPlan(raw);
  if (contract.response === "dispute-resolution")
    return disputeOutputPlan(raw, contract.disputeTarget);
  if (contract.operations.length === 1 && contract.operations[0] === "publish_lesson")
    return lessonModelPlan(raw);
  return parseModelPlan(raw);
};

/** Run a read-only model turn with a schema supplied by the caller. */
export async function runStructured(
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  saveIdentity: (sessionId: string) => void,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
  saveActiveModel?: (model: string) => void,
  research = false,
  saveModelOutput?: (value: unknown) => void,
  guard?: StreamGuard,
): Promise<unknown> {
  if (identity.backend !== "claude") prompt = joinPrompt(prompt);
  if (identity.backend === "pi") {
    const { runPi } = await import("./pi-teacher.ts");
    return runPi(
      identity,
      prompt,
      cwd,
      saveIdentity,
      schema,
      signal,
      saveActiveModel,
      research,
      saveModelOutput,
    );
  }
  return identity.backend === "codex"
    ? runCodex(
        identity,
        prompt,
        cwd,
        saveIdentity,
        schema,
        signal,
        saveActiveModel,
        false,
        research,
      )
    : runClaude(
        identity,
        prompt,
        cwd,
        saveIdentity,
        schema,
        signal,
        saveActiveModel,
        research,
        saveModelOutput,
        guard,
      );
}

/** Events after this run's init, so an earlier turn could never count as a call now. */
function thisRun(events: any[]): any[] {
  let start = 0;
  events.forEach((event, i) => {
    if (event?.type === "system" && event.subtype === "init") start = i + 1;
  });
  return events.slice(start);
}
const DIGEST_ITEMS = 12;
const DIGEST_CHARS = 200;
/** Summarize assistant text, native tool calls and tool errors without keeping the whole stream. */
export function claudeStreamDigest(events: any[]): StreamDigest {
  const digest: StreamDigest = { text: [], tools: [], toolErrors: [] };
  for (const event of thisRun(events)) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (event.type === "assistant" && block?.type === "text" && typeof block.text === "string")
        digest.text.push({ chars: block.text.length, start: block.text.slice(0, DIGEST_CHARS) });
      if (event.type === "assistant" && block?.type === "tool_use")
        digest.tools.push(String(block.name).slice(0, DIGEST_CHARS));
      if (event?.type === "user" && block?.type === "tool_result" && block.is_error) {
        const body =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        digest.toolErrors.push(String(body).slice(0, DIGEST_CHARS));
      }
    }
  }
  digest.text = digest.text.slice(0, DIGEST_ITEMS);
  digest.tools = digest.tools.slice(0, DIGEST_ITEMS);
  digest.toolErrors = digest.toolErrors.slice(0, DIGEST_ITEMS);
  const result = [...events].reverse().find((event) => event?.type === "result");
  if (result?.is_error)
    digest.resultError = String(result.result ?? JSON.stringify(result.errors)).slice(
      0,
      DIGEST_CHARS,
    );
  return digest;
}

async function runClaude(
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  save: (id: string) => void,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
  saveActiveModel?: (model: string) => void,
  research = false,
  saveModelOutput?: (value: unknown) => void,
  guard?: StreamGuard,
): Promise<unknown> {
  const catalog = await cachedClaudeModels(cwd);
  const model = identity.requestedModel ?? catalog.configuredModel;
  const expectedModel = catalog.models.find((m) => m.id === model)?.resolvedModel ?? model;
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(schema),
    "--tools",
    research ? "WebSearch,WebFetch" : "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--permission-mode",
    "dontAsk",
  ];
  if (research) args.push("--allowedTools", "WebSearch", "WebFetch");
  if (identity.requestEffort) args.push("--effort", identity.requestEffort);
  // Fresh mode: every request carries its full context, so a resumed session only adds cost.
  // The saved session id is neither used nor replaced, so "resume" still works afterwards.
  const fresh = readConfig().teacherSessions === "fresh";
  if (fresh) args.push("--no-session-persistence");
  else if (identity.sessionId) args.push("--resume", identity.sessionId);
  // The stable part of a cache-ordered prompt goes in a private temporary system prompt file.
  const { stable, request } = splitPrompt(prompt);
  let privateDir: string | undefined;
  if (stable !== undefined) {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "studens-teacher-"));
    const file = path.join(privateDir, "context.txt");
    fs.writeFileSync(file, stable, { mode: 0o600 });
    args.push("--append-system-prompt-file", file);
  }
  const cleanup = () => {
    if (privateDir) fs.rmSync(privateDir, { recursive: true, force: true });
  };
  const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.stdin.on("error", () => {
    child.kill();
  });
  child.stdin.end(request);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude teacher timed out after 180 seconds."));
    }, 180_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      try {
        // Best effort, before any failure: a failed exit still leaves a diagnosable digest.
        const readable = stdout
          .trim()
          .split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        guard?.saveDigest?.(claudeStreamDigest(readable));
        if (code !== 0) throw new Error(`Claude teacher exited with ${code}: ${stderr}`);
        const events = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const result = [...events].reverse().find((event) => event.type === "result");
        if (!result) throw new Error("Claude returned no result.");
        if (result.session_id && !fresh) {
          // Every request carries its full context, so a long session only adds cost.
          // An empty id makes the caller forget the session; the next request starts fresh.
          const limit = readConfig().teacherSessionMaxTokens;
          const u = result.usage ?? {};
          const used =
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
          save(limit !== undefined && used > limit ? "" : result.session_id);
        }
        if (result.is_error)
          throw new Error(
            `Claude teacher failed: ${result.result ?? JSON.stringify(result.errors)}`,
          );
        const models = [
          ...new Set<string>(
            events
              .filter((event) => event.type === "assistant" && event.message?.model)
              .map((event) => event.message.model),
          ),
        ];
        if (!models.length) throw new Error("Claude did not report the answering model.");
        if (models.some((actual) => actual !== expectedModel))
          throw new Error(
            `Claude selected model ${model} resolved to ${models.join(", ")}, expected ${expectedModel}. Choose a model and retry explicitly.`,
          );
        saveActiveModel?.(models.join(", "));
        // A stray native call is harmless only when the final plan still returned the operation.
        const called: string[] = thisRun(events)
          .filter((event) => event.type === "assistant" && Array.isArray(event.message?.content))
          .flatMap((event) => event.message.content)
          .filter((block: any) => block?.type === "tool_use")
          .map((block: any) => String(block.name));
        const stray = guard?.operations.find(
          (operation) =>
            called.some((name) => name === operation || name.endsWith(`__${operation}`)) &&
            !guard.returned(result.structured_output, operation),
        );
        if (stray) {
          saveModelOutput?.(result.structured_output);
          throw new Error(
            `Claude teacher called ${stray} as a tool instead of returning it in the plan. Retry explicitly.`,
          );
        }
        resolve(result.structured_output);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function runCodex(
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  save: (id: string) => void,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
  saveActiveModel?: (model: string) => void,
  catalogOnly = false,
  research = false,
): Promise<unknown> {
  // Dedicated teachers return plans. Installed plugins and connected apps can
  // bypass the filesystem sandbox, so an empty mcp_servers override is insufficient.

  const child = spawn("codex", CODEX_TEACHER_ARGS, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    signal,
  });
  let seq = 0,
    stderr = "",
    finalText = "";
  let threadId: string | undefined, turnId: string | undefined, failure: Error | undefined;
  const pending = new Map<
    number,
    { method: string; resolve: (v: any) => void; reject: (err: Error) => void }
  >();
  let completedResolve: () => void, completedReject: (err: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    completedResolve = resolve;
    completedReject = reject;
  });
  // Attach immediately. A process failure can precede turn/start.
  void completed.catch(() => {});
  function fail(err: Error) {
    failure ??= err;
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
    completedReject(err);
  }
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", (code) => fail(new Error(`Codex teacher exited with ${code}: ${stderr}`)));
  const deadline = new TeacherDeadline((err) => {
    fail(err);
    child.kill("SIGKILL");
  });
  const objects = new JsonObjectStream();
  child.stdout.setEncoding("utf8");
  function receive(value: unknown) {
    if (!value || typeof value !== "object" || !("id" in value || "method" in value))
      throw new Error("Invalid Codex RPC message.");
    const m = value as any;
    if (m.id !== undefined && !m.method) {
      const waiter = pending.get(m.id);
      pending.delete(m.id);
      if (waiter?.method === "thread/start" || waiter?.method === "thread/resume")
        threadId = m.result?.thread?.id;
      if (waiter?.method === "turn/start") turnId = m.result?.turn?.id;
      if (m.error) waiter?.reject(new Error(m.error.message));
      else waiter?.resolve(m.result);
    } else if (m.id !== undefined) {
      child.stdin.write(
        JSON.stringify({
          id: m.id,
          error: { code: -32601, message: "Dedicated teacher cannot use interactive tools." },
        }) + "\n",
      );
    } else if (m.params?.threadId === threadId && threadId !== undefined) {
      if (m.method === "model/rerouted" && turnId !== undefined && m.params.turnId === turnId) {
        fail(
          new Error(
            `Codex model ${m.params.fromModel} was rerouted to ${m.params.toModel}: ${m.params.reason}. Choose a model and retry explicitly.`,
          ),
        );
        child.kill();
        return;
      }
      if (m.method === "turn/started" && m.params.turn.id === turnId) {
        deadline.enter(`running turn ${turnId} in thread ${threadId}`);
      } else if (m.params.turnId === turnId && turnId !== undefined) {
        if (
          (m.method === "item/started" || m.method === "item/completed") &&
          (["mcpToolCall", "commandExecution", "fileChange"].includes(m.params.item?.type) ||
            (m.params.item?.type === "webSearch" && !research))
        ) {
          fail(
            new Error(
              `Codex dedicated teacher attempted forbidden ${m.params.item.type}. Retry only after correcting its tool scope.`,
            ),
          );
          child.kill();
          return;
        }
        if (
          /^item\/(agentMessage\/delta|reasoning\/(textDelta|summaryTextDelta))$/.test(m.method) &&
          typeof m.params.delta === "string" &&
          m.params.delta.length > 0
        )
          deadline.progress(m.method);
        if (m.method === "item/completed" && m.params.item.type === "reasoning")
          deadline.progress("completed reasoning item");
        if (m.method === "item/completed" && m.params.item.type === "agentMessage") {
          deadline.progress("received agent message");
          if (m.params.item.phase !== "commentary") finalText = m.params.item.text;
        }
      }
      if (m.method !== "turn/completed" || m.params.turn.id !== turnId) return;
      if (m.params.turn.status !== "completed")
        completedReject(
          new Error(`Codex turn ${m.params.turn.status}: ${JSON.stringify(m.params.turn.error)}`),
        );
      else completedResolve();
    }
  }
  child.stdout.on("data", (chunk: string) => {
    if (failure) return;
    try {
      objects.push(chunk, receive);
    } catch (err) {
      fail(new Error(`Invalid Codex stdout: ${(err as Error).message}`, { cause: err }));
    }
  });
  child.stdout.on("end", () => {
    try {
      objects.finish();
    } catch (err) {
      fail(err as Error);
    }
  });
  function request(method: string, params: unknown): Promise<any> {
    if (failure) return Promise.reject(failure);
    deadline.enter(`waiting for ${method}`);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "studens_teacher", version: "0.11.0" } });
    child.stdin.write('{"method":"initialized","params":{}}\n');
    const settings = await request("config/read", { includeLayers: false, cwd });
    let model = identity.requestedModel ?? settings.config?.model;
    if (catalogOnly || !model) {
      const models: ModelChoice[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      let defaultModel: string | undefined;
      do {
        const page = await request("model/list", { includeHidden: true, cursor });
        if (!Array.isArray(page.data)) throw new Error("Codex returned no model catalog.");
        for (const entry of page.data) {
          if (typeof entry.model !== "string" || typeof entry.displayName !== "string")
            throw new Error("Codex returned an invalid model catalog entry.");
          models.push({ id: entry.model, label: entry.displayName });
          if (entry.isDefault) defaultModel = entry.model;
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("Codex model catalog repeated a pagination cursor.");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const configuredModel = settings.config?.model ?? defaultModel;
      if (!configuredModel) throw new Error("Codex did not report a configured default model.");
      if (!models.some((entry) => entry.id === configuredModel))
        models.push({ id: configuredModel, label: `${configuredModel} (configured)` });
      if (catalogOnly) return { models, configuredModel };
      model ??= configuredModel;
    }
    const configuredServers = settings.config?.mcp_servers;
    if (
      configuredServers !== undefined &&
      configuredServers !== null &&
      (typeof configuredServers !== "object" || Array.isArray(configuredServers))
    )
      throw new Error("Codex returned an invalid MCP server configuration.");
    const config = {
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        mcp_servers: Object.fromEntries(
          Object.keys(configuredServers ?? {}).map((name) => [name, { enabled: false }]),
        ),
        features: CODEX_TEACHER_FEATURES,
        web_search: research ? "live" : "disabled",
      },
    };
    const result = identity.sessionId
      ? await request("thread/resume", { ...config, threadId: identity.sessionId })
      : await request("thread/start", config);
    save(result.thread.id);
    if (typeof result.model !== "string" || result.model !== model)
      throw new Error(
        `Codex selected model ${model} resolved to ${result.model ?? "unknown"}. Choose a model and retry explicitly.`,
      );
    let inventoryCursor: string | null = null;
    const inventoryCursors = new Set<string>();
    do {
      const page = await request("mcpServerStatus/list", {
        threadId: result.thread.id,
        detail: "full",
        cursor: inventoryCursor,
      });
      if (
        !Array.isArray(page.data) ||
        !(
          page.nextCursor === null ||
          (typeof page.nextCursor === "string" && page.nextCursor.length > 0)
        )
      )
        throw new Error("Codex returned an invalid dedicated-teacher MCP inventory.");
      if (page.data.length)
        throw new Error(
          `Codex dedicated teacher still exposes MCP servers: ${page.data.map((server: any) => server.name).join(", ")}. No model turn was started.`,
        );
      inventoryCursor = page.nextCursor;
      if (inventoryCursor && inventoryCursors.has(inventoryCursor))
        throw new Error("Codex MCP inventory repeated a pagination cursor.");
      if (inventoryCursor) inventoryCursors.add(inventoryCursor);
    } while (inventoryCursor);
    await request("turn/start", {
      threadId: result.thread.id,
      model,
      input: [{ type: "text", text: prompt }],
      outputSchema: schema,
    });
    deadline.enter(`running turn ${turnId} in thread ${threadId}`);
    await completed;
    if (failure) throw failure;
    let value: unknown;
    try {
      value = JSON.parse(finalText);
    } catch (err) {
      throw new Error(`Invalid Codex teacher plan JSON: ${(err as Error).message}`, { cause: err });
    }
    saveActiveModel?.(result.model);
    return value;
  } finally {
    deadline.stop();
    child.stdin.end();
    child.kill();
  }
}

/** Discover choices through the same installed/authenticated transport as inference. */
export async function teacherModels(backend: Backend, cwd: string): Promise<ModelCatalog> {
  if (backend === "pi") {
    const { piModels } = await import("./pi-teacher.ts");
    return piModels(cwd);
  }
  return backend === "claude"
    ? claudeModels(cwd)
    : ((await runCodex(
        { backend },
        "",
        cwd,
        () => {},
        {},
        undefined,
        undefined,
        true,
      )) as ModelCatalog);
}

/**
 * The identity a request runs under. A local `teacherRequestOverrides` entry for a light
 * request kind picks its model and effort unless the classroom chose a model itself.
 */
export function requestIdentity(
  identity: TeacherIdentity,
  request: { kind: string; requestedModel?: string | null },
): TeacherIdentity {
  const base = { ...identity, requestedModel: request.requestedModel };
  if (identity.backend !== "claude") return base;
  const override = (
    readConfig().teacherRequestOverrides as
      Record<string, { model?: string; effort?: string } | undefined> | undefined
  )?.[request.kind];
  if (!override) return base;
  return {
    ...base,
    requestedModel: request.requestedModel ?? override.model ?? null,
    requestEffort: override.effort,
  };
}
