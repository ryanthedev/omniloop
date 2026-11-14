# Omniloop

Written 2026-11-12; owner: the user. Omniloop stands alone. It needs only herdr-core (`hc`) and node, plus the
Herdr app for the view. It depends on no Claude Code plugin (herderp) and reads none of their
labels.

## The idea

You manage work by **what you're doing**, not by space or agent. An **omniloop** is one piece of work
("ship Plenary M2", "fix SEC-6096"). Its agents can sit in any space on its machine.

## One machine per loop (2026-11-12)

A loop lives on the machine it was made on: its folder, its agents and its watcher. The same id on two
machines is two loops. Each machine runs its own omniloop and watcher and sees only its own loops. A
computer connected to other machines (`hc machine ls`) also sees theirs, keyed `<machine>/<id>`
(`core/omniloop.js` `loopKey`), and shows their alerts for you, but its watcher never types into another
machine's terminals: that machine's watcher does. Nothing omniloop sends to a machine names another one.

Every loop has a **coordinator**: an agent, or you. Only the coordinator talks to you. An agent that gets stuck goes to
whoever it reports to, and they unstick it. It nests: a coordinator starts subagents, and a
subagent can start its own.

## A loop is a folder, a space and a Claude project

`omniloop new <id> --goal G --dir ~/repos/a --dir ~/repos/b` makes:

- **`~/loops/<id>/`**, with `CLAUDE.md` (goal, context folders, decisions) and `loop.json`
  (`{ id, goal, dirs: [{ path, machine }] }`). Every agent starts in this folder, so it is their shared
  Claude Code project: they all read its `CLAUDE.md`, and their sessions are saved together under it.
- **A Herdr space named `<id>`**, starting in that folder, with the coordinator as its first tab. `omniloop start`
  puts subagents into it.
- **Context:** each agent gets `--add-dir` for every context folder on its machine, and
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, so each folder's own `CLAUDE.md` loads too. Verified
  2026-11-12 with Claude Code 2.1.323: without the variable only the loop folder's `CLAUDE.md` loaded; with it,
  both did. `omniloop add-dir <path>` adds a folder (agents started later get it).
- **Claude's launch** is the user's own: `~/loops/config.json` `"claude"`, taken once from their shell's
  `claude` alias (settings, plugins), since a non-interactive shell skips aliases.
- **Order matters:** the task goes right after `claude`, because `--add-dir` takes a list and would read a
  trailing task as one more folder.
- **Trade-off:** a repo's own `.claude/settings.json` doesn't apply (the project is the loop folder); agents
  work in repos by absolute path. Folders on another machine only reach agents started there.

## Labels (herdr-core terminal labels; all can change after start)

| Label | Meaning |
|---|---|
| `omniloop=<id>` | This terminal works on loop `<id>` on its own machine (seen from elsewhere as `<machine>/<id>`). |
| `omniloop.coordinator=1` | This agent coordinates the loop. One per loop; with more, the oldest coordinates and tools warn. Also written as the old key `omniloop.lead=1`, which is still read (a terminal labelled by an older version stays recognised). |
| `omniloop.goal=<text>` | What the loop is for (read from the coordinator first, then any agent). |
| `omniloop.to=<terminal>` | Its parent: who gets its blocks and results. A remote terminal may omit its own machine. |
| `omniloop.job=<text>` | What it's doing, for the view. |
| `omniloop.notify=me` | This agent may reach you directly. |
| `omniloop.ask=1` | Set by `bin/ask-hook.mjs` (Stop hook) when the agent's last message asks the user something; cleared at the next prompt. |
| `omniloop.you=<ms>` | Set by `bin/ask-hook.mjs` (UserPromptSubmit hook) when a person typed the prompt: the time of it. |
| `omniloop.needs=you` | Set by the agent itself (`omniloop needs-you`): this block is yours. |
| `omniloop.retired=<t>` | Handed off to `<t>` (`omniloop handoff`); out of the loop. |

Never use herdr-core's `parent` field (Herdr shows a parented terminal as a pane-less child terminal).

## Who hears about a blocked, finished or stalled agent

The first rule that matches wins.

1. `omniloop.needs=you`: **you** (agents use it for credentials, spending, anything public).
2. A **permission or auth** prompt: **you**. A parent agent can't approve a prompt in another terminal.
3. The coordinator: **you**.
4. The loop has no coordinator: **you** (you coordinate it).
5. `omniloop.notify=me`: **you**.
6. Blocked 10 minutes with nobody clearing it: **you** (`ESCALATE_MS`, a default).
7. Otherwise its parent; if the parent is blocked too, further up; with no parent, the coordinator.

A terminal in no loop reaches you, exactly as today. Retired or finished terminals leave the loop, so a
handed-off coordinator's successor coordinates. `error` counts as `blocked`.

## The watcher: monitoring at zero model tokens

`omniloop watch` is a plain program, not an agent. It follows `hc events` (one snapshot, then deltas:
`created`, `labels`, `status`, `turn`, `finished`, `removed`), so it never polls herdr-core, and every 15 s
it checks timers and stalls.

- **Notes:** it types a one-line note into the agent that should hear (`hc send`), e.g.
  `omniloop: t3 blocked (question): which db?`. Each thing is told once (by address, kind and turn).
- **Batching:** notes for an agent wait while it works or is blocked (`hc send` refuses a blocked program),
  then go as one line when it stops. A busy coordinator gets one wake-up for many agents.
- **Only work it was given (2026-11-13):** a "finished its turn" note wakes the parent only for a turn the parent
  started (a message from it, or its `hc send`), one omniloop started (a note, a timer), or a started subagent's
  first prompt (its task). A turn a person typed, or one another session asked for, goes to the loop feed only:
  waking an idle coordinator costs a whole turn, often on a cold prompt cache. The Stop hook reads who gave the turn from
  the transcript (`origin.kind` `peer` or `human`; typed `<hc from="X">` and `omniloop:` are agents'). A session
  whose hook didn't record it is told as before. Rule: `core/watch.js` `worthTelling`.
- **No re-routing:** a note already delivered to a parent isn't re-sent up the chain when that parent
  blocks later; only an escalation to you is news again.
- **Stalls:** working with no event for 20 minutes (`STALL_MS`) is told once, routed like a block. This
  also catches a session stuck at the folder-trust dialog, which reports `working`, never `blocked`.
  A long build looks the same, so a stall is a nudge, not an alarm.
- **Timers:** `omniloop timer 20m "check X"` writes a file the watcher reads; when it's due, the text
  arrives as a note once the agent stops. Agents never sleep or poll.
- **For you:** written to `~/.cache/omniloop/state.json` (with a heartbeat); the view shows them and can
  play the sound.
- **Gone parents:** notes for a parent that finished or retired come to you.

Token cost, measured in the end-to-end test (fake agents, 2026-11-12): two notes, 58 characters, for a
blocked builder plus a timer; zero tokens while nothing happened.

### A console made in a loop's space joins the loop (2026-11-13)

Herdr's **+** menu (`tab.new`) makes a terminal with no omniloop labels. Left that way, the panel jumped to an
unrelated loop ("top of the list") and the loop tab bar dropped it. So the watcher adopts it: a terminal it sees
**created** (never one already open), live, on this machine, unlabelled, not a terminal with a `parent` and not named
`omniloop-watch`, gets `omniloop=<id>`, `omniloop.to=<coordinator>` (no `to` when you coordinate) and `omniloop.job=<tab name>`
(none when Herdr only numbered the tab) and `omniloop.adopted=1` (its first prompt is a person's, not a task) when it sits in the loop's **own** space (the one named after it, read from
the `where` label) and every live, labelled, unretired agent in that space belongs to the loop. A space the loop's
agents merely sit in (plenary-m2's agents in the `plenary` space) adopts nothing. Only a terminal **alone in its
tab** is adopted: if another live terminal shares its `herdr.tab` label it is a pane split (⌘D, the leader's "scrollback
in nvim") of a tab that already has terminals, and is left alone; one with no `herdr.tab` yet waits like one with no
`herdr.space`. A failed `hc label` puts it back to retry until the give-up. It waits 3 s
(`ADOPT_AFTER_MS`; the watcher ticks again then), so a terminal its maker labels right after making it (`omniloop new`
starting a coordinator with `tab.new`) is left alone, and gives up after 60 s. `omniloop leave --terminal <t>` undoes it and
sticks. Only the all-loops watcher adopts (not `--loop` or `--dry-run`). Once adopted it is an agent like any other:
the coordinator hears when turns it gave finish (not ones you typed there), `omniloop rm` stops it, and a temporary loop doesn't end while it's open. Rule: `core/watch.js` `adoptions`.

## When you last interacted

Each loop shows when you last interacted with it ("you 5m"), and the view ranks loops by it, newest first
(loops you never touched last). Agents that **report to you** (the coordinator, every agent of a loop you coordinate,
`omniloop.notify=me`) show their own time; other agents don't, since they report to an agent.

herdr-core records no "last key a person pressed", so "interacted" means either of:

- **Focus:** you were in its terminal. The loop tab bar (`mod-tabs/main.js`, installed as `loop-tabs`, the mod the layout
  always shows; rules in `core/focus.js`) records it, at most every 10 s per terminal and only for terminals with the
  `omniloop` label, into the shared `omniloop.withYou` (`{ [address]: ms }`). A 10 s timer redraws the bar so staying in one
  terminal keeps counting, and it starts from the stored value. The picker, panel, status and main mod read it.
- **Replied:** you sent a message with `omniloop reply` (the panel and pane chat box run it). `cmdReply` sets
  `omniloop.you=<ms>` on the loop's coordinator terminal, sent or held (5 s timeout, failure ignored: it never fails the
  reply); the watcher records it like a typed prompt. With no coordinator running there is nothing to label, and only the
  index's `touched` (the feed's mtime) moves.
- **Prompted:** you typed a prompt into it. The UserPromptSubmit hook (`bin/ask-hook.mjs`, shipped in `plugin/hooks`)
  sets the label `omniloop.you=<ms>` on the terminal it runs in, unless the prompt is empty or not a person's
  (starts with `omniloop:` (omniloop's own notes), `<hc from=`, `<cross-session-message` or "Another Claude session sent a message"). The
  watcher records the time when that label changes (`touchedByYou` in `core/watch.js`).

The plugin may also be loaded by the user's own `claude` alias (`--plugin-dir <repo>/plugin`), so it runs in every
Claude, loop or not. Claude Code registers a plugin's hooks once per plugin name (verified: the same directory twice,
or a copy under another path with the same name, runs each hook once), so omniloop's own flag does not double them.
`ask-hook` and `goal-hook` do nothing (no label, no file, no output) unless the terminal carries the `omniloop`
label (`goal-hook` also acts when the session's cwd holds a `loop.json`: a Claude started inside a loop folder counts as in the loop); a hand-started Claude in a loop terminal therefore counts as you typing, with the same rules as above.
`session-hook` is not gated: `omniloop send` needs its session and turn records for any Claude.

Status changes (an agent going idle/done to working) and `herdr.seen` are **not** signals: agents message each
other directly, and each such message looked like you. An agent without the plugin loaded shows a time from you only by focus.

The watcher keeps its record in `state.json` (`withYou`, entries older than 30 days dropped); the view takes
the newer of the two.

## What is for you, in words

Not colours. A row, a loop and the status bar say what is waiting, counts first, joined with " · "
(`forYouLabel(counts)` in `core/omniloop.js`; per loop `forYouCounts` = `{ approval, asked, finished, stalled }`):

| Word | When |
|---|---|
| `needs approval` | blocked on a permission or auth prompt (any other block for you too): the agent can't continue |
| `asked you` | finished its turn with a question (`omniloop.ask=1`, from the Stop hook: last lines end with "?", or a "What you need to do" line), or blocked with herdr kind `question` |
| `finished` | finished its turn, nothing asked |
| `stalled` | watcher-only: no progress for 20 min, or stuck at start |
| `not delivered` | a note to that agent couldn't be delivered (`undeliverable`) |
| `needs you` | any other kind of alert for you (never shown as "finished") |

e.g. "1 needs approval · 2 asked you". `needsYou` stays the plain count.

## The view (Herdr mod)

`mod/main.js`: loops ordered by when you last interacted with them, each with its goal, its coordinator (★, or "you coordinate") and its
agents as a tree; chips for what's for you and what the loop is handling itself. It reads `terminals()`
and the watcher's state file and runs no `hc` commands. "Watcher off: loops are silent" shows when the
heartbeat is older than 45 s.

**Sound:** off by default, because the app's own blocked sound still plays for every agent. Once you turn
off `settings.json` `sounds.blocked`, switch the view's sound on: only alerts for you then make a sound.
Not yet tried: whether `playSound` plays with the global setting off.

## Known gaps

- A permission prompt always reaches you; loops can't take those off your plate.
- Not tried: a real Claude agent ending its turn with a question shows `done`, not `blocked`, so it routes
  as "finished its turn" (which goes to its parent).
- Verified 2026-11-12: `hc events` carries connected machines' terminals, snapshot and live deltas.
