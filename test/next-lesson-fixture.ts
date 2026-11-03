import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { lessonPublicationFiles } from "../src/next-lesson.ts";
import type { LessonRequest } from "../src/next-lesson.ts";
import type { LessonDocument } from "../src/next-lesson.ts";
import { lessonHtml } from "./helpers.ts";

/** Complete gated document using the prepared source's private review pools. */
export function nextLessonDocument(root: string): LessonDocument {
  const dir = path.join(root, "rust/001-ownership");
  const original = fs.readFileSync(path.join(dir, "lesson.html"), "utf8");
  const quiz = original
    .slice(original.indexOf("<form"), original.indexOf("</form>") + 7)
    .replace('class="cl-quiz"', 'class="cl-quiz cl-card-box"')
    .replaceAll('<input type="text">', '<input class="cl-input" type="text">')
    .replaceAll("<textarea>", '<textarea class="cl-input">')
    .replaceAll("<ol>", '<ol class="cl-questions">');
  const rubric = JSON.parse(fs.readFileSync(path.join(dir, "quiz/key.json"), "utf8"));
  rubric["pretest-1"] = {
    p1: {
      expected: "The new owner.",
      points: 1,
      full: "Name the owner.",
      partial: "Zero if incorrect.",
    },
  };
  for (const quiz of Object.values(rubric) as any[])
    for (const entry of Object.values(quiz) as any[]) {
      entry.criteria = [{ id: "reason", description: entry.full, points: entry.points }];
      for (const variant of entry.variants ?? [])
        variant.rubric.criteria = [
          { id: "reason", description: variant.rubric.full, points: variant.rubric.points },
        ];
    }
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "quiz/plan.json"), "utf8"));
  plan.quizzes["pretest-1"] = {
    purpose: "prequestion",
    questions: {
      p1: {
        objective: "owner",
        task: "prediction",
        support: "independent",
        teaching: "teaching-owner",
      },
    },
  };
  return {
    title: "Move and release",
    summary: "Track the owner after a move.",
    lesson_html: lessonHtml(
      "Move and release",
      `<form class="cl-quiz cl-card-box" data-quiz-id="pretest-1" data-kind="pretest"><ol class="cl-questions"><li class="cl-q" data-question-id="p1" data-type="short"><p class="cl-q-prompt">Predict who releases a value after it moves to a new owner.</p><textarea class="cl-input"></textarea></li></ol></form><template data-cl-after-pretest="pretest-1"><section id="teaching-owner"><h2>Track the owner</h2><p>A move transfers ownership. The new owner releases the value when its scope ends.</p><details class="cl-disclosure"><summary>Trace a move</summary><p>The first scope loses ownership when the value moves.</p></details></section>${quiz}</template>`,
    ).replace(
      "<main data-cl-content>",
      '<main class="cl-lesson-shell" data-cl-content data-cl-ui="2">',
    ),
    rubric_json: JSON.stringify(rubric),
    teaching_plan_json: JSON.stringify(plan),
    syllabus_skills: null,
  };
}

/** Controlled receipt at the private checker boundary; real browser checks create their own. */
export function nextLessonReceipt(request: LessonRequest, document: LessonDocument): string {
  return JSON.stringify({
    preflight: {
      version: 1,
      inputHashes: Object.fromEntries(
        Object.entries(lessonPublicationFiles(request, document)).map(([name, text]) => [
          name,
          createHash("sha256").update(text).digest("hex"),
        ]),
      ),
    },
  });
}
