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
import { examCoverage, targetExam } from "./syllabus.ts";

export function syllabusPie(classroom: string, lessons: Lesson[], items: ReviewItem[]): string {
  let exam, topics;
  try {
    exam = targetExam(
      JSON.parse(fs.readFileSync(path.join(classroomDir(classroom), "syllabus.json"), "utf8")),
    );
    topics = examCoverage(exam, lessons, items);
  } catch {
    return "";
  }
  if (!topics.length) return "";
  const totals = { mastered: 0, seen: 0, unseen: 0 };
  const counts = { mastered: 0, seen: 0, unseen: 0 };
  for (const topic of topics) {
    totals[topic.state] += topic.share;
    counts[topic.state]++;
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
