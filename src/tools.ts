/**
 * tools.ts — the tools the teacher uses to reach the learner's browser.
 *
 * `answer_lesson_question` and `grade_lesson_quiz` are the only way an answer or a
 * grade appears on the page; the scaffold tools exist so the canonical directory
 * layout is created correctly without the model having to remember it.
 *
 * The definitions are host-agnostic: Pi registers them as extension tools, and the MCP
 * server (`src/mcp.ts`) lists them for Claude Code and Codex. Parameters are plain JSON
 * Schema, which Pi's validator compiles as-is.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { readConfig } from "./config.ts";
import { allocateCriteria, type CriterionAllocation } from "./criteria.ts";
import { ASSISTANCE, type Assistance } from "./evidence.ts";
import { applyAnswer, applyGrade } from "./bridge.ts";
import { mergeGrades } from "./closed-grading.ts";
import { gradeScore, validateGrade } from "../assets/runtime/grade.mjs";
import { avoidedUses, htmlText } from "./glossary.ts";
import { healthReport, type LessonHealthInput } from "./health.ts";
import { classroomDir, isValidSlug, lessonDir, slugify, templatesDir } from "./paths.ts";
import {
  authoringSteps,
  missionStub,
  notesStub,
  PRETEST_FOLLOW_UP,
  quizFollowUp,
} from "./prompts.ts";
import { authoredQuestions } from "./quiz-authoring.ts";
import { parseTeachingPlan } from "./teaching-plan.ts";
import { parseRubric } from "./rubric.ts";
import { authoredVariants } from "./review-variants.ts";
import { startReview, completePreparedReview } from "./review-session.ts";
import type { ReviewOwner } from "./review-session.ts";
import { answersByQuestion, kindOf } from "./quiz.ts";
import {
  answerReviewKey,
  findReviewItem,
  defaultReviewSize,
  MAX_REVIEW_SIZE,
  relativeDay,
} from "./review.ts";
import * as server from "./server.ts";
import * as store from "./store.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface ClassroomTool {
  name: string;
  label: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  execute(params: any, context?: ToolContext): Promise<ToolResult>;
}

/** Host-owned context is never part of a model's tool arguments. */
export interface ToolContext {
  retrieval?: { classroom: string; lesson: string; reply: store.PanelMessage };
}

/** What differs between the hosts that run these tools. */
export interface ToolHost {
  reviewOwner?: ReviewOwner;
  /** Tells the model how to show a classroom when the server is not running. */
  browseHint: string;
  /** Tells the model how to check a lesson and present its URL. */
  checkPage: string;
}

export const PI_HOST: ToolHost = {
  browseHint: "Run /classroom to get its link.",
  checkPage:
    "Call lesson_health for this lesson. It reports unfinished question types and a missing rubric. Check the lesson URL in a headless browser. Look for contract errors and press each local control. Give the learner the lesson URL. Do not open a visible browser window. If the classroom server is not running, ask the learner to run /classroom. If headless checks cannot run, report the specific error and state that the controls were not checked. Do not switch to a visible browser.",
};

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    details: { error: true, ...details },
  };
}

/** Whether a tool result reports a failure. */
export function isFailure(result: ToolResult): boolean {
  return result.details["error"] === true;
}

export function registerClassroomTools(
  pi: any,
  extra: ClassroomTool[] = [],
  beforeWrite?: (name: string) => ToolContext | void,
): void {
  for (const tool of [...classroomTools(PI_HOST), ...extra]) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: (_toolCallId: string, params: unknown) => {
        let context: ToolContext | void = undefined;
        if (tool.name !== "lesson_health" && tool.name !== "resume_lesson_teacher")
          context = beforeWrite?.(tool.name);
        return tool.execute(params, context || undefined);
      },
    });
  }
}

/** JSON Schema helpers, kept tiny so the definitions below stay readable. */
function str(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function object(
  properties: Record<string, Record<string, unknown>>,
  optional: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
  };
}

export function classroomTools(host: ToolHost): ClassroomTool[] {
  return [
    // ── answer_lesson_question ──────────────────────────────────────────────────

    {
      name: "answer_lesson_question",
      label: "Answer Lesson Question",
      description:
        "Answer a question a learner asked by highlighting text in a classroom lesson. " +
        "The answer appears in a card pinned to the passage they highlighted — this tool is the only thing that puts it on their screen. " +
        "A card is a thread: the answer attaches to whichever turn is still waiting, so the same annotation_id answers the original question and every follow-up asked in that card. " +
        "Only call it with an annotation_id you were given in a classroom question notification.",
      parameters: object({
        annotation_id: str("The annotation id from the question or follow-up notification."),
        answer_markdown: str(
          "The answer, as markdown. Renders in a narrow card, so favour a few short paragraphs over headings and long lists. Write math in TeX: $...$ inline, $$...$$ on its own lines.",
        ),
      }),
      async execute(params: { annotation_id: string; answer_markdown: string }) {
        const annotation = store.findAnnotation(params.annotation_id);
        if (!annotation) {
          return fail(`No such question: ${params.annotation_id}`, {
            annotationId: params.annotation_id,
          });
        }
        const answer = params.answer_markdown.trim();
        if (!answer) return fail("answer_markdown is empty.");

        // Resolved before the write, so the message can name the turn that was answered.
        const turn = store.answerTarget(annotation);
        const asked =
          turn === null
            ? annotation.question
            : ((annotation.followUps ?? []).find((f) => f.id === turn)?.question ??
              annotation.question);

        const updated = applyAnswer(params.annotation_id, answer);
        if (!updated) return fail(`Could not save the answer for ${params.annotation_id}.`);

        return ok(
          `Answered ${turn === null ? "" : "the follow-up "}"${truncate(asked, 80)}" in ${annotation.classroom}/${annotation.lesson}. It is on the learner's page now.`,
          {
            annotationId: updated.id,
            classroom: updated.classroom,
            lesson: updated.lesson,
            followUpId: turn,
          },
        );
      },
    },

    {
      name: "record_retrieval_check",
      label: "Record Retrieval Check",
      description:
        "Record demonstrated understanding after a successful retrieval check in the teacher panel. Link the original review item to an active learning record. Preserve quiz grades and schedule later review. Do not use for material merely covered or an unverified answer.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          review_key: str(
            "Original <lesson>/<quiz id>/<question id> from the grade or review schedule.",
          ),
          learning_record: str("Existing active learning record file name, such as 0002-exec.md."),
          answer: str("The learner's actual panel reply to the new question."),
          evidence: str("The new question and why the answer demonstrates the missed idea."),
          assistance: {
            type: "string",
            enum: ASSISTANCE,
            description: readConfig().hideAnswerReports
              ? "Assistance, decided by the teacher from the panel conversation: none if the learner answered before any hint from you, hint if you nudged them, solution if you supplied the answer."
              : "Learner-reported assistance. Use unknown unless the learner states how they answered.",
          },
          task: {
            type: "string",
            enum: ["retrieval", "transfer"],
            description:
              "Use transfer only for an unfamiliar situation that applies the principle.",
          },
        },
        ["assistance", "task"],
      ),
      async execute(
        params: {
          classroom: string;
          review_key: string;
          learning_record: string;
          answer: string;
          evidence: string;
          assistance?: Assistance;
          task?: "retrieval" | "transfer";
        },
        context?: ToolContext,
      ) {
        if (!store.readClassroom(params.classroom))
          return fail(`No such classroom: ${params.classroom}`);
        try {
          const source = context?.retrieval;
          if (
            source &&
            (source.classroom !== params.classroom ||
              source.reply.text !== params.answer ||
              !findReviewItem(
                store.lessonReviewItems(params.classroom, source.lesson),
                params.review_key,
              ))
          )
            throw new Error("Retrieval timing must belong to this lesson's actual learner reply.");
          const check = store.recordRetrievalCheck(
            params.classroom,
            {
              key: params.review_key,
              learningRecord: params.learning_record,
              answer: params.answer,
              evidence: params.evidence,
              assistance: params.assistance,
              task: params.task,
            },
            source?.reply.at,
          );
          return ok(
            `Recorded retrieval evidence for ${check.key}. The quiz grade is preserved. Later review remains scheduled.`,
            { check },
          );
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    },

    // ── grade_lesson_quiz ───────────────────────────────────────────────────────

    {
      name: "grade_lesson_quiz",
      label: "Grade Lesson Quiz",
      description:
        "Grade a quiz a learner submitted from a classroom lesson. The grade is written to the lesson's quiz/grades directory and rendered inline on their page. " +
        "Only call it with a submission_id you were given in a quiz submission notification. " +
        "For a check or review, check a missed idea with a new question in the lesson's teacher panel. For a pretest, treat errors as diagnostic and continue to teaching without a retrieval check.",
      parameters: object({
        submission_id: str("The submission id from the notification."),
        score: {
          type: "number",
          description:
            "Overall score out of 100. Must equal 100 times total points earned divided by total points possible. Integer rounding is allowed.",
        },
        feedback_markdown: str(
          "Short markdown feedback on the quiz as a whole: what they have, and what to work on. Write math in TeX: $...$ inline, $$...$$ on its own lines.",
        ),
        questions: {
          type: "array",
          description: "One entry per question in the submission.",
          items: object(
            {
              question_id: str("The question id, exactly as given in the notification."),
              correct: {
                type: "boolean",
                description: "True only for full credit. Partial credit is false.",
              },
              points_earned: {
                type: "number",
                description:
                  "Points earned under the quiz rubric. Supply both point fields for every question when using points.",
              },
              points_possible: {
                type: "number",
                description: "Maximum points under the rubric. Must be greater than zero.",
              },
              criteria: {
                type: "array",
                description:
                  "For questions with saved criteria, allocate every criterion once. Omit or supply [] for historical questions without criteria. Never supply descriptions or weights.",
                items: object({
                  criterion_id: str("The fixed private criterion id."),
                  points_earned: {
                    type: "number",
                    description: "Earned points within this criterion's fixed weight.",
                  },
                  feedback: str(
                    "Explain which submitted reasoning met or missed this criterion. Reinforce correct reasoning with the actual step; accept equivalent methods.",
                  ),
                }),
              },
              feedback: str(
                "One or two sentences on this answer. For a wrong answer, name the idea they missed rather than only restating the right answer.",
              ),
            },
            ["points_earned", "points_possible", "criteria"],
          ),
        },
      }),
      async execute(params: {
        submission_id: string;
        score: number;
        feedback_markdown: string;
        questions: Array<{
          question_id: string;
          criteria?: CriterionAllocation[];
          correct: boolean;
          feedback: string;
          points_earned?: number;
          points_possible?: number;
        }>;
      }) {
        const submission = store.findSubmission(params.submission_id);
        if (submission?.rubricDigest) {
          const rubric = path.join(
            lessonDir(submission.classroom, submission.lesson),
            "quiz",
            "key.json",
          );
          if (
            !fs.existsSync(rubric) ||
            createHash("sha256").update(fs.readFileSync(rubric)).digest("hex") !==
              submission.rubricDigest
          )
            return fail(
              "The private rubric changed after submission. Restore the original rubric before grading.",
            );
        }
        if (!submission) {
          return fail(`No such submission: ${params.submission_id}`, {
            submissionId: params.submission_id,
          });
        }

        if (submission.deterministicGrades?.length) {
          try {
            const teacherQuestions = params.questions.map((q) => ({
              questionId: q.question_id,
              correct: q.correct,
              feedback: q.feedback,
              criteria: allocateCriteria(submission, q.question_id, q.criteria),
              pointsEarned: q.points_earned,
              pointsPossible: q.points_possible,
            }));
            const fixed = submission.deterministicGrades;
            const merged = mergeGrades(fixed, teacherQuestions);
            validateGrade(
              params.score,
              teacherQuestions,
              submission.answers
                .filter((a) => !fixed.some((q) => q.questionId === a.questionId))
                .map((a) => a.questionId),
            );
            params = {
              ...params,
              score: gradeScore(merged),
              questions: merged.map((q) => ({
                question_id: q.questionId,
                correct: q.correct,
                feedback: q.feedback,
                points_earned: q.pointsEarned,
                points_possible: q.pointsPossible,
                criteria: q.criteria?.map((c) => ({
                  criterion_id: c.criterionId,
                  points_earned: c.pointsEarned,
                  feedback: c.feedback,
                })),
              })),
            };
          } catch (error) {
            return fail((error as Error).message);
          }
        }

        const lesson = store.readLesson(submission.classroom, submission.lesson);
        if (submission.assessmentContract === 1) {
          try {
            if (!lesson) throw new Error("The submitted lesson no longer exists.");
            const rubric = parseRubric(
              fs.readFileSync(
                path.join(lessonDir(submission.classroom, submission.lesson), "quiz", "key.json"),
                "utf8",
              ),
              fs.readFileSync(lesson.htmlPath, "utf8"),
              submission.deterministicGrades === undefined ? "legacy" : "machine",
            );
            for (const question of params.questions) {
              const expected = rubric[submission.quizId]?.[question.question_id];
              if (!expected) throw new Error("The question is missing from the private rubric.");
              if (question.points_possible !== expected.points)
                throw new Error(
                  `Use the rubric points for ${question.question_id}: ${expected.points}. Supply points for every question.`,
                );
            }
          } catch (err) {
            return fail(`Invalid assessment rubric: ${(err as Error).message}`);
          }
        }

        const submitted = new Set(submission.answers.map((a) => a.questionId));
        const graded = new Set(params.questions.map((q) => q.question_id));
        const missing = [...submitted].filter((id) => !graded.has(id));
        if (missing.length > 0) {
          return fail(
            `Missing feedback for: ${missing.join(", ")}. Grade every question in the submission.`,
            { missing },
          );
        }
        const unknown = [...graded].filter((id) => !submitted.has(id));
        if (unknown.length > 0) {
          return fail(
            `No such question in the submission: ${unknown.join(", ")}. Use the question ids from the notification.`,
            { unknown },
          );
        }

        let grade: store.QuizGrade;
        try {
          const withPoints = params.questions.some(
            (q) => q.points_earned !== undefined || q.points_possible !== undefined,
          );
          if (
            withPoints &&
            params.questions.some(
              (q) => q.points_earned === undefined || q.points_possible === undefined,
            )
          ) {
            throw new Error(
              "Supply points_earned and points_possible for every question when using points.",
            );
          }
          grade = applyGrade(submission, {
            score: params.score,
            feedbackMarkdown: params.feedback_markdown,
            questions: params.questions.map((q) => ({
              questionId: q.question_id,
              criteria: allocateCriteria(submission, q.question_id, q.criteria),
              correct: q.correct,
              pointsEarned: q.points_earned,
              pointsPossible: q.points_possible,
              feedback: q.feedback,
            })),
          });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const storageError = [
            "EACCES",
            "EPERM",
            "ENOSPC",
            "EROFS",
            "EIO",
            "ENOENT",
            "ENOTDIR",
            "EISDIR",
            "EMFILE",
            "ENFILE",
          ].includes(code ?? "");
          return fail((err as Error).message, { storageError });
        }
        const kind = kindOf(submission);
        const reviewKeys = [
          ...new Set(
            kind === "pretest"
              ? []
              : answersByQuestion(submission.answers).map(([, group]) =>
                  answerReviewKey(submission.lesson, submission.quizId, group[0]),
                ),
          ),
        ];
        const incorrectQuestionIds = grade.questions
          .filter((question) => !question.correct)
          .map((question) => question.questionId);

        const notes: string[] = reviewKeys.length
          ? [
              `Review item keys for later retrieval evidence: ${reviewKeys.join(", ")}. After a successful panel check, write a learning record and call record_retrieval_check for the resolved item.`,
            ]
          : [];
        if (kind === "pretest") {
          notes.push(PRETEST_FOLLOW_UP);
        } else {
          notes.push(
            incorrectQuestionIds.length > 0
              ? `Missed questions: ${incorrectQuestionIds.join(", ")}.\n\n${quizFollowUp()}`
              : "Every answer is correct. Ask in the teacher panel whether the learner is ready to continue before starting the next lesson.",
          );
          notes.push(reviewScheduleLine(submission));
        }

        return ok(
          `Graded ${submission.quizTitle} in ${submission.classroom}/${submission.lesson}: ${Math.round(grade.score)}%. The learner can see it now.\n\n${notes.join("\n\n")}`,
          {
            submissionId: submission.id,
            score: grade.score,
            kind,
            incorrectQuestionIds,
          },
        );
      },
    },

    // ── scaffold_classroom ──────────────────────────────────────────────────────

    {
      name: "scaffold_classroom",
      label: "Scaffold Classroom",
      description:
        "Create a classroom in the canonical location (~/.pi/agent/classrooms/<name>/) with MISSION.md and NOTES.md stubs. " +
        "Call this once at the start of teaching a new topic, before writing any lesson.",
      parameters: object(
        {
          name: str("Topic or classroom name; it is slugified into a directory name."),
          title: str("Display title. Defaults to the name."),
          emoji: str("One emoji shown on the classroom card."),
        },
        ["title", "emoji"],
      ),
      async execute(params: { name: string; title?: string; emoji?: string }) {
        const slug = slugify(params.name);
        const dir = classroomDir(slug);
        const existed = fs.existsSync(dir);

        fs.mkdirSync(dir, { recursive: true });
        const title = params.title?.trim() || store.titleFromSlug(slug);

        if (!existed) {
          store.writeClassroomMeta(slug, {
            title,
            emoji: params.emoji?.trim() || "📚",
            createdAt: Date.now(),
          });
        }

        const missionPath = path.join(dir, "MISSION.md");
        if (!fs.existsSync(missionPath)) fs.writeFileSync(missionPath, missionStub(title), "utf8");
        const notesPath = path.join(dir, "NOTES.md");
        if (!fs.existsSync(notesPath)) fs.writeFileSync(notesPath, notesStub(), "utf8");

        return ok(
          [
            `${existed ? "Classroom already existed" : "Created classroom"}: ${slug}`,
            `Directory: ${dir}`,
            `Mission: ${missionPath}${existed ? "" : " (a stub — interview the learner and fill in Why before writing lessons)"}`,
            server.urlFor(slug) ? `URL: ${server.urlFor(slug)}` : host.browseHint,
          ].join("\n"),
          { classroom: slug, dir, existed },
        );
      },
    },

    // ── scaffold_lesson ─────────────────────────────────────────────────────────

    {
      name: "scaffold_lesson",
      label: "Scaffold Lesson",
      description:
        "Create a numbered page and return its path. Use mode lesson for teaching with a pretest, quiz for a quiz-only request, or pretest for a standalone diagnostic. " +
        "The template is a shell with optional example sections, not a fixed lesson script. " +
        "The result lists the authoring steps: read the current quiz contract, state the objective, choose the lesson experience and response types, write the questions, write the private rubric, and check the page. " +
        "Lessons are numbered in the order they are created.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          name: str("Short lesson name; slugified and given a numeric prefix."),
          title: str("Lesson title, shown in the classroom's lesson list."),
          summary: str("One line describing the single win of this lesson."),
          mode: {
            type: "string",
            enum: ["lesson", "quiz", "pretest"],
            description:
              "Default lesson. Use quiz for a quiz or test request. Use pretest for diagnosis only.",
          },
        },
        ["summary", "mode"],
      ),
      async execute(params: {
        classroom: string;
        name: string;
        title: string;
        summary?: string;
        mode?: "lesson" | "quiz" | "pretest";
      }) {
        const mode = params.mode ?? "lesson";
        if (!["lesson", "quiz", "pretest"].includes(mode))
          return fail(`Unknown page mode: ${mode}.`);
        if (!isValidSlug(params.classroom) || !fs.existsSync(classroomDir(params.classroom))) {
          return fail(`No such classroom: ${params.classroom}. Call scaffold_classroom first.`);
        }

        const next = nextLessonNumber(params.classroom);
        const slug = `${String(next).padStart(3, "0")}-${slugify(params.name)}`;
        const dir = lessonDir(params.classroom, slug);
        if (fs.existsSync(dir)) return fail(`Lesson directory already exists: ${dir}`);

        fs.mkdirSync(dir, { recursive: true });

        const template = fs.readFileSync(
          path.join(templatesDir(), mode === "lesson" ? "lesson.html" : "assessment.html"),
          "utf8",
        );
        const htmlPath = path.join(dir, "lesson.html");
        fs.writeFileSync(
          htmlPath,
          template
            .replace(/\{\{LESSON_TITLE\}\}/g, params.title)
            .replace(/\{\{ONE_LINE_SUMMARY\}\}/g, params.summary ?? "")
            .replace(/\{\{QUIZ_KIND\}\}/g, mode === "pretest" ? "pretest" : "check"),
          "utf8",
        );

        store.writeLessonMeta(params.classroom, slug, {
          title: params.title,
          summary: params.summary ?? "",
          createdAt: Date.now(),
          assessmentContract: 1,
          criterionContract: 1,
          instructionalContract: 1,
          ...(mode !== "pretest" ? { reviewVariantContract: 1 as const } : {}),
        });

        const url = server.urlFor(params.classroom, slug);
        return ok(
          [
            `Created lesson ${slug} in ${params.classroom}.`,
            `Edit: ${htmlPath}`,
            url ? `URL: ${url}` : host.browseHint,
            "",
            authoringSteps(mode, {
              mode: "filesystem",
              lessonPath: htmlPath,
              checkPage: host.checkPage,
            }),
          ].join("\n"),
          { classroom: params.classroom, lesson: slug, path: htmlPath, url },
        );
      },
    },

    // ── scaffold_review ─────────────────────────────────────────────────────────

    {
      name: "scaffold_review",
      label: "Scaffold Review",
      description:
        "Open a ready spaced review assembled from private variants of due questions, without a model authoring turn. " +
        "Reuse an unfinished review. Keep its questions and keys unchanged. Lessons without prepared pools are skipped. " +
        "Fails specifically when no prepared questions are due.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          limit: {
            type: "number",
            description: `How many due questions to include. Default ${defaultReviewSize()}, maximum ${MAX_REVIEW_SIZE}.`,
          },
        },
        ["limit"],
      ),
      async execute(params: { classroom: string; limit?: number }) {
        if (!isValidSlug(params.classroom) || !fs.existsSync(classroomDir(params.classroom))) {
          return fail(`No such classroom: ${params.classroom}.`);
        }
        const limit = params.limit ?? defaultReviewSize();
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEW_SIZE) {
          return fail(`limit must be a whole number from 1 to ${MAX_REVIEW_SIZE}.`);
        }

        try {
          const { session } = startReview(
            params.classroom,
            randomUUID(),
            host.reviewOwner ?? "pi",
            limit,
          );
          if (session.status === "failed")
            return fail(`Review failed: ${session.error}. Use Retry review on the classroom page.`);
          if (!session.document && session.status !== "done")
            return fail(
              "An existing review is still being authored. Continue it from the classroom page.",
            );
          completePreparedReview(session);
          server.reviewSaved(params.classroom);
          const htmlPath = path.join(lessonDir(params.classroom, session.lesson), "lesson.html");
          const url = server.urlFor(params.classroom, session.lesson);
          return ok(
            [
              `Prepared review ${session.lesson} in ${params.classroom}.`,
              url ? `URL: ${url}` : host.browseHint,
              "The review is ready. Keep its questions and private keys unchanged. Give the learner its link.",
            ].join("\n"),
            {
              classroom: params.classroom,
              lesson: session.lesson,
              path: htmlPath,
              url,
              items: session.items.map((item) => item.key),
            },
          );
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    },

    // ── lesson_health ───────────────────────────────────────────────────────────

    {
      name: "lesson_health",
      label: "Lesson Health",
      description:
        "Report where lessons did not land: long question threads, quiz questions missed more than once, glossary words to avoid, GLOSSARY.md errors, and the learner's self-explanations. " +
        "Call it before you plan the next lesson, and fix a lesson that keeps failing.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          lesson: str("Lesson directory name. Omit it for every lesson in the classroom."),
        },
        ["lesson"],
      ),
      async execute(params: { classroom: string; lesson?: string }) {
        const classroom = store.readClassroom(params.classroom);
        if (!classroom) return fail(`No such classroom: ${params.classroom}.`);

        const lessons = store.listLessons(params.classroom);
        const chosen = params.lesson ? lessons.filter((l) => l.name === params.lesson) : lessons;
        if (params.lesson && chosen.length === 0) {
          return fail(`No such lesson in ${params.classroom}: ${params.lesson}.`);
        }

        const glossary = store.readGlossary(params.classroom);
        // Review answers live in other lessons. Read them before selecting the report.
        const checks = store.listRetrievalChecks(params.classroom);
        const inputs: LessonHealthInput[] = lessons.map((lesson) => {
          const html = fs.readFileSync(lesson.htmlPath, "utf8");
          let rubricError: string | undefined;
          if (lesson.assessmentContract === 1) {
            const rubric = path.join(lessonDir(params.classroom, lesson.name), "quiz", "key.json");
            if (fs.existsSync(rubric)) {
              try {
                parseRubric(
                  fs.readFileSync(rubric, "utf8"),
                  html,
                  "machine",
                  lesson.criterionContract === 1,
                );
                if (lesson.reviewVariantContract === 1)
                  authoredVariants(
                    fs.readFileSync(rubric, "utf8"),
                    fs.readFileSync(
                      path.join(lessonDir(params.classroom, lesson.name), "quiz/plan.json"),
                      "utf8",
                    ),
                    html,
                    true,
                  );
              } catch (err) {
                rubricError = (err as Error).message;
              }
            }
          }
          let alignmentError: string | undefined;
          if (lesson.instructionalContract === 1) {
            try {
              parseTeachingPlan(
                fs.readFileSync(
                  path.join(lessonDir(params.classroom, lesson.name), "quiz", "plan.json"),
                  "utf8",
                ),
                html,
              );
            } catch (err) {
              alignmentError = (err as Error).message;
            }
          }
          return {
            alignmentError,
            lesson: lesson.name,
            title: lesson.title,
            questions: authoredQuestions(html),
            rubricError,
            hasRubric: fs.existsSync(
              path.join(lessonDir(params.classroom, lesson.name), "quiz", "key.json"),
            ),
            annotations: store.listAnnotations(params.classroom, lesson.name),
            submissions: store.listSubmissions(params.classroom, lesson.name),
            grades: store.latestGrades(params.classroom, lesson.name),
            reflections: store.listReflections(params.classroom, lesson.name),
            retrievalChecks: checks.filter((check) => check.key.split("/")[0] === lesson.name),
            avoided: avoidedUses(htmlText(html), glossary),
          };
        });

        return ok(healthReport(params.classroom, inputs, glossary.errors, params.lesson), {
          classroom: params.classroom,
          lessons: chosen.map((l) => l.name),
          glossaryErrors: glossary.errors,
        });
      },
    },
  ];
}

export { DEFAULT_REVIEW_SIZE, MAX_REVIEW_SIZE } from "./review.ts";

/** When each question in a graded submission comes up for review next. */
function reviewScheduleLine(submission: store.QuizSubmission): string {
  const now = Date.now();
  const items = store.reviewItems(submission.classroom);
  const parts = answersByQuestion(submission.answers).map(([questionId, group]) => {
    const key = answerReviewKey(submission.lesson, submission.quizId, group[0]);
    const item = findReviewItem(items, key);
    if (!item) throw new Error(`No review item for ${key} after grading it.`);
    return item.needsReteach
      ? `${questionId} paused: offer a short re-teach in the lesson teacher panel`
      : `${questionId} ${relativeDay(item.dueAt, now)}`;
  });
  return `Next review: ${parts.join(", ")}.`;
}

/** One past the highest numeric prefix already used in the classroom. */
function nextLessonNumber(classroom: string): number {
  const used = store
    .listLessonDirs(classroom)
    .map((name) => store.orderPrefix(name))
    .filter((n): n is number => n !== null);
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}
