# omniloop

Manage your work by what you're doing, not by space or agent. Stands alone: needs `hc` (herdr-core) and
node, plus the Herdr app for the view. The rules are in `SPEC.md`.

| Path | What |
|---|---|
| `core/omniloop.js` | who leads a loop and who hears about each member (pure) |
| `core/watch.js` | the watcher's step: notes, batching, stalls, timers, escalation (pure) |
| `core/view.js` | what the pane shows (pure) |
| `bin/omniloop.mjs` | CLI for agents and the watcher process |
| `core/projects.js` | projects: matching a request to projects, and what a project adds to a member's launch (pure) |
| `projects/<name>/` | projects shipped with omniloop; your own go in `~/loops/projects/<name>/` and win on a name clash |
| `mod/` | the Herdr pane; `scripts/install.sh` copies it with `core/` into `$HERDR_APP_HOME/mods/omniloop` |

`npm test` runs the unit tests (no model, no hc). `npm link` puts `omniloop` on your PATH, which agents
need to run it.

## CLI

```sh
omniloop ls [loop]                           # the loop as a tree; * = lead
omniloop join <loop> --lead --goal "…"       # make this terminal a loop's lead
omniloop start <loop> --job J -- claude "…"  # start a helper that reports to you (a tab in your space)
omniloop timer 20m "check the build"         # a note later, once you stop working
omniloop needs-you [off]                     # this block is the user's
omniloop handoff <file>                      # restart yourself fresh from a hand-off file
omniloop watch [--loop id] [--dry-run]       # the watcher (one per machine)
omniloop brief                               # the ~900-character brief every member reads at start
omniloop new <id> --goal "…" --project study    # a loop with a project (repeat --project for more); a goal is required
omniloop goal [set "…" | add "…" | done N]   the loop's goal; there is always one
omniloop project ls [--json]                    # the projects omniloop can find
omniloop project match "<request>" [--json]     # which projects a request calls for
omniloop project add <project> [--loop id]         # give an existing loop a project
```

## Goals

Every loop always has a goal, kept in `~/loops/<id>/loop.json` (`goal` is the current one, `goals` the history,
`goalRev` counts changes). `omniloop goal` shows it; `goal set "…"` replaces it, `goal add "…"` adds another open
one, `goal done N` closes one, never the last. `new` refuses a loop without one.

- **You see it:** as a paragraph under each loop's name in the Omniloop pane.
- **Agents get it:** at start from the loop's CLAUDE.md (between `<!-- omniloop:goal -->` markers). On a change,
  members started by omniloop load `plugin/` (a Claude Code plugin), whose hook (`bin/goal-hook.mjs`) adds one
  line to their next prompt, and again after a compact or resume; an unchanged goal adds nothing. Members started
  some other way get the line typed in, if they're waiting.

## Tasks

The goal is the end; tasks are the steps. Each loop keeps `tasks.json` in its folder, with two kinds of owner:
you, and agents (by terminal). `omniloop task` lists the caller's own open tasks; `task ls` lists everyone's;
`task add "…" --for you|me|t3`, `task done N`, `task give N you|t3`. A task handed to another agent is typed
into it if it's waiting. The pane shows your tasks as a checklist under the goal (click to finish) and the
agents' tasks under that. Writes take a short lock, so agents can add tasks at the same time.

## Projects

A project is reusable context for a kind of work: a folder with `project.json` (name, description, trigger words and
URLs, repos), `CONTEXT.md` (copied into each loop's CLAUDE.md, between `<!-- omniloop:projects -->` markers), and
`.claude-plugin/` plus `skills/` so members load it with `--plugin-dir`. A loop lists its projects in `loop.json`.
The picker (⌘O) pre-ticks projects whose triggers appear in what you typed; a loop made with projects and a goal
starts its lead on the goal instead of asking.

- **study:** reels, videos and podcasts into a slide deck and a randomized practice test, published on upublish,
  with a root page listing every kit. Its test engine (`kit/`) is shared; each kit writes only its slides and
  its question bank. `bin/study-check.mjs` and `bin/study-smoke.mjs` (headless Chrome) gate publishing.

## Status (2026-11-12)

- Verified: 42 unit tests; an end-to-end watcher run with fake agents (hidden child terminals reporting
  status through OSC 7501) in a scoped test loop; the view rendered in an isolated Herdr window with fake
  loops, both "watcher off" and "watcher on".
- Not done: nothing installed into the real Herdr, no real watcher running, sound untested, the view not
  yet tried as a docked pane (only as a pop-up), `handoff` and `start` not run against real Claude agents.
