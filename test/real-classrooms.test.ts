/**
 * Regression check against a COPY of real classrooms. Skipped unless STUDENS_CLASSROOMS_COPY
 * names a directory; it refuses the live classrooms directory. Set STUDENS_CLASSROOMS_BASELINE
 * to a snapshot made by the previous build (scripts/classroom-snapshot.ts) to also prove that
 * review scheduling is unchanged.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshot } from "../scripts/classroom-snapshot.ts";
import { _overrideClassroomsDir, classroomsRoot } from "../src/paths.ts";
import { handleClassroomRoute } from "../src/server/classrooms.ts";

const copy = process.env.STUDENS_CLASSROOMS_COPY;
const live = path.join(os.homedir(), ".pi", "agent", "classrooms");

function digest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile())
        hash.update(path.relative(root, file) + "\0" + fs.readFileSync(file));
    }
  };
  walk(root);
  return hash.digest("hex");
}

describe.skipIf(!copy)("real classrooms copy", () => {
  let before = "";
  let previousRoot = "";
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    if (!copy || path.resolve(copy) === live || fs.realpathSync(copy) === fs.realpathSync(live))
      throw new Error("STUDENS_CLASSROOMS_COPY must be a copy, never the live classrooms.");
    before = digest(copy);
    previousRoot = classroomsRoot();
    _overrideClassroomsDir(copy);
    server = http.createServer((req, res) => {
      const rest = new URL(req.url!, "http://x").pathname.split("/").filter(Boolean).slice(1);
      handleClassroomRoute(res, rest, null);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    server?.close();
    _overrideClassroomsDir(previousRoot);
  });

  it("loads every lesson and validates every quiz", () => {
    const snap = snapshot() as Record<
      string,
      { lessons: { name: string; quizError: string | null }[] }
    >;
    expect(Object.keys(snap).length).toBeGreaterThan(0);
    const errors = Object.entries(snap).flatMap(([c, v]) =>
      v.lessons.filter((l) => l.quizError).map((l) => `${c}/${l.name}: ${l.quizError}`),
    );
    expect(errors).toEqual([]);
  });

  it("renders every classroom page", async () => {
    const snap = snapshot() as Record<string, { title: string; lessons: { title: string }[] }>;
    for (const [name, c] of Object.entries(snap)) {
      const res = await fetch(`${base}/c/${name}`);
      expect(res.status, name).toBe(200);
      const html = await res.text();
      for (const lesson of c.lessons.slice(0, 3)) expect(html).toContain(lesson.title.slice(0, 20));
      if (fs.existsSync(path.join(copy!, name, "syllabus.json")))
        expect(html, `${name} pie`).toContain("cl-syllabus-pie");
    }
  });

  it.skipIf(!process.env.STUDENS_CLASSROOMS_BASELINE)(
    "schedules the same review items and due list as the baseline build",
    () => {
      const baseline = JSON.parse(
        fs.readFileSync(process.env.STUDENS_CLASSROOMS_BASELINE!, "utf8"),
      );
      expect(JSON.parse(JSON.stringify(snapshot()))).toEqual(baseline);
    },
  );

  it("leaves the data byte-identical", () => {
    expect(digest(copy!)).toBe(before);
  });
});
