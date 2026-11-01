/** Typed panel reply output; code alone serializes the durable retrieval check call. */
import type { TeacherPlan } from "./teacher.ts";
import { ASSISTANCE } from "./evidence.ts";

export interface RetrievalOutputTarget {
  classroom: string;
  /** The exact saved learner reply. Without one no check can be verified. */
  answer?: string;
  /** This lesson's eligible review item keys and their exact question keys. */
  reviewKeys: string[];
}
const text = { type: "string", minLength: 1, pattern: "\\S" };
const TASKS = ["retrieval", "transfer"];
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const CHECK_FIELDS = ["review_key", "evidence", "assistance", "task", "learning_record_markdown"];
function requireTarget(
  target: RetrievalOutputTarget | undefined,
): asserts target is RetrievalOutputTarget {
  if (!target?.classroom?.trim() || !Array.isArray(target.reviewKeys))
    throw new Error("A panel reply response requires its saved classroom and review items.");
}
/** True when this request can verify a retrieval check at all. */
function checkable(target: RetrievalOutputTarget): boolean {
  return typeof target.answer === "string" && target.reviewKeys.length > 0;
}
/** The check and its learning record are one value: neither can be returned alone. */
export function retrievalOutputSchema(target: RetrievalOutputTarget | undefined) {
  requireTarget(target);
  const check = object({
    review_key: { ...text, enum: [...new Set(target.reviewKeys)] },
    evidence: text,
    assistance: { type: "string", enum: [...ASSISTANCE] },
    task: { type: "string", enum: TASKS },
    learning_record_markdown: text,
  });
  return object({
    message: text,
    retrieval_check: checkable(target) ? { anyOf: [{ type: "null" }, check] } : { type: "null" },
    notes_markdown: { type: "string" },
  });
}
export function isRetrievalOutputSchema(schema: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, unknown> | undefined;
  return !!properties && Object.hasOwn(properties, "retrieval_check");
}
/** True when the output returns the check in the plan. Invalid output is decoded later. */
export function returnsRetrievalCheck(value: unknown): boolean {
  const check = (value as Record<string, unknown> | null)?.retrieval_check;
  return !!check && typeof check === "object" && !Array.isArray(check);
}
/** Also validate at the host boundary: provider schema enforcement is not trusted. */
export function retrievalOutputPlan(
  value: unknown,
  target: RetrievalOutputTarget | undefined,
): TeacherPlan {
  requireTarget(target);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !["message", "retrieval_check", "notes_markdown"].every((key) => Object.hasOwn(value, key))
  )
    throw new Error(
      "Panel reply response must contain only message, retrieval_check and notes_markdown.",
    );
  const row = value as Record<string, unknown>;
  if (typeof row.message !== "string" || !row.message.trim())
    throw new Error("Panel reply response needs a nonblank message.");
  if (typeof row.notes_markdown !== "string")
    throw new Error("Panel reply notes_markdown must be a string.");
  const plan = { message: row.message, notes_markdown: row.notes_markdown };
  if (row.retrieval_check === null) return { ...plan, calls: [], learning_record: "" };
  const check = row.retrieval_check as Record<string, unknown>;
  if (
    !check ||
    typeof check !== "object" ||
    Array.isArray(check) ||
    Object.keys(check).length !== CHECK_FIELDS.length ||
    !CHECK_FIELDS.every((key) => Object.hasOwn(check, key))
  )
    throw new Error(
      "retrieval_check must be null or contain only review_key, evidence, assistance, task and learning_record_markdown.",
    );
  if (!checkable(target))
    throw new Error(
      "This panel reply has no saved learner reply or review item to verify. Return retrieval_check: null.",
    );
  if (!target.reviewKeys.includes(check.review_key as string))
    throw new Error("retrieval_check.review_key must be one of this lesson's review item keys.");
  for (const key of ["evidence", "learning_record_markdown"])
    if (typeof check[key] !== "string" || !check[key].trim())
      throw new Error(`retrieval_check.${key} must be a nonblank string.`);
  if (!(ASSISTANCE as readonly unknown[]).includes(check.assistance))
    throw new Error(`retrieval_check.assistance must be one of ${ASSISTANCE.join(", ")}.`);
  if (!TASKS.includes(check.task as string))
    throw new Error("retrieval_check.task must be retrieval or transfer.");
  return {
    ...plan,
    calls: [
      {
        name: "record_retrieval_check",
        arguments_json: JSON.stringify({
          classroom: target.classroom,
          review_key: check.review_key,
          answer: target.answer,
          evidence: check.evidence,
          assistance: check.assistance,
          task: check.task,
        }),
      },
    ],
    learning_record: check.learning_record_markdown as string,
  };
}
