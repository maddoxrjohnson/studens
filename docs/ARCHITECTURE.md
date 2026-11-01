# Architecture

[Documentation](README.md)

Studens is a self-contained Pi package and Claude Code/Codex plugin, installed from
[max-miller1204/studens](https://github.com/max-miller1204/studens). It is an
independent continuation of [joshrnoll/pi-teach](https://github.com/joshrnoll/pi-teach),
outside the upstream fork network. It is not published to npm. Keep the upstream MIT
notices and [teaching attribution](ATTRIBUTION.md).

Release installs resolve a named `v<version>` Git tag. Pi's install spec and both
plugin marketplace source entries pin that tag. Marketplace catalogs may track
`main`, but their plugin sources do not. Successful `main` CI publishes a release
only when that version has not been released. Existing release tags are never moved.
Loading a checkout directly remains an explicit development path.

## Hosts and lifecycles

Pi loads `index.ts` through `pi.extensions` in `package.json`. Its commands and
extension tools use the same private service socket and tool dispatcher as MCP.
The extension disconnects on session shutdown; HTTP and queued teacher work continue.
It never installs browser hooks or starts a competing HTTP server.

Claude Code and Codex load the root plugin through `.claude-plugin/` and
`.codex-plugin/`. Their marketplaces list this root. `mcp/launch.mjs` checks Node,
installs production dependencies on first use, and starts `src/mcp-stdio.ts`.
MCP clients attach to that persistent service. Closing stdin detaches the client.

Pi's dedicated teacher uses the packaged Pi SDK with the existing Pi account,
provider catalog, and effective model settings. Configuration is read into memory;
retry, compaction, and cache warming are disabled for these service turns, without editing global
settings. A single structured-output tool returns a plan to the service and cannot
write learner data. Its persisted Pi session lives in the private service directory.
Dedicated in-memory settings clear package, extension, skill, prompt, and theme
sources before SDK resource resolution, which can install packages before applying
loader flags. Account/provider/model/thinking settings are retained; global and
project configuration files remain unchanged.
Initiating Pi chat context, extensions, skills, and project context files are not
inherited. The dedicated teacher receives saved classroom context and each durable
request instead. Initiating chat can author lessons directly. Explicit browser Next lesson requests use the same dedicated persistent teacher conversation.

Codex dedicated turns use a read-only sandbox with shell and research disabled.
Explicitly disable every configured MCP server, apps and plugin discovery. Disable
apps and plugins at process startup as well as in thread settings: per-thread flags
alone leave the native app catalog available, and an empty MCP map can merge with
inherited servers. Claude dedicated turns use no tools and a
strict empty MCP configuration. Pi exposes only its plan-return tool.

One service owns one classrooms root and stable loopback port. Each classroom has
one selected backend and dedicated teacher session. Browser requests start teacher
work without a listening initiating agent. An explicit open selects the opening app's teacher adapter. A cross-adapter open
waits for the active request and migrates ownership after a read-only readiness turn.
A list open reserves all classrooms and commits them together. Same-adapter opens
check readiness and retain the native session and model selection. Package, version,
and configured port mismatches still require an explicit stop or error.

The teaching brief is read by skills and `begin_teaching`. Keep it out of the system
prompt and MCP `instructions`. Wake-up prompts must include the classroom, lesson,
request content, and answering tool because they can arrive many turns later.

## Runtime and files

There is no build step. Pi loads `.ts`; Claude Code and Codex use Node 22.19+ type
stripping. Relative imports end in `.ts`, and type-only imports use `import type`.
No enums or parameter properties. Browser code is `.mjs`/`.js`, served directly.
Shared browser modules need handwritten `.d.mts` sidecars for TypeScript callers.

All hosts share `~/.pi/agent/classrooms/`, overridden by `PI_CLASSROOMS_DIR`.
See [configuration and storage](CONFIGURATION.md). Legacy service, socket, and Pi
route ownership names remain stable across the Studens rename; changing them would
hide existing owners and recovery state. Package assets resolve from `import.meta.url`,
never the working directory or files outside the package.

## Module map

| Boundary                                        | Entry points                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Pi service client, commands, status             | `index.ts`, `pi-service-client.ts`, `commands.ts`, `status-widget.ts`      |
| HTTP lifecycle, feature routes, static guards   | `server.ts`, `server/`, `paths.ts`                                         |
| Disk state API and feature storage              | `store.ts`, `store/`                                                       |
| Shared tools and host prompts                   | `tools.ts`, `prompts.ts`                                                   |
| MCP dispatch and control transport              | `mcp.ts`, `mcp-stdio.ts`, `service-client.ts`, `service-main.ts`           |
| Durable requests and plans                      | `service-state.ts`, `teacher-service.ts`                                   |
| Model adapters, deadlines, grade decoding       | `teacher.ts`, `pi-teacher.ts`, `teacher-deadline.ts`, `teacher-grading.ts` |
| Daily classroom groups                          | `server/daily-review.ts`, `store/daily-review.ts`                          |
| Resume and review publication                   | `teacher-resume.ts`, `review-session.ts`                                   |
| Private variant pools and refills               | `review-variants.ts`, `review-pool.ts`, `review-refill.ts`                 |
| Quiz, rubric, pretest, plan validation          | `quiz.ts`, `rubric.ts`, `pretest.ts`, `teaching-plan.ts`                   |
| Review schedule, learning evidence, diagnostics | `review.ts`, `evidence.ts`, `health.ts`                                    |
| HTML and Markdown                               | `pages.ts`, `lesson-html.ts`, `markdown.ts`                                |
| Tailnet route ownership and links               | `phone-access.ts`, `tailnet-links.ts`                                      |

`server.ts` keeps the loopback singleton and public exports. `server/` owns
classroom pages, records, folders, annotations, quizzes, review, teacher endpoints,
and learner state. Shared HTTP helpers, hooks, and the SSE registry live there;
closing the singleton closes its SSE clients before the HTTP server.

`store.ts` preserves the public storage exports. `store/` separates filesystem
discovery, lesson summaries, folders, annotations, quiz history and submissions,
review evidence, reflections, panel messages, drafts, and records. Discovery and
quiz history do not depend on submission creation, so lesson and review reads do
not create circular feature dependencies. Canonical path helpers and static guards
remain in `paths.ts`. Persisted formats and request ordering are unchanged.

Names in the table are under `src/` unless stated. `assets/runtime/classroom.js`
boots the lesson features and dispatches saved state and SSE events. `highlights.mjs`
owns selection and the question composer; `cards.mjs` owns annotation threads;
`quiz-ui.mjs`, `reflections.mjs`, `glossary-ui.mjs`, and `teacher-panel.mjs` own their
respective page features. `review-screen.mjs` presents one review quiz card at a time,
with shared grading, drafts, and the teacher panel. Each feature keeps its own state and receives its lesson
config, content root, and dependencies at construction. `drafts.mjs` serializes draft
saves; each feature restores its own draft after saved state has rendered.
`lesson-dom.mjs` holds shared DOM helpers, while `anchor.mjs` stays DOM-free.
`shell.js` owns other pages. Pure contracts in that folder are imported by the server
and tests as well as the browser. Browser modules are served directly without a build.
`assets/templates/quiz.html` is the markup contract; lesson and review templates
are shells with an invalid placeholder type until authored.

Mermaid and Temml are vendored with licenses and versions. Update them through
`scripts/vendor-mermaid.ts` and `scripts/vendor-temml.ts`. Load diagrams and math
before text indexing. Skip generated diagram/MathML nodes in highlights and send
source notation to grading. Answers and feedback render Markdown server-side.

Runnable `code` answers use the pinned browser QuickJS WASM interpreter after an
explicit Run. Each disposable worker gives its guest VM no browser objects, host
functions or module loader, with time/memory/output limits. Public test outcomes
are debugging context. Submit saves exact source and public inputs with the normal
immutable attempt; the teacher assesses source under private declared criteria.
No learner source executes on the host, and Run grants no learning evidence or
points. See [code exercises](CODE-EXERCISES.md) for the authoring and isolation contract.

## State invariants

- **Ownership changes use a private journal.** Opens run in service order. Pause
  affected queues after their active request. Prepare every candidate before the
  durable commit decision. Recovery drops uncommitted decisions and completes
  committed identity and unfinished service lesson-owner writes before queue restore.
  Keep prior native identities privately. Readiness never applies learner plans.
  Failed opens return no link and never retry failed learner inference.

- **Requests are sequential and durable per classroom.** Save each plan before writes.
  Save raw model output before decoding. Recovery completes saved calls and skips
  already saved grades. Interrupted calls show specific errors and require retry.
  Storage failures retain validated plans; rejected allocations require a new plan.
- **Plans are restricted by request type.** Service teachers return per-question
  allocations through `grade_quiz_answers`; the service computes the score and
  validates identities, rubric weights, correctness, and arithmetic. Version 2 plans
  use this format. Older saved plans retain their original score validation.
  Resume requests permit a teacher message only. Only chat/reflection allow gap notes.
  Fresh panel replies return a typed nullable `retrieval_check` that carries its learning
  record; code adds the classroom and exact saved reply and saves the canonical
  `record_retrieval_check` call as a version 3 plan; a null check stays version 2.
  Saved version 2 plans keep their calls. Plan operations are described as plan
  fields, never as callable tools. A Claude stream that calls one natively without
  returning it in the plan fails for explicit retry, with a small private stream
  digest on the failed request.
- **Pi uses the service FIFO.** Initiating chat turns cannot answer queued browser
  work. The dedicated Pi session returns exactly one structured plan; prose cannot
  substitute for a grading operation. The old bridge remains only in historical
  regression fixtures and shared answer/grade persistence helpers.
- **Conversations stay on the lesson page.** Cards hold the original answer and ordered
  follow-ups. Answer the oldest pending turn. Post quiz retrieval questions and learner
  replies in the teacher panel. Resume the exact latest graded submission without
  inventing a reply or grading again. Interrupted inference requires explicit retry on every host.
- **Closed grades are code-owned.** Validated assessments use machine-checkable
  private keys for choice, multi, numeric, order, match, and normally cloze. Term
  and locate can explicitly opt into exact grading. Save the computed allocations
  privately on the submission before grade writes. HTTP completes closed-only
  attempts without a teacher turn; startup and host recovery reuse the saved
  allocations and skip existing grades. Mixed requests contain only judgment
  answers. Reject teacher overrides and compute the final score with `gradeScore`
  from merged raw points. Attempts saved before machine allocations existed retain
  the original rubric validation and teacher grading contract.
- **Grade disputes are revisions of saved attempts.** An explicit learner action saves
  the question, grade timestamp, reason, original submission and verified rubric snapshot
  in the classroom FIFO. Dedicated teachers return only `resolve_grade_dispute` plans.
  Fresh responses use typed dispute data with the exact saved dispute UUID and
  question id bound in the response schema. Code serializes the canonical plan;
  persisted plans keep their format and recovery checks. Machine disputes permit
  only explanation/authoring-defect decisions and a null question allocation.
  Revalidate the exact target and snapshot before inference and application. Only the
  disputed judgment allocation can change; `mergeGrades` still rejects machine overrides.
  Explain or flag machine disputes without writing another grade. Save validated plans
  before revisions, and link accepted grade files to their dispute for recovery even if
  the process stops before saving the applied receipt. Never write learning records,
  retrieval checks, authoring changes or gap notes from a dispute. Publish only linked
  learner reasons, responses and existing grade feedback/history. Replaying uses the
  original attempt and first feedback, with no extra exposure or review completion.
- **Expected answers are read-only and attempt-bound.** New attempts privately save
  the lesson source digest alongside the rubric digest. The expected-answer endpoint
  accepts only the current saved attempt and requires the original complete grade,
  unchanged source, exact quiz/question type, and an allowlisted rubric projection.
  Correct original answers and graded pretests are available immediately. Original
  check/review misses require a completed validated corrective request, its actual
  saved learner reply, the server-selected preceding teacher task chain back to this
  exact attempt, and the matching saved retrieval check/record. An exact question
  key can identify one miss; an objective shared by several misses is insufficient.
  Historical replies without that provenance remain unavailable. Dispute revisions
  do not bypass the original-miss gate. No read/reveal runs a teacher, writes evidence,
  changes a grade, unlocks an editor or completes a daily review. Missing/changed
  originals give specific errors and explicit retry, never a replacement key.
- **Submission order is total.** Timestamps increase strictly per lesson. Attempts
  count submissions; regrades are revisions. Use `latestGrades()` consistently for
  scores, quiz state, health, and review. Refuse another attempt while one is ungraded.
- **Review history is separate.** New review identities resolve under classroom `.reviews/`
  and use `/c/<classroom>/reviews/<review-id>`. Each card has a durable quiz and grade;
  all cards must be graded before the session completes. Keep numbered legacy review
  paths and saved documents unchanged. Both layouts participate in discovery and recovery,
  while reviews stay out of the learner's lesson list and lesson count. Closed misses
  enqueue durable corrective panel requests, with one request per submission.
- **Reviews are derived.** Schedule lesson-local objectives from saved answer evidence;
  questions are probes. Same-attempt probes count as one exposure, and any incomplete
  probe resets the objective. Historical answers without objective context keep their
  question key and unknown context. Never read the current plan to replay history.
  Keep old question links usable by saved reviews, panel checks, and recovery.
  Exclude pretests. Save review requests and selected items before
  publication. New reviews deterministically select private preauthored variants and
  save the complete document before writes; no model authoring is needed. Legacy
  questions without pools are skipped with an explicit error when none are eligible.
  Validate keys, rubric, controls, and plan before publication. Hide unfinished
  reviews from lists, routes, and submissions. Repeated clicks reuse work; published
  reviews open across hosts. Saved service plans resume without another model turn.
- **Explicit next lessons are private until checked.** The classroom control saves
  an owner-bound request in `.lesson-requests.json`. Its optional topic and status
  survive reload. Service authoring shares the classroom request queue and teacher
  identity for Pi, Claude, and Codex. Pi SDK authoring advertises only its typed
  output tool and bounded public source reader, with no external resources or
  native file/shell tools. Each SDK turn reconstructs its tools when reopening the
  same private session; ordinary requests expose only the plan tool. A research
  failure requires explicit retry. Owning-request and current SDK tool cancellation
  stop research before DNS or sockets, interrupt active transfers, and prevent
  following redirects or accepting late output. Classroom resources are supplied through path
  guards. Private service-delivery markers distinguish new Pi authoring from legacy
  live-session requests, which must finish in their previous package. Only explicit
  authoring enables web research. Dedicated Codex processes disable
  installed plugins, connected apps, execution and other unrelated tools, disable
  configured MCP servers, and require an empty per-thread MCP inventory before
  inference. An empty configuration map alone does not remove plugin tools.
  Provider lesson responses carry HTML, rubric entries, objective mappings and private
  variants as typed data. Code serializes both private JSON files and the canonical
  saved publication call; models never encode nested JSON strings. New lesson
  turns on Pi's OpenAI Responses APIs require strict function output using the same
  all-required lesson schema; unsupported strict capability fails explicitly. Other
  Pi APIs retain their native tool schema validation. Cross-field HTML/private-key
  coverage still requires host validation on every backend. Dedicated authoring includes
  a complete typed response example that separates original rubrics from variants.
  Validate hidden HTML and both gate stages with the served-page parser before saving
  a publication plan; never repair malformed tags or derive missing original rubrics. New lesson
  publication declares criterionContract1 and checks the fixed criteria on every
  visible question and private review variant. Save and validate complete output before
  publication, run `scripts/check-lesson.ts` in disposable state, then expose the
  lesson. Recover checked output without a model turn; retain rejected output and
  require explicit retry. Never create learner submissions during checking.
- **Daily review keeps classroom boundaries.** The private root `.daily-reviews.json`
  saves every classroom selection and document before the first publication. Each
  group reuses a normal classroom review and its original objective keys. Group
  completion derives from saved card grades; navigation never grades or extends a
  schedule. Later groups need explicit progression. Reads, reloads and repeated
  starts reuse saved requests; publication and ownership failures require retry.
  Daily history links to each classroom’s separate review history and teacher panel.
  Save declared criterion requirements with new prepared plans and retain their
  definitions in the private document through publication. Legacy plans remain
  compatible. Public attempts redact criterion and early-timing snapshots.
- **Variant refills are background work.** Save private refill requests with their host
  and learner mistake. Run them after queued learner requests in the same sequential
  teacher session. Fresh service responses use typed variants bound to the saved
  classroom, request id, and exact count; the host serializes the canonical plan.
  Keep saved canonical plans recoverable without a model turn. Save validated output before atomically adding a supplemental
  private pool; never rewrite a submitted rubric. Recover saved output once. Failed
  model work requires explicit retry and cannot block an already prepared review.
  Replaying the same saved batch never duplicates variants.
- **Learner marks never wake a teacher.** Version-1 `.learner-marks.json` files hold
  highlights, margin notes, and bookmarks separately from question annotations.
  Private path guards, an exclusive edit lock, atomic replacement, and per-mark
  revisions protect writes. Reads and mark actions create no assessment or learning
  evidence. The canonical text index and text-quote selector anchor marks; tied or
  missing passages stay unresolved. Browser paint ranges leave authored controls
  intact, and mark editors remain outside quizzes and their answer snapshots.
  Unsent mark drafts stay in the tab session; only explicit actions send writes.
- **Drafts never wake a teacher.** Restore them once on load, only into fresh quizzes.
  Reconnect must not overwrite typing. Successful submissions clear their draft.
- **Daily edits serialize across hosts.** Lock root batch creation and group edits,
  reloading state under the lock. Save every classroom plan before publication.
  A busy or interrupted save names the lock and requires explicit retry. Reads
  never publish or retry classroom work.
- **Folder edits keep classroom paths stable.** Lock `.folders.json` edits and replace
  state atomically. Conflicts and stale locks name the cause and require explicit retry.

## HTTP and browser boundaries

Bind HTTP to loopback. Connected Tailscale links use owned, tailnet-only Serve routes;
respect config, preserve unrelated routes, and never enable Funnel. All hosts use the service-owned route. Legacy Pi route ownership remains
discoverable for explicit cleanup; never take over a live legacy route. Route errors do not select another port or backend.

Every static route uses the guards in `paths.ts`, including symlink checks.
Never serve `quiz/`, private plans, teacher state, or recovery files. Media routes
are deliberately narrow. Invalid stored state must throw a specific error.

Cards remain after their highlighted block in DOM order, outside quiz controls.
On wide lesson shells, passage panels dock in the reserved right column; below
1100px they remain inline. Panels without sufficient side space also stay inline.
Ignore nested card events when collecting or locking quiz answers. Exclude mutable
quiz runtime UI from text indexing. Preserve question IDs after submission.
The lesson runtime adds the header before wiring the theme toggle; the inline theme
bootstrap prevents a light flash. Widgets derive the current port from server state;
unsupported widget APIs must not bring the server down.

See [development](DEVELOPMENT.md) for verification and the
[feature recipes](../.agents/skills/verify-studens/features/README.md) for browser checks.
