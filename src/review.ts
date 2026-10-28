/** Derive review schedules and evidence labels from immutable attempt history. */
import {
  evidenceContext,
  independent,
  type EvidenceContext,
  type PerformanceEvidence,
} from "./evidence.ts";
import { readConfig } from "./config.ts";
import { objectiveReviewKey, reviewKey } from "../assets/runtime/quiz.mjs";
import { initialMemory, recallMemory, incompleteMemory, MEMORY_POLICY } from "./review-memory.ts";
import type { Objective } from "./teaching-plan.ts";

export const REVIEW_POLICY = "elapsed-independent-v1";
export const RETENTION_SPAN_DAYS = 7;
export const RETENTION_SUCCESSES = 2;
/** Cumulative incomplete exposures while the latest performance remains unresolved. */
export const RETEACH_MISSES = 3;

export const DEFAULT_REVIEW_SIZE = 5;
/** Items per review: the local `reviewSize` setting, else the upstream default. */
export function defaultReviewSize(): number {
  return readConfig().reviewSize ?? DEFAULT_REVIEW_SIZE;
}
export const MAX_REVIEW_SIZE = 12;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One quiz answer or linked chat check for an item. */
export interface ReviewEvent {
  /** Objective key, or the historical question key when context is unknown. */
  key: string;
  /** Original question aliases; absent on chat and linked review events. */
  questionKey?: string;
  /** Source identity remains usable when an older schedule owns the question alias. */
  sourceQuestionKey?: string;
  /** When the learner answered. */
  at: number;
  /** Immutable submission/check identity, absent only on legacy event callers. */
  attemptId?: string;
  correct: boolean;
  /** Fraction of credit. Absent on historical binary events. */
  credit?: number;
  evidence?: PerformanceEvidence;
  /** Saved independence can resolve a gap without inventing an old objective context. */
  gapIndependent?: boolean;
  /** First feedback time for the attempt. A regrade does not create a new exposure. */
  feedbackAt?: number;
  /** Selected before its due date; replay must never extend this interval. */
  early?: boolean;
  /** Original selected due time, including snapshots saved under an earlier scheduler. */
  earlyDueAt?: number;
  source?: "chat";
  learningRecord?: string;
  prompt: string;
  /** The learner's answer, as one line. */
  answer: string;
  feedback: string;
}

export interface ReviewItem {
  key: string;
  retiredAt?: number;
  controlRevision?: number;
  lesson: string;
  quizId: string;
  questionId: string;
  /** Historical links remain valid after an objective replaces its question schedules. */
  questionKeys?: string[];
  /** Previously answered probes, for fresh review authoring. */
  prompts?: string[];
  /** The prompt of the first graded question for this item: the original question. */
  prompt: string;
  /** Legacy diagnostic counter; never used to calculate intervals. */
  box: number;
  stability: number;
  difficulty: number;
  memoryPolicy: typeof MEMORY_POLICY;
  /** Latest actual feedback/check boundary, distinct from selected-review elapsedDays. */
  lastFeedbackAt: number;
  objective?: Objective;
  objectiveId?: string;
  context: EvidenceContext;
  progress:
    | "context-unknown"
    | "needs-practice"
    | "immediate-success"
    | "delayed-success"
    | "transfer-needed"
    | "retained-evidence";
  delayedSuccesses: number;
  delayedTransfers: number;
  evidenceSpanDays: number;
  elapsedDays: number;
  scheduleReason: string;
  schedulePolicy: typeof REVIEW_POLICY;
  dueAt: number;
  lastAt: number;
  lastCorrect: boolean;
  lastCredit: number;
  lastSource?: "chat";
  learningRecord?: string;
  lastAnswer: string;
  lastFeedback: string;
  attempts: number;
  /** An incomplete exposure remains open until a full independent answer. */
  gapOpen: boolean;
  misses?: number;
  needsReteach?: boolean;
}

/** Stable identity from the saved answer, never the current teaching plan. */
export function answerReviewKey(
  lesson: string,
  quizId: string,
  answer: { questionId: string; reviewOf?: string; learning?: PerformanceEvidence },
): string {
  return (
    answer.reviewOf ??
    (answer.learning
      ? objectiveReviewKey(lesson, answer.learning.objectiveId)
      : reviewKey(lesson, quizId, answer.questionId))
  );
}

export function findReviewItem(items: ReviewItem[], key: string): ReviewItem | undefined {
  return (
    items.find((item) => item.key === key) ?? items.find((item) => item.questionKeys?.includes(key))
  );
}

/** Ignore extra confidence/self-rating fields entirely. Known performance and
 * context fields order policy ties; final text ties only make display deterministic.
 * Delay always comes from the saved answer/feedback times, never narrative. */
function eventTie(event: ReviewEvent): string {
  const e = event.evidence;
  return JSON.stringify([
    event.source,
    event.correct,
    event.credit,
    event.feedbackAt,
    event.early,
    event.earlyDueAt,
    event.gapIndependent,
    e?.objectiveId,
    e?.task,
    e?.support,
    e?.assistance,
    e?.objective.statement,
    e?.objective.application,
    e?.objective.retentionDays,
    e?.objective.interleaveGroup,
    e?.objective.strategy,
    event.answer,
    event.feedback,
  ]);
}

/** Build each schedule from quiz answers and linked chat checks. */
export function scheduleItems(events: ReviewEvent[]): ReviewItem[] {
  const byKey = new Map<string, ReviewEvent[]>();
  for (const event of events) {
    if (
      !Number.isFinite(event.at) ||
      Math.abs(event.at) > 8e15 ||
      (event.earlyDueAt !== undefined &&
        (!Number.isFinite(event.earlyDueAt) || Math.abs(event.earlyDueAt) > 8e15)) ||
      !Number.isFinite(event.feedbackAt ?? event.at) ||
      Math.abs(event.feedbackAt ?? event.at) > 8e15 ||
      (event.credit !== undefined &&
        (!Number.isFinite(event.credit) || event.credit < 0 || event.credit > 1))
    )
      throw new Error(`Invalid review event timing or credit for ${event.key}.`);
  }
  const ordered = [...events].sort(
    (a, b) =>
      a.at - b.at ||
      a.key.localeCompare(b.key) ||
      (a.attemptId ?? "").localeCompare(b.attemptId ?? "") ||
      (a.questionKey ?? a.prompt).localeCompare(b.questionKey ?? b.prompt) ||
      eventTie(a).localeCompare(eventTie(b)),
  );
  for (const event of ordered) {
    const list = byKey.get(event.key);
    if (list) list.push(event);
    else byKey.set(event.key, [event]);
  }

  const items: ReviewItem[] = [];
  for (const [key, probes] of byKey) {
    const questionKeys = [...new Set(probes.flatMap((event) => event.questionKey ?? []))];
    const source = probes.find((event) => event.sourceQuestionKey)?.sourceQuestionKey;
    const [lesson, quizId, questionId] = (source ?? questionKeys[0] ?? key).split("/");
    // Several probes in one attempt are one exposure. Every probe must succeed
    // independently; a later correct answer must not erase an incomplete one.
    const list: ReviewEvent[] = [];
    for (const event of probes) {
      const previous = list.at(-1);
      if (
        !previous ||
        (previous.attemptId ?? previous.at) !== (event.attemptId ?? event.at) ||
        previous.source ||
        event.source
      ) {
        list.push({ ...event });
        continue;
      }
      const credit = (e: ReviewEvent) => e.credit ?? (e.correct ? 1 : 0);
      const weaker = credit(event) < credit(previous) || (!event.correct && previous.correct);
      const evidence = !independent(previous.evidence)
        ? previous.evidence
        : !independent(event.evidence)
          ? event.evidence
          : event.evidence?.task === "transfer"
            ? event.evidence
            : previous.evidence;
      list[list.length - 1] = {
        ...(weaker ? event : previous),
        correct: previous.correct && event.correct,
        gapIndependent:
          (previous.gapIndependent ?? independent(previous.evidence)) &&
          (event.gapIndependent ?? independent(event.evidence)),
        early: previous.early || event.early,
        earlyDueAt:
          previous.earlyDueAt === undefined
            ? event.earlyDueAt
            : event.earlyDueAt === undefined
              ? previous.earlyDueAt
              : Math.min(previous.earlyDueAt, event.earlyDueAt),
        credit: Math.min(credit(previous), credit(event)),
        feedbackAt: Math.max(previous.feedbackAt ?? previous.at, event.feedbackAt ?? event.at),
        evidence,
      };
    }
    let memory = initialMemory();
    let misses = 0;
    let gapOpen = false;
    let box = 0;
    let dueAt = list[0].at + DAY_MS;
    let exposureAt = list[0].at;
    let objective: Objective | undefined;
    let objectiveId: string | undefined;
    let context: EvidenceContext = "unknown";
    let delayedSuccesses = 0;
    let delayedTransfers = 0;
    let baselineAt: number | undefined;
    let lastDelayedAt: number | undefined;
    let elapsedDays = 0;
    let scheduleReason = "Initial practice: review in one day.";
    for (const [i, event] of list.entries()) {
      if (!objective && event.evidence) {
        objective = event.evidence.objective;
        objectiveId = event.evidence.objectiveId;
      }
      const elapsed = i === 0 ? 0 : Math.max(0, event.at - exposureAt);
      elapsedDays = elapsed / DAY_MS;
      context = evidenceContext(event.evidence, elapsed);
      const full = event.correct && (event.credit === undefined || event.credit === 1);
      const independentFull = full && (event.gapIndependent ?? independent(event.evidence));
      if (!full) gapOpen = true;
      else if (event.gapIndependent ?? independent(event.evidence)) gapOpen = false;
      const feedbackAt = Math.max(event.at, event.feedbackAt ?? event.at);
      const scheduledDueAt = dueAt;
      if (i === 0) dueAt = feedbackAt + DAY_MS;
      if (!full) {
        misses++;
        memory = incompleteMemory(memory, elapsedDays, event.credit ?? (event.correct ? 1 : 0));
        box = 0;
        delayedSuccesses = 0;
        delayedTransfers = 0;
        baselineAt = undefined;
        lastDelayedAt = undefined;
        const interval = Math.min(
          Math.max(1, memory.stability),
          objective?.retentionDays === undefined
            ? Infinity
            : Math.max(1, Math.floor(objective.retentionDays / 4)),
        );
        dueAt = feedbackAt + Math.ceil(interval * DAY_MS);
        scheduleReason =
          (event.credit ?? 0) > 0
            ? `Partial retrieval: small stability setback; ${interval.toFixed(2)}-day interval after feedback.`
            : `Missed retrieval: ${interval.toFixed(2)}-day interval after feedback.`;
      } else if (independentFull) {
        if (baselineAt !== undefined && elapsed >= DAY_MS) {
          delayedSuccesses++;
          lastDelayedAt = event.at;
          if (context === "delayed-transfer") delayedTransfers++;
        }
        baselineAt ??= event.at;
        if (i > 0 && !event.early && elapsed >= DAY_MS && event.at >= dueAt) {
          box = Math.min(box + 1, 4);
          memory = recallMemory(memory, elapsedDays);
          const base = Math.max(1, memory.stability);
          const interval =
            objective?.retentionDays === undefined
              ? base
              : Math.min(base, Math.max(1, Math.floor(objective.retentionDays / 4)));
          dueAt = feedbackAt + Math.ceil(interval * DAY_MS);
          scheduleReason = `Independent retrieval after ${elapsedDays.toFixed(1)} days: ${interval.toFixed(2)}-day interval${objective?.retentionDays === undefined ? "." : `; retention-duration cap ${objective.retentionDays} days (not a deadline).`}`;
        } else if (i === 0) {
          dueAt = feedbackAt + DAY_MS;
        } else {
          scheduleReason = "Early independent success: keep the scheduled review.";
        }
      } else {
        scheduleReason =
          context === "assisted"
            ? "Assisted performance: keep the scheduled independent review."
            : "Unknown independence: keep the scheduled review; no retention claim.";
      }
      if (event.early) {
        dueAt = Math.min(scheduledDueAt, dueAt, event.earlyDueAt ?? Infinity);
        scheduleReason += " Early review cannot extend the scheduled interval.";
      }
      exposureAt = Math.max(exposureAt, feedbackAt);
    }
    const span =
      baselineAt === undefined || lastDelayedAt === undefined
        ? 0
        : (lastDelayedAt - baselineAt) / DAY_MS;
    const retained = delayedSuccesses >= RETENTION_SUCCESSES && span >= RETENTION_SPAN_DAYS;
    const last = list[list.length - 1];
    const progress: ReviewItem["progress"] = !(
      last.correct &&
      (last.credit === undefined || last.credit === 1)
    )
      ? "needs-practice"
      : !objective
        ? "context-unknown"
        : retained && (!objective.application || delayedTransfers > 0)
          ? "retained-evidence"
          : retained && objective.application
            ? "transfer-needed"
            : delayedSuccesses > 0
              ? "delayed-success"
              : independent(last.evidence)
                ? "immediate-success"
                : context === "unknown"
                  ? "context-unknown"
                  : "needs-practice";
    items.push({
      key,
      lesson,
      quizId,
      questionId,
      questionKeys,
      prompts: [...new Set(probes.map((event) => event.prompt))],
      prompt: probes[0].prompt,
      box,
      stability: memory.stability,
      difficulty: memory.difficulty,
      memoryPolicy: MEMORY_POLICY,
      lastFeedbackAt: exposureAt,
      dueAt,
      objective,
      objectiveId,
      context,
      progress,
      delayedSuccesses,
      delayedTransfers,
      evidenceSpanDays: span,
      elapsedDays,
      scheduleReason,
      schedulePolicy: REVIEW_POLICY,
      lastAt: last.at,
      lastCorrect: last.correct,
      lastCredit: last.credit ?? (last.correct ? 1 : 0),
      lastSource: last.source,
      learningRecord: last.learningRecord,
      lastAnswer: last.answer,
      lastFeedback: last.feedback,
      attempts: list.length,
      misses,
      gapOpen,
      needsReteach:
        misses >= RETEACH_MISSES &&
        !(
          last.correct &&
          (last.credit === undefined || last.credit === 1) &&
          (last.gapIndependent ?? independent(last.evidence))
        ),
    });
  }
  return items.sort((a, b) => a.dueAt - b.dueAt || a.key.localeCompare(b.key));
}

export function isDue(item: ReviewItem, now: number): boolean {
  return item.retiredAt === undefined && !item.needsReteach && item.dueAt <= now;
}

/** Mix distinct strategies within related groups. Keep unrelated items in due order. */
export function pickReviewItems(
  items: ReviewItem[],
  now: number,
  limit: number,
  early = false,
): ReviewItem[] {
  const due = items
    .filter(
      (item) => item.retiredAt === undefined && !item.needsReteach && (early || isDue(item, now)),
    )
    .sort(
      (a, b) =>
        Math.max(a.dueAt, a.lastFeedbackAt ?? a.lastAt) -
          Math.max(b.dueAt, b.lastFeedbackAt ?? b.lastAt) || a.key.localeCompare(b.key),
    );
  const pools = new Map<string, ReviewItem[]>();
  for (const item of due) {
    const group = item.objective?.interleaveGroup;
    const id = group === undefined ? `item:${item.key}` : `group:${group}`;
    const pool = pools.get(id) ?? [];
    pool.push(item);
    pools.set(id, pool);
  }
  const ordered = new Map<string, ReviewItem[]>();
  for (const [id, pool] of pools) {
    const mixed: ReviewItem[] = [];
    const byStrategy = new Map<string, ReviewItem[]>();
    for (const item of pool) {
      const strategy = item.objective?.strategy ?? item.key;
      const queue = byStrategy.get(strategy) ?? [];
      queue.push(item);
      byStrategy.set(strategy, queue);
    }
    const queues = [...byStrategy.values()];
    while (queues.some((queue) => queue.length)) {
      for (const queue of queues) {
        const item = queue.shift();
        if (item) mixed.push(item);
      }
    }
    ordered.set(id, mixed);
  }
  return due.slice(0, limit).map((item) => {
    const id =
      item.objective?.interleaveGroup === undefined
        ? `item:${item.key}`
        : `group:${item.objective.interleaveGroup}`;
    return ordered.get(id)!.shift()!;
  });
}

export interface ReviewSummary {
  total: number;
  retired?: number;
  due: number;
  /** Items that become due within the next three days, not counting those due now. */
  dueSoon: number;
  retained: number;
  transferNeeded: number;
  unknown: number;
  /** The earliest due time among items that are not due yet. */
  nextDueAt: number | null;
}

export function summarize(items: ReviewItem[], now: number): ReviewSummary {
  const retired = items.filter((item) => item.retiredAt !== undefined).length;
  items = items.filter((item) => item.retiredAt === undefined);
  const scheduled = items.filter((item) => !item.needsReteach);
  const upcoming = scheduled.filter((item) => !isDue(item, now));
  return {
    retired,
    total: items.length,
    due: scheduled.length - upcoming.length,
    dueSoon: upcoming.filter((item) => item.dueAt <= now + 3 * DAY_MS).length,
    retained: items.filter((item) => item.progress === "retained-evidence").length,
    transferNeeded: items.filter((item) => item.progress === "transfer-needed").length,
    unknown: items.filter((item) => item.progress === "context-unknown").length,
    nextDueAt: upcoming.length > 0 ? Math.min(...upcoming.map((item) => item.dueAt)) : null,
  };
}

/** "today", "tomorrow", "in 5 days", or "3 days ago", relative to `now`. */
export function relativeDay(at: number, now: number): string {
  const days = Math.round((at - now) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** Topic choices reuse saved objective groups, then objectives, then historical lessons. */
export function reviewTopic(item: ReviewItem): { id: string; label: string } {
  return {
    id: JSON.stringify([item.lesson, item.objective?.interleaveGroup ?? item.objectiveId ?? null]),
    label: `${item.lesson}: ${item.objective?.interleaveGroup ?? item.objective?.statement ?? "Historical questions"}`,
  };
}

/** Current corrective phase is measured from actual latest feedback, never saved selection metadata. */
export function reviewTiming(items: ReviewItem[], answerAt: number) {
  return items.map((item) => ({
    key: item.key,
    phase: "panel-corrective-reply",
    answerAt,
    feedbackAt: item.lastFeedbackAt,
    elapsedMs: Math.max(0, answerAt - item.lastFeedbackAt),
    delay: answerAt - item.lastFeedbackAt >= DAY_MS ? "delayed" : "immediate",
    // Assistance and task still come from this actual reply, never this timing hint.
  }));
}
