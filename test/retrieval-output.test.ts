/** Typed panel reply output: code serializes the canonical retrieval check call. */
import { describe, expect, it } from "vitest";
import { retrievalOutputPlan, retrievalOutputSchema } from "../src/retrieval-output.ts";
import { planSchema, returnsOperation } from "../src/teacher.ts";

const target = {
  classroom: "rust",
  answer: "The String is dropped when its owner leaves scope.",
  reviewKeys: ["001-ownership/check-1/q1"],
};
const check = {
  review_key: "001-ownership/check-1/q1",
  evidence: "New example: the learner traced the owner to the end of its scope.",
  assistance: "none",
  task: "retrieval",
  learning_record_markdown: "# Owner lifetime\n\nTraced a String to its owner's scope end.",
};
const output = (retrieval_check: unknown) => ({
  message: "Correct. Ready to continue?",
  retrieval_check,
  notes_markdown: "",
});

describe("typed panel reply output", () => {
  it("serializes the canonical call with the exact saved reply and classroom", () => {
    const plan = retrievalOutputPlan(output(check), target);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0].name).toBe("record_retrieval_check");
    expect(JSON.parse(plan.calls[0].arguments_json)).toEqual({
      classroom: "rust",
      review_key: check.review_key,
      answer: target.answer,
      evidence: check.evidence,
      assistance: "none",
      task: "retrieval",
    });
    expect(plan.learning_record).toBe(check.learning_record_markdown);
    expect(plan.message).toBe("Correct. Ready to continue?");
  });
  it("accepts an exact question key that findReviewItem resolves", () => {
    const keyed = {
      ...target,
      reviewKeys: ["010-mock-test2-a/@objective/deadlock-facts", "010-mock-test2-a/q1/q1_4"],
    };
    const plan = retrievalOutputPlan(
      output({ ...check, review_key: "010-mock-test2-a/q1/q1_4" }),
      keyed,
    );
    expect(JSON.parse(plan.calls[0].arguments_json).review_key).toBe("010-mock-test2-a/q1/q1_4");
    expect(
      (retrievalOutputSchema(keyed).properties.retrieval_check as { anyOf: any[] }).anyOf[1]
        .properties.review_key.enum,
    ).toContain("010-mock-test2-a/q1/q1_4");
  });
  it("returns no call and no record for a null check", () => {
    expect(retrievalOutputPlan(output(null), target)).toEqual({
      calls: [],
      message: "Correct. Ready to continue?",
      learning_record: "",
      notes_markdown: "",
    });
  });
  it("cannot return a record without a check or a check without a record", () => {
    const schema = retrievalOutputSchema(target);
    // The record lives inside the check, so the two are a single nullable value.
    expect(schema.properties).not.toHaveProperty("learning_record");
    expect(schema.properties).not.toHaveProperty("calls");
    const typed = (schema.properties.retrieval_check as { anyOf: any[] }).anyOf;
    expect(typed[0]).toEqual({ type: "null" });
    expect(typed[1].required).toContain("learning_record_markdown");
    expect(typed[1].properties.review_key.enum).toEqual(target.reviewKeys);
    expect(() =>
      retrievalOutputPlan({ ...output(null), learning_record: { markdown: "x" } }, target),
    ).toThrow("only message, retrieval_check and notes_markdown");
    const { learning_record_markdown: _record, ...bare } = check;
    expect(() => retrievalOutputPlan(output(bare), target)).toThrow("retrieval_check must be");
    expect(() =>
      retrievalOutputPlan(output({ ...check, learning_record_markdown: " " }), target),
    ).toThrow("learning_record_markdown must be a nonblank string");
  });
  it("rejects keys outside this lesson and checks without a saved reply", () => {
    expect(() =>
      retrievalOutputPlan(output({ ...check, review_key: "other/check/q9" }), target),
    ).toThrow("review item keys");
    expect(() => retrievalOutputPlan(output({ ...check, task: "mastery" }), target)).toThrow(
      "task",
    );
    const unverifiable = { ...target, answer: undefined };
    expect(retrievalOutputSchema(unverifiable).properties.retrieval_check).toEqual({
      type: "null",
    });
    expect(() => retrievalOutputPlan(output(check), unverifiable)).toThrow(
      "Return retrieval_check: null",
    );
  });
  it("keeps the root a closed all-required object for every host", () => {
    const schema = planSchema({
      operations: ["record_retrieval_check"],
      messageRequired: true,
      notesAllowed: true,
      response: "retrieval-check",
      retrievalTarget: target,
    });
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema.required).toEqual(Object.keys(schema.properties));
  });
  it("knows whether the final output returned the operation", () => {
    const contract = {
      operations: ["record_retrieval_check" as const],
      response: "retrieval-check" as const,
      retrievalTarget: target,
    };
    expect(returnsOperation(contract, output(check), "record_retrieval_check")).toBe(true);
    expect(returnsOperation(contract, output(null), "record_retrieval_check")).toBe(false);
    const generic = { operations: ["record_retrieval_check" as const] };
    expect(
      returnsOperation(
        generic,
        { calls: [{ name: "record_retrieval_check", arguments_json: "{}" }] },
        "record_retrieval_check",
      ),
    ).toBe(true);
    expect(returnsOperation(generic, { calls: [] }, "record_retrieval_check")).toBe(false);
  });
});
