# Studens

Interactive lessons for Pi, Claude Code, and Codex. Highlight a passage to ask a
question, get answers in a saved thread, and submit quizzes for feedback.

![An answer card below a highlighted passage](screenshots/answer.png)

## Install

**Pi**

```sh
pi install git:github.com/maddoxrjohnson/studens@v0.13.2
```

**Claude Code**

```sh
claude plugin marketplace add maddoxrjohnson/studens
claude plugin install studens@studens
```

**Codex**

```sh
codex plugin marketplace add maddoxrjohnson/studens
codex plugin add studens@studens
```

All hosts require Node 22.19 or later, including the packaged Pi SDK. The plugin installs its runtime
dependencies on first start. There is no build step.

Pi installs the named release tag. Both plugin marketplaces also fetch the plugin
from a release tag, even when the catalog tracks `main`. Merging a feature PR does
not change the installed release. See [updating Studens](docs/USAGE.md#updating-studens)
for upgrades and moving an existing checkout installation to releases.

Upgrading from pi-teach? Remove the old plugin before installing Studens; see the
[upgrade guide](docs/USAGE.md#upgrading-from-pi-teach). Existing classrooms stay in place.

## Start learning

- **Pi:** `/teach <topic>`, then `/classroom` for the lesson link. The teacher service stays running after Pi exits.
- **Claude Code:** `/studens:teach <topic>` and `/studens:classroom`.
- **Codex:** Ask it to teach you a topic, then open your classroom.

Read, ask questions, and reply to the teacher on the lesson page. Quizzes save your
answers and feedback. The classroom page offers spaced reviews and folders.
Choose **Export** for an Anki deck, printable classroom, or portable Markdown.
Exports contain saved public material; expected answers stay excluded unless you
select answers already unlocked under the original grading rules.
All three hosts share a persistent local teacher service.

All three hosts save material in `~/.pi/agent/classrooms/`.

## More

- [Usage](docs/USAGE.md): commands, upgrades, service recovery, and phone access.
- [Configuration](docs/CONFIGURATION.md): settings, storage, and lesson links.
- [Screenshots](docs/FEATURES.md) · [Development](docs/DEVELOPMENT.md)
- [Teaching and authoring references](docs/README.md)

[MIT](LICENSE). Derived from Josh Noll's pi-teach and Matt Pocock's teaching skill;
see [attribution](docs/ATTRIBUTION.md).
