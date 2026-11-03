import { StateReadError, stateReadError } from "../state-errors.ts";
import { invalidateActivity } from "../server/events.ts";
/** Private browser lesson requests. Never expose authoring documents over HTTP. */
import * as fs from "node:fs";
import * as path from "node:path";
import { classroomDir, isValidSlug, safeStaticFile } from "../paths.ts";

export interface LessonDocument {
  title: string;
  summary: string;
  lesson_html: string;
  rubric_json: string;
  teaching_plan_json: string;
  /** Target-exam topic ids taught; null without syllabus topics. Absent in 0.13.4 plans. */
  syllabus_skills?: string[] | null;
}
export interface LessonRequest {
  id: string;
  classroom: string;
  lesson: string;
  topic: string;
  owner: "pi" | "claude" | "codex";
  ownerPid: number;
  /** Absent only on historical live-session Pi requests. */
  delivery?: "service";
  ownerSession?: string;
  at: number;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
  document?: LessonDocument;
  pageCheck?: { hash: string; report: string };
  pageCheckFailed?: boolean;
  /** The saved plan's syllabus_skills no longer match syllabus.json; retry needs a new plan. */
  syllabusCheckFailed?: boolean;
  pageCheckFailures?: Array<{ error: string; stdout: string; stderr: string }>;
  modelOutput?: unknown;
  rejectedDocuments?: LessonDocument[];
  failedAttempts?: Array<{ at: number; error?: string; output?: unknown }>;
}
function file(classroom: string): string {
  if (!isValidSlug(classroom)) throw new Error("Invalid classroom.");
  return path.join(classroomDir(classroom), ".lesson-requests.json");
}
export function lessonRequests(classroom: string): LessonRequest[] {
  try {
    const target = file(classroom);
    if (fs.existsSync(target) && !safeStaticFile(classroomDir(classroom), path.basename(target)))
      throw new StateReadError("Lesson request state cannot be a symlink.");
    const state = JSON.parse(fs.readFileSync(file(classroom), "utf8"));
    if (
      state.version !== 1 ||
      !Array.isArray(state.requests) ||
      state.requests.some(
        (r: LessonRequest) =>
          !r ||
          r.classroom !== classroom ||
          !isValidSlug(r.lesson) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.id) ||
          !["pi", "claude", "codex"].includes(r.owner) ||
          (r.delivery !== undefined && r.delivery !== "service") ||
          !Number.isSafeInteger(r.ownerPid) ||
          r.ownerPid < 1 ||
          typeof r.topic !== "string" ||
          !Number.isFinite(r.at) ||
          !["queued", "running", "done", "failed"].includes(r.status),
      )
    )
      throw new Error(`Invalid lesson requests for ${classroom}.`);
    return state.requests;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw stateReadError(`lesson request state ${classroom}/.lesson-requests.json`, error);
  }
}
export function saveLessonRequests(classroom: string, requests: LessonRequest[]): void {
  const target = file(classroom);
  if (fs.lstatSync(classroomDir(classroom)).isSymbolicLink())
    throw new Error("Lesson classroom cannot be a symlink.");
  for (const candidate of [target, `${target}.tmp`]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink())
        throw new StateReadError("Lesson request state cannot be a symlink.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  fs.writeFileSync(`${target}.tmp`, JSON.stringify({ version: 1, requests }, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(`${target}.tmp`, target);
  invalidateActivity(classroom);
}
export function updateLessonRequest(
  request: LessonRequest,
  changes: Partial<LessonRequest>,
): LessonRequest {
  const requests = lessonRequests(request.classroom);
  const saved = requests.find((r) => r.id === request.id);
  if (!saved) throw new Error("The lesson request no longer exists.");
  Object.assign(saved, changes);
  saveLessonRequests(request.classroom, requests);
  return saved;
}
