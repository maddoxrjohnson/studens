/**
 * Read-only snapshot of a classrooms directory: lessons, quiz validity, review items and
 * what is due at a fixed time. Run it with the old and new build over a COPY of the data
 * and compare the output.
 *
 *   PI_CLASSROOMS_DIR=/copy node scripts/classroom-snapshot.ts [now-ms] > snapshot.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isDue } from "../src/review.ts";
import { lessonDir } from "../src/paths.ts";
import { parseRubric } from "../src/rubric.ts";
import { parseTeachingPlan } from "../src/teaching-plan.ts";
import * as store from "../src/store.ts";

export const SNAPSHOT_NOW = Date.UTC(2026, 9, 28);

function quizError(classroom: string, lesson: store.Lesson): string | null {
  const dir = lessonDir(classroom, lesson.name);
  const key = path.join(dir, "quiz", "key.json");
  if (!fs.existsSync(key)) return null;
  try {
    const text = fs.readFileSync(key, "utf8");
    const page = lesson as unknown as Record<string, unknown>;
    // Legacy (unmarked) lessons are graded by the teacher; only marked lessons are machine-parsed,
    // exactly as when the server accepts a submission.
    if (page.assessmentContract !== 1) {
      JSON.parse(text);
      return null;
    }
    const html = fs.readFileSync(lesson.htmlPath, "utf8");
    parseRubric(text, html, "machine", page.criterionContract === 1);
    if (page.instructionalContract === 1)
      parseTeachingPlan(fs.readFileSync(path.join(dir, "quiz", "plan.json"), "utf8"), html);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function snapshot(now = SNAPSHOT_NOW) {
  const result: Record<string, unknown> = {};
  for (const classroom of store.listClassrooms()) {
    const lessons = store.listLessons(classroom.name);
    const items = store.reviewItems(classroom.name);
    result[classroom.name] = {
      title: classroom.title,
      lessons: lessons.map((l) => ({
        name: l.name,
        title: l.title,
        latestScore: l.latestScore,
        quizError: quizError(classroom.name, l),
      })),
      items: items
        .map((i) => ({ key: i.key, box: i.box, dueAt: i.dueAt, retired: i.retiredAt ?? null }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      due: items
        .filter((i) => i.retiredAt === undefined && isDue(i, now))
        .map((i) => i.key)
        .sort(),
    };
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.stdout.write(JSON.stringify(snapshot(Number(process.argv[2]) || SNAPSHOT_NOW), null, 1));
}
