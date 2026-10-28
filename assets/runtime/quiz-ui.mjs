/** Hydrate quiz controls, collect answers, and restore attempts, grades, and drafts. */
import { TEACHER_WORKING } from "./teacher-status.mjs";
import { createGradeDisputes } from "./grade-disputes.mjs";
import { createExpectedAnswers } from "./expected-answers.mjs";
import { gradePointsNotice, gradeSummary, questionGradeLabel, questionOutcome } from "./grade.mjs";
import { normalizeText } from "./anchor.mjs";
import { diagramSource } from "./diagrams.mjs";
import { swapMathForSource } from "./math.mjs";
import { QUIZ_KINDS, isContractId, isQuizKind, parseNumber, questionErrors } from "./quiz.mjs";
import {
  showErrors,
  textOf,
  detachMarkers,
  detachLearnerMarks,
  setQuizStatus,
  cssEscape,
  escapeText,
} from "./lesson-dom.mjs";
import { draftStatus } from "./drafts.mjs";
import { practiceErrors, practiceFeedback } from "./practice.mjs";
import { enhanceCode, collectCode, restoreCode, lockCode } from "./code-ui.mjs";

/**
 * The quiz contract lives in assets/templates/quiz.html. A form that breaks it is
 * not hydrated: every problem is shown on the page and in the console, and the form
 * cannot be submitted. A half-working quiz would hand the teacher answers that do not
 * match the questions.
 */
export function createQuizzes({ config, drafts, placeTeacherPanel }) {
  const { scheduleDraft, flushDraft } = drafts;
  let teacherState = null;
  const revealed = new Set();
  const disputes = createGradeDisputes(config);
  const expectedAnswers = createExpectedAnswers(config);
  /** Elements inside a question. */
  function own(question, selector) {
    return [...question.querySelectorAll(selector)].filter(
      (el) => !el.closest(".cl-learner-marks"),
    );
  }

  /** Summarise a question's markup as plain data, for `questionErrors`. */
  function questionShape(question, kind) {
    const ids = (selector, attribute) =>
      own(question, selector).map((el) => el.getAttribute(attribute) ?? "");
    const count = (selector) => own(question, selector).length;
    const unit = question.querySelector(".cl-unit");
    // null means editable text; a list contains the units the control can supply.
    let unitValues = [];
    if (unit?.matches("input:not([type]), input[type=text], input[type=search]"))
      unitValues = unit.readOnly || unit.matches(":disabled") ? [unit.value.trim()] : null;
    else if (unit?.matches("select") && !unit.multiple)
      unitValues = [...unit.options]
        .filter(
          (option) =>
            option.selected ||
            (!unit.matches(":disabled") &&
              !option.disabled &&
              !option.closest("optgroup[disabled]")),
        )
        .map((option) => option.value.trim());
    return {
      id: question.dataset.questionId ?? null,
      type: question.dataset.type ?? null,
      kind,
      reviewOf: question.dataset.reviewOf ?? null,
      select: question.dataset.select ?? null,
      hasStimulus: Boolean(question.querySelector(".cl-q-stimulus")),
      hasCloze: Boolean(question.querySelector(".cl-cloze")),
      radios: count("input[type=radio]"),
      checkboxes: count("input[type=checkbox]"),
      textInputs: count(
        "input[type=text]:not([data-blank]):not(.cl-number):not(.cl-unit), input:not([type]):not([data-blank]):not(.cl-number):not(.cl-unit)",
      ),
      textareas: count("textarea"),
      code: question.getAttribute("data-code"),
      codeEditors: count("label textarea.cl-code-source"),
      numbers: count("input.cl-number"),
      units: count(".cl-unit"),
      unitValues,
      options: own(question, "input[type=radio], input[type=checkbox]").map((input) =>
        input.getAttribute("value"),
      ),
      blanks: ids("input[data-blank]", "data-blank"),
      orderItems: ids(".cl-order > li", "data-item"),
      matchLeft: ids(".cl-match-left > li", "data-item"),
      matchRight: ids(".cl-match-right > li", "data-item"),
      segments: ids(".cl-q-stimulus [data-segment]", "data-segment"),
    };
  }

  /** Problems with the form itself, before its questions are checked. */
  function quizErrors(form, seenQuizIds) {
    const errors = [];
    const practice = form.matches(".cl-practice");
    const attribute = practice ? "data-practice-id" : "data-quiz-id";
    const quizId = form.getAttribute(attribute);
    if (!quizId) errors.push(`The form has no ${attribute}.`);
    else if (!isContractId(quizId)) errors.push(`The ${attribute} "${quizId}" is not valid.`);
    else if (seenQuizIds.has(quizId))
      errors.push(`Two quiz or practice forms use the id "${quizId}".`);

    const kind = form.dataset.kind;
    if (kind !== undefined && !isQuizKind(kind)) {
      errors.push(`Unknown data-kind "${kind}". Use one of: ${QUIZ_KINDS.join(", ")}.`);
    }
    const questions = [...form.querySelectorAll(".cl-q")];
    if (questions.length === 0) errors.push("The quiz has no .cl-q questions.");
    const ids = questions.map((q) => q.dataset.questionId).filter(Boolean);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (repeated.length > 0)
      errors.push(`Repeated data-question-id: ${[...new Set(repeated)].join(", ")}.`);
    return errors;
  }

  const KIND_NOTES = {
    pretest:
      "Before instruction, attempt the upcoming ideas. Predict, explain, or try a solution even if you do not know yet. Wrong answers are expected. These answers do not affect lesson scores or review.",
    review:
      "Review. These questions come back to ideas from earlier lessons, so you recall them after a gap.",
  };

  const practiceKeys = new WeakMap();

  function hydrateQuizzes() {
    const seenQuizIds = new Set();
    for (const form of document.querySelectorAll("form.cl-quiz, form.cl-practice")) {
      const practice = form.matches(".cl-practice");
      const formErrors = quizErrors(form, seenQuizIds);
      const formId = practice ? form.dataset.practiceId : form.dataset.quizId;
      if (formId) seenQuizIds.add(formId);
      const kind = isQuizKind(form.dataset.kind) ? form.dataset.kind : "check";
      if (!practice) form.dataset.kind = kind;

      if (practice) {
        if (form.matches(".cl-quiz")) formErrors.push("Practice must not also be a graded quiz.");
        if (form.hasAttribute("data-kind")) formErrors.push("Practice does not use data-kind.");
        try {
          const keys = form.querySelectorAll(
            'script[type="application/json"][data-cl-practice-key]',
          );
          if (keys.length !== 1)
            throw new Error("Practice needs one public data-cl-practice-key JSON script.");
          const key = JSON.parse(keys[0].textContent);
          formErrors.push(
            ...practiceErrors(
              [...form.querySelectorAll(".cl-q")].map((q) => questionShape(q, "check")),
              key,
            ),
          );
          practiceKeys.set(form, key);
        } catch (error) {
          formErrors.push(error.message);
        }
      }
      let broken = formErrors.length > 0;
      for (const question of form.querySelectorAll(".cl-q")) {
        const errors = questionErrors(questionShape(question, kind));
        if (errors.length > 0) {
          broken = true;
          const label = question.dataset.questionId ?? "without an id";
          showErrors(question, `Question ${label}`, errors);
        }
      }

      if (form.dataset.title && !form.querySelector(".cl-quiz-title")) {
        const heading = document.createElement("p");
        heading.className = "cl-quiz-title";
        heading.textContent = form.dataset.title;
        form.prepend(heading);
      }
      if (practice) {
        const note = document.createElement("p");
        note.className = "cl-quiz-kind";
        note.textContent =
          "Practice · Ungraded. Check your answer here, then try again. Nothing is saved or added to your score or review.";
        form.prepend(note);
      }
      if (!practice && KIND_NOTES[kind] && !form.querySelector(".cl-quiz-kind")) {
        const note = document.createElement("p");
        note.className = "cl-quiz-kind";
        note.textContent = KIND_NOTES[kind];
        const title = form.querySelector(".cl-quiz-title");
        if (title) title.after(note);
        else form.prepend(note);
      }
      if (formErrors.length > 0) {
        showErrors(form, "This quiz has errors.", formErrors, form.querySelector(".cl-questions"));
      }

      let footer = form.querySelector(".cl-quiz-footer");
      if (!footer) {
        footer = document.createElement("div");
        footer.className = "cl-quiz-footer";
        form.appendChild(footer);
      }

      let submit = form.querySelector('button[type="submit"], .cl-submit');
      if (!submit) {
        submit = document.createElement("button");
        submit.type = "submit";
        submit.className = "cl-submit";
        submit.textContent = "Submit for grading";
      }
      if (practice) submit.textContent = "Check answer";
      submit.classList.add("cl-button");
      footer.appendChild(submit);

      const status = document.createElement("span");
      status.className = "cl-quiz-status cl-status-line";
      status.dataset.clQuizStatus = "";
      status.setAttribute("role", "status");
      footer.appendChild(status);

      if (broken) {
        setQuizState(form, "broken");
        setQuizStatus(
          form,
          "This quiz has errors, so it cannot be submitted. Ask your teacher to fix it.",
        );
        continue;
      }

      for (const question of form.querySelectorAll(".cl-q")) enhanceQuestion(form, question);
      form.dataset.state = "fresh";
      // A question card inside the quiz has its own form. Its events bubble here.
      form.addEventListener("submit", (event) => {
        if (event.target === form) onQuizSubmit(event, form);
      });
      if (practice) {
        const clearFeedback = (event) => {
          if (event.target.closest(".cl-card-panel, .cl-learner-marks")) return;
          form.querySelectorAll(".cl-practice-feedback").forEach((node) => node.remove());
          setQuizStatus(form, "");
        };
        form.addEventListener("input", clearFeedback);
        form.addEventListener("change", clearFeedback);
        continue;
      }
      const saveQuiz = (event) => {
        if (
          form.dataset.state !== "fresh" ||
          event.target.closest(".cl-card-panel, .cl-learner-marks")
        )
          return;
        scheduleDraft(
          `quiz:${form.dataset.quizId}`,
          () => quizDraft(form),
          draftStatus((text) => setQuizStatus(form, text), "Draft saved."),
        );
      };
      form.addEventListener("input", saveQuiz);
      form.addEventListener("change", saveQuiz);
    }
  }

  /** Add the controls a question type needs. */
  function enhanceQuestion(form, question) {
    const addReport = (name, title, options) => {
      const label = document.createElement("label");
      label.className = "cl-answer-report";
      label.append(document.createTextNode(title + " "));
      const select = document.createElement("select");
      select.className = "cl-input";
      select.dataset[name] = "";
      for (const [value, text] of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        select.append(option);
      }
      label.append(select);
      question.append(label);
    };
    if (form.dataset.evidence === "report" && !config.hideAnswerReports)
      addReport("clAssistance", "How did you answer?", [
        ["", "Not reported"],
        ["none", "Without help"],
        ["hint", "With a hint or reference"],
        ["solution", "After seeing a solution"],
      ]);
    if (
      !config.hideAnswerReports &&
      (question.dataset.confidence === "optional" || form.dataset.confidence === "optional")
    )
      addReport("clConfidence", "Confidence (optional)", [
        ["", "Not reported"],
        ["guess", "Guess"],
        ["unsure", "Unsure"],
        ["sure", "Sure"],
      ]);
    switch (question.dataset.type) {
      case "code":
        enhanceCode(question);
        break;
      case "numeric":
        for (const input of question.querySelectorAll("input.cl-number")) {
          input.setAttribute("inputmode", "decimal");
          input.addEventListener("input", () => markNumber(input));
        }
        break;
      case "order":
        enhanceOrder(question);
        break;
      case "match":
        enhanceMatch(question);
        break;
      case "locate":
        enhanceLocate(form, question);
        break;
    }
  }

  function markNumber(input) {
    const invalid = input.value.trim() !== "" && parseNumber(input.value) === null;
    input.setAttribute("aria-invalid", String(invalid));
  }

  function enhanceOrder(question) {
    const list = question.querySelector(".cl-order");
    // Keep the authored order so saved answers can replace the displayed selections.
    list.dataset.clInitial = [...list.children].map((li) => li.dataset.item).join(" ");
    for (const item of list.children) {
      const controls = document.createElement("span");
      controls.className = "cl-order-controls";
      controls.innerHTML = `
      <button type="button" class="cl-icon-button" data-cl-move="-1" aria-label="Move up">↑</button>
      <button type="button" class="cl-icon-button" data-cl-move="1" aria-label="Move down">↓</button>`;
      item.appendChild(controls);
      controls.addEventListener("click", (event) => {
        const button = event.target.closest("[data-cl-move]");
        if (!button || button.disabled) return;
        const sibling =
          button.dataset.clMove === "-1" ? item.previousElementSibling : item.nextElementSibling;
        if (!sibling) return;
        if (button.dataset.clMove === "-1") sibling.before(item);
        else sibling.after(item);
        button.focus();
        // A move is a change of answer, like a click on a native control.
        item.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }

  /** The text of an order item, without the move buttons. */
  function itemLabel(item) {
    const clone = item.cloneNode(true);
    clone.querySelector(".cl-order-controls")?.remove();
    swapMathForSource(clone);
    return normalizeText(clone.textContent);
  }

  function enhanceMatch(question) {
    const rights = [...question.querySelectorAll(".cl-match-right > li")];
    for (const left of question.querySelectorAll(".cl-match-left > li")) {
      const select = document.createElement("select");
      select.className = "cl-match-select cl-input";
      select.dataset.matchFor = left.dataset.item;
      select.setAttribute("aria-label", `Match for ${textOf(left)}`);
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Choose a match…";
      select.appendChild(blank);
      for (const right of rights) {
        const option = document.createElement("option");
        option.value = right.dataset.item;
        option.textContent = textOf(right);
        select.appendChild(option);
      }
      left.appendChild(select);
    }
  }

  function enhanceLocate(form, question) {
    const many = question.dataset.select === "many";
    for (const segment of question.querySelectorAll(".cl-q-stimulus [data-segment]")) {
      segment.classList.add("cl-segment");
      segment.setAttribute("role", "button");
      segment.setAttribute("tabindex", "0");
      segment.setAttribute("aria-pressed", "false");
      const toggle = () => {
        if (form.dataset.state !== "fresh") return;
        const pressed = segment.getAttribute("aria-pressed") !== "true";
        if (!many) {
          for (const other of question.querySelectorAll(".cl-segment")) {
            other.setAttribute("aria-pressed", "false");
          }
        }
        segment.setAttribute("aria-pressed", String(pressed));
        segment.dispatchEvent(new Event("change", { bubbles: true }));
      };
      segment.addEventListener("click", toggle);
      segment.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    }
  }

  /**
   * Plain text of a stimulus block. Line breaks are kept, because code needs them.
   *
   * A diagram is sent as its Mermaid source, because the SVG labels omit the arrows.
   * A formula is sent as its TeX. The diagrams are hidden and the formulas swapped while
   * the text is read, and both are put back before the browser can paint.
   */
  function stimulusText(element) {
    const restoreNotes = detachLearnerMarks(element);
    const diagrams = [...element.querySelectorAll(".cl-diagram")];
    for (const diagram of diagrams) diagram.hidden = true;
    const restoreMath = swapMathForSource(element);
    const text = (element.innerText || element.textContent || "").trim();
    restoreMath();
    for (const diagram of diagrams) diagram.hidden = false;
    const images = [...element.querySelectorAll("img")].map(
      (img) => `[image: ${img.getAttribute("alt") || "no alt text"}]`,
    );
    const sources = diagrams.map(
      (diagram) => `[diagram, Mermaid source:\n${diagramSource(diagram)}]`,
    );
    restoreNotes();
    return [text, ...images, ...sources].filter(Boolean).join("\n");
  }

  /** A cloze passage as text, with each blank written as `[[<blank id>]]`. */
  function clozeText(element) {
    const clone = element.cloneNode(true);
    for (const note of clone.querySelectorAll(".cl-learner-marks")) note.remove();
    for (const blank of clone.querySelectorAll("input[data-blank]")) {
      blank.replaceWith(document.createTextNode(`[[${blank.dataset.blank}]]`));
    }
    swapMathForSource(clone);
    return normalizeText(clone.textContent);
  }

  /**
   * Read one question's answer.
   *
   * Returns `{ answer }`, or `{ missing: true }` when the learner has not answered it
   * yet, or `{ invalid: message }` when the answer cannot be sent as it is.
   */
  function collectAnswer(question) {
    const type = question.dataset.type;
    const answer = {
      questionId: question.dataset.questionId,
      type,
      prompt: textOf(question.querySelector(".cl-q-prompt")),
    };
    const confidence = question.querySelector("[data-cl-confidence]")?.value;
    const assistance = question.querySelector("[data-cl-assistance]")?.value;
    if (confidence) answer.confidence = confidence;
    if (assistance) answer.assistance = assistance;
    const stimulus = question.querySelector(".cl-q-stimulus");
    if (stimulus) answer.stimulus = stimulusText(stimulus);
    if (question.dataset.reviewOf) answer.reviewOf = question.dataset.reviewOf;

    const labelOf = (input) => {
      const label = input.closest("label");
      return label ? textOf(label) : input.value;
    };

    switch (type) {
      case "code": {
        const result = collectCode(question);
        if (result.invalid || result.missing) return result;
        answer.value = result.value;
        answer.code = result.code;
        break;
      }
      case "choice": {
        const chosen = own(question, "input[type=radio]").find((input) => input.checked);
        if (!chosen) return { missing: true };
        answer.value = chosen.value;
        answer.label = labelOf(chosen);
        break;
      }
      case "multi": {
        const chosen = own(question, "input[type=checkbox]").filter((input) => input.checked);
        if (chosen.length === 0) return { missing: true };
        answer.parts = chosen.map((input) => ({ id: input.value, value: labelOf(input) }));
        break;
      }
      case "term":
      case "short": {
        const field = own(question, "textarea, input[type=text], input:not([type])")[0];
        if (!field.value.trim()) return { missing: true };
        answer.value = field.value.trim();
        break;
      }
      case "numeric": {
        const number = question.querySelector("input.cl-number");
        if (!number.value.trim()) return { missing: true };
        if (parseNumber(number.value) === null) {
          return {
            invalid: `"${number.value.trim()}" is not a number. Write it like 9.81 or 3e8.`,
          };
        }
        answer.value = number.value.trim();
        const unit = question.querySelector(".cl-unit");
        if (unit) answer.unit = unit.value.trim();
        break;
      }
      case "cloze": {
        const blanks = [...question.querySelectorAll("input[data-blank]")];
        if (blanks.some((blank) => !blank.value.trim())) return { missing: true };
        answer.passage = clozeText(question.querySelector(".cl-cloze"));
        answer.parts = blanks.map((blank) => ({
          id: blank.dataset.blank,
          value: blank.value.trim(),
        }));
        break;
      }
      case "order":
        answer.parts = [...question.querySelectorAll(".cl-order > li")].map((item) => ({
          id: item.dataset.item,
          value: itemLabel(item),
        }));
        break;
      case "match": {
        const selects = [...question.querySelectorAll("select.cl-match-select")];
        if (selects.some((select) => !select.value)) return { missing: true };
        answer.pairs = selects.map((select) => ({
          left: select.dataset.matchFor,
          right: select.value,
          leftLabel: itemText(select.closest("li")),
          rightLabel: normalizeText(select.selectedOptions[0].textContent),
        }));
        break;
      }
      case "locate": {
        const chosen = [...question.querySelectorAll(".cl-segment[aria-pressed=true]")];
        if (chosen.length === 0) return { missing: true };
        answer.parts = chosen.map((segment) => ({
          id: segment.dataset.segment,
          value: textOf(segment),
        }));
        break;
      }
    }

    return { answer };
  }

  /** The text of a match item, without the select the runtime added. */
  function itemText(item) {
    const clone = item.cloneNode(true);
    clone.querySelector("select")?.remove();
    swapMathForSource(clone);
    return normalizeText(clone.textContent);
  }

  async function onQuizSubmit(event, form) {
    event.preventDefault();
    if (form.dataset.state !== "fresh") return;

    const questions = [...form.querySelectorAll(".cl-q")];
    const answers = [];
    let missing = 0;
    // A question card leaves a marker in the question text. The marker is not part of
    // the question, so it is taken out while the answers are read.
    const putMarkersBack = detachMarkers(form);
    try {
      for (const [i, question] of questions.entries()) {
        const result = collectAnswer(question);
        if (result.invalid) {
          setQuizStatus(form, `Question ${i + 1}: ${result.invalid}`);
          return;
        }
        if (result.missing) missing += 1;
        else answers.push(result.answer);
      }
    } finally {
      putMarkersBack();
    }
    if (missing > 0) {
      setQuizStatus(form, `Answer every question first (${missing} left).`);
      return;
    }

    if (form.matches(".cl-practice")) {
      const key = practiceKeys.get(form);
      form.querySelectorAll(".cl-practice-feedback").forEach((node) => node.remove());
      for (const [index, answer] of answers.entries()) {
        const result = practiceFeedback(answer, key[answer.questionId]);
        const feedback = document.createElement("p");
        feedback.className = "cl-practice-feedback";
        feedback.dataset.correct = String(result.correct);
        feedback.textContent = `${result.correct ? "Correct." : "Not yet."} ${result.feedback}`;
        questions[index].append(feedback);
      }
      setQuizStatus(form, "Feedback shown. You can change your answer and check again.");
      return;
    }

    setQuizState(form, "submitted");
    form.dataset.activeAttempt = String(Number(form.dataset.attempts ?? "0") + 1);
    // Save the last keystrokes before the submission. The server removes the draft
    // only when it accepts the submission.
    await flushDraft(`quiz:${form.dataset.quizId}`);
    setQuizStatus(form, '<span class="cl-spinner"></span> Saving your answers for grading…', true);

    let response;
    try {
      response = await fetch("/api/quiz/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classroom: config.classroom,
          lesson: config.lesson,
          quizId: form.dataset.quizId,
          quizTitle: form.dataset.title || "Check on learning",
          kind: form.dataset.kind,
          answers,
        }),
      });
    } catch (err) {
      console.error("[classroom] quiz submit failed", err);
      setQuizState(form, "fresh");
      setQuizStatus(
        form,
        "Could not reach your teacher. Is the session that started the classroom still running?",
      );
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      console.error("[classroom] quiz refused", body.error);
      setQuizState(form, "fresh");
      setQuizStatus(form, `The classroom refused this quiz: ${body.error}`);
      return;
    }
    const submission = await response.json();
    applyQuizState({ submission, grade: null, attempts: submission.attempt });
  }

  function setQuizState(form, state) {
    form.dataset.state = state;
    const locked = state !== "fresh";
    for (const field of form.querySelectorAll(
      ".cl-q input, .cl-q textarea, .cl-q select, .cl-q button",
    )) {
      if (!field.closest(".cl-disputes, .cl-expected, .cl-learner-marks")) field.disabled = locked;
    }
    for (const question of form.querySelectorAll('.cl-q[data-type="code"]'))
      lockCode(question, locked);
    for (const segment of form.querySelectorAll(".cl-segment")) {
      segment.setAttribute("tabindex", locked ? "-1" : "0");
    }
    // In the footer: a question card in the quiz has a submit button of its own.
    const submit = form.querySelector(
      '.cl-quiz-footer button[type="submit"], .cl-quiz-footer .cl-submit',
    );
    if (submit) {
      submit.disabled = locked;
      if (state === "graded") submit.textContent = "Graded";
      else if (state === "submitted") submit.textContent = "Submitted";
      else
        submit.textContent = form.matches(".cl-practice") ? "Check answer" : "Submit for grading";
    }
  }

  /** Clear displayed answers before restoring a saved attempt. */
  function clearQuizAnswers(form) {
    for (const input of own(form, ".cl-q input")) {
      if (input.type === "radio" || input.type === "checkbox") input.checked = false;
      else input.value = "";
      input.removeAttribute("aria-invalid");
    }
    for (const field of own(form, ".cl-q textarea, .cl-q select")) field.value = "";
    for (const segment of form.querySelectorAll(".cl-segment")) {
      segment.setAttribute("aria-pressed", "false");
    }
    for (const list of form.querySelectorAll(".cl-order"))
      reorder(list, list.dataset.clInitial.split(" "));
  }

  /** Put the items of an order list in the given order of item ids. */
  function reorder(list, ids) {
    for (const id of ids) {
      const item = [...list.children].find((li) => li.dataset.item === id);
      if (item) list.appendChild(item);
    }
  }

  /** Put a saved answer back into its question. */
  function restoreAnswer(question, group) {
    const answer = group[0];
    const confidence = question.querySelector("[data-cl-confidence]");
    const assistance = question.querySelector("[data-cl-assistance]");
    if (confidence) confidence.value = answer.confidence ?? "";
    if (assistance) assistance.value = answer.assistance ?? "";
    const byValue = (selector, value) =>
      own(question, selector).find((input) => input.value === value);

    switch (answer.type) {
      case "code":
        restoreCode(question, answer);
        break;
      // Answers saved before question types were enforced: one entry for each ticked box.
      case undefined:
        for (const entry of group) {
          const choice = byValue("input[type=radio], input[type=checkbox]", entry.value);
          if (choice) choice.checked = true;
          else {
            const free = own(question, "textarea, input[type=text]")[0];
            if (free) free.value = entry.value;
          }
        }
        return;
      case "choice": {
        const choice = byValue("input[type=radio]", answer.value);
        if (choice) choice.checked = true;
        break;
      }
      case "multi":
        for (const part of answer.parts) {
          const box = byValue("input[type=checkbox]", part.id);
          if (box) box.checked = true;
        }
        break;
      case "term":
      case "short": {
        const field = own(question, "textarea, input[type=text], input:not([type])")[0];
        if (field) field.value = answer.value;
        break;
      }
      case "numeric": {
        const number = question.querySelector("input.cl-number");
        if (number) number.value = answer.value;
        const unit = question.querySelector(".cl-unit");
        if (unit && answer.unit !== undefined) unit.value = answer.unit;
        break;
      }
      case "cloze":
        for (const part of answer.parts) {
          const blank = question.querySelector(`input[data-blank="${cssEscape(part.id)}"]`);
          if (blank) blank.value = part.value;
        }
        break;
      case "order": {
        const list = question.querySelector(".cl-order");
        if (list)
          reorder(
            list,
            answer.parts.map((part) => part.id),
          );
        break;
      }
      case "match":
        for (const pair of answer.pairs) {
          const select = question.querySelector(`select[data-match-for="${cssEscape(pair.left)}"]`);
          if (select) select.value = pair.right;
        }
        break;
      case "locate":
        for (const part of answer.parts) {
          const segment = question.querySelector(
            `.cl-segment[data-segment="${cssEscape(part.id)}"]`,
          );
          if (segment) segment.setAttribute("aria-pressed", "true");
        }
        break;
    }
  }

  /** Re-apply the latest attempt at a quiz (and its grade, if graded) to its form. */
  function applyQuizState(state) {
    const { submission, grade, attempts } = state;
    if (grade && config.pendingPretests?.includes(submission.quizId)) {
      location.reload();
      return;
    }
    const form = quizForms().find((f) => f.dataset.quizId === submission.quizId);
    if (!form) {
      console.error(
        `[classroom] A saved attempt belongs to quiz "${submission.quizId}", which is not on this page.`,
      );
      return;
    }
    if (form.dataset.state === "broken") return;
    if (
      form.dataset.submissionId === submission.id &&
      grade &&
      grade.gradedAt < Number(form.dataset.activeGrade ?? "0")
    )
      return;
    if (
      form.dataset.state === "graded" &&
      form.dataset.submissionId === submission.id &&
      grade?.gradedAt === Number(form.dataset.activeGrade)
    ) {
      disputes.history(form, state.history ?? [grade]);
      disputes.render(form, state);
      expectedAnswers.apply(form, state);
      return;
    }
    if (attempts < Number(form.dataset.activeAttempt ?? "0")) return;
    if (submission.submittedAt < Number(form.dataset.submittedAt ?? "0")) return;
    // The grade can arrive through SSE before the submit response arrives.
    if (!grade && form.dataset.submissionId === submission.id && form.dataset.state === "graded")
      return;
    const reveal = Boolean(
      grade && form.dataset.state === "submitted" && !revealed.has(submission.id),
    );
    if (grade) revealed.add(submission.id);
    if (grade) form.dataset.activeGrade = String(grade.gradedAt);
    form.dataset.activeAttempt = String(attempts);
    form.dataset.submissionId = submission.id;
    form.dataset.submittedAt = String(submission.submittedAt);
    form.dataset.attempts = String(attempts);
    placeTeacherPanel();

    // Clear first: a grade can arrive for an attempt the form is already showing.
    form.querySelector("[data-cl-grade]")?.remove();
    for (const verdict of form.querySelectorAll(".cl-q-verdict")) verdict.remove();
    clearQuizAnswers(form);

    const groups = new Map();
    for (const answer of submission.answers) {
      if (!groups.has(answer.questionId)) groups.set(answer.questionId, []);
      groups.get(answer.questionId).push(answer);
    }
    for (const [questionId, group] of groups) {
      const question = form.querySelector(`.cl-q[data-question-id="${cssEscape(questionId)}"]`);
      if (question) restoreAnswer(question, group);
    }

    const attemptNote = attempts > 1 ? ` · attempt ${attempts}` : "";
    if (!grade) {
      expectedAnswers.apply(form, state);
      setQuizState(form, "submitted");
      setQuizStatus(
        form,
        `<span class="cl-spinner"></span> Submission saved. Waiting for your teacher to grade it.${attemptNote}${config.delivery === "wait" ? " Your teacher receives page requests while listening. If no grade arrives, return to chat and ask them to listen." : ""}`,
        true,
      );
      showGradingActivity(form);
      return;
    }

    setQuizState(form, "graded");
    setQuizStatus(form, `Graded ${new Date(grade.gradedAt).toLocaleString()}${attemptNote}`);
    renderGrade(form, grade, reveal);
    disputes.history(form, state.history ?? [grade]);
    disputes.render(form, state);
    expectedAnswers.apply(form, state);
  }

  function showGradingActivity(form) {
    if (form.dataset.state !== "submitted") return;
    const request = teacherState?.requests.find(
      (r) => r.kind === "quiz" && r.target === form.dataset.submissionId && r.status !== "done",
    );
    if (!request) return;
    if (request.status === "failed") {
      setQuizStatus(
        form,
        `Grading failed: ${request.error}. Use Retry request in the teacher panel.`,
      );
      const link = document.createElement("a");
      link.href = "#cl-teacher";
      link.textContent = "View request";
      form.querySelector(".cl-quiz-status").append(" ", link);
    } else {
      setQuizStatus(
        form,
        `${request.status === "queued" ? "Queued: " : ""}${TEACHER_WORKING.quiz}… Your answers are saved.`,
      );
    }
  }

  function renderGrade(form, grade, reveal) {
    form.querySelector("[data-cl-grade]")?.remove();

    const summary = document.createElement("div");
    summary.dataset.clGrade = "";
    if (reveal) summary.dataset.reveal = "true";
    const score = grade.score;
    summary.innerHTML = `
    <div class="cl-grade-banner">
      <span class="cl-grade-score">${Math.round(score)}<span>%</span></span>
      <span class="cl-grade-count">${escapeText(gradeSummary(grade.questions))}</span>
      <div class="cl-grade-meter" role="meter" aria-label="Quiz score" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"><span style="transform: scaleX(${score / 100})"></span></div>
    </div>
    <div class="cl-grade-feedback">${grade.feedbackHtml || escapeText(grade.feedbackMarkdown || "")}</div>
    ${gradePointsNotice(grade) ? `<p class="cl-quiz-status">${escapeText(gradePointsNotice(grade))}</p>` : ""}`;
    const anchor = form.querySelector(".cl-quiz-kind") ?? form.querySelector(".cl-quiz-title");
    if (anchor) anchor.after(summary);
    else form.prepend(summary);

    for (const [index, questionGrade] of grade.questions.entries()) {
      const question = form.querySelector(
        `.cl-q[data-question-id="${cssEscape(questionGrade.questionId)}"]`,
      );
      if (!question) continue;
      question.querySelector(".cl-q-verdict")?.remove();
      const verdict = document.createElement("div");
      verdict.className = "cl-q-verdict";
      verdict.dataset.correct = String(questionGrade.correct);
      const outcome = questionOutcome(questionGrade);
      verdict.dataset.outcome = outcome;
      if (reveal) {
        verdict.dataset.reveal = "true";
        verdict.style.animationDelay = `${(index + 2) * 100}ms`;
      }
      verdict.innerHTML = `<div class="cl-q-verdict-label"><span class="cl-verdict-icon" aria-hidden="true">${outcome === "correct" ? "✓" : outcome === "partial" ? "◐" : "×"}</span>${escapeText(questionGradeLabel(questionGrade))}</div><div class="cl-q-verdict-feedback">${
        questionGrade.feedbackHtml || escapeText(questionGrade.feedback)
      }</div>`;
      const details = document.createElement("details");
      details.className = "cl-criteria-disclosure";
      const toggle = document.createElement("summary");
      toggle.textContent = "Criterion breakdown";
      details.append(toggle);
      if (questionGrade.criteria?.length) {
        const list = document.createElement("ul");
        list.className = "cl-q-criteria";
        list.setAttribute("aria-label", "Rubric criteria");
        for (const criterion of questionGrade.criteria) {
          const item = document.createElement("li");
          const outcome =
            criterion.pointsEarned === criterion.pointsPossible
              ? "Met"
              : criterion.pointsEarned > 0
                ? "Partly met"
                : "Missed";
          item.innerHTML = `<div><strong>${escapeText(outcome)} · ${escapeText(criterion.description)}</strong> <span>(${escapeText(String(criterion.pointsEarned))}/${escapeText(String(criterion.pointsPossible))} points)</span></div><div>${criterion.feedbackHtml || escapeText(criterion.feedback)}</div>`;
          list.appendChild(item);
        }
        details.append(list);
      } else {
        const notice = document.createElement("p");
        notice.className = "cl-quiz-status";
        notice.textContent = "No criterion breakdown was recorded for this answer.";
        details.append(notice);
      }
      verdict.append(details);
      // A grade revision must keep the primary feedback before existing disclosures.
      const expected = question.querySelector(".cl-expected");
      if (expected) expected.before(verdict);
      else question.append(verdict);
    }
  }
  /** The unsubmitted answers of a quiz, or null when it has none. */
  function quizDraft(form) {
    const draft = {};
    for (const question of form.querySelectorAll(".cl-q")) {
      const entry = questionDraft(question);
      if (entry) draft[question.dataset.questionId] = entry;
    }
    return Object.keys(draft).length > 0 ? draft : null;
  }

  /** One question's answer as the learner left it, or null when it is untouched. */
  function questionDraft(question) {
    const entry = questionResponseDraft(question) ?? {};
    const confidence = question.querySelector("[data-cl-confidence]")?.value;
    const assistance = question.querySelector("[data-cl-assistance]")?.value;
    if (confidence) entry.confidence = confidence;
    if (assistance) entry.assistance = assistance;
    return Object.keys(entry).length ? entry : null;
  }

  function questionResponseDraft(question) {
    const some = (entry) => (Object.keys(entry).length > 0 ? entry : null);
    const filled = (pairs) => Object.fromEntries(pairs.filter(([, value]) => value));
    switch (question.dataset.type) {
      case "choice":
      case "multi": {
        const checked = own(question, "input[type=radio], input[type=checkbox]")
          .filter((input) => input.checked)
          .map((input) => input.value);
        return checked.length > 0 ? { checked } : null;
      }
      case "term":
      case "code":
      case "short": {
        const field = own(question, "textarea, input[type=text], input:not([type])")[0];
        return field.value ? { text: field.value } : null;
      }
      case "numeric":
        return some(
          filled([
            ["text", question.querySelector("input.cl-number").value],
            ["unit", question.querySelector(".cl-unit")?.value],
          ]),
        );
      case "cloze": {
        const blanks = filled(
          [...question.querySelectorAll("input[data-blank]")].map((blank) => [
            blank.dataset.blank,
            blank.value,
          ]),
        );
        return Object.keys(blanks).length > 0 ? { blanks } : null;
      }
      case "order": {
        const list = question.querySelector(".cl-order");
        const order = [...list.children].map((item) => item.dataset.item);
        return order.join(" ") === list.dataset.clInitial ? null : { order };
      }
      case "match": {
        const pairs = filled(
          [...question.querySelectorAll("select.cl-match-select")].map((select) => [
            select.dataset.matchFor,
            select.value,
          ]),
        );
        return Object.keys(pairs).length > 0 ? { pairs } : null;
      }
      case "locate": {
        const segments = [...question.querySelectorAll(".cl-segment[aria-pressed=true]")].map(
          (segment) => segment.dataset.segment,
        );
        return segments.length > 0 ? { segments } : null;
      }
    }
    throw new Error(`Question type ${question.dataset.type} has no draft.`);
  }

  /** Put a quiz draft back into a fresh form. */
  function restoreQuizDraft(form, draft) {
    for (const [questionId, entry] of Object.entries(draft)) {
      const question = form.querySelector(`.cl-q[data-question-id="${cssEscape(questionId)}"]`);
      if (!question) {
        console.error(
          `[classroom] A draft answer belongs to question "${questionId}", which is not in quiz "${form.dataset.quizId}".`,
        );
        continue;
      }
      if (entry.confidence !== undefined)
        question.querySelector("[data-cl-confidence]").value = entry.confidence;
      if (entry.assistance !== undefined)
        question.querySelector("[data-cl-assistance]").value = entry.assistance;
      for (const value of entry.checked ?? []) {
        const choice = own(question, "input[type=radio], input[type=checkbox]").find(
          (input) => input.value === value,
        );
        if (choice) choice.checked = true;
      }
      if (entry.text !== undefined) {
        const field =
          question.querySelector("input.cl-number") ??
          own(question, "textarea, input[type=text], input:not([type])")[0];
        field.value = entry.text;
        if (field.matches(".cl-number")) markNumber(field);
      }
      if (entry.unit !== undefined) question.querySelector(".cl-unit").value = entry.unit;
      for (const [id, value] of Object.entries(entry.blanks ?? {})) {
        const blank = question.querySelector(`input[data-blank="${cssEscape(id)}"]`);
        if (blank) blank.value = value;
      }
      if (entry.order) reorder(question.querySelector(".cl-order"), entry.order);
      for (const [left, right] of Object.entries(entry.pairs ?? {})) {
        const select = question.querySelector(`select[data-match-for="${cssEscape(left)}"]`);
        if (select) select.value = right;
      }
      for (const id of entry.segments ?? []) {
        const segment = question.querySelector(`.cl-segment[data-segment="${cssEscape(id)}"]`);
        if (segment) segment.setAttribute("aria-pressed", "true");
      }
    }
    setQuizStatus(form, "Draft restored. Submit when you are ready.");
  }
  function restoreDraft(id, value) {
    const form = quizForms().find((f) => f.dataset.quizId === id);
    if (!form)
      console.error(`[classroom] A draft belongs to quiz "${id}", which is not on this page.`);
    // A submitted or graded quiz keeps the answers it was sent with.
    else if (form.dataset.state === "fresh") restoreQuizDraft(form, value);
  }
  return {
    hydrateQuizzes,
    applyQuizState,
    restoreDraft,
    updateTeacher(state) {
      teacherState = state;
      for (const form of quizForms()) showGradingActivity(form);
      disputes.updateTeacher(state);
      expectedAnswers.updateTeacher();
    },
  };
}

export function quizForms() {
  return [...document.querySelectorAll("form.cl-quiz")];
}
