/**
 * The Claude Code and Codex plugin manifests. They are JSON that no compiler checks, so
 * these tests catch a renamed entry point or a version that drifted from package.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import { MAX_WAIT_SECONDS } from "../src/mcp.ts";
import { packageRoot } from "../src/paths.ts";

const readJson = (relative: string) =>
  JSON.parse(fs.readFileSync(path.join(packageRoot(), relative), "utf8")) as Record<string, any>;

const pkg = readJson("package.json");

describe("Pi package", () => {
  it("declares the extension and packaged teaching skills for native discovery", () => {
    expect(pkg["pi"].extensions).toEqual(["./index.ts"]);
    expect(pkg["pi"].skills).toEqual(["./skills"]);
    for (const entry of pkg["pi"].extensions)
      expect(fs.statSync(path.join(packageRoot(), entry)).isFile()).toBe(true);
    for (const skill of ["teach", "classroom"])
      expect(
        fs.statSync(path.join(packageRoot(), pkg["pi"].skills[0], skill, "SKILL.md")).isFile(),
      ).toBe(true);
  });
});

it.each([".claude-plugin/plugin.json", ".codex-plugin/plugin.json"])(
  "%s keeps the Studens identity, version, and repository in sync",
  (file) => {
    const manifest = readJson(file);
    expect(manifest).toMatchObject({
      name: "studens",
      version: pkg["version"],
      repository: "https://github.com/maddoxrjohnson/studens",
      homepage: pkg["homepage"],
    });
    expect(pkg["name"]).toBe(manifest["name"]);
    expect(pkg["repository"].url).toBe(`git+${manifest["repository"]}.git`);
    const lock = readJson("package-lock.json");
    expect(lock["name"]).toBe(pkg["name"]);
    expect(lock["version"]).toBe(pkg["version"]);
    expect(lock["packages"][""]).toMatchObject({
      name: pkg["name"],
      version: pkg["version"],
      engines: pkg["engines"],
    });
  },
);

describe("Claude Code plugin", () => {
  const manifest = readJson(".claude-plugin/plugin.json");

  it("runs the MCP launcher from the plugin root", () => {
    expect(manifest["mcpServers"].classroom.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/mcp/launch.mjs"]);
    expect(fs.existsSync(path.join(packageRoot(), "mcp/launch.mjs"))).toBe(true);
  });

  it("lets the longest wait_for_learner call finish", () => {
    expect(manifest["mcpServers"].classroom.timeout).toBeGreaterThan(MAX_WAIT_SECONDS * 1000);
  });

  it("is listed by the marketplace at the repository root", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(marketplace["name"]).toBe(manifest["name"]);
    expect(marketplace["plugins"]).toEqual([
      expect.objectContaining({
        name: manifest["name"],
        source: {
          source: "url",
          url: "https://github.com/maddoxrjohnson/studens.git",
          ref: `v${manifest["version"]}`,
        },
      }),
    ]);
  });
});

describe("Codex plugin", () => {
  const manifest = readJson(".codex-plugin/plugin.json");

  it("runs the MCP launcher and forwards the classroom settings", () => {
    const mcp = readJson(manifest["mcpServers"]);
    expect(mcp["mcpServers"].classroom).toMatchObject({
      args: ["./mcp/launch.mjs"],
      cwd: ".",
      env_vars: [
        "PI_CLASSROOMS_DIR",
        "PI_CLASSROOM_CONFIG",
        "PI_CLASSROOM_SERVICE_PORT",
        "PI_CLASSROOM_TAILSCALE",
        "PI_CLASSROOM_TEACHER",
        "PI_CODING_AGENT_DIR",
      ],
    });
  });

  it("lets the longest wait_for_learner call finish", () => {
    const mcp = readJson(manifest["mcpServers"]);
    expect(mcp["mcpServers"].classroom.tool_timeout_sec).toBeGreaterThan(MAX_WAIT_SECONDS);
  });

  it("is listed by the marketplace at the repository root", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json");
    expect(marketplace["name"]).toBe(manifest["name"]);
    expect(marketplace["plugins"]).toEqual([
      expect.objectContaining({
        name: manifest["name"],
        source: {
          source: "url",
          url: "https://github.com/maddoxrjohnson/studens.git",
          ref: `v${manifest["version"]}`,
        },
      }),
    ]);
  });
});

describe("skills", () => {
  it.each(["teach", "classroom"])("%s names only tools the MCP server lists", (skill) => {
    const body = fs.readFileSync(path.join(packageRoot(), "skills", skill, "SKILL.md"), "utf8");
    expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
    const tools = [...body.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1])
      .filter((t) => t.includes("_"));
    const known = [
      "answer_lesson_question",
      "begin_teaching",
      "grade_lesson_quiz",
      "lesson_health",
      "list_classrooms",
      "open_classroom",
      "resume_lesson_teacher",
      "record_retrieval_check",
      "scaffold_classroom",
      "scaffold_lesson",
      "scaffold_review",
      "wait_for_learner",
      "classroom_service",
    ];
    for (const tool of tools) expect(known).toContain(tool);
  });
});
