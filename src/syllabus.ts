/**
 * syllabus.ts — the classroom's optional syllabus.json: target-exam topic coverage
 * for the pie and the Next lesson prompt, the lesson → topic mapping written on
 * publication, and the generated progress block in the optional curriculum plan.
 *
 * Target exam = `target` in syllabus.json, else the last exam listed. A topic id is the
 * leading whitespace-delimited token of its name ("1.3.2 Choose ..." → "1.3.2"). A topic
 * is not seen (no listed lesson has a non-pretest grade), seen, or mastered (seen, and
 * every active review item from its seen lessons has reached the 21-day box).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { classroomDir, isFile, isStoredReview, safeJoin, safeStaticFile } from "./paths.ts";
import { kindOf } from "./quiz.ts";
import type { ReviewItem } from "./review.ts";
import * as store from "./store.ts";
import type { Lesson } from "./store.ts";

/** Box 3 is the 21-day interval in the 1, 3, 7, 21, 60 day ladder. */
const MASTERED_BOX = 3;
const START = "<!-- studens:progress:start -->";
const END = "<!-- studens:progress:end -->";

interface Topic {
  name: string;
  lessons?: string[];
}
interface Domain {
  name?: string;
  weight?: number;
  topics?: Topic[];
}
interface Exam {
  name?: string;
  domains?: Domain[];
}
interface Syllabus {
  target?: string;
  plan?: string;
  exams?: Exam[];
}
export type TopicState = "unseen" | "seen" | "mastered";
export interface TopicCoverage {
  id: string;
  name: string;
  domain: string;
  domainIndex: number;
  /** Share of the exam: the domain's weight split evenly across its topics. */
  share: number;
  state: TopicState;
  lessons: string[];
}

export function targetExam(syllabus: Syllabus): Exam | undefined {
  const exams = Array.isArray(syllabus.exams) ? syllabus.exams : [];
  return exams.find((exam) => exam.name === syllabus.target) ?? exams[exams.length - 1];
}

/** A numbered name ("1.3.2 Choose ...") is identified by its number, else by the whole name. */
export function topicId(topic: Topic): string {
  if (typeof topic.name !== "string") return "";
  const name = topic.name.trim(),
    lead = name.split(/\s+/)[0];
  return /^\d+(\.\d+)*$/.test(lead) ? lead : name;
}

/** Per-topic coverage of an exam. Lessons supply taught state; items supply mastery. */
export function examCoverage(
  exam: Exam | undefined,
  lessons: Lesson[],
  items: ReviewItem[],
): TopicCoverage[] {
  const domains = (exam?.domains ?? [])
    .map((domain, index) => ({ domain, index }))
    .filter(({ domain }) => domain.topics?.length);
  const taught = new Set(lessons.filter((l) => l.latestScore !== null).map((l) => l.name));
  const weightSum = domains.reduce((sum, { domain }) => sum + (domain.weight ?? 1), 0);
  return domains.flatMap(({ domain, index }) =>
    domain.topics!.map((topic) => {
      const names = (topic.lessons ?? []).filter((name) => taught.has(name));
      const own = items.filter((i) => i.retiredAt === undefined && names.includes(i.lesson));
      const state: TopicState = !names.length
        ? "unseen"
        : own.length && own.every((i) => i.box >= MASTERED_BOX)
          ? "mastered"
          : "seen";
      return {
        id: topicId(topic),
        name: typeof topic.name === "string" ? topic.name : "",
        domain: domain.name ?? `Domain ${index + 1}`,
        domainIndex: index,
        share: (domain.weight ?? 1) / weightSum / domain.topics!.length,
        state,
        lessons: topic.lessons ?? [],
      };
    }),
  );
}

/** Reverse map: lesson directory → ids of the topics that list it. */
export function lessonTopics(topics: TopicCoverage[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const topic of topics)
    for (const lesson of topic.lessons) map.set(lesson, [...(map.get(lesson) ?? []), topic.id]);
  return map;
}

function syllabusFile(classroom: string): string {
  return path.join(classroomDir(classroom), "syllabus.json");
}

/** The `plan` path when syllabus.json opts in, read loosely: any other content is ignored here. */
export function syllabusPlan(classroom: string): string | undefined {
  const file = syllabusFile(classroom);
  try {
    if (!fs.lstatSync(file).isFile()) return undefined;
    const plan = JSON.parse(fs.readFileSync(file, "utf8"))?.plan;
    return typeof plan === "string" ? plan : undefined;
  } catch {
    return undefined;
  }
}

/** Strictly read syllabus.json. Null only when the classroom has none. */
export function readSyllabus(classroom: string): { syllabus: Syllabus; exam: Exam } | null {
  const file = syllabusFile(classroom);
  if (!fs.existsSync(file) && !isSymlink(file)) return null;
  const where = `${classroom}/syllabus.json`;
  if (!safeStaticFile(classroomDir(classroom), "syllabus.json") || !isFile(file))
    throw new Error(`${where} must be a regular file, not a symlink.`);
  let syllabus: Syllabus;
  try {
    syllabus = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${where} is not valid JSON: ${(error as Error).message}`);
  }
  if (!syllabus || typeof syllabus !== "object" || Array.isArray(syllabus))
    throw new Error(`${where} must hold a JSON object.`);
  if (syllabus.exams !== undefined && !Array.isArray(syllabus.exams))
    throw new Error(`${where}: exams must be an array.`);
  if (syllabus.plan !== undefined && typeof syllabus.plan !== "string")
    throw new Error(`${where}: plan must be a classroom-relative markdown path.`);
  const exam = targetExam(syllabus);
  if (exam === undefined) return { syllabus, exam: {} };
  if (!exam || typeof exam !== "object" || Array.isArray(exam))
    throw new Error(`${where}: each exam must be an object.`);
  const label = `${where} exam ${JSON.stringify(exam.name ?? "(unnamed)")}`;
  if (exam.domains !== undefined && !Array.isArray(exam.domains))
    throw new Error(`${label}: domains must be an array.`);
  const ids = new Set<string>();
  for (const domain of exam.domains ?? []) {
    if (!domain || typeof domain !== "object" || Array.isArray(domain))
      throw new Error(`${label}: each domain must be an object.`);
    if (domain.weight !== undefined && !(typeof domain.weight === "number" && domain.weight >= 0))
      throw new Error(`${label}: domain weight must be a nonnegative number.`);
    if (domain.topics !== undefined && !Array.isArray(domain.topics))
      throw new Error(`${label}: domain topics must be an array.`);
    for (const topic of domain.topics ?? []) {
      if (!topic || typeof topic.name !== "string" || !topic.name.trim())
        throw new Error(`${label}: each topic needs a nonblank name.`);
      if (
        topic.lessons !== undefined &&
        !(Array.isArray(topic.lessons) && topic.lessons.every((l) => typeof l === "string"))
      )
        throw new Error(`${label}: topic ${topic.name} lessons must be an array of strings.`);
      const id = topicId(topic);
      if (ids.has(id)) throw new Error(`${label} lists topic id ${id} more than once.`);
      ids.add(id);
    }
  }
  return { syllabus, exam };
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Target-exam coverage from disk, or null when the classroom has no syllabus topics. */
export function syllabusCoverage(
  classroom: string,
): { exam: string; topics: TopicCoverage[] } | null {
  const read = readSyllabus(classroom);
  if (!read) return null;
  const topics = examCoverage(
    read.exam,
    store.listLessons(classroom),
    store.reviewItems(classroom),
  );
  return topics.length ? { exam: read.exam.name ?? "Syllabus", topics } : null;
}

/** A lesson plan's syllabus_skills do not match the classroom's syllabus topics. */
export class SyllabusSkillsError extends Error {}

/** A lesson plan's syllabus_skills must match the classroom: null without topics, else known ids. */
export function validateSyllabusSkills(classroom: string, skills: unknown): void {
  const read = readSyllabus(classroom);
  const topics = read ? examCoverage(read.exam, [], []) : [];
  if (!topics.length) {
    if (skills !== null)
      throw new SyllabusSkillsError(
        `syllabus_skills must be null: classroom ${classroom} has no syllabus.json topics.`,
      );
    return;
  }
  const exam = JSON.stringify(read!.exam.name ?? "(unnamed)");
  if (!Array.isArray(skills))
    throw new SyllabusSkillsError(
      `syllabus_skills must be an array of topic ids from exam ${exam} in ${classroom}/syllabus.json ([] when none apply).`,
    );
  const ids = new Set(topics.map((t) => t.id));
  for (const skill of skills)
    if (!ids.has(skill))
      throw new SyllabusSkillsError(
        `syllabus_skills names unknown topic ${JSON.stringify(skill)}: it is not a topic id in exam ${exam} of ${classroom}/syllabus.json.`,
      );
}

/** Replace a classroom file through a same-directory temporary file. */
function replaceFile(target: string, text: string): void {
  const temp = `${target}.studens.tmp`;
  if (isSymlink(temp)) throw new Error(`Temporary file cannot be a symlink: ${temp}.`);
  fs.writeFileSync(temp, text, { mode: fs.statSync(target).mode & 0o777 });
  fs.renameSync(temp, target);
}

/** Add a published lesson to its topics in the target exam. Idempotent; no write when unchanged. */
export function recordLessonSkills(classroom: string, lesson: string, skills: string[]): void {
  if (!skills.length) return;
  const read = readSyllabus(classroom);
  if (!read) throw new Error(`Classroom ${classroom} has no syllabus.json to record topics in.`);
  let changed = false;
  for (const domain of read.exam.domains ?? [])
    for (const topic of domain.topics ?? [])
      if (skills.includes(topicId(topic)) && !(topic.lessons ?? []).includes(lesson)) {
        topic.lessons = [...(topic.lessons ?? []), lesson];
        changed = true;
      }
  if (!changed) return;
  const target = safeStaticFile(classroomDir(classroom), "syllabus.json");
  if (!target) throw new Error(`${classroom}/syllabus.json cannot be a symlink.`);
  replaceFile(target, JSON.stringify(read.syllabus, null, 2) + "\n");
}

/** Resolve syllabus.json `plan` to a safe, public, existing markdown file in the classroom. */
export function planFile(classroom: string, plan: string): string {
  const where = `${classroom}/syllabus.json plan ${JSON.stringify(plan)}`;
  const root = classroomDir(classroom);
  const segments = plan.split("/");
  if (
    !plan.endsWith(".md") ||
    path.isAbsolute(plan) ||
    plan.includes("\\") ||
    segments.some((s) => !s || s === "." || s === ".." || s.startsWith(".") || s === "quiz") ||
    !safeJoin(root, plan)
  )
    throw new Error(
      `${where} must be a classroom-relative .md path outside private and hidden folders.`,
    );
  const target = safeStaticFile(root, plan);
  if (!target || !isFile(target))
    throw new Error(`${where} must name an existing markdown file that is not a symlink.`);
  return target;
}

interface BlockLesson {
  name: string;
  title: string;
  latestScore: number | null;
}

function pretestScore(classroom: string, lesson: string): number | null {
  const grades = store.latestGrades(classroom, lesson);
  const graded = new Set(grades.map((g) => g.submissionId));
  const last = [...store.listSubmissions(classroom, lesson)]
    .reverse()
    .find((s) => graded.has(s.id) && kindOf(s) === "pretest");
  return last ? (grades.find((g) => g.submissionId === last.id)?.score ?? null) : null;
}

/** Keep generated text on one line so it can never forge a marker line. */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");

function progressBlock(classroom: string, lessons: BlockLesson[], topics: TopicCoverage[]) {
  const skills = lessonTopics(topics);
  const lines = [
    "Maintained by Studens from grades and syllabus.json; authoritative over the checklist above.",
    "",
  ];
  for (const lesson of lessons) {
    const pretest = pretestScore(classroom, lesson.name);
    const scores = [
      pretest === null ? "" : `pretest ${Math.round(pretest)}%`,
      lesson.latestScore === null ? "" : `check ${Math.round(lesson.latestScore)}%`,
    ].filter(Boolean);
    const number = /^\d+/.exec(lesson.name)?.[0] ?? lesson.name;
    lines.push(
      oneLine(
        `- [${lesson.latestScore === null ? " " : "x"}] ${number} ${lesson.title}: skills ${skills.get(lesson.name)?.join(", ") || "none"}${scores.length ? `; ${scores.join(", ")}` : ""}`,
      ),
    );
  }
  lines.push("", "Not seen yet:");
  const unseen = topics.filter((t) => t.state === "unseen");
  const domains = [...new Set(unseen.map((t) => t.domainIndex))];
  for (const index of domains) {
    const group = unseen.filter((t) => t.domainIndex === index);
    lines.push(oneLine(`- ${group[0].domain}: ${group.map((t) => t.id).join(", ")}`));
  }
  if (!unseen.length) lines.push("- none");
  return lines;
}

/**
 * Regenerate the progress block in the syllabus.json `plan` file, wholesale from disk.
 * A no-op without a string `plan`, before any strict validation, so classrooms that have
 * not opted in never depend on syllabus.json. `publishing` names a lesson whose request
 * is not done yet. Text outside the markers is kept byte for byte; the file is replaced
 * only on change.
 */
export function refreshProgress(classroom: string, publishing?: BlockLesson): void {
  if (syllabusPlan(classroom) === undefined) return;
  const read = readSyllabus(classroom);
  if (read?.syllabus.plan === undefined) return;
  const target = planFile(classroom, read.syllabus.plan);
  const listed = store.listLessons(classroom);
  const topics = examCoverage(read.exam, listed, store.reviewItems(classroom));
  const lessons: BlockLesson[] = listed.filter(
    (l) => l.kind !== "review" && !isStoredReview(l.name) && l.name !== publishing?.name,
  );
  if (publishing) {
    const at = lessons.findIndex((l) => store.orderPrefix(l.name) === null);
    lessons.splice(at === -1 ? lessons.length : at, 0, publishing);
  }
  const block = progressBlock(classroom, lessons, topics);
  const before = fs.readFileSync(target, "utf8");
  const lines = before.split("\n");
  const starts = lines.flatMap((line, i) => (line.trim() === START ? [i] : []));
  const ends = lines.flatMap((line, i) => (line.trim() === END ? [i] : []));
  let after: string;
  if (!starts.length && !ends.length)
    after = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}${[START, ...block, END].join("\n")}\n`;
  else if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0])
    after = [...lines.slice(0, starts[0] + 1), ...block, ...lines.slice(ends[0])].join("\n");
  else
    throw new Error(
      `${classroom}/${read.syllabus.plan} needs exactly one ${START} line followed by one ${END} line, or neither. Fix the markers and retry.`,
    );
  if (after !== before) replaceFile(target, after);
}

/** Refresh after an automatic grade; the learner's submission never fails on it. */
export function refreshProgressInBackground(classroom: string): void {
  try {
    refreshProgress(classroom);
  } catch (error) {
    console.error(
      `[classroom] syllabus progress block for ${classroom} was not refreshed: ${(error as Error).message}`,
    );
  }
}

/** Thrown after a grade is saved when the progress block cannot be refreshed. */
export class ProgressRefreshError extends Error {}

/** Refresh after a saved grade; the error says the grade is kept so a retry never regrades. */
export function refreshProgressAfterGrade(classroom: string): void {
  try {
    refreshProgress(classroom);
  } catch (error) {
    throw new ProgressRefreshError(
      `The grade was saved, but the syllabus progress block could not be refreshed: ${(error as Error).message} Do not grade again; retry this request after fixing it.`,
    );
  }
}
