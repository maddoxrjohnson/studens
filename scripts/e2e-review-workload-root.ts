/** Real browser/HTTP proof of per-classroom allowances (with an override) and immutable multi-classroom plans. */
import * as fs from "node:fs";
import * as path from "node:path";
import { DAY_MS } from "../src/review.ts";
import { rootWorkload } from "../src/review-workload.ts";
import { completePreparedReview, reviewSessions } from "../src/review-session.ts";
import { dailyReviews } from "../src/store/daily-review.ts";
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

export async function verifyRootWorkload(artifacts: string | null): Promise<void> {
  const fixture = makeFixture();
  const originalNow = Date.now;
  let now = Date.UTC(2026, 9, 19, 12);
  Date.now = () => now;
  // One card per classroom per day, except class-6, which an override raises to two.
  fs.writeFileSync(
    path.join(fixture.root, "test-config.json"),
    JSON.stringify({ dailyReviewLimit: 1, dailyReviewLimits: { "class-6": 2 } }),
  );
  const history: Record<string, string> = {};
  for (let c = 0; c < 7; c++) {
    const classroom = `class-${c}`;
    seedClassroom(fixture, { classroom, title: `Subject ${c}` });
    seedPreparedReviewSource(fixture.root, classroom, "001-ownership", "check-1", [
      "q1",
      "q2",
      "q3",
    ]);
    closeReviewVariants(fixture.root, classroom);
    writeGradedAttempt({
      classroom,
      at: Date.UTC(2026, 9, 1),
      answers: ["q1", "q2", "q3"].map((id) => termAnswer(id, "owner")),
      correct: { q1: true, q2: true, q3: true },
    });
    history[classroom] = JSON.stringify(store.listGrades(classroom, "001-ownership"));
  }
  server.setHooks({
    reviewOwner: "pi",
    delivery: "push",
    onReview: completePreparedReview,
    onReviewRetry: completePreparedReview,
    onAsk() {},
    onFollowUp() {},
    onReflect() {},
    onQuizSubmit() {
      throw new Error("Unexpected model turn for closed root workload.");
    },
  });
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  const session = `studens-root-workload-${process.pid}`;
  let opened = false;
  const code = (body: string) =>
    playwrightCode(session, fixture.root, `async page=>{${body};return true;}`);
  const shot = (name: string) =>
    artifacts
      ? `await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:${JSON.stringify(path.join(artifacts, `${name}.png`))},fullPage:true});`
      : "";
  try {
    const base = await server.start(0);
    const post = async (route: string, body: unknown) => {
      const r = await fetch(`${base}/api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    await playwright(session, fixture.root, "open", base);
    opened = true;
    await code(
      `await page.getByRole('button',{name:'Start daily review',exact:true}).waitFor();await page.setViewportSize({width:1440,height:1000});${shot("landing-desktop")}await page.setViewportSize({width:375,height:812});${shot("landing-mobile")}await page.getByRole('button',{name:'Start daily review',exact:true}).click();await page.getByRole('button',{name:'Continue Subject 0 review',exact:true}).waitFor();${shot("seven-groups-mobile")}`,
    );
    const first = dailyReviews()[0];
    // No classroom starves another: all seven get their own share, and the override is honored.
    if (
      first.groups.length !== 7 ||
      first.groups.some((g) => g.plan.items.length !== (g.classroom === "class-6" ? 2 : 1))
    )
      throw new Error("Daily batch did not give each classroom its own allowance and override.");
    const saved = JSON.stringify(dailyReviews());
    const [repeat, individual] = await Promise.all([
      post("daily-review", { id: crypto.randomUUID() }),
      post("review", { id: crypto.randomUUID(), classroom: "class-6", size: 12, early: true }),
    ]);
    if (
      repeat.body.daily.id !== first.id ||
      individual.status !== 409 ||
      !individual.body.error.includes("reserved for this classroom")
    )
      throw new Error("Alternate concurrent start bypassed reservation.");
    now += DAY_MS;
    await code(
      `await page.reload();await page.getByRole('button',{name:'Continue Subject 0 review',exact:true}).waitFor();`,
    );
    if (JSON.stringify(dailyReviews()) !== saved || rootWorkload(now).remaining !== 0)
      throw new Error("Midnight/reload replaced unfinished plans or reset reservations.");
    await code(
      `await page.goto(${JSON.stringify(`${base}/c/class-6`)});await page.locator('[data-cl-review-early]').check();await page.getByRole('button',{name:'Start review',exact:true}).click();await page.getByText("Today's review allowance is reserved for this classroom (2/2)",{exact:false}).waitFor();${shot("alternate-cap-mobile")}`,
    );
    for (const [i, g] of first.groups.entries()) {
      const n = g.plan.items.length;
      await code(
        `await page.goto(${JSON.stringify(`${base}/reviews/daily/${first.id}`)});await page.getByRole('button',{name:${JSON.stringify(`${i === 0 ? "Continue" : "Start"} Subject ${i} review`)},exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='fresh');for(let k=0;k<${n};k++){await page.locator('form.cl-quiz:visible input[value="owner"]').check();await page.locator('form.cl-quiz:visible [data-cl-assistance]').selectOption('none');await page.locator('form.cl-quiz:visible button[type="submit"]').click();if(k<${n - 1}){await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='graded');await page.getByRole('button',{name:'Next question',exact:true}).click();}}await page.getByText('Review complete · ${n} of ${n} answered',{exact:true}).waitFor();`,
      );
      if (store.listGrades(g.classroom, g.plan.lesson).length !== n)
        throw new Error("A root card lost its grade.");
    }
    // Finishing carried work frees its old reservations, but earns no credit or carry-over.
    const settled = rootWorkload(now);
    if (settled.allowance !== 8 || settled.used !== 0 || settled.remaining !== 8)
      throw new Error("Same-day completions silently changed the flat per-classroom allowances.");
    const explicit = await post("review", {
      id: crypto.randomUUID(),
      classroom: "class-6",
      size: 12,
      early: true,
    });
    if (explicit.status !== 202 || explicit.body.review.count !== 2)
      throw new Error("Explicit classroom did not spend exactly its own overridden allowance.");
    const next = await post("daily-review", { id: crypto.randomUUID() });
    const nextSaved = dailyReviews().find((r) => r.id === next.body.daily.id)!;
    const newlyPlanned = nextSaved.groups
      .filter((g) => g.classroom !== "class-6")
      .reduce((n, g) => n + g.plan.items.length, 0);
    // Spending all of class-6 blocks only class-6: the other six still get their daily card.
    if (newlyPlanned !== 6 || rootWorkload(now).used !== 8 || rootWorkload(now).remaining !== 0)
      throw new Error("One classroom's spent allowance blocked or inflated another classroom.");
    const beforeRestart = JSON.stringify(dailyReviews());
    await server.close();
    const restarted = await server.start(0);
    await code(
      `await page.goto(${JSON.stringify(restarted)});await page.getByRole('button',{name:'Continue daily review',exact:true}).waitFor();await page.setViewportSize({width:1440,height:1000});${shot("spent-desktop")}await page.setViewportSize({width:375,height:812});${shot("spent-mobile")}`,
    );
    if (JSON.stringify(dailyReviews()) !== beforeRestart)
      throw new Error("Restart replaced saved plans.");
    for (let c = 0; c < 7; c++)
      if (JSON.stringify(store.listGrades(`class-${c}`, "001-ownership")) !== history[`class-${c}`])
        throw new Error("Root cap rewrote original assessments.");
    if ((await fetch(`${restarted}/.daily-reviews.json`)).status !== 404)
      throw new Error("Private root reservations leaked.");
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "result.json"),
        JSON.stringify(
          {
            first,
            repeat,
            individual,
            next: nextSaved,
            root: rootWorkload(now),
            originalHistoryUnchanged: true,
            midnightPreserved: true,
            concurrentStartsBounded: true,
            individualAllowances: { default: 1, "class-6": 2 },
            restartPreserved: true,
            grades: first.groups.map((g) => ({
              classroom: g.classroom,
              count: store.listGrades(g.classroom, g.plan.lesson).length,
            })),
            reviews: Array.from({ length: 7 }, (_, i) => ({
              classroom: `class-${i}`,
              sessions: reviewSessions(`class-${i}`).length,
            })),
          },
          null,
          2,
        ),
      );
    console.log(
      "PASS: seven classrooms with own allowances and an override, daily/classroom/early concurrency, midnight/reload, eight real closed cards, no carry-over, one spent classroom never blocks another, restart and private state",
    );
  } catch (error) {
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "failure.json"),
        JSON.stringify({ error: String(error), daily: dailyReviews() }, null, 2),
      );
    if (opened) await code(shot("failure")).catch((e) => console.error(e));
    throw error;
  } finally {
    if (opened) await playwright(session, fixture.root, "close");
    await server.close();
    Date.now = originalNow;
    fixture.cleanup();
  }
}
