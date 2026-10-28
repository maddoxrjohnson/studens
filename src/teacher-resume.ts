/** Explicit handoff from the initiating chat to a graded lesson's teacher. */
import * as fs from "node:fs";
import * as path from "node:path";
import { classroomDir, isValidSlug, lessonDir } from "./paths.ts";
import { answerReviewKey, findReviewItem } from "./review.ts";
import { quizFollowUp } from "./prompts.ts";
import * as server from "./server.ts";
import * as store from "./store.ts";
import { kindOf } from "./quiz.ts";
import type { ClassroomTool } from "./tools.ts";

export interface ResumeInput {
  classroom: string;
  lesson: string;
  submission_id: string;
}
export interface ResumeRequest {
  id: string;
  classroom: string;
  lesson: string;
  prompt: string;
  unresolvedKeys: string[];
}

/** Validate the exact assessment before considering any panel state. */
export function prepareResume(input: ResumeInput): ResumeRequest {
  const { classroom, lesson, submission_id } = input;
  if (!isValidSlug(classroom) || !isValidSlug(lesson) || !store.readLesson(classroom, lesson))
    throw new Error("Select an existing classroom and lesson.");
  const submission = store.findSubmission(submission_id);
  if (!submission || submission.classroom !== classroom || submission.lesson !== lesson)
    throw new Error("The submission does not belong to this classroom and lesson.");
  if (!["check", "review"].includes(kindOf(submission)))
    throw new Error("Only a graded check or review can resume corrective retrieval.");
  const latest = store
    .latestQuizStates(classroom, lesson)
    .find((s) => s.quizId === submission.quizId);
  if (latest?.submission.id !== submission.id || !latest.grade)
    throw new Error("Select the latest graded submission for this quiz.");
  if (!latest.grade.questions.some((q) => !q.correct))
    throw new Error("This submission has no missed questions to resume.");
  const items = store.lessonReviewItems(classroom, lesson);
  const unresolvedKeys = [
    ...new Set(
      latest.grade.questions
        .filter((q) => !q.correct)
        .map((q) => {
          const answer = submission.answers.find((a) => a.questionId === q.questionId);
          if (!answer) throw new Error("A missed question has no saved answer.");
          const key = answerReviewKey(lesson, submission.quizId, answer);
          return findReviewItem(items, key)?.key ?? key;
        })
        .filter(
          (key) =>
            !items.some(
              (item) =>
                item.key === key &&
                item.lastSource === "chat" &&
                item.lastCorrect &&
                item.lastAt > latest.grade!.gradedAt,
            ),
        ),
    ),
  ];
  return {
    id: `resume:${submission.id}`,
    classroom,
    lesson,
    unresolvedKeys,
    prompt: [
      "This is the queued teacher-panel resume request. The learner is continuing a graded check or has just missed a review card. You are now the teacher for this panel turn. Do not hand off again or return only a link. Ask the corrective question here.",
      `Classroom: ${classroom}. Lesson: ${lesson}. Submission: ${submission.id}.`,
      `Lesson file: ${path.join(lessonDir(classroom, lesson), "lesson.html")}`,
      `Classroom directory: ${classroomDir(classroom)}`,
      "Read this lesson and its private rubric. Read available classroom documents from the list below. Do not read a missing NOTES.md. Use the saved learning records and retrieval checks below as the evidence. Historical notes that say chat mean the teacher panel for this request.",
      `Available classroom documents: ${JSON.stringify(store.listClassroomDocs(classroom))}`,
      `Learning records: ${JSON.stringify(store.readLearningRecords(classroom))}`,
      unresolvedKeys.length
        ? `These review keys remain unresolved after the saved grade: ${JSON.stringify(unresolvedKeys)}. Ask one fresh corrective question about a missed idea. Earlier checks, checks for other keys, and free-form learning records do not resolve these gaps.`
        : "Saved retrieval checks after this grade resolve each missed item. Explain that and ask whether the learner is ready to continue.",
      "This is a handoff, not a learner answer. Do not grade again, write a learning record, record a retrieval check, change notes, or start a new lesson. Preserve all assessments and evidence.",
      "Write your final message to the learner in the teacher panel. Keep learner replies there.",
      quizFollowUp(),
      `Saved submission: ${JSON.stringify(submission)}`,
      `Saved grade: ${JSON.stringify(latest.grade)}`,
      `Review items: ${JSON.stringify(items)}`,
      `Retrieval checks: ${JSON.stringify(store.listRetrievalChecks(classroom))}`,
    ].join("\n\n"),
  };
}

export function resumeTeacherTool(resume: (input: ResumeInput) => void): ClassroomTool {
  return {
    name: "resume_lesson_teacher",
    label: "Resume Lesson Teacher",
    description:
      "Resume corrective retrieval for an existing graded check or review in its inline teacher panel. Supply the exact classroom, lesson, and latest submission ID. Existing conversations and requests are reused. Call this when the learner asks in chat to continue an unfinished check. Do not ask the corrective question in chat.",
    parameters: {
      type: "object",
      properties: {
        classroom: { type: "string", description: "Exact classroom directory name." },
        lesson: { type: "string", description: "Exact lesson directory name." },
        submission_id: {
          type: "string",
          description: "Latest graded check or review submission ID.",
        },
      },
      required: ["classroom", "lesson", "submission_id"],
      additionalProperties: false,
    },
    async execute(input: ResumeInput) {
      const request = prepareResume(input);
      const url = server.urlFor(input.classroom, input.lesson);
      if (!url) throw new Error("Start the classroom server before resuming its teacher.");
      resume(input);
      return {
        content: [
          {
            type: "text",
            text: `[Continue in the lesson teacher panel](${url}#cl-teacher)\nRead the existing question or request there. Use Retry request for a failed request. Keep the corrective question and learner reply on this page.`,
          },
        ],
        details: {
          url: `${url}#cl-teacher`,
          requestId: request.id,
          unresolvedKeys: request.unresolvedKeys,
        },
      };
    },
  };
}

/** Pi resume requests survive session loss. This private file is never a static asset. */
export interface PiResume extends ResumeRequest {
  kind: "resume" | "chat";
  status: "running" | "failed" | "done";
  ownerPid: number;
  ownerSession: string;
  error?: string;
}
function file(classroom: string): string {
  if (!isValidSlug(classroom)) throw new Error("Invalid classroom.");
  return path.join(classroomDir(classroom), ".pi-teacher-resumes.json");
}
export function piResumes(classroom: string): PiResume[] {
  try {
    const value = JSON.parse(fs.readFileSync(file(classroom), "utf8"));
    if (
      !Array.isArray(value) ||
      value.some(
        (r) =>
          !r ||
          r.classroom !== classroom ||
          !isValidSlug(r.lesson) ||
          typeof r.id !== "string" ||
          !["resume", "chat"].includes(r.kind) ||
          !r.id.startsWith(`${r.kind}:`) ||
          typeof r.prompt !== "string" ||
          !["running", "failed", "done"].includes(r.status) ||
          !Number.isInteger(r.ownerPid) ||
          r.ownerPid < 1 ||
          typeof r.ownerSession !== "string",
      )
    )
      throw new Error("Invalid Pi teacher resume state.");
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
export function savePiResume(request: PiResume): void {
  const list = piResumes(request.classroom).filter((r) => r.id !== request.id);
  list.push(request);
  const target = file(request.classroom);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
}
export function piOwnerAlive(request: PiResume): boolean {
  try {
    process.kill(request.ownerPid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}
