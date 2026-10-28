import { lessonDir, lessonUrl } from "../src/paths.ts";
/** Drive review creation, reload, failure, retry, and continuation from the classroom page. */
import * as fs from "node:fs";
import * as path from "node:path";
import { applyGrade, ClassroomBridge } from "../src/bridge.ts";
import {
  currentReview,
  reviewSessions,
  updateReview,
  type ReviewSession,
} from "../src/review-session.ts";
import { refillRequests, piRefillTool } from "../src/review-refill.ts";
import { DAY_MS } from "../src/review.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { readTeacherState } from "../src/service-state.ts";
import { TeacherService } from "../src/teacher-service.ts";
import {
  makeFixture,
  seedPreparedReviewSource,
  seedTransferObjective,
  refillPlan,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
} from "../test/helpers.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyReviewBrowser(artifacts: string | null): Promise<void> {
  for (const host of ["pi", "service"] as const) {
    const fixture = makeFixture();
    seedClassroom(fixture);
    if (host === "service") seedTransferObjective();
    else
      writeGradedAttempt({
        at: Date.now() - 2 * DAY_MS,
        answers: [termAnswer("q1", "owner")],
        correct: { q1: true },
      });
    const evidence = artifacts ? path.join(artifacts, host) : null;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    const session = `studens-review-${host}-${process.pid}`;
    let browserOpen = false,
      runs = 0,
      chatRuns = 0,
      refillRuns = 0;
    let conflict = true;
    const bridge = new ClassroomBridge({
      sendUserMessage: (prompt) => {
        if (prompt.includes("Background private review refill")) {
          refillRuns++;
          if (refillRuns === 1) {
            queueMicrotask(() => bridge.onAgentEnd([]));
            return;
          }
          const request = refillRequests("rust").find((r) => r.status === "running")!;
          void piRefillTool()
            .execute(JSON.parse(refillPlan(request).calls[0].arguments_json))
            .then(() => bridge.onAgentEnd([]));
          return;
        }
        runs++;
      },
    });
    const teacher = new TeacherService(async (_identity, prompt) => {
      if (prompt.includes("Background private review refill")) {
        refillRuns++;
        if (refillRuns === 1) throw new Error("Fixture background provider failure.");
        return refillPlan(refillRequests("rust").find((r) => r.status === "running")!);
      }
      runs++;
      if (prompt.includes("The learner replied in the teacher panel")) {
        chatRuns++;
        return {
          calls: [],
          message: "Return when you are ready.",
          learning_record: chatRuns === 1 ? "An unverified record." : "",
          notes_markdown: "",
        };
      }
      const submitted = /submission_id: "([^"]+)"/.exec(prompt);
      if (submitted) {
        const submission = store.findSubmission(submitted[1])!;
        return {
          calls: [
            {
              name: "grade_quiz_answers",
              arguments_json: JSON.stringify({
                submission_id: submission.id,
                feedback_markdown: "The new owner releases it.",
                questions: submission.answers.map((a) => ({
                  question_id: a.questionId,
                  correct: true,
                  points_earned: 1,
                  points_possible: 1,
                  feedback: "Correct.",
                })),
              }),
            },
          ],
          message: "Your review is complete.",
          learning_record: "",
          notes_markdown: "",
        };
      }
      throw new Error("Starting a prepared review must not call a model.");
    });
    const connectHost = () =>
      server.setHooks({
        delivery: host === "service" ? "service" : "push",
        onGradeSaved: (s) =>
          host === "service" ? teacher.maintenance(s.classroom) : bridge.maintenance(s.classroom),
        onAsk: (a) => (host === "service" ? teacher.question(a) : bridge.ask(a)),
        onFollowUp: (a, f) => (host === "service" ? teacher.followUp(a, f) : bridge.followUp(a, f)),
        onQuizSubmit: (s) => (host === "service" ? teacher.submission(s) : bridge.grade(s)),
        onReflect: (r) => (host === "service" ? teacher.reflection(r) : bridge.reflect(r)),
        reviewOwner: host,
        onReview: (s) => {
          if (conflict) {
            fs.mkdirSync(lessonDir("rust", s.lesson), { recursive: true });
            fs.writeFileSync(
              path.join(lessonDir("rust", s.lesson), "lesson.html"),
              "<p>Conflicting file</p>",
            );
            conflict = false;
          }
          if (host === "service") teacher.review(s);
          else bridge.review(s);
        },
        onReviewRetry: (s) => {
          if (host === "pi") bridge.retryReview(s);
          else {
            updateReview(s, "queued");
            teacher.review({ ...s, status: "queued" });
          }
        },
        teacherState: (c, l) =>
          host === "service" ? teacher.publicState(c, l) : bridge.panelState(c, l),
        onTeacherChat: (c, l, text, id) =>
          host === "service" ? teacher.chat(c, l, text, id) : bridge.chat(c, l, text, id),
        onTeacherRetry: (c, id) =>
          host === "service" ? teacher.retry(c, id) : bridge.retry(c, id),
      });
    connectHost();
    if (host === "service") teacher.attach("rust", "codex");
    const code = (body: string) =>
      playwrightCode(
        session,
        fixture.root,
        `async page => {
      page.reviewErrors ??= [];
      if (!page.reviewErrorListener) { page.reviewErrorListener = true; page.on('pageerror', error => page.reviewErrors.push(error.message)); }
      ${body}
      if (page.reviewErrors.length) throw new Error(page.reviewErrors.join('; '));
      return {url:page.url(), snapshot:await page.locator('body').ariaSnapshot()};
    }`,
      );
    const shot = (name: string) =>
      evidence
        ? `await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({path:${JSON.stringify(path.join(evidence, `${name}.png`))},fullPage:true});`
        : "";
    let request: ReviewSession | null = null;
    try {
      const base = await server.start(0);
      await playwright(session, fixture.root, "open", `${base}/c/rust`);
      browserOpen = true;
      await code(`
        await page.getByRole('button', {name:'Start review',exact:true}).waitFor();
        await page.waitForFunction(() => !document.querySelector('[data-cl-review-start]').disabled);
        ${shot("start-review")}
        await page.getByRole('button', {name:'Start review',exact:true}).click();
        await page.getByText('No prepared variants for the due questions.', {exact:false}).waitFor();
        ${shot("legacy-without-pool")}
      `);
      if (currentReview("rust") || runs)
        throw new Error("A legacy lesson silently started authoring.");
      if (host === "service") seedTransferObjective(true, false);
      else seedPreparedReviewSource(fixture.root);
      await code(`
        await page.reload();
        await page.getByRole('button', {name:'Start review',exact:true}).click();
        await page.getByRole('button', {name:'Retry review',exact:true}).waitFor();
        if (!(await page.locator('[data-cl-review-status]').innerText()).includes('conflicts with lesson.html')) throw new Error('The publication conflict is missing.');
        ${shot("failed-review")}
        await page.reload();
        await page.getByRole('button', {name:'Retry review',exact:true}).waitFor();
      `);
      request = currentReview("rust");
      if (
        host === "service" &&
        (request?.items.length !== 1 ||
          request.items[0].key !== "001-ownership/@objective/ownership")
      )
        throw new Error("Several objective probes created duplicate review items.");
      if (!request?.document || runs || reviewSessions("rust").length !== 1)
        throw new Error("Review assembly was not durable or called a teacher.");
      if ((await fetch(`${base}${lessonUrl("rust", request.lesson)}`)).status !== 404)
        throw new Error("An unfinished review was served.");
      fs.unlinkSync(path.join(lessonDir("rust", request.lesson), "lesson.html"));
      await code(`
        await page.getByRole('button', {name:'Retry review',exact:true}).click();
        await page.waitForURL(${JSON.stringify(`${base}${lessonUrl("rust", request.lesson)}*`)});
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
        ${shot("instant-review")}
      `);
      if (runs || currentReview("rust")?.status !== "done")
        throw new Error("Publication retry called a teacher.");
      await code(`
        await page.getByRole('button', {name:'Retry request',exact:true}).waitFor();
        if (await page.locator('form.cl-quiz').getAttribute('data-state') !== 'fresh') throw new Error('Background failure blocked the ready review.');
        ${shot("background-refill-failed")}
        await page.reload();
        await page.getByRole('button', {name:'Retry request',exact:true}).waitFor();
      `);
      if (refillRuns !== 1) throw new Error("Reload silently retried background work.");
      await code(`
        await page.getByRole('button', {name:'Retry request',exact:true}).click();
        await page.waitForFunction(() => !document.querySelector('.cl-teacher-requests button'));
        ${shot("background-refill-retried")}
      `);
      if (refillRequests("rust").some((r) => r.status !== "done") || Number(refillRuns) !== 2)
        throw new Error("Background retry did not save its pool.");
      for (const route of [
        "/c/rust/001-ownership/quiz/review-pool.json",
        "/c/rust/.review-refills.json",
        "/c/rust/.reviews.json",
      ]) {
        if ((await fetch(base + route)).status !== 404)
          throw new Error(`Private variant state is public: ${route}`);
      }
      const publicState = await (
        await fetch(`${base}/api/state?classroom=rust&lesson=${request.lesson}`)
      ).text();
      if (
        publicState.includes("save_review_variants") ||
        publicState.includes("The new owner releases the value.")
      )
        throw new Error("Private refill plans leaked through public state.");
      const unexpectedWork = () => {
        throw new Error("Opening a published review must not start teacher work.");
      };
      server.setHooks({
        reviewOwner: host === "pi" ? "service" : "pi",
        onAsk: unexpectedWork,
        onFollowUp: unexpectedWork,
        onQuizSubmit: unexpectedWork,
        onReflect: unexpectedWork,
        onReview: unexpectedWork,
        onReviewRetry: unexpectedWork,
      });
      await code(`
        await page.waitForURL(${JSON.stringify(`${base}${lessonUrl("rust", request.lesson)}*`)});
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
        if (await page.locator('.cl-quiz-error').count()) throw new Error('Review controls have contract errors.');
        await page.locator('form.cl-quiz textarea').fill('The new owner releases it.');
        ${shot("ready-review")}
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByRole('button', {name:'Continue review',exact:true}).waitFor();
        await page.getByRole('button', {name:'Continue review',exact:true}).click();
        await page.waitForURL(${JSON.stringify(`${base}${lessonUrl("rust", request.lesson)}*`)});
        await page.waitForFunction(() => document.querySelector('form.cl-quiz textarea')?.value === 'The new owner releases it.');
        await page.setViewportSize({width:375,height:812});
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByRole('button', {name:'Continue review',exact:true}).waitFor();
        await page.getByRole('button', {name:'Toggle colour theme',exact:true}).click();
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Review controls overflow on mobile.');
        ${shot("mobile-continue-review")}
      `);
      connectHost();
      if (
        Number(runs) !== 0 ||
        reviewSessions("rust").length !== 1 ||
        currentReview("rust")!.id !== request.id
      )
        throw new Error("Retry or continuation duplicated review work.");
      if (store.listSubmissions("rust", request.lesson).length)
        throw new Error("Opening a review submitted it.");
      for (const privateFile of ["key.json", "plan.json", "review-pool.json"])
        if ((await fetch(`${base}/c/rust/${request.lesson}/quiz/${privateFile}`)).status !== 404)
          throw new Error("Private review file is public.");
      await code(`
        await page.getByRole('button', {name:'Continue review',exact:true}).click();
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
        await page.locator('[data-cl-assistance]').selectOption('none');
        const response = page.waitForResponse(r => r.url().endsWith('/api/quiz/submit'));
        await page.getByRole('button', {name:'Submit for grading',exact:true}).click();
        if ((await response).status() !== 201) throw new Error('The generated review could not be submitted.');
      `);
      if (host === "service") await teacher.idle();
      else {
        const submission = store.listSubmissions("rust", request.lesson)[0];
        applyGrade(submission, {
          score: 100,
          feedbackMarkdown: "The new owner releases it.",
          questions: submission.answers.map((a) => ({
            questionId: a.questionId,
            correct: true,
            pointsEarned: 1,
            pointsPossible: 1,
            feedback: "Correct.",
          })),
        });
        bridge.onAgentEnd([
          { role: "assistant", content: [{ type: "text", text: "Your review is complete." }] },
        ]);
      }
      await code(`
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'graded');
        await page.reload();
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'graded');
        if (!await page.getByRole('button', {name:'Graded',exact:true}).isDisabled()) throw new Error('The review is unlocked.');
        ${shot("graded-review")}
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByRole('button', {name:'Start review',exact:true}).waitFor();
        if (!await page.getByRole('button', {name:'Start review',exact:true}).isDisabled()) throw new Error('Review availability contradicts the saved evidence.');
      `);
      const grade = store.latestGrades("rust", request.lesson)[0];
      const reviewedItem = store
        .reviewItems("rust")
        .find((item) => item.key === request!.items[0].key)!;
      if (
        host === "pi" &&
        (reviewedItem.objective !== undefined || reviewedItem.context !== "unknown")
      )
        throw new Error("A historical question acquired invented objective context.");
      if (host === "service" && reviewedItem.progress !== "retained-evidence")
        throw new Error(
          "The delayed independent transfer did not complete the objective evidence.",
        );
      if (
        !grade ||
        grade.score !== 100 ||
        !store
          .reviewItems("rust")
          .some(
            (item) =>
              item.key === request!.items[0].key && item.attempts === (host === "service" ? 4 : 2),
          )
      )
        throw new Error("The review grade did not update its original item.");
      if (host === "service") {
        await code(`
          await page.goto(${JSON.stringify(`${base}${lessonUrl("rust", request.lesson)}`)});
          await page.getByRole('textbox', {name:'Reply to your teacher',exact:true}).fill('I will return to this later.');
          await page.getByRole('button', {name:'Send reply',exact:true}).click();
          await page.getByRole('button', {name:'Retry request',exact:true}).waitFor();
          if (!(await page.locator('.cl-teacher-requests').innerText()).includes('A learning record requires verified retrieval evidence')) throw new Error('Invalid panel evidence did not fail.');
          ${shot("invalid-panel-plan")}
          const response = page.waitForResponse(r => r.url().endsWith('/api/teacher/retry'));
          await page.getByRole('button', {name:'Retry request',exact:true}).click();
          if (!(await response).ok()) throw new Error('Panel retry was refused.');
          await page.waitForFunction(() => !document.querySelector('.cl-teacher-requests button'));
          ${shot("retried-panel-plan")}
        `);
        await teacher.idle();
        if (chatRuns !== 2 || readTeacherState("rust")!.requests.some((r) => r.status !== "done"))
          throw new Error("Panel retry did not request a corrected plan.");
        if (
          store.listLearningRecords("rust").length ||
          store.latestGrades("rust", request.lesson).length !== 1
        )
          throw new Error("Panel retry wrote unverified evidence or graded twice.");
      }
      if (evidence)
        fs.writeFileSync(
          path.join(evidence, "result.json"),
          JSON.stringify(
            {
              host,
              runs,
              refillRuns,
              refills: refillRequests("rust"),
              review: currentReview("rust"),
              teacher: host === "service" ? readTeacherState("rust") : null,
              drafts: store.readDrafts("rust", request.lesson),
              passed: [
                "start",
                "reload",
                "failure",
                "explicit retry",
                "legacy pool absence without model work",
                "zero model turns for review creation",
                "durable document publication",
                "background refill failure leaves the quiz ready",
                "background explicit retry survives reload",
                "host ownership",
                "continue published review from another host",
                "automatic open",
                "resume draft",
                "mobile",
                "private files",
                "submit and grade",
                "schedule original item",
                ...(host === "service" ? ["regenerate rejected panel plan"] : []),
              ],
            },
            null,
            2,
          ),
        );
      console.log(
        `PASS: ${host} instant browser review, legacy skip, explicit publication retry, and continuation`,
      );
    } catch (err) {
      if (evidence)
        fs.writeFileSync(
          path.join(evidence, "failure.json"),
          JSON.stringify(
            {
              error: String(err),
              review: currentReview("rust"),
              teacher: readTeacherState("rust"),
            },
            null,
            2,
          ),
        );
      throw err;
    } finally {
      await teacher.stop();
      bridge.reset();
      if (browserOpen) await playwright(session, fixture.root, "close");
      await server.close();
      fixture.cleanup();
    }
  }
}
