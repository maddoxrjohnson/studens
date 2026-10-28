/** Private question pools. Only a selected question is copied to a review page. */
import { authoredQuizzes, authoredQuestionShapes } from "./quiz-authoring.ts";
import { authoringContent, htmlAttributes, TAG_ATTRIBUTES } from "./authoring-html.ts";
import { isContractId, questionErrors } from "../assets/runtime/quiz.mjs";
import { parseRubric } from "./rubric.ts";
import type { RubricQuestion } from "./rubric.ts";
import { parseTeachingPlan } from "./teaching-plan.ts";
import type { Objective, QuestionPlan } from "./teaching-plan.ts";

export interface ReviewVariant {
  id: string;
  html: string;
  rubric: RubricQuestion;
}
export interface PreparedVariant extends ReviewVariant {
  plan: QuestionPlan;
  objective: Objective;
}

export function validateVariant(
  value: unknown,
  mapping: unknown,
  objective: Objective,
): PreparedVariant {
  if (!value || typeof value !== "object") throw new Error("Invalid private review variant.");
  const variant = value as ReviewVariant;
  if (!isContractId(variant.id) || typeof variant.html !== "string")
    throw new Error("A review variant needs an id and question HTML.");
  const fragment = authoringContent(variant.html).trim();
  if (
    !/^<li\b[\s\S]*<\/li\s*>$/i.test(fragment) ||
    /<\/?(?:form|html|head|body|script|style|template|iframe|object|embed|link|meta|base)\b/i.test(
      variant.html,
    )
  )
    throw new Error(`Variant ${variant.id} must contain one question li fragment.`);
  for (const tag of fragment.matchAll(new RegExp(`<([a-z][\\w-]*)\\b(${TAG_ATTRIBUTES})>`, "gi"))) {
    if (/(?:^|\s)(?:on[\w-]+|srcdoc)\s*=/i.test(tag[2]))
      throw new Error(`Variant ${variant.id} contains active attributes.`);
    for (const reference of tag[2].matchAll(
      /\b(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      if (!/^(?:\/c\/|#)/.test(reference[1] ?? reference[2] ?? reference[3]))
        throw new Error(`Variant ${variant.id} has a non-classroom media reference.`);
    }
    const attributes = htmlAttributes(tag[2]);
    if (
      [...attributes].some(
        ([name, value]) =>
          /^on/i.test(name) ||
          name === "data-review-of" ||
          (["href", "src", "action"].includes(name) && !/^(?:\/c\/|#)/.test(value)),
      )
    )
      throw new Error(
        `Variant ${variant.id} has active content or a non-classroom media reference.`,
      );
  }
  const html = `<form class="cl-quiz" data-quiz-id="review" data-kind="check"><ol>${fragment}</ol></form>`;
  const questions = authoredQuizzes(html)[0]?.questions ?? [];
  const shapes = authoredQuestionShapes(html);
  if (questions.length !== 1 || questions[0].id !== variant.id || shapes.length !== 1)
    throw new Error(`Variant ${variant.id} needs exactly one matching question.`);
  const errors = questionErrors(shapes[0]);
  if (errors.length) throw new Error(`Variant ${variant.id}: ${errors.join(" ")}`);
  parseRubric(JSON.stringify({ review: { [variant.id]: variant.rubric } }), html);
  const plan = mapping as QuestionPlan;
  if (
    !plan ||
    plan.objective !== "original" ||
    plan.support !== "independent" ||
    plan.teaching !== undefined
  )
    throw new Error(`Variant ${variant.id} needs independent retrieval of objective original.`);
  parseTeachingPlan(
    JSON.stringify({
      version: 1,
      objectives: { original: objective },
      quizzes: { review: { purpose: "assessment", questions: { [variant.id]: plan } } },
    }),
    html,
  );
  return { id: variant.id, html: fragment, rubric: variant.rubric, plan, objective };
}

/** Missing pools are legacy data; declared pools must be complete, even on old lessons. */
export function authoredVariants(
  keyText: string,
  planText: string,
  html: string,
  required = false,
): Map<string, PreparedVariant[]> {
  const key = parseRubric(keyText, html, required ? "machine" : "legacy");
  const plan = parseTeachingPlan(planText, html);
  const pools = new Map<string, PreparedVariant[]>();
  for (const quiz of authoredQuizzes(html)) {
    if (quiz.kind !== "check") continue;
    for (const question of quiz.questions) {
      const where = `${quiz.id}/${question.id}`;
      const entry = key[quiz.id!][question.id!] as RubricQuestion & { variants?: ReviewVariant[] };
      const mapping = plan.quizzes[quiz.id!].questions[question.id!] as QuestionPlan & {
        variants?: Record<string, QuestionPlan>;
      };
      if (entry.variants === undefined && mapping.variants === undefined && !required) continue;
      if (!Array.isArray(entry.variants) || entry.variants.length < 2 || entry.variants.length > 3)
        throw new Error(`Question ${where} needs two or three private review variants.`);
      const ids = entry.variants.map((v) => v?.id);
      if (
        !mapping.variants ||
        typeof mapping.variants !== "object" ||
        Array.isArray(mapping.variants) ||
        new Set(ids).size !== ids.length ||
        Object.keys(mapping.variants).length !== ids.length ||
        Object.keys(mapping.variants).some((id) => !ids.includes(id))
      )
        throw new Error(`Question ${where} has mismatched or duplicate variant ids.`);
      pools.set(
        where,
        entry.variants.map((v) =>
          validateVariant(v, mapping.variants![v.id], plan.objectives[mapping.objective]),
        ),
      );
    }
  }
  return pools;
}
