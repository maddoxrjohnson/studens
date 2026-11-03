import * as fs from "node:fs";
import { expect, it } from "vitest";
import { lessonModelPlan, LESSON_OUTPUT_SCHEMA } from "../src/lesson-output.ts";
import { planSchema } from "../src/teacher.ts";
import { validateLessonDocument } from "../src/next-lesson.ts";
import { makeFixture, seedClassroom, seedPreparedReviewSource } from "./helpers.ts";
import { nextLessonDocument } from "./next-lesson-fixture.ts";
import { lessonOutput, simpleLessonOutput } from "./lesson-output-fixture.ts";
import { authoredVariants } from "../src/review-variants.ts";
import { assembleReview } from "../src/review-pool.ts";
import { validateToolCall } from "@earendil-works/pi-ai";

it("rejects the retained missing-page and omitted-original failures without deriving content from variants", () => {
  const missingPage: any = structuredClone(simpleLessonOutput);
  delete missingPage.lesson_html;
  const before = structuredClone(missingPage);
  expect(() =>
    validateToolCall(
      [{ name: "submit_teacher_plan", description: "", parameters: LESSON_OUTPUT_SCHEMA as any }],
      { type: "toolCall", id: "missing-page", name: "submit_teacher_plan", arguments: missingPage },
    ),
  ).toThrow(/lesson_html/);
  expect(() => lessonModelPlan(missingPage)).toThrow(/missing/);
  expect(missingPage).toEqual(before);

  const missingOriginal: any = structuredClone(simpleLessonOutput);
  missingOriginal.lesson_html =
    '<form class="cl-quiz" data-quiz-id="check-1"><li class="cl-q" data-question-id="q1" data-type="short"><p>Who owns it?</p><textarea></textarea></li></form>';
  missingOriginal.variants = [
    {
      quiz: "check-1",
      question: "q1",
      id: "v1",
      html: "private variant",
      rubric: structuredClone(missingOriginal.quizzes[0].questions[0].rubric),
      task: "application",
    },
  ];
  missingOriginal.quizzes[0].id = "pretest-1";
  const retained = structuredClone(missingOriginal);
  expect(() => lessonModelPlan(missingOriginal)).toThrow(
    /omits original rubric and mapping for check-1\/q1/,
  );
  expect(missingOriginal).toEqual(retained);
});

// Reduced forms of the retained Pi Next lesson failure: interspersed strings,
// duplicate key rows and rows missing the private plan's task. Never repair them.
it.each(["string", "missing-task", "duplicate", "split-task"])(
  "rejects the saved Pi %s variant failure instead of normalizing it",
  (kind) => {
    const input: any = structuredClone(simpleLessonOutput);
    const variant = {
      quiz: "check-1",
      question: "q1",
      id: "v1",
      html: '<li class="cl-q" data-question-id="v1" data-type="short"><p class="cl-q-prompt">Who owns the value?</p><textarea></textarea></li>',
      rubric: structuredClone(input.quizzes[0].questions[0].rubric),
      task: "application",
    };
    input.variants = [variant];
    if (kind === "string") input.variants.push("task2 ");
    if (kind === "missing-task") delete input.variants[0].task;
    if (kind === "duplicate") input.variants.push(structuredClone(variant));
    if (kind === "split-task") {
      delete input.variants[0].task;
      input.variants.push({ id: "v1", task: "application" });
    }
    expect(() => lessonModelPlan(input)).toThrow(/Variant/);
    // Uniqueness is enforced by the decoder; the native SDK enforces row shape.
    if (kind !== "duplicate")
      expect(() =>
        validateToolCall(
          [
            {
              name: "submit_teacher_plan",
              description: "",
              parameters: LESSON_OUTPUT_SCHEMA as any,
            },
          ],
          { type: "toolCall", id: "rejected-plan", name: "submit_teacher_plan", arguments: input },
        ),
      ).toThrow(/variants/);
  },
);

it("keeps reused variant ids scoped to their source question in both private files", () => {
  const input: any = structuredClone(simpleLessonOutput);
  input.quizzes[0].questions.push({ ...structuredClone(input.quizzes[0].questions[0]), id: "q2" });
  input.variants = ["q1", "q2"].flatMap((question) =>
    ["v1", "v2"].map((id) => ({
      quiz: "check-1",
      question,
      id,
      html: `${question}/${id}`,
      rubric: structuredClone(input.quizzes[0].questions[0].rubric),
      task: question === "q1" ? "retrieval" : "application",
    })),
  );
  const document = JSON.parse(lessonModelPlan(input).calls[0].arguments_json);
  const key = JSON.parse(document.rubric_json)["check-1"];
  const plan = JSON.parse(document.teaching_plan_json).quizzes["check-1"].questions;
  for (const question of ["q1", "q2"]) {
    expect(key[question].variants.map((v: any) => v.html)).toEqual([
      `${question}/v1`,
      `${question}/v2`,
    ]);
    expect(plan[question].variants).toEqual(
      Object.fromEntries(
        ["v1", "v2"].map((id) => [
          id,
          {
            objective: "original",
            support: "independent",
            task: question === "q1" ? "retrieval" : "application",
          },
        ]),
      ),
    );
  }
});

it("code serializes raw HTML, including private variant HTML, into a canonical valid document", () => {
  const f = makeFixture();
  try {
    seedClassroom(f);
    seedPreparedReviewSource(f.root);
    const document = nextLessonDocument(f.root);
    const input = lessonOutput(document);
    const plan = lessonModelPlan(input);
    const decoded = JSON.parse(plan.calls[0].arguments_json);
    expect(decoded.lesson_html).toBe(document.lesson_html);
    expect(JSON.parse(decoded.rubric_json)).toEqual(JSON.parse(document.rubric_json));
    expect(JSON.parse(decoded.teaching_plan_json)).toEqual(JSON.parse(document.teaching_plan_json));
    expect(() => validateLessonDocument(decoded)).not.toThrow();
    const prepared = [
      ...authoredVariants(
        decoded.rubric_json,
        decoded.teaching_plan_json,
        decoded.lesson_html,
        true,
      ).values(),
    ][0][0];
    const review = assembleReview(
      [{ key: "002-next/check-1/q1", objective: prepared.objective } as any],
      [prepared],
      true,
    );
    expect(JSON.parse(review.rubric_json).review.r1.criteria).toEqual(prepared.rubric.criteria);
    expect(plan).toMatchObject({ message: "Ready", learning_record: "", notes_markdown: "" });
    const variant = input.variants[0];
    variant.html += '\n<!-- "quoted" \\slash\t -->';
    const privateKey = JSON.parse(
      JSON.parse(lessonModelPlan(input).calls[0].arguments_json).rubric_json,
    );
    expect(privateKey[variant.quiz][variant.question].variants[0].html).toBe(variant.html);
  } finally {
    f.cleanup();
  }
});
it("uses the dedicated supported schema only for explicit lesson requests", () => {
  expect(planSchema({ operations: ["publish_lesson"], research: true })).toEqual(
    LESSON_OUTPUT_SCHEMA,
  );
  expect(planSchema({ operations: ["answer_lesson_question"] })).toHaveProperty("properties.calls");
  expect(LESSON_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  expect(LESSON_OUTPUT_SCHEMA.required).toHaveLength(8);
  function inspect(schema: any, depth = 0): number {
    const next = depth + (schema.type === "object" || schema.type === "array" ? 1 : 0);
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(Object.keys(schema.properties));
    }
    return Math.max(
      next,
      ...Object.values(schema.properties ?? {}).map((v) => inspect(v, next)),
      ...(schema.items ? [inspect(schema.items, next)] : []),
      ...(schema.anyOf ?? []).map((v: any) => inspect(v, next)),
    );
  }
  // Arrays count too; flattened variants keep mapping keys inside the provider's ten-level limit.
  expect(inspect(LESSON_OUTPUT_SCHEMA)).toBeLessThanOrEqual(10);
});
it.each([
  ['quoted "answer"\n', 'quoted "answer"\n'],
  [
    ["a", "b"],
    ["a", "b"],
  ],
  [
    { value: 4, tolerance: 0.1, unit: "m" },
    { value: 4, tolerance: 0.1, unit: "m" },
  ],
  [{ value: 4 }, { value: 4 }],
  [
    {
      entries: [
        { key: "a", value: "b" },
        { key: "c", value: ["d", "e"] },
      ],
    },
    { a: "b", c: ["d", "e"] },
  ],
])(
  "converts typed expected answers without parsing or changing their content",
  (expected, canonical) => {
    const input = structuredClone(simpleLessonOutput);
    input.quizzes[0].questions[0].rubric.expected = expected as any;
    const document = JSON.parse(lessonModelPlan(input).calls[0].arguments_json);
    expect(JSON.parse(document.rubric_json)["check-1"].q1.expected).toEqual(canonical);
  },
);
it.each([
  null,
  { ...simpleLessonOutput, message: "" },
  { ...simpleLessonOutput, lesson_html: 5 },
  { ...simpleLessonOutput, calls: [] },
  { ...simpleLessonOutput, rubric_json: '{"bad":\n' },
  {
    ...simpleLessonOutput,
    objectives: [...simpleLessonOutput.objectives, ...simpleLessonOutput.objectives],
  },
  {
    ...simpleLessonOutput,
    variants: [
      { quiz: "missing", question: "q1", id: "v1", html: "x", rubric: {}, task: "application" },
    ],
  },
])("rejects malformed, duplicate, extra and legacy serialized inputs before saving", (input) => {
  expect(() => lessonModelPlan(input)).toThrow();
});
it("rejects duplicate mapping keys instead of silently overwriting them", () => {
  const input = structuredClone(simpleLessonOutput);
  input.quizzes[0].questions[0].rubric.expected = {
    entries: [
      { key: "a", value: "b" },
      { key: "a", value: "c" },
    ],
  } as any;
  expect(() => lessonModelPlan(input)).toThrow(/duplicate/);
});
it("preserves fixed criteria and refuses missing or inconsistent weights", () => {
  const input = structuredClone(simpleLessonOutput);
  input.quizzes[0].questions[0].rubric.criteria[0].points = 2;
  expect(() => lessonModelPlan(input)).toThrow(/sum/);
  input.quizzes[0].questions[0].rubric.criteria = [];
  expect(() => lessonModelPlan(input)).toThrow(/non-empty/);
});

it("refuses legacy expected tags instead of carrying lesson transport into canonical tools", () => {
  const input = structuredClone(simpleLessonOutput);
  input.quizzes[0].questions[0].rubric.expected = { kind: "text", value: "map" } as any;
  expect(() => lessonModelPlan(input)).toThrow(/extra fields/);
});

it("the complete dedicated response example satisfies the native schema and both private contracts", () => {
  const doc = fs.readFileSync(new URL("../docs/LESSON-OUTPUT.md", import.meta.url), "utf8");
  const example = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)![1]);
  validateToolCall(
    [{ name: "submit_teacher_plan", description: "", parameters: LESSON_OUTPUT_SCHEMA as any }],
    { type: "toolCall", id: "example", name: "submit_teacher_plan", arguments: example },
  );
  const document = JSON.parse(lessonModelPlan(example).calls[0].arguments_json);
  expect(() => validateLessonDocument(document)).not.toThrow();
  // A syntactically valid transport can still omit an original in gated HTML.
  example.quizzes = example.quizzes.filter((q: any) => q.purpose !== "assessment");
  const before = structuredClone(example);
  expect(() => lessonModelPlan(example)).toThrow(
    /omits original rubric and mapping for after\/compare/,
  );
  expect(example).toEqual(before);
});
