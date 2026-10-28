/** Workload policy only: reservations never change memory, grades, or due dates. */
import {
  DAY_MS,
  defaultReviewSize,
  MAX_REVIEW_SIZE,
  isDue,
  findReviewItem,
  pickReviewItems,
  reviewTopic,
} from "./review.ts";
import type { ReviewItem } from "./review.ts";
import { reviewSessions, resumableReview } from "./review-session.ts";
import { dailyReviews } from "./store/daily-review.ts";
import { listClassrooms } from "./store/classrooms.ts";
import { reviewItems } from "./store/review.ts";
import { listGrades, listSubmissions } from "./store/quiz-history.ts";

export interface ReviewReservation {
  id: string;
  classroom?: string;
  topics?: string[];
  at: number;
  keys: string[];
  /** Original saved cards remain budget units even when aliases converge. */
  cards?: string[];
  active: boolean;
  completions: Array<{ key: string; at: number }>;
}
export interface ReviewWorkload {
  cap: number;
  allowance: number;
  used: number;
  remaining: number;
  eligible: number;
  deferred: number;
  nextWindowAt: number;
  reservedKeys: string[];
}
export const reviewDay = (at: number) => Math.floor(at / DAY_MS) * DAY_MS;

/** Pure, time-explicit policy; no missed days accumulate credit. */
export function workload(
  items: ReviewItem[],
  reservations: ReviewReservation[],
  now: number,
): ReviewWorkload {
  const day = reviewDay(now);
  reservations = [...new Map(reservations.map((r) => [r.id, r])).values()];
  const firstCompletions = new Map<string, number>();
  for (const r of reservations)
    for (const c of r.completions) {
      const card = `${r.id}:${c.key}`;
      firstCompletions.set(card, Math.min(firstCompletions.get(card) ?? Infinity, c.at));
    }
  const completedYesterday = [...firstCompletions.values()].filter(
    (at) => at >= day - DAY_MS && at < day,
  ).length;
  const allowance = Math.min(MAX_REVIEW_SIZE, defaultReviewSize() + completedYesterday);
  const reservedKeys = [
    ...new Set(
      reservations
        .filter((r) => r.at < day + DAY_MS && (r.at >= day || r.active))
        .flatMap((r) => r.keys),
    ),
  ];
  const used = reservations
    .filter((r) => r.at < day + DAY_MS && (r.at >= day || r.active))
    .reduce((sum, r) => sum + new Set(r.cards ?? r.keys).size, 0);
  const remaining = Math.max(0, allowance - used);
  const due = items.filter((item) => isDue(item, now) && !reservedKeys.includes(item.key));
  return {
    cap: MAX_REVIEW_SIZE,
    allowance,
    used,
    remaining,
    eligible: Math.min(remaining, due.length),
    deferred: Math.max(0, due.length - remaining),
    nextWindowAt: day + DAY_MS,
    reservedKeys,
  };
}
export function classroomReservations(classroom: string): ReviewReservation[] {
  const sessions = new Map(reviewSessions(classroom).map((r) => [r.id, r]));
  for (const batch of dailyReviews())
    for (const group of batch.groups)
      if (group.classroom === classroom && !group.empty && !sessions.has(group.plan.id))
        sessions.set(group.plan.id, group.plan);
  const current = reviewItems(classroom);
  return [...sessions.values()].map((r) => {
    const submissions = listSubmissions(classroom, r.lesson);
    const grades = listGrades(classroom, r.lesson);
    const firstGrade = new Map<string, number>();
    for (const grade of grades)
      if (!firstGrade.has(grade.submissionId)) firstGrade.set(grade.submissionId, grade.gradedAt);
    const completions = submissions.flatMap((s) =>
      firstGrade.has(s.id)
        ? s.answers
            .filter((a) => a.reviewOf)
            .map((a) => ({ key: a.reviewOf!, at: firstGrade.get(s.id)! }))
        : [],
    );
    return {
      id: r.id,
      classroom,
      topics: [
        ...new Set(
          r.items.map((item) => reviewTopic(findReviewItem(current, item.key) ?? item).id),
        ),
      ],
      at: r.at,
      keys: r.items.map((i) => findReviewItem(current, i.key)?.key ?? i.key),
      cards: r.items.map((i) => i.key),
      active: resumableReview(r),
      completions,
    };
  });
}
/** Namespacing preserves identical lesson/objective keys in separate classrooms. */
export function rootReservations(): ReviewReservation[] {
  return listClassrooms().flatMap((c) =>
    classroomReservations(c.name).map((r) => ({
      ...r,
      id: `${c.name}/${r.id}`,
      keys: r.keys.map((key) => `${c.name}/${key}`),
      completions: r.completions.map((event) => ({ ...event, key: `${c.name}/${event.key}` })),
    })),
  );
}
export function rootWorkload(now: number, omitReservation?: string): ReviewWorkload {
  const items = listClassrooms().flatMap((c) =>
    reviewItems(c.name).map((item) => ({ ...item, key: `${c.name}/${item.key}` })),
  );
  return workload(
    items,
    rootReservations().filter((r) => r.id !== omitReservation),
    now,
  );
}
export function classroomWorkload(
  classroom: string,
  items: ReviewItem[],
  now: number,
  omitReservation?: string,
): ReviewWorkload {
  const root = rootWorkload(now, omitReservation ? `${classroom}/${omitReservation}` : undefined);
  const reservedKeys = root.reservedKeys
    .filter((key) => key.startsWith(`${classroom}/`))
    .map((key) => key.slice(classroom.length + 1));
  const due = items.filter((item) => isDue(item, now) && !reservedKeys.includes(item.key)).length;
  return {
    ...root,
    reservedKeys,
    eligible: Math.min(root.remaining, due),
    deferred: Math.max(0, due - root.remaining),
  };
}

/** Daily all-topic fairness: least recently selected classrooms and topics first,
 * then round-robin one card per classroom/topic. Explicit choices use the same
 * budget through pickDailyItems but intentionally direct its remaining slots. */
export function pickAcrossClassrooms(
  candidates: Array<{ classroom: string; items: ReviewItem[] }>,
  now: number,
  state: ReviewWorkload,
  history: ReviewReservation[],
): Map<string, ReviewItem[]> {
  const lastClass = (classroom: string) =>
    Math.max(
      -Infinity,
      ...history.filter((r) => r.classroom === classroom && r.at <= now).map((r) => r.at),
    );
  const lastTopic = (classroom: string, topic: string) =>
    Math.max(
      -Infinity,
      ...history
        .filter((r) => r.classroom === classroom && r.at <= now && r.topics?.includes(topic))
        .map((r) => r.at),
    );
  const classes = candidates
    .map(({ classroom, items }) => {
      const byTopic = new Map<string, ReviewItem[]>();
      for (const item of items)
        if (isDue(item, now) && !state.reservedKeys.includes(`${classroom}/${item.key}`)) {
          const topic = reviewTopic(item).id;
          const queue = byTopic.get(topic) ?? [];
          queue.push(item);
          byTopic.set(topic, queue);
        }
      const topics = [...byTopic]
        .sort(([a], [b]) => lastTopic(classroom, a) - lastTopic(classroom, b) || a.localeCompare(b))
        .map(([, queue]) => pickReviewItems(queue, now, Number.MAX_SAFE_INTEGER));
      const mixed: ReviewItem[] = [];
      while (topics.some((queue) => queue.length))
        for (const queue of topics) {
          const item = queue.shift();
          if (item) mixed.push(item);
        }
      return { classroom, queue: mixed };
    })
    .sort(
      (a, b) =>
        lastClass(a.classroom) - lastClass(b.classroom) || a.classroom.localeCompare(b.classroom),
    );
  const selected = new Map<string, ReviewItem[]>();
  let count = 0;
  while (count < state.remaining && classes.some((c) => c.queue.length)) {
    for (const c of classes) {
      if (count >= state.remaining) break;
      const item = c.queue.shift();
      if (!item) continue;
      const picks = selected.get(c.classroom) ?? [];
      picks.push(item);
      selected.set(c.classroom, picks);
      count++;
    }
  }
  return selected;
}
/** All entry points share the same exclusions, due ordering and interleaving. */
export function pickDailyItems(
  items: ReviewItem[],
  now: number,
  limit: number,
  state: ReviewWorkload,
  early = false,
): ReviewItem[] {
  return pickReviewItems(
    items.filter((item) => !state.reservedKeys.includes(item.key)),
    now,
    Math.min(limit, state.remaining),
    early,
  );
}
