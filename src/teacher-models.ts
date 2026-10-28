/** Read Claude's installed model catalog and effective settings without an inference turn. */
import { spawn } from "node:child_process";
import { readConfig } from "./config.ts";
import { JsonObjectStream } from "./json-object-stream.ts";

export interface ModelChoice {
  id: string;
  label: string;
  resolvedModel?: string;
}
export interface ModelCatalog {
  models: ModelChoice[];
  configuredModel: string;
}
export function modelSelection(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 200 ||
    /[\s\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(
      "Model ID must contain 1 to 200 characters without whitespace or control characters, or be null for the configured default.",
    );
  return value;
}

const catalogCache = new Map<string, { at: number; catalog: ModelCatalog }>();
/** `claudeModels` reused for `teacherModelCatalogSeconds`; failures are never cached. */
export async function cachedClaudeModels(cwd: string): Promise<ModelCatalog> {
  const ttl = (readConfig().teacherModelCatalogSeconds ?? 0) * 1000;
  const hit = catalogCache.get(cwd);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.catalog;
  const catalog = await claudeModels(cwd);
  if (ttl > 0) catalogCache.set(cwd, { at: Date.now(), catalog });
  return catalog;
}
export function _clearModelCatalogCache(): void {
  catalogCache.clear();
}

export async function claudeModels(cwd: string): Promise<ModelCatalog> {
  const child = spawn(
    "claude",
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--permission-mode",
      "dontAsk",
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  return new Promise((resolve, reject) => {
    let catalog: ModelChoice[];
    const timer = setTimeout(
      () =>
        finish(
          new Error("Claude model discovery timed out after 30 seconds. Retry loading models."),
        ),
      30_000,
    );
    let settled = false;
    function finish(error?: Error, value?: ModelCatalog) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(value!);
    }
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.on("close", (code) =>
      finish(new Error(`Claude model discovery exited with ${code}: ${stderr}`)),
    );
    const objects = new JsonObjectStream();
    child.stdout.setEncoding("utf8");
    const send = (id: string) =>
      child.stdin.write(
        JSON.stringify({ type: "control_request", request_id: id, request: { subtype: id } }) +
          "\n",
      );
    child.stdout.on("data", (chunk) => {
      try {
        objects.push(chunk, (value) => {
          const m = value as any;
          if (m.type !== "control_response") return;
          const r = m.response;
          if (r.subtype !== "success") throw new Error(`Claude model discovery: ${r.error}`);
          if (r.request_id === "initialize") {
            if (!Array.isArray(r.response.models))
              throw new Error("Claude initialization returned no model catalog.");
            catalog = r.response.models.map((model: any) => ({
              id: modelSelection(model.value)!,
              label: model.displayName,
              resolvedModel: model.resolvedModel,
            }));
            send("get_settings");
          } else if (r.request_id === "get_settings") {
            const configuredModel =
              process.env.ANTHROPIC_MODEL ||
              r.response.effective?.model ||
              catalog.find((m) => m.id === "default")?.resolvedModel;
            if (!configuredModel)
              throw new Error("Claude did not report a configured default model.");
            modelSelection(configuredModel);
            if (!catalog.some((m) => m.id === configuredModel))
              catalog.push({ id: configuredModel, label: `${configuredModel} (configured)` });
            finish(undefined, { models: catalog, configuredModel });
          }
        });
      } catch (error) {
        finish(error as Error);
      }
    });
    send("initialize");
  });
}
