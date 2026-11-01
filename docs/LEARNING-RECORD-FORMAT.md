# Learning Record Format

Learning records live in `./learning-records/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc. Create the directory lazily : only when the first record is written.

They record evidence and stated prior knowledge for future teaching decisions.
They do not calculate a learner's ability or prove retained knowledge.

## Template

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

That is the whole format. A learning record can be a single paragraph. State what
the evidence shows and how it changes the next teaching decision.

## Optional sections

Only include these when they add genuine value. Most records won't need them.

- **Status** frontmatter (`active | superseded by LR-NNNN`) : useful when an earlier understanding turns out to be wrong and is replaced.
- **Evidence** : how the user demonstrated the understanding (a question answered, an exercise completed, prior experience cited). Useful when the claim might be revisited.
- **Implications** : what this unlocks or rules out for future sessions. Worth recording when non-obvious.

## Numbering

Scan `./learning-records/` for the highest existing number and increment by one.

## When to write a learning record

Write one when any of these is true:

1. **The user demonstrated genuine understanding of something non-trivial** : not just exposure, but evidence they can use the concept correctly. This sets a new floor for what to teach next.
2. **The user disclosed prior knowledge** : "I already know X." Record the claimed depth. Label it as self-report until an independent response supports it.
3. **A misconception was corrected** : the user previously believed something wrong and now sees why. These are high-value: they predict future stumbling blocks for related topics.
4. **The mission shifted in response to learning** : the user discovered they cared about something different than they thought. Cross-link to [[MISSION.md]] and update it.

### What does _not_ qualify

- Material that was merely covered. Coverage is not learning. Wait for evidence.
- Anything already captured tersely in [[GLOSSARY.md]] as a term definition. Don't duplicate.
- Session-by-session activity logs. Learning records are not a journal : they are decision-grade insights.

## Supersession

When a later record contradicts an earlier one (the user's understanding deepened or corrected), mark the old record `Status: superseded by LR-NNNN` rather than deleting it. The history of how understanding evolved is itself useful signal.

## Link a quiz correction

After a successful panel retrieval check, link an active record to the original
review item with a retrieval check (`record_retrieval_check`). Initiating hosts call
it as a tool; a dedicated teacher returns it in its plan. Include the learner's
actual answer and the new question. Explain how that answer demonstrates the missed
idea. Use the item key `<lesson>/<quiz id>/<question id>` from the grade or review
schedule.

This link updates current health and the review schedule. It preserves the quiz
score and attempt. The runtime does not infer mastery from free-form prose.
Do not link superseded records or material that was merely covered.

## Evidence context

State what the work shows: prior knowledge, assisted performance, immediate
independent performance, delayed retrieval, or transfer. State the actual delay
and assistance report when known. Keep unknown context unknown. Do not call a
reflection, confidence report, or immediate correction retained knowledge.
A correct pretest can show prior knowledge. It cannot create review penalties.
Use the saved attempt's objective context. Preserve earlier grades and records.
For application objectives, describe the unfamiliar situation and the principle
used. Changing values alone does not establish transfer.
