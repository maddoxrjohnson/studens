import { appearanceHead } from "./appearance.ts";
/**
 * lesson-html.ts — wire a lesson document up to the classroom runtime at serve time.
 *
 * Lessons on disk are plain, self-contained HTML: open one in a browser directly and
 * it still reads fine. Everything interactive (highlight-to-ask, quiz submission,
 * theming) is injected here, so a lesson authored months ago picks up runtime fixes
 * without being rewritten.
 */

import { readConfig } from "./config.ts";
import { toScriptJson } from "./markdown.ts";
import { uiFontHead } from "./ui-assets.ts";

export interface LessonRuntimeConfig {
  classroom: string;
  lesson: string;
  classroomTitle: string;
  lessonTitle: string;
  baseUrl: string;
  delivery?: "push" | "wait" | "service";
  pendingPretests?: string[];
  reviewScreen?: boolean;
  /** Local preference: the page omits the assistance and confidence reports. */
  hideAnswerReports?: boolean;
  prerequisites?: { title: string; url: string }[];
  prerequisiteError?: string;
}

function bodyInjection(config: LessonRuntimeConfig): string {
  return `<script type="application/json" id="cl-config">${toScriptJson(config)}</script>
<script type="module" src="/static/classroom.js"></script>`;
}

/** Insert `snippet` before the first `</head>`, or fall back to prepending it. */
function insertInHead(html: string, snippet: string): string {
  const idx = html.search(/<\/head\s*>/i);
  if (idx !== -1) return html.slice(0, idx) + snippet + "\n" + html.slice(idx);

  // No <head> — try after <body>, else prepend. Lessons are model-authored and a
  // stray fragment must still render rather than 500.
  const bodyIdx = html.search(/<body[^>]*>/i);
  if (bodyIdx !== -1) {
    const end = html.indexOf(">", bodyIdx) + 1;
    return html.slice(0, end) + "\n" + snippet + html.slice(end);
  }
  return snippet + "\n" + html;
}

/** Insert `snippet` before the last `</body>`, or append it. */
function insertBeforeBodyEnd(html: string, snippet: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx !== -1) return html.slice(0, idx) + snippet + "\n" + html.slice(idx);
  return html + "\n" + snippet;
}

/**
 * Add the classroom runtime to a lesson document.
 *
 * Idempotent: a lesson that already links the runtime (because the model copied a
 * served page back to disk) is returned unchanged rather than double-wired.
 */
export function injectLessonRuntime(html: string, config: LessonRuntimeConfig): string {
  if (readConfig().hideAnswerReports) config = { ...config, hideAnswerReports: true };
  if (html.includes('id="cl-config"')) {
    if (!html.includes('href="/static/ui-fonts.css"')) html = insertInHead(html, uiFontHead());
    return html.replace(
      /<script\b[^>]*\bid="cl-config"[^>]*>[\s\S]*?<\/script\s*>/i,
      () => `<script type="application/json" id="cl-config">${toScriptJson(config)}</script>`,
    );
  }
  if (config.reviewScreen)
    html = html.replace(/<body\b([^>]*)>/i, "<body$1 data-cl-review-screen>");
  return insertBeforeBodyEnd(
    insertInHead(
      html,
      `${appearanceHead()}
${uiFontHead()}`,
    ),
    bodyInjection(config),
  );
}
