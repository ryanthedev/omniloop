// feed.js: a loop's chat feed, one JSON line per message in ~/loops/<id>/feed.jsonl. Pure (no I/O).
//
//   { ts, from, thread, text }   from: a terminal address, "omniloop" or "you"; thread: a short tag or null
//
// The file is shared by many writers and read from the tail, so reading tolerates what a crash or a partial
// read leaves behind: a torn line, a bad line.

import { machineOf } from "./omniloop.js";
import { ago } from "./view.js";

export const FEED_FILE = "feed.jsonl";
export const MAX_TEXT = 2000;
const MAX_THREAD = 40;

// Keep newlines and tabs; drop other control characters (an ESC in a message must not reach a terminal).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Validate and clean a message. Returns { entry } or { error }. */
export function feedEntry({ from, thread, text, now }) {
  const who = oneLine(from).replace(CONTROL, "");
  if (!who) return { error: "a feed message needs a sender" };
  if (!Number.isFinite(now)) return { error: "a feed message needs a time" };
  const body = Array.from(String(text ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").trim())
    .slice(0, MAX_TEXT).join("").trim();
  if (!body) return { error: "a message needs words" };
  const tag = Array.from(oneLine(thread).replace(CONTROL, "")).slice(0, MAX_THREAD).join("");
  return { entry: { ts: now, from: who, thread: tag || null, text: body } };
}

/** One entry as one line, newline included (newlines in the text stay escaped inside the JSON). */
export const feedLine = (entry) => JSON.stringify(entry) + "\n";

const isEntry = (e) => e && typeof e === "object" && !Array.isArray(e)
  && Number.isFinite(e.ts) && typeof e.from === "string" && typeof e.text === "string";

/** Entries, oldest first, from file text. Skips any line that is torn or isn't an entry; `last` keeps the newest N. */
export function parseFeed(text, { last } = {}) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (isEntry(e)) out.push({ ts: e.ts, from: e.from, thread: typeof e.thread === "string" && e.thread ? e.thread : null, text: e.text });
  }
  return Number.isFinite(last) ? out.slice(Math.max(0, out.length - Math.max(0, last))) : out;
}

/**
 * What `omniloop reply` does with a message for the loop's lead, from the lead's address and status:
 *   { send: { if } }  type it now (`hc send --if idle` for idle; no guard for done)
 *   { hold: true }    the lead is working, blocked, or not an agent: queue it for the watcher's next flush
 *   { none: true }    no lead on this computer: nobody to tell (another machine's lead is never typed into)
 */
export function replyPlan(lead, status) {
  if (typeof lead !== "string" || !lead || machineOf(lead) != null) return { none: true };
  if (status === "idle") return { send: { if: "idle" } };
  if (status === "done") return { send: { if: null } };
  return { hold: true };
}

/**
 * The chat the pane draws, oldest first (newest last). `thread`: a tag to show only that thread; null/absent shows
 * every message. `names`: { [address]: display name }; "you" and "omniloop" are shown as they are, an unknown sender
 * as its raw address. Entries that aren't well-formed are skipped, so a bad line never blanks the view.
 * Returns [{ ts, who, mine (from you), system (from omniloop), age ("now", "5m"), thread, text }].
 */
export function chatRows(entries, { thread = null, now, names = {} } = {}) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => isEntry(e) && (thread == null || e.thread === thread))
    .map((e) => ({
      ts: e.ts, who: e.from === "you" || e.from === "omniloop" ? e.from : names[e.from] || e.from,
      mine: e.from === "you", system: e.from === "omniloop", age: ago(e.ts, now),
      thread: typeof e.thread === "string" && e.thread ? e.thread : null, text: e.text,
    }));
}

/** The threads in use, most recently posted-to first: [{ thread, count }] (the main stream, null, is not a thread). */
export function chatThreads(entries) {
  const seen = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isEntry(e) || typeof e.thread !== "string" || !e.thread) continue;
    const c = seen.get(e.thread);
    seen.set(e.thread, { thread: e.thread, count: (c?.count ?? 0) + 1, ts: e.ts });
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts).map(({ thread, count }) => ({ thread, count }));
}
