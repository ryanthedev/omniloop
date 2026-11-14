# D6: omniloop backend switch (omni/d6)

Commits: f74c3b2 (port + adapters + tests), then the smoke test commit (see `git log omni/d6`). Base 7a6e7af.

## The port
`bin/lib/backend/index.mjs` documents it; `OMNILOOP_BACKEND=omni|herdr` selects (default herdr; omni auto-selected when `OMNI_PANE` is set and
`HC_TERMINAL_ID` is not; both set means herdr). Pure policy is in `core/backend.js` (selection, `selfId`, `looksLikeAddress`/`isPaneId`,
`hasDraft`, `waitForNoDraft`). Process transport is `bin/lib/proc.mjs` (`run` resolves for any exit code, so adapters are testable with a fake).

Methods: self, list, get, read, send, label, spawnPlan/spawn, kill, remove, foregroundPid, events, machines, groupOf, startCoordinator,
renameGroup/closeGroup/retireGroup, syncLoop, place. `HerdrBackend` (bin/lib/backend/herdr.mjs) holds every hc/herdr-app call exactly as
before; `OmniBackend` (omni.mjs) calls the `omni` CLI.

What changed in omniloop: `bin/omniloop.mjs` no longer calls hc/herdr-app anywhere (`hc()` and `loopSpace` are gone); the hooks (`ask-hook`,
`goal-hook`), `sock.mjs` (foregroundPid), `turns.js` (`addressOf`), `omniloop-mcp.mjs` use the port / `selfId`. Watcher: reconnects on omni
(`eventsReconnect`, covers `pane.dropped`), ends as before on herdr.

## Gaps fixed on omniloop's side
1. `pn_` ids: `looksLikeAddress` and the foreground-pid lookup (`isPaneId`) accept them.
2. `OMNI_PANE` is the self identity everywhere `HC_TERMINAL_ID` was (me(), hooks, turn records, MCP sender, myAddress).
3. `--` before the text in `omni send` (`sendArgs`). Note omniloop's own arg parser still treats a leading `--word` in `omniloop reply` text as a flag (unchanged).
4. Draft wait: `omni send` has none, so the OmniBackend EMULATES it: before typing it reads `omni capture` once a second until the prompt shows no
   unsent text (heuristic `hasDraft`: last 8 lines, an input row `❯ text` / `> text` that is not a placeholder), at most 60 s, then types anyway (as hc does).
   `OMNILOOP_DRAFT_WAIT_MS=0` turns it off. It is a screen scrape: a false positive only delays a note, a false negative types over a draft.
5. Label values over omni's 2048 bytes are cut on a character boundary (a long goal label would be refused otherwise).
6. Loop mirroring (best effort, labels stay the truth): `omniloop new` and `goal` call `loop new`/`loop set --goal` (folders on create);
   `join`/`leave`/`handoff`/`start` also place panes with `omni join`/`spawn --loop --role`; a refusal is a stderr note, never a failure.
   Tasks are NOT mirrored (`omni loop task`): omniloop's tasks.json stays the only record.

## Tests (`npm test` = `node --test test/`)
`env -u OMNI_PANE npm test`: tests 353, pass 353, fail 0 (baseline before my change: 304/304; the 304 existing tests pass unchanged).
New: `backend.test.mjs` (pure, 10), `backend-adapters.test.mjs` (24: port contract for fake/herdr/omni, OmniBackend against a fake `omni` on PATH,
HerdrBackend against a recording transport, fake clock for the draft wait), `omni-cli.test.mjs` (14: the real CLI with OMNILOOP_BACKEND=omni against the
fake omni; asserts no hc/herdr-app call is made), `omni-smoke.test.mjs` (1, real daemon). Mutation check: dropping the `--` made 2 tests fail.
Caveat: the existing lifecycle/feed tests inherit the environment; run inside an omni pane (OMNI_PANE set, HC_TERMINAL_ID empty) they would auto-select omni. Run them with `env -u OMNI_PANE` (or set OMNILOOP_BACKEND=herdr).

## Smoke test (real daemon): PASSED
Built `omni` + `omni-daemon` from ~/repos/omni/build/wt/5d (head 21235ff-ish; the tree was moving) with
`CARGO_TARGET_DIR=~/repos/omni/build/target/d6 CARGO_BUILD_JOBS=4 OMNI_VT_PREFIX=~/repos/omni/tools/ghostty-vt gates/lock.sh run d6-build -- cargo build -p omni-cli -p omni-daemon`
(waited ~15 min for the heavy lock; build 13.7 s, no ghostty rebuild; omni-hostd not needed, the daemon binary is omni-daemon).
`node --test test/omni-smoke.test.mjs`: pass 1 / fail 0 (1.3 s). It starts a throwaway `omni-daemon` (own OMNI_RUNTIME_DIR/DATA_DIR/HOME under
~/repos/omni/build/tmp/d6/s-*, removed after) and drives omniloop as the user: `new` (omni loop with goal), `start --coordinator` and `start` (lead
and helper panes, roles checked via `omni loop get`), `ls`, label via `needs-you`, `send "--smoke words"` and read it back from the screen, `--if idle`
refused on a plain program (exit non-zero, nothing typed), `watch --loop smk --dry-run` on `omni events --all` ("watching loop smk: 2 terminals"),
then kill/rm/`loop rm`. The test skips with a message when `OMNI_BIN_DIR` (default the d6 build dir) has no binaries.
Not covered by a real run: a pane-token caller (agents inside panes with the 5d grants file), omniloop rename, handoff, a real Claude agent.

## Omni-side gaps (queue as an omni job; nothing edited in omni)
1. `loop.rename {id, to}` (user-only, atomic; CLI `omni loop rename <id> <to>`). Why: omniloop rename must today create the new loop, `omni join` every pane (the
   user's call only) and `loop rm` the old one, which drops tasks, goal_rev, created_ms, category and workspace worktree/branch (only goal + dirs are copied). Without it,
   `omniloop rename` from an agent pane fails the join step and says "keeps the old name".
2. Spawn by helpers: omniloop lets any agent `omniloop start` (reports-to chain), but 5d grants `spawn` into a loop only to its lead. Needed: a helper may spawn
   `--role helper` into its own loop (parent = the helper, so `kill`/`rm` scope `children` fits), or the grants file must allow it.
3. Adopting a running pane into a loop that has members (`omniloop join L --terminal T`, a hand-started agent): only the user may. Needed: a lead-issued consent
   (e.g. `loop.invite {loop, pane?}` returning a one-time token the pane presents to `pane.join`), or let a loop grant cover the grantee's own pane; also lets a pane in no loop self-join a led loop.
4. `loop.import` has no CLI verb. Needed: `omni loop import [--file F|-]` (user only), to bring omniloop's existing loop.json + tasks.json (`by`/`doneBy`, `byHandle`) over; D6 did no migration.
5. Draft awareness: `omni send` has no wait for a person's draft. Needed: a pane field or `send --if no-draft` backed by something better than a screen scrape (shell integration/OSC for the agent prompt, or Claude Code's own state), so the emulation (poll `capture`) can go.
6. Two leads on handoff: `omniloop handoff` spawns a new `--role lead` while the old lead stays lead in omni (omniloop demotes it by label only). Behavior of `pane.spawn role=lead` into a loop that has a live lead is not specified in 5d (not exercised against the real daemon): define it (refuse, or demote) or add `omni join <old> <loop> --role helper` permission for the old lead itself.
7. Install note, not a code gap: agents need the 5d grants file (loop-scope send/label/capture/loop, lead spawn, children kill/remove) and the watcher pane `events` on `*`; without it label/send between panes are refused.
8. Nice to have: `omni spawn --name` from `omniloop.job` (omniloop does not pass it), and an `omni wait` equivalent of `hc wait` (the brief says never to poll; omni has `run --wait` only).

## Not ported (out of D6)
Herdr UI mods use `hc exec --on`/herdr-app and stay herdr-only: mod, mod-pane, mod-panel, mod-picker, mod-status, mod-tabs, scripts/install.sh. Multi-machine (`hc machine ls`, `hc exec --on`, `m1/t7` addresses) has no omni equivalent: `machines()` returns [].

## Review round fixes
Auto-select omni only when its runtime socket exists and is user-owned (one stat); a forced OMNILOOP_BACKEND decides selfId and the hooks use backend.self(); each draft-wait capture has a 2 s timeout. Suite 356/356, smoke 1/1.
