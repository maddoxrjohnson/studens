import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeFixture, seedClassroom, termAnswer, type Fixture } from "./helpers.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { readTeacherState } from "../src/service-state.ts";
import * as store from "../src/store.ts";
import * as server from "../src/server.ts";
import type { TeacherPlan } from "../src/teacher.ts";

let f: Fixture;
const START = "<!-- studens:progress:start -->";
const END = "<!-- studens:progress:end -->";
const gradePlan = (id: string): TeacherPlan => ({
  calls: [
    {
      name: "grade_quiz_answers",
      arguments_json: JSON.stringify({
        submission_id: id,
        feedback_markdown: "Check the owner.",
        questions: [{ question_id: "q1", correct: false, feedback: "The owner releases it." }],
      }),
    },
  ],
  message: "What happens with a second example?",
  learning_record: "",
  notes_markdown: "",
});
const submit = () =>
  store.createSubmission({
    classroom: "rust",
    lesson: "001-ownership",
    quizId: "check-1",
    quizTitle: "Ownership",
    kind: "check",
    answers: [termAnswer("q1", "forever")],
  });
const grades = () => store.listGrades("rust", "001-ownership");
const syllabus = (extra: object) =>
  JSON.stringify({
    exams: [{ name: "EX", domains: [{ topics: [{ name: "1.1 Owner" }, { name: "1.1 Again" }] }] }],
    ...extra,
  });
beforeEach(() => {
  f = makeFixture();
  seedClassroom(f);
  f.write("rust/001-ownership/quiz/key.json", '{"q1":"dropped"}');
});
afterEach(async () => {
  await server.close();
  f.cleanup();
});

it.each([
  ["duplicate and unnamed topics", syllabus({ odd: [{ name: 3 }] })],
  ["malformed JSON", "{not json"],
])("grades normally when syllabus.json has %s and no plan", async (_label, text) => {
  f.write("rust/syllabus.json", text);
  const s = submit();
  const teacher = new TeacherService(async () => gradePlan(s.id));
  teacher.attach("rust", "codex");
  await teacher.idle();
  await teacher.stop();
  expect(readTeacherState("rust")!.requests.find((r) => r.target === s.id)!.status).toBe("done");
  expect(grades()).toHaveLength(1);
});

it("keeps one grade when the block refresh fails and refreshes on the retry's skip path", async () => {
  f.write(
    "rust/syllabus.json",
    JSON.stringify({
      plan: "notes/plan.md",
      exams: [{ name: "EX", domains: [{ topics: [{ name: "1.1 Owner" }] }] }],
    }),
  );
  const plan = f.write("rust/notes/plan.md", `# Plan\n${END}\n${START}\n`);
  const s = submit();
  let turns = 0;
  const teacher = new TeacherService(async () => {
    turns++;
    return gradePlan(s.id);
  });
  teacher.attach("rust", "codex");
  await teacher.idle();
  const failed = readTeacherState("rust")!.requests.find((r) => r.target === s.id)!;
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatch(/grade was saved.*markers/);
  expect(failed.planValidated).toBe(true);
  expect(grades()).toHaveLength(1);

  fs.writeFileSync(plan, "# Plan\n");
  teacher.retry("rust", failed.id);
  await teacher.idle();
  await teacher.stop();
  expect(readTeacherState("rust")!.requests.find((r) => r.id === failed.id)!.status).toBe("done");
  expect(grades()).toHaveLength(1);
  expect(turns).toBe(1);
  expect(fs.readFileSync(path.join(f.root, "rust/notes/plan.md"), "utf8")).toMatch(
    /\[x\] 001 .*check 0%/,
  );
});
