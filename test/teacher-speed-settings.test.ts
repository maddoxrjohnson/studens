/** Local speed settings: model catalog cache, session rotation and per-kind overrides. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config.ts";
import {
  requestIdentity,
  runStructured,
  runTeacher,
  type PlanContract,
  type StreamDigest,
  type TeacherIdentity,
} from "../src/teacher.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { readTeacherState } from "../src/service-state.ts";
import * as store from "../src/store.ts";
import { _clearModelCatalogCache } from "../src/teacher-models.ts";
import { PROMPT_SPLIT } from "../src/prompt-split.ts";
import {
  makeFixture,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";

let f: Fixture;
let priorPath: string | undefined;
let priorModel: string | undefined;
const setConfig = (config: object) => f.write("test-config.json", JSON.stringify(config));
const log = (): { args: string[] }[] =>
  fs.existsSync(path.join(f.root, "rpc.jsonl"))
    ? fs
        .readFileSync(path.join(f.root, "rpc.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
const requests = () => log().filter((m) => !m.args.includes("--input-format"));
const discoveries = () => log().filter((m) => m.args.includes("--input-format"));

beforeEach(() => {
  f = makeFixture();
  priorPath = process.env.PATH;
  priorModel = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  _clearModelCatalogCache();
  const script =
    `#!${process.execPath}\n` +
    String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=process.cwd();
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
fs.appendFileSync(path.join(root,'rpc.jsonl'),JSON.stringify({args:process.argv.slice(2)})+'\n');
if(!process.argv.includes('--input-format')) {
 let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
  const a=process.argv.indexOf('--append-system-prompt-file');
  fs.appendFileSync(path.join(root,'prompts.jsonl'),JSON.stringify({stdin,system:a>0?fs.readFileSync(process.argv[a+1],'utf8'):null,file:a>0?process.argv[a+1]:null})+'\n');
  const model=process.argv[process.argv.indexOf('--model')+1];
  if(process.env.FAKE_EVENTS){for(const e of JSON.parse(fs.readFileSync(process.env.FAKE_EVENTS,'utf8'))){if(e.type==='assistant')e.message.model=model;send(e);}process.exitCode=Number(process.env.FAKE_EXIT||0);return;}
  send({type:'assistant',message:{model}});
  send({type:'result',session_id:'s1',usage:{input_tokens:2,cache_creation_input_tokens:Number(process.env.FAKE_TOKENS||0),cache_read_input_tokens:0},structured_output:{ok:true}});
 });
} else readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 const response=m.request.subtype==='initialize'?{models:[{value:'cfg',resolvedModel:'cfg',displayName:'Cfg'},{value:'fast',resolvedModel:'fast',displayName:'Fast'}]}:{effective:{model:'cfg'}};
 send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
});
`;
  fs.chmodSync(f.write("bin/claude", script), 0o700);
  process.env.PATH = path.join(f.root, "bin") + ":" + priorPath;
});
afterEach(() => {
  process.env.PATH = priorPath;
  delete process.env.FAKE_TOKENS;
  delete process.env.FAKE_EVENTS;
  delete process.env.FAKE_EXIT;
  if (priorModel === undefined) delete process.env.ANTHROPIC_MODEL;
  else process.env.ANTHROPIC_MODEL = priorModel;
  f.cleanup();
});
const run = (identity: TeacherIdentity, save: (id: string) => void = () => {}) =>
  runStructured(identity, "go", f.root, save, { type: "object" });

describe("config validation", () => {
  it("accepts good values and rejects ranges, kinds and unknown options", () => {
    expect(() =>
      validateConfig({
        teacherModelCatalogSeconds: 300,
        teacherSessionMaxTokens: 150_000,
        teacherRequestOverrides: { chat: { model: "fast", effort: "low" }, refill: {} },
      }),
    ).not.toThrow();
    for (const bad of [
      { teacherModelCatalogSeconds: -1 },
      { teacherModelCatalogSeconds: 3601 },
      { teacherSessionMaxTokens: 1000 },
      { teacherRequestOverrides: [] },
      { teacherRequestOverrides: { chat: { effort: "ultra" } } },
      { teacherRequestOverrides: { chat: { model: "a b" } } },
      { teacherRequestOverrides: { chat: { speed: 1 } } },
      { teacherSessions: "sometimes" },
      { teacherPromptOrder: "reverse" },
    ])
      expect(() => validateConfig(bad as never)).toThrow();
  });
  it.each(["quiz", "lesson", "review", "follow-up"])("never lets %s be overridden", (kind) => {
    expect(() =>
      validateConfig({ teacherRequestOverrides: { [kind]: { model: "fast" } } } as never),
    ).toThrow(/grading and lesson requests always use the classroom's model/);
  });
});

describe("requestIdentity", () => {
  const identity: TeacherIdentity = { backend: "claude", sessionId: "s" };
  it("changes nothing without overrides", () => {
    expect(requestIdentity(identity, { kind: "chat", requestedModel: null })).toEqual({
      ...identity,
      requestedModel: null,
    });
  });
  it("overrides only configured kinds, and never over an explicit classroom model", () => {
    setConfig({ teacherRequestOverrides: { chat: { model: "fast", effort: "low" } } });
    expect(requestIdentity(identity, { kind: "chat", requestedModel: null })).toMatchObject({
      requestedModel: "fast",
      requestEffort: "low",
    });
    expect(requestIdentity(identity, { kind: "chat", requestedModel: "mine" })).toMatchObject({
      requestedModel: "mine",
    });
    expect(
      requestIdentity(identity, { kind: "quiz", requestedModel: null }).requestEffort,
    ).toBeUndefined();
    expect(
      requestIdentity({ backend: "codex" }, { kind: "chat", requestedModel: null }).requestEffort,
    ).toBeUndefined();
  });
  it("passes the override model and effort to the claude CLI", async () => {
    setConfig({ teacherRequestOverrides: { chat: { model: "fast", effort: "low" } } });
    await run(requestIdentity(identity, { kind: "chat", requestedModel: null }));
    const args = requests()[0].args;
    expect(args[args.indexOf("--model") + 1]).toBe("fast");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
  });
});

describe("model catalog cache", () => {
  it("spawns one discovery per request by default", async () => {
    await run({ backend: "claude" });
    await run({ backend: "claude" });
    expect(discoveries()).toHaveLength(2);
  });
  it("reuses the catalog within teacherModelCatalogSeconds", async () => {
    setConfig({ teacherModelCatalogSeconds: 300 });
    await run({ backend: "claude" });
    await run({ backend: "claude" });
    expect(discoveries()).toHaveLength(1);
    expect(requests()).toHaveLength(2);
  });
});

describe("session rotation", () => {
  it("keeps the session by default and forgets it past teacherSessionMaxTokens", async () => {
    process.env.FAKE_TOKENS = "300000";
    const saved: string[] = [];
    await run({ backend: "claude" }, (id) => saved.push(id));
    setConfig({ teacherSessionMaxTokens: 150_000 });
    await run({ backend: "claude" }, (id) => saved.push(id));
    process.env.FAKE_TOKENS = "1000";
    await run({ backend: "claude" }, (id) => saved.push(id));
    expect(saved).toEqual(["s1", "", "s1"]);
  });
});

describe("fresh sessions", () => {
  const identity: TeacherIdentity = { backend: "claude", sessionId: "old-session" };
  it("resumes the saved session by default", async () => {
    const saved: string[] = [];
    await run(identity, (id) => saved.push(id));
    const args = requests()[0].args;
    expect(args[args.indexOf("--resume") + 1]).toBe("old-session");
    expect(args).not.toContain("--no-session-persistence");
    expect(saved).toEqual(["s1"]);
  });
  it("starts a new session, writes no transcript, and leaves the saved session alone", async () => {
    setConfig({ teacherSessions: "fresh" });
    const saved: string[] = [];
    await run(identity, (id) => saved.push(id));
    const args = requests()[0].args;
    expect(args).not.toContain("--resume");
    expect(args).toContain("--no-session-persistence");
    expect(saved).toEqual([]);
  });
});

describe("cache-ordered prompt", () => {
  const prompts = () =>
    fs
      .readFileSync(path.join(f.root, "prompts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  it("sends the stable part as a private system prompt file and removes it afterwards", async () => {
    await runStructured(
      { backend: "claude" },
      `stable rules\n\n${PROMPT_SPLIT}\n\nRequest r1: question`,
      f.root,
      () => {},
      { type: "object" },
    );
    const [sent] = prompts();
    expect(sent.system).toBe("stable rules");
    expect(sent.stdin).toBe("Request r1: question");
    expect(fs.existsSync(sent.file)).toBe(false);
  });
  it("sends an unsplit prompt on stdin with no system prompt file", async () => {
    await runStructured({ backend: "claude" }, "plain", f.root, () => {}, { type: "object" });
    expect(prompts()[0]).toMatchObject({ stdin: "plain", system: null });
  });
});

describe("plan operations called as native tools", () => {
  const reply = "The String is dropped when its owner leaves scope.";
  const key = "001-ownership/check-1/q1";
  const contract: PlanContract = {
    operations: ["record_retrieval_check"],
    messageRequired: true,
    notesAllowed: true,
    response: "retrieval-check",
    retrievalTarget: { classroom: "rust", answer: reply, reviewKeys: [key] },
  };
  const check = {
    review_key: key,
    evidence: "New example: the learner traced the owner to the end of its scope.",
    assistance: "none",
    task: "retrieval",
    learning_record_markdown: "# Owner lifetime\n\nTraced a String to its owner's scope end.",
  };
  /** The captured failure: a native call is refused, then the plan omits the check. */
  const stream = (
    retrieval_check: unknown,
    name = "record_retrieval_check",
    before: unknown[] = [],
  ) => {
    const file = f.write(
      `events-${Math.random()}.json`,
      JSON.stringify([
        ...before,
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name, input: {} }] },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: true,
                content:
                  "<tool_use_error>Error: No such tool available: record_retrieval_check</tool_use_error>",
              },
            ],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Correct. Next case." }] },
        },
        {
          type: "result",
          session_id: "s1",
          usage: {},
          structured_output: { message: "Correct.", retrieval_check, notes_markdown: "" },
        },
      ]),
    );
    process.env.FAKE_EVENTS = file;
  };
  const turn = (digests: StreamDigest[] = []) =>
    runTeacher(
      { backend: "claude" },
      "go",
      f.root,
      () => {},
      undefined,
      contract,
      undefined,
      undefined,
      (digest) => digests.push(digest),
    );

  it("rejects a native call whose final plan omits the operation, saving a digest", async () => {
    stream(null);
    const digests: StreamDigest[] = [];
    await expect(turn(digests)).rejects.toThrow(
      "called record_retrieval_check as a tool instead of returning it in the plan",
    );
    expect(digests).toHaveLength(1);
    expect(digests[0].tools).toEqual(["record_retrieval_check"]);
    expect(digests[0].toolErrors[0]).toContain("No such tool available");
    expect(digests[0].text).toEqual([{ chars: 19, start: "Correct. Next case." }]);
  });
  it("keeps a digest when the CLI exits with an error", async () => {
    process.env.FAKE_EVENTS = f.write(
      "events-exit.json",
      JSON.stringify([
        { type: "result", is_error: true, result: "Usage limit reached.", session_id: "s1" },
      ]),
    );
    process.env.FAKE_EXIT = "1";
    const digests: StreamDigest[] = [];
    await expect(turn(digests)).rejects.toThrow("Claude teacher exited with 1");
    expect(digests).toEqual([
      { text: [], tools: [], toolErrors: [], resultError: "Usage limit reached." },
    ]);
  });
  it("matches a namespaced native call to the plan operation", async () => {
    stream(null, "mcp__plugin_studens_classroom__record_retrieval_check");
    await expect(turn()).rejects.toThrow("called record_retrieval_check as a tool");
  });
  it("ignores a native call from an earlier resumed turn", async () => {
    const earlier = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t0", name: "record_retrieval_check", input: {} }],
      },
    };
    stream(null, "StructuredOutput", [earlier, { type: "system", subtype: "init" }]);
    const digests: StreamDigest[] = [];
    const plan = await turn(digests);
    expect(plan.calls).toEqual([]);
    expect(digests[0].tools).toEqual(["StructuredOutput"]);
  });
  it("accepts a stray native call when the final plan returned the check", async () => {
    stream(check);
    const plan = await turn();
    expect(plan.calls.map((call) => call.name)).toEqual(["record_retrieval_check"]);
    expect(JSON.parse(plan.calls[0].arguments_json)).toMatchObject({
      classroom: "rust",
      answer: reply,
    });
  });
  it("leaves the panel request failed with the reply kept until an explicit retry", async () => {
    seedClassroom(f);
    writeGradedAttempt({
      at: Date.now() - 86_400_000,
      answers: [termAnswer("q1", "forever")],
      correct: { q1: false },
    });
    stream(null);
    const teacher = new TeacherService();
    teacher.attach("rust", "claude");
    const id = "5b4e807f-23ba-4716-8fdd-abfb09b79001";
    teacher.chat("rust", "001-ownership", reply, id);
    await teacher.idle();
    let state = readTeacherState("rust")!;
    const failed = state.requests.find((r) => r.id === `chat:${id}`)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("called record_retrieval_check as a tool");
    expect(failed.plan).toBeUndefined();
    expect(failed.streamDigest?.tools).toEqual(["record_retrieval_check"]);
    expect(state.messages.filter((m) => m.role === "learner").map((m) => m.text)).toEqual([reply]);
    expect(store.listRetrievalChecks("rust")).toHaveLength(0);
    stream(check);
    teacher.retry("rust", `chat:${id}`);
    await teacher.idle();
    state = readTeacherState("rust")!;
    const done = state.requests.find((r) => r.id === `chat:${id}`)!;
    expect(done.status).toBe("done");
    expect(done.planVersion).toBe(3);
    expect(done.streamDigest).toBeUndefined();
    const sent = fs
      .readFileSync(path.join(f.root, "rust", "prompts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).stdin as string);
    expect(sent.at(-1)).toContain("Previous teacher plan error:");
    expect(sent.at(-1)).toContain("called record_retrieval_check as a tool");
    expect(store.listRetrievalChecks("rust")).toHaveLength(1);
    expect(store.listRetrievalChecks("rust")[0]).toMatchObject({ key, answer: reply });
    await teacher.stop();
  });
});
