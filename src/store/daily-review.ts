import { stateReadError } from "../state-errors.ts";
import { invalidateActivity } from "../server/events.ts";
/** Durable cross-classroom selections. Classroom assessment history remains separate. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isValidSlug, lessonUrl, privateStatePath } from "../paths.ts";
import type { ReviewOwner, ReviewSession } from "../review-session.ts";
import {
  planReview,
  resumableReview,
  reviewSessions,
  validateReview,
  preparedReviewItems,
} from "../review-session.ts";
import { withReviewEdit } from "../review-lock.ts";
import {
  classroomWorkload,
  rootWorkload,
  rootReservations,
  pickAcrossClassrooms,
} from "../review-workload.ts";
import { MAX_REVIEW_SIZE, summarize } from "../review.ts";
import { listClassrooms } from "./classrooms.ts";
import { reviewItems } from "./review.ts";

export const isDailyId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);

export interface DailyGroup {
  classroom: string;
  title: string;
  plan: ReviewSession;
  error?: string;
  empty?: boolean;
}
export interface DailyReview {
  id: string;
  at: number;
  owner: ReviewOwner;
  groups: DailyGroup[];
}

export function dailyReviews(): DailyReview[] {
  try {
    return readDailyReviews();
  } catch (error) {
    throw stateReadError("daily review state .daily-reviews.json", error);
  }
}
function readDailyReviews(): DailyReview[] {
  const file = privateStatePath(".daily-reviews.json");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw stateReadError("daily review state .daily-reviews.json", error);
  }
  if (
    value?.version !== 1 ||
    !Array.isArray(value.requests) ||
    value.requests.some(
      (request: DailyReview) =>
        !request ||
        !isDailyId(request.id) ||
        !Number.isFinite(request.at) ||
        !["pi", "service"].includes(request.owner) ||
        !Array.isArray(request.groups) ||
        !request.groups.length ||
        request.groups.some(
          (g) =>
            !g ||
            !isValidSlug(g.classroom) ||
            typeof g.title !== "string" ||
            (g.empty !== undefined && typeof g.empty !== "boolean") ||
            !g.plan ||
            g.plan.classroom !== g.classroom ||
            !isDailyId(g.plan.id) ||
            !["pi", "service"].includes(g.plan.owner) ||
            !["queued", "running", "done", "failed"].includes(g.plan.status) ||
            !Number.isSafeInteger(g.plan.ownerPid) ||
            g.plan.ownerPid < 1 ||
            !Number.isFinite(g.plan.at) ||
            (g.plan.status !== "done" && g.plan.owner !== request.owner) ||
            !isValidSlug(g.plan.lesson) ||
            (g.plan.criterionContract !== undefined && g.plan.criterionContract !== 1) ||
            !Array.isArray(g.plan.items) ||
            !g.plan.items.length ||
            g.plan.items.some((item) => !item || typeof item.key !== "string") ||
            (g.error !== undefined && typeof g.error !== "string"),
        ) ||
        new Set(request.groups.map((g) => g.classroom)).size !== request.groups.length,
    ) ||
    new Set(value.requests.map((r: DailyReview) => r.id)).size !== value.requests.length
  )
    throw new Error("Invalid daily review state.");
  for (const request of value.requests as DailyReview[])
    for (const group of request.groups) {
      if (group.plan.document) validateReview(group.plan, group.plan.document);
    }
  return value.requests;
}

/** Reload under the root lock so another host's completed edit cannot be overwritten. */
export function editDailyReview(id: string, edit: (request: DailyReview) => void): DailyReview {
  return withReviewEdit(() => {
    const request = dailyReviews().find((request) => request.id === id);
    if (!request) throw new Error("This daily review no longer exists.");
    edit(request);
    return request;
  });
}

export function saveDailyReview(request: DailyReview): void {
  const requests = dailyReviews();
  const index = requests.findIndex((r) => r.id === request.id);
  if (index < 0) requests.push(request);
  else requests[index] = request;
  fs.mkdirSync(privateStatePath("."), { recursive: true });
  const temporary = privateStatePath(".daily-reviews.json.tmp");
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, requests }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, privateStatePath(".daily-reviews.json"));
  for (const group of request.groups) invalidateActivity(group.classroom);
}

export function groupSession(group: DailyGroup): ReviewSession | undefined {
  return reviewSessions(group.classroom).find((r) => r.id === group.plan.id);
}
export function groupComplete(group: DailyGroup): boolean {
  if (group.empty) return true;
  const session = groupSession(group);
  return session?.status === "done" && !resumableReview(session);
}
export function activeGroup(request: DailyReview): number {
  return request.groups.findIndex((group) => !groupComplete(group));
}
export function currentDailyReview(): DailyReview | null {
  return [...dailyReviews()].reverse().find((r) => activeGroup(r) !== -1) ?? null;
}
/** The same history-derived summary used on the classroom page. No schedule writes. */
export function dailyDue(now = Date.now()): Record<string, number> {
  return Object.fromEntries(
    listClassrooms().map((c) => [c.name, summarize(reviewItems(c.name), now).due]),
  );
}
export function startDailyReview(
  id: string,
  owner: ReviewOwner,
  authorize?: (group: DailyGroup) => void,
): DailyReview {
  return withReviewEdit(() => createDailyReview(id, owner, authorize));
}
function createDailyReview(
  id: string,
  owner: ReviewOwner,
  authorize?: (group: DailyGroup) => void,
): DailyReview {
  if (!isDailyId(id)) throw new Error("Invalid daily review request.");
  const requests = dailyReviews();
  const existing =
    requests.find((r) => r.id === id) ?? [...requests].reverse().find((r) => activeGroup(r) !== -1);
  if (existing) {
    const active = activeGroup(existing);
    if (active !== -1) authorize?.(existing.groups[active]);
    return existing;
  }
  const at = Date.now();
  const due = dailyDue(at);
  const classrooms = listClassrooms().sort((a, b) => a.name.localeCompare(b.name));
  const pending = new Map(
    classrooms.map((c) => [c.name, [...reviewSessions(c.name)].reverse().find(resumableReview)]),
  );
  const budget = rootWorkload(at);
  const room = new Map(
    classrooms.map((c) => [
      c.name,
      Math.min(MAX_REVIEW_SIZE, classroomWorkload(c.name, reviewItems(c.name), at).remaining),
    ]),
  );
  const candidates = classrooms
    .filter((c) => !pending.get(c.name) && due[c.name] > 0 && room.get(c.name)! > 0)
    .map((c) => ({
      classroom: c.name,
      items: preparedReviewItems(c.name, reviewItems(c.name)).eligible,
    }));
  const selected = pickAcrossClassrooms(candidates, at, budget, rootReservations(), (c) =>
    room.get(c)!,
  );
  const groups: DailyGroup[] = [];
  // Keep the existing classroom navigation order; fairness determines membership
  // and allocations before these complete plans are saved together.
  const order = classrooms
    .filter((c) => pending.get(c.name) || selected.has(c.name))
    .map((c) => c.name);
  for (const name of order) {
    const classroom = classrooms.find((c) => c.name === name)!;
    try {
      const picks = selected.get(name);
      const plan =
        pending.get(name) ??
        planReview(name, randomUUID(), owner, MAX_REVIEW_SIZE, {
          at,
          keys: picks!.map((item) => item.key),
        });
      if (plan.status !== "done" && plan.owner !== owner)
        throw new Error(
          `This review belongs to ${plan.owner}. Open that classroom host to continue.`,
        );
      const group = { classroom: name, title: classroom.title, plan };
      authorize?.(group);
      groups.push(group);
    } catch (error) {
      throw new Error(`${classroom.title}: ${(error as Error).message}`);
    }
  }
  if (!groups.length)
    throw new Error(
      Object.values(due).some((count) => count > 0)
        ? Object.entries(due).every(([name, count]) => count === 0 || room.get(name) === 0)
          ? "Due questions remain, but each classroom with due questions has reserved its daily review allowance. Continue saved reviews or return after the next UTC workload window. Due dates are unchanged."
          : "No prepared variants for the due questions. Prepare private review pools in their original lessons, then retry."
        : "No questions are due across classrooms.",
    );
  const request = { id, owner, at, groups };
  saveDailyReview(request);
  return request;
}
export function publicDailyReview(request: DailyReview) {
  const active = activeGroup(request);
  return {
    id: request.id,
    at: request.at,
    complete: active === -1,
    active,
    url: `/reviews/daily/${request.id}`,
    groups: request.groups.map((g, index) => {
      const session = groupSession(g);
      return {
        classroom: g.classroom,
        title: g.title,
        count: g.empty ? 0 : g.plan.items.length,
        empty: g.empty === true,
        complete: groupComplete(g),
        status: session?.status ?? "planned",
        error: g.error ?? session?.error,
        available:
          !g.error &&
          index <= (active === -1 ? request.groups.length : active) &&
          session?.status === "done",
        url: `${lessonUrl(g.classroom, g.plan.lesson)}?daily=${request.id}`,
        historyUrl: `/c/${encodeURIComponent(g.classroom)}/reviews`,
      };
    }),
  };
}
