import type { LessonDocument } from "../src/next-lesson.ts";

/** Typed transport fixture for existing complete private contracts. */
export function lessonOutput(document: LessonDocument) {
  const rubric = JSON.parse(document.rubric_json);
  const plan = JSON.parse(document.teaching_plan_json);
  const typedRubric = (raw: any) => {
    const e = raw.expected;
    return {
      expected:
        typeof e === "string" || Array.isArray(e) || typeof e.value === "number"
          ? e
          : { entries: Object.entries(e).map(([key, value]) => ({ key, value })) },
      criteria: raw.criteria,
      points: raw.points,
      full: raw.full,
      partial: raw.partial,
      grading: raw.grading ?? null,
    };
  };
  return {
    title: document.title,
    summary: document.summary,
    lesson_html: document.lesson_html,
    message: "Ready",
    objectives: Object.entries(plan.objectives).map(([id, raw]: [string, any]) => ({
      id,
      statement: raw.statement,
      application: raw.application,
      retentionDays: raw.retentionDays ?? null,
      interleaveGroup: raw.interleaveGroup ?? null,
      strategy: raw.strategy ?? null,
    })),
    quizzes: Object.entries(plan.quizzes).map(([id, raw]: [string, any]) => ({
      id,
      purpose: raw.purpose,
      questions: Object.entries(raw.questions).map(([question, q]: [string, any]) => ({
        id: question,
        rubric: typedRubric(rubric[id][question]),
        objective: q.objective,
        task: q.task,
        support: q.support,
        teaching: q.teaching ?? null,
      })),
    })),
    variants: Object.entries(rubric).flatMap(([quiz, raw]: [string, any]) =>
      Object.entries(raw).flatMap(([question, q]: [string, any]) =>
        (q.variants ?? []).map((v: any) => ({
          quiz,
          question,
          id: v.id,
          html: v.html,
          rubric: typedRubric(v.rubric),
          task: plan.quizzes[quiz].questions[question].variants[v.id].task,
        })),
      ),
    ),
    syllabus_skills: document.syllabus_skills ?? null,
  };
}

export const simpleLessonOutput = {
  title: "Lesson",
  summary: "Summary",
  lesson_html: '<main>"quoted"\n\\backslash\ttext</main>',
  message: "Ready",
  objectives: [
    {
      id: "owner",
      statement: "Track ownership.",
      application: true,
      retentionDays: null,
      interleaveGroup: null,
      strategy: null,
    },
  ],
  quizzes: [
    {
      id: "check-1",
      purpose: "assessment",
      questions: [
        {
          id: "q1",
          rubric: {
            expected: "The owner.",
            criteria: [{ id: "owner", description: "Identify the current owner.", points: 1 }],
            points: 1,
            full: "Identify the owner.",
            partial: "Zero for incorrect owner.",
            grading: null,
          },
          objective: "owner",
          task: "application",
          support: "independent",
          teaching: null,
        },
      ],
    },
  ],
  variants: [],
  syllabus_skills: null,
};
