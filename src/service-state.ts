import { StateReadError, stateReadError } from "./state-errors.ts";
/** Durable requests and teacher ownership. This file is never served as an asset. */
import * as fs from "node:fs";
import * as path from "node:path";
import { classroomDir, isValidSlug } from "./paths.ts";
import { modelSelection } from "./teacher-models.ts";
import type { GradeDispute, DisputeResolution } from "./grade-dispute.ts";
import type { StreamDigest, TeacherIdentity, TeacherPlan } from "./teacher.ts";

export interface TeacherRequest {
  id: string;
  classroom: string;
  lesson: string;
  kind:
    | "ask"
    | "follow-up"
    | "quiz"
    | "reflect"
    | "chat"
    | "review"
    | "resume"
    | "refill"
    | "lesson"
    | "dispute";
  target: string;
  dispute?: GradeDispute;
  disputeDecision?: DisputeResolution["decision"];
  turn?: string;
  prompt: string;
  at: number;
  startedAt?: number;
  finishedAt?: number;
  status: "queued" | "running" | "planned" | "done" | "failed";
  error?: string;
  plan?: TeacherPlan;
  /** Original model response, saved before contract decoding. */
  modelOutput?: unknown;
  /** Snapshot taken only when a new inference request starts. */
  requestedModel?: string | null;
  resolvedModel?: string;
  originatingIdentity?: TeacherIdentity;
  /**
   * Version 2 uses score-free grade_quiz_answers. Version 3 is a panel reply plan whose
   * retrieval check code serialized from typed output. Absent on older saved plans.
   */
  planVersion?: 2 | 3;
  planRubricDigest?: string;
  planValidated?: boolean;
  applied?: number;
  recordFile?: string;
  /** Private summary of the last Claude stream for this request, for diagnosis. */
  streamDigest?: StreamDigest;
}
export interface TeacherMessage {
  id: string;
  lesson: string;
  role: "learner" | "teacher";
  text: string;
  at: number;
  /** Server-selected panel task this learner actually replied to; absent historically. */
  replyTo?: string;
}
export interface TeacherState {
  version: 1;
  identity: TeacherIdentity;
  previousIdentities?: TeacherIdentity[];
  requests: TeacherRequest[];
  messages: TeacherMessage[];
}
function file(classroom: string): string {
  if (!isValidSlug(classroom)) throw new Error("Invalid classroom.");
  return path.join(classroomDir(classroom), ".teacher.json");
}
export function readTeacherState(classroom: string): TeacherState | null {
  try {
    const state = JSON.parse(fs.readFileSync(file(classroom), "utf8")) as TeacherState;
    if (
      state.version !== 1 ||
      !["codex", "claude", "pi"].includes(state.identity.backend) ||
      !Array.isArray(state.requests) ||
      state.requests.some(
        (request) => request.planVersion !== undefined && ![2, 3].includes(request.planVersion),
      ) ||
      !Array.isArray(state.messages)
    )
      throw new StateReadError(`Invalid teacher state for ${classroom}.`);
    if (state.identity.requestedModel !== undefined) modelSelection(state.identity.requestedModel);
    if (
      state.identity.selectionRevision !== undefined &&
      (!Number.isSafeInteger(state.identity.selectionRevision) ||
        state.identity.selectionRevision < 0)
    )
      throw new Error(`Invalid model selection revision for ${classroom}.`);
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw stateReadError(`teacher state ${classroom}/.teacher.json`, err);
  }
}
export function saveTeacherState(classroom: string, state: TeacherState): void {
  const target = file(classroom),
    temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}
