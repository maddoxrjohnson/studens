# Configuration and storage

[Back to the README](../README.md)

## Configuration

Optional, at `~/.pi/agent/classroom.json`:

```json
{
  "port": 4098
}
```

| Key               | Default | Meaning                                                                                                |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `port`            | `43123` | Fixed port. An occupied or invalid port causes an error.                                               |
| `tailscale`       | `true`  | Use tailnet links while Tailscale is connected. `PI_CLASSROOM_TAILSCALE=0` overrides.                  |
| `tailscalePort`   | `8443`  | HTTPS port for the shared persistent service tailnet route. An occupied port causes an error.          |
| `piTailscalePort` | `8444`  | Legacy live-session Pi route port; retained for old-package cleanup. An occupied port causes an error. |

### Local preferences

These keys keep one learner's preferred behavior in the config file, outside the plugin
directory, so a plugin upgrade or merge cannot silently drop it. Every default is the
upstream behavior.

| Key                          | Default | Meaning                                                                                                                                                      |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hideAnswerReports`          | `false` | Hide the assistance and confidence dropdowns. Quiz answers default to assistance `none`. The teacher decides assistance in panel checks.                     |
| `reviewSize`                 | `5`     | Default items per review and the daily review allowance. Whole number from 3 to 12.                                                                          |
| `reviewSingleForm`           | `false` | Build a review as one form with one submit, not one card per question. Saved reviews keep their stored form.                                                 |
| `syllabusPie`                | `true`  | Draw a coverage pie on the classroom page when the classroom has a `syllabus.json`. Without the file nothing is drawn and nothing fails.                     |
| `teacherModelCatalogSeconds` | `0`     | Reuse Claude's model catalog for this many seconds (0 to 3600). `0` runs one discovery process per teacher request.                                          |
| `teacherSessionMaxTokens`    | unset   | Start a fresh Claude teacher session once a request used more input tokens than this (20000 to 2000000). Requests carry their full context, so this is safe. |
| `teacherRequestOverrides`    | unset   | `{"chat": {"model": "...", "effort": "low"}}`. Only `chat`, `refill`, and `reflect` can be overridden. Grading and lesson requests never are.                |

A classroom that sets its own teacher model keeps it. Overrides apply to the Claude teacher only.

The legacy-lesson review fixes (saved independence spaces out legacy items, and legacy lessons
parse rubrics in the legacy format) are not settings. `test/local-preferences.test.ts` pins them.

Claude Code and Codex read the same file. `/classroom`, `/teach`, and `open_classroom`
return a link. They never open a browser. See [phone and remote links](USAGE.md#phone-and-remote-links). Lesson checks run in a separate headless
session. The scaffold instructions name the packaged headless config.
Set `PI_CLASSROOM_CONFIG` to read the settings from another file.

All three hosts use the persistent service port `43123` by default. A configured
`port` applies to the shared service. `PI_CLASSROOM_SERVICE_PORT` takes priority over
that file. The stable private socket and `.pi-teach-service` ownership identity are
unchanged. An occupied port fails explicitly; no alternate port is selected.
Pi's SDK reads `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) for account credentials,
`models.json`, and model/thinking settings. Service startup captures its environment;
stop and restart explicitly after changing that environment.
Get the current URL from `open_classroom` or `/classroom`.

## Storage

```text
~/.pi/agent/classrooms/
  <classroom-name>/
    classroom.json          title and emoji
    MISSION.md              why you are learning this
    RESOURCES.md            trusted sources, split Knowledge / Wisdom
    GLOSSARY.md             canonical terminology
    NOTES.md                your preferences, and an index of the teacher's notes
    notes/                  slug.md: the topic files NOTES.md indexes
    quiz/retrieval-checks/  successful chat checks linked to review items
    learning-records/       NNNN-slug.md: what you have actually learned
    reference/*.html        cheat sheets, built to be revisited and printed
    assets/                 shared components across lessons
    .review-controls.json   retirement state and revisions; evidence stays in quiz history
    .reviews.json           durable review requests, selected options, and saved documents
    .reviews/review-<id>/   review pages, drafts, panel state, and private quiz history
    NNN-lesson-name/
      lesson.html           the lesson
      lesson.json           title and summary
      annotations.json      your question threads and their answers
      reflections.json      your self-explanations
      quiz/
        key.json            private rubric and predeclared criterion weights
        submissions/*.json  your answers and private grading snapshots
        grades/*.json       your teacher's grading
```

Set `PI_CLASSROOMS_DIR` to keep material somewhere else. Pi, Claude Code, and Codex all
use the same directory, so a classroom you start in one continues in the others.

A lesson directory is recognised by containing an HTML document: `lesson.html` if
present, else the first `lesson-*.html` (so a literal `lesson-001.html` works), else the
first `.html` file. Lesson order comes from the numeric prefix on the directory name.

The `quiz/` directory is never served as static files, only through the JSON API. An
answer key written to `quiz/key.json` is therefore not readable from the page.
New scaffold metadata includes `criterionContract: 1`. Private submission files
save `rubricCriteria` definitions fixed before submission; learner JSON responses
omit this snapshot and saved machine allocations. After grading, public grades
include only each submitted question's approved criterion descriptions, earned and
possible points, and explanations. Regrades add files; saved history is never
rewritten to infer missing criteria. Older attempts retain their original totals
and display that no criterion breakdown was recorded.

New reviews open at `/c/<classroom>/reviews/<review-id>`. Review history is at
`/c/<classroom>/reviews`; reviews do not appear in the lesson list. Existing
numbered review directories and their lesson links remain usable. The `.reviews/`
directory is never a static route, and review keys and plans remain private.

Progress offers sizes 3 through 12 and topics from saved objective groups.
Ungrouped items use the original objective; historical items use their lesson.
Early selections save their timing on submissions: neither a success nor a miss
can extend the scheduled interval. Immediate or assisted performance remains
separate from delayed retention evidence. Retirement excludes an item from active
counts and future selections while retaining its actual quiz evidence and every
published review. Restore it from `Manage review items`. Edits use a private lock
and revisions; stale or interrupted edits require an explicit retry.

`Flag bad question` prepares a report in the review's teacher panel. Add the problem
and send it there. Reports use the same durable teacher requests, saved messages,
owner checks, and explicit failure retry as other panel replies. They do not change
question pools, saved grades, or historical links. Private control and teacher state
are never static routes.

### Links in teaching documents

Links to other sites and PDFs open in a new tab. This applies to lessons,
reference documents, and the classroom's markdown pages. Classroom and lesson
navigation stay in the current tab. Links that set their own `target`, or carry a
`download` attribute, are left alone.

Lesson URLs use `/c/<classroom>/<lesson>` without a trailing slash. They do not match
filesystem paths. From a lesson, use:

- `./` for the classroom page.
- `assets/<path>` for shared classroom assets.
- `<other-lesson>` for another lesson in the same classroom.
- `/r/<classroom>/<file>.html` for a reference document.

Do not use `../assets/<path>` from a lesson. It resolves to `/c/assets/<path>`.
From a reference document, use `/c/<classroom>/<lesson>` for lesson links. Replace
`{{CLASSROOM_NAME}}` in the reference template with the classroom directory name.

## Settings page

Open a classroom and select **Settings** beside Review history. Connection settings are shared across classrooms and use the validated configuration file above; unrelated keys are preserved. Local port changes apply only after an explicit server stop and restart. Obtain the new link from your agent. Tailnet link changes apply on save using the current host’s owned route, while environment overrides still take priority. A failed link update reports that the settings were saved and asks for another explicit save to retry.

Pace, depth, and tone are optional single-line preferences, at most 200 characters each. They are stored as `- Pace:`, `- Depth:`, and `- Tone:` bullets inside `NOTES.md`’s `## Preferences` section. Other preferences, the notes index, and other classrooms are preserved. Missing notes start from the canonical notes template. A stale page must reload before saving over a newer edit.

All persistent classrooms offer **Teacher model**. **Use tool’s configured default** reads the installed tool’s effective configuration for the next request, including when a previous request selected another model. The dropdown is discovered from the installed host: Codex uses paginated `model/list` and its configured model; Claude uses its initialization catalog and effective settings. **Custom model ID…** supports configured/provider IDs that are absent from the picker. Discovery does not guarantee account access. The Claude discovery protocol was verified with Claude Code 2.1.303; unsupported host protocols report an error and require explicit action.

Selections are private to the classroom’s `.teacher.json`, survive service restarts, and never edit global CLI configuration. Claude receives `--model`; Codex receives the model on thread start/resume and turn start. **Last answering model** comes from Claude’s assistant messages or the completed Codex turn’s resolved thread model, independently of the requested/default setting. A reported reroute or unexpected resolution fails the request before its plan is applied.

A setting change applies between teacher requests and keeps the existing conversation. Running work finishes with its original setting; saved plans recover without another model request or grade. A model error names the selection and stays visible until explicit request retry. Choosing another setting alone does not retry the request. Pi selects an exact `provider/model` ID through its SDK catalog and records the
successful SDK selection separately as **Last Pi SDK model selection**. The packaged
Pi SDK initializes its assistant model from the selected catalog entry; its
OpenAI Codex response handlers do not independently replace that value with a
provider-resolved response model. This label reports the exact SDK selection,
not independent evidence of upstream routing. The service rejects SDK fallback
messages or a different SDK selection; provider-side rerouting remains unverified.
Its dedicated session is saved privately under
`.pi-teach-service/pi-sessions/`; include it in whole-data backups. A missing or
unsafe session file is an explicit recovery error, never a new conversation.
