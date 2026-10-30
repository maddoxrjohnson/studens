import { afterEach, beforeEach, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.ts";
import {
  connectionSettings,
  learnerPreferences,
  reviewSettings,
  saveConnectionSettings,
  saveLearnerPreferences,
  saveReviewSettings,
} from "../src/settings.ts";
import { dailyReviewLimit } from "../src/review.ts";
import { readConfig } from "../src/config.ts";
import { servicePort } from "../src/service-client.ts";
import * as server from "../src/server.ts";
let f: Fixture;
beforeEach(() => {
  f = makeFixture();
  seedClassroom(f);
  seedClassroom(f, { classroom: "algebra" });
});
afterEach(async () => {
  await server.close();
  f.cleanup();
});
const prefs = { pace: "Slower", depth: "Detailed", tone: "Direct" };
it("merges validated connection settings without exposing or replacing unrelated config", async () => {
  f.write(
    "test-config.json",
    JSON.stringify({
      secret: "private sentinel",
      extra: { a: 1 },
      port: 43100,
      piTailscalePort: 8447,
    }),
  );
  const old = connectionSettings();
  expect(JSON.stringify(old)).not.toContain("private sentinel");
  expect(servicePort()).toBe(43100);
  saveConnectionSettings({ port: 43101, tailscale: false }, old.revision);
  expect(readConfig()).toEqual({
    secret: "private sentinel",
    extra: { a: 1 },
    port: 43101,
    tailscale: false,
    piTailscalePort: 8447,
  });
  expect(() => saveConnectionSettings({ port: 43102 }, old.revision)).toThrow(/changed since/);
  for (const values of [
    { port: 0 },
    { port: "43100" },
    { tailscale: "yes" },
    { piTailscalePort: null },
    { extra: 7 },
  ])
    expect(() => saveConnectionSettings(values, connectionSettings().revision)).toThrow();
  expect(readConfig().port).toBe(43101);
  saveConnectionSettings({ port: null }, connectionSettings().revision);
  expect(readConfig().port).toBeUndefined();
});
it("saves per-classroom and shared daily review limits without replacing unrelated config", () => {
  f.write(
    "test-config.json",
    JSON.stringify({ secret: "private sentinel", port: 43100, dailyReviewLimits: { algebra: 8 } }),
  );
  const old = reviewSettings("rust");
  expect(old.values).toEqual({ limit: null, sharedLimit: null });
  expect(dailyReviewLimit("rust")).toBe(old.defaultLimit);
  saveReviewSettings("rust", { limit: 30, sharedLimit: 20 }, old.revision);
  expect(readConfig()).toEqual({
    secret: "private sentinel",
    port: 43100,
    dailyReviewLimit: 20,
    dailyReviewLimits: { algebra: 8, rust: 30 },
  });
  expect([dailyReviewLimit("rust"), dailyReviewLimit("algebra")]).toEqual([30, 8]);
  expect(() => saveReviewSettings("rust", { limit: 31 }, old.revision)).toThrow(/changed since/);
  // A review save advances the revision the connection form must present.
  expect(connectionSettings().revision).toBe(reviewSettings("rust").revision);
  for (const values of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: "9" }, { port: 1 }])
    expect(() => saveReviewSettings("rust", values, reviewSettings("rust").revision)).toThrow();
  expect(readConfig().dailyReviewLimits).toEqual({ algebra: 8, rust: 30 });
  saveReviewSettings("rust", { limit: null, sharedLimit: null }, reviewSettings("rust").revision);
  saveReviewSettings("algebra", { limit: null }, reviewSettings("algebra").revision);
  expect(readConfig()).toEqual({ secret: "private sentinel", port: 43100 });
});
it("does not repair malformed config or silently choose an occupied port", async () => {
  f.write("test-config.json", "private-config-value-not-json");
  try {
    connectionSettings();
    throw new Error("Expected invalid config");
  } catch (error) {
    expect(String(error)).not.toContain("private-config-value-not-json");
  }
  f.write("test-config.json", "{");
  expect(() => connectionSettings()).toThrow(/Invalid classroom config/);
  expect(() => saveConnectionSettings({ port: 43101 }, "stale")).toThrow();
  expect(fs.readFileSync(path.join(f.root, "test-config.json"), "utf8")).toBe("{");
  f.write("test-config.json", "{}");
  const base = await server.start(0);
  saveConnectionSettings({ port: 43101 }, connectionSettings().revision);
  expect(server.getBaseUrl()).toBe(base);
});
it("preserves unrelated preferences, teacher note indexes, and other classrooms", () => {
  const source =
    "# Notes\n\n## Preferences\n\nKeep examples short.\n- Pace: Fast\n\n## Index\n\n- [Memory](notes/memory.md): sentinel\n\n## Other\nKeep this byte for byte.\n";
  f.write("rust/NOTES.md", source);
  f.write("algebra/NOTES.md", "another classroom");
  const old = learnerPreferences("rust");
  expect(old.values.pace).toBe("Fast");
  saveLearnerPreferences("rust", prefs, old.revision);
  const saved = fs.readFileSync(path.join(f.root, "rust/NOTES.md"), "utf8");
  expect(saved).toContain("Keep examples short.");
  expect(saved.slice(saved.indexOf("## Index"))).toBe(source.slice(source.indexOf("## Index")));
  expect(learnerPreferences("rust").values).toEqual(prefs);
  expect(fs.readFileSync(path.join(f.root, "algebra/NOTES.md"), "utf8")).toBe("another classroom");
  expect(() => saveLearnerPreferences("rust", prefs, old.revision)).toThrow(/changed since/);
  expect(() =>
    saveLearnerPreferences(
      "rust",
      { ...prefs, tone: "bad\n## Index" },
      learnerPreferences("rust").revision,
    ),
  ).toThrow(/tone must/);
});
it("creates only the preference section and rejects ambiguous or unsafe notes", () => {
  saveLearnerPreferences("algebra", prefs, learnerPreferences("algebra").revision);
  expect(fs.readFileSync(path.join(f.root, "algebra/NOTES.md"), "utf8")).toContain("## Index");
  f.write("rust/NOTES.md", "# Notes\n\n## Index\n\n- Keep this index.\n");
  saveLearnerPreferences("rust", prefs, learnerPreferences("rust").revision);
  expect(learnerPreferences("rust").values).toEqual(prefs);
  expect(fs.readFileSync(path.join(f.root, "rust/NOTES.md"), "utf8")).toContain(
    "## Index\n\n- Keep this index.\n",
  );
  f.write("rust/NOTES.md", "## Preferences\n- Pace: one\n- Pace: two\n");
  expect(() => learnerPreferences("rust")).toThrow(/multiple pace/);
  fs.unlinkSync(path.join(f.root, "rust/NOTES.md"));
  fs.symlinkSync(path.join(f.root, "algebra/classroom.json"), path.join(f.root, "rust/NOTES.md"));
  expect(() => learnerPreferences("rust")).toThrow(/symlink/);
});
it("exposes owner-appropriate settings, specific errors and private route guards", async () => {
  server.setHooks({ onAsk() {}, onFollowUp() {}, onQuizSubmit() {}, onReflect() {} });
  const base = await server.start(0);
  const url = `${base}/api/settings?classroom=rust`;
  const initial = await (await fetch(url)).json();
  expect(initial.host).toBe("pi");
  expect(initial.teacher).toBeNull();
  const rejected = await fetch(url, {
    method: "PUT",
    body: JSON.stringify({
      section: "model",
      revision: 0,
      values: { requestedModel: "test-model" },
    }),
  });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).error).toMatch(/attach its persistent teacher/);
  for (const route of [
    "/c/rust/.teacher.json",
    "/c/rust/settings/quiz/key.json",
    "/doc/rust/.teacher.json",
    "/c/rust/001-ownership/quiz/key.json",
  ])
    expect((await fetch(base + route)).status).toBe(404);
  f.write("test-config.json", '{"port":0}');
  const bad = await fetch(url);
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toMatch(/port must be an integer/i);
});
