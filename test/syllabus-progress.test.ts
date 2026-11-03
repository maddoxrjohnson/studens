import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeFixture, seedClassroom, seedPreparedReviewSource } from "./helpers.ts";
import type { Fixture } from "./helpers.ts";
import { nextLessonDocument, nextLessonReceipt } from "./next-lesson-fixture.ts";
import {
  completeLessonRequest,
  lessonRequests,
  prepareLessonRetry,
  saveLessonDocument,
  startLessonRequest,
  updateLessonRequest,
} from "../src/next-lesson.ts";
import type { LessonDocument } from "../src/next-lesson.ts";
import { refreshProgress, syllabusCoverage } from "../src/syllabus.ts";

const START = "<!-- studens:progress:start -->";
const END = "<!-- studens:progress:end -->";
const syllabus = (plan?: string) =>
  JSON.stringify(
    {
      target: "EX",
      ...(plan ? { plan } : {}),
      exams: [
        {
          name: "EX",
          domains: [
            {
              name: "Design",
              weight: 60,
              topics: [
                { name: "1.1 Ownership", lessons: ["001-ownership"] },
                { name: "1.2 Moves" },
              ],
            },
            { name: "Ops", weight: 40, topics: [{ name: "2.1 Drop" }] },
          ],
        },
      ],
      extra: { keep: true },
    },
    null,
    2,
  ) + "\n";

let fixture: Fixture;
const file = (name: string) => path.join(fixture.root, "rust", name);
beforeEach(() => {
  fixture = makeFixture();
  seedClassroom(fixture);
  seedPreparedReviewSource(fixture.root);
});
afterEach(() => fixture.cleanup());

function checked(document: LessonDocument) {
  const request = startLessonRequest("rust", randomUUID(), "", "codex", "service");
  const saved = saveLessonDocument(request, document);
  return updateLessonRequest(saved, {
    status: "running",
    pageCheck: {
      hash: createHash("sha256").update(JSON.stringify(document)).digest("hex"),
      report: nextLessonReceipt(saved, document),
    },
  });
}

it("rejects an unknown syllabus skill before saving the plan or writing any file", () => {
  fixture.write("rust/syllabus.json", syllabus());
  const before = fs.readFileSync(file("syllabus.json"));
  const request = startLessonRequest("rust", randomUUID(), "", "codex", "service");
  const document = { ...nextLessonDocument(fixture.root), syllabus_skills: ["1.2", "9.9"] };
  expect(() => saveLessonDocument(request, document)).toThrow(/9\.9.*EX/);
  expect(() =>
    saveLessonDocument(request, { ...nextLessonDocument(fixture.root), syllabus_skills: null }),
  ).toThrow(/array/);
  expect(lessonRequests("rust")[0].document).toBeUndefined();
  expect(fs.existsSync(file(request.lesson))).toBe(false);
  expect(fs.readFileSync(file("syllabus.json"))).toEqual(before);
});

it("records published skills idempotently and keeps other syllabus content", async () => {
  fixture.write("rust/syllabus.json", syllabus());
  const saved = checked({ ...nextLessonDocument(fixture.root), syllabus_skills: ["1.2", "2.1"] });
  await completeLessonRequest(saved);
  const once = fs.readFileSync(file("syllabus.json"), "utf8");
  const parsed = JSON.parse(once);
  expect(parsed.extra).toEqual({ keep: true });
  expect(parsed.exams[0].domains[0].topics[0].lessons).toEqual(["001-ownership"]);
  expect(parsed.exams[0].domains[0].topics[1].lessons).toEqual([saved.lesson]);
  expect(parsed.exams[0].domains[1].topics[0].lessons).toEqual([saved.lesson]);
  // Recovery after a crash before "done" re-runs the whole completion.
  updateLessonRequest(saved, { status: "running" });
  await completeLessonRequest(saved);
  expect(fs.readFileSync(file("syllabus.json"), "utf8")).toBe(once);
  expect(lessonRequests("rust")[0].status).toBe("done");
});

it("publishes a legacy plan without syllabus_skills and leaves syllabus.json untouched", async () => {
  fixture.write("rust/syllabus.json", syllabus());
  const before = fs.readFileSync(file("syllabus.json"));
  const { syllabus_skills: _absent, ...legacy } = nextLessonDocument(fixture.root);
  const saved = checked(legacy);
  await completeLessonRequest(saved);
  expect(lessonRequests("rust")[0].status).toBe("done");
  expect(fs.readFileSync(file("syllabus.json"))).toEqual(before);
});

it("regenerates only the marked block and writes no plan without a plan key", async () => {
  const head = "# Plan\r\n\r\n- [ ] 001 by hand\n";
  const tail = "\n## Later\nKeep this.";
  fixture.write("rust/notes/curriculum-plan.md", `${head}${START}\nstale\n${END}${tail}`);
  fixture.write("rust/syllabus.json", syllabus());
  const untouched = fs.readFileSync(file("notes/curriculum-plan.md"));
  const saved = checked({ ...nextLessonDocument(fixture.root), syllabus_skills: ["1.2"] });
  await completeLessonRequest(saved);
  expect(fs.readFileSync(file("notes/curriculum-plan.md"))).toEqual(untouched);

  fixture.write("rust/syllabus.json", syllabus("notes/curriculum-plan.md"));
  refreshProgress("rust");
  const text = fs.readFileSync(file("notes/curriculum-plan.md"), "utf8");
  expect(text.startsWith(`${head}${START}\n`)).toBe(true);
  expect(text.endsWith(`\n${END}${tail}`)).toBe(true);
  expect(text).not.toContain("stale");
  expect(text).toContain(saved.lesson.slice(0, 3));
  refreshProgress("rust");
  expect(fs.readFileSync(file("notes/curriculum-plan.md"), "utf8")).toBe(text);

  fixture.write("rust/notes/curriculum-plan.md", `${head}${END}\n${START}\n`);
  const broken = fs.readFileSync(file("notes/curriculum-plan.md"));
  expect(() => refreshProgress("rust")).toThrow(/markers/);
  expect(fs.readFileSync(file("notes/curriculum-plan.md"))).toEqual(broken);
});

it("appends the block after the existing text when the markers are missing", () => {
  fixture.write("rust/notes/curriculum-plan.md", "# Plan\n");
  fixture.write("rust/syllabus.json", syllabus("notes/curriculum-plan.md"));
  refreshProgress("rust");
  const text = fs.readFileSync(file("notes/curriculum-plan.md"), "utf8");
  expect(text.startsWith(`# Plan\n\n${START}\n`)).toBe(true);
  expect(text.endsWith(`${END}\n`)).toBe(true);
});

it("refuses a plan path outside the classroom's public markdown", () => {
  for (const plan of ["../x.md", ".teacher.md", "notes/plan.txt", "001-ownership/quiz/x.md"]) {
    fixture.write("rust/syllabus.json", syllabus(plan));
    expect(() => refreshProgress("rust"), plan).toThrow(/plan/);
  }
});

it("drops a saved plan on explicit retry when syllabus.json no longer has its topics", async () => {
  fixture.write("rust/syllabus.json", syllabus());
  const saved = checked({ ...nextLessonDocument(fixture.root), syllabus_skills: ["1.2"] });
  fixture.write("rust/syllabus.json", syllabus().replace("1.2 Moves", "1.3 Moves"));
  await expect(completeLessonRequest(saved)).rejects.toThrow(/1\.2/);
  const failed = lessonRequests("rust")[0];
  expect(failed.syllabusCheckFailed).toBe(true);
  expect(fs.existsSync(file(saved.lesson))).toBe(false);
  const retried = prepareLessonRetry(updateLessonRequest(failed, { status: "failed" }));
  expect(retried.document).toBeUndefined();
  expect(retried.rejectedDocuments).toHaveLength(1);
});

it("identifies numbered topics by number and other topics by their whole name", () => {
  fixture.write(
    "rust/syllabus.json",
    JSON.stringify({
      exams: [
        {
          domains: [
            { topics: [{ name: "Exercise 3: Outfoxed" }, { name: "Exercise 4: Buddy" }] },
            { topics: [{ name: "1.3.2 Choose a store" }] },
          ],
        },
      ],
    }),
  );
  expect(syllabusCoverage("rust")!.topics.map((t) => t.id)).toEqual([
    "Exercise 3: Outfoxed",
    "Exercise 4: Buddy",
    "1.3.2",
  ]);
});

it("keeps a saved plan when syllabus.json is unreadable or its files are already published", async () => {
  fixture.write("rust/syllabus.json", syllabus());
  const saved = checked({ ...nextLessonDocument(fixture.root), syllabus_skills: ["1.2"] });
  fixture.write("rust/syllabus.json", "{not json");
  await expect(completeLessonRequest(saved)).rejects.toThrow(/not valid JSON/);
  expect(lessonRequests("rust")[0].syllabusCheckFailed).toBeUndefined();
  expect(prepareLessonRetry(lessonRequests("rust")[0]).document).toBeDefined();

  fixture.write("rust/syllabus.json", syllabus());
  await completeLessonRequest(saved);
  // A crash after the files were written, then syllabus.json lost the topic.
  updateLessonRequest(saved, { status: "running" });
  fixture.write("rust/syllabus.json", syllabus().replace("1.2 Moves", "1.3 Moves"));
  await expect(completeLessonRequest(saved)).rejects.toThrow(/1\.2/);
  expect(lessonRequests("rust")[0].syllabusCheckFailed).toBeUndefined();
  expect(prepareLessonRetry(lessonRequests("rust")[0]).document).toBeDefined();
});
