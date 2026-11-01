import {
  saveOwnershipTransaction,
  finishOwnershipTransaction,
  recoverOwnershipTransaction,
  pendingOwnershipTransaction,
} from "./teacher-ownership.ts";
import type { OwnershipChange } from "./teacher-ownership.ts";
import { requestIdentity } from "./teacher.ts";
import type { TeacherIdentity } from "./teacher.ts";
import {
  RESOLVE_DISPUTE,
  snapshotDispute,
  validateDisputeTarget,
  resolveDispute,
  disputePrompt,
  publicDisputes,
} from "./grade-dispute.ts";
import type { DisputeTarget } from "./grade-dispute.ts";
import { validateAnswerCriteria } from "./criteria.ts";
import { dailyReviews, groupSession } from "./store/daily-review.ts";
import { modelSelection } from "./teacher-models.ts";
import { reteachOffers, reteachPrompt } from "./reteach.ts";
import {
  lessonRequests,
  requireLessonOwner,
  updateLessonRequest,
  saveLessonDocument,
  completeLessonRequest,
  nextLessonPrompt,
  prepareLessonRetry,
} from "./next-lesson.ts";
import type { LessonRequest } from "./next-lesson.ts";
/** Run one request at a time for each classroom. Persist plans before writes. */
import {
  discoverRefills,
  refillOwnerAlive,
  refreshRefill,
  refillRequests,
  updateRefill,
  saveRefillPlan,
  applyRefill,
  REFILL_TOOL,
} from "./review-refill.ts";
import type { RefillRequest } from "./review-refill.ts";
import { prepareResume, piResumes, piOwnerAlive, type ResumeInput } from "./teacher-resume.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { applyTurnAnswer, withHtml } from "./bridge.ts";
import { classroomDir, lessonDir, safeStaticFile, isStoredReview } from "./paths.ts";
import { stageLesson } from "./pretest.ts";
import { applyGrade, completeClosedSubmission } from "./quiz-grading.ts";
import { validateGrade } from "../assets/runtime/grade.mjs";
import { answerGradingTool, GRADE_ANSWERS, scoredAnswers } from "./teacher-grading.ts";
import {
  askPrompt,
  followUpPrompt,
  gradePrompt,
  reflectPrompt,
  dedicatedTeacherPrompt,
  reviewPrompt,
} from "./prompts.ts";
import * as store from "./store.ts";
import { findReviewItem, reviewTiming } from "./review.ts";
import * as server from "./server.ts";
import { classroomTools, isFailure, PI_HOST } from "./tools.ts";
import {
  readTeacherState,
  saveTeacherState,
  type TeacherRequest,
  type TeacherState,
} from "./service-state.ts";
import {
  runTeacher,
  type Backend,
  type RunTeacher,
  type PlanContract,
  planSchema,
  type TeacherPlan,
  parsePlan,
} from "./teacher.ts";

import {
  completePreparedReview,
  reviewSessions,
  requireReviewOwner,
  updateReview,
  publishReview,
  validateReview,
  type ReviewDocument,
  type ReviewSession,
} from "./review-session.ts";

export class TeacherService {
  private readonly states = new Map<string, TeacherState>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly run: RunTeacher;
  private stopping = false;
  private readonly switching = new Map<string, Backend>();
  private ownershipOrder: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  constructor(run: RunTeacher = runTeacher) {
    this.run = run;
  }

  attach(classroom: string, backend?: Backend): void {
    this.checkOwnership(classroom);
    let state = this.states.get(classroom) ?? readTeacherState(classroom);
    if (!state) {
      if (!backend)
        throw new Error(
          "Select teacher_backend pi, codex, or claude. The initiating host is unknown.",
        );
      state = { version: 1, identity: { backend }, requests: [], messages: [] };
    } else if (backend && backend !== state.identity.backend) {
      throw new Error(
        `Classroom ${classroom} belongs to ${state.identity.backend}. It cannot attach to ${backend}.`,
      );
    }
    if (!this.states.has(classroom)) {
      this.states.set(classroom, state);
      for (const r of state.requests)
        if (r.status === "running") {
          r.status = "failed";
          r.error = "Service stopped during teacher work. Retry this request.";
          if (r.kind === "lesson")
            updateLessonRequest(this.lessonRequest(r), { status: "failed", error: r.error });
          if (r.kind === "review") updateReview(this.reviewSession(r), "failed", r.error);
          if (r.kind === "refill") updateRefill(this.refillRequest(r), "failed", r.error);
        }
    }
    saveTeacherState(classroom, state);
    this.recover(classroom);
    this.wake(classroom);
  }
  private checkOwnership(classroom: string): void {
    if (!store.readClassroom(classroom)) throw new Error(`No such classroom: ${classroom}`);
    const legacyLesson = lessonRequests(classroom).find(
      (r) => r.owner === "pi" && r.delivery !== "service" && r.status !== "done",
    );
    if (legacyLesson)
      throw new Error(
        `Classroom ${classroom} has unfinished legacy Pi lesson request ${legacyLesson.id}. Reopen the previous Pi package, explicitly retry and finish that request, then stop its server before retrying open_classroom. Saved plans and history have not been changed.`,
      );
    if (piResumes(classroom).some((r) => r.status === "running" && piOwnerAlive(r)))
      throw new Error(
        "A live Pi session owns this classroom's resume request. Finish it and explicitly stop the previous Pi server, then retry open_classroom.",
      );
    if (
      refillRequests(classroom).some(
        (r) =>
          r.owner === "pi" &&
          ["queued", "running", "planned"].includes(r.status) &&
          refillOwnerAlive(r),
      )
    )
      throw new Error(
        "A live Pi session owns this classroom's background review work. Finish it and explicitly stop the previous Pi server, then retry open_classroom.",
      );
    const legacyReview = reviewSessions(classroom).find(
      (r) => r.owner === "pi" && r.status !== "done",
    );
    const legacyRefill = refillRequests(classroom).find(
      (r) => r.owner === "pi" && r.status !== "done",
    );
    const legacyResume = piResumes(classroom).find((r) => r.status !== "done");
    const legacyDaily = dailyReviews()
      .flatMap((request) => request.groups)
      .find((group) => {
        if (group.classroom !== classroom || group.empty) return false;
        const session = groupSession(group) ?? group.plan;
        return session.owner === "pi" && session.status !== "done";
      });
    if (legacyReview || legacyRefill || legacyResume || legacyDaily)
      throw new Error(
        `Classroom ${classroom} has unfinished legacy Pi work ${legacyReview?.id ?? legacyRefill?.id ?? legacyResume?.id ?? legacyDaily?.plan.id}. Reopen the previous Pi package, explicitly retry and finish that request, then stop its server before retrying open_classroom. Saved plans and history have not been changed.`,
      );
  }
  restore(): void {
    recoverOwnershipTransaction();
    for (const c of store.listClassrooms()) if (readTeacherState(c.name)) this.attach(c.name);
  }
  /** Serialize opens, including list reservations, before releasing learner work. */
  open(classroom: string | null, backend: Backend): Promise<void> {
    const work = this.ownershipOrder.then(async () => {
      if (this.stopping) throw new Error("Teacher service is stopping.");
      if (pendingOwnershipTransaction())
        throw new Error("Teacher ownership recovery is required. Restart the service explicitly.");
      const names = classroom ? [classroom] : store.listClassrooms().map((c) => c.name);
      for (const name of names) this.switching.set(name, backend);
      const changes: OwnershipChange[] = [];
      try {
        for (const name of names) {
          // Attach checks legacy ownership and loads saved recovery without dispatching it.
          this.checkOwnership(name);
          if (readTeacherState(name)) this.attach(name);
          this.publishOwnership(name);
        }
        await Promise.all(names.map((name) => this.active.get(name)));
        if (this.stopping) throw new Error("Teacher service stopped before ownership preparation.");
        for (const name of names) {
          if (this.stopping)
            throw new Error("Teacher service stopped during ownership preparation.");
          const state = this.states.get(name);
          const prior = state ? { ...state.identity } : null;
          const candidate: TeacherIdentity =
            prior?.backend === backend
              ? { ...prior }
              : {
                  backend,
                  selectionRevision: (prior?.selectionRevision ?? 0) + 1,
                };
          changes.push({ classroom: name, prior, candidate });
          saveOwnershipTransaction({ version: 1, decision: "prepared", changes });
          const controller = new AbortController();
          this.controllers.add(controller);
          try {
            const plan = await this.run(
              candidate,
              "Readiness check only. Confirm that this dedicated teacher can run. Return an empty calls array, a brief readiness message, null learning_record and empty notes_markdown. Do not answer learner work, grade, research, publish or write evidence. Saved classroom evidence will be supplied with each later request.",
              classroomDir(name),
              (id) => {
                if (id) candidate.sessionId = id;
                else delete candidate.sessionId;
                saveOwnershipTransaction({ version: 1, decision: "prepared", changes });
              },
              controller.signal,
              { operations: [], messageRequired: true },
              undefined,
              (model) => {
                candidate.activeModel = model;
                candidate.activeModelAt = Date.now();
                candidate.activeRequestedModel = candidate.requestedModel ?? null;
              },
            );
            if (
              plan.calls.length ||
              plan.learning_record.trim() ||
              plan.notes_markdown.trim() ||
              !plan.message.trim()
            )
              throw new Error(
                "Readiness must return a message without operations or learning evidence.",
              );
          } catch (error) {
            throw new Error(
              `Cannot open classroom ${name} with ${backend} teacher: ${error instanceof Error ? error.message : String(error)}. Retry open_classroom explicitly.`,
              { cause: error },
            );
          } finally {
            this.controllers.delete(controller);
          }
        }
        if (!changes.length) return;
        if (this.stopping) throw new Error("Teacher service stopped before ownership commit.");
        const transaction = {
          version: 1 as const,
          decision: "prepared" as "prepared" | "committed",
          changes,
        };
        saveOwnershipTransaction(transaction);
        transaction.decision = "committed";
        saveOwnershipTransaction(transaction);
        finishOwnershipTransaction(transaction);
        // All files are committed before any public identity or queue is released.
        for (const change of changes) {
          const saved = readTeacherState(change.classroom)!;
          const state = this.states.get(change.classroom);
          if (state) {
            state.identity = saved.identity;
            state.previousIdentities = saved.previousIdentities;
          } else {
            this.states.set(change.classroom, saved);
            this.recover(change.classroom);
          }
        }
      } finally {
        const unresolved = pendingOwnershipTransaction();
        if (unresolved?.decision === "prepared") finishOwnershipTransaction(unresolved);
        if (!unresolved || unresolved.decision === "prepared") {
          for (const name of names) {
            this.switching.delete(name);
            this.publishOwnership(name);
            this.wake(name);
          }
        }
      }
    });
    this.ownershipOrder = work.catch(() => {});
    return work;
  }
  private publishOwnership(classroom: string): void {
    if (!this.states.has(classroom)) return;
    this.publish(classroom, "");
    for (const lesson of store.listLessons(classroom)) this.publish(classroom, lesson.name);
  }
  connect(applyConnectionSettings?: () => Promise<void>): void {
    server.setHooks({
      delivery: "service",
      applyConnectionSettings,
      lessonOwner: (classroom) => {
        const state = this.states.get(classroom);
        if (!state) throw new Error("No teacher owns this classroom. Call open_classroom first.");
        return state.identity.backend;
      },
      onNextLesson: (r) => this.nextLesson(r),
      onNextLessonRetry: (r) => {
        if (this.states.get(r.classroom)?.requests.some((x) => x.id === `lesson:${r.id}`))
          this.retry(r.classroom, `lesson:${r.id}`);
        else this.nextLesson(updateLessonRequest(r, { status: "queued" }));
      },
      reviewOwner: "service",
      onAsk: (a) => this.question(a),
      onFollowUp: (a, f) => this.followUp(a, f),
      onQuizSubmit: (s) => this.submission(s),
      onGradeDispute: (input) => this.dispute(input),
      onReflect: (r) => this.reflection(r),
      teacherSettings: (classroom) => this.settings(classroom),
      setTeacherModel: (classroom, model, revision) => this.setModel(classroom, model, revision),
      teacherState: (classroom, lesson) => this.publicState(classroom, lesson),
      onTeacherChat: (classroom, lesson, text, id) => this.chat(classroom, lesson, text, id),
      onTeacherRetry: (classroom, id) => this.retry(classroom, id),
      onReviewMiss: (s) => this.correctReview(s),
      onGradeSaved: (s) => this.maintenance(s.classroom),
      onReviewSaved: (classroom) => this.maintenance(classroom),
      onReview: (session) => this.review(session),
      onReviewRetry: (session) => {
        if (
          this.states.get(session.classroom)?.requests.some((r) => r.id === `review:${session.id}`)
        )
          this.retry(session.classroom, `review:${session.id}`);
        else {
          updateReview(session, "queued");
          this.review({ ...session, status: "queued" });
        }
      },
      canAccept: (classroom) => {
        if (!this.states.has(classroom))
          throw new Error("No teacher owns this classroom. Call open_classroom first.");
      },
    });
  }
  private enqueue(r: Omit<TeacherRequest, "status" | "at">): void {
    const state = this.states.get(r.classroom);
    if (!state) throw new Error(`No teacher owns classroom ${r.classroom}.`);
    if (state.requests.some((x) => x.id === r.id)) return;
    state.requests.push({ ...r, status: "queued", at: Date.now() });
    saveTeacherState(r.classroom, state);
    this.publish(r.classroom, r.lesson);
    this.wake(r.classroom);
  }
  question(a: store.Annotation): void {
    this.enqueue({
      id: `ask:${a.id}`,
      classroom: a.classroom,
      lesson: a.lesson,
      kind: "ask",
      target: a.id,
      prompt: askPrompt(a, "service"),
    });
  }
  followUp(a: store.Annotation, f: store.FollowUp): void {
    this.enqueue({
      id: `follow-up:${f.id}`,
      classroom: a.classroom,
      lesson: a.lesson,
      kind: "follow-up",
      target: a.id,
      turn: f.id,
      prompt: followUpPrompt(a, f, "service"),
    });
  }
  submission(s: store.QuizSubmission): void {
    if (completeClosedSubmission(s)) return;
    this.enqueue({
      id: `quiz:${s.id}`,
      classroom: s.classroom,
      lesson: s.lesson,
      kind: "quiz",
      target: s.id,
      prompt: gradePrompt(s, "service", store.previousGrade(s)),
    });
  }
  dispute(input: DisputeTarget): string {
    const state = this.states.get(input.classroom);
    if (!state) throw new Error("No classroom teacher. Call open_classroom first.");
    const id = `dispute:${input.id}`;
    const existing = state.requests.find(
      (r) =>
        r.id === id ||
        (r.kind === "dispute" &&
          r.dispute?.lesson === input.lesson &&
          r.dispute.submissionId === input.submissionId &&
          r.dispute.questionId === input.questionId &&
          r.dispute.gradedAt === input.gradedAt),
    );
    if (existing) {
      const d = existing.dispute;
      if (
        !d ||
        d.classroom !== input.classroom ||
        d.lesson !== input.lesson ||
        d.quizId !== input.quizId ||
        d.submissionId !== input.submissionId ||
        d.questionId !== input.questionId ||
        d.gradedAt !== input.gradedAt ||
        d.reason !== input.reason
      )
        throw new Error(
          "A different dispute already uses this request or grade revision. Reload the lesson.",
        );
      return existing.id;
    }
    const dispute = snapshotDispute(input);
    this.enqueue({
      id,
      classroom: input.classroom,
      lesson: input.lesson,
      kind: "dispute",
      target: input.submissionId,
      dispute,
      prompt: "Resolve the saved learner grade dispute.",
    });
    return id;
  }
  reflection(r: store.Reflection): void {
    this.enqueue({
      id: `reflect:${r.id}`,
      classroom: r.classroom,
      lesson: r.lesson,
      kind: "reflect",
      target: r.id,
      prompt: reflectPrompt(r, "service"),
    });
  }
  private reviewSession(request: TeacherRequest): ReviewSession {
    const session = reviewSessions(request.classroom).find((s) => s.id === request.target);
    if (!session || session.lesson !== request.lesson)
      throw new Error("The review request no longer exists.");
    requireReviewOwner(session, "service");
    return session;
  }
  review(session: ReviewSession): void {
    requireReviewOwner(session, "service");
    if (session.document) {
      if (session.status !== "failed") {
        completePreparedReview(session);
        this.maintenance(session.classroom);
      }
      return;
    }
    if (this.states.get(session.classroom)?.requests.some((r) => r.id === `review:${session.id}`))
      return;
    this.enqueue({
      id: `review:${session.id}`,
      classroom: session.classroom,
      lesson: session.lesson,
      kind: "review",
      target: session.id,
      prompt: reviewPrompt(session, "service"),
    });
    if (session.status === "failed") {
      const state = this.states.get(session.classroom)!;
      const request = state.requests.find((r) => r.id === `review:${session.id}`)!;
      request.status = "failed";
      request.error = session.error;
      saveTeacherState(session.classroom, state);
    }
  }
  nextLesson(request: LessonRequest): void {
    const state = this.states.get(request.classroom);
    if (!state) throw new Error("No teacher owns this classroom. Call open_classroom first.");
    requireLessonOwner(request, state.identity.backend);
    if (request.owner === "pi" && request.delivery !== "service")
      throw new Error("This legacy Pi lesson request must finish in its previous Pi package.");
    this.enqueue({
      id: `lesson:${request.id}`,
      classroom: request.classroom,
      lesson: request.lesson,
      kind: "lesson",
      target: request.id,
      prompt: nextLessonPrompt(request, "service"),
    });
    if (request.status === "failed") {
      const mirror = state.requests.find((r) => r.id === `lesson:${request.id}`)!;
      mirror.status = "failed";
      mirror.error = request.error;
      saveTeacherState(request.classroom, state);
    }
  }
  private lessonRequest(r: TeacherRequest): LessonRequest {
    const request = lessonRequests(r.classroom).find((x) => x.id === r.target);
    if (!request) throw new Error("The lesson request no longer exists.");
    requireLessonOwner(request, this.states.get(r.classroom)!.identity.backend);
    return request;
  }
  private refillRequest(request: TeacherRequest): RefillRequest {
    const saved = refillRequests(request.classroom).find(
      (r) => r.id === request.target && r.owner === "service",
    );
    if (!saved) throw new Error("This service does not own the refill request.");
    return saved;
  }
  maintenance(classroom: string): void {
    if (this.stopping || !this.states.has(classroom)) return;
    for (const request of discoverRefills(classroom, "service")) {
      const state = this.states.get(classroom);
      if (!state || request.status === "done" || state.requests.some((r) => r.id === request.id))
        continue;
      this.enqueue({
        id: request.id,
        classroom,
        lesson: request.lesson,
        kind: "refill",
        target: request.id,
        prompt: request.prompt,
      });
      if (request.status === "failed") {
        const mirror = state.requests.find((r) => r.id === request.id)!;
        mirror.status = "failed";
        mirror.error = request.error;
        saveTeacherState(classroom, state);
      }
    }
  }
  private recover(classroom: string): void {
    for (const request of lessonRequests(classroom))
      if (
        request.owner === this.states.get(classroom)!.identity.backend &&
        request.status !== "done"
      )
        this.nextLesson(request);
    for (const session of reviewSessions(classroom)) {
      if (session.owner !== "service" || session.status === "done") continue;
      this.review(session);
    }
    for (const l of store.listLessons(classroom)) {
      for (const a of store.listAnnotations(classroom, l.name)) {
        if (a.status === "pending") this.question(a);
        for (const f of a.followUps ?? []) if (f.status === "pending") this.followUp(a, f);
      }
      for (const s of store.listSubmissions(classroom, l.name)) {
        if (!store.listGrades(classroom, l.name).some((g) => g.submissionId === s.id))
          this.submission(s);
        else if (isStoredReview(l.name) && s.deterministicGrades?.some((grade) => !grade.correct))
          this.correctReview(s);
      }
      for (const r of store.listReflections(classroom, l.name)) this.reflection(r);
    }
    this.maintenance(classroom);
  }
  chat(classroom: string, lesson: string, text: string, id: string): void {
    const state = this.states.get(classroom);
    if (!state) throw new Error("No classroom teacher. Call open_classroom first.");
    const key = `chat:${id}`;
    const existingReply = state.messages.find((m) => m.id === key && m.role === "learner");
    if (existingReply && (existingReply.lesson !== lesson || existingReply.text !== text))
      throw new Error("This reply ID already belongs to a different saved panel reply.");
    if (!state.messages.some((m) => m.id === key)) {
      const previous = this.messages(classroom, lesson, state).at(-1);
      state.messages.push({
        id: key,
        lesson,
        role: "learner",
        text,
        at: this.nextMessageAt(classroom, lesson, state),
        ...(previous?.role === "teacher" ? { replyTo: previous.id } : {}),
      });
      saveTeacherState(classroom, state);
    }
    this.enqueue({
      id: key,
      classroom,
      lesson,
      kind: "chat",
      target: id,
      prompt: id.startsWith("reteach:")
        ? `${reteachPrompt(text)}\n\nPut the complete explanation, worked example, and question in this plan's message field. The service posts only that field to this lesson's teacher panel. Other assistant prose and earlier turns in this model session are invisible to the learner. Repeat the full re-teach in message even if you already wrote it elsewhere; do not refer to an explanation above or elsewhere.`
        : `The learner replied in the teacher panel:\n${text}`,
    });
  }
  private correctReview(submission: store.QuizSubmission): void {
    if (!this.states.has(submission.classroom)) return;
    this.resume(
      { classroom: submission.classroom, lesson: submission.lesson, submission_id: submission.id },
      true,
    );
  }
  resume(input: ResumeInput, reviewCard = false): void {
    const request = prepareResume(input);
    const state = this.states.get(request.classroom);
    if (!state) throw new Error("No classroom teacher. Call open_classroom first.");
    if (piResumes(request.classroom).some((r) => r.status === "running" && piOwnerAlive(r)))
      throw new Error(
        "A live Pi session owns this classroom's resume request. Finish it and explicitly stop the previous Pi server, then retry open_classroom.",
      );
    if (reviewCard) {
      if (!state.requests.some((r) => r.id === request.id))
        this.enqueue({ ...request, kind: "resume", target: input.submission_id });
      return;
    }
    if (state.requests.some((r) => r.lesson === request.lesson && r.status !== "done")) return;
    const reply = this.messages(request.classroom, request.lesson, state).at(-1);
    if (reply?.role === "learner") {
      if (!reply.id.startsWith("chat:") || state.requests.some((r) => r.id === reply.id))
        throw new Error("The saved learner reply has no unfinished panel request.");
      // Preserve the actual reply when it comes from historical Pi storage.
      const existing = state.messages.find((m) => m.id === reply.id && m.role === "learner");
      if (existing && (existing.lesson !== request.lesson || existing.text !== reply.text))
        throw new Error("The saved reply ID belongs to a different panel message.");
      if (!existing) {
        state.messages.push(reply);
        saveTeacherState(request.classroom, state);
      }
      this.enqueue({
        id: reply.id,
        classroom: request.classroom,
        lesson: request.lesson,
        kind: "chat",
        target: reply.id.slice("chat:".length),
        prompt: `The learner replied in the teacher panel:\n${reply.text}`,
      });
      return;
    }
    if (reply) return;
    if (state.requests.some((r) => r.id === request.id))
      throw new Error("The completed resume request has no saved teacher message.");
    this.enqueue({ ...request, kind: "resume", target: input.submission_id });
  }
  retry(classroom: string, id: string): void {
    const state = this.states.get(classroom),
      r = state?.requests.find((r) => r.id === id);
    if (!state || !r || r.status !== "failed") throw new Error("This request cannot be retried.");
    if (r.kind === "quiz" && r.plan?.learning_record.trim()) {
      const submitted = store.findSubmission(r.target);
      const grade = store
        .latestGrades(r.classroom, r.lesson)
        .find((grade) => grade.submissionId === r.target);
      if (
        submitted?.kind === "pretest" &&
        grade &&
        !grade.questions.some((question) => question.correct)
      ) {
        delete r.plan;
        delete r.recordFile;
        r.applied = 0;
        r.planValidated = false;
      }
    }
    if (r.kind === "quiz" && r.plan && !(r.applied ?? 0)) {
      const submission = store.findSubmission(r.target);
      if (submission?.rubricDigest && r.planRubricDigest !== submission.rubricDigest) {
        delete r.plan;
        delete r.planRubricDigest;
      }
      if (r.plan && submission) {
        try {
          const call = r.plan.calls.find(
            (call) => call.name === (r.planVersion === 2 ? GRADE_ANSWERS : "grade_lesson_quiz"),
          );
          if (!call) throw new Error("The saved plan has no grade call.");
          const supplied = JSON.parse(call.arguments_json);
          const args = r.planVersion === 2 ? scoredAnswers(supplied) : supplied;
          validateGrade(
            args.score,
            args.questions.map(
              (q: {
                question_id: string;
                correct: boolean;
                points_earned?: number;
                points_possible?: number;
              }) => ({
                questionId: q.question_id,
                correct: q.correct,
                pointsEarned: q.points_earned,
                pointsPossible: q.points_possible,
              }),
            ),
            [
              ...new Set(
                submission.answers
                  .filter(
                    (answer) =>
                      !submission.deterministicGrades?.some(
                        (q) => q.questionId === answer.questionId,
                      ),
                  )
                  .map((answer) => answer.questionId),
              ),
            ],
          );
        } catch {
          delete r.plan;
        }
      }
    }
    if (r.kind === "review" && r.plan) {
      try {
        validateReview(this.reviewSession(r), this.reviewDocument(r.plan));
      } catch {
        delete r.plan;
      }
    }
    if (r.kind === "lesson") {
      let request = this.lessonRequest(r);
      // Older decoder failures saved raw output only in the teacher state.
      // Preserve it in the authoring attempt before an explicit retry replaces it.
      if (request.modelOutput === undefined && r.modelOutput !== undefined)
        request = updateLessonRequest(request, { modelOutput: r.modelOutput });
      const failedPage = request.pageCheckFailed;
      prepareLessonRetry(request);
      if (failedPage) {
        delete r.plan;
        r.planValidated = false;
      }
    }
    if (
      r.kind !== "review" &&
      !(r.kind === "lesson" && this.lessonRequest(r).document) &&
      r.plan &&
      r.planValidated !== true &&
      !(r.applied ?? 0)
    )
      delete r.plan;
    if (r.kind === "lesson") {
      const request = this.lessonRequest(r);
      if (request.document) {
        r.status = "planned";
      }
      updateLessonRequest(request, { status: "queued", error: undefined });
    }
    if (!r.plan && r.kind === "lesson")
      r.prompt = nextLessonPrompt({ ...this.lessonRequest(r), error: r.error }, "service");
    if (!r.plan && r.error)
      r.prompt += `\n\nPrevious teacher plan error: ${r.error}\nCorrect it in the new plan.`;
    const refill = r.kind === "refill" ? refreshRefill(this.refillRequest(r)) : null;
    if (refill && !r.plan) r.prompt = refill.prompt;
    r.status = r.plan ? "planned" : "queued";
    if (r.kind === "review") updateReview(this.reviewSession(r), "queued");
    if (refill) updateRefill(refill, r.plan ? "planned" : "queued");
    delete r.error;
    saveTeacherState(classroom, state);
    this.publish(classroom, r.lesson);
    this.wake(classroom);
  }
  /** Include saved Pi conversation when a classroom moves to a persistent host. */
  private messages(
    classroom: string,
    lesson: string,
    state: TeacherState,
  ): (store.PanelMessage & { sourceBackend?: "pi" })[] {
    const current = state.messages.filter((m) => m.lesson === lesson);
    const history = store
      .listPanelMessages(classroom, lesson)
      .filter((m) => !current.some((existing) => existing.id === m.id && existing.role === m.role))
      .map((m) => ({ ...m, sourceBackend: "pi" as const }));
    return [...history, ...current].sort((a, b) => a.at - b.at);
  }
  /** Keep replies after saved messages if the clock has moved back. */
  private nextMessageAt(classroom: string, lesson: string, state: TeacherState): number {
    const previous = this.messages(classroom, lesson, state).at(-1);
    return previous ? Math.max(Date.now(), previous.at + 1) : Date.now();
  }
  settings(classroom: string) {
    const state = this.states.get(classroom);
    if (!state) return null;
    const running = state.requests.find((request) => request.status === "running");
    const last = [...state.requests].reverse().find((request) => request.status === "failed");
    return {
      identity: {
        backend: state.identity.backend,
        requestedModel: state.identity.requestedModel,
        selectionRevision: state.identity.selectionRevision,
        activeModel: state.identity.activeModel,
        activeRequestedModel: state.identity.activeRequestedModel,
        activeModelAt: state.identity.activeModelAt,
      },
      running: running ? { id: running.id, requestedModel: running.requestedModel ?? null } : null,
      error: last?.error,
    };
  }
  setModel(classroom: string, value: unknown, revision: unknown): void {
    const model = modelSelection(value);
    const state = this.states.get(classroom);
    if (!state) throw new Error("No teacher owns this classroom. Open it from your agent first.");
    if (this.switching.has(classroom))
      throw new Error("Teacher is switching. Retry model selection after opening finishes.");
    if (revision !== (state.identity.selectionRevision ?? 0))
      throw new Error(
        "Teacher model setting changed in another page. Reload settings before saving again.",
      );
    const identity = {
      ...state.identity,
      requestedModel: model,
      selectionRevision: (state.identity.selectionRevision ?? 0) + 1,
    };
    saveTeacherState(classroom, { ...state, identity });
    state.identity = identity;
    for (const lesson of store.listLessons(classroom)) this.publish(classroom, lesson.name);
  }
  publicState(classroom: string, lesson?: string): unknown {
    const state = this.states.get(classroom);
    if (!state) return null;
    return {
      reteach: lesson === undefined ? [] : reteachOffers(classroom, lesson),
      disputes: lesson === undefined ? [] : publicDisputes(state.requests, lesson),
      switching: this.switching.get(classroom) ?? null,
      identity: {
        backend: state.identity.backend,
        requestedModel: state.identity.requestedModel,
        activeModel: state.identity.activeModel,
        persistent: true,
      },
      requests: state.requests
        .filter((r) => lesson === undefined || r.lesson === lesson)
        .map((r) => ({
          id: r.id,
          lesson: r.lesson,
          target: r.target,
          at: r.at,
          kind: r.kind,
          status: r.status,
          error: r.error,
        })),
      messages: lesson === undefined ? [] : this.messages(classroom, lesson, state).map(withHtml),
    };
  }
  private publish(classroom: string, lesson: string): void {
    server.pushEvent(classroom, lesson, "teacher", this.publicState(classroom, lesson));
  }
  private wake(classroom: string): void {
    if (
      this.stopping ||
      !this.states.has(classroom) ||
      this.switching.has(classroom) ||
      this.active.has(classroom)
    )
      return;
    // Defer execution until the request is fully saved and its HTTP response can finish.
    const work = Promise.resolve()
      .then(() => this.drain(classroom))
      .finally(() => {
        this.active.delete(classroom);
      });
    this.active.set(classroom, work);
  }
  async idle(): Promise<void> {
    await Promise.all(this.active.values());
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    await this.idle();
    await this.ownershipOrder;
  }
  private contract(r: TeacherRequest): PlanContract {
    switch (r.kind) {
      case "lesson":
        return {
          operations: ["publish_lesson"],
          required: true,
          messageRequired: true,
          research: true,
        };
      case "dispute":
        return {
          operations: [RESOLVE_DISPUTE],
          required: true,
          messageRequired: true,
          response: "dispute-resolution",
          disputeTarget: r.dispute
            ? {
                id: r.dispute.id,
                questionId: r.dispute.questionId,
                machine:
                  r.dispute.submission.deterministicGrades?.some(
                    (q) => q.questionId === r.dispute!.questionId,
                  ) ?? false,
              }
            : undefined,
        };
      case "quiz":
        return { operations: [GRADE_ANSWERS], required: true, messageRequired: true };
      case "ask":
      case "follow-up":
        return {
          operations: ["answer_lesson_question"],
          required: true,
          response: "passage-answer",
          passageAnnotationId: r.target,
        };
      case "refill": {
        const request = this.refillRequest(r);
        return {
          operations: [REFILL_TOOL.name],
          required: true,
          response: "review-variants",
          refillTarget: {
            classroom: request.classroom,
            requestId: request.id,
            count: request.reason === "miss" ? 1 : 2,
          },
        };
      }
      case "review":
        return { operations: ["publish_review"], required: true, messageRequired: true };
      case "chat": {
        if (r.target.startsWith("reteach:")) return { operations: [], messageRequired: true };
        // The same saved reply and review items that apply() later checks.
        const answer = this.states
          .get(r.classroom)
          ?.messages.find((m) => m.id === r.id && m.role === "learner")?.text;
        return {
          operations: ["record_retrieval_check"],
          messageRequired: true,
          notesAllowed: true,
          response: "retrieval-check",
          retrievalTarget: {
            classroom: r.classroom,
            answer,
            // findReviewItem accepts an item key or one of its exact question keys.
            reviewKeys: [
              ...new Set(
                store
                  .lessonReviewItems(r.classroom, r.lesson)
                  .flatMap((item) => [item.key, ...(item.questionKeys ?? [])]),
              ),
            ],
          },
        };
      }
      case "reflect":
        return { operations: [], messageRequired: true, notesAllowed: true };
      case "resume":
        return { operations: [], messageRequired: true };
    }
  }
  private prompt(r: TeacherRequest, state: TeacherState): string {
    if (r.kind === "lesson") return r.prompt;
    if (r.kind === "dispute") {
      if (
        !r.dispute ||
        r.target !== r.dispute.submissionId ||
        r.classroom !== r.dispute.classroom ||
        r.lesson !== r.dispute.lesson
      )
        throw new Error("The dispute request does not match its target.");
      validateDisputeTarget(r.dispute, r.id);
      return disputePrompt(r.dispute, r.id, planSchema(this.contract(r))) + `\n\n${r.prompt}`;
    }
    if (r.kind === "review") return r.prompt;
    if (r.kind === "refill")
      return `${r.prompt}\n\nRequired typed response schema: ${JSON.stringify(planSchema(this.contract(r)))}`;
    const lesson = store.readLesson(r.classroom, r.lesson);
    if (!lesson) throw new Error("The request lesson no longer exists.");
    const rubric = path.join(lessonDir(r.classroom, r.lesson), "quiz", "key.json");
    if (r.kind === "quiz" && !fs.existsSync(rubric))
      throw new Error("Private quiz rubric is missing. Write quiz/key.json before grading.");
    const privateRubric = fs.existsSync(rubric) ? fs.readFileSync(rubric, "utf8") : null;
    let codeRecordReferences = "";
    if (r.kind === "quiz") {
      const submission = store.findSubmission(r.target);
      if (!submission) throw new Error("The submitted quiz no longer exists.");
      const digest = createHash("sha256").update(privateRubric!).digest("hex");
      if (submission.rubricDigest && digest !== submission.rubricDigest)
        throw new Error(
          "The private rubric changed after submission. Restore it before teacher work.",
        );
      r.planRubricDigest = digest;
      const forms = submission.answers
        .filter((answer) => answer.type === "code")
        .map((answer) => `${submission.quizId}/${answer.questionId}`);
      if (forms.length)
        codeRecordReferences = `Code question citation reference forms for this immutable submission: ${JSON.stringify(forms)}. These are reference forms, not an eligibility grant. An optional learning_record may cite a code question only when it is fully credited and supported by the saved source, using the exact quizId/questionId form. Do not infer independence, retention or mastery from these references or browser results. A learning_record is unnecessary for grading; return learning_record=null when no supported record is being written.`;
    }
    const classroomDocs = store.listClassroomDocs(r.classroom).map((file) => ({
      file,
      text: fs.readFileSync(path.join(classroomDir(r.classroom), file), "utf8"),
    }));
    const index = classroomDocs.find((doc) => doc.file === "NOTES.md");
    const links = [
      ...new Set(
        [...(index?.text ?? "").matchAll(/\[[^\]]*\]\((notes\/[a-z0-9.-]+\.md)(?:#[^)]*)?\)/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    const topicNotes = links.map((file) => {
      const target = safeStaticFile(classroomDir(r.classroom), file);
      if (!target) throw new Error(`Indexed teacher note is missing or unsafe: ${file}.`);
      return { file, text: fs.readFileSync(target, "utf8") };
    });
    const staged = stageLesson(
      fs.readFileSync(lesson.htmlPath, "utf8"),
      new Set(
        store
          .latestQuizStates(r.classroom, r.lesson)
          .filter((s) => s.submission.kind === "pretest" && s.grade)
          .map((s) => s.quizId),
      ),
    );
    const reviewItems = store.lessonReviewItems(r.classroom, r.lesson);
    const replyAt = state.messages.find((m) => m.id === r.id && m.role === "learner")?.at ?? r.at;
    const context = {
      lesson: staged.html,
      lessonStage: {
        gatedPretests: staged.gatedPretests,
        pendingPretests: staged.pendingPretests,
      },
      privateRubric,
      teachingPlan: r.kind === "quiz" ? store.findSubmission(r.target)?.teachingPlan : undefined,
      records: store.readLearningRecords(r.classroom),
      messages: this.messages(r.classroom, r.lesson, state),
      grades: store.latestGrades(r.classroom, r.lesson),
      reviewItems,
      reviewTiming: r.kind === "chat" ? reviewTiming(reviewItems, replyAt) : [],
      classroomDocs,
      topicNotes,
    };
    const contract = this.contract(r);
    const defs = classroomTools(PI_HOST)
      .map((tool) => (tool.name === "grade_lesson_quiz" ? answerGradingTool(tool) : tool))
      .filter((t) => contract.operations.includes(t.name));
    // Reassemble queued passage requests with the current transport instructions.
    // Historical raw outputs and already-saved canonical plans never pass this boundary.
    let requestPrompt = r.prompt;
    if (contract.response === "passage-answer") {
      const annotation = store.findAnnotation(r.target);
      if (!annotation || annotation.classroom !== r.classroom || annotation.lesson !== r.lesson)
        throw new Error("The passage request no longer owns its annotation.");
      const followUp =
        r.kind === "follow-up"
          ? annotation.followUps?.find((turn) => turn.id === r.turn)
          : undefined;
      if (r.kind === "follow-up" && !followUp)
        throw new Error("The passage follow-up no longer exists.");
      requestPrompt = followUp
        ? followUpPrompt(annotation, followUp, "service")
        : askPrompt(annotation, "service");
    }
    return dedicatedTeacherPrompt(
      r.id,
      `Current request kind: ${r.kind}. ${contract.response === "passage-answer" ? "Return the typed passage answer fields from the current response schema." : contract.response === "retrieval-check" ? "Return retrieval_check from the current response schema only when this learner reply demonstrates understanding. Otherwise return retrieval_check=null." : contract.required ? "Return exactly one call from the plan operation definitions." : contract.operations.length ? "Return only retrieval calls supported by this learner reply. Otherwise return calls=[]." : "Return calls=[]."}\n\n${requestPrompt}${codeRecordReferences ? `\n\n${codeRecordReferences}` : ""}`,
      context,
      defs.map((t) => {
        const parameters = structuredClone(t.parameters);
        if (t.name === "record_retrieval_check") {
          delete (parameters.properties as Record<string, unknown>).learning_record;
          parameters.required = (parameters.required as string[]).filter(
            (key) => key !== "learning_record",
          );
        }
        return { name: t.name, description: t.description, parameters };
      }),
      contract.response === "passage-answer" || contract.response === "retrieval-check"
        ? contract.response
        : undefined,
    );
  }
  private async drain(classroom: string): Promise<void> {
    const state = this.states.get(classroom)!;
    while (!this.stopping && !this.switching.has(classroom)) {
      const pending = (r: TeacherRequest) => r.status === "queued" || r.status === "planned";
      const r =
        state.requests.find((r) => r.kind !== "refill" && pending(r)) ??
        state.requests.find(pending);
      if (!r) return;
      r.startedAt = Date.now();
      delete r.finishedAt;
      try {
        if (!r.plan) {
          r.status = "running";
          r.requestedModel = state.identity.requestedModel ?? null;
          r.originatingIdentity = { ...state.identity };
          delete r.resolvedModel;
          delete r.streamDigest;
          if (r.kind === "lesson")
            updateLessonRequest(this.lessonRequest(r), { status: "running", error: undefined });
          if (r.kind === "review") updateReview(this.reviewSession(r), "running");
          if (r.kind === "refill") {
            r.prompt = refreshRefill(this.refillRequest(r)).prompt;
            updateRefill(this.refillRequest(r), "running");
          }
          saveTeacherState(classroom, state);
          this.publish(classroom, r.lesson);
          // One contract per run: rebuilding it after inference could lose an unsaved plan.
          const contract = this.contract(r);
          const controller = new AbortController();
          this.controllers.add(controller);
          let plan;
          try {
            plan = await this.run(
              requestIdentity(state.identity, r),
              this.prompt(r, state),
              classroomDir(classroom),
              (id) => {
                if (id) state.identity.sessionId = id;
                else delete state.identity.sessionId;
                if (r.originatingIdentity) {
                  if (id) r.originatingIdentity.sessionId = id;
                  else delete r.originatingIdentity.sessionId;
                }
                saveTeacherState(classroom, state);
              },
              controller.signal,
              contract,
              (value) => {
                r.modelOutput = value;
                saveTeacherState(classroom, state);
                if (r.kind === "lesson")
                  updateLessonRequest(this.lessonRequest(r), { modelOutput: value });
              },
              (model) => {
                r.resolvedModel = model;
                state.identity.activeModel = model;
                state.identity.activeRequestedModel = r.requestedModel;
                state.identity.activeModelAt = Date.now();
                saveTeacherState(classroom, state);
                this.publish(classroom, r.lesson);
              },
              (digest) => {
                r.streamDigest = digest;
                saveTeacherState(classroom, state);
              },
            );
          } finally {
            this.controllers.delete(controller);
          }
          r.plan = parsePlan(plan);
          // Version 3 marks a retrieval check that code serialized from typed reply data.
          // A null check has no call, so it stays readable by older packages.
          r.planVersion = contract.response === "retrieval-check" && r.plan.calls.length ? 3 : 2;
          r.planValidated = false;
          r.status = "planned";
          saveTeacherState(classroom, state);
          this.publish(classroom, r.lesson);
        }
        if (r.kind === "lesson")
          updateLessonRequest(this.lessonRequest(r), { status: "running", error: undefined });
        await this.apply(r, state);
        r.finishedAt = Date.now();
        r.status = "done";
        // The digest only diagnoses failures.
        delete r.streamDigest;
        if (r.kind === "review") updateReview(this.reviewSession(r), "done");
        console.log(
          `[teacher] ${state.identity.backend} ${classroom}/${r.lesson} ${r.id} done in ${r.finishedAt - r.startedAt}ms.`,
        );
        saveTeacherState(classroom, state);
        this.publish(classroom, r.lesson);
      } catch (err) {
        r.status = "failed";
        r.finishedAt = Date.now();
        r.error = `${state.identity.backend} model ${r.requestedModel ?? "configured default"} ${r.kind} request ${r.id} in ${classroom}/${r.lesson}: ${err instanceof Error ? err.message : String(err)}`;
        if (r.kind === "lesson")
          updateLessonRequest(this.lessonRequest(r), { status: "failed", error: r.error });
        if (r.kind === "review") updateReview(this.reviewSession(r), "failed", r.error);
        if (r.kind === "refill") updateRefill(this.refillRequest(r), "failed", r.error);
        console.error(`[teacher] ${r.error}`);
        saveTeacherState(classroom, state);
        this.publish(classroom, r.lesson);
      }
    }
  }
  private reviewDocument(plan: TeacherPlan): ReviewDocument {
    if (
      plan.calls.length !== 1 ||
      plan.calls[0].name !== "publish_review" ||
      plan.learning_record.trim() ||
      plan.notes_markdown.trim()
    )
      throw new Error(
        "Review authoring requires exactly one publish_review call and no evidence writes.",
      );
    const document = JSON.parse(plan.calls[0].arguments_json);
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      typeof document.lesson_html !== "string" ||
      typeof document.rubric_json !== "string" ||
      typeof document.teaching_plan_json !== "string"
    )
      throw new Error("Invalid review document arguments.");
    return document;
  }
  private async apply(r: TeacherRequest, state: TeacherState): Promise<void> {
    const plan = r.plan!;
    if (r.kind === "lesson") {
      updateLessonRequest(this.lessonRequest(r), { modelOutput: r.modelOutput ?? plan });
      if (
        plan.calls.length !== 1 ||
        plan.calls[0].name !== "publish_lesson" ||
        plan.learning_record.trim() ||
        plan.notes_markdown.trim() ||
        !plan.message.trim()
      )
        throw new Error(
          "Lesson authoring requires exactly one publish_lesson call and no evidence writes.",
        );
      const request = saveLessonDocument(
        this.lessonRequest(r),
        JSON.parse(plan.calls[0].arguments_json),
      );
      r.planValidated = true;
      saveTeacherState(r.classroom, state);
      await completeLessonRequest(request);
      return;
    }
    if (r.kind === "dispute") {
      if (
        !r.dispute ||
        r.target !== r.dispute.submissionId ||
        r.classroom !== r.dispute.classroom ||
        r.lesson !== r.dispute.lesson
      )
        throw new Error("The dispute request does not match its target.");
      const receipt = validateDisputeTarget(r.dispute, r.id);
      const result = resolveDispute(r.dispute, plan);
      r.planValidated = true;
      saveTeacherState(r.classroom, state);
      if (result.questions && !receipt)
        applyGrade(r.dispute.submission, {
          score: result.score!,
          questions: result.questions,
          feedbackMarkdown: plan.message,
          disputeId: r.id,
          revisesGradedAt: r.dispute.gradedAt,
        });
      r.disputeDecision = result.resolution.decision;
      r.applied = 1;
      if (!state.messages.some((m) => m.id === r.id && m.role === "teacher"))
        state.messages.push({
          id: r.id,
          lesson: r.lesson,
          role: "teacher",
          text: plan.message,
          at: this.nextMessageAt(r.classroom, r.lesson, state),
        });
      saveTeacherState(r.classroom, state);
      return;
    }
    if (r.kind === "refill") {
      const request = this.refillRequest(r);
      if (
        plan.calls.length !== 1 ||
        plan.calls[0].name !== REFILL_TOOL.name ||
        plan.learning_record.trim() ||
        plan.notes_markdown.trim() ||
        plan.message.trim()
      )
        throw new Error(
          "A private refill permits only save_review_variants and no learner or evidence writes.",
        );
      const args = JSON.parse(plan.calls[0].arguments_json);
      if (
        args.classroom !== r.classroom ||
        args.request_id !== request.id ||
        !Array.isArray(args.variants)
      )
        throw new Error("Refill output does not belong to this request.");
      if (request.status !== "done") {
        saveRefillPlan(request, args.variants);
        r.planValidated = true;
        saveTeacherState(r.classroom, state);
        applyRefill(request);
      }
      return;
    }
    if (r.kind === "review") {
      const session = this.reviewSession(r),
        document = this.reviewDocument(plan);
      validateReview(session, document);
      r.planValidated = true;
      saveTeacherState(r.classroom, state);
      publishReview(session, document);
      return;
    }
    if (
      (r.kind === "resume" || (r.kind === "chat" && r.target.startsWith("reteach:"))) &&
      (plan.calls.length || plan.learning_record.trim() || plan.notes_markdown.trim())
    )
      throw new Error(
        "Teacher resumption permits only a panel message. Re-teaching also cannot write assessment or learning evidence.",
      );
    const required =
      r.kind === "quiz"
        ? r.planVersion === 2
          ? GRADE_ANSWERS
          : "grade_lesson_quiz"
        : r.kind === "ask" || r.kind === "follow-up"
          ? "answer_lesson_question"
          : null;
    if (required && plan.calls.filter((c) => c.name === required).length !== 1)
      throw new Error(`Teacher must return one ${required} call.`);
    if (r.kind !== "ask" && r.kind !== "follow-up" && !plan.message.trim())
      throw new Error("Teacher message is empty.");
    if ((r.kind === "ask" || r.kind === "follow-up") && plan.calls.length !== 1)
      throw new Error("A passage answer requires exactly one answer_lesson_question call.");
    // Validate ownership for every call before any write.
    const parsed = plan.calls.map((c) => {
      const args = JSON.parse(c.arguments_json);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Invalid teacher arguments.");
      if (
        c.name === "answer_lesson_question" &&
        (required !== c.name || args.annotation_id !== r.target)
      )
        throw new Error("Teacher tried to answer a request it does not own.");
      if (
        c.name === "answer_lesson_question" &&
        (typeof args.answer_markdown !== "string" || !args.answer_markdown.trim())
      )
        throw new Error("Teacher answer is empty.");
      if (
        (c.name === "grade_lesson_quiz" || c.name === GRADE_ANSWERS) &&
        (required !== c.name || args.submission_id !== r.target)
      )
        throw new Error("Teacher tried to grade a request it does not own.");
      if (
        c.name === "record_retrieval_check" &&
        (r.kind !== "chat" || args.classroom !== r.classroom || !plan.learning_record.trim())
      )
        throw new Error("Retrieval evidence requires a learner reply and a learning record.");
      if (c.name === "record_retrieval_check") {
        const learner = state.messages.find((m) => m.id === r.id && m.role === "learner");
        if (
          typeof args.evidence !== "string" ||
          !args.evidence.trim() ||
          args.answer !== learner?.text ||
          !findReviewItem(store.lessonReviewItems(r.classroom, r.lesson), args.review_key)
        )
          throw new Error(
            "Retrieval check must use the actual learner reply and this lesson's review item.",
          );
      }
      const publicTools = classroomTools(PI_HOST);
      const tool =
        c.name === GRADE_ANSWERS
          ? answerGradingTool(publicTools.find((t) => t.name === "grade_lesson_quiz")!)
          : publicTools.find((t) => t.name === c.name);
      if (
        !tool ||
        ![
          "answer_lesson_question",
          "grade_lesson_quiz",
          GRADE_ANSWERS,
          "record_retrieval_check",
        ].includes(c.name)
      )
        throw new Error(`Teacher operation is not allowed: ${c.name}`);
      for (const key of tool.parameters.required as string[])
        if (
          args[key] === undefined &&
          !(c.name === "record_retrieval_check" && key === "learning_record")
        )
          throw new Error(`Teacher omitted ${key}.`);
      return { name: c.name, args, tool };
    });
    if (r.planVersion === 3 && (r.kind !== "chat" || parsed.length > 1))
      throw new Error("A typed panel reply plan permits at most one retrieval check.");
    const pretest = r.kind === "quiz" && store.findSubmission(r.target)?.kind === "pretest";
    const quiz = r.kind === "quiz" ? store.findSubmission(r.target) : null;
    if (quiz) {
      const gradeCall = parsed.find(
        (call) => call.name === "grade_lesson_quiz" || call.name === GRADE_ANSWERS,
      );
      if (gradeCall) validateAnswerCriteria(quiz, gradeCall.args.questions);
    }
    if (quiz?.rubricDigest && r.planRubricDigest !== quiz.rubricDigest)
      throw new Error(
        "The saved grading plan has no matching rubric. Retry to request a new plan.",
      );
    const quizPrefix = quiz?.quizId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const citedQuestions = quiz
      ? [
          ...plan.learning_record.matchAll(
            new RegExp(`(?<![A-Za-z0-9_.-])${quizPrefix}/([A-Za-z0-9_.-]+)`, "g"),
          ),
        ]
          .map((match) => match[1])
          .map((id) =>
            quiz.answers.some((a) => a.questionId === id) ? id : id.replace(/\.+$/, ""),
          )
      : [];
    const quizRecord =
      !pretest &&
      quiz &&
      plan.learning_record.trim() &&
      parsed.some(
        (call) =>
          (call.name === "grade_lesson_quiz" || call.name === GRADE_ANSWERS) &&
          Array.isArray(call.args.questions) &&
          citedQuestions.length > 0 &&
          citedQuestions.every(
            (id) =>
              quiz.answers.some((a) => a.questionId === id) &&
              call.args.questions.some(
                (q: { correct?: boolean; question_id?: string }) =>
                  q.correct === true && q.question_id === id,
              ),
          ),
      );
    if (
      pretest &&
      plan.learning_record.trim() &&
      !parsed.some(
        (call) =>
          (call.name === "grade_lesson_quiz" || call.name === GRADE_ANSWERS) &&
          Array.isArray(call.args.questions) &&
          call.args.questions.some((question: { correct?: boolean }) => question.correct === true),
      )
    )
      throw new Error("A quiz learning record requires fully credited evidence.");
    if (
      plan.learning_record.trim() &&
      !pretest &&
      !quizRecord &&
      !parsed.some((c) => c.name === "record_retrieval_check")
    )
      throw new Error("A learning record requires verified retrieval evidence.");
    if (plan.notes_markdown.trim() && r.kind !== "chat" && r.kind !== "reflect")
      throw new Error("Gap notes require a learner reply or self-explanation.");
    r.planValidated = true;
    saveTeacherState(r.classroom, state);
    if (plan.learning_record.trim() && !r.recordFile) {
      const numbers = store
        .listLearningRecords(r.classroom)
        .map((file) => Number(/^(\d+)-/.exec(file)?.[1] ?? 0));
      r.recordFile = `${String(Math.max(0, ...numbers) + 1).padStart(4, "0")}-teacher-check.md`;
      saveTeacherState(r.classroom, state);
    }
    const recordFile = r.recordFile!;
    for (let i = r.applied ?? 0; i < parsed.length; i++) {
      const { name, args, tool } = parsed[i];
      if (name === "answer_lesson_question") {
        const a = store.findAnnotation(r.target);
        const turn = r.turn ?? null;
        if (a && store.isTurnPending(a, turn)) {
          applyTurnAnswer(r.target, turn, args.answer_markdown);
        }
      } else if (name === "grade_lesson_quiz" || name === GRADE_ANSWERS) {
        if (!store.listGrades(r.classroom, r.lesson).some((g) => g.submissionId === r.target)) {
          const result = await tool.execute(args);
          if (isFailure(result)) {
            if (result.details.storageError !== true) r.planValidated = false;
            throw new Error(result.content[0].text);
          }
        }
      } else {
        const dir = path.join(classroomDir(r.classroom), "learning-records");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, recordFile);
        if (fs.existsSync(file)) {
          if (fs.readFileSync(file, "utf8") !== plan.learning_record)
            throw new Error("Learning record path belongs to another record.");
        } else fs.writeFileSync(file, plan.learning_record, { flag: "wx" });
        args.learning_record = recordFile;
        const previous = store
          .listRetrievalChecks(r.classroom)
          .find((check) => check.key === args.review_key && check.learningRecord === recordFile);
        if (!previous) {
          const reply = state.messages.find((m) => m.id === r.id && m.role === "learner");
          if (!reply)
            throw new Error("The retrieval request has no saved learner reply timestamp.");
          const result = await tool.execute(args, {
            retrieval: { classroom: r.classroom, lesson: r.lesson, reply },
          });
          if (isFailure(result)) throw new Error(result.content[0].text);
        }
      }
      r.applied = i + 1;
      saveTeacherState(r.classroom, state);
    }
    if ((pretest || quizRecord) && plan.learning_record.trim()) {
      const priorGrade = store
        .latestGrades(r.classroom, r.lesson)
        .find((grade) => grade.submissionId === r.target);
      if (
        !priorGrade ||
        (pretest
          ? !priorGrade.questions.some((q) => q.correct)
          : !citedQuestions.every((id) =>
              priorGrade.questions.some((q) => q.correct && q.questionId === id),
            ))
      )
        throw new Error("A quiz learning record requires fully credited evidence.");
      const file = path.join(classroomDir(r.classroom), "learning-records", recordFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        if (fs.readFileSync(file, "utf8") !== plan.learning_record)
          throw new Error("Learning record path belongs to another record.");
      } else fs.writeFileSync(file, plan.learning_record, { flag: "wx" });
    }
    if (plan.notes_markdown.trim()) {
      const index = path.join(classroomDir(r.classroom), "NOTES.md");
      const indexText = fs.readFileSync(index, "utf8");
      if (!/^## Index\s*$/m.test(indexText))
        throw new Error("NOTES.md needs an Index section before saving teacher notes.");
      const file = path.join(classroomDir(r.classroom), "notes", "teacher-gaps.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, "# Teacher gaps\n", { flag: "wx" });
      const previous = fs.readFileSync(file, "utf8");
      const marker = `<!-- teacher-request:${r.id} -->`;
      if (!previous.includes(marker)) {
        fs.writeFileSync(
          `${file}.teacher.tmp`,
          `${previous}\n\n${marker}\n${plan.notes_markdown}\n`,
        );
        fs.renameSync(`${file}.teacher.tmp`, file);
      }
      if (!indexText.includes("(notes/teacher-gaps.md)")) {
        fs.writeFileSync(
          `${index}.teacher.tmp`,
          indexText.replace(
            /^## Index\s*$/m,
            "## Index\n\n- [Teacher gaps](notes/teacher-gaps.md): Review unresolved checks and self-explanations.",
          ),
        );
        fs.renameSync(`${index}.teacher.tmp`, index);
      }
    }
    if (plan.message.trim() && !state.messages.some((m) => m.id === r.id && m.role === "teacher"))
      state.messages.push({
        id: r.id,
        lesson: r.lesson,
        role: "teacher",
        text: plan.message,
        at: this.nextMessageAt(r.classroom, r.lesson, state),
      });
  }
}
