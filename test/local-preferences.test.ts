/** Pins the local preferences in ~/.pi/agent/classroom.json so an upstream merge cannot silently drop them. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, validateConfig } from "../src/config.ts";
import { classroomPage } from "../src/pages.ts";
import { QUIZ_FOLLOW_UP, dedicatedTeacherPrompt, quizFollowUp } from "../src/prompts.ts";
import {
  DAY_MS,
  DEFAULT_DAILY_REVIEW_LIMIT,
  DEFAULT_REVIEW_SIZE,
  MAX_REVIEW_SIZE,
  dailyReviewLimit,
  defaultReviewSize,
  scheduleItems,
  type ReviewEvent,
} from "../src/review.ts";
import { injectLessonRuntime } from "../src/lesson-html.ts";
import { PROMPT_SPLIT, joinPrompt, splitPrompt } from "../src/prompt-split.ts";
import { syllabusPie } from "../src/syllabus-pie.ts";
import type { Classroom, Lesson } from "../src/store.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fixture: Fixture;
const setConfig = (config: object) =>
  fs.writeFileSync(path.join(fixture.root, "test-config.json"), JSON.stringify(config));
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

describe("local preference settings", () => {
  it("validates the new keys", () => {
    for (const bad of [
      { hideAnswerReports: "yes" },
      { syllabusPie: 1 },
      { reviewSingleForm: "no" },
      { reviewSize: 2 },
      { reviewSize: MAX_REVIEW_SIZE + 1 },
      { reviewSize: 4.5 },
    ])
      expect(() => validateConfig(bad as never)).toThrow();
    expect(() =>
      validateConfig({ hideAnswerReports: true, reviewSize: 10, syllabusPie: false }),
    ).not.toThrow();
  });
  it("validates the per-classroom daily review limits", () => {
    for (const bad of [
      { dailyReviewLimit: 0 },
      { dailyReviewLimit: 51 },
      { dailyReviewLimit: 2.5 },
      { dailyReviewLimit: "15" },
      { dailyReviewLimits: [] },
      { dailyReviewLimits: "rust" },
      { dailyReviewLimits: { rust: 0 } },
      { dailyReviewLimits: { rust: 51 } },
      { dailyReviewLimits: { rust: 2.5 } },
      { dailyReviewLimits: { rust: 5, biology: "7" } },
    ])
      expect(() => validateConfig(bad as never)).toThrow(/dailyReviewLimit/);
    for (const good of [
      { dailyReviewLimit: 1 },
      { dailyReviewLimit: 50 },
      { dailyReviewLimits: {} },
      { dailyReviewLimit: 15, dailyReviewLimits: { rust: 1, biology: 50 } },
    ])
      expect(() => validateConfig(good as never)).not.toThrow();
  });
  it("defaults to 15 cards per classroom and lets an override win", () => {
    expect(DEFAULT_DAILY_REVIEW_LIMIT).toBe(15);
    expect(dailyReviewLimit("rust")).toBe(15);
    setConfig({ dailyReviewLimit: 8, dailyReviewLimits: { biology: 3 } });
    expect(dailyReviewLimit("rust")).toBe(8);
    expect(dailyReviewLimit("biology")).toBe(3);
  });
  it("keeps upstream behavior when nothing is configured", () => {
    expect(readConfig()).toEqual({});
    expect(defaultReviewSize()).toBe(DEFAULT_REVIEW_SIZE);
    expect(DEFAULT_REVIEW_SIZE).toBe(5);
    expect(quizFollowUp()).toBe(QUIZ_FOLLOW_UP);
    expect(injectLessonRuntime("<html><head></head><body></body></html>", base)).not.toContain(
      "hideAnswerReports",
    );
  });
  it("keeps the dedicated teacher prompt consistent with the assistance policy", () => {
    const prompt = () => dedicatedTeacherPrompt("r", "request", {}, []);
    expect(prompt()).toContain("Use assistance unknown unless the learner states");
    setConfig({ hideAnswerReports: true });
    expect(prompt()).not.toContain("Use assistance unknown unless the learner states");
    expect(prompt()).toContain("Decide assistance yourself");
  });
  it("uses reviewSize as the default review size", () => {
    setConfig({ reviewSize: 10 });
    expect(defaultReviewSize()).toBe(10);
  });
  it("lets the teacher decide assistance when hideAnswerReports is set", () => {
    setConfig({ hideAnswerReports: true });
    expect(quizFollowUp()).toContain("Decide assistance yourself");
    expect(quizFollowUp()).not.toContain("Ask them to report assistance");
    expect(injectLessonRuntime("<html><head></head><body></body></html>", base)).toContain(
      '"hideAnswerReports":true',
    );
  });
});

const base = {
  classroom: "c",
  lesson: "l",
  classroomTitle: "C",
  lessonTitle: "L",
  baseUrl: "http://127.0.0.1",
};

describe("review scheduling fix", () => {
  const T0 = Date.UTC(2026, 0, 1);
  const legacy = (day: number): ReviewEvent => ({
    key: "001-cost/check/q1",
    at: T0 + day * DAY_MS,
    correct: true,
    prompt: "p",
    answer: "a",
    feedback: "f",
    gapIndependent: true,
  });
  it("spaces out a legacy item whose independence is saved on the event", () => {
    const [item] = scheduleItems([legacy(0), legacy(2), legacy(8)]);
    expect(item.box).toBeGreaterThan(0);
  });
});

const classroom: Classroom = {
  name: "aws",
  title: "AWS",
  emoji: "☁️",
  createdAt: 1,
  updatedAt: 2,
  mission: "# Mission: AWS\n",
  lessonCount: 1,
};
const lesson = (name: string, latestScore: number | null): Lesson =>
  ({
    name,
    classroom: "aws",
    title: name,
    summary: "",
    dueSoon: 0,
    retained: 0,
    transferNeeded: 0,
    unknown: 0,
    nextDueAt: null,
    latestScore,
  }) as unknown as Lesson;

const noProgress = {
  review: {
    total: 0,
    due: 0,
    dueSoon: 0,
    retained: 0,
    transferNeeded: 0,
    unknown: 0,
    nextDueAt: null,
  },
  dueByLesson: {},
  glossaryTerms: 0,
  now: 0,
};

describe("syllabus coverage pie", () => {
  const syllabus = {
    target: "EXAM",
    exams: [
      {
        name: "EXAM",
        domains: [
          { weight: 50, topics: [{ name: "a", lessons: ["001-a"] }, { name: "b" }] },
          { weight: 50, topics: [{ name: "c", lessons: ["002-c"] }] },
        ],
      },
    ],
  };
  it("renders nothing, without an error, when there is no syllabus.json", () => {
    fixture.write("aws/classroom.json", "{}");
    expect(syllabusPie("aws", [lesson("001-a", 1)], [])).toBe("");
  });
  it("renders nothing for an unreadable or empty syllabus.json", () => {
    fixture.write("aws/syllabus.json", "{not json");
    expect(syllabusPie("aws", [], [])).toBe("");
    fixture.write("aws/syllabus.json", JSON.stringify({ exams: [] }));
    expect(syllabusPie("aws", [], [])).toBe("");
  });
  it("weights topics by domain and counts taught lessons as seen", () => {
    fixture.write("aws/syllabus.json", JSON.stringify(syllabus));
    const html = syllabusPie("aws", [lesson("001-a", 1), lesson("002-c", null)], []);
    expect(html).toContain("Syllabus coverage: EXAM");
    expect(html).toContain("Seen <strong>25%</strong>");
    expect(html).toContain("Not seen <strong>75%</strong>");
  });
  it("appears on the classroom page and the syllabusPie setting turns it off", () => {
    fixture.write("aws/syllabus.json", JSON.stringify(syllabus));
    const data = {
      classroom,
      lessons: [lesson("001-a", 1)],
      docs: [],
      learningRecords: [],
      referenceDocs: [],
      progress: noProgress,
    } as never;
    expect(classroomPage(data)).toContain("cl-syllabus-pie");
    setConfig({ syllabusPie: false });
    expect(classroomPage(data)).not.toContain("cl-syllabus-pie");
  });
});

describe("teacher prompt order", () => {
  const context = {
    lesson: "<p>lesson</p>",
    lessonStage: { gatedPretests: [] },
    privateRubric: "{}",
    records: ["r"],
    messages: [{ text: "hi" }],
    classroomDocs: [],
    topicNotes: [],
  };
  const build = () => dedicatedTeacherPrompt("req-1", "Learner asks X", context, [{ name: "t" }]);
  const at = (prompt: string, marker: string) => prompt.indexOf(marker);
  it("keeps tool definitions, then the request, then the context by default", () => {
    const prompt = build();
    expect(at(prompt, "Tool definitions:")).toBeLessThan(at(prompt, "Request req-1:"));
    expect(at(prompt, "Request req-1:")).toBeLessThan(at(prompt, "Private context:"));
  });
  it("splits stable context from the changing request in cache order, losing nothing", () => {
    setConfig({ teacherPromptOrder: "cache" });
    const { stable, request } = splitPrompt(build());
    expect(stable).toBeDefined();
    expect(stable).toContain("You are the learner's dedicated classroom teacher.");
    expect(stable).not.toContain("req-1");
    expect(stable).not.toContain("Tool definitions:");
    expect(request.trimEnd().endsWith("Learner asks X")).toBe(true);
    expect(request).toContain("Tool definitions:");
    const json = (text: string, label: string) =>
      JSON.parse(text.slice(text.indexOf(label) + label.length).split("\n\n")[0]);
    const kept = json(stable!, "Private context (rarely changes):\n");
    const changing = json(request, "Private context (changes with each request):\n");
    expect(Object.keys(kept)).toEqual([
      "classroomDocs",
      "topicNotes",
      "records",
      "lesson",
      "privateRubric",
    ]);
    expect({ ...kept, ...changing }).toEqual(context);
    expect(joinPrompt(build())).not.toContain(PROMPT_SPLIT);
  });
});
