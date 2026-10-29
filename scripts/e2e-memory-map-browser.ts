/** Read production replay through the real classroom UI; fixture owners never infer. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  makeFixture,
  seedClassroom,
  seedPreparedReviewSource,
  closeReviewVariants,
  termAnswer,
  writeGradedAttempt,
} from "../test/helpers.ts";
import { NOW, seedMemory } from "../test/memory-map-fixture.ts";
import { memoryForecast } from "../src/memory-map.ts";
import { DAY_MS, reviewTopic } from "../src/review.ts";
import { classroomWorkload } from "../src/review-workload.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { readTeacherState } from "../src/service-state.ts";
import { completePreparedReview, currentReview } from "../src/review-session.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { playwright, playwrightCode } from "./playwright.ts";

function hashes(root: string) {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const file = path.join(e.parentPath, e.name);
        return [
          path.relative(root, file),
          createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        ];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
export async function verifyMemoryMapBrowser(artifacts: string | null): Promise<void> {
  const out = artifacts ?? fs.mkdtempSync(path.join(os.tmpdir(), "studens-memory-map-"));
  fs.mkdirSync(out, { recursive: true });
  for (const backend of ["pi", "claude", "codex"] as const) {
    const f = makeFixture(),
      session = `studens-memory-${backend}-${process.pid}`,
      dir = path.join(out, backend);
    fs.mkdirSync(dir, { recursive: true });
    const realNow = Date.now;
    Date.now = () => NOW;
    let opened = false,
      teacherTurns = 0;
    const save = (name: string, data: unknown) =>
      fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(data, null, 2));
    const code = <T>(body: string) => playwrightCode<T>(session, dir, `async page=>{${body}}`);
    try {
      seedClassroom(f);
      const teacher = new TeacherService(async () => {
        teacherTurns++;
        throw Error("Memory map must not wake a teacher.");
      });
      teacher.attach("rust", backend);
      const items = seedMemory(f);
      closeReviewVariants(f.root);
      seedClassroom(f, { classroom: "many", title: "Many objectives" });
      seedPreparedReviewSource(
        f.root,
        "many",
        "001-ownership",
        "check-1",
        Array.from({ length: 20 }, (_, i) => "q" + i),
      );
      writeGradedAttempt({
        classroom: "many",
        at: NOW - 10 * DAY_MS,
        answers: Array.from({ length: 20 }, (_, i) => termAnswer("q" + i, "owner")),
        correct: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["q" + i, true])),
      });
      seedClassroom(f, { classroom: "long", title: "Long objective" });
      seedPreparedReviewSource(f.root, "long");
      writeGradedAttempt({
        classroom: "long",
        at: NOW - 3 * DAY_MS,
        answers: [
          termAnswer("q1", "owner", {
            learning: {
              objectiveId: "long",
              objective: {
                statement:
                  "Explain ownership across a chain of functions, including " +
                  "long_reference_name_".repeat(25),
                application: false,
              },
              task: "retrieval",
              support: "independent",
              assistance: "none",
            },
          }),
        ],
        correct: { q1: true },
      });
      seedClassroom(f, { classroom: "future", title: "Future timestamps" });
      writeGradedAttempt({
        classroom: "future",
        at: NOW + 30 * DAY_MS,
        answers: [termAnswer("q1", "owner")],
        correct: { q1: true },
      });
      server.setHooks({
        delivery: "service",
        reviewOwner: "service",
        teacherState: (c, l) => teacher.publicState(c, l),
        lessonOwner: () => backend,
        onReview: completePreparedReview,
        onReviewRetry: completePreparedReview,
        onAsk() {
          throw Error("Unexpected annotation");
        },
        onFollowUp() {
          throw Error("Unexpected follow-up");
        },
        onReflect() {
          throw Error("Unexpected reflection");
        },
        onQuizSubmit() {
          throw Error("Closed card must not ask teacher to grade.");
        },
      });
      const base = await server.start(0),
        before = hashes(f.root);
      save("source-before", {
        items,
        forecast: memoryForecast(items, NOW),
        workload: classroomWorkload("rust", items, NOW),
        teacher: readTeacherState("rust"),
      });
      await playwright(session, dir, "open", "about:blank");
      opened = true;
      const observation = await code(`
        const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push({method:r.method(),url:r.url()});});
        await page.setViewportSize({width:1280,height:900});await page.goto(${JSON.stringify(base + "/c/rust")});
        await page.getByRole('heading',{name:'Memory map',exact:true}).waitFor();
        const expected=${JSON.stringify(items)};
        const check=async()=>{
          if(await page.locator('[data-memory-key]').count()!==expected.length)throw Error('Memory rows lost or duplicated objectives.');
          for(const item of expected){
            const target=page.locator('[data-memory-key='+JSON.stringify(item.key)+']');
            await target.locator('.cl-memory-row > summary').focus();await page.keyboard.press('Enter');
            if(await target.locator('.cl-memory-facts time').first().getAttribute('datetime')!==new Date(item.lastAt).toISOString())throw Error('Latest evidence time differs from production replay.');
            const evidenceTime=target.locator('.cl-memory-facts time').first();await evidenceTime.focus();
            if(!(await evidenceTime.getAttribute('aria-label')).includes('Exact UTC:'))throw Error('Missing exact UTC label');
            if(!(await evidenceTime.evaluate(el=>getComputedStyle(el,'::after').content)).includes(await evidenceTime.getAttribute('datetime')))throw Error('Keyboard focus lost exact UTC');
            const why=target.getByText('Why is this due?',{exact:true});await why.focus();await page.keyboard.press('Enter');
            if(!(await target.innerText()).includes(item.scheduleReason))throw Error('Why due lost real scheduleReason.');
            if(!(await target.innerText()).includes(item.stability.toFixed(2)))throw Error('Memory estimate lost.');
            if(await target.locator('a').last().getAttribute('href')!==${JSON.stringify("/c/rust/001-ownership")})throw Error('Original source link lost.');
            await why.press('Enter');await target.locator('.cl-memory-row > summary').click();
          }
          await page.getByText('Read forecast as a table',{exact:true}).focus();await page.keyboard.press('Enter');
          const counts=await page.locator('.cl-memory-table tbody td').allTextContents();
          if(JSON.stringify(counts.map(Number))!==JSON.stringify(${JSON.stringify(memoryForecast(items, NOW).map((d) => d.count))}))throw Error('Forecast differs from production saved due times.');
          await page.getByText('Read forecast as a table',{exact:true}).press('Enter');
        };
        await check();
        const shots=[];
        for(const [size,width,height]of [['desktop',1280,800],['mobile',390,844]])for(const theme of ['light','dark']){
          await page.setViewportSize({width,height});await page.evaluate(t=>localStorage.setItem('pi-classroom-theme',t),theme);await page.reload();await page.getByRole('heading',{name:'Memory map',exact:true}).waitFor();
          await page.locator('[data-cl-up-start]:visible').waitFor({state:'visible'});
          if(await page.locator('.cl-up-actions > .cl-button:visible').count()!==1)throw Error('Expected one primary action');const primary=await page.locator('[data-cl-up-start]:visible').boundingBox();if(!primary||primary.y<0||primary.y+primary.height>height)throw Error('Primary action below fold');
          await page.evaluate(()=>window.scrollTo(0,0));if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Memory map clips viewport.');
          const file=${JSON.stringify(dir)}+'/after-'+size+'-'+theme+'.png';await page.screenshot({path:file,fullPage:true});shots.push(file);
        }
        const legacy=page.locator('[data-memory-key="001-ownership/check-1/legacy"]');
        await legacy.locator('.cl-memory-row > summary').click();await legacy.getByText('Why is this due?',{exact:true}).click();await legacy.getByRole('link',{name:'Open original lesson',exact:true}).click();await page.locator('[data-question-id="legacy"]').waitFor();await page.goBack();
        await page.getByRole('link',{name:'upcoming objectives',exact:true}).click();await page.getByRole('heading',{name:'Course map',exact:true}).waitFor();await page.goBack();
        await page.goto(${JSON.stringify(base + "/c/empty")});await page.getByText('No saved answer evidence yet.',{exact:false}).waitFor();await page.screenshot({path:${JSON.stringify(path.join(dir, "empty-mobile-dark.png"))},fullPage:true});
        await page.goto(${JSON.stringify(base + "/c/many")});if(await page.locator('[data-memory-key]').count()!==20)throw Error('Many evidence rows lost.');
        await page.getByText('How review is scheduled',{exact:true}).click();if(!(await page.locator('[data-review-workload]').innerText()).includes('(UTC). 5 due items deferred'))throw Error('Actual cap/deferred count lost.');
        await page.goto(${JSON.stringify(base + "/c/long")});
        for(const [width,height]of [[1280,900],[390,844]])for(const theme of ['light','dark']){await page.setViewportSize({width,height});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Long objective clips.');await page.screenshot({path:${JSON.stringify(dir)}+'/long-'+width+'-'+theme+'.png',fullPage:true});}
        await page.goto(${JSON.stringify(base + "/c/future")});await page.locator('.cl-memory-row > summary').first().click();await page.getByText('Saved evidence is dated in the future',{exact:true}).waitFor();
        await page.goto(${JSON.stringify(base + "/c/rust")});
        if(errors.length||writes.length)throw Error(JSON.stringify({errors,writes}));
        return {shots,errors,writes,keyboardWhy:true,keyboardTable:true,legacySource:true,courseCoverageSeparate:true,empty:true,many:true};
      `);
      const nextStep = await code(`
        // A real read stores a resume anchor; grading remains the source of completion.
        await page.goto(${JSON.stringify(base + "/c/empty")});
        await page.getByRole('button',{name:'Start next lesson',exact:true}).waitFor();
        await page.locator('.cl-lesson-link').first().click();
        await page.locator('[data-cl-content]').waitFor();
        await page.waitForFunction(()=>JSON.parse(localStorage.getItem('studens-recent-lessons')||'[]').some(h=>h.url==='/c/empty/001-ownership'));
        await page.goto(${JSON.stringify(base + "/c/empty")});
        await page.getByRole('link',{name:'Resume lesson',exact:true}).waitFor();
        if(await page.locator('[data-cl-lesson-status]').innerText()!=='In progress')throw Error('Visited lesson not in progress');
        await page.reload();await page.getByRole('link',{name:'Resume lesson',exact:true}).waitFor();
        await page.goto(${JSON.stringify(base + "/c/rust")});
        await page.getByRole('button',{name:'Review due items',exact:true}).waitFor();
        return {notStartedNext:true,visitedResume:true,resumeReload:true,completedLessonReview:true};
      `);
      save("up-next", nextStep);
      const viewed = hashes(f.root);
      save("read-only-hashes", { before, after: viewed });
      if (JSON.stringify(before) !== JSON.stringify(viewed))
        throw Error("Viewing memory map wrote canonical state.");
      save("viewing", observation);
      // Native accepted retire/restore events change the map only after explicit action/reload.
      const partial = items.find((i) => i.questionId === "partial")!;
      await code(`
        await page.getByText('Manage review items',{exact:true}).click();
        const control=page.locator('[data-review-item='+JSON.stringify(${JSON.stringify(partial.key)})+']');
        await Promise.all([page.waitForEvent('load'),control.getByRole('button',{name:'Retire item',exact:true}).click()]);
        if(!(await page.locator('[data-memory-key='+JSON.stringify(${JSON.stringify(partial.key)})+']').innerText()).includes('Retired · not scheduled'))throw Error('Retirement not reflected.');
        await page.getByText('Manage review items',{exact:true}).click();await Promise.all([page.waitForEvent('load'),control.getByRole('button',{name:'Restore item',exact:true}).click()]);return true;
      `);
      if (store.reviewItems("rust").find((i) => i.key === partial.key)!.retiredAt !== undefined)
        throw Error("Restore did not persist.");
      // Real prepared review, native closed grading, then reload: no teacher/model turn.
      await code(
        `await page.locator('[data-cl-review-topic]').selectOption(${JSON.stringify(reviewTopic(partial).id)});await page.getByRole('button',{name:'Review due items',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='fresh');await page.locator('form.cl-quiz:visible input[value="owner"]').check();await page.locator('form.cl-quiz:visible [data-cl-assistance]').selectOption('none');await page.locator('form.cl-quiz:visible button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('[data-review-active="true"]')?.dataset.state==='graded');await page.goto(${JSON.stringify(base + "/c/rust")});await page.reload();return true;`,
      );
      const after = store.reviewItems("rust"),
        corrected = after.find((i) => i.key === partial.key)!;
      if (
        corrected.gapOpen ||
        corrected.attempts !== partial.attempts + 1 ||
        corrected.lastAt !== NOW
      )
        throw Error("Accepted correction did not revise memory projection.");
      const correctedDisplay = await code(
        `const row=page.locator('[data-memory-key='+JSON.stringify(${JSON.stringify(partial.key)})+']');await row.locator('.cl-memory-row > summary').click();if(!(await row.innerText()).includes('Earlier answer gap resolved'))throw Error('Saved correction missing after reload');await row.getByText('Why is this due?',{exact:true}).click();await page.screenshot({path:${JSON.stringify(path.join(dir, "corrected.png"))},fullPage:true});return {strength:await row.locator(".cl-memory-facts > div").first().innerText(),latestEvidence:await row.locator(".cl-memory-facts > div").nth(1).innerText(),expanded:await row.locator(".cl-memory-why").innerText()};`,
      );
      save("correction-display", correctedDisplay);
      const review = currentReview("rust")!;
      if (store.listGrades("rust", review.lesson).length !== 1)
        throw Error("Correction graded twice.");
      const preserved = JSON.stringify(store.listGrades("rust", "001-ownership"));
      // A production accepted linked retrieval check uses the actual reply time,
      // so a late teacher receipt cannot invent delayed evidence.
      const long = store.reviewItems("long")[0];
      f.write(
        "long/learning-records/0001-correction.md",
        "# Ownership correction\n\nSaved learner explanation.",
      );
      const linked = store.recordRetrievalCheck(
        "long",
        {
          key: long.key,
          answer: "The current owner releases it.",
          evidence: "The learner explained ownership independently.",
          learningRecord: "0001-correction.md",
          assistance: "none",
          task: "retrieval",
        },
        long.lastAt + 100,
      );
      const linkedItem = store.reviewItems("long")[0];
      if (
        linkedItem.lastAt !== long.lastAt + 100 ||
        linkedItem.delayedSuccesses !== 0 ||
        linkedItem.dueAt !== long.dueAt
      )
        throw Error("Teacher receipt latency became delayed evidence.");
      const linkedBefore = hashes(f.root);
      await code(
        `await page.goto(${JSON.stringify(base + "/c/long")});await page.locator('.cl-memory-row > summary').first().click();await page.getByText('Why is this due?',{exact:true}).click();await page.getByRole('link',{name:'Read linked learning record',exact:true}).click();await page.getByRole('heading',{name:'Ownership correction',exact:true}).waitFor();await page.goto(${JSON.stringify(base + "/c/rust")});return true;`,
      );
      if (JSON.stringify(linkedBefore) !== JSON.stringify(hashes(f.root)))
        throw Error("Reading linked record wrote evidence.");
      save("linked-check", { before: long, receipt: linked, after: linkedItem });
      // Malformed persisted event must stop with a specific error and explicit retry; reads cannot repair it.
      const submission = store.listSubmissions("rust", "001-ownership")[0];
      const file = path.join(
        f.root,
        "rust",
        "001-ownership",
        "quiz",
        "submissions",
        `${submission.submittedAt}-${submission.id}.json`,
      );
      const raw = fs.readFileSync(file, "utf8");
      const corrupt = JSON.parse(raw);
      corrupt.submittedAt = "invalid";
      fs.writeFileSync(file, JSON.stringify(corrupt));
      const errorBefore = hashes(f.root);
      await code(
        `const response=await page.goto(${JSON.stringify(base + "/c/rust")});if(response.status()!==500)throw Error('Malformed event did not stop map');await page.getByRole('link',{name:'Retry loading review state',exact:true}).waitFor();await page.getByRole('main').getByText('Invalid review event timing or credit',{exact:false}).waitFor();await page.screenshot({path:${JSON.stringify(path.join(dir, "error.png"))},fullPage:true});return true;`,
      );
      if (JSON.stringify(errorBefore) !== JSON.stringify(hashes(f.root)))
        throw Error("Error read rewrote state.");
      fs.writeFileSync(file, raw);
      await code(
        `await page.getByRole('link',{name:'Retry loading review state',exact:true}).click();await page.getByRole('heading',{name:'Memory map',exact:true}).waitFor();return true;`,
      );
      const privateRoutes = [
        "/c/rust/001-ownership/quiz/plan.json",
        "/c/rust/.teacher.json",
        "/static/../quiz/plan.json",
      ];
      const statuses = await Promise.all(
        privateRoutes.map(async (route) => ({ route, status: (await fetch(base + route)).status })),
      );
      if (statuses.some((r) => r.status !== 404)) throw Error("Private memory input leaked.");
      await server.close();
      await server.start(0);
      if (
        JSON.stringify(store.listGrades("rust", "001-ownership")) !== preserved ||
        store.listGrades("rust", review.lesson).length !== 1 ||
        teacherTurns !== 0
      )
        throw Error("Restart rewrote grades or woke inference.");
      save("result", {
        backend,
        teacherTurns,
        viewing: observation,
        itemsBefore: items,
        itemsAfter: after,
        forecastAfter: memoryForecast(after, NOW),
        workloadAfter: classroomWorkload("rust", after, NOW),
        review,
        privateRoutes: statuses,
        gradeCount: 1,
        linkedRecord: true,
        malformedExplicitRetry: true,
        restartPreserved: true,
        fixtureOwnerOnly: true,
      });
      console.log(
        `PASS: ${backend} owner memory map, replay/forecast/why, keyboard/links, both themes/sizes, no read writes/inference, native correction/retirement, malformed explicit retry, restart/private routes`,
      );
    } catch (error) {
      save("failure", {
        error: String(error),
        diagnostics: (error as { browserDiagnostics?: unknown }).browserDiagnostics,
        teacher: readTeacherState("rust"),
      });
      throw error;
    } finally {
      if (opened) await playwright(session, dir, "close");
      await server.close();
      f.cleanup();
      Date.now = realNow;
    }
  }
}
