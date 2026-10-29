import { reviewProgress, reviewState } from "./review-presentation.mjs";

/** Group navigation only; each classroom keeps its quiz, grades and teacher panel. */
export function initDailyReview(control) {
  const id = control.dataset.clDaily;
  const button = control.querySelector("[data-daily-action]");
  const status = control.querySelector("[data-daily-status]");
  const list = control.querySelector("[data-daily-groups]");
  const progress = reviewProgress("Completed classrooms");
  const state = reviewState();
  status.after(progress.root, state.root);
  progress.root.hidden = true;
  const key = "studens-daily-review-request";
  let daily;
  let action = "check";
  let busy = false;
  let timer;
  let navigate = false;
  async function request(route, body) {
    const response = await fetch(
      `/api/${route}`,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Daily review request failed without a description.");
    if (!Object.hasOwn(result, "daily"))
      throw new Error("Daily review response has no saved state.");
    return result;
  }
  function render(result) {
    daily = result.daily;
    clearTimeout(timer);
    state.clear();
    const due = Object.values(result.due).reduce((sum, n) => sum + n, 0);
    if (!id) {
      const work = result.workload;
      if (!work || !Number.isFinite(work.remaining) || !Number.isFinite(work.nextWindowAt))
        throw new Error("Daily review response has no valid workload state.");
      control.querySelector("h2").textContent = `${due} due across classrooms`;
      control.querySelector("[data-daily-workload]").textContent =
        `${work.eligible} due slots available across all classrooms today · ${work.used} reserved or used of ${work.cap} daily review cards (each classroom has its own allowance, UTC). ${work.deferred} due items deferred; their due dates are unchanged. Next workload window: ${new Date(work.nextWindowAt).toISOString()}. Prepared questions are required.`;
      action = daily ? "open" : "start";
      button.textContent = daily ? "Continue daily review" : "Start daily review";
      button.disabled = !daily && (due === 0 || work.eligible === 0);
      status.textContent = daily
        ? "Your saved classroom groups are ready to continue."
        : due
          ? work.eligible === 0
            ? "Every classroom with due work has used today's allowance. Due work stays listed."
            : "Review due ideas in separate classroom groups."
          : "Nothing is due. Return after your next review becomes due.";
      if (!daily && due === 0)
        state.show("empty", "All caught up", "Nothing is due. Your next review will appear here.");
      if (navigate && daily) location.assign(daily.url);
      return;
    }
    if (!daily)
      throw new Error(
        "This saved daily review no longer exists. Return to Today to choose a current review.",
      );
    const completed = daily.groups.filter((group) => group.complete).length;
    progress.root.hidden = false;
    progress.update(
      completed,
      daily.groups.length,
      `${completed} of ${daily.groups.length} classrooms complete`,
    );
    if (daily.complete)
      state.show(
        "complete",
        "Daily review complete",
        "Each classroom keeps its answers, feedback, and review history.",
      );
    else if (daily.groups.some((group) => group.error || group.status === "failed"))
      state.show(
        "partial-failure",
        "Daily review paused",
        "Saved progress is preserved. Resolve the classroom error below, then explicitly retry.",
      );
    list.replaceChildren();
    for (const [index, group] of daily.groups.entries()) {
      const item = document.createElement("li");
      item.className = "cl-daily-group cl-card-box";
      const name = document.createElement(group.available ? "a" : "strong");
      name.textContent = group.title;
      if (group.available) name.href = group.url;
      const note = document.createElement("p");
      note.textContent = group.empty
        ? "No due items remain"
        : `${group.count} ${group.count === 1 ? "item" : "items"} · ${group.complete ? "Complete" : index === daily.active ? "Current classroom" : "Up next"}`;
      const history = document.createElement("a");
      history.textContent = `${group.title} review history`;
      history.href = group.historyUrl;
      item.append(name, note, history);
      if (group.error) {
        const error = document.createElement("p");
        error.className = "cl-inline-error";
        error.setAttribute("role", "alert");
        error.textContent = `${group.title}: ${group.error}`;
        item.append(error);
      }
      list.append(item);
    }
    const group = daily.groups[daily.active];
    button.hidden = daily.complete;
    button.disabled = false;
    status.textContent = daily.complete
      ? "Daily review complete. Each classroom keeps its review history."
      : `Classroom ${daily.active + 1} of ${daily.groups.length} · ${group.title}`;
    if (daily.complete) return;
    if (group.error || group.status === "failed") {
      action = "retry";
      button.textContent = `Retry ${group.title} review`;
    } else if (group.available) {
      action = "group";
      button.textContent = `Continue ${group.title} review`;
      if (navigate) location.assign(group.url);
    } else if (group.status === "planned") {
      action = "continue";
      button.textContent = `Start ${group.title} review`;
    } else {
      button.disabled = true;
      button.textContent = `Preparing ${group.title} review…`;
      timer = setTimeout(check, 1000);
    }
  }
  function failed(error) {
    clearTimeout(timer);
    navigate = false;
    action = "check";
    button.hidden = false;
    button.disabled = false;
    button.textContent = "Retry daily review state";
    status.textContent = "";
    state.show(
      id ? "stale" : "error",
      id ? "Cannot load saved daily review" : "Cannot load daily review",
      error.message,
    );
  }
  async function check() {
    try {
      render(await request(`daily-review${id ? `?id=${id}` : ""}`));
    } catch (error) {
      failed(error);
    }
  }
  button.addEventListener("click", async () => {
    if (busy) return;
    if (action === "open") return location.assign(daily.url);
    if (action === "group") return location.assign(daily.groups[daily.active].url);
    busy = true;
    button.disabled = true;
    try {
      if (action === "check") await check();
      else {
        const requestId = daily?.id || sessionStorage.getItem(key) || crypto.randomUUID();
        sessionStorage.setItem(key, requestId);
        const group = daily?.groups[daily.active];
        const result = await request(
          action === "start" ? "daily-review" : `daily-review/${action}`,
          { id: requestId, classroom: group?.classroom },
        );
        sessionStorage.removeItem(key);
        navigate = true;
        render(result);
      }
    } catch (error) {
      failed(error);
    } finally {
      busy = false;
    }
  });
  window.addEventListener("cl-activity-retried", (event) => {
    if (event.detail.kind === "daily" && (!id || event.detail.id === id)) {
      navigate = true;
      check();
    }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    navigate = false;
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) check();
  });
  check();
}

export function addDailyReviewLink(navigation) {
  const id = new URL(location.href).searchParams.get("daily");
  if (!id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return;
  const link = document.createElement("a");
  link.href = `/reviews/daily/${id}`;
  link.textContent = "Continue daily review";
  navigation.append(link);
}
