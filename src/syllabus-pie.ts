/**
 * syllabus-pie.ts — local addition: a coverage pie from the classroom's optional
 * syllabus.json, for the learner's target exam (`target` in syllabus.json, else the
 * last exam listed). Each topic is not seen (no taught lesson), seen (taught), or
 * mastered (taught, and every active review item from its lessons has reached the
 * 21-day box). Topics are weighted by their domain's exam weight, split evenly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { escapeHtml } from "./markdown.ts";
import { classroomDir } from "./paths.ts";
import type { ReviewItem } from "./review.ts";
import type { Lesson } from "./store.ts";

/** Box 3 is the 21-day interval in the 1, 3, 7, 21, 60 day ladder. */
const MASTERED_BOX = 3;

interface Topic {
  name: string;
  lessons?: string[];
}
interface Exam {
  name?: string;
  domains?: { weight?: number; topics?: Topic[] }[];
}

function targetExam(classroom: string): Exam | undefined {
  try {
    const syllabus = JSON.parse(
      fs.readFileSync(path.join(classroomDir(classroom), "syllabus.json"), "utf8"),
    );
    const exams: Exam[] = Array.isArray(syllabus.exams) ? syllabus.exams : [];
    return exams.find((exam) => exam.name === syllabus.target) ?? exams[exams.length - 1];
  } catch {
    return undefined;
  }
}

export function syllabusPie(classroom: string, lessons: Lesson[], items: ReviewItem[]): string {
  const exam = targetExam(classroom);
  const domains = (exam?.domains ?? []).filter((d) => d.topics?.length);
  if (!domains.length) return "";
  const taught = new Set(lessons.filter((l) => l.latestScore !== null).map((l) => l.name));
  const totals = { mastered: 0, seen: 0, unseen: 0 };
  const counts = { mastered: 0, seen: 0, unseen: 0 };
  const weightSum = domains.reduce((sum, d) => sum + (d.weight ?? 1), 0);
  for (const domain of domains) {
    const share = (domain.weight ?? 1) / weightSum / domain.topics!.length;
    for (const topic of domain.topics!) {
      const names = (topic.lessons ?? []).filter((name) => taught.has(name));
      const own = items.filter((i) => i.retiredAt === undefined && names.includes(i.lesson));
      const state = !names.length
        ? "unseen"
        : own.length && own.every((i) => i.box >= MASTERED_BOX)
          ? "mastered"
          : "seen";
      totals[state] += share;
      counts[state]++;
    }
  }
  const topicCount = counts.mastered + counts.seen + counts.unseen;
  const parts = [
    ["mastered", "Mastered"],
    ["seen", "Seen"],
    ["unseen", "Not seen"],
  ] as const;
  const pct = (key: keyof typeof totals) => totals[key] * 100;
  let offset = 25;
  const arcs = parts
    .filter(([key]) => pct(key) > 0)
    .map(([key]) => {
      const arc = `<circle class="cl-pie-${key}" cx="21" cy="21" r="15.91549" fill="none" stroke-width="6" stroke-dasharray="${pct(key)} ${100 - pct(key)}" stroke-dashoffset="${offset}"></circle>`;
      offset -= pct(key);
      return arc;
    })
    .join("");
  const legend = parts
    .map(
      ([key, label]) =>
        `<li><span class="cl-pie-swatch cl-pie-${key}" aria-hidden="true"></span>${label} <strong>${Math.round(pct(key))}%</strong> <span class="cl-pie-count">(${counts[key]} of ${topicCount} topics)</span></li>`,
    )
    .join("");
  const name = escapeHtml(exam?.name ?? "Syllabus");
  return `<section class="cl-section cl-syllabus-pie" aria-label="Syllabus coverage">
  <h2 class="cl-section-title">Syllabus coverage: ${name}</h2>
  <div class="cl-pie-row">
    <svg viewBox="0 0 42 42" class="cl-pie" role="img" aria-label="${escapeHtml(parts.map(([key, label]) => `${label} ${Math.round(pct(key))}%`).join(", "))}">${arcs}</svg>
    <ul class="cl-pie-legend">${legend}</ul>
  </div>
  <p class="cl-progress-note">Weighted by exam domain. Mastered: every review item from the topic's lessons has reached the 21-day interval.</p>
</section>`;
}
