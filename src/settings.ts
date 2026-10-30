/** Validated settings edits preserve unrelated config keys and the NOTES index. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { configPath, readConfig, validateConfig } from "./config.ts";
import { classroomDir, classroomsRoot, safeStaticFile, isValidSlug } from "./paths.ts";
import * as store from "./store.ts";
import { notesStub } from "./prompts.ts";
import { DEFAULT_DAILY_REVIEW_LIMIT } from "./review.ts";

export function revision(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
function readOptional(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
/** Synchronous compare-and-replace: no teacher/event callback can interleave a file edit. */
function edit(file: string, expected: unknown, transform: (source: string) => string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.settings-lock`;
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Settings are locked by another writer. Retry after it finishes. If its process stopped, remove ${lock} before retrying.`,
      );
    throw error;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const source = readOptional(file);
    if (expected !== revision(source))
      throw new Error(
        "Settings changed since this page loaded. Reload settings before saving again.",
      );
    const next = transform(source);
    fs.writeFileSync(temp, next, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
export function connectionSettings() {
  const config = readConfig();
  return {
    revision: revision(readOptional(configPath())),
    values: {
      port: config.port ?? null,
      tailscale: config.tailscale !== false,
      tailscalePort: config.tailscalePort ?? 8443,
      piTailscalePort: config.piTailscalePort ?? 8444,
    },
    environmentPort: process.env.PI_CLASSROOM_SERVICE_PORT ?? null,
    tailnetDisabled: process.env.PI_CLASSROOM_TAILSCALE === "0",
  };
}
export function saveConnectionSettings(values: Record<string, unknown>, expected: unknown): void {
  for (const key of Object.keys(values))
    if (!["port", "tailscale", "tailscalePort", "piTailscalePort"].includes(key))
      throw new Error(`Unknown connection setting: ${key}.`);
  edit(configPath(), expected, () => {
    const config = { ...readConfig(), ...values };
    if (config.port === null) delete config.port;
    validateConfig(config);
    return JSON.stringify(config, null, 2) + "\n";
  });
}
/** `limit` is this classroom's `dailyReviewLimits` entry; null uses the shared `dailyReviewLimit`. */
export function reviewSettings(classroom: string) {
  const config = readConfig();
  const limits = config.dailyReviewLimits;
  return {
    revision: revision(readOptional(configPath())),
    values: {
      limit: limits && Object.hasOwn(limits, classroom) ? limits[classroom] : null,
      sharedLimit: config.dailyReviewLimit ?? null,
    },
    defaultLimit: DEFAULT_DAILY_REVIEW_LIMIT,
  };
}
export function saveReviewSettings(
  classroom: string,
  values: Record<string, unknown>,
  expected: unknown,
): void {
  for (const key of Object.keys(values))
    if (!["limit", "sharedLimit"].includes(key)) throw new Error(`Unknown review setting: ${key}.`);
  edit(configPath(), expected, () => {
    const config = readConfig();
    const limits = { ...config.dailyReviewLimits };
    if ("limit" in values) {
      if (values.limit === null) delete limits[classroom];
      else limits[classroom] = values.limit as number;
    }
    if (Object.keys(limits).length) config.dailyReviewLimits = limits;
    else delete config.dailyReviewLimits;
    if ("sharedLimit" in values) {
      if (values.sharedLimit === null) delete config.dailyReviewLimit;
      else config.dailyReviewLimit = values.sharedLimit as number;
    }
    validateConfig(config);
    return JSON.stringify(config, null, 2) + "\n";
  });
}
function notesFile(classroom: string): string {
  if (!isValidSlug(classroom) || !store.readClassroom(classroom))
    throw new Error("Unknown classroom.");
  if (!safeStaticFile(classroomsRoot(), classroom))
    throw new Error("Classroom settings cannot follow a symlink.");
  const target = path.join(classroomDir(classroom), "NOTES.md");
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error("NOTES.md cannot be a symlink.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}
const fields = ["pace", "depth", "tone"] as const;
export type Preferences = Record<(typeof fields)[number], string>;
function preferenceSection(source: string): { start: number; end: number } | null {
  const headings = [...source.matchAll(/^## Preferences\s*$/gm)];
  if (headings.length > 1)
    throw new Error(
      "NOTES.md has multiple Preferences sections. Keep one before editing preferences.",
    );
  if (!headings.length) return null;
  const start = headings[0].index! + headings[0][0].length;
  const tail = source.slice(start),
    next = /^## /m.exec(tail);
  return { start, end: next ? start + next.index : source.length };
}
export function learnerPreferences(classroom: string) {
  const source = readOptional(notesFile(classroom));
  const section = preferenceSection(source);
  const body = section ? source.slice(section.start, section.end) : "";
  const values = Object.fromEntries(
    fields.map((field) => {
      const matches = [...body.matchAll(new RegExp(`^- ${field}: ?(.*)$`, "gmi"))];
      if (matches.length > 1)
        throw new Error(`NOTES.md has multiple ${field} preferences. Keep one before editing.`);
      return [field, matches[0]?.[1] ?? ""];
    }),
  ) as Preferences;
  return { revision: revision(source), values };
}
export function saveLearnerPreferences(
  classroom: string,
  values: Record<string, unknown>,
  expected: unknown,
): void {
  for (const key of Object.keys(values))
    if (!fields.includes(key as keyof Preferences))
      throw new Error(`Unknown learner preference: ${key}.`);
  for (const field of fields)
    if (
      typeof values[field] !== "string" ||
      (values[field] as string).length > 200 ||
      /[\r\n\x00-\x1f\x7f]/.test(values[field] as string)
    )
      throw new Error(`${field} must be one line of at most 200 characters.`);
  // Validate duplicate labeled entries before editing.
  learnerPreferences(classroom);
  edit(notesFile(classroom), expected, (source) => {
    if (!source) source = notesStub();
    let section = preferenceSection(source);
    if (!section) {
      const index = /^## Index\b/m.exec(source)?.index ?? source.length;
      source =
        source.slice(0, index) +
        (index && !source.slice(0, index).endsWith("\n\n") ? "\n\n" : "") +
        "## Preferences\n\n" +
        source.slice(index);
      section = preferenceSection(source)!;
    }
    let body = source.slice(section.start, section.end);
    for (const field of fields) {
      const label = field[0].toUpperCase() + field.slice(1);
      const entry = values[field] ? `- ${label}: ${values[field]}` : "";
      const re = new RegExp(`^- ${field}: ?.*$`, "mi");
      if (re.test(body)) body = body.replace(re, () => entry);
      else if (entry) body = body.trimEnd() + `\n${entry}\n\n`;
    }
    return source.slice(0, section.start) + body + source.slice(section.end);
  });
}
