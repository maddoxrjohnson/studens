import { expect, it } from "vitest";
import { lessonModelPlan } from "../src/lesson-output.ts";
import { validateLessonDocument, piLessonDocument, nextLessonPrompt } from "../src/next-lesson.ts";
import { simpleLessonOutput } from "./lesson-output-fixture.ts";
import { codeForm, codeQuestion, codeRubric, source, exercise } from "./code-fixture.ts";
import { authoredVariants } from "../src/review-variants.ts";
import { assembleReview } from "../src/review-pool.ts";
import { parseCodeExercise } from "../assets/runtime/code.mjs";
import { authoredQuestionShapes } from "../src/quiz-authoring.ts";
import { makeFixture, seedClassroom } from "./helpers.ts";

const input = () => {
  const value = structuredClone(simpleLessonOutput);
  value.lesson_html = codeForm();
  value.quizzes[0].id = "check";
  value.quizzes[0].questions[0].id = "sum";
  value.quizzes[0].questions[0].rubric = { ...codeRubric, grading: null };
  return {
    ...value,
    variants: ["v1", "v2"].map((id) => ({
      quiz: "check",
      question: "sum",
      id,
      task: "application",
      html: codeQuestion(undefined, exercise, id),
      rubric: { ...codeRubric, grading: null },
    })),
  };
};
it("preserves code HTML, public tests, judgment criteria and private variants through the actual typed/Pi producer", () => {
  const typed = input();
  const document = JSON.parse(lessonModelPlan(typed).calls[0].arguments_json);
  expect(() => validateLessonDocument(document)).not.toThrow();
  const pi = piLessonDocument({
    title: document.title,
    summary: document.summary,
    lesson_html: document.lesson_html,
    rubric: JSON.parse(document.rubric_json),
    teaching_plan: JSON.parse(document.teaching_plan_json),
    syllabus_skills: null,
  });
  expect(pi).toEqual(document);
  expect(document.lesson_html).toBe(typed.lesson_html);
  expect(JSON.parse(document.rubric_json).check.sum.criteria).toEqual(codeRubric.criteria);
  expect(JSON.parse(document.rubric_json).check.sum.expected).toBe(codeRubric.expected);
  const pool = [
    ...authoredVariants(
      document.rubric_json,
      document.teaching_plan_json,
      document.lesson_html,
      true,
    ).values(),
  ][0];
  const review = assembleReview(
    [{ key: "002-code/check/sum", objective: pool[0].objective } as any],
    [pool[0]],
    true,
  );
  expect(parseCodeExercise(authoredQuestionShapes(review.lesson_html)[0].code)).toEqual(exercise);
  const bad = input();
  bad.variants[0].html = codeQuestion(source, { ...exercise, language: "python" }, "v1");
  expect(() =>
    validateLessonDocument(JSON.parse(lessonModelPlan(bad).calls[0].arguments_json)),
  ).toThrow(/javascript/);
  const exact = input();
  exact.quizzes[0].questions[0].rubric.grading = "exact" as any;
  expect(() =>
    validateLessonDocument(JSON.parse(lessonModelPlan(exact).calls[0].arguments_json)),
  ).toThrow(/judgment/);
  const malformed = input();
  malformed.lesson_html = codeForm(source, { ...exercise, tests: [] });
  expect(() =>
    validateLessonDocument(JSON.parse(lessonModelPlan(malformed).calls[0].arguments_json)),
  ).toThrow(/public tests/);
});
it("inlines the supported code contract for service authors without enabling ordinary teacher research", () => {
  const f = makeFixture();
  try {
    seedClassroom(f);
    const prompt = nextLessonPrompt(
      {
        id: "code",
        classroom: "rust",
        lesson: "002-code",
        topic: "Implement sum",
        at: 1,
        status: "queued",
      } as any,
      "service",
    );
    expect(prompt).toContain("CODE-EXERCISES.md:");
    expect(prompt).toContain("a string for short/choice/code");
    expect(prompt).toContain("learning_record");
    expect(prompt).toContain('"language":"javascript"');
  } finally {
    f.cleanup();
  }
});
