/** Optional settings in ~/.pi/agent/classroom.json. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const OVERRIDABLE_KINDS = ["chat", "refill", "reflect"] as const;
export type OverridableKind = (typeof OVERRIDABLE_KINDS)[number];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClassroomConfig {
  port?: number;
  tailscale?: boolean;
  tailscalePort?: number;
  piTailscalePort?: number;
  /** Local preference: hide the assistance and confidence reports; the teacher decides assistance. */
  hideAnswerReports?: boolean;
  /** Local preference: due items per review. Whole number from 3 to 12; upstream default is 5. */
  reviewSize?: number;
  /** Local preference: build a review as one form with one submit, not one card per question. */
  reviewSingleForm?: boolean;
  /** Cache Claude's model catalog this many seconds (0-3600) instead of one discovery spawn per request. */
  teacherModelCatalogSeconds?: number;
  /** "fresh" runs every Claude teacher request in a new session; the saved session is left alone. */
  teacherSessions?: "resume" | "fresh";
  /** "cache" puts the stable context first and the request last so the prompt cache can be reused. */
  teacherPromptOrder?: "default" | "cache";
  /** Start a fresh Claude teacher session once a request used more than this many input tokens. */
  teacherSessionMaxTokens?: number;
  /** Model and effort for light request kinds. Grading and lesson requests are never overridden. */
  teacherRequestOverrides?: Partial<Record<OverridableKind, { model?: string; effort?: Effort }>>;
  /** Draw the syllabus coverage pie when a classroom has a syllabus.json. On unless false. */
  syllabusPie?: boolean;
}

let testConfigPath: string | undefined;
export function _overrideConfigPath(file: string | undefined): void {
  testConfigPath = file;
}

/** `PI_CLASSROOM_CONFIG` when it is set, else `~/.pi/agent/classroom.json`. */
export function configPath(): string {
  if (testConfigPath) return testConfigPath;
  return (
    process.env["PI_CLASSROOM_CONFIG"] ?? path.join(os.homedir(), ".pi", "agent", "classroom.json")
  );
}

export function readConfig(file = configPath()): ClassroomConfig {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read classroom config ${file}`, { cause: err });
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config must be an object.");
    }
    const config = parsed as ClassroomConfig;
    validateConfig(config);
    return config;
  } catch (err) {
    const message = err instanceof SyntaxError ? "Invalid JSON syntax." : (err as Error).message;
    throw new Error(`Invalid classroom config ${file}: ${message}`, { cause: err });
  }
}

/** Use an ephemeral port only when no port is configured. */
export function resolveConfiguredPort(port: unknown): number {
  if (port === undefined) return 0;
  if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  throw new Error("Configured port must be an integer from 1 to 65535.");
}

export type TailnetHost = "service" | "pi";

/** Automatic tailnet links. `PI_CLASSROOM_TAILSCALE=0` takes priority. Pi uses port 8444. */
export function tailscaleLinks(
  host: TailnetHost,
  config: ClassroomConfig = readConfig(),
): { enabled: boolean; port?: number } {
  return {
    enabled: process.env["PI_CLASSROOM_TAILSCALE"] !== "0" && config.tailscale !== false,
    port: host === "pi" ? (config.piTailscalePort ?? 8444) : config.tailscalePort,
  };
}

/** Shared read/write validation; unknown config keys remain intact. */
export function validateConfig(config: ClassroomConfig): void {
  resolveConfiguredPort(config.port);
  if (config.tailscale !== undefined && typeof config.tailscale !== "boolean")
    throw new Error("tailscale must be a boolean.");
  for (const key of ["hideAnswerReports", "reviewSingleForm", "syllabusPie"] as const)
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      throw new Error(`${key} must be a boolean.`);
  if (
    config.reviewSize !== undefined &&
    (!Number.isInteger(config.reviewSize) || config.reviewSize < 3 || config.reviewSize > 12)
  )
    throw new Error("reviewSize must be a whole number from 3 to 12.");
  const wholeIn = (
    key: "teacherModelCatalogSeconds" | "teacherSessionMaxTokens",
    lo: number,
    hi: number,
  ) => {
    const v = config[key];
    if (v !== undefined && (!Number.isInteger(v) || v < lo || v > hi))
      throw new Error(`${key} must be a whole number from ${lo} to ${hi}.`);
  };
  if (config.teacherSessions !== undefined && !["resume", "fresh"].includes(config.teacherSessions))
    throw new Error('teacherSessions must be "resume" or "fresh".');
  if (
    config.teacherPromptOrder !== undefined &&
    !["default", "cache"].includes(config.teacherPromptOrder)
  )
    throw new Error('teacherPromptOrder must be "default" or "cache".');
  wholeIn("teacherModelCatalogSeconds", 0, 3600);
  wholeIn("teacherSessionMaxTokens", 20_000, 2_000_000);
  if (config.teacherRequestOverrides !== undefined) {
    const overrides = config.teacherRequestOverrides as Record<string, unknown>;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      throw new Error("teacherRequestOverrides must be an object.");
    for (const [kind, value] of Object.entries(overrides)) {
      if (!(OVERRIDABLE_KINDS as readonly string[]).includes(kind))
        throw new Error(
          `teacherRequestOverrides.${kind} is not allowed. Only ${OVERRIDABLE_KINDS.join(", ")} can be overridden; grading and lesson requests always use the classroom's model.`,
        );
      const o = value as { model?: unknown; effort?: unknown };
      if (!o || typeof o !== "object" || Array.isArray(o))
        throw new Error(`teacherRequestOverrides.${kind} must be an object.`);
      for (const key of Object.keys(o))
        if (key !== "model" && key !== "effort")
          throw new Error(`teacherRequestOverrides.${kind}.${key} is not a known option.`);
      if (
        o.model !== undefined &&
        (typeof o.model !== "string" || !o.model.trim() || /\s/.test(o.model))
      )
        throw new Error(
          `teacherRequestOverrides.${kind}.model must be a model ID without whitespace.`,
        );
      if (o.effort !== undefined && !(EFFORTS as readonly string[]).includes(o.effort as string))
        throw new Error(
          `teacherRequestOverrides.${kind}.effort must be one of ${EFFORTS.join(", ")}.`,
        );
    }
  }
  for (const key of ["tailscalePort", "piTailscalePort"] as const) {
    if (config[key] !== undefined) {
      try {
        resolveConfiguredPort(config[key]);
      } catch {
        throw new Error(`${key} must be an integer from 1 to 65535.`);
      }
    }
  }
}
