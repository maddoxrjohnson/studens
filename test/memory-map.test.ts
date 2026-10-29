import { describe, expect, it } from "vitest";
import { memoryForecast, memoryMapItems } from "../src/memory-map.ts";
import { DAY_MS, scheduleItems } from "../src/review.ts";
import type { ReviewEvent } from "../src/review.ts";
import type { PerformanceEvidence } from "../src/evidence.ts";
import { workload } from "../src/review-workload.ts";
import * as store from "../src/store.ts";
import { makeFixture } from "./helpers.ts";
import { NOW, seedMemory } from "./memory-map-fixture.ts";

const evidence: PerformanceEvidence = {
  objectiveId: "owner",
  objective: { statement: "Explain ownership", application: true, retentionDays: 16 },
  task: "retrieval",
  support: "independent",
  assistance: "none",
};
const event = (day: number, extra: Partial<ReviewEvent> = {}): ReviewEvent => ({
  key: "001-owner/@objective/owner",
  questionKey: "001-owner/check/q1",
  at: NOW + day * DAY_MS,
  correct: true,
  credit: 1,
  evidence,
  prompt: "Explain ownership",
  answer: "answer",
  feedback: "feedback",
  ...extra,
});

describe("memory map replay contract", () => {
  it("keeps unresolved misses open through supported or unknown success, and resolves independently", () => {
    const miss = event(0, { correct: false, credit: 0.5 });
    for (const assistance of ["hint", "unknown"] as const) {
      const history = [miss, event(2, { evidence: { ...evidence, assistance } })];
      expect(scheduleItems(history)[0]).toMatchObject({
        gapOpen: true,
        misses: 1,
        delayedSuccesses: 0,
      });
      expect(scheduleItems([...history, event(4)])[0]).toMatchObject({ gapOpen: false, misses: 1 });
    }
  });
  it("groups probes and uses weakest credit and independence for a gap", () => {
    const history = [
      event(0, { attemptId: "one", correct: false, credit: 0.5 }),
      event(0, { attemptId: "one", questionKey: "001-owner/check/q2" }),
    ];
    expect(scheduleItems(history)[0]).toMatchObject({
      attempts: 1,
      gapOpen: true,
      lastCredit: 0.5,
    });
    const correction = [
      event(2, { attemptId: "two" }),
      event(2, {
        attemptId: "two",
        questionKey: "001-owner/check/q2",
        evidence: { ...evidence, assistance: "hint" },
      }),
    ];
    expect(scheduleItems([...history, ...correction])[0]).toMatchObject({
      attempts: 2,
      gapOpen: true,
    });
  });
  it("keeps independent immediate corrections separate from delayed or transfer evidence", () => {
    const history = [event(0, { correct: false }), event(0.1)];
    expect(scheduleItems(history)[0]).toMatchObject({
      gapOpen: false,
      progress: "immediate-success",
      delayedSuccesses: 0,
    });
    const recalled = scheduleItems([event(0), event(2), event(9)])[0];
    expect(recalled).toMatchObject({
      progress: "transfer-needed",
      delayedSuccesses: 2,
      delayedTransfers: 0,
    });
    expect(
      scheduleItems([
        event(0),
        event(2),
        event(9),
        event(14, { evidence: { ...evidence, task: "transfer" } }),
      ])[0],
    ).toMatchObject({ progress: "retained-evidence", delayedTransfers: 1 });
  });
  it("uses saved latest grade credit, original answer and first feedback; regrading adds no exposure", () => {
    const f = makeFixture();
    try {
      const items = seedMemory(f),
        partial = items.find((i) => i.questionId === "partial")!;
      expect(partial).toMatchObject({ lastCredit: 0.5, gapOpen: true, attempts: 1 });
      const grade = store
        .listGrades("rust", "001-ownership")
        .filter((g) => g.questions[0].questionId === "partial")
        .at(-1)!;
      store.writeGrade({
        ...grade,
        gradedAt: NOW,
        disputeId: "saved-dispute",
        revisesGradedAt: grade.gradedAt,
        questions: [
          {
            questionId: "partial",
            correct: true,
            pointsEarned: 2,
            pointsPossible: 2,
            feedback: "Accepted equivalent explanation.",
          },
        ],
      });
      const revised = store.reviewItems("rust").find((i) => i.key === partial.key)!;
      expect(revised).toMatchObject({
        lastCredit: 1,
        gapOpen: false,
        attempts: 1,
        lastAt: partial.lastAt,
        lastFeedbackAt: partial.lastFeedbackAt,
        delayedSuccesses: 0,
      });
      expect(revised.dueAt).toBe(partial.lastFeedbackAt + DAY_MS);
    } finally {
      f.cleanup();
    }
  });
  it("preserves historical context even when saved independence resolves its answer gap", () => {
    const history = [
      event(0, { key: "001-owner/check/q1", evidence: undefined, correct: false }),
      event(2, {
        key: "001-owner/check/q1",
        evidence: undefined,
        gapIndependent: true,
        source: "chat",
      }),
    ];
    expect(scheduleItems(history)[0]).toMatchObject({
      gapOpen: false,
      progress: "context-unknown",
      delayedSuccesses: 0,
    });
  });
  it("ignores confidence and self-ratings and retains early caps and estimated memory", () => {
    const history = [event(0), event(2), event(9, { early: true, earlyDueAt: NOW + 3 * DAY_MS })];
    const item = scheduleItems(history)[0];
    expect(
      scheduleItems(history.map((e) => ({ ...e, confidence: "certain", selfRating: 10 }))),
    ).toEqual([item]);
    expect(item.dueAt).toBeLessThanOrEqual(NOW + 3 * DAY_MS);
    expect(item.dueAt).toBeLessThanOrEqual(item.lastFeedbackAt + 4 * DAY_MS);
  });
});

describe("fourteen UTC saved-due dates", () => {
  it("includes all today's backlog once; keeps later-today arrivals separate from now and excludes paused/retired", () => {
    const midnight = Math.floor(NOW / DAY_MS) * DAY_MS;
    const item = scheduleItems([event(0)])[0];
    const times = [
      midnight - 20 * DAY_MS,
      midnight,
      NOW,
      midnight + DAY_MS - 1,
      midnight + DAY_MS,
      midnight + 14 * DAY_MS - 1,
      midnight + 14 * DAY_MS,
    ];
    const items = times.map((dueAt, i) => ({ ...item, key: String(i), dueAt }));
    items.push(
      { ...item, key: "paused", needsReteach: true, dueAt: NOW },
      { ...item, key: "retired", retiredAt: NOW, dueAt: NOW },
    );
    const days = memoryForecast(items, NOW);
    expect(days).toHaveLength(14);
    expect(days.map((d) => d.count)).toEqual([4, 1, ...Array(11).fill(0), 1]);
    expect(days.map((d) => d.at)).toEqual(
      Array.from({ length: 14 }, (_, i) => midnight + i * DAY_MS),
    );
    expect(memoryForecast(items, midnight + DAY_MS)[0].count).toBe(5);
  });
  it("does not allocate future reviews or mutate the scheduler under shared limits", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...scheduleItems([event(-3)])[0],
      key: String(i),
    }));
    const before = structuredClone(items);
    const state = workload(items, [], NOW);
    expect(state).toMatchObject({ eligible: 15, deferred: 5, allowance: 15 });
    expect(workload(items, [], NOW, 5)).toMatchObject({ eligible: 5, deferred: 15, allowance: 5 });
    expect(memoryForecast(items, NOW).map((d) => d.count)).toEqual([20, ...Array(13).fill(0)]);
    expect(items).toEqual(before);
  });
  it("covers empty, long future and malformed clocks/dates explicitly", () => {
    expect(memoryForecast([], NOW).every((d) => d.count === 0)).toBe(true);
    expect(memoryForecast(scheduleItems([event(100)]), NOW).every((d) => d.count === 0)).toBe(true);
    expect(() => memoryForecast([], NaN)).toThrow("Invalid memory map clock");
    expect(() =>
      memoryForecast([{ ...scheduleItems([event(0)])[0], dueAt: Infinity }], NOW),
    ).toThrow("Invalid memory map due time");
    expect(() => scheduleItems([event(0, { at: NaN })])).toThrow("Invalid review event");
  });
  it("escapes source content and encodes original public paths without linking private files", () => {
    const item = scheduleItems([
      event(0, {
        prompt: "<img src=x>",
        feedback: "<script>alert(1)</script>",
        learningRecord: "001 record.md",
      }),
    ])[0];
    const html = memoryMapItems(
      "a classroom",
      [{ ...item, objective: { statement: "<img src=x>", application: false } }],
      NOW,
    );
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("/c/a%20classroom/001-owner");
    expect(html).toContain("/doc/a%20classroom/learning-records/001%20record.md");
    expect(html).not.toContain("/quiz/");
  });
});
