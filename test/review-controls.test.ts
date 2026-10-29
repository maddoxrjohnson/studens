import { ClassroomBridge } from "../src/bridge.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { readTeacherState, saveTeacherState } from "../src/service-state.ts";
import { createHash } from "node:crypto";
import { lessonDir } from "../src/paths.ts";
import { refillRequests } from "../src/review-refill.ts";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DAY_MS, pickReviewItems, reviewTopic, scheduleItems, summarize } from "../src/review.ts";
import { completePreparedReview, reviewSessions, startReview } from "../src/review-session.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import {
  closeReviewVariants,
  refillPlan,
  makeFixture,
  seedClassroom,
  seedPreparedReviewSource,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";
let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
  seedClassroom(fixture);
  const ids = Array.from({ length: 14 }, (_, i) => `q${i + 1}`);
  seedPreparedReviewSource(fixture.root, "rust", "001-ownership", "check-1", ids);
  closeReviewVariants(fixture.root);
  writeGradedAttempt({
    at: Date.now() - 2 * DAY_MS,
    answers: ids.map((id) => termAnswer(id, "owner")),
    correct: Object.fromEntries(ids.map((id) => [id, true])),
  });
});
afterEach(async () => {
  await server.close();
  fixture.cleanup();
});
const post = (base: string, route: string, body: unknown) =>
  fetch(`${base}/api/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

it.each([0, 1, 2, 2.5, 13, Infinity, "3", null])(
  "rejects invalid review size %s before any request or writes",
  (size) => {
    expect(() => startReview("rust", randomUUID(), "pi", size as number)).toThrow(
      "whole number from 3 to 12",
    );
    expect(reviewSessions("rust")).toEqual([]);
  },
);
const setConfig = (config: object) =>
  fs.writeFileSync(path.join(fixture.root, "test-config.json"), JSON.stringify(config));
it.each([3, 12])("bounds the requested maximum %i by the classroom's daily limit", (size) => {
  setConfig({ dailyReviewLimit: 5 });
  const id = randomUUID();
  const review = startReview("rust", id, "pi", size).session;
  expect(review.items).toHaveLength(Math.min(size, 5));
  expect(reviewSessions("rust")[0].options).toEqual({ limit: size, early: false });
  expect(startReview("rust", id, "pi", size).session).toEqual(review);
  expect(() => startReview("rust", id, "service", size)).toThrow("belongs to pi");
});
it("scopes topics by original objective groups and classroom-local identities", () => {
  seedClassroom(fixture, { classroom: "other" });
  seedPreparedReviewSource(fixture.root, "other");
  writeGradedAttempt({
    classroom: "other",
    at: Date.now() - 2 * DAY_MS,
    answers: [termAnswer("q1", "owner")],
    correct: { q1: true },
  });
  const objective = {
    statement: "Apply ownership",
    application: false,
    interleaveGroup: "Ownership rules",
    strategy: "Trace the current owner",
  };
  seedPreparedReviewSource(fixture.root, "rust", "002-groups", "check-1", ["left", "right"]);
  const answers = ["left", "right"].map((id) =>
    termAnswer(id, "owner", {
      learning: {
        objectiveId: id,
        objective,
        task: "retrieval",
        support: "independent",
        assistance: "none",
      },
    }),
  );
  writeGradedAttempt({
    at: Date.now() - 3 * DAY_MS,
    lesson: "002-groups",
    answers,
    correct: { left: true, right: true },
  });
  const grouped = store.reviewItems("rust").filter((item) => item.objective);
  expect(grouped).toHaveLength(2);
  expect(reviewTopic(grouped[0]).id).toBe(reviewTopic(grouped[1]).id);
  const groupTopic = reviewTopic(grouped[0]).id;
  const other = store.reviewItems("other");
  const review = startReview("rust", randomUUID(), "pi", 3, { topic: groupTopic }).session;
  expect(review.items).toHaveLength(2);
  expect(review.items.every((item) => item.objective?.interleaveGroup === "Ownership rules")).toBe(
    true,
  );
  const retired = store.setReviewRetired("rust", "002-groups/check-1/left", true, 0);
  expect(retired.key).toBe("002-groups/@objective/left");
  expect(
    store.reviewItems("rust").find((item) => item.key === retired.key)?.retiredAt,
  ).toBeGreaterThan(0);
  expect(store.reviewEvents("rust").some((event) => event.key === retired.key)).toBe(true);
  expect(store.reviewItems("other")).toEqual(other);
  expect(() => startReview("other", randomUUID(), "pi", 3, { topic: "missing" })).toThrow(
    "no longer active",
  );
});
it("retires an item without changing evidence, rejects stale actions, and restores it", () => {
  const item = store.reviewItems("rust")[0];
  const events = store.reviewEvents("rust");
  const grades = store.listGrades("rust", "001-ownership");
  const retired = store.setReviewRetired("rust", item.key, true, 0);
  expect(retired.retiredAt).toBeGreaterThan(0);
  expect(store.setReviewRetired("rust", item.key, true, 0)).toEqual(retired);
  expect(store.reviewItems("rust")).toHaveLength(14);
  expect(summarize(store.reviewItems("rust"), Date.now())).toMatchObject({
    total: 13,
    due: 13,
    retired: 1,
  });
  expect(
    pickReviewItems(store.reviewItems("rust"), Date.now(), 12, true).some(
      (i) => i.key === item.key,
    ),
  ).toBe(false);
  expect(
    startReview("rust", randomUUID(), "pi", 12, { early: true }).session.items.some(
      (selected) => selected.key === item.key,
    ),
  ).toBe(false);
  const restored = store.setReviewRetired("rust", item.key, false, 1);
  expect(restored).toMatchObject({ retiredAt: undefined, controlRevision: 2 });
  expect(() => store.setReviewRetired("rust", item.key, true, 0)).toThrow("another tab");
  expect(store.reviewEvents("rust")).toEqual(events);
  expect(store.listGrades("rust", "001-ownership")).toEqual(grades);
});
it("rejects corrupt retirement state and symlinks rather than silently dropping controls", () => {
  const file = fixture.write("rust/.review-controls.json", "{bad");
  expect(() => store.reviewItems("rust")).toThrow("Cannot read review controls");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, items: [{ key: "unknown", revision: 1, retiredAt: 1 }] }),
  );
  expect(() => store.reviewItems("rust")).toThrow("unknown item");
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(fixture.root, "rust/classroom.json"), file);
  expect(() => store.reviewItems("rust")).toThrow("symlinks");
});
it("keeps an early miss's scheduled date across HTTP grading and recovery, retaining the saved timing privately", async () => {
  seedClassroom(fixture, { classroom: "early" });
  seedPreparedReviewSource(fixture.root, "early");
  closeReviewVariants(fixture.root, "early");
  const keyFile = path.join(fixture.root, "early/001-ownership/quiz/key.json");
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  for (const variant of key["check-1"].q1.variants)
    variant.rubric.criteria = [
      { id: "owner", description: "Identify the current owner", points: 1 },
    ];
  fs.writeFileSync(keyFile, JSON.stringify(key));
  writeGradedAttempt({
    classroom: "early",
    at: Date.now() - 3600000,
    answers: [termAnswer("q1", "owner")],
    correct: { q1: true },
  });
  const before = store.reviewItems("early")[0];
  server.setHooks({
    reviewOwner: "pi",
    onReview: completePreparedReview,
    onReviewRetry: completePreparedReview,
    onAsk() {},
    onFollowUp() {},
    onReflect() {},
    onQuizSubmit() {
      throw new Error("Closed review used teacher grading");
    },
  });
  const base = await server.start(0);
  const id = randomUUID();
  expect((await post(base, "review", { classroom: "early", id, size: 3 })).status).toBe(409);
  expect(
    (await post(base, "review", { classroom: "early", id, size: 3, early: true })).status,
  ).toBe(202);
  const review = reviewSessions("early")[0];
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events?classroom=early&lesson=${review.lesson}`, {
    signal: controller.signal,
  });
  const reader = stream.body!.getReader();
  await reader.read();
  const response = await post(base, "quiz/submit", {
    classroom: "early",
    lesson: review.lesson,
    quizId: "review",
    kind: "review",
    answers: [
      {
        questionId: "r1",
        type: "choice",
        value: "old",
        label: "Old binding",
        reviewOf: before.key,
      },
    ],
  });
  expect(response.status).toBe(201);
  const publicAttempt = await response.json();
  expect(publicAttempt).not.toHaveProperty("earlyReviewKeys");
  expect(publicAttempt).not.toHaveProperty("rubricCriteria");
  const saved = store.listSubmissions("early", review.lesson)[0];
  expect(saved.earlyReviewKeys).toEqual([before.key]);
  expect(saved.rubricCriteria?.r1).toEqual(key["check-1"].q1.variants[0].rubric.criteria);
  const frame = new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  await reader.cancel().catch(() => {});
  expect(frame).toContain("event: grade");
  expect(frame).not.toMatch(
    /rubricCriteria|earlyReviewKeys|teachingPlan|deterministicGrades|"learning":/,
  );
  expect(frame).toContain('"criterionId":"owner"');
  const publicState = await (
    await fetch(`${base}/api/state?classroom=early&lesson=${review.lesson}`)
  ).text();
  expect(publicState).not.toMatch(
    /rubricCriteria|earlyReviewKeys|teachingPlan|deterministicGrades|"learning":/,
  );
  expect(store.reviewItems("early")[0]).toMatchObject({
    key: before.key,
    dueAt: before.dueAt,
    attempts: 2,
    lastCorrect: false,
  });
  await server.close();
  const recoveredBase = await server.start(0);
  expect(store.reviewItems("early")[0].dueAt).toBe(before.dueAt);
  expect(store.listGrades("early", review.lesson)).toHaveLength(1);
  expect((await fetch(`${recoveredBase}/c/early/.review-controls.json`)).status).toBe(404);
});
it("preserves the interval even when a selected early question is answered after its original due time", () => {
  const evidence = {
    objectiveId: "o",
    objective: { statement: "Explain", application: false },
    task: "retrieval" as const,
    support: "independent" as const,
    assistance: "none" as const,
  };
  const event = (day: number) => ({
    key: "001-ownership/@objective/o",
    at: day * DAY_MS,
    correct: true,
    prompt: "Explain",
    answer: "answer",
    feedback: "feedback",
    evidence,
  });
  const history = [event(0), event(1)];
  const before = scheduleItems(history)[0];
  expect(before.dueAt).toBeGreaterThan(2 * DAY_MS);
  for (const correct of [true, false]) {
    const after = scheduleItems([...history, { ...event(5), early: true, correct }])[0];
    expect(after.dueAt).toBeLessThanOrEqual(before.dueAt);
    expect(after.box).toBe(correct ? before.box : 0);
  }
  const assisted = scheduleItems([
    ...history,
    { ...event(1.1), early: true, evidence: { ...evidence, assistance: "hint" as const } },
  ])[0];
  expect(assisted.context).toBe("assisted");
  expect(assisted.progress).not.toBe("retained-evidence");
});

it("rejects a review report sent through Pi when a persistent teacher owns the classroom", async () => {
  const review = startReview("rust", randomUUID(), "pi", 3).session;
  completePreparedReview(review);
  const teacher = new TeacherService();
  teacher.attach("rust", "codex");
  const bridge = new ClassroomBridge({
    sendUserMessage() {
      throw new Error("Report reached the wrong teacher");
    },
  });
  try {
    expect(() => bridge.chat("rust", review.lesson, "Bad question report", randomUUID())).toThrow(
      "belongs to a persistent teacher",
    );
    expect(store.listPanelMessages("rust", review.lesson)).toEqual([]);
  } finally {
    bridge.reset();
    await teacher.stop();
  }
});

it("requires explicit retry after a competing server holds the retirement lock", () => {
  const item = store.reviewItems("rust")[0];
  const lock = fixture.write("rust/.review-controls.json.lock", "other owner");
  expect(() => store.setReviewRetired("rust", item.key, true, 0)).toThrow(
    "locked review item edits",
  );
  expect(store.reviewItems("rust")[0].retiredAt).toBeUndefined();
  fs.unlinkSync(lock);
  expect(store.setReviewRetired("rust", item.key, true, 0).retiredAt).toBeGreaterThan(0);
});

it("keeps paused and retired items out of early selection while preserving restore history", () => {
  setConfig({ dailyReviewLimit: 5 });
  for (let i = 0; i < 3; i++)
    writeGradedAttempt({
      at: Date.now() - (1.9 - i / 10) * DAY_MS,
      answers: [termAnswer("q2", "old")],
      correct: { q2: false },
    });
  const paused = store.reviewItems("rust").find((item) => item.questionId === "q2")!;
  expect(paused).toMatchObject({ needsReteach: true, misses: 3 });
  const retired = store.setReviewRetired("rust", paused.key, true, 0);
  expect(summarize(store.reviewItems("rust"), Date.now())).toMatchObject({
    total: 13,
    due: 13,
    retired: 1,
  });
  const restored = store.setReviewRetired("rust", retired.key, false, 1);
  expect(restored).toMatchObject({ needsReteach: true, misses: 3, attempts: 4 });
  const other = store.reviewItems("rust").find((item) => item.questionId === "q1")!;
  store.setReviewRetired("rust", other.key, true, 0);
  const items = store.reviewItems("rust");
  expect(summarize(items, Date.now())).toMatchObject({ total: 13, due: 12, retired: 1 });
  const selected = startReview("rust", randomUUID(), "pi", 12, { early: true }).session.items;
  expect(selected).toHaveLength(5);
  expect(selected.some((item) => item.key === paused.key || item.key === other.key)).toBe(false);
});

it("recovers partial criterion credit on an early review once, preserving timing and model snapshots", async () => {
  seedClassroom(fixture, { classroom: "partial" });
  seedPreparedReviewSource(fixture.root, "partial");
  const keyFile = path.join(fixture.root, "partial/001-ownership/quiz/key.json");
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const criteria = [
    { id: "owner", description: "Identify the current owner", points: 2 },
    { id: "release", description: "Explain when the value is released", points: 2 },
  ];
  for (const variant of key["check-1"].q1.variants) {
    variant.rubric.points = 4;
    variant.rubric.criteria = criteria;
  }
  fs.writeFileSync(keyFile, JSON.stringify(key));
  writeGradedAttempt({
    classroom: "partial",
    at: Date.now() - 3600000,
    answers: [termAnswer("q1", "owner")],
    correct: { q1: true },
  });
  const before = store.reviewItems("partial")[0];
  server.setHooks({
    reviewOwner: "service",
    onReview: completePreparedReview,
    onReviewRetry: completePreparedReview,
    onAsk() {},
    onReflect() {},
    onFollowUp() {},
    onQuizSubmit() {},
  });
  const base = await server.start(0);
  expect(
    (await post(base, "review", { classroom: "partial", id: randomUUID(), early: true })).status,
  ).toBe(202);
  const review = reviewSessions("partial")[0];
  const response = await post(base, "quiz/submit", {
    classroom: "partial",
    lesson: review.lesson,
    quizId: "review",
    kind: "review",
    answers: [
      {
        questionId: "r1",
        type: "short",
        value: "The new owner",
        reviewOf: before.key,
        assistance: "hint",
      },
    ],
  });
  expect(response.status).toBe(201);
  const publicAttempt = await response.json();
  const saved = store.findSubmission(publicAttempt.id)!;
  expect(saved.rubricCriteria?.r1).toEqual(criteria);
  expect(saved.earlyReviewKeys).toEqual([before.key]);
  const pending = await (
    await fetch(`${base}/api/state?classroom=partial&lesson=${review.lesson}`)
  ).text();
  for (const value of [JSON.stringify(publicAttempt), pending])
    expect(value).not.toMatch(
      /rubricCriteria|earlyReviewKeys|teachingPlan|deterministicGrades|"learning":/,
    );
  expect(JSON.parse(pending).quizzes[0].grade).toBeNull();
  const plan = {
    calls: [
      {
        name: "grade_quiz_answers",
        arguments_json: JSON.stringify({
          submission_id: saved.id,
          feedback_markdown: "The owner is named; explain release timing.",
          questions: [
            {
              question_id: "r1",
              correct: false,
              points_earned: 1,
              points_possible: 4,
              feedback: "Identify the owning binding and explain when it releases the value.",
              criteria: [
                {
                  criterion_id: "owner",
                  points_earned: 1,
                  feedback: "You named a new owner but not the binding.",
                },
                {
                  criterion_id: "release",
                  points_earned: 0,
                  feedback: "Explain release at the owning scope's end.",
                },
              ],
            },
          ],
        }),
      },
    ],
    message: "Explain when the owning scope releases the value.",
    learning_record: "",
    notes_markdown: "",
  };
  saveTeacherState("partial", {
    version: 1,
    identity: { backend: "codex", requestedModel: "new-selection", sessionId: "same-conversation" },
    messages: [],
    requests: [
      {
        id: `quiz:${saved.id}`,
        classroom: "partial",
        lesson: review.lesson,
        kind: "quiz",
        target: saved.id,
        prompt: "saved",
        status: "planned",
        at: 1,
        applied: 0,
        planVersion: 2,
        planValidated: true,
        requestedModel: "original-selection",
        resolvedModel: "original-model",
        planRubricDigest: createHash("sha256")
          .update(fs.readFileSync(path.join(lessonDir("partial", review.lesson), "quiz/key.json")))
          .digest("hex"),
        plan,
      },
    ],
  });
  let gradingInferenceCalls = 0;
  const backgroundCalls: string[] = [];
  for (let replay = 0; replay < 2; replay++) {
    if (replay) {
      const state = readTeacherState("partial")!;
      state.requests[0].status = "planned";
      state.requests[0].applied = 0;
      saveTeacherState("partial", state);
    }
    const teacher = new TeacherService(async (_identity, prompt) => {
      const request = refillRequests("partial").find(
        (r) => r.status === "running" && prompt.includes(r.id),
      );
      if (!request) {
        gradingInferenceCalls++;
        throw new Error("Unexpected grading inference during saved-plan recovery");
      }
      backgroundCalls.push(request.id);
      return refillPlan(request);
    });
    try {
      teacher.attach("partial", "codex");
      await teacher.idle();
    } finally {
      await teacher.stop();
    }
    expect(store.listGrades("partial", review.lesson)).toHaveLength(1);
    expect(store.listGrades("partial", review.lesson)[0]).toMatchObject({
      score: 25,
      questions: [{ pointsEarned: 1, pointsPossible: 4 }],
    });
    expect(readTeacherState("partial")?.requests[0]).toMatchObject({
      status: "done",
      requestedModel: "original-selection",
      resolvedModel: "original-model",
      plan,
    });
    expect(readTeacherState("partial")?.identity.sessionId).toBe("same-conversation");
    expect(store.reviewItems("partial")[0].dueAt).toBe(before.dueAt);
    expect(store.findSubmission(saved.id)?.earlyReviewKeys).toEqual([before.key]);
  }
  expect(gradingInferenceCalls).toBe(0);
  expect(backgroundCalls.length).toBeGreaterThan(0);
  expect(new Set(backgroundCalls).size).toBe(backgroundCalls.length);
  expect(readTeacherState("partial")!.requests.filter((r) => r.kind === "quiz")).toHaveLength(1);
  expect(readTeacherState("partial")!.requests.every((r) => r.status === "done")).toBe(true);
});
