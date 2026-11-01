/** Verify learner actions against a persistent service and a mock Codex process. */
import { highlightText } from "./browser-actions.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { makeFixture, seedClassroom, lessonHtml } from "../test/helpers.ts";
import { packageRoot } from "../src/paths.ts";
import { control, ensureService, servicePaths, serviceStatus } from "../src/service-client.ts";
import * as store from "../src/store.ts";
import { readTeacherState, saveTeacherState } from "../src/service-state.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyServiceBrowser(artifacts: string | null): Promise<void> {
  const fixture = makeFixture();
  seedClassroom(fixture);
  fixture.write(
    "rust/001-ownership/lesson.html",
    lessonHtml(
      "Service browser",
      `
    <p>Every value has one owner.</p>
    <form class="cl-reflect" data-reflect-id="ownership"><p class="cl-reflect-prompt">Explain ownership.</p><textarea></textarea></form>
    <form class="cl-quiz" data-quiz-id="draft"><ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="short"><p class="cl-q-prompt">Who owns it?</p><textarea></textarea></li></ol></form>`,
    ),
  );
  const passageMarkdown =
    'The owner releases the value.\n\nQuoted "owner", path C:\\notes\\λ, and Unicode café 🦀.\n\n```rust\nlet owner = "🦀";\n```\n';
  fixture.write("passage-answer.json", JSON.stringify(passageMarkdown));
  const bin = path.join(fixture.root, "bin");
  fixture.write("rust/001-ownership/quiz/key.json", '{"q1":"The owner."}');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}\n` +
      String.raw`
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const file = path.join(process.env.PI_CLASSROOMS_DIR, 'mock-turns.json');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (!m.id) return;
 if (m.method === 'initialize') send({id:m.id,result:{}});
 else if (m.method === 'mcpServerStatus/list') send({id:m.id,result:{data:[],nextCursor:null}});
 else if (m.method === 'config/read') send({id:m.id,result:{config:{model:'fixture-model'}}});
 else if (m.method === 'model/list') send({id:m.id,result:{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model',isDefault:true}],nextCursor:null}});
 else if (m.method === 'thread/start' || m.method === 'thread/resume') send({id:m.id,result:{model:m.params.model,thread:{id:m.params.threadId || 'browser-teacher-session'}}});
 else if (m.method === 'turn/start') {
  if (m.params.input[0].text.startsWith('Readiness check only.')) {
   send({id:m.id,result:{turn:{id:'ready'}}});
   send({method:'item/completed',params:{threadId:m.params.threadId,turnId:'ready',item:{type:'agentMessage',text:JSON.stringify({calls:[],message:'Ready.',learning_record:null,notes_markdown:''})}}});
   send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'ready',status:'completed'}}});
   return;
  }
  const turns = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  turns.push({threadId:m.params.threadId, prompt:m.params.input[0].text, schema:m.params.outputSchema});
  fs.writeFileSync(file, JSON.stringify(turns));
  if (turns.length === 1) { send({id:m.id,error:{code:-32000,message:'Fixture teacher failure'}}); return; }
  const ask = /annotation_id: "([^"]+)"/.exec(m.params.input[0].text);
  const quiz = /submission_id: "([^"]+)"/.exec(m.params.input[0].text);
  const calls = ask ? [{name:'answer_lesson_question',arguments_json:JSON.stringify({annotation_id:ask[1],answer_markdown:'The owner releases the value.'})}] : quiz ? [{name:'grade_quiz_answers',arguments_json:JSON.stringify({submission_id:quiz[1],...(m.params.input[0].text.includes('Previous teacher plan error:') ? {} : {score:10}),feedback_markdown:'Check the owner.',questions:[{question_id:'q1',correct:false,feedback:'Trace the owner.'}]})}] : [];
  send({id:m.id,result:{turn:{id:'browser-turn'}}});
  send({method:'item/completed',params:{threadId:m.params.threadId,turnId:'browser-turn',item:{type:'agentMessage',text:JSON.stringify(ask ? {annotation_id:ask[1],answer_markdown:JSON.parse(fs.readFileSync(path.join(process.env.PI_CLASSROOMS_DIR,'passage-answer.json'),'utf8'))} : m.params.outputSchema?.properties?.retrieval_check ? {message:'What changes when the value moves?',retrieval_check:null,notes_markdown:''} : {calls,message:'What changes when the value moves?',learning_record:null,notes_markdown:''})}}});
  send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'browser-turn',status:'completed'}}});
 }
});
`,
    { mode: 0o700 },
  );
  const previous = {
    PATH: process.env.PATH,
    PI_CLASSROOM_SERVICE_PORT: process.env.PI_CLASSROOM_SERVICE_PORT,
    PI_CLASSROOMS_DIR: process.env.PI_CLASSROOMS_DIR,
    PI_CLASSROOM_TAILSCALE: process.env.PI_CLASSROOM_TAILSCALE,
  };
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  Object.assign(process.env, {
    PATH: `${bin}:${previous.PATH}`,
    PI_CLASSROOM_SERVICE_PORT: String(port),
    PI_CLASSROOMS_DIR: fixture.root,
    PI_CLASSROOM_TAILSCALE: "0",
  });
  const session = `studens-service-browser-${process.pid}`;
  let browserOpen = false;
  const evidence = (name: string, value: unknown) => {
    if (artifacts) {
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, `${name}.json`), JSON.stringify(value, null, 2));
    }
  };
  const snapshot = (name: string) =>
    evidence(name, {
      teacher: readTeacherState("rust"),
      drafts: store.readDrafts("rust", "001-ownership"),
      reflections: store.listReflections("rust", "001-ownership"),
      annotations: store.listAnnotations("rust", "001-ownership"),
    });
  async function wait(label: string, probe: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }
  async function stopOwnedService() {
    const status = await serviceStatus();
    if (!status.running) return;
    if (
      status.root !== fixture.root ||
      status.packageRoot !== path.resolve(packageRoot()) ||
      status.port !== port
    )
      throw new Error("Cleanup found a different service owner.");
    await control("/stop", {});
    await wait("service process exit", () => {
      try {
        process.kill(status.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        return true;
      }
    });
    if ((await serviceStatus()).running) throw new Error("The stopped service is still running.");
  }
  let action = 0;
  async function browser(code: string) {
    const result = await playwrightCode(
      session,
      fixture.root,
      `async page => {
      page.learnerErrors ??= [];
      if (!page.learnerErrorListener) {
        page.learnerErrorListener = true;
        page.on('pageerror', error => page.learnerErrors.push(error.message));
      }
      ${code}
      if (page.learnerErrors.length) throw new Error('Browser errors: '+page.learnerErrors.join('; '));
      return {url:page.url(), snapshot:await page.locator('body').ariaSnapshot(), errors:page.learnerErrors, reconnectState:page.reconnectState};
    }`,
    );
    evidence(`browser-action-${++action}`, result);
    return result;
  }
  const shot = (name: string) =>
    artifacts
      ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, `${name}.png`))},fullPage:true});`
      : "";
  let mcp: ReturnType<typeof spawn> | undefined;
  let mcpLog = "";
  try {
    // Call the public MCP tool through its stdio transport.
    mcp = spawn(process.execPath, [path.join(packageRoot(), "mcp/launch.mjs")], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    mcp.stderr!.on("data", (chunk) => {
      mcpLog += chunk;
    });
    const lines = readline.createInterface({ input: mcp.stdout! });
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    });
    mcp.on("exit", (code) => {
      for (const request of pending.values())
        request.reject(new Error(`MCP exited with ${code}: ${mcpLog}`));
    });
    async function call(method: string, params: unknown) {
      const id = ++sequence;
      const reply = new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      mcp!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          reply,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`MCP timed out: ${method}`)), 15_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    }
    await call("initialize", { clientInfo: { name: "codex-browser-test", version: "1" } });
    const opened = await call("tools/call", {
      name: "open_classroom",
      arguments: { classroom: "rust", teacher_backend: "codex" },
    });
    if (opened.error || opened.result.isError) throw new Error(JSON.stringify(opened));
    const link = /\[Open classroom\]\((http:\/\/127\.0\.0\.1:\d+\/c\/rust)\)/.exec(
      opened.result.content[0].text,
    )?.[1];
    if (!link) throw new Error("open_classroom did not return a classroom link.");
    evidence("mcp-open-classroom", opened);
    const exited = new Promise<void>((resolve) => mcp!.on("exit", () => resolve()));
    mcp.stdin!.end();
    await exited;
    lines.close();
    const before = await serviceStatus();
    if (
      before.root !== fixture.root ||
      before.packageRoot !== path.resolve(packageRoot()) ||
      before.port !== port
    )
      throw new Error("The service does not own the expected fixture.");
    for (const route of ["/", "/c/rust", "/c/rust/001-ownership", "/static/classroom.js"]) {
      if ((await fetch(`${before.url}${route}`)).status !== 200)
        throw new Error(`Service readiness failed: ${route}`);
    }
    evidence("service-before", before);
    await playwright(session, fixture.root, "open", link);
    browserOpen = true;
    await browser(`
      await page.locator('a[href="/c/rust/001-ownership"]').click();
      await page.locator('main > p').getByText('Every value has one owner.', {exact:true}).waitFor();
      ${shot("mcp-reading-lesson")}
      await (${highlightText.toString()})(page, 'main > p', 'one owner');
      await page.locator('.cl-ask-pill').click();
      await page.locator('[data-cl-question]').fill('Who releases the value?');
      const response = page.waitForResponse(r => r.url().endsWith('/api/ask') && r.request().method() === 'POST');
      await page.getByRole('button', {name:'Ask your teacher', exact:true}).click();
      if ((await response).status() !== 201) throw new Error('The composer question was refused.');
      await page.getByRole('button', {name:'Retry request', exact:true}).waitFor();
      if (!(await page.locator('.cl-teacher-requests').innerText()).includes('Fixture teacher failure')) throw new Error('The request error is missing.');
      ${shot("failed-request")}
    `);
    const failed = readTeacherState("rust")!;
    if (
      failed.requests.length !== 1 ||
      failed.requests[0].status !== "failed" ||
      failed.requests[0].error !==
        `codex model configured default ask request ${failed.requests[0].id} in rust/001-ownership: Fixture teacher failure`
    )
      throw new Error("The first failure was not saved.");
    snapshot("failed-request");
    await browser(`
      const retry = page.waitForResponse(r => r.url().endsWith('/api/teacher/retry'));
      await page.getByRole('button', {name:'Retry request', exact:true}).click();
      if (!(await retry).ok()) throw new Error('Retry was refused.');
      await page.locator('.cl-card-answer').getByText('The owner releases the value.', {exact:true}).waitFor();
      await page.waitForFunction(() => !document.querySelector('.cl-teacher-requests button'));
      ${shot("retried-request")}
    `);
    await wait("saved retry", () => readTeacherState("rust")!.requests[0].status === "done");
    const retried = readTeacherState("rust")!;
    if (
      retried.requests.length !== 1 ||
      retried.requests[0].id !== failed.requests[0].id ||
      retried.requests[0].error ||
      store.listAnnotations("rust", "001-ownership")[0].status !== "answered"
    )
      throw new Error("Retry changed the request identity or lost its answer.");
    const turns = JSON.parse(fs.readFileSync(path.join(fixture.root, "mock-turns.json"), "utf8"));
    if (
      turns.length !== 2 ||
      turns.some((turn: any) => turn.threadId !== "browser-teacher-session")
    )
      throw new Error("Retry did not use exactly one new turn in the same teacher session.");
    snapshot("retried-request");
    const annotation = store.listAnnotations("rust", "001-ownership")[0];
    await browser(`
      await page.locator('[data-cl-followup]').fill('How does moving change the owner?');
      const response = page.waitForResponse(r => r.url().endsWith('/follow-up') && r.request().method() === 'POST');
      await page.locator('.cl-card-panel').getByRole('button', {name:'Ask',exact:true}).click();
      if ((await response).status() !== 201) throw new Error('Follow-up was refused.');
      await page.waitForFunction(() => document.querySelectorAll('.cl-card-answer pre code').length === 2);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('.cl-card-answer pre code').length === 2);
      ${shot("typed-passage-reload")}
    `);
    await wait("typed follow-up saved", () =>
      readTeacherState("rust")!.requests.every((r) => r.status === "done"),
    );
    const answered = store.findAnnotation(annotation.id)!;
    if (
      answered.answerMarkdown !== passageMarkdown ||
      answered.followUps?.[0].answerMarkdown !== passageMarkdown
    )
      throw new Error("Typed Markdown changed on disk.");
    const passageRequests = readTeacherState("rust")!.requests;
    if (passageRequests.map((r) => r.kind).join(",") !== "ask,follow-up")
      throw new Error("Passage FIFO changed.");
    for (const request of passageRequests) {
      if (
        !request.planValidated ||
        request.applied !== 1 ||
        JSON.parse(request.plan!.calls[0].arguments_json).answer_markdown !== passageMarkdown
      )
        throw new Error("Typed canonical plan was not validated and applied once.");
      if (
        JSON.stringify(request.modelOutput) !==
        JSON.stringify({ annotation_id: annotation.id, answer_markdown: passageMarkdown })
      )
        throw new Error("Raw typed output was not saved.");
    }
    snapshot("typed-passage-reload");
    await browser(`
      await page.locator('[data-cl-followup]').fill('Does moving change the owner?');
      await page.getByRole('textbox', {name:'Reply to your teacher', exact:true}).fill('I think the new variable owns it.');
    `);
    await wait("stored card and teacher drafts", () => {
      const drafts = store.readDrafts("rust", "001-ownership");
      return (
        drafts[`followup:${annotation.id}`] === "Does moving change the owner?" &&
        drafts.teacher === "I think the new variable owns it."
      );
    });
    snapshot("before-draft-reload");
    await browser(`
      await page.reload();
      await page.waitForFunction(() => document.querySelector('[data-cl-followup]')?.value === 'Does moving change the owner?' && document.querySelector('.cl-teacher textarea')?.value === 'I think the new variable owns it.');
      ${shot("restored-card-and-teacher-drafts")}
      await page.locator('form.cl-reflect textarea').fill('The first saved explanation.');
      const response = page.waitForResponse(r => r.url().endsWith('/api/reflect') && r.request().method() === 'POST');
      await page.locator('form.cl-reflect').getByRole('button', {name:'Save', exact:true}).click();
      if ((await response).status() !== 201) throw new Error('Reflection was refused.');
      await page.locator('form.cl-quiz textarea').fill('The old quiz draft.');
    `);
    await wait(
      "reflection work and quiz draft",
      () =>
        readTeacherState("rust")!.requests.every((r) => r.status === "done") &&
        !!store.readDrafts("rust", "001-ownership")["quiz:draft"],
    );
    // Hold draft requests at the network boundary. Reconnect must keep text newer than disk.
    await browser(`
      page.heldDrafts = [];
      await page.route('**/api/draft', route => { page.heldDrafts.push(route); });
      await page.locator('form.cl-reflect textarea').fill('The unsaved new explanation.');
      await page.locator('form.cl-quiz textarea').fill('The unsaved new quiz answer.');
      await page.locator('[data-cl-followup]').fill('The unsaved new follow-up.');
      await page.getByRole('textbox', {name:'Reply to your teacher', exact:true}).fill('The unsaved new teacher reply.');
      await page.waitForFunction(() => document.querySelector('form.cl-reflect').dataset.clDraft === 'true');
      page.reconnectResponses = [];
      page.on('response', response => { if (response.url().includes('/api/state?')) page.reconnectResponses.push(response); });
    `);
    snapshot("before-reconnect");
    await stopOwnedService();
    const recovery = readTeacherState("rust")!;
    const passageBeforeRecovery = JSON.stringify(store.findAnnotation(annotation.id));
    const turnCountBeforeRecovery = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "mock-turns.json"), "utf8"),
    ).length;
    const recoveredRequest = recovery.requests.find((r) => r.kind === "follow-up")!;
    recoveredRequest.status = "planned";
    recoveredRequest.applied = 0;
    saveTeacherState("rust", recovery);
    const after = await ensureService();
    await wait(
      "saved passage plan recovery",
      () =>
        readTeacherState("rust")!.requests.find((r) => r.id === recoveredRequest.id)!.status ===
        "done",
    );
    if (
      JSON.stringify(store.findAnnotation(annotation.id)) !== passageBeforeRecovery ||
      JSON.parse(fs.readFileSync(path.join(fixture.root, "mock-turns.json"), "utf8")).length !==
        turnCountBeforeRecovery
    )
      throw new Error("Saved passage recovery changed an answer or ran inference.");
    snapshot("typed-passage-recovered");
    if (after.pid === before.pid || after.url !== before.url)
      throw new Error("Restart did not replace the service at its stable URL.");
    evidence("service-after", after);
    await browser(`
      const deadline = Date.now() + 15000;
      while (!page.reconnectResponses.length && Date.now() < deadline) await page.waitForTimeout(100);
      if (!page.reconnectResponses.length) throw new Error('The event stream did not reconnect and reload state.');
      const response = page.reconnectResponses.at(-1);
      await response.finished();
      const state = await response.json();
      if (state.reflections[0].text !== 'The first saved explanation.' || state.drafts.teacher !== 'I think the new variable owns it.') throw new Error('Reconnect did not receive the old stored values.');
      await page.waitForTimeout(200);
      page.reconnectState = state;
      for (const [selector, expected] of [
        ['form.cl-reflect textarea', 'The unsaved new explanation.'],
        ['form.cl-quiz textarea', 'The unsaved new quiz answer.'],
        ['[data-cl-followup]', 'The unsaved new follow-up.'],
        ['.cl-teacher textarea', 'The unsaved new teacher reply.']
      ]) if (await page.locator(selector).inputValue() !== expected) throw new Error('Reconnect replaced text: '+selector);
      ${shot("reconnected-unsaved-text")}
      if (page.heldDrafts.length !== 4) throw new Error('Not all four draft writes were held.');
      await Promise.all(page.heldDrafts.map(route => route.continue()));
      await page.unroute('**/api/draft');
    `);
    await wait("new drafts after reconnect", () => {
      const drafts = store.readDrafts("rust", "001-ownership");
      return (
        drafts.teacher === "The unsaved new teacher reply." &&
        drafts[`followup:${annotation.id}`] === "The unsaved new follow-up." &&
        drafts["reflect:ownership"] === "The unsaved new explanation." &&
        JSON.stringify(drafts["quiz:draft"]).includes("The unsaved new quiz answer.")
      );
    });
    snapshot("after-reconnect");
    await browser(`
      const response = page.waitForResponse(r => r.url().endsWith('/api/teacher/chat'));
      await page.getByRole('button', {name:'Send reply', exact:true}).click();
      if (!(await response).ok()) throw new Error('The restored reply was refused.');
    `);
    await wait("saved teacher reply", () => {
      const state = readTeacherState("rust")!;
      return (
        state.requests.every((r) => r.status === "done") &&
        state.messages.some(
          (m) => m.role === "learner" && m.text === "The unsaved new teacher reply.",
        )
      );
    });
    if (Object.hasOwn(store.readDrafts("rust", "001-ownership"), "teacher"))
      throw new Error("Send reply left its draft.");
    snapshot("sent-teacher-reply");
    await browser(`
      const submitted = page.waitForResponse(r => r.url().endsWith('/api/quiz/submit'));
      await page.locator('form.cl-quiz').getByRole('button', {name:'Submit for grading', exact:true}).click();
      if ((await submitted).status() !== 201) throw new Error('Quiz was refused.');
      await page.getByRole('button', {name:'Retry request', exact:true}).waitFor();
      if (!(await page.locator('.cl-teacher-requests').innerText()).includes('grade_quiz_answers must omit score')) throw new Error('The invalid score was not shown.');
      ${shot("rejected-grade")}
    `);
    const rejectedGrade = readTeacherState("rust")!.requests.find((r) => r.kind === "quiz")!;
    if (
      !rejectedGrade.modelOutput ||
      (rejectedGrade.modelOutput as { learning_record?: unknown }).learning_record !== null
    )
      throw new Error("The raw model plan with explicit record absence was not retained.");
    if (rejectedGrade.status !== "failed" || store.listGrades("rust", "001-ownership").length)
      throw new Error("An invalid grade must fail before saving a grade.");
    snapshot("rejected-grade");
    await browser(`
      const retried = page.waitForResponse(r => r.url().endsWith('/api/teacher/retry'));
      await page.getByRole('button', {name:'Retry request', exact:true}).click();
      if (!(await retried).ok()) throw new Error('Grade retry was refused.');
      await page.waitForFunction(() => document.querySelector('form.cl-quiz').dataset.state === 'graded');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('form.cl-quiz').dataset.state === 'graded');
      ${shot("retried-grade")}
    `);
    const grades = store.listGrades("rust", "001-ownership");
    if (grades.length !== 1 || grades[0].score !== 0)
      throw new Error("Retry must save exactly one corrected grade.");
    const gradingTurns = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "mock-turns.json"), "utf8"),
    ).filter((turn: any) =>
      turn.schema.properties.calls?.items.properties.name.enum?.includes("grade_quiz_answers"),
    );
    if (
      gradingTurns.length !== 2 ||
      gradingTurns.some(
        (turn: any) =>
          turn.schema.properties.calls.minItems !== 1 ||
          turn.schema.properties.calls.maxItems !== 1 ||
          turn.schema.properties.calls.items.properties.name.enum.length !== 1 ||
          turn.schema.properties.message.minLength !== 1 ||
          turn.schema.properties.message.pattern !== "\\S",
      )
    )
      throw new Error("Grading must use two request-scoped model turns.");
    evidence("grading-turns", gradingTurns);
    snapshot("retried-grade");
    evidence("result", {
      passed: [
        "MCP open_classroom link to lesson",
        "failed request and explicit Retry request",
        "follow-up and teacher reply draft reload",
        "service restart preserves four unsaved fields",
        "Send reply removes its draft",
        "invalid score fails before writes and explicit retry saves one grade",
      ],
    });
    console.log("PASS: service browser reading, retry, drafts, and reconnect");
  } catch (error) {
    evidence("failure", { error: String(error), status: await serviceStatus(), mcpLog });
    snapshot("failure-stored-state");
    throw error;
  } finally {
    mcp?.kill();
    if (browserOpen) await playwright(session, fixture.root, "close");
    await stopOwnedService();
    if (artifacts && fs.existsSync(servicePaths().log))
      fs.copyFileSync(servicePaths().log, path.join(artifacts, "service.log"));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fixture.cleanup();
  }
}
