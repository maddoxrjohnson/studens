import { teacherFailureRetryActions } from "./review-card-actions.ts";
/** Drive learner review controls through the real browser, HTTP routes and durable host queues. */
import * as fs from "node:fs";
import * as path from "node:path";
import { ClassroomBridge } from "../src/bridge.ts";
import { lessonUrl } from "../src/paths.ts";
import { completePreparedReview, currentReview, reviewSessions } from "../src/review-session.ts";
import { DAY_MS, reviewTopic, summarize } from "../src/review.ts";
import { piResumes } from "../src/teacher-resume.ts";
import { readTeacherState } from "../src/service-state.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { TeacherService } from "../src/teacher-service.ts";
import {
  closeReviewVariants,
  makeFixture,
  seedClassroom,
  seedPreparedReviewSource,
  termAnswer,
  writeGradedAttempt,
} from "../test/helpers.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyReviewControls(artifacts: string | null): Promise<void> {
  for (const host of ["pi", "service"] as const) {
    const fixture = makeFixture();
    seedClassroom(fixture);
    const seed = (classroom: string, lesson: string, count: number, at: number) => {
      const ids = Array.from({ length: count }, (_, i) => `q${i + 1}`);
      seedPreparedReviewSource(fixture.root, classroom, lesson, "check-1", ids);
      closeReviewVariants(fixture.root, classroom, lesson);
      const keyFile = path.join(fixture.root, classroom, lesson, "quiz/key.json");
      const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
      for (const question of Object.values(key["check-1"]) as Array<{
        variants: Array<{ rubric: { criteria?: unknown[] } }>;
      }>)
        for (const variant of question.variants)
          variant.rubric.criteria = [
            { id: "owner", description: "Identify the current owner", points: 1 },
          ];
      fs.writeFileSync(keyFile, JSON.stringify(key));
      writeGradedAttempt({
        classroom,
        lesson,
        at,
        answers: ids.map((id, index) =>
          termAnswer(
            id,
            "owner",
            lesson === "002-upcoming"
              ? {
                  learning: {
                    objectiveId: id,
                    objective: {
                      statement: "Explain ownership.",
                      application: false,
                      interleaveGroup: index < 2 ? "Ownership rules" : "Other rules",
                      strategy: `Strategy ${index + 1}`,
                    },
                    task: "retrieval",
                    support: "independent",
                    assistance: "none",
                  },
                }
              : {},
          ),
        ),
        correct: Object.fromEntries(ids.map((id) => [id, true])),
      });
    };
    seed("rust", "001-ownership", 3, Date.now() - 2 * DAY_MS);
    seedClassroom(fixture, { classroom: "other", title: "Other" });
    seed("other", "001-ownership", 1, Date.now() - 2 * DAY_MS);
    const unrelated = JSON.stringify(store.reviewItems("other"));
    const beforeEvents = store.reviewEvents("rust");
    const originalGrades = store.listGrades("rust", "001-ownership");
    let reports = 0;
    const prompts: string[] = [];
    const bridge = new ClassroomBridge({
      sendUserMessage: (prompt) => {
        prompts.push(prompt);
        reports++;
        queueMicrotask(() =>
          bridge.onAgentEnd(
            reports === 1
              ? []
              : [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: "I received your bad-question report and will review the wording.",
                      },
                    ],
                  },
                ],
          ),
        );
      },
    });
    const modelAttempts: Array<{ model: string | null | undefined; session: string | undefined }> =
      [];
    const teacher = new TeacherService(
      async (identity, prompt, _cwd, save, _signal, _contract, _raw, active) => {
        modelAttempts.push({ model: identity.requestedModel, session: identity.sessionId });
        save("review-report-conversation");
        prompts.push(prompt);
        reports++;
        if (reports === 1) throw new Error("Fixture report teacher unavailable.");
        active?.(identity.requestedModel ?? "fixture-default");
        return {
          calls: [],
          message: "I received your bad-question report and will review the wording.",
          learning_record: "",
          notes_markdown: "",
        };
      },
    );
    if (host === "service") {
      teacher.attach("rust", "codex");
      teacher.setModel("rust", "report-before", 0);
    }
    server.setHooks({
      reviewOwner: host,
      delivery: host === "pi" ? "push" : "service",
      onReview: completePreparedReview,
      onReviewRetry: completePreparedReview,
      onAsk() {
        throw new Error("Unexpected annotation");
      },
      onFollowUp() {},
      onReflect() {},
      onQuizSubmit() {
        throw new Error("Closed controls called teacher grading");
      },
      teacherSettings: host === "service" ? (classroom) => teacher.settings(classroom) : undefined,
      setTeacherModel:
        host === "service"
          ? (classroom, model, revision) => teacher.setModel(classroom, model, revision)
          : undefined,
      teacherState: (classroom, lesson) =>
        host === "pi"
          ? bridge.panelState(classroom, lesson)
          : teacher.publicState(classroom, lesson),
      onTeacherChat: (classroom, lesson, text, id) =>
        host === "pi"
          ? bridge.chat(classroom, lesson, text, id)
          : teacher.chat(classroom, lesson, text, id),
      onTeacherRetry: (classroom, id) =>
        host === "pi" ? bridge.retry(classroom, id) : teacher.retry(classroom, id),
    });
    const evidence = artifacts ? path.join(artifacts, host) : null;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    const browser = `studens-review-controls-${host}-${process.pid}`;
    const code = (body: string) =>
      playwrightCode(browser, fixture.root, `async page=>{${body};return true;}`);
    const shot = (name: string) =>
      evidence
        ? `await page.screenshot({path:${JSON.stringify(path.join(evidence, `${name}.png`))},fullPage:true});`
        : "";
    let opened = false;
    try {
      const base = await server.start(0);
      const post = (route: string, body: unknown) =>
        fetch(`${base}/api/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      await playwright(browser, fixture.root, "open", base);
      opened = true;
      await code(`
        await page.getByRole('main').locator('a[href="/c/rust"]').click();
        await page.evaluate(()=>sessionStorage.setItem('pi-classroom-review:rust:options','{invalid'));
        await page.reload();
        await page.getByText('Cannot read saved review options:',{exact:false}).waitFor();
        await page.getByRole('button',{name:'Reset review options',exact:true}).click();
        await page.getByRole('button',{name:'Start review',exact:true}).waitFor();
        await page.locator('[data-cl-review-size]').selectOption('3');
        await page.reload();
        if(await page.locator('[data-cl-review-size]').inputValue()!=='3')throw new Error('Size preference lost on reload.');
        await page.route('**/api/review',async route=>{const body=route.request().postDataJSON();await route.continue({postData:JSON.stringify({...body,size:13})});});
        await page.getByRole('button',{name:'Start review',exact:true}).click();
        await page.getByText('Review size must be a whole number from 3 to 12.',{exact:true}).waitFor();
        ${shot("invalid-size")}
        await page.unroute('**/api/review');
        await page.getByRole('button',{name:'Check review status',exact:true}).click();
        await page.getByRole('button',{name:'Start review',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='fresh');
        await page.getByText('Question 1 of 3 · 0 answered',{exact:true}).waitFor();
        await page.route('**/api/review/items?*',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Fixture item state unavailable.'})}));
        await page.reload();
        await page.getByText('Fixture item state unavailable.',{exact:true}).waitFor();
        await page.unroute('**/api/review/items?*');
        await page.getByRole('button',{name:'Retry item state',exact:true}).click();
        await page.getByRole('button',{name:'Retire item',exact:true}).waitFor();
        await page.getByRole('button',{name:'Flag bad question',exact:true}).click();
        await page.getByRole('button',{name:'Flag bad question',exact:true}).click();
        await page.getByText('Send or clear your existing teacher reply before flagging a question.',{exact:true}).waitFor();
        const reply=page.getByRole('textbox',{name:'Reply to your teacher',exact:true});
        if(!(await reply.inputValue()).includes('001-ownership/check-1/q1'))throw new Error('Report omitted original item identity.');
        await reply.fill((await reply.inputValue())+'The wording is ambiguous about the old binding.');
        await page.waitForFunction(()=>document.querySelector('.cl-teacher-error')?.textContent==='');
        await page.reload();
        await page.waitForFunction(()=>document.querySelector('#cl-teacher textarea')?.value.includes('Bad question report'));
        await page.getByRole('button',{name:'Send reply',exact:true}).click();
        await page.getByText('Teacher failed:',{exact:false}).waitFor();
        ${shot("report-failed")}
        await page.reload();
        await page.getByRole('button',{name:'Retry request',exact:true}).waitFor();
      `);
      if (reports !== 1) throw new Error("Reload retried a failed report.");
      const failedReport =
        host === "service" ? structuredClone(readTeacherState("rust")!.requests[0]) : null;
      if (host === "service") {
        if (failedReport!.requestedModel !== "report-before" || failedReport!.status !== "failed")
          throw new Error("Report did not retain the selected model on failure.");
        await code(`
          const reviewUrl=page.url();
          await page.route('**/api/settings/models?*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({models:[{id:'report-before',label:'Before report'},{id:'report-after',label:'After report'}],configuredModel:'fixture-default'})}));
          await page.goto(${JSON.stringify(`${base}/c/rust/settings`)});
          await page.getByLabel('Teacher model',{exact:true}).selectOption('report-after');
          await page.getByRole('button',{name:'Save teacher model',exact:true}).click();
          await page.getByRole('status').filter({hasText:'Saved for the next'}).waitFor();
          await page.reload();
          if(await page.getByLabel('Teacher model',{exact:true}).inputValue()!=='report-after')throw new Error('Report model setting lost on reload.');
          await page.goto(reviewUrl);
          await page.getByRole('button',{name:'Retry request',exact:true}).waitFor();
        `);
        if (
          reports !== 1 ||
          readTeacherState("rust")!.requests[0].requestedModel !== "report-before"
        )
          throw new Error("Changing model retried or rewrote the failed report snapshot.");
      }
      await code(
        `${teacherFailureRetryActions(evidence ? path.join(evidence, "report-before-explicit-retry.png") : null)}await page.getByText('I received your bad-question report and will review the wording.',{exact:true}).waitFor();await page.reload();await page.getByText('I received your bad-question report and will review the wording.',{exact:true}).waitFor();${shot("report-received")}`,
      );
      const review = currentReview("rust")!;
      const durable = host === "pi" ? piResumes("rust") : readTeacherState("rust")!.requests;
      if (
        durable.filter((request) => request.id.startsWith("chat:")).length !== 1 ||
        Number(reports) !== 2 ||
        !prompts.every(
          (prompt) =>
            prompt.includes("Bad question report") && prompt.includes(review.items[0].key),
        )
      )
        throw new Error("Report lost its owner, identity, or request deduplication.");
      if (host === "service") {
        const state = readTeacherState("rust")!;
        if (
          JSON.stringify(modelAttempts) !==
            JSON.stringify([
              { model: "report-before" },
              { model: "report-after", session: "review-report-conversation" },
            ]) ||
          state.requests[0].requestedModel !== "report-after" ||
          state.requests[0].resolvedModel !== "report-after" ||
          state.identity.sessionId !== "review-report-conversation" ||
          state.identity.requestedModel !== "report-after"
        )
          throw new Error(
            "Explicit report retry lost its model snapshot or persistent conversation.",
          );
      }
      const repeated = await post("review", {
        classroom: "rust",
        id: crypto.randomUUID(),
        size: 12,
      });
      if ((await repeated.json()).review.id !== review.id || reviewSessions("rust").length !== 1)
        throw new Error("Repeated start created another session.");
      const editLock = path.join(fixture.root, "rust/.review-controls.json.lock");
      fs.writeFileSync(editLock, "fixture competing edit");
      await code(`
        await page.getByRole('button',{name:'Retire item',exact:true}).click();
        await page.getByText('Another server has locked review item edits.',{exact:false}).waitFor();
        ${shot("retire-failed")}
      `);
      fs.unlinkSync(editLock);
      await code(`
        await page.getByRole('button',{name:'Retry item action',exact:true}).click();
        await page.getByRole('button',{name:'Restore item',exact:true}).waitFor();
        await page.reload();
        await page.getByRole('button',{name:'Restore item',exact:true}).waitFor();
        await page.setViewportSize({width:375,height:812});
        if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Controls overflow mobile.');
        ${shot("retired-mobile")}
      `);
      if (
        summarize(store.reviewItems("rust"), Date.now()).total !== 2 ||
        JSON.stringify(store.reviewEvents("rust")) !== JSON.stringify(beforeEvents)
      )
        throw new Error("Retirement hid or rewrote historical evidence.");
      const retired = store.reviewItems("rust").find((item) => item.retiredAt)!;
      await code(`
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByText('Manage review items',{exact:true}).click();
        await page.getByText('Retired · 1 saved exposures',{exact:true}).waitFor();
        await page.getByRole('button',{name:'Restore item',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('[data-review-item]')?.dataset.retired==='false');
      `);
      const controlsFile = path.join(fixture.root, "rust/.review-controls.json");
      const savedControls = fs.readFileSync(controlsFile, "utf8");
      fs.writeFileSync(controlsFile, "{invalid");
      await code(
        `await page.goto(${JSON.stringify(`${base}/c/rust`)});await page.getByRole('heading',{name:'Cannot load review state',exact:true}).waitFor();await page.getByRole('main').getByText('Cannot read review controls:',{exact:false}).waitFor();${shot("controls-corrupt")}`,
      );
      fs.writeFileSync(controlsFile, savedControls);
      await code(
        `await page.getByRole('link',{name:'Retry loading review state',exact:true}).click();await page.getByRole('button',{name:'Continue review',exact:true}).waitFor();`,
      );
      const stale = await post("review/item", {
        classroom: "rust",
        key: retired.key,
        retired: true,
        revision: 0,
      });
      if (stale.status !== 409 || !(await stale.text()).includes("another tab"))
        throw new Error("Stale retirement did not name its conflict.");
      await code(`
        await page.getByRole('button',{name:'Continue review',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='fresh');
        for(let i=0;i<3;i++){
          await page.locator('form.cl-quiz:visible input[value="owner"]').check();
          await page.locator('form.cl-quiz:visible button[type="submit"]').click();
          await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='graded');
          if(i<2)await page.getByRole('button',{name:'Next question',exact:true}).click();
        }
        await page.getByText('Review complete · 3 of 3 answered',{exact:true}).waitFor();
        await page.getByRole('link',{name:'Review history',exact:true}).click();
        await page.getByText('3/3 answered',{exact:true}).waitFor();
        ${shot("history")}
      `);
      // Saved groups select related objectives without changing the other topic.
      seed("rust", "002-upcoming", 3, Date.now() - 3600000);
      const earlyItem = store.reviewItems("rust").find((item) => item.lesson === "002-upcoming")!;
      const earlyTopic = reviewTopic(earlyItem).id;
      const unrelatedTopicsBefore = store
        .reviewItems("rust")
        .filter((item) => reviewTopic(item).id !== earlyTopic);
      await code(`
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.locator('[data-cl-review-topic]').selectOption(${JSON.stringify(earlyTopic)});
        await page.locator('[data-cl-review-early]').check();
        await page.reload();
        if(await page.locator('[data-cl-review-topic]').inputValue()!==${JSON.stringify(earlyTopic)}||!await page.locator('[data-cl-review-early]').isChecked())throw new Error('Topic/early preference lost.');
        await page.getByRole('button',{name:'Start review',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='fresh');
        await page.locator('form.cl-quiz:visible input[value="old"]').check();
        await page.locator('form.cl-quiz:visible [data-cl-assistance]').selectOption('hint');
        await page.locator('form.cl-quiz:visible button[type="submit"]').click();
        await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='graded');
        await page.getByRole('button',{name:'Next question',exact:true}).click();
        await page.locator('form.cl-quiz:visible input[value="owner"]').check();
        await page.locator('form.cl-quiz:visible button[type="submit"]').click();
        await page.getByText('Review complete · 2 of 2 answered',{exact:true}).waitFor();
        await page.reload();
        ${shot("early-review")}
      `);
      if (
        JSON.stringify(
          store.reviewItems("rust").filter((item) => reviewTopic(item).id !== earlyTopic),
        ) !== JSON.stringify(unrelatedTopicsBefore)
      )
        throw new Error("Scoped early review changed an unrelated item.");
      const earlyReview = currentReview("rust")!;
      const earlyAfter = store.reviewItems("rust").find((item) => item.key === earlyItem.key)!;
      const earlySubmission = store.listSubmissions("rust", earlyReview.lesson)[0];
      const earlyGrade = store.listGrades("rust", earlyReview.lesson)[0];
      if (
        !earlySubmission.earlyReviewKeys?.includes(earlyItem.key) ||
        earlySubmission.rubricCriteria?.r1?.[0].id !== "owner" ||
        earlyGrade.questions[0].criteria?.[0].pointsEarned !== 0
      )
        throw new Error("Early review lost its private criterion or timing snapshot.");
      const publicState = await (
        await fetch(`${base}/api/state?classroom=rust&lesson=${earlyReview.lesson}`)
      ).text();
      if (
        /rubricCriteria|earlyReviewKeys|teachingPlan|deterministicGrades|"learning":/.test(
          publicState,
        )
      )
        throw new Error("Combined private review snapshots leaked through learner state.");
      if (
        earlyReview.items.length !== 2 ||
        earlyReview.items[0].key !== earlyItem.key ||
        earlyAfter.dueAt !== earlyItem.dueAt ||
        earlyAfter.progress === "retained-evidence"
      )
        throw new Error("Early/topic review changed its due date or invented retention.");
      seedClassroom(fixture, { classroom: "many", title: "Many" });
      // Rust has used 5 cards today (3 + 2). Each classroom has its own flat daily allowance.
      fs.writeFileSync(
        path.join(fixture.root, "test-config.json"),
        JSON.stringify({ dailyReviewLimit: 5, dailyReviewLimits: { many: 7 } }),
      );
      seed("many", "001-ownership", 14, Date.now() - 2 * DAY_MS);
      for (let i = 0; i < 3; i++)
        writeGradedAttempt({
          classroom: "many",
          at: Date.now() - (1.9 - i / 10) * DAY_MS,
          answers: [termAnswer("q2", "old")],
          correct: { q2: false },
        });
      await code(`
        await page.goto(${JSON.stringify(base)});
        await page.getByRole('main').locator('a[href="/c/many"]').click();
        await page.getByText('Manage review items',{exact:true}).click();
        await page.locator('[data-review-item="001-ownership/check-1/q1"] [data-review-retire]').click();
        await page.locator('[data-review-item="001-ownership/check-1/q1"][data-retired="true"]').waitFor({state:'attached'});
        await page.reload();
        await page.locator('[data-cl-review-early]').check();
        await page.locator('[data-cl-review-size]').selectOption('12');
        await page.getByRole('button',{name:'Start review',exact:true}).click();
        await page.getByText('Question 1 of 7 · 0 answered',{exact:true}).waitFor();
        ${shot("maximum-size")}
      `);
      // Allowances are per classroom: rust has spent its whole day, yet "many" starts in full,
      // limited only by its own override (7), not the shared setting (5) or rust's spending.
      if (currentReview("many")?.items.length !== 7)
        throw new Error("Another classroom was blocked by rust, or ignored its own override.");
      await code(`
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByRole('button',{name:'Start review',exact:true}).click();
        await page.getByText("Today's review allowance is reserved for this classroom (5/5)",{exact:false}).waitFor();
        ${shot("classroom-allowance-spent")}
      `);
      if (currentReview("rust")?.id !== earlyReview.id || reviewSessions("rust").length !== 2)
        throw new Error("A spent classroom allowance still created a review.");
      if (
        JSON.stringify(store.reviewItems("other")) !== unrelated ||
        JSON.stringify(store.listGrades("rust", "001-ownership")) !== JSON.stringify(originalGrades)
      )
        throw new Error("Unrelated classroom or original grades changed.");
      for (const route of [
        "/c/rust/.review-controls.json",
        "/c/rust/.reviews.json",
        "/c/rust/.teacher.json",
        "/c/rust/.pi-teacher-resumes.json",
        "/c/rust/001-ownership/quiz/key.json",
        `${lessonUrl("rust", review.lesson)}/quiz/plan.json`,
      ])
        if ((await fetch(base + route)).status !== 404)
          throw new Error(`Private state leaked: ${route}`);
      const gradesBefore = store.listGrades("rust", review.lesson);
      await server.close();
      await server.start(0);
      if (host === "service") {
        const restored = readTeacherState("rust")!;
        if (
          restored.identity.requestedModel !== "report-after" ||
          restored.identity.sessionId !== "review-report-conversation" ||
          restored.requests.filter((request) => request.kind === "chat").length !== 1 ||
          restored.requests[0].requestedModel !== "report-after" ||
          restored.requests[0].resolvedModel !== "report-after" ||
          restored.requests[0].status !== "done"
        )
          throw new Error("Server restart lost the durable report or its model metadata.");
      }
      if (
        store.listGrades("rust", review.lesson).length !== gradesBefore.length ||
        Number(reports) !== 2 ||
        store.listGrades("rust", earlyReview.lesson).length !== 2
      )
        throw new Error("Recovery repeated grading or report delivery.");
      if (evidence)
        fs.writeFileSync(
          path.join(evidence, "result.json"),
          JSON.stringify(
            {
              host,
              review,
              earlyReview,
              earlyBefore: earlyItem,
              earlyAfter,
              earlySubmission,
              earlyGrade,
              durable,
              prompts,
              reports,
              failedReport,
              modelAttempts,
              gradesBefore,
              originalGrades,
              unrelatedUnchanged: true,
              privateRoutesDenied: true,
            },
            null,
            2,
          ),
        );
      console.log(
        `PASS: ${host} size 3..12, topic/classroom scope, early interval, retirement/history, per-classroom allowance and override, report receipt/retry, stale actions and recovery`,
      );
    } catch (error) {
      if (evidence) {
        fs.writeFileSync(
          path.join(evidence, "failure.json"),
          JSON.stringify(
            { error: String(error), reports, prompts, review: currentReview("rust") },
            null,
            2,
          ),
        );
        if (opened)
          await code(shot("failure")).catch((captureError) =>
            console.error("Failure screenshot:", captureError),
          );
      }
      throw error;
    } finally {
      if (opened) await playwright(browser, fixture.root, "close");
      bridge.reset();
      await teacher.stop();
      await server.close();
      fixture.cleanup();
    }
  }
}
