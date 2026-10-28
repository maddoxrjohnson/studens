import { verifyRootWorkload } from "./e2e-review-workload-root.ts";
/** Observe workload slots and unchanged overdue history through classroom controls. */
import * as fs from "node:fs";
import * as path from "node:path";
import { DAY_MS, summarize } from "../src/review.ts";
import { classroomWorkload } from "../src/review-workload.ts";
import { completePreparedReview, currentReview, reviewSessions } from "../src/review-session.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import {
  makeFixture,
  seedClassroom,
  seedPreparedReviewSource,
  closeReviewVariants,
  termAnswer,
  writeGradedAttempt,
} from "../test/helpers.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyReviewWorkload(artifacts: string | null): Promise<void> {
  const fixture = makeFixture();
  seedClassroom(fixture);
  const ids = Array.from({ length: 20 }, (_, i) => `q${i + 1}`);
  seedPreparedReviewSource(fixture.root, "rust", "001-ownership", "check-1", ids);
  closeReviewVariants(fixture.root);
  writeGradedAttempt({
    at: Date.UTC(2026, 9, 1),
    answers: ids.map((id) => termAnswer(id, "owner")),
    correct: Object.fromEntries(ids.map((id) => [id, true])),
  });
  const original = JSON.stringify(store.listGrades("rust", "001-ownership"));
  const originalDates = store.reviewItems("rust").map((i) => ({ key: i.key, dueAt: i.dueAt }));
  let teacherTurns = 0;
  server.setHooks({
    reviewOwner: "pi",
    delivery: "push",
    onReview: completePreparedReview,
    onReviewRetry: completePreparedReview,
    onAsk() {},
    onFollowUp() {},
    onReflect() {},
    onQuizSubmit() {
      teacherTurns++;
      throw new Error("Unexpected closed workload grading turn.");
    },
  });
  const session = `studens-workload-${process.pid}`;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  const code = (body: string) =>
    playwrightCode(session, fixture.root, `async page=>{${body};return true;}`);
  const shot = (name: string) =>
    artifacts
      ? `await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:${JSON.stringify(path.join(artifacts, `${name}.png`))},fullPage:true});`
      : "";
  let opened = false;
  try {
    const base = await server.start(0);
    await playwright(session, fixture.root, "open", `${base}/c/rust`);
    opened = true;
    await code(
      `await page.getByRole('button',{name:'Start review',exact:true}).waitFor();await page.setViewportSize({width:1440,height:1000});${shot("desktop")}await page.setViewportSize({width:375,height:812});${shot("mobile")}if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Workload text overflows mobile.');`,
    );
    const before = classroomWorkload("rust", store.reviewItems("rust"), Date.now());
    if (
      before.eligible !== 5 ||
      before.deferred !== 15 ||
      summarize(store.reviewItems("rust"), Date.now()).due !== 20
    )
      throw new Error("Absent-day workload/count mismatch.");
    await code(
      `await page.locator('[data-cl-review-size]').selectOption('3');await page.getByRole('button',{name:'Start review',exact:true}).click();await page.getByText('Question 1 of 3 · 0 answered',{exact:true}).waitFor();`,
    );
    const first = currentReview("rust")!;
    const repeated = await fetch(`${base}/api/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classroom: "rust", id: crypto.randomUUID(), size: 12 }),
    });
    if ((await repeated.json()).review.id !== first.id)
      throw new Error("Concurrent start replaced saved selection.");
    const answer = async (count: number) => {
      for (let i = 0; i < count; i++)
        await code(
          `await page.locator('form.cl-quiz:visible input[value="owner"]').check();await page.locator('form.cl-quiz:visible [data-cl-assistance]').selectOption('none');await page.locator('form.cl-quiz:visible button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='graded');${i < count - 1 ? "await page.getByRole('button',{name:'Next question',exact:true}).click();" : ""}`,
        );
      await code(
        `await page.getByText('Review complete · ${count} of ${count} answered',{exact:true}).waitFor();`,
      );
    };
    await answer(3);
    await code(
      `await page.goto(${JSON.stringify(`${base}/c/rust`)});await page.locator('[data-cl-review-size]').selectOption('12');await page.locator('[data-cl-review-early]').check();await page.getByRole('button',{name:'Start review',exact:true}).click();await page.getByText('Question 1 of 2 · 0 answered',{exact:true}).waitFor();${shot("remaining-two")}`,
    );
    const second = currentReview("rust")!;
    if (second.items.some((i) => first.items.some((s) => s.key === i.key)))
      throw new Error("Completed card selected twice in one workload day.");
    await answer(2);
    await code(
      `await page.goto(${JSON.stringify(`${base}/c/rust`)});await page.getByRole('button',{name:'Start review',exact:true}).click();await page.getByText("Today's shared review allowance is reserved",{exact:false}).waitFor();${shot("cap-error-mobile")}await page.reload();await page.getByRole('button',{name:'Start review',exact:true}).waitFor();await page.getByRole('button',{name:'Start review',exact:true}).click();await page.getByText("Today's shared review allowance is reserved",{exact:false}).waitFor();await page.setViewportSize({width:1440,height:1000});${shot("cap-error-desktop")}await page.getByText('Manage review items',{exact:true}).click();${shot("due-reasons")} `,
    );
    const work = classroomWorkload("rust", store.reviewItems("rust"), Date.now());
    if (
      work.used !== 5 ||
      work.remaining !== 0 ||
      work.deferred !== 15 ||
      reviewSessions("rust").length !== 2 ||
      teacherTurns !== 0
    )
      throw new Error("Cap/reload changed selection or woke a teacher.");
    if (JSON.stringify(store.listGrades("rust", "001-ownership")) !== original)
      throw new Error("Workload policy mutated original grades.");
    // Matches upstream 0.12.1: a correct delayed answer extends only the selected items.
    const selectedKeys = new Set([...first.items, ...second.items].map((item) => item.key));
    const scheduled = store.reviewItems("rust");
    if (selectedKeys.size !== 5 || scheduled.length !== 20)
      throw new Error("Workload selection lost unique keys.");
    for (const item of scheduled) {
      const originalDue = originalDates.find((date) => date.key === item.key)!.dueAt;
      if (selectedKeys.has(item.key)) {
        if (item.dueAt <= Date.now() || item.dueAt <= originalDue || item.gapOpen)
          throw new Error(`Correct delayed answer did not extend ${item.key}.`);
        if (
          item.context !== "unknown" ||
          item.objective !== undefined ||
          item.delayedSuccesses !== 0
        )
          throw new Error("Historical workload answer invented independent-task evidence.");
      } else if (item.dueAt !== originalDue) {
        throw new Error(`Workload postponed unselected item ${item.key}.`);
      }
    }
    const counts = reviewSessions("rust").map((r) => store.listGrades("rust", r.lesson).length);
    await server.close();
    const restarted = await server.start(0);
    if (JSON.stringify(store.reviewItems("rust")) !== JSON.stringify(scheduled))
      throw new Error("Restart changed completed or deferred schedules.");
    if (
      JSON.stringify(counts) !==
      JSON.stringify(reviewSessions("rust").map((r) => store.listGrades("rust", r.lesson).length))
    )
      throw new Error("Restart graded twice.");
    if ((await fetch(`${restarted}/.daily-reviews.lock`)).status !== 404)
      throw new Error("Private workload lock leaked.");
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "result.json"),
        JSON.stringify(
          {
            before,
            after: work,
            first,
            second,
            counts,
            teacherTurns,
            originalDates,
            summary: summarize(store.reviewItems("rust"), Date.now()),
            privateLockDenied: true,
            restartPreserved: true,
            minimumDelayMs: DAY_MS,
          },
          null,
          2,
        ),
      );
    console.log(
      "PASS: workload 20 overdue -> 5 available / 15 deferred; 3+2 unique closed cards, explicit cap error/reload, unchanged due history and restart",
    );
  } catch (error) {
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "failure.json"),
        JSON.stringify({ error: String(error), reviews: reviewSessions("rust") }, null, 2),
      );
    if (opened) await code(shot("failure")).catch((e) => console.error("Failure screenshot:", e));
    throw error;
  } finally {
    if (opened) await playwright(session, fixture.root, "close");
    await server.close();
    fixture.cleanup();
  }
  await verifyRootWorkload(artifacts ? path.join(artifacts, "root") : null);
}
