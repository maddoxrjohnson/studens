/** Local speed settings: model catalog cache, session rotation and per-kind overrides. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config.ts";
import { requestIdentity, runStructured, type TeacherIdentity } from "../src/teacher.ts";
import { _clearModelCatalogCache } from "../src/teacher-models.ts";
import { PROMPT_SPLIT } from "../src/prompt-split.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

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
