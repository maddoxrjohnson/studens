import { navigationChrome } from "../assets/runtime/navigation.mjs";
import { appearanceHead } from "./appearance.ts";
import { searchPassages } from "./search-passages.ts";
import { icon } from "../assets/runtime/icons.mjs";
import { uiFontHead } from "./ui-assets.ts";
/**
 * pages.ts — the shell pages: landing (all classrooms), classroom (its lessons and
 * documents), and the markdown document view.
 *
 * Pure string builders — they take already-read data and return HTML, so they are
 * testable without a server or a filesystem.
 */

import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { lessonUrl } from "./paths.ts";
import { memoryMapItems, memoryMapSection, memoryTime } from "./memory-map.ts";
import { readConfig } from "./config.ts";
import { syllabusPie } from "./syllabus-pie.ts";
import { missionSummary, renderMission } from "./mission-map.ts";
import {
  defaultReviewSize,
  MAX_REVIEW_SIZE,
  reviewTopic,
  type ReviewItem,
  type ReviewSummary,
} from "./review.ts";
import type { ReviewWorkload } from "./review-workload.ts";
import type { Classroom, ClassroomFolder, Lesson } from "./store.ts";

// ── Shell ─────────────────────────────────────────────────────────────────────

interface ShellOptions {
  title: string;
  /** Rendered into the sticky header, left of the theme toggle. */
  breadcrumb: string;
  body: string;
  /** Page-level class applied to <body>, for layout variants. */
  bodyClass?: string;
}

/**
 * Wrap page content in the common document shell.
 *
 * The theme bootstrap runs inline in <head> deliberately: reading localStorage after
 * the stylesheet has painted would flash the light theme at dark-mode readers.
 */
export function shell(options: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📚</text></svg>">
${appearanceHead()}
${uiFontHead()}
</head>
<body class="cl-app ${escapeHtml(options.bodyClass ?? "cl-shell")}">
${navigationChrome(options.breadcrumb)}
<main class="cl-main">
${options.body}
</main>
<script type="module" src="/static/shell.js"></script>
<script type="module" src="/static/search-source.mjs"></script>
</body>
</html>`;
}

// ── Landing page ──────────────────────────────────────────────────────────────

/**
 * `dueByClassroom` maps a classroom name to how many of its questions are due for
 * review. A classroom that is not in the map has none due.
 */
export function landingPage(
  classrooms: Classroom[],
  dueByClassroom: Record<string, number> = {},
  folders: ClassroomFolder[] = [],
  folderId: string | null = null,
): string {
  const folder = folders.find((f) => f.id === folderId);
  if (folderId !== null && !folder) throw new Error("Unknown classroom folder.");
  const visible = classrooms.filter((c) => (folder ? folder.classrooms.includes(c.name) : true));
  const title = folder?.name ?? "Today";
  const body = `<div data-cl-folders data-folder-id="${escapeHtml(folderId ?? "")}">
<div class="cl-hero">
  <div class="cl-folder-heading"><h1>${escapeHtml(title)}</h1>
    <div class="cl-folder-actions">${folder ? `<button type="button" class="cl-button cl-button-quiet" data-cl-folder-rename>Rename folder</button><button type="button" class="cl-button cl-button-quiet" data-cl-folder-delete>Delete folder</button>` : `<button type="button" class="cl-button cl-button-quiet" data-cl-folder-create>New folder</button>`}</div>
  </div>
  <p class="cl-lede">${folder ? "Keep related classrooms together." : "Pick up where you left off, or start something new with <code>/teach</code>."}</p>
</div>
${!folder ? `<section class="cl-continue cl-card-box" data-cl-continue hidden aria-label="Continue learning"><span class="cl-section-title">Pick up where you left off</span><h2></h2><p></p><a class="cl-button" href="/">Continue lesson</a></section>` : ""}
${!folder ? `<section class="cl-daily-summary" aria-label="Daily review" data-cl-daily><h2>${Object.values(dueByClassroom).reduce((sum, count) => sum + count, 0)} due across classrooms</h2><button type="button" class="cl-button" data-daily-action disabled>Start daily review</button><p class="cl-progress-note" role="status" aria-live="polite" data-daily-status>Checking daily review…</p><a href="/reviews/daily">Daily review history</a><details class="cl-daily-details"><summary>How daily review works</summary><p data-daily-workload>One shared daily allowance bounds new selections across all classrooms, topics, and early reviews. Deferred work stays due.</p></details></section>` : ""}
<section aria-label="${folder ? "Classrooms in folder" : "Classrooms"}">
${!folder ? '<h2 class="cl-section-title">Classrooms</h2>' : ""}
${visible.length ? `<ul class="cl-grid">${visible.map((c) => classroomCard(c, dueByClassroom[c.name] ?? 0, folders.find((f) => f.classrooms.includes(c.name))?.id ?? "")).join("\n")}</ul>` : folder ? '<p class="cl-folder-empty">This folder is empty. Use “Move to folder” on a classroom to add it here.</p>' : emptyState("No classrooms yet", "Ask your agent to teach you a topic (<code>/teach &lt;topic&gt;</code> in Pi) and your first classroom will appear here.")}
</section>
${!folder && folders.length ? `<section aria-label="Folders"><h2 class="cl-section-title">Folders</h2><ul class="cl-grid cl-folder-grid">${folders.map((f) => `<li class="cl-card"><a class="cl-card-link" href="/?folder=${encodeURIComponent(f.id)}"><span class="cl-card-emoji" aria-hidden="true">📁</span><span class="cl-card-body"><span class="cl-card-title">${escapeHtml(f.name)}</span><span class="cl-card-meta">${plural(classrooms.filter((c) => f.classrooms.includes(c.name)).length, "classroom")}</span></span></a></li>`).join("\n")}</ul></section>` : ""}
<dialog class="cl-confirm cl-folder-dialog" aria-labelledby="cl-folder-dialog-title">
  <form data-cl-folder-form>
    <h2 class="cl-confirm-title" id="cl-folder-dialog-title"></h2>
    <p class="cl-confirm-body" data-cl-folder-description></p>
    <label class="cl-folder-field" data-cl-folder-name-label>Folder name
      <input name="name" required maxlength="80" autocomplete="off">
    </label>
    <div class="cl-folder-field" data-cl-folder-select-label>
      <label for="cl-folder-select">Folder</label>
      <select id="cl-folder-select" name="folder"><option value="">Unfiled</option>${folders.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("")}</select>
    </div>
    <p role="alert" class="cl-folder-error" data-cl-folder-error hidden></p>
    <div class="cl-confirm-actions">
      <button type="button" class="cl-button cl-button-quiet" data-cl-folder-cancel>Cancel</button>
      <button type="submit" class="cl-button" data-cl-folder-save>Save</button>
    </div>
  </form>
</dialog>
</div>`;

  return shell({
    title,
    breadcrumb: folder
      ? `<a class="cl-crumb" href="/">Classrooms</a><span class="cl-crumb-sep" aria-hidden="true">/</span><span class="cl-crumb cl-crumb-current">${escapeHtml(folder.name)}</span>`
      : `<span class="cl-crumb cl-crumb-current">Today</span>`,
    body,
  });
}

export function folderLoadErrorPage(message: string, retryUrl: string): string {
  return shell({
    title: "Cannot load classrooms",
    breadcrumb: '<a class="cl-crumb" href="/">Classrooms</a>',
    body: `<div class="cl-hero"><h1>Cannot load classroom folders</h1></div>
<p role="alert">${escapeHtml(message)}</p>
<p>Fix the folder state, then retry loading.</p>
<a class="cl-button cl-button-quiet" href="${escapeHtml(retryUrl)}">Retry loading</a>`,
  });
}

export function reviewLoadErrorPage(message: string, retryUrl: string): string {
  return shell({
    title: "Cannot load review state",
    breadcrumb: '<a class="cl-crumb" href="/">Classrooms</a>',
    body: `<h1>Cannot load review state</h1><p role="alert">${escapeHtml(message)}</p><p>Fix the saved review state, then retry loading.</p><a class="cl-button" href="${escapeHtml(retryUrl)}">Retry loading review state</a>`,
  });
}

function classroomCard(classroom: Classroom, due: number, folderId: string): string {
  const why = missionWhy(classroom.mission);
  return `<li class="cl-card cl-classroom-card">
  <a class="cl-card-link" href="/c/${encodeURIComponent(classroom.name)}">
    <span class="cl-card-emoji" aria-hidden="true">${escapeHtml(classroom.emoji)}</span>
    <span class="cl-card-body">
      <span class="cl-card-title">${escapeHtml(classroom.title)}</span>
      ${why ? `<span class="cl-card-why">${escapeHtml(why)}</span>` : ""}
      <span class="cl-card-meta">${plural(classroom.lessonCount, "lesson")}${due > 0 ? ` · <span class="cl-card-due">${due} due for review</span>` : ""}</span>
    </span>
  </a>
  <details class="cl-classroom-overflow"><summary aria-label="Classroom actions for ${escapeHtml(classroom.title)}" title="Classroom actions"><span aria-hidden="true">⋯</span></summary><button type="button" class="cl-classroom-move" data-current-folder="${escapeHtml(folderId)}" data-cl-move="${escapeHtml(classroom.name)}" data-classroom-title="${escapeHtml(classroom.title)}" aria-label="Move ${escapeHtml(classroom.title)} to folder">Move to folder</button></details>
</li>`;
}

/**
 * Pull the "## Why" paragraph out of MISSION.md for the card subtitle.
 *
 * The mission is the reason the learner cares about the topic, so it is the single
 * most useful line to show on a card — far better than a truncated lesson title.
 */
export function missionWhy(mission: string | null): string | null {
  return missionSummary(mission);
}

// ── Classroom page ────────────────────────────────────────────────────────────

/** What the progress section of the classroom page shows. */
export interface ClassroomProgress {
  review: ReviewSummary;
  workload?: ReviewWorkload;
  /** Lesson name → questions from that lesson that are due for review. */
  dueByLesson: Record<string, number>;
  reteach?: Array<{ lesson: string; prompt: string }>;
  items?: ReviewItem[];
  glossaryTerms: number;
  /** The time the page is built, for "due tomorrow". */
  now: number;
}

export interface ClassroomPageData {
  classroom: Classroom;
  lessons: Lesson[];
  docs: string[];
  learningRecords: string[];
  referenceDocs: string[];
  progress: ClassroomProgress;
}

export function classroomPage(data: ClassroomPageData): string {
  const { classroom } = data;
  const lessons = data.lessons.filter((lesson) => lesson.kind !== "review");

  const lessonList =
    lessons.length === 0
      ? emptyState("No lessons yet", "Choose Next lesson to ask your teacher to create one.")
      : `<ol class="cl-lessons">
${lessons.map((lesson, i) => lessonRow(lesson, i, data.progress.dueByLesson[lesson.name] ?? 0)).join("\n")}
</ol>`;

  const body = `<div class="cl-hero">
  <h1><span class="cl-hero-emoji" aria-hidden="true">${escapeHtml(classroom.emoji)}</span>${escapeHtml(classroom.title)}</h1>
  ${classroom.mission ? `<p class="cl-lede">${escapeHtml(missionWhy(classroom.mission) ?? "")}</p>` : ""}
</div>
${upNext(data)}
${readConfig().syllabusPie === false ? "" : syllabusPie(classroom.name, data.lessons, data.progress.items ?? [])}
<div class="cl-classroom-columns">
<section class="cl-section" aria-label="Lessons"><h2 class="cl-section-title">Lessons</h2>${lessonList}</section>
${memoryMapSection(classroom.name, data.progress.items ?? [], data.progress.now)}
</div>
${progressSection(data)}
<p><a href="/c/${encodeURIComponent(classroom.name)}/course-map">Course map</a> · <a href="/c/${encodeURIComponent(classroom.name)}/reviews">Review history</a> · <a href="/c/${encodeURIComponent(classroom.name)}/settings">Settings</a> · <a href="#cl-export">Export</a></p>
<section class="cl-section">
  <h2 class="cl-section-title">Next lesson</h2>
  <div id="cl-next-lesson" class="cl-next-lesson" data-cl-next-lesson="${escapeHtml(classroom.name)}">
    <label for="cl-next-topic">What would you like to learn next? <span>(optional)</span></label>
    <textarea id="cl-next-topic" rows="2" maxlength="2000" placeholder="Let your teacher choose, or suggest a topic"></textarea>
    <div class="cl-next-actions"><button type="button" class="cl-button" data-cl-next-start disabled>Next lesson</button><a data-cl-next-open hidden>Open lesson</a></div>
    <p class="cl-progress-note" data-cl-next-status role="status" aria-live="polite">Checking lesson status…</p>
  </div>
</section>
${sidePanel(data)}
<section id="cl-export" class="cl-section cl-card-box cl-export-panel" aria-label="Export classroom">
<h2 class="cl-section-title">Export classroom</h2>
<p>Take saved public documents, learning records, notes, released lessons and question threads with you. Private teaching files and unreleased content stay private. Interactive controls are omitted.</p>
<form method="get" action="/api/export" target="_blank" class="cl-export-form">
<input type="hidden" name="classroom" value="${escapeHtml(classroom.name)}">
<label><input type="checkbox" name="answers" value="1"> Include answers already unlocked in Studens</label>
<p class="cl-progress-note">Off by default. Includes only expected answers available under the original grading and corrective rules.</p>
<div class="cl-export-actions">
<button class="cl-button" name="format" value="anki">Download Anki deck</button>
<button class="cl-button cl-button-secondary" name="format" value="markdown">Download Markdown</button>
<button class="cl-button cl-button-secondary" name="format" value="print">Open printable classroom</button>
</div>
</form>
</section>`;

  return shell({
    title: `${classroom.title} — Classrooms`,
    breadcrumb: `<a class="cl-crumb" href="/">Classrooms</a><span class="cl-crumb-sep" aria-hidden="true">/</span><span class="cl-crumb cl-crumb-current">${escapeHtml(classroom.title)}</span>`,
    body,
  });
}

/** Resume only saved work; browser reading history refines this without inventing completion. */
function upNext(data: ClassroomPageData): string {
  const pending = data.lessons.find((l) => l.kind === "lesson" && l.hasUngradedSubmission);
  const due = data.progress.review.due;
  const action = pending ? "resume" : due > 0 ? "review" : "next";
  return `<section class="cl-up-next cl-card-box" aria-label="Up next" data-cl-up-next data-classroom="${escapeHtml(data.classroom.name)}" data-action="${action}">
<h2 class="cl-section-title">Up next</h2>
<p data-cl-up-description>${pending ? escapeHtml(pending.title) : due > 0 ? `${due} items due for review` : "Continue with the next idea in your classroom."}</p>
<div class="cl-up-actions"><a class="cl-button" data-cl-up-resume ${pending ? `href="${lessonUrl(data.classroom.name, pending.name)}"` : "hidden"}>Resume lesson</a><button class="cl-button" type="button" data-cl-up-start ${pending ? "hidden" : "disabled"}>${due > 0 ? "Review due items" : "Start next lesson"}</button>
<a href="#cl-review" ${data.progress.review.total ? "" : "hidden"}>Review options</a><a href="#cl-next-lesson">Choose next topic</a></div>
<div data-cl-up-status></div>
</section>`;
}

/** Review sessions have their own navigation, including unchanged legacy links. */
export function reviewHistoryPage(
  classroom: Classroom,
  reviews: Array<Lesson & { answered: number; questionCount: number }>,
): string {
  return shell({
    title: `Review history — ${classroom.title}`,
    bodyClass: "cl-shell cl-workspace-page",
    breadcrumb: `<a class="cl-crumb" href="/c/${encodeURIComponent(classroom.name)}">${escapeHtml(classroom.title)}</a><span class="cl-crumb-sep" aria-hidden="true">/</span><span class="cl-crumb cl-crumb-current">Review history</span>`,
    body: `<div class="cl-hero"><h1>Review history</h1><p class="cl-lede">Your saved reviews, newest first.</p></div>${
      reviews.length
        ? `<ol class="cl-lessons cl-card-box cl-workspace-list">${reviews
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(
              (review) =>
                `<li class="cl-lesson"><a class="cl-lesson-link" href="${lessonUrl(classroom.name, review.name)}"><span class="cl-lesson-body"><span class="cl-lesson-title">${escapeHtml(review.title)}</span><span class="cl-lesson-summary">${escapeHtml(new Date(review.createdAt).toLocaleDateString("en-US", { timeZone: "UTC" }))}</span></span><span class="cl-lesson-badges">${review.answered}/${review.questionCount} answered${review.hasUngradedSubmission ? " · grading…" : ""}</span></a></li>`,
            )
            .join("")}</ol>`
        : emptyState(
            "No reviews yet",
            "Start a review from the classroom memory map when an item is due.",
          )
    }`,
  });
}

/**
 * The learner's progress: what is due, what evidence is retained, and what they have built.
 *
 * A new classroom explains how saved evidence begins.
 */
function progressSection(data: ClassroomPageData): string {
  const { review, now } = data.progress;
  const work = data.progress.workload;

  return `<section class="cl-section cl-progress" aria-label="Memory map">
  <h2 class="cl-section-title">Memory map</h2>
  <p class="cl-memory-intro">What your saved answers show, and what to revisit next. Teaching coverage and <a href="/c/${encodeURIComponent(data.classroom.name)}/course-map">upcoming objectives</a> live in the course map.</p>
  <details class="cl-scheduling"><summary>How review is scheduled</summary>
  <p class="cl-progress-note">Strength describes evidence, not mastery. Immediate answers, help, notes and high scores alone do not show lasting recall.</p>
  ${work ? `<p class="cl-progress-note" data-review-workload>${work.eligible} due slots available in this classroom today · ${work.used} reserved or used across all classrooms of today's ${work.allowance}-item allowance (daily cap ${work.cap}, all classrooms, UTC). ${work.deferred} due items deferred to later workload windows; they remain due. Next workload window: ${memoryTime(work.nextWindowAt, now)}. Prepared questions are required. Continue unfinished saved reviews. This limit changes workload, never grades or memory evidence.</p>` : ""}
  <p class="cl-progress-note">Early review never extends the scheduled interval. Immediate or assisted answers do not establish retention. Paused and retired items are excluded. Deferred work stays due. Prepared questions are required. Today’s forecast includes items due later today. Later dates show newly due items once, not a plan of completed reviews. Future completions and allocations across classrooms are unknown.</p></details>
  ${(data.progress.reteach ?? []).map((item) => `<p class="cl-progress-note">Review paused after repeated misses: ${escapeHtml(item.prompt)} <a href="/c/${escapeHtml(data.classroom.name)}/${escapeHtml(item.lesson)}#cl-reteach">Open short re-teach</a></p>`).join("")}
  ${
    review.total > 0
      ? `<div id="cl-review" class="cl-review-start" data-cl-review="${escapeHtml(data.classroom.name)}" data-due="${review.due}" data-review-size="${defaultReviewSize()}">
    <div class="cl-review-options">
    <label>Review size<select data-cl-review-size>${Array.from(
      { length: MAX_REVIEW_SIZE - 2 },
      (_, index) => index + 3,
    )
      .map(
        (size) =>
          `<option value="${size}"${size === defaultReviewSize() ? " selected" : ""}>${size === 3 ? "Quick 3" : `${size} items`}</option>`,
      )
      .join("")}</select></label>
    <label>Topic<select data-cl-review-topic><option value="">All topics in this classroom</option>${[
      ...new Map(
        (data.progress.items ?? [])
          .filter((item) => item.retiredAt === undefined)
          .map((item) => {
            const topic = reviewTopic(item);
            return [topic.id, topic];
          }),
      ).values(),
    ]
      .map((topic) => `<option value="${escapeHtml(topic.id)}">${escapeHtml(topic.label)}</option>`)
      .join("")}</select></label>
    <label><input type="checkbox" data-cl-review-early> Review early anyway</label>
    </div>
    <button type="button" class="cl-button" data-cl-review-start disabled>Start review</button>
    <p class="cl-progress-note" data-cl-review-status role="status" aria-live="polite">Checking review status…</p>
    <a data-cl-review-open hidden>Open review</a>
  </div>`
      : ""
  }
${memoryMapItems(data.classroom.name, data.progress.items ?? [], now)}
${(data.progress.items ?? []).length ? `<details class="cl-review-items"><summary>Manage review items</summary><p>Retired items leave active review counts and future selections. Saved answers, grades, and published reviews stay available.</p>${(data.progress.items ?? []).map((item) => `<div class="cl-review-item" data-review-item="${escapeHtml(item.key)}" data-revision="${item.controlRevision ?? 0}" data-retired="${item.retiredAt !== undefined}"><a href="${lessonUrl(data.classroom.name, item.lesson)}">${escapeHtml(item.objective?.statement ?? item.prompt)}</a><span>${item.retiredAt === undefined ? "Active" : "Retired"} · ${item.attempts} saved exposures</span><button class="cl-button" type="button" data-review-retire>${item.retiredAt === undefined ? "Retire item" : "Restore item"}</button><p role="status" data-review-item-status></p></div>`).join("")}</details>` : ""}
</section>`;
}

function lessonRow(lesson: Lesson, index: number, due: number): string {
  const href = `/c/${encodeURIComponent(lesson.classroom)}/${encodeURIComponent(lesson.name)}`;
  const badges: string[] = [];
  if (lesson.kind === "review") {
    badges.push(
      `<span class="cl-badge cl-badge-review" title="Spaced review session">review</span>`,
    );
  }
  if (due > 0) {
    badges.push(
      `<span class="cl-badge cl-badge-due" title="Questions from this lesson due for review">${due} due</span>`,
    );
  }
  if (lesson.latestScore !== null) {
    badges.push(
      `<span class="cl-badge cl-badge-score" title="Quiz score">${Math.round(lesson.latestScore)}%</span>`,
    );
  }
  if (lesson.latestScore === null || lesson.hasUngradedSubmission) {
    badges.push(
      `<span class="cl-badge" data-cl-lesson-status>${lesson.hasUngradedSubmission || lesson.annotationCount > 0 ? "In progress" : "Not started"}</span>`,
    );
  }
  if (lesson.hasUngradedSubmission) {
    badges.push(`<span class="cl-badge cl-badge-pending" title="Awaiting grading">grading…</span>`);
  }
  if (lesson.annotationCount > 0) {
    badges.push(
      `<span class="cl-badge cl-badge-notes" title="Questions you asked">${lesson.annotationCount} Q</span>`,
    );
  }

  return `<li class="cl-lesson" data-cl-lesson-url="${href}" data-in-progress="${lesson.hasUngradedSubmission || lesson.annotationCount > 0}" data-complete="${lesson.latestScore !== null && !lesson.hasUngradedSubmission}">
  <a class="cl-lesson-link" href="${href}">
    <span class="cl-lesson-index">${String(lesson.order ?? index + 1).padStart(2, "0")}</span>
    <span class="cl-lesson-body">
      <span class="cl-lesson-title">${escapeHtml(lesson.title)}</span>
      ${lesson.summary ? `<span class="cl-lesson-summary">${escapeHtml(lesson.summary)}</span>` : ""}
    </span>
    <span class="cl-lesson-badges">${badges.join("")}</span>
  </a>
</li>`;
}

/** How many learning records the classroom page lists before deferring to their page. */
export const RECENT_RECORDS = 5;

function sidePanel(data: ClassroomPageData): string {
  const { classroom, docs, learningRecords, referenceDocs } = data;
  const name = encodeURIComponent(classroom.name);
  const sections: string[] = [];

  if (docs.length > 0) {
    sections.push(
      panel(
        "Workspace",
        docs.map(
          (doc) => `<a href="/doc/${name}/${encodeURIComponent(doc)}">${escapeHtml(doc)}</a>`,
        ),
      ),
    );
  }
  if (referenceDocs.length > 0) {
    sections.push(
      panel(
        "Reference",
        referenceDocs.map(
          (file) =>
            `<a href="/r/${name}/${encodeURIComponent(file)}">${escapeHtml(prettyFileName(file))}</a>`,
        ),
      ),
    );
  }
  if (learningRecords.length > 0) {
    // Records accumulate for as long as the learner keeps going, so the panel shows only
    // the newest few; the full list, with summaries, has a page of its own.
    const recent = learningRecords.slice(-RECENT_RECORDS).reverse();
    sections.push(
      panel("Learning records", [
        ...recent.map(
          (file) =>
            `<a href="/doc/${name}/learning-records/${encodeURIComponent(file)}">${escapeHtml(prettyFileName(file))}</a>`,
        ),
        `<a class="cl-panel-more" href="/doc/${name}/learning-records">All ${plural(learningRecords.length, "record")} →</a>`,
      ]),
    );
  }

  if (sections.length === 0) return "";
  return `<section class="cl-panels">\n${sections.join("\n")}\n</section>`;
}

function panel(title: string, links: string[]): string {
  return `<div class="cl-panel">
  <h2 class="cl-panel-title">${escapeHtml(title)}</h2>
  <ul class="cl-panel-list">
${links.map((link) => `    <li>${link}</li>`).join("\n")}
  </ul>
</div>`;
}

/** `0003-closures-capture-by-value.md` → `Closures capture by value`. */
export function prettyFileName(file: string): string {
  const base = file.replace(/\.(md|html)$/i, "").replace(/^\d+[-_]/, "");
  const words = base.split(/[-_]/).filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── Learning records page ─────────────────────────────────────────────────────

export interface RecordSummary {
  file: string;
  /** The `NNNN` prefix, when the file has one. */
  number: number | null;
  title: string;
  /** First paragraph of the body, flattened to plain text. */
  summary: string | null;
  superseded: boolean;
}

/**
 * Pull a title and one-paragraph summary out of a learning record.
 *
 * Records are a heading and a few sentences (see LEARNING-RECORD-FORMAT.md), so the
 * first paragraph is the record — the page can show it without opening the file.
 */
export function summarizeRecord(file: string, markdown: string): RecordSummary {
  let body = markdown.replace(/\r\n/g, "\n");
  let superseded = false;
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (frontmatter) {
    superseded = /^status:\s*superseded/im.test(frontmatter[1]);
    body = body.slice(frontmatter[0].length);
  }

  const heading = /^#\s+(.+)$/m.exec(body);
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !/^status:/i.test(block));
  const prefix = /^(\d+)[-_]/.exec(file);

  return {
    file,
    number: prefix ? Number(prefix[1]) : null,
    title: heading ? plainText(heading[1]) : prettyFileName(file),
    summary: paragraph ? truncate(plainText(paragraph), 280) : null,
    superseded,
  };
}

/** Flatten the inline markdown a record is likely to use into readable text. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3).trimEnd() + "…" : text;
}

/** Every learning record, newest first — the newest is where the learner is now. */
export function learningRecordsPage(
  classroom: Classroom,
  records: Array<{ file: string; markdown: string }>,
): string {
  const name = encodeURIComponent(classroom.name);
  const summaries = records.map((r) => summarizeRecord(r.file, r.markdown)).reverse();

  const list =
    summaries.length === 0
      ? emptyState(
          "No learning records yet",
          "Your teacher writes one each time you demonstrate you have really learned something.",
        )
      : `<ol class="cl-lessons cl-records cl-card-box cl-workspace-list">
${summaries.map((record, i) => recordRow(name, record, summaries.length - i)).join("\n")}
</ol>`;

  return shell({
    title: `Learning records — ${classroom.title}`,
    bodyClass: "cl-shell cl-workspace-page",
    breadcrumb: `${classroomCrumbs(classroom)}<span class="cl-crumb-sep" aria-hidden="true">/</span><span class="cl-crumb cl-crumb-current">Learning records</span>`,
    body: `<div class="cl-hero">
  <h1>Learning records</h1>
  <p class="cl-lede">What you have actually learned, newest first. ${plural(summaries.length, "record")}.</p>
</div>
${list}`,
  });
}

function recordRow(classroomName: string, record: RecordSummary, fallbackIndex: number): string {
  const href = `/doc/${classroomName}/learning-records/${encodeURIComponent(record.file)}`;
  const badge = record.superseded
    ? `<span class="cl-lesson-badges"><span class="cl-badge" title="Replaced by a later record">superseded</span></span>`
    : "";
  return `<li class="cl-lesson">
  <a class="cl-lesson-link" href="${href}">
    <span class="cl-lesson-index">${String(record.number ?? fallbackIndex).padStart(2, "0")}</span>
    <span class="cl-lesson-body">
      <span class="cl-lesson-title">${escapeHtml(record.title)}</span>
      ${record.summary ? `<span class="cl-lesson-summary">${escapeHtml(record.summary)}</span>` : ""}
    </span>
    ${badge}
  </a>
</li>`;
}

// ── Markdown document page ────────────────────────────────────────────────────

/**
 * A markdown document from the classroom.
 *
 * `parent` adds a crumb between the classroom and the document, for files that live
 * under an index of their own (a learning record, a note).
 */
export function documentPage(
  classroom: Classroom,
  fileName: string,
  markdown: string,
  parent?: { label: string; href: string },
): string {
  const sep = `<span class="cl-crumb-sep" aria-hidden="true">/</span>`;
  const parentCrumb = parent
    ? `${sep}<a class="cl-crumb" href="${escapeHtml(parent.href)}">${escapeHtml(parent.label)}</a>`
    : "";
  return shell({
    title: `${prettyFileName(fileName)} — ${classroom.title}`,
    bodyClass: "cl-shell cl-workspace-page",
    breadcrumb: `${classroomCrumbs(classroom)}${parentCrumb}${sep}<span class="cl-crumb cl-crumb-current">${escapeHtml(prettyFileName(fileName))}</span>`,
    body: `<article class="cl-doc cl-card-box">\n${fileName === "MISSION.md" ? renderMission(markdown) : parent?.href === `/doc/${encodeURIComponent(classroom.name)}/learning-records` ? searchPassages(renderMarkdown(markdown)).html : renderMarkdown(markdown)}\n</article>`,
  });
}

/** `Classrooms / <classroom>` — the start of every page inside a classroom. */
function classroomCrumbs(classroom: Classroom): string {
  return `<a class="cl-crumb" href="/">Classrooms</a><span class="cl-crumb-sep" aria-hidden="true">/</span><a class="cl-crumb" href="/c/${encodeURIComponent(classroom.name)}">${escapeHtml(classroom.title)}</a>`;
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function emptyState(title: string, html: string): string {
  return `<div class="cl-empty">
  <p class="cl-empty-title">${escapeHtml(title)}</p>
  <p class="cl-empty-body">${html}</p>
</div>`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function notFoundPage(message: string): string {
  return shell({
    title: "Not found — Classrooms",
    breadcrumb: `<a class="cl-crumb" href="/">Classrooms</a>`,
    body: emptyState("Not found", escapeHtml(message)),
  });
}

/** Settings load through the validated API so read errors have an explicit retry. */
export function settingsPage(classroom: Classroom): string {
  return shell({
    title: `Settings — ${classroom.title}`,
    bodyClass: "cl-shell cl-workspace-page",
    breadcrumb: `<a class="cl-crumb" href="/">Classrooms</a><span class="cl-crumb-sep" aria-hidden="true">/</span><a class="cl-crumb" href="/c/${encodeURIComponent(classroom.name)}">${escapeHtml(classroom.title)}</a><span class="cl-crumb-sep" aria-hidden="true">/</span><span class="cl-crumb cl-crumb-current">Settings</span>`,
    body: `
<div class="cl-settings" data-cl-settings="${escapeHtml(classroom.name)}">
  <div class="cl-hero"><h1>Settings</h1><p class="cl-lede">Make ${escapeHtml(classroom.title)} work for you.</p></div>
  <section class="cl-settings-section cl-card-box" aria-labelledby="appearance-heading" data-cl-appearance>
    <h2 id="appearance-heading">Appearance</h2>
    <p>Theme and accent apply to all classrooms in this browser on this device.</p>
    <div class="cl-appearance-options"><div><label for="cl-theme-choice">Theme</label><select id="cl-theme-choice" data-cl-theme-choice><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
    <div><label for="cl-accent-choice">Accent</label><select id="cl-accent-choice" data-cl-accent-choice><option value="indigo">Indigo</option><option value="copper">Copper</option><option value="green">Green</option><option value="neutral">Neutral</option></select></div></div>
    <p role="status" data-cl-appearance-status></p>
  </section>
  <p role="alert" data-settings-error hidden></p><button class="cl-button cl-button-quiet" data-settings-load hidden>Reload settings</button>
  <div data-settings-content hidden>
    <section class="cl-settings-section cl-card-box" aria-labelledby="preferences-heading">
      <h2 id="preferences-heading">How you like to learn</h2>
      <p>These preferences guide every lesson in this classroom. Leave a field blank to let your teacher adapt.</p>
      <form data-settings-form="preferences">
        <label>Pace<input name="pace" maxlength="200" placeholder="For example, slower with time to practise" list="pace-ideas"></label>
        <datalist id="pace-ideas"><option value="Slower, with time to practise"><option value="Steady, one idea at a time"><option value="Faster, with fewer pauses"></datalist>
        <label>Depth<input name="depth" maxlength="200" placeholder="For example, detailed explanations and examples" list="depth-ideas"></label>
        <datalist id="depth-ideas"><option value="Concise, focus on the essentials"><option value="Detailed, with worked examples"><option value="Explore the underlying theory"></datalist>
        <label>Tone<input name="tone" maxlength="200" placeholder="For example, direct and encouraging" list="tone-ideas"></label>
        <datalist id="tone-ideas"><option value="Direct and practical"><option value="Warm and encouraging"><option value="Ask questions that help me reason"></datalist>
        <button class="cl-button" type="submit">Save preferences</button><p role="status" data-save-status></p>
      </form>
    </section>
    <section class="cl-settings-section cl-card-box" aria-labelledby="teacher-heading">
      <h2 id="teacher-heading">Your teacher</h2><p data-teacher-owner></p><p role="alert" data-teacher-status-error hidden></p>
      <p data-teacher-active></p><p data-teacher-request></p><p data-teacher-work></p><div role="alert" data-teacher-error hidden></div>
      <form data-settings-form="model" hidden>
        <div><label for="teacher-model">Teacher model</label><select id="teacher-model" name="model"><option value="">Use tool’s configured default</option></select></div>
        <label data-custom-model hidden>Model ID<input name="customModel" maxlength="200" autocomplete="off" placeholder="Enter your configured or custom model ID"></label>
        <p>Changes apply to the next teacher request. Your conversation and grades stay here. Model access is checked when you send a request.</p>
        <p role="alert" data-model-error hidden></p><button class="cl-button cl-button-quiet" type="button" data-model-load>Reload models</button>
        <button class="cl-button" type="submit">Save teacher model</button><p role="status" data-save-status></p>
      </form>
    </section>
    <section class="cl-settings-section cl-card-box" aria-labelledby="connection-heading">
      <h2 id="connection-heading">Connection</h2><p>Shared by your classrooms on this computer.</p><p data-connection-current></p>
      <form data-settings-form="connection">
        <label>Local port<input name="port" type="number" min="1" max="65535" step="1" placeholder="Automatic"></label>
        <p>Local port changes take effect after you stop and restart the classroom server. Get its new link from your agent.</p>
        <label class="cl-settings-check"><input name="tailscale" type="checkbox">Enable Tailscale links while connected</label>
        <p>Only people on your tailnet can use these links. Changes to links apply when you save.</p>
        <label>Service HTTPS port (all hosts)<input name="tailscalePort" type="number" min="1" max="65535" step="1" required></label>
        <label>Legacy Pi HTTPS port (previous live-session package)<input name="piTailscalePort" type="number" min="1" max="65535" step="1" required></label>
        <p data-connection-override></p>
        <button class="cl-button" type="submit">Save connection settings</button><p role="status" data-save-status></p>
      </form>
    </section>
  </div>
</div><script type="module" src="/static/settings.mjs"></script>`,
  });
}
