# Changelog

## 0.13.1

Based on 0.13.0. Upstream 0.12.1 is not merged yet.

### Changed

- The daily review allowance is now per classroom instead of shared by all classrooms.
  Each classroom may reserve `dailyReviewLimit` cards per UTC day (default 15, at most 50),
  with optional per-classroom `dailyReviewLimits` overrides. The allowance no longer ramps
  from yesterday's completions. One review still holds at most 12 cards, and grades, memory
  and due dates are unchanged.

## 0.13.0

Based on 0.12.0. Upstream 0.12.1 is not merged yet.

### Added

- Local preferences in `~/.pi/agent/classroom.json`, all defaulting to upstream behavior:
  `hideAnswerReports`, `reviewSize`, `reviewSingleForm`, `syllabusPie`. See
  [Configuration](docs/CONFIGURATION.md#local-preferences).
- Syllabus coverage pie on the classroom page, drawn from an optional `syllabus.json`
  (`target` exam, domains, weights, topics to lessons). No file means no pie and no error.
- Teacher usage and speed settings, off by default: `teacherSessions` (`"fresh"`),
  `teacherPromptOrder` (`"cache"`), `teacherModelCatalogSeconds`, `teacherSessionMaxTokens`, and
  `teacherRequestOverrides` (chat, refill, reflect only). With fresh sessions and the cache order,
  five panel replies on a 24-lesson classroom used about 70% fewer token-cost units, and each reply
  after the first about 85% fewer.
- `scripts/classroom-snapshot.ts` and an opt-in regression test
  (`STUDENS_CLASSROOMS_COPY`, optional `STUDENS_CLASSROOMS_BASELINE`) that checks a copy of real
  classrooms: lessons load, quizzes validate, review items and due lists match a baseline build,
  pages render, and the data is left byte-identical.

### Fixed

- Review scheduling: an item whose saved independence is on the event now counts as independent, so
  legacy items can space out.
- Legacy lessons parse review rubrics in the legacy format.
- The dedicated teacher prompt no longer contradicts the assistance policy.
- Headless lesson checks use Playwright's Chromium instead of an installed Google Chrome.

### Data

No stored format changed, so there is no migration. Submissions, grades, question ids, rubrics,
learning records and `syllabus.json` are only read.
