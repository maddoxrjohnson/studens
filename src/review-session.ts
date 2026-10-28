import { readConfig } from "./config.ts";
import { stateReadError } from "./state-errors.ts";
import { invalidateActivity } from "./server/events.ts";
/** Save browser review requests and publish only complete review documents. */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classroomDir,
  isValidSlug,
  lessonDir,
  lessonUrl,
  isStoredReview,
  privateStatePath,
} from "./paths.ts";
import { isContractId, parseReviewKey, questionErrors } from "../assets/runtime/quiz.mjs";
import {
  defaultReviewSize,
  findReviewItem,
  isDue,
  MAX_REVIEW_SIZE,
  reviewTopic,
  pickReviewItems,
  relativeDay,
  summarize,
  type ReviewItem,
} from "./review.ts";
import { authoredQuizzes, authoredQuestionShapes } from "./quiz-authoring.ts";
import { parseRubric } from "./rubric.ts";
import { parseTeachingPlan } from "./teaching-plan.ts";
import * as store from "./store.ts";
import { assembleReview, lessonPools, selectVariant } from "./review-pool.ts";
import { withReviewEdit } from "./review-lock.ts";
import { classroomWorkload, pickDailyItems } from "./review-workload.ts";
import type { PreparedVariant } from "./review-variants.ts";

export type ReviewOwner = "pi" | "service";

export interface ReviewSession {
  owner: ReviewOwner;
  ownerPid: number;
  id: string;
  classroom: string;
  lesson: string;
  at: number;
  items: ReviewItem[];
  status: "queued" | "running" | "done" | "failed";
  /** Saved before any publication writes, so recovery never needs a model. */
  document?: ReviewDocument;
  variants?: Record<string, string>;
  options?: { limit: number; topic?: string; early: boolean };
  /** Saved publication requirement; absent on legacy prepared documents. */
  criterionContract?: 1;
  error?: string;
}
export interface ReviewDocument {
  lesson_html: string;
  rubric_json: string;
  teaching_plan_json: string;
}

function file(classroom: string): string {
  if (!isValidSlug(classroom)) throw new Error("Invalid classroom.");
  return privateStatePath(`${classroom}/.reviews.json`);
}
export function reviewSessions(classroom: string): ReviewSession[] {
  try {
    const saved = JSON.parse(fs.readFileSync(file(classroom), "utf8"));
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.requests) ||
      saved.requests.some(
        (request: ReviewSession) =>
          !request ||
          request.classroom !== classroom ||
          !["pi", "service"].includes(request.owner) ||
          !Number.isSafeInteger(request.ownerPid) ||
          request.ownerPid < 1 ||
          !isValidSlug(request.lesson) ||
          typeof request.id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(request.id) ||
          !Number.isFinite(request.at) ||
          !["queued", "running", "done", "failed"].includes(request.status) ||
          (request.options !== undefined &&
            (!request.options ||
              !Number.isInteger(request.options.limit) ||
              request.options.limit < 3 ||
              request.options.limit > MAX_REVIEW_SIZE ||
              typeof request.options.early !== "boolean" ||
              (request.options.topic !== undefined &&
                (typeof request.options.topic !== "string" || !request.options.topic)))) ||
          (request.criterionContract !== undefined && request.criterionContract !== 1) ||
          !Array.isArray(request.items) ||
          request.items.length === 0 ||
          request.items.some((item) => !item || !parseReviewKey(item.key)) ||
          ((request.document !== undefined || request.variants !== undefined) &&
            (!request.document ||
              typeof request.document !== "object" ||
              [
                request.document.lesson_html,
                request.document.rubric_json,
                request.document.teaching_plan_json,
              ].some((value) => typeof value !== "string" || !value.trim()) ||
              !request.variants ||
              typeof request.variants !== "object" ||
              Array.isArray(request.variants) ||
              Object.keys(request.variants).length !== request.items.length ||
              request.items.some((item) => !isContractId(request.variants![item.key])))),
      )
    )
      throw new Error(`Invalid review requests for ${classroom}.`);
    return saved.requests;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw stateReadError(`review request state ${classroom}/.reviews.json`, err);
  }
}
function save(classroom: string, requests: ReviewSession[]): void {
  const target = file(classroom);
  privateStatePath(`${classroom}/.reviews.json.tmp`);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify({ version: 1, requests }, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(`${target}.tmp`, target);
  invalidateActivity(classroom);
}
export function updateReview(
  session: ReviewSession,
  status: ReviewSession["status"],
  error?: string,
): void {
  return withReviewEdit(() => {
    const requests = reviewSessions(session.classroom);
    const request = requests.find((r) => r.id === session.id);
    if (!request) throw new Error("The review request no longer exists.");
    request.status = status;
    if (status === "queued" || status === "running") request.ownerPid = process.pid;
    if (error) request.error = error;
    else delete request.error;
    save(session.classroom, requests);
  });
}
export function currentReview(classroom: string): ReviewSession | null {
  return reviewSessions(classroom).at(-1) ?? null;
}
export function resumableReview(session: ReviewSession): boolean {
  if (session.status !== "done") return true;
  if (!isStoredReview(session.lesson))
    return !store.latestQuizStates(session.classroom, session.lesson).some((state) => state.grade);
  const quizzes = authoredQuizzes((session.document ?? readReviewDocument(session)).lesson_html);
  const states = store.latestQuizStates(session.classroom, session.lesson);
  return quizzes.some((quiz) => !states.some((state) => state.quizId === quiz.id && state.grade));
}
export function startReview(
  classroom: string,
  id: string,
  owner: ReviewOwner,
  limit = defaultReviewSize(),
  options: { topic?: string; early?: boolean } = {},
): { session: ReviewSession; added: boolean } {
  return withReviewEdit(() => startReviewLocked(classroom, id, owner, limit, options));
}
function startReviewLocked(
  classroom: string,
  id: string,
  owner: ReviewOwner,
  limit: number,
  options: { topic?: string; early?: boolean },
) {
  if (!store.readClassroom(classroom)) throw new Error(`No such classroom: ${classroom}.`);
  if (!Number.isInteger(limit) || limit < 3 || limit > MAX_REVIEW_SIZE)
    throw new Error(`Review size must be a whole number from 3 to ${MAX_REVIEW_SIZE}.`);
  if (options.early !== undefined && typeof options.early !== "boolean")
    throw new Error("Early review must be true or false.");
  if (options.topic !== undefined && (typeof options.topic !== "string" || !options.topic))
    throw new Error("Choose an existing review topic.");
  const requests = reviewSessions(classroom);
  const existing =
    requests.find((r) => r.id === id) ?? [...requests].reverse().find(resumableReview);
  if (existing) {
    if (existing.status !== "done") requireReviewOwner(existing, owner);
    return { session: existing, added: false };
  }
  const session = planReview(classroom, id, owner, limit, options);
  requests.push(session);
  save(classroom, requests);
  return { session, added: true };
}

/** Prepare selections and the complete document without changing classroom state. */
export function planReview(
  classroom: string,
  id: string,
  owner: ReviewOwner,
  limit = defaultReviewSize(),
  options: {
    topic?: string;
    early?: boolean;
    at?: number;
    keys?: string[];
    replaceReservation?: boolean;
  } = {},
): ReviewSession {
  if (!store.readClassroom(classroom)) throw new Error(`No such classroom: ${classroom}.`);
  if (!Number.isInteger(limit) || limit < 3 || limit > MAX_REVIEW_SIZE)
    throw new Error(`Review size must be a whole number from 3 to ${MAX_REVIEW_SIZE}.`);
  if (options.early !== undefined && typeof options.early !== "boolean")
    throw new Error("Early review must be true or false.");
  if (options.topic !== undefined && (typeof options.topic !== "string" || !options.topic))
    throw new Error("Choose an existing review topic.");
  const requests = reviewSessions(classroom);
  const at = options.at ?? Date.now();
  const active = store.reviewItems(classroom).filter((item) => item.retiredAt === undefined);
  if (options.topic !== undefined && !active.some((item) => reviewTopic(item).id === options.topic))
    throw new Error("This review topic is no longer active. Reload and choose a topic.");
  const items =
    options.topic === undefined
      ? active
      : active.filter((item) => reviewTopic(item).id === options.topic);
  const candidates = options.keys
    ? items.filter((item) => options.keys!.includes(item.key))
    : items;
  const { eligible, itemPools } = preparedReviewItems(classroom, candidates);
  const budget = classroomWorkload(
    classroom,
    active,
    at,
    options.replaceReservation ? id : undefined,
  );
  const picked = pickDailyItems(eligible, at, limit, budget, options.early);
  if (!picked.length) {
    if (
      budget.remaining === 0 ||
      eligible.some(
        (item) => budget.reservedKeys.includes(item.key) && (options.early || isDue(item, at)),
      )
    )
      throw new Error(
        `Today's shared review allowance is reserved (${budget.used}/${budget.allowance}; cap ${budget.cap}). Continue saved classroom or daily reviews. This allowance covers all classrooms. The next workload window starts ${new Date(budget.nextWindowAt).toISOString()}; overdue dates are unchanged.`,
      );
    const selectable = (item: ReviewItem) =>
      !item.needsReteach && (options.early || isDue(item, at));
    if (items.some(selectable) && !eligible.some(selectable))
      throw new Error(
        `No prepared variants for the ${options.early ? "selected" : "due"} questions. Prepare private review pools in their original lessons, then retry.`,
      );
    const next = summarize(eligible, at).nextDueAt;
    throw new Error(
      next === null
        ? items.some((item) => item.needsReteach)
          ? "Repeatedly missed items are paused from review. Open a short re-teach from the classroom memory map."
          : "No graded questions are due for review."
        : `The next review is due ${relativeDay(next, at)}.`,
    );
  }
  const session: ReviewSession = {
    id,
    owner,
    ownerPid: process.pid,
    classroom,
    lesson: `review-${id}`,
    at,
    items: picked,
    options: { limit, topic: options.topic, early: options.early ?? false },
    status: "queued",
  };
  if (fs.existsSync(lessonDir(classroom, session.lesson)))
    throw new Error("Review directory already exists.");
  const variants = picked.map((item) =>
    selectVariant(
      itemPools.get(item.key)!,
      requests.flatMap((r) => (r.variants?.[item.key] ? [r.variants[item.key]] : [])),
    ),
  );
  for (const [i, variant] of variants.entries())
    if (
      store.readLesson(classroom, picked[i].lesson)?.criterionContract === 1 &&
      !variant.rubric.criteria?.length
    )
      throw new Error(
        `Prepared review variant for ${picked[i].key} has no predeclared criteria. Prepare its private criteria, then retry.`,
      );
  if (variants.every((variant) => variant.rubric.criteria?.length)) session.criterionContract = 1;
  session.variants = Object.fromEntries(picked.map((item, i) => [item.key, variants[i].id]));
  session.document = assembleReview(picked, variants, !readConfig().reviewSingleForm);
  validateReview(session, session.document);
  return session;
}

/** The same private variant eligibility for classroom and root daily selection. */
export function preparedReviewItems(classroom: string, items: ReviewItem[]) {
  const pools = new Map<string, PreparedVariant[]>();
  for (const lesson of new Set(items.map((item) => item.lesson))) {
    const source = store.readLesson(classroom, lesson);
    for (const [key, pool] of lessonPools(classroom, lesson, source?.reviewVariantContract === 1))
      pools.set(`${lesson}/${key}`, pool);
  }
  const itemPools = new Map<string, PreparedVariant[]>();
  for (const item of items) {
    // Objective schedules retain their original question links. Select a prepared
    // probe through those links while keeping the objective as the review identity.
    const keys = item.questionKeys?.length
      ? item.questionKeys
      : [`${item.lesson}/${item.quizId}/${item.questionId}`];
    for (const key of keys) {
      const pool = pools
        .get(key)
        ?.filter(
          (variant) => item.progress !== "transfer-needed" || variant.plan.task === "transfer",
        );
      if (pool?.length) {
        itemPools.set(item.key, pool);
        break;
      }
    }
  }
  const eligible = items.filter((item) => itemPools.has(item.key));
  return { eligible, itemPools };
}

/** Recheck through the canonical picker when a saved group has not been published. */
export function plannedReviewEligible(session: ReviewSession): boolean {
  const current = store.reviewItems(session.classroom);
  const eligible = new Set(
    pickReviewItems(
      current,
      Date.now(),
      Number.MAX_SAFE_INTEGER,
      session.options?.early ?? false,
    ).map((item) => item.key),
  );
  return session.items.every((item) =>
    eligible.has(findReviewItem(current, item.key)?.key ?? item.key),
  );
}

/** Commit a previously saved daily selection, refusing competing classroom work. */
export function savePlannedReview(session: ReviewSession): ReviewSession {
  return withReviewEdit(() => {
    const requests = reviewSessions(session.classroom);
    const existing = requests.find((request) => request.id === session.id);
    if (existing) return existing;
    if (requests.some(resumableReview))
      throw new Error(
        "Another unfinished review exists in this classroom. Finish it, then retry this group.",
      );
    if (!plannedReviewEligible(session))
      throw new Error(
        "Daily selections are no longer due or eligible. Retry this classroom to refresh its unstarted selection.",
      );
    if (!session.document) throw new Error("The saved daily review document is missing.");
    validateReview(session, session.document);
    requests.push(session);
    save(session.classroom, requests);
    return session;
  });
}
export function publicReview(session: ReviewSession | null): unknown {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    error: session.error,
    count: session.items.length,
    options: session.options,
    resumable: resumableReview(session),
    url: lessonUrl(session.classroom, session.lesson),
  };
}
export function validateReview(session: ReviewSession, document: ReviewDocument): void {
  for (const value of Object.values(document))
    if (typeof value !== "string" || !value.trim())
      throw new Error("Review documents must be nonempty strings.");
  const quizzes = authoredQuizzes(document.lesson_html);
  if (
    !quizzes.length ||
    quizzes.some((quiz) => quiz.kind !== "review") ||
    new Set(quizzes.map((quiz) => quiz.id)).size !== quizzes.length ||
    (quizzes.length > 1 && quizzes.some((quiz) => quiz.questions.length !== 1))
  )
    throw new Error("A review needs one review quiz or one review quiz per card.");
  const keys = quizzes.flatMap((quiz) => quiz.questions.map((q) => q.reviewOf));
  if (keys.length !== session.items.length || keys.some((key, i) => key !== session.items[i].key))
    throw new Error(
      `Review questions must use the selected item keys in order. Expected ${JSON.stringify(session.items.map((item) => item.key))}; received ${JSON.stringify(keys)}.`,
    );
  const shapes = authoredQuestionShapes(document.lesson_html);
  if (shapes.length !== keys.length)
    throw new Error("Review controls must be visible in the quiz.");
  for (const shape of shapes) {
    const errors = questionErrors(shape);
    if (errors.length) throw new Error(`Review question ${shape.id}: ${errors.join(" ")}`);
  }
  parseRubric(
    document.rubric_json,
    document.lesson_html,
    "machine",
    session.criterionContract === 1,
  );
  const plan = parseTeachingPlan(document.teaching_plan_json, document.lesson_html);
  for (const [i, question] of quizzes
    .flatMap((quiz) => quiz.questions.map((question) => ({ ...question, quizId: quiz.id! })))
    .entries()) {
    const mapping = plan.quizzes[question.quizId];
    const item = session.items[i];
    const original = item.objective;
    const probe = mapping.questions[question.id!];
    const objective = plan.objectives[probe.objective];
    if (
      item.progress === "transfer-needed" &&
      (probe.task !== "transfer" || probe.support !== "independent")
    )
      throw new Error(
        `Review question ${question.id} requires an independent transfer task for ${item.key}.`,
      );
    if (!original) {
      if (
        objective.retentionDays !== undefined ||
        objective.interleaveGroup !== undefined ||
        objective.strategy !== undefined
      )
        throw new Error(
          `Historical review question ${question.id} cannot invent retention or strategy policy.`,
        );
      continue;
    }
    for (const field of [
      "statement",
      "application",
      "retentionDays",
      "interleaveGroup",
      "strategy",
    ] as const)
      if (objective[field] !== original[field])
        throw new Error(`Review question ${question.id} changed its original objective policy.`);
  }
}
/** Reject symlinks before writing model output to the reserved directory. */
function checkPath(target: string, root: string): void {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Review classroom cannot be a symlink.");
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Review path cannot be a symlink: ${current}.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
export function publishReview(session: ReviewSession, document: ReviewDocument): void {
  validateReview(session, document);
  const dir = lessonDir(session.classroom, session.lesson);
  const files = {
    "quiz/key.json": document.rubric_json,
    "quiz/plan.json": document.teaching_plan_json,
    "lesson.html": document.lesson_html,
  };
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name);
    checkPath(target, classroomDir(session.classroom));
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== text)
      throw new Error(`Review publication conflicts with ${name}.`);
  }
  checkPath(path.join(dir, "lesson.json"), classroomDir(session.classroom));
  fs.mkdirSync(path.join(dir, "quiz"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target))
      fs.writeFileSync(target, text, {
        flag: "wx",
        mode: name.startsWith("quiz/") ? 0o600 : 0o644,
      });
  }
  store.writeLessonMeta(session.classroom, session.lesson, {
    title: `Review: ${new Date(session.at).toISOString().slice(0, 10)}`,
    summary: `Spaced review of ${session.items.length} earlier item${session.items.length === 1 ? "" : "s"}.`,
    createdAt: session.at,
    kind: "review",
    assessmentContract: 1,
    ...(session.criterionContract === 1 ? { criterionContract: 1 as const } : {}),
    instructionalContract: 1,
  });
}
export function readReviewDocument(session: ReviewSession): ReviewDocument {
  const dir = lessonDir(session.classroom, session.lesson);
  const read = (name: string) => {
    checkPath(path.join(dir, name), classroomDir(session.classroom));
    return fs.readFileSync(path.join(dir, name), "utf8");
  };
  return {
    lesson_html: read("lesson.html"),
    rubric_json: read("quiz/key.json"),
    teaching_plan_json: read("quiz/plan.json"),
  };
}

/** A host must not take over another host's review work. */
export function requireReviewOwner(session: ReviewSession, owner: ReviewOwner): void {
  if (session.owner !== owner)
    throw new Error(
      `This review belongs to ${session.owner}. Open that classroom host to continue.`,
    );
}

/** Complete a saved assembly; callers retain legacy in-flight authoring separately. */
export function completePreparedReview(session: ReviewSession): boolean {
  if (!session.document) return false;
  if (session.status === "done") return true;
  try {
    publishReview(session, session.document);
    updateReview(session, "done");
  } catch (error) {
    updateReview(session, "failed", (error as Error).message);
    throw error;
  }
  return true;
}
