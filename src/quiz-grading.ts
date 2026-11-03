/** Persist grades through one shared path for every host. */
import { validateCriterionGrade } from "./criteria.ts";
import { gradeScore, validateGrade } from "../assets/runtime/grade.mjs";
import { reteachOffers } from "./reteach.ts";
import { renderMarkdown } from "./markdown.ts";
import * as server from "./server.ts";
import * as store from "./store.ts";
import { refreshProgressInBackground } from "./syllabus.ts";

/** Finish a saved closed submission without a model turn or a second grade revision. */
export function completeClosedSubmission(submission: store.QuizSubmission): boolean {
  const questions = submission.deterministicGrades;
  if (!questions?.length || questions.length !== submission.answers.length) return false;
  const graded = !store
    .latestGrades(submission.classroom, submission.lesson)
    .some((g) => g.submissionId === submission.id);
  if (graded)
    applyGrade(submission, {
      score: gradeScore(questions),
      feedbackMarkdown: "Graded against the private answer key.",
      questions,
    });
  if (questions.some((question) => !question.correct)) server.reviewMiss(submission);
  // Only after a new grade, and last: a refresh failure is logged, never the learner's error.
  if (graded) refreshProgressInBackground(submission.classroom);
  return true;
}

/** Persist a grade and push it to any browser watching the lesson. */
export function applyGrade(
  submission: store.QuizSubmission,
  input: {
    score: number;
    feedbackMarkdown: string;
    questions: store.QuizQuestionGrade[];
    disputeId?: string;
    revisesGradedAt?: number;
  },
): store.QuizGrade {
  for (const question of input.questions) validateCriterionGrade(submission, question);
  const score = validateGrade(input.score, input.questions, [
    ...new Set(submission.answers.map((a) => a.questionId)),
  ]);
  // A revision must keep its own file even when two grades finish in one millisecond.
  const previous = store.listGrades(submission.classroom, submission.lesson);
  const gradedAt = Math.max(Date.now(), (previous.at(-1)?.gradedAt ?? 0) + 1);
  const grade: store.QuizGrade = {
    ...(input.disputeId
      ? { disputeId: input.disputeId, revisesGradedAt: input.revisesGradedAt }
      : {}),
    submissionId: submission.id,
    classroom: submission.classroom,
    lesson: submission.lesson,
    quizId: submission.quizId,
    score,
    feedbackMarkdown: input.feedbackMarkdown,
    feedbackHtml: renderMarkdown(input.feedbackMarkdown),
    questions: input.questions.map((q) => ({
      criteria: q.criteria?.map((c) => ({ ...c, feedbackHtml: renderMarkdown(c.feedback) })),
      questionId: q.questionId,
      correct: q.correct,
      pointsEarned: q.pointsEarned,
      pointsPossible: q.pointsPossible,
      feedback: q.feedback,
      feedbackHtml: renderMarkdown(q.feedback),
    })),
    gradedAt,
  };

  store.writeGrade(grade);
  server.pushEvent(submission.classroom, submission.lesson, "grade", {
    reteach: reteachOffers(submission.classroom, submission.lesson),
    submission: store.publicSubmission(submission),
    grade,
    history: store
      .listGrades(submission.classroom, submission.lesson)
      .filter((g) => g.submissionId === submission.id),
  });
  if (!input.disputeId) server.gradeSaved(submission);
  return grade;
}
