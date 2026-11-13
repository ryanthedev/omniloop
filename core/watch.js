// watch.js: what the watcher does, as a pure step. No model, no tokens: the watcher (bin/omniloop.mjs watch)
// follows `hc events`, calls step() on every event and every tick, and carries out the actions.
//
// Token rules this encodes:
// - Agents never poll, sleep or watch. They end their turn; the watcher wakes them only with something to act on.
// - Edges, not levels: each block, finish, stall or escalation is told once (keyed by address, kind, turn).
// - Notes for one agent are held while it works and sent as one line when it stops, so a busy lead
//   gets one wake-up for many members, not one each.

import { buildLoops, alerts, trackBlocked, statusOf, loopKey, machineOf, LABEL } from "./omniloop.js";
import { feedEntry } from "./feed.js";
import { alreadyReported, turnText } from "./deliver.js";

/** Working with no event for this long counts as stalled (also catches a session stuck at a dialog). */
export const STALL_MS = 20 * 60 * 1000;
/** A Claude member that hasn't reported this long after it was made is stuck before its first prompt
 *  (Claude Code's folder-trust question, a login, an update prompt): it never reaches "working", so no stall fires. */
export const START_MS = 60 * 1000;
/** Longest message text carried into a note. */
const MSG_MAX = 120;

/**
 * terminals: hc terminal objects, each with `event_ms` (when the watcher last saw an event for it).
 * opts.loop: only this loop id (tests; never touch terminals outside it). Loose terminals are ignored:
 * the watcher only routes inside loops, and the app already tells you about the rest.
 */
// Another machine's terminals are watched, never typed into: that machine runs its own watcher, which tells
// its agents. This watcher only reports their alerts for you (the view). Typing into them would also send
// this computer's addresses to a machine that must not know about it.
function scoped(terminals, loop) {
  return (terminals ?? []).filter((t) => t.labels?.[LABEL.loop] && (!loop || loopKey(t) === loop));
}
const remote = (address) => machineOf(address) != null;

// Told once per agent-or-you: a note already delivered to a parent isn't re-sent up the chain because
// that parent later blocks too; only a move to you (escalation) is news again.
function keyOf(a, turn) {
  return `${a.address}|${a.kind}|${a.to === "you" ? "you" : "loop"}|${turn ?? 0}`;
}

function routed(terminals, state, now) {
  const built = buildLoops(terminals);
  const byAddr = new Map(terminals.map((t) => [t.address, t]));
  const out = alerts({ loops: built.loops, loose: [] }, { now, blockedSince: state.blockedSince });

  // Stalls: working, no event for STALL_MS. Routed like a block (parent, else lead, else you).
  for (const loop of built.loops)
    for (const m of loop.members) {
      if (m.status !== "working") continue;
      const last = m.terminal.event_ms ?? m.terminal.status_ms ?? null;
      if (last == null || now - last < STALL_MS) continue;
      const to = m.isLead || !loop.lead ? "you" : m.parent ?? loop.lead;
      out.push({ address: m.address, loop: loop.id, to, kind: "stalled", why: `no progress for ${Math.round((now - last) / 60000)} min`, last });
    }
  // Stuck at start: always yours (trusting a folder or logging in is your decision), keyed by when it was made.
  for (const loop of built.loops)
    for (const m of loop.members) {
      const t = m.terminal;
      if (!startingClaude(t) || t.created_ms == null || now - t.created_ms < START_MS) continue;
      out.push({ address: m.address, loop: loop.id, to: "you", kind: "stuck", why: "Claude Code hasn't started; it may be asking a question (folder trust?)", last: t.created_ms });
    }
  return { built, byAddr, out };
}

/** A live Claude session that has never reported a status: still before its first prompt. */
export function startingClaude(t) {
  if (!t || (t.state && t.state !== "live") || t.reported || statusOf(t) != null || t.status_ms != null || (t.turn ?? 0) > 0) return false;
  const argv = [...(t.foreground?.argv ?? []), ...(t.argv ?? [])];
  return argv.some((a) => /(^|\/)claude$/.test(String(a)));
}

/** Start from what is true now without telling anyone about it (no flood of old "done"s). */
export function initState(terminals, now, { loop = null, timers = [] } = {}) {
  const ts = scoped(terminals, loop);
  const state = { told: {}, pending: {}, timers, blockedSince: trackBlocked({}, ts, now), members: ts.map((t) => t.address) };
  const { byAddr, out } = routed(ts, state, now);
  for (const a of out) state.told[keyOf(a, a.kind === "stalled" || a.kind === "stuck" ? a.last : byAddr.get(a.address)?.turn)] = true;
  return state;
}

// A finished turn carries the agent's own last reply (from its Stop hook's turn record), not just "finished".
function line(a, t, rec) {
  const role = t?.labels?.[LABEL.lead] ? " (lead)" : "";
  const msg = t?.status && typeof t.status === "object" ? t.status.msg : t?.message;
  const what = a.kind === "blocked" ? `blocked${t?.status?.kind ? ` (${t.status.kind})` : ""}` : a.kind === "stalled" ? `stalled, ${a.why}` : a.kind === "stuck" ? `stuck at start: ${a.why}` : "finished its turn";
  const reply = a.kind === "done" ? lastReply(rec) : null;
  // Quoted, so the reader sees an agent's words relayed, not omniloop's; withoutReplies() strips it for typing.
  if (reply) return `${a.address}${role} finished its turn, last reply: «${reply.replace(/[«»]/g, '"')}»`;
  const tail = msg ? `: ${String(msg).replace(/\s+/g, " ").slice(0, MSG_MAX)}` : "";
  return `${a.address}${role} ${what}${tail}`;
}

/** How long a finished turn waits for its Stop hook's record before it is told without the reply. */
export const REPLY_WAIT_MS = 10_000;

function replyPending(a, t, rec, now) {
  if (a.kind !== "done" || !rec || lastReply(rec)) return false; // no record at all: this agent has no hook; never wait
  const since = t?.status_ms ?? t?.event_ms ?? null;
  return since != null && now - since < REPLY_WAIT_MS;
}

/** The last reply of a turn record, when that record is of a turn that has ended (not one still running). */
function lastReply(rec) {
  if (!rec || !Number.isFinite(rec.endedAt)) return null;
  if (Number.isFinite(rec.startedAt) && rec.endedAt < rec.startedAt) return null;
  return turnText(rec.text);
}

/**
 * One step. Returns { state, actions, you, feed }.
 * opts.turns: { [address]: turn record } from the session hook (core/deliver.js), for finished-turn text and dedupe.
 * actions: [{ type: "send", to, text, if }]   a note for an agent that has stopped (`if`: hc send --if)
 *          [{ type: "you", alert, text }]      newly for you (the view plays the sound for these)
 * you: every alert currently for you (the view lists them)
 * feed: [{ loop, entry }] what to post to each loop's chat feed, once (never for another machine's members or loops)
 * opts.loop also scopes timers: only those aimed at a terminal in that loop fire; the rest stay untouched.
 */
export function step(prev, terminals, now, { loop = null, turns = {} } = {}) {
  const ts = scoped(terminals, loop);
  const state = {
    told: { ...prev.told },
    pending: Object.fromEntries(Object.entries(prev.pending ?? {}).map(([k, v]) => [k, [...v]])),
    timers: [...(prev.timers ?? [])],
    blockedSince: trackBlocked(prev.blockedSince, ts, now),
    members: ts.map((t) => t.address),
  };
  const { byAddr, out } = routed(ts, state, now);
  const actions = [], feed = [];
  const post = (loopId, text) => {
    if (!loopId || loopId.includes("/")) return;
    const r = feedEntry({ from: "omniloop", text, now });
    if (r.entry) feed.push({ loop: loopId, entry: r.entry });
  };
  // A terminal that just joined a loop brings its state with it: joining isn't news (no flood of old "done"s).
  const before = new Set(prev.members ?? ts.map((t) => t.address));
  for (const a of out)
    if (!before.has(a.address)) state.told[keyOf(a, a.kind === "stalled" || a.kind === "stuck" ? a.last : byAddr.get(a.address)?.turn)] = true;

  const live = new Set();
  for (const a of out) {
    const k = keyOf(a, a.kind === "stalled" || a.kind === "stuck" ? a.last : byAddr.get(a.address)?.turn);
    live.add(k);
    if (state.told[k]) continue;
    const rec = turns[a.address];
    // The Stop hook writes the reply as the turn ends; the watcher can see "done" first. Wait for it, a little.
    if (replyPending(a, byAddr.get(a.address), rec, now)) { live.add(k); continue; }
    state.told[k] = true;
    const l = line(a, byAddr.get(a.address), rec);
    const text = `omniloop ${a.loop}: ${l}`;
    if (!remote(a.address) && !remote(a.to)) post(a.loop, l);
    // The agent already told its parent this turn (omniloop send / hc send): a "finished" note would say it twice.
    if (a.kind === "done" && a.to !== "you" && alreadyReported(rec, a.to)) continue;
    if (a.to === "you") actions.push({ type: "you", alert: a, text });
    else if (remote(a.to)) continue;
    else (state.pending[a.to] ??= []).push(l);
  }
  // Forget told keys that are no longer true, so the same thing happening again is news again.
  for (const k of Object.keys(state.told)) if (!live.has(k)) delete state.told[k];

  // Timers: due ones become notes for their terminal.
  // A scoped watcher only owns timers for its own loop's terminals; the rest wait for their own watcher.
  const mine = (tm) => !loop || ts.some((t) => t.address === tm.to);
  const due = state.timers.filter((tm) => tm.at <= now && mine(tm));
  state.timers = state.timers.filter((tm) => !due.includes(tm));
  for (const tm of due) {
    if (remote(tm.to)) continue;
    // A `note: true` timer is a note already worded (and posted) by its writer, e.g. a held reply from you.
    (state.pending[tm.to] ??= []).push(tm.note ? tm.text : `timer: ${tm.text}`);
    if (!tm.note) post(loopKey(byAddr.get(tm.to)), `timer for ${tm.to}: ${tm.text}`);
  }

  // Flush: one line per agent, only when it has stopped (idle or done). Held while working or blocked.
  // An agent that is gone (not live, retired) can't be told: its notes go to you.
  for (const [to, lines] of Object.entries(state.pending)) {
    if (!lines.length || remote(to)) { delete state.pending[to]; continue; }
    const t = byAddr.get(to) ?? (terminals ?? []).find((x) => x.address === to);
    const gone = !t || (t.state && t.state !== "live") || t.labels?.[LABEL.retired];
    const st = statusOf(t);
    // Only an agent that has stopped (exactly idle or done) is typed into. A null status is a plain shell
    // (the agent exited, or a shell was named as a parent): typing there would run the note as a command.
    if (gone || st == null) {
      const why = gone ? "its parent is gone" : "its parent isn't an agent now";
      actions.push({ type: "you", alert: { address: to, kind: "undeliverable", to: "you", why }, text: `omniloop: for ${to} (${why}): ${lines.join(" · ")}` });
      post(loopKey(t), `for ${to} (${why}): ${lines.join(" · ")}`);
      delete state.pending[to];
    } else if (st === "idle" || st === "done") {
      actions.push({ type: "send", to, text: `omniloop: ${lines.join(" · ")}`, if: st === "idle" ? "idle" : null });
      delete state.pending[to];
    }
  }

  return { state, actions, you: out.filter((a) => a.to === "you"), feed };
}

/**
 * After \`hc send\` exits: was the note NOT delivered, so it should be held for the next stop?
 * herdr-core can type the note and then fail to save its terminal list ("cannot save terminals", e.g. on a full
 * disk) and exit non-zero: that note arrived, and holding it would re-send it at every stop, forever.
 */
export function sendFailed(code, output = "") {
  if (code === 0) return false;
  return !/cannot save terminals/.test(String(output));
}

/** Hold a line for an agent once: a line already waiting for it isn't added again. */
export function hold(pending, to, line) {
  const lines = (pending[to] ??= []);
  if (!lines.includes(line)) lines.push(line);
  return pending;
}

/** "20m", "90s", "2h", "1h30m" -> ms; null when it doesn't parse. */
export function parseDuration(s) {
  const m = String(s ?? "").trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
}

/**
 * Did this change look like you interacting with the terminal? One signal: the `omniloop.you` label changed to a
 * value. bin/ask-hook.mjs (UserPromptSubmit) sets it, to the time, only when a person typed the prompt (not another
 * agent's note or message). Status changes and herdr.seen say nothing reliable about who prompted.
 * prev, next: the terminal before and after the event.
 */
export function touchedByYou(prev, next) {
  if (!prev || !next) return false;
  const you = (t) => t.labels?.[LABEL.you] ?? "";
  return you(next) !== "" && you(next) !== you(prev);
}

/**
 * A note as it may be typed into a terminal (hc send): without the agents' relayed replies. Typed text reads as
 * the user's own words, so an agent's free text never goes that way; only a labelled socket message carries it.
 */
export function withoutReplies(text) {
  return String(text ?? "").replace(/, last reply: «[^»]*»/g, "");
}

/** A new console waits this long before it's adopted, so a terminal its maker labels right after making it
 *  (`omniloop new` starting a lead with `tab.new`, then labelling it) is left alone. */
export const ADOPT_AFTER_MS = 3 * 1000;
/** A new console not adoptable by then (no space label, a space with no loop) is dropped from the candidates. */
export const ADOPT_WITHIN_MS = 60 * 1000;

/** The Herdr space and tab a terminal sits in, from its `where` label ("<space> / <tab>"), or nulls. */
export function whereOf(t) {
  const w = t?.labels?.where ?? "";
  const i = w.lastIndexOf(" / ");
  return i < 0 ? { space: null, tab: null } : { space: w.slice(0, i), tab: w.slice(i + 3) };
}

/**
 * A console made in a loop's own space (Herdr's + menu: `tab.new`, which sets no omniloop labels) joins that loop,
 * reporting to its lead. Only new consoles (`candidates`: address -> when the watcher saw it created), so what was
 * already open is never swept in, and `omniloop leave` sticks. A loop's own space is the one named after it, and
 * every live, labelled member on this machine in it must belong to that loop. Returns { adopt: [{ address, loop,
 * to, job }], keep: candidates still waiting }. `to` is null when the loop has no lead (you lead it); `job` is the
 * tab's name unless Herdr only numbered it.
 */
export function adoptions(candidates, terminals, now) {
  const ts = terminals ?? [];
  const live = (t) => t && (!t.state || t.state === "live");
  const local = (t) => !machineOf(t.address);
  const built = buildLoops(ts);
  const adopt = [], keep = {};
  for (const [address, seen] of Object.entries(candidates ?? {})) {
    const t = ts.find((x) => x.address === address);
    if (!live(t) || !local(t) || t.labels?.[LABEL.loop] || t.labels?.[LABEL.retired] || t.parent || t.name === "omniloop-watch") continue;
    if (now - seen > ADOPT_WITHIN_MS) continue;
    const space = t.labels?.["herdr.space"], where = whereOf(t);
    if (!space || !where.space || now - seen < ADOPT_AFTER_MS) { keep[address] = seen; continue; }
    const loops = new Set(ts.filter((x) => x !== t && live(x) && local(x) && !x.labels?.[LABEL.retired] && x.labels?.["herdr.space"] === space && x.labels?.[LABEL.loop])
      .map((x) => x.labels[LABEL.loop]));
    if (loops.size !== 1) { if (!loops.size) keep[address] = seen; continue; }
    const loop = [...loops][0];
    if (loop !== where.space) continue;
    const job = where.tab && !/^\d+$/.test(where.tab) ? where.tab : null;
    adopt.push({ address, loop, to: built.loops.find((l) => l.id === loop)?.lead ?? null, job });
  }
  return { adopt, keep };
}
