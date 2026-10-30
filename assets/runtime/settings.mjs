import { settingsError } from "./settings-error.mjs";

const root = document.querySelector("[data-cl-settings]");
const api = `/api/settings?classroom=${encodeURIComponent(root.dataset.clSettings)}`;
const errorBox = root.querySelector("[data-settings-error]");
const reload = root.querySelector("[data-settings-load]");
const modelForm = root.querySelector('[data-settings-form="model"]');
const select = modelForm.elements.model;
let state;
let catalog;
let teacherStatus;
let statusTimer;
let lastTeacherError;
function showError(node, message) {
  node.textContent = message || "";
  node.hidden = !message;
}
async function request(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Settings request failed (${response.status}).`);
  return result;
}
function renderReviewDefaults() {
  const shared = state.review.values.sharedLimit ?? state.review.defaultLimit;
  root.querySelector("[data-review-limit]").placeholder = `Shared default (${shared})`;
  root.querySelector("[data-review-shared-limit]").placeholder =
    `Built-in default (${state.review.defaultLimit})`;
}
function modelInput() {
  modelForm.querySelector("[data-custom-model]").hidden = select.value !== "__custom__";
}
function renderTeacher() {
  const teacher = teacherStatus;
  root.querySelector("[data-teacher-owner]").textContent = teacher
    ? `${teacher.identity.backend === "claude" ? "Claude Code" : teacher.identity.backend === "pi" ? "Pi" : "Codex"} · this classroom’s teacher`
    : "Open this classroom from Pi, Claude Code, or Codex to attach its teacher.";
  modelForm.hidden = !teacher;
  root.querySelector("[data-teacher-active]").textContent = teacher
    ? `${teacher.identity.backend === "pi" ? "Last Pi SDK model selection" : "Last answering model"}: ${teacher.identity.activeModel || "No answer yet"}`
    : "";
  root.querySelector("[data-teacher-request]").textContent = teacher
    ? `Requested setting: ${teacher.identity.requestedModel ?? "tool’s configured default"}${teacher.identity.activeModel ? ` · Last answer used setting: ${teacher.identity.activeRequestedModel ?? "tool’s configured default"}` : ""}`
    : "";
  root.querySelector("[data-teacher-work]").textContent = teacher?.running
    ? `Teacher request in progress using ${teacher.running.requestedModel ?? "the tool’s configured default"}. A saved change will apply after this request.`
    : teacher
      ? "The saved model will be used for your next request."
      : "";
  const error = teacher?.error || "";
  if (lastTeacherError !== error) {
    lastTeacherError = error;
    const node = root.querySelector("[data-teacher-error]");
    node.replaceChildren();
    node.hidden = !error;
    if (error) {
      const parsed = settingsError(error);
      const reason = document.createElement("p");
      reason.dataset.teacherErrorReason = "";
      reason.textContent = parsed?.reason ?? error;
      node.append(reason);
      if (parsed) {
        const context = document.createElement("p");
        context.className = "cl-settings-error-context";
        context.textContent = parsed.context;
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Technical details";
        const original = document.createElement("pre");
        original.textContent = error;
        details.append(summary, original);
        node.append(context, details);
      }
      const action = document.createElement("p");
      action.textContent =
        "Choose a model below, then use Retry request on the lesson when you’re ready.";
      node.append(action);
    }
  }
}
function renderModels(preserveInput = false) {
  if (!state.teacher) return;
  const requested = preserveInput ? select.value || null : state.teacher.identity.requestedModel;
  select.replaceChildren(
    new Option(
      `Use tool’s configured default${catalog ? ` (${catalog.configuredModel})` : ""}`,
      "",
    ),
  );
  for (const model of catalog?.models || [])
    if (model.id !== "default") select.add(new Option(model.label, model.id));
  if (
    requested &&
    requested !== "__custom__" &&
    !Array.from(select.options).some((option) => option.value === requested)
  )
    select.add(new Option(`${requested} (saved selection)`, requested));
  select.add(new Option("Custom model ID…", "__custom__"));
  select.value = requested ?? "";
  modelInput();
}
async function loadModels() {
  const button = root.querySelector("[data-model-load]");
  button.disabled = true;
  try {
    catalog = await request(
      `/api/settings/models?classroom=${encodeURIComponent(root.dataset.clSettings)}`,
    );
    renderModels(true);
    showError(root.querySelector("[data-model-error]"));
  } catch (error) {
    showError(
      root.querySelector("[data-model-error]"),
      error.message + " Select Reload models to retry.",
    );
  } finally {
    button.disabled = false;
  }
}
// Refresh saved status without replacing edits or their original save revisions.
function watchTeacherStatus() {
  clearTimeout(statusTimer);
  if (!state.teacher) return;
  statusTimer = setTimeout(async () => {
    try {
      const next = await request(api);
      if (
        (next.teacher?.identity.selectionRevision ?? 0) >=
        (state.teacher.identity.selectionRevision ?? 0)
      ) {
        teacherStatus = next.teacher;
        renderTeacher();
      }
      watchTeacherStatus();
    } catch (error) {
      showError(
        root.querySelector("[data-teacher-status-error]"),
        `Teacher status could not refresh: ${error.message} Reload settings to retry.`,
      );
      reload.hidden = false;
    }
  }, 2000);
}
async function load() {
  clearTimeout(statusTimer);
  reload.disabled = true;
  try {
    state = await request(api);
    teacherStatus = state.teacher;
    showError(root.querySelector("[data-teacher-status-error]"));
    for (const section of ["preferences", "review", "connection"]) {
      const form = root.querySelector(`[data-settings-form="${section}"]`);
      for (const [name, value] of Object.entries(state[section].values)) {
        const input = form.elements[name];
        if (input.type === "checkbox") input.checked = value;
        else input.value = value ?? "";
      }
    }
    renderReviewDefaults();
    root.querySelector("[data-connection-current]").textContent =
      `Currently serving on local port ${state.currentPort}. A blank port uses ${state.host === "service" ? "43123" : "an available port"}.`;
    root.querySelector("[data-connection-override]").textContent = [
      state.connection.environmentPort && state.host === "service"
        ? `The service’s environment overrides the local port with ${state.connection.environmentPort}.`
        : "",
      state.connection.tailnetDisabled
        ? "Tailscale links are disabled by this server’s environment."
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    root.querySelector("[data-settings-content]").hidden = false;
    showError(errorBox);
    reload.hidden = true;
    renderTeacher();
    renderModels();
    watchTeacherStatus();
    if (state.teacher) await loadModels();
  } catch (error) {
    showError(errorBox, error.message);
    reload.hidden = false;
  } finally {
    reload.disabled = false;
  }
}
for (const form of root.querySelectorAll("[data-settings-form]"))
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const section = form.dataset.settingsForm;
    const button = form.querySelector('[type="submit"]');
    const status = form.querySelector("[data-save-status]");
    button.disabled = true;
    status.textContent = "Saving…";
    try {
      let values;
      if (section === "model")
        values = {
          requestedModel:
            select.value === "__custom__" ? form.elements.customModel.value : select.value || null,
        };
      else
        values = Object.fromEntries(
          Array.from(form.elements)
            .filter((input) => input.name)
            .map((input) => [
              input.name,
              input.type === "checkbox"
                ? input.checked
                : input.type === "number"
                  ? input.value === ""
                    ? null
                    : Number(input.value)
                  : input.value,
            ]),
        );
      const revision =
        section === "model"
          ? (state.teacher.identity.selectionRevision ?? 0)
          : state[section].revision;
      const next = await request(api, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, revision, values }),
      });
      // Keep unsaved fields in the other forms intact.
      state[section === "model" ? "teacher" : section] =
        next[section === "model" ? "teacher" : section];
      // Review and connection share classroom.json, so both need its new revision.
      if (section === "review" || section === "connection") {
        state.review.revision = next.review.revision;
        state.connection.revision = next.connection.revision;
      }
      if (section === "review") renderReviewDefaults();
      teacherStatus = next.teacher;
      renderTeacher();
      if (section === "model") renderModels();
      showError(errorBox, next.applyError);
      reload.hidden = !next.applyError && root.querySelector("[data-teacher-status-error]").hidden;
      status.textContent = next.applyError
        ? "Saved; link changes need an explicit retry."
        : section === "connection"
          ? "Saved. Links updated; local port applies after a server restart."
          : section === "model"
            ? "Saved for the next teacher request. Failed requests still need Retry request on the lesson."
            : section === "review"
              ? "Saved. Applies to the next review you start."
              : "Preferences saved for this classroom.";
    } catch (error) {
      status.textContent = "Save failed.";
      showError(errorBox, error.message);
      reload.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
select.addEventListener("change", modelInput);
reload.addEventListener("click", load);
root.querySelector("[data-model-load]").addEventListener("click", loadModels);
await load();
