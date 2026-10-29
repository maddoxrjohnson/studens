import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DAY_MS, scheduleItems, summarize, pickReviewItems, reviewTopic } from "../src/review.ts";
import {
  workload,
  pickDailyItems,
  classroomWorkload,
  reviewDay,
  rootWorkload,
  pickAcrossClassrooms,
} from "../src/review-workload.ts";
import type { ReviewReservation } from "../src/review-workload.ts";
import {
  startReview,
  reviewSessions,
  completePreparedReview,
  resumableReview,
  savePlannedReview,
  plannedReviewEligible,
} from "../src/review-session.ts";
import { dailyReviews, startDailyReview } from "../src/store/daily-review.ts";
import * as store from "../src/store.ts";
import {
  makeFixture,
  seedClassroom,
  seedPreparedReviewSource,
  closeReviewVariants,
  termAnswer,
  writeGradedAttempt,
} from "./helpers.ts";
import type { Fixture } from "./helpers.ts";
const NOW = Date.UTC(2026, 9, 19, 12);
const items = () =>
  scheduleItems(
    Array.from({ length: 30 }, (_, i) => ({
      key: `001-a/check/q${String(i).padStart(2, "0")}`,
      at: NOW - 20 * DAY_MS,
      correct: true,
      prompt: "Recall",
      answer: "Answer",
      feedback: "Feedback",
    })),
  );
it("keeps due counts and dates intact through absent days without accumulating allowance", () => {
  const all = items();
  const saved = JSON.stringify(all);
  for (const day of [0, 1, 10, 365]) {
    const now = NOW + day * DAY_MS;
    const state = workload(all, [], now);
    expect(state).toMatchObject({
      cap: 15,
      allowance: 15,
      remaining: 15,
      eligible: 15,
      deferred: 15,
    });
    expect(summarize(all, now).due).toBe(30);
    expect(pickDailyItems(all, now, 12, state)).toHaveLength(12);
  }
  expect(JSON.stringify(all)).toBe(saved);
});
it("keeps the cap flat: prior-day completions never raise or lower it, with exact UTC boundaries", () => {
  const all = items();
  const day = reviewDay(NOW);
  const yesterday: ReviewReservation = {
    id: "first",
    at: day - DAY_MS,
    keys: all.slice(0, 12).map((i) => i.key),
    active: false,
    completions: all.slice(0, 12).map((i) => ({ key: i.key, at: day - 1 })),
  };
  // Twelve cards finished yesterday carry nothing over: no ramp, no used budget.
  for (const cap of [undefined, 5, 40])
    expect(workload(all, [yesterday], NOW, cap)).toMatchObject({
      cap: cap ?? 15,
      allowance: cap ?? 15,
      used: 0,
      remaining: cap ?? 15,
    });
  expect(workload(all, [yesterday], day - DAY_MS - 1, 5).allowance).toBe(5);
  // A finished reservation made today still spends today's budget until the UTC boundary.
  const today: ReviewReservation = {
    ...yesterday,
    id: "today",
    at: day,
    keys: all.slice(0, 4).map((i) => i.key),
    completions: all.slice(0, 4).map((i) => ({ key: i.key, at: day + 1 })),
  };
  expect(workload(all, [yesterday, today], NOW, 5)).toMatchObject({ used: 4, remaining: 1 });
  expect(workload(all, [yesterday, today], day + DAY_MS - 1, 5)).toMatchObject({ used: 4 });
  expect(workload(all, [yesterday, today], day + DAY_MS, 5)).toMatchObject({
    allowance: 5,
    used: 0,
    remaining: 5,
  });
  // Spending more than the cap (a lowered setting) floors remaining at zero.
  expect(workload(all, [today], NOW, 2)).toMatchObject({ used: 4, remaining: 0, eligible: 0 });
});
it("reserves failed and unfinished cards across midnight and excludes them even for early reviews", () => {
  const all = items();
  all[0].retiredAt = 1;
  all[1].needsReteach = true;
  const r: ReviewReservation = {
    id: "old",
    at: NOW - 3 * DAY_MS,
    keys: [all[2].key, all[3].key],
    active: true,
    completions: [],
  };
  const state = workload(all, [r], NOW, 5);
  expect(state).toMatchObject({ used: 2, remaining: 3, eligible: 3, deferred: 23 });
  const picked = pickDailyItems(all, NOW, 12, state, true);
  expect(picked).toHaveLength(3);
  expect(picked.some((i) => all.slice(0, 4).some((a) => a.key === i.key))).toBe(false);
});
it("moves recently checked but still-overdue unknown items behind untouched backlog", () => {
  const all = items();
  const selected = pickReviewItems(all, NOW, 5);
  const updated = all.map((i) =>
    selected.includes(i) ? { ...i, lastAt: NOW, lastFeedbackAt: NOW } : i,
  );
  const next = pickReviewItems(updated, NOW + DAY_MS, 5);
  expect(next.some((i) => selected.some((s) => s.key === i.key))).toBe(false);
  expect(pickReviewItems([...updated].reverse(), NOW + DAY_MS, 5)).toEqual(next);
});
let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.cleanup();
});
const setConfig = (config: object) =>
  fs.writeFileSync(path.join(fixture.root, "test-config.json"), JSON.stringify(config));
function seed(classroom = "rust") {
  seedClassroom(fixture, { classroom });
  const ids = Array.from({ length: 20 }, (_, i) => `q${i + 1}`);
  seedPreparedReviewSource(fixture.root, classroom, "001-ownership", "check-1", ids);
  closeReviewVariants(fixture.root, classroom);
  writeGradedAttempt({
    classroom,
    at: NOW - 20 * DAY_MS,
    answers: ids.map((id) => termAnswer(id, "owner")),
    correct: Object.fromEntries(ids.map((id) => [id, true])),
  });
}
it("shares one classroom's durable reservations across its starts, daily plans, topics, reload and clock changes", () => {
  setConfig({ dailyReviewLimit: 5 });
  seed();
  seed("biology");
  const first = startReview("rust", randomUUID(), "pi", 3).session;
  completePreparedReview(first);
  expect(startReview("rust", randomUUID(), "pi", 12).session.id).toBe(first.id);
  expect(classroomWorkload("rust", store.reviewItems("rust"), NOW)).toMatchObject({
    used: 3,
    remaining: 2,
  });
  // Complete actual published cards once; no mutation of original assessment history.
  first.items.forEach((item, i) =>
    writeGradedAttempt({
      lesson: first.lesson,
      quizId: i === 0 ? "review" : `review-${i + 1}`,
      kind: "review",
      at: NOW + i,
      answers: [termAnswer(`r${i + 1}`, "owner", { reviewOf: item.key })],
      correct: { [`r${i + 1}`]: true },
    }),
  );
  expect(resumableReview(reviewSessions("rust")[0])).toBe(false);
  const next = startReview("rust", randomUUID(), "pi", 12, { early: true }).session;
  expect(next.items).toHaveLength(2);
  expect(next.items.some((i) => first.items.some((a) => a.key === i.key))).toBe(false);
  const daily = startDailyReview(randomUUID(), "pi");
  expect(daily.groups.find((g) => g.classroom === "rust")!.plan.id).toBe(next.id);
  // Rust's budget is spent, but biology has its own: the daily batch still serves it in full.
  expect(daily.groups.find((g) => g.classroom === "biology")!.plan.items).toHaveLength(5);
  expect(() => startReview("biology", randomUUID(), "pi")).toThrow("allowance is reserved");
  const snapshot = JSON.stringify(dailyReviews());
  Date.now = () => NOW + DAY_MS;
  expect(startDailyReview(randomUUID(), "pi").id).toBe(daily.id);
  expect(JSON.stringify(dailyReviews())).toBe(snapshot);
  expect(reviewSessions("rust")).toHaveLength(2);
  // The first review's three completions earn nothing tomorrow; only the unfinished plan still counts.
  expect(classroomWorkload("rust", store.reviewItems("rust"), NOW + DAY_MS)).toMatchObject({
    allowance: 5,
    used: 2,
    remaining: 3,
  });
  const rootLock = path.join(fixture.root, ".daily-reviews.lock");
  fs.writeFileSync(rootLock, "concurrent host");
  expect(() => startReview("biology", randomUUID(), "pi")).toThrow("locked daily review edits");
  expect(() => startDailyReview(randomUUID(), "pi")).toThrow("locked daily review edits");
  fs.unlinkSync(rootLock);
});

// Nine classrooms publish and grade four days on disk; allow for filesystem work, not a latency claim.
it("serves every classroom its own bounded share each day, with no carry-over between days", () => {
  setConfig({ dailyReviewLimit: 2 });
  for (let c = 0; c < 9; c++) seed(`class-${c}`);
  for (let day = 0; day < 4; day++) {
    vi.mocked(Date.now).mockReturnValue(NOW + day * DAY_MS);
    const batch = startDailyReview(randomUUID(), "pi");
    const count = batch.groups.reduce((n, g) => n + g.plan.items.length, 0);
    // Nine classrooms times two cards: the budget is per classroom, not one shared allowance.
    expect(batch.groups.map((g) => g.classroom).sort()).toEqual(
      Array.from({ length: 9 }, (_, c) => `class-${c}`),
    );
    for (const group of batch.groups) expect(group.plan.items).toHaveLength(2);
    expect(count).toBe(18);
    expect(count).toBeLessThanOrEqual(rootWorkload(Date.now()).allowance);
    expect(startDailyReview(randomUUID(), "pi").id).toBe(batch.id);
    for (const group of batch.groups) {
      const saved = savePlannedReview(group.plan);
      completePreparedReview(saved);
      group.plan.items.forEach((item, i) =>
        writeGradedAttempt({
          classroom: group.classroom,
          lesson: group.plan.lesson,
          quizId: i === 0 ? "review" : `review-${i + 1}`,
          kind: "review",
          at: Date.now() + i,
          answers: [termAnswer(`r${i + 1}`, "owner", { reviewOf: item.key })],
          correct: { [`r${i + 1}`]: true },
        }),
      );
    }
    expect(rootWorkload(Date.now())).toMatchObject({ allowance: 18, used: 18, remaining: 0 });
    expect(() => startReview("class-8", randomUUID(), "pi", 12, { early: true })).toThrow(
      "allowance is reserved",
    );
  }
}, 20_000);

it("rotates topics within a classroom", () => {
  // Separate topic queues remain fair even within a single classroom.
  const all = items().map((item, i) => ({ ...item, lesson: `lesson-${i % 3}` }));
  const candidates = [{ classroom: "topics", items: all }];
  const state = workload(all, [], NOW);
  const chosen = pickAcrossClassrooms(candidates, NOW, state, []).get("topics")!;
  expect(new Set(chosen.slice(0, 3).map((i) => reviewTopic(i).id)).size).toBe(3);
  const history = [
    {
      id: "previous",
      classroom: "topics",
      at: NOW - DAY_MS,
      keys: [],
      active: false,
      completions: [],
      topics: [reviewTopic(all[0]).id],
    },
  ];
  const next = pickAcrossClassrooms(candidates, NOW, state, history).get("topics")!;
  expect(reviewTopic(next[0]).id).not.toBe(reviewTopic(all[0]).id);
  expect(
    pickAcrossClassrooms([...candidates].reverse(), NOW, state, [...history].reverse()),
  ).toEqual(new Map([["topics", next]]));
});

it("gives each classroom up to its own limit, with no count shared across classrooms", () => {
  const candidates = Array.from({ length: 9 }, (_, i) => ({ classroom: `c${i}`, items: items() }));
  const state = workload([], [], NOW);
  // Without a limit function every classroom may take the whole remaining budget.
  const all = pickAcrossClassrooms(candidates, NOW, state, []);
  expect([...all.keys()].sort()).toEqual(candidates.map((c) => c.classroom));
  for (const picks of all.values()) expect(picks).toHaveLength(state.remaining);
  const limits: Record<string, number> = { c0: 1, c1: 100, c2: 0 };
  const picked = pickAcrossClassrooms(
    candidates,
    NOW,
    state,
    [],
    (classroom) => limits[classroom] ?? 4,
  );
  expect(picked.has("c2")).toBe(false);
  expect(picked.get("c0")).toHaveLength(1);
  expect(picked.get("c1")).toHaveLength(30);
  for (const c of candidates.slice(3)) expect(picked.get(c.classroom)).toHaveLength(4);
  for (const [classroom, picks] of picked) {
    expect(new Set(picks.map((i) => i.key)).size).toBe(picks.length);
    expect(picks.every((i) => Number.isFinite(i.dueAt))).toBe(true);
    expect(candidates.find((c) => c.classroom === classroom)!.items).toEqual(
      expect.arrayContaining(picks),
    );
  }
  // A classroom's own history still rotates its topics; another classroom's does not matter.
  const grouped = items().map((item, i) => ({ ...item, lesson: `lesson-${i % 3}` }));
  const history: ReviewReservation[] = [
    {
      id: "previous",
      classroom: "c0",
      at: NOW - DAY_MS,
      keys: [],
      active: false,
      completions: [],
      topics: [reviewTopic(grouped[0]).id],
    },
  ];
  const rotated = pickAcrossClassrooms(
    [{ classroom: "c0", items: grouped }],
    NOW,
    state,
    history,
    () => 3,
  );
  expect(rotated.get("c0")).toHaveLength(3);
  expect(reviewTopic(rotated.get("c0")![0]).id).not.toBe(reviewTopic(grouped[0]).id);
});

it("serializes independent host processes against per-classroom budgets and reports lock contention", async () => {
  setConfig({ dailyReviewLimit: 5 });
  seed();
  seed("biology");
  const execute = promisify(execFile);
  const source = new URL("../src/review-session.ts", import.meta.url).href;
  const attempt = async (classroom: string) => {
    const code = `import {startReview} from ${JSON.stringify(source)};Date.now=()=>${NOW};try{const r=startReview(${JSON.stringify(classroom)},${JSON.stringify(randomUUID())},"pi",3);console.log(JSON.stringify({id:r.session.id,classroom:${JSON.stringify(classroom)},keys:r.session.items.map(i=>i.key)}));}catch(error){console.log(JSON.stringify({error:error.message}));}`;
    return JSON.parse(
      (
        await execute(process.execPath, ["--input-type=module", "-e", code], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PI_CLASSROOMS_DIR: fixture.root,
            PI_CLASSROOM_CONFIG: path.join(fixture.root, "test-config.json"),
          },
        })
      ).stdout,
    );
  };
  const results = await Promise.all([attempt("rust"), attempt("biology")]);
  expect(results.filter((r) => r.keys).length).toBeGreaterThan(0);
  for (const result of results)
    if (result.error) expect(result.error).toContain("locked daily review edits");
  for (const result of results.filter((r) => r.keys)) {
    const state = classroomWorkload(result.classroom, store.reviewItems(result.classroom), NOW);
    expect(state.used).toBeLessThanOrEqual(5);
    expect(state.used).toBe(result.keys.length);
    expect(state.remaining).toBe(5 - state.used);
  }
  const total = results.filter((r) => r.keys).reduce((n, r) => n + r.keys.length, 0);
  expect(rootWorkload(NOW)).toMatchObject({ cap: 10, used: total, remaining: 10 - total });
});

// Grade every card of a review once, which ends the review but leaves its cards counted today.
function finishReview(session: ReturnType<typeof startReview>["session"], classroom = "rust") {
  completePreparedReview(session);
  session.items.forEach((item, i) =>
    writeGradedAttempt({
      classroom,
      lesson: session.lesson,
      quizId: i === 0 ? "review" : `review-${i + 1}`,
      kind: "review",
      at: NOW + i,
      answers: [termAnswer(`r${i + 1}`, "owner", { reviewOf: item.key })],
      correct: { [`r${i + 1}`]: true },
    }),
  );
}

it("lets one classroom exhaust its budget without blocking another, and carries nothing to the next day", () => {
  setConfig({ dailyReviewLimit: 3 });
  seed();
  seed("biology");
  const first = startReview("rust", randomUUID(), "pi", 12).session;
  expect(first.items).toHaveLength(3);
  finishReview(first);
  expect(() => startReview("rust", randomUUID(), "pi", 3, { early: true })).toThrow(
    "allowance is reserved",
  );
  expect(classroomWorkload("rust", store.reviewItems("rust"), NOW)).toMatchObject({
    allowance: 3,
    used: 3,
    remaining: 0,
  });
  // Biology is untouched by rust's spending.
  expect(classroomWorkload("biology", store.reviewItems("biology"), NOW)).toMatchObject({
    used: 0,
    remaining: 3,
  });
  const other = startReview("biology", randomUUID(), "pi", 12).session;
  expect(other.items).toHaveLength(3);
  expect(rootWorkload(NOW)).toMatchObject({ cap: 6, allowance: 6, used: 6, remaining: 0 });
  finishReview(other, "biology");
  // Next UTC day: a fresh flat budget, however much was finished yesterday.
  expect(classroomWorkload("rust", store.reviewItems("rust"), NOW + DAY_MS)).toMatchObject({
    allowance: 3,
    used: 0,
    remaining: 3,
  });
  expect(rootWorkload(NOW + DAY_MS)).toMatchObject({ cap: 6, used: 0, remaining: 6 });
});

it("leaves a classroom that spent its budget out of the daily batch while serving the others", () => {
  setConfig({ dailyReviewLimit: 3 });
  seed();
  seed("biology");
  finishReview(startReview("rust", randomUUID(), "pi", 3).session);
  const daily = startDailyReview(randomUUID(), "pi");
  expect(daily.groups.map((g) => g.classroom)).toEqual(["biology"]);
  expect(daily.groups[0].plan.items).toHaveLength(3);
});

it("honors dailyReviewLimits per classroom and sums them at the root", () => {
  setConfig({ dailyReviewLimit: 4, dailyReviewLimits: { biology: 2 } });
  seed();
  seed("biology");
  expect(classroomWorkload("rust", store.reviewItems("rust"), NOW)).toMatchObject({
    cap: 4,
    allowance: 4,
    remaining: 4,
  });
  expect(classroomWorkload("biology", store.reviewItems("biology"), NOW)).toMatchObject({
    cap: 2,
    allowance: 2,
    remaining: 2,
  });
  expect(startReview("rust", randomUUID(), "pi", 12).session.items).toHaveLength(4);
  expect(startReview("biology", randomUUID(), "pi", 12).session.items).toHaveLength(2);
  const root = rootWorkload(NOW);
  expect(root).toMatchObject({ cap: 6, allowance: 6, used: 6, remaining: 0, eligible: 0 });
  expect(root.reservedKeys).toHaveLength(6);
  expect(root.reservedKeys.filter((key) => key.startsWith("biology/"))).toHaveLength(2);
  // A classroom override can also raise one above the shared default.
  setConfig({ dailyReviewLimit: 4, dailyReviewLimits: { biology: 9 } });
  expect(classroomWorkload("biology", store.reviewItems("biology"), NOW)).toMatchObject({
    cap: 9,
    used: 2,
    remaining: 7,
  });
});

it("reserves canonical aliases while charging every original saved card", () => {
  const day = reviewDay(NOW);
  const reserved: ReviewReservation = {
    id: "legacy",
    at: day,
    active: true,
    keys: ["objective"],
    cards: ["q1", "q2", "q3"],
    completions: [],
  };
  expect(workload([], [reserved], NOW, 5)).toMatchObject({ used: 3, remaining: 2 });
});

it("keeps an older saved question alias eligible without selecting its objective twice", () => {
  seedClassroom(fixture);
  seedPreparedReviewSource(fixture.root);
  const learning = {
    objectiveId: "owner",
    objective: { statement: "Explain ownership.", application: false },
    task: "retrieval" as const,
    support: "independent" as const,
    assistance: "none" as const,
  };
  writeGradedAttempt({
    at: NOW - 20 * DAY_MS,
    answers: [termAnswer("q1", "owner", { learning })],
    correct: { q1: true },
  });
  const first = startReview("rust", randomUUID(), "pi", 3).session;
  const canonical = first.items[0].key,
    alias = "001-ownership/check-1/q1";
  const file = path.join(fixture.root, "rust/.reviews.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(canonical, alias));
  const old = reviewSessions("rust")[0];
  const bytes = fs.readFileSync(file, "utf8");
  expect(plannedReviewEligible(old)).toBe(true);
  const state = classroomWorkload("rust", store.reviewItems("rust"), NOW);
  expect(state.reservedKeys).toContain(canonical);
  expect(pickDailyItems(store.reviewItems("rust"), NOW, 12, state, true)).toEqual([]);
  expect(fs.readFileSync(file, "utf8")).toBe(bytes);
});
