# Teaching evidence registry

Checked: 2026-10-06. This registry records principles and their limits. It does not
claim that studens improves human learning. Sources support conditional practices.
Our counts, intervals, evidence thresholds, and UI remain choices to evaluate.
When a rule changes, update its implementation, tests, and this registry together.
The teaching brief uses these rule ids. Keep the brief and skill consistent.

## P1: Prequestion the upcoming idea

**Sources:** [Pan and Carpenter (2023)](https://link.springer.com/article/10.1007/s10648-023-09814-5),
[Richland, Kornell, and Kao (2009)](https://learninglab.uchicago.edu/Publications_files/RichlandKornellKao.pdf),
[St. Hilaire, Chan, and Ahn (2024)](https://pubmed.ncbi.nlm.nih.gov/37640836/).

**Finding:** Attempts before study can improve later learning even when answers are
wrong. The meta-analysis found benefits concentrated on prequestioned material.
**Limits:** Do not promise improvement on all lesson material. Prerequisite tests
and retrieval of previous topics serve different purposes.
**Behavior:** Ask about central upcoming objectives. Invite predictions, explanations,
or attempted solutions. Gate teaching until grading. Map questions to teaching.
Feedback can stress or clarify an idea. The gate releases prewritten teaching.
**Choice:** Two or three questions is a practical default, not an optimum.
**Verify:** Plan validation, leak tests, semantic authoring review, human delayed tests.

[Yu et al. (2025)](https://sc-pan.github.io/pdf/YHADP_2025.pdf) studied science stories
with children aged 5 to 6. Benefits occurred with immediate feedback. Results without
feedback were not significant in those experiments. This supports prompt feedback
and cautions against applying adult findings to every learner and setting.

## P2: Retrieve and apply

**Sources:** [Roediger and Karpicke (2006)](https://www.psychologicalscience.org/journals/psychological-science/j.1467-9280.2006.01693.x/),
[Butler (2010)](https://pubmed.ncbi.nlm.nih.gov/20804289/).

**Finding:** Retrieval can improve delayed retention. Repeated testing supported
inferential transfer in the studied tasks.
**Limits:** Recognition, copied blanks, and puzzle complexity do not establish
independent application. Transfer depends on what is learned and tested.
**Behavior:** Map questions to objectives. Use fresh situations, method choice,
diagnosis, and justification when relevant. Accept equivalent valid solutions.
**Verify:** Alternate-solution and partial-credit grading cases; unfamiliar delayed
human questions. An agent solving its own quiz tests software and adherence only.

## P3: Fade suitable support

**Source:** [Atkinson, Renkl, and Merrill (2003)](https://experts.azregents.edu/en/publications/transitioning-from-studying-examples-to-solving-problems-effects-/).

**Finding:** Fading worked steps with principle-focused self-explanation supported
transition to problem solving in the studied procedures.
**Limits:** This does not require one layout for every topic or learner.
**Behavior:** For suitable new procedures, use worked examples, principle explanations,
faded completion, then independent practice. Reduce support from demonstrated knowledge.
**Verify:** Semantic authoring review checks the progression and reasons for support.
Supported completion and reflection cannot count as independent retention.

## P4: Separate performance from retention

**Sources:** P2 and P5. Immediate performance can differ from delayed performance.
**Behavior:** Preserve grades. Label prior knowledge, assisted work, immediate
independent work, delayed retrieval, and transfer separately. Mark old context unknown.
**Choice:** The progress labels require independent delayed successes on two occasions,
with a total span of at least seven days. Application objectives also require delayed
transfer. These thresholds are conservative product choices, not scientific constants.
The UI says retained evidence, not mastery. A reflection or confidence rating is no proof.
**Verify:** Time, assistance, transfer, historical, revision, and chat-check tests.

## P5: Space for a retention goal

**Sources:** [Cepeda et al. (2008)](https://pubmed.ncbi.nlm.nih.gov/19076480/),
[FSRS algorithm, FSRS-4.5 and inherited v4 equations](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm),
[official TypeScript implementation](https://github.com/open-spaced-repetition/ts-fsrs),
[FSRS class documentation](https://open-spaced-repetition.github.io/ts-fsrs/classes/FSRS.html).
Algorithm sources checked 2026-10-19: wiki revision `7bcf7dc343fc81d0fc55db2705c8b8fe85c2daa5`
(page edited July 28, 2026); TypeScript repository `3bc3c5505a49484f6077f094d4f13ad7200f82b8`.
The current library and algorithm versions differ. Studens pins an adaptation of
**FSRS-4.5**, not the current library defaults. No implementation code is copied,
no dependency is added, and the package still requires no build.

**Finding:** In fact learning, useful spacing depended on the later retention interval.
FSRS models difficulty, stability and elapsed time rather than fixed boxes.
**Limits:** Neither source supplies a universal formula for every skill or learner.
This adaptation is not upstream-compatible FSRS, fitted personalization, a calibrated
recall probability, or evidence of improved human learning.

**Behavior:** `elapsed-independent-v1` remains the evidence boundary. Replay saved
latest grade revisions, first feedback times and linked checks, never the current
plan or model narrative. Regrading is not another exposure. Same-attempt objective
probes use their weakest credit and independence. Only full independent retrieval
on or after the due time, at least 24 actual hours after the latest feedback/check,
can grow stability and extend the interval. Explicitly selected early reviews never
postpone their saved original due date, even if answered later. Replay also honors
the due-time cap in immutable selections created under the earlier scheduler. Supported, unknown,
and immediate success cannot grow memory. Incomplete work resets delayed evidence;
three unresolved misses pause review for re-teaching. A supported or unknown-independence success cannot
resolve a paused item, including historical questions with no objective snapshot.
Saved assistance/support can resolve an independently demonstrated gap while the
historical objective context and retention claim remain unknown. Historical context stays unknown. Confidence and
self-ratings have no scheduling input; confidence may shape feedback only.

**Memory choices (`studens-fsrs45-v1`):** Start stability S at 1 day and difficulty D
at 5.1618. Use the published 4.5 parameters, frozen in `src/review-memory.ts`:
`[0.4872,1.4003,3.7145,13.8206,5.1618,1.2298,0.8975,0.031,1.6474,0.1367,1.0461,2.1072,0.0793,0.3246,1.587,0.2272,2.8755]`.
For eligible full retrieval, use the 4.5 curve R=(1+19t/(81S))^-0.5 and inherited
successful-recall equation with G=3, using actual elapsed days t, including overdue
time. R is an internal calculation, not a learner-facing recall estimate. Difficulty
uses v4 mean reversion toward 5.1618. The interval at nominal 0.9 is S, with a one-day
minimum, interval milliseconds rounded upward, and no fuzz or randomness. Clamp S to 0.25..3650 days and D to 1..10.
Zero credit uses the inherited forgetting equation, limited to the old S, and raises
D by 2×0.8975. **Fractional credit is a Studens product mapping:** for 0<c<1,
S becomes S×(0.85+0.1c), and D rises by 0.5×(1-c). This is a 5..15% setback,
not upstream Hard (which describes successful recall), not another grade, and not
a validated optimal mapping. Legacy missing credit is binary. Intervals after
incomplete work use the resulting S with the one-day minimum. The optional retention
duration still caps each interval at floor(duration/4), minimum one day. This is a
heuristic limit, not a deadline. Never invent a learner deadline. The legacy `box`
field is diagnostic only; it no longer determines any date.

**Workload choices:** Per classroom and UTC calendar day, cap new selections at the
`dailyReviewLimit` setting (default 15, at most 50; `dailyReviewLimits` overrides it per
classroom). One review still holds at most 12 cards. Missed days accumulate no allowance. Failed, published,
and unstarted saved daily groups reserve their cards before writes; unfinished older
plans continue to reserve them across midnight. Completed selections still consume
their selection day's slots, even when their evidence remains unknown or a miss.
A classroom's classroom, daily, topic and early-review entry points share its budget;
all classrooms share the root transaction lock. Reload/recovery reuse plans; no old attempt or saved batch is
rewritten to spread dates. Canonical aliases share a reservation; original saved cards still count separately toward workload. Already saved larger batches are grandfathered and may
exceed a newly derived allowance; they can finish, but consume all available slots.
This is a workload cap, not evidence of forgetting, an implicit grade change, or a
scientifically optimal workload. Namespace card identities by classroom, so identical
lesson keys in different subjects are separate cards. A card is one item in one
saved review; regrades and linked chat checks grant no extra slots. One classroom's
budget never limits another's.

Due counts include deferred and reserved items; pausing and retirement keep their
existing exclusions. The daily landing shows root totals and the classroom memory map shows
local due slots against that classroom's allowance. Due dates stay separate from
new-selection slots, reserved/used slots, deferred work and the next UTC workload
window. That window is the earliest budget reset, not a guaranteed review date.
A prepared private variant is still required; a slot does not promise a usable variant.

The classroom memory map projects the same saved replay, without scheduling or
inference on reads. Per-objective strength describes observed evidence, with latest
answer context and credit separate from estimated stability/difficulty. Incomplete
answer gaps remain open through assisted or unknown success and close on a full
independent answer; immediate correction is still not delayed retention. Historical
question evidence retains its original lesson, quiz and question identity. Grade
revisions use the original answer and first feedback boundary. The displayed reason
is the scheduler's saved replay reason, not an explanation invented by a model.

Its fourteen-date forecast counts current saved due dates once in UTC calendar days.
Today includes the entire overdue backlog and later-today due times; subsequent
dates show only newly due items. Paused and retired items are excluded. Reserved
and deferred due items remain visible as due; today's summed per-classroom allowances,
used/reserved slots, local available slots and deferred count are shown separately.
No future completions, repeat reviews, future allowances or shared-root allocations
are predicted. The next due time is a saved scheduling estimate, not an allocated
review appointment or measured forgetting. Reading, expanding and navigating write
no canonical state and create no evidence.

For the all-topic daily picker, make one queue per classroom and per saved objective
group/objective/historical lesson topic. Order classroom and topic queues by their
latest saved selection time (never selected first), breaking ties by stable identifier.
Round-robin one card per topic within each classroom, up to min(12, that classroom's
remaining allowance). Keep the existing alphabetical classroom navigation
order after selection; save every selected group together before publishing one.
Individual classroom and explicit topic/early choices may direct remaining slots;
they cannot obtain another allowance. Within a topic, order by max(due time, latest
feedback/check), then stable key, with existing related-strategy interleaving.
Recently checked unknown/assisted items cannot continually jump untouched backlog.
With finite eligible classroom/topic queues and continued completion of saved groups,
least-recent selection prevents systematic first-classroom/topic starvation. No
progress is promised without completions, under an infinite influx of older/never
selected work, while paused/retired, without prepared variants, or when the learner
deliberately keeps choosing other classrooms/topics. No due date is changed by smoothing.

**Migration/rollback:** All new memory/workload state is derived, with no write-back
migration of grades/history. Read-only replay recalculates old due dates under this
versioned policy. Saved selections/documents remain fixed. Reverting code restores
the former derived dates; assessment files and historical aliases remain intact.

**Verify:** Deterministic replay, elapsed and UTC boundaries, revisions/aliases,
partial/zero/full and confidence invariance, assistance, early review, retention caps,
restart/reload and shared reservations. Current corrective prompts carry code-owned
reply and feedback/check timestamps. New panel checks save their host-owned
`answeredAt` separately from the check/feedback write time `at`, so queued teacher
latency cannot turn an immediate answer into delayed retrieval. Old checks retain
their saved `at` as their only available timing, with no history migration. The
previous selected exposure's elapsedDays
is not the current correction's delay. Free-form records cannot override those times.
Human pilots must compare delayed outcomes and workload across policies.

## P6: Interleave related methods

**Sources:** [Rohrer, Dedrick, and Burgess (2014)](https://pubmed.ncbi.nlm.nih.gov/24578089/),
[Rohrer et al. (2020), classroom trial](https://ies.ed.gov/ncee/wwc/Study/88770),
[Samani and Pan (2021), undergraduate physics](https://pubmed.ncbi.nlm.nih.gov/34772951/).

**Finding:** Mixed practice can support later problem solving when learners must
select a strategy. Newer classroom and physics work extends the evidence settings.
**Limits:** Mixing unrelated subjects is not a substitute for method discrimination.
**Behavior:** Alternate distinct strategies within an authored related group. Keep
ungrouped items in due order. Supply private policy labels to review authors.
**Choice:** Deterministic round-robin strategy selection. Early instruction can remain blocked.
**Verify:** Same-lesson different-strategy, cross-lesson related-group, and unrelated cases.
Check that prompts do not announce the method.

## P7: Calibrate feedback

**Source:** [Butler, Karpicke, and Roediger (2008)](https://pubmed.ncbi.nlm.nih.gov/18605878/).

**Finding:** Feedback benefited low-confidence correct responses in the studied task.
**Limits:** Confidence does not determine correctness or demonstrate understanding.
**Behavior:** Offer optional confidence. Explain correct but uncertain answers. Give
useful correction and one fresh follow-up after errors. Record assistance separately.
**Verify:** Equal credit at all confidence levels, useful uncertain-correct feedback,
and assisted answers excluded from independent retention evidence.

## P8: Use representations for a task

**Source:** [IES practice guide (2007)](https://ies.ed.gov/ncee/wwc/PracticeGuide/1).

**Finding:** The guide recommends combining graphics with verbal descriptions and
asking explanatory questions. Its original evidence ratings are historical ratings.
**Limits:** A diagram or varied response type alone does not cause learning.
**Behavior:** Preserve nine types and Mermaid on every host. Choose types from mental
work. Give diagrams accessible descriptions. Inspect rendered relationships and grading source.
**Verify:** Browser diagrams, source sent to grading, keyboard controls, and all-type tests.

## P9: Verify claims with suitable evidence

**Basis:** Measurement limits of P1 through P8. This is an evaluation policy.
**Behavior:** Test software, agent adherence, and human outcomes separately.
**Verify:** [Evaluation protocol](EVALUATION.md). Publish failed runs and missing evidence.
Do not describe the extension as scientifically validated without human outcome data.
