// turns.js: the record-merging half of bin/session-hook.mjs. Pure (no I/O).
// Writes two kinds of record under ~/.cache/omniloop (formats: core/deliver.js "Turn records"):
//   sessions/<address>.json  { address, pid, sessionId, mode, cwd, at }   who a session is, for delivery
//   turns/<address>.json     { address, sessionId, pid, mode, startedAt, endedAt, text, first, given, reportedAt, reportedTo }
import { sentTo } from "./deliver.js";
import { selfId } from "./backend.js";

/** Longest last-reply text kept in a turn record. */
export const TEXT_MAX = 4000;

/** A name that is safe as a file name: no path separators, no "..", not empty. */
export function safeAddress(a) {
  const s = String(a ?? "");
  return s && !/[/\\\0]/.test(s) && !s.includes("..") ? s : null;
}

/** The address of a session: its terminal id (herdr HC_TERMINAL_ID, omni OMNI_PANE), else "s-" + the first 8 chars of the session id. null when neither is usable. */
export function addressOf(env, sessionId) {
  const id = safeAddress(selfId(env));
  if (id) return id;
  const sid = String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return sid ? safeAddress("s-" + sid) : null;
}

/** The pid of the Claude process: CLAUDE_PID when set, else the hook's parent. */
export function pidOf(env, ppid) {
  return Number(env?.CLAUDE_PID) || ppid;
}

/** The session record after a SessionStart / UserPromptSubmit. mode: this event's permission_mode, else the last one seen. */
export function sessionRecord(prev, { address, pid, input, now }) {
  const same = prev?.sessionId != null && prev.sessionId === input.session_id;
  return { address, pid, sessionId: input.session_id ?? null, mode: input.permission_mode ?? (same ? prev.mode : null) ?? null, cwd: input.cwd ?? null, at: now };
}

/** The turn record after a UserPromptSubmit: a new turn begins (existing fields kept, the report marks cleared). */
export function turnStart(prev, { address, pid, input, now }) {
  const { reportedAt, reportedTo, ...rest } = prev ?? {};
  return { ...rest, address, pid, sessionId: input.session_id ?? rest.sessionId ?? null, mode: input.permission_mode ?? rest.mode ?? null, startedAt: now };
}

/**
 * Who gave this turn: every prompt in the transcript after `since` (the previous turn's end, ms; null: all in
 * sight), so a line that arrives mid-turn doesn't hide the one that started it. Claude Code marks a peer message
 * origin.kind "peer" (with the sender's name) and anything typed "human"; typed text an agent sent with hc send
 * starts <hc from="X">, and a watcher note typed as a fallback starts "omniloop:".
 * Returns { you: a person typed a prompt, from: [senders] }, or null when no prompt is in sight (unknown).
 */
export function givenBy(entries, since = null) {
  const out = { you: false, from: [] };
  let seen = false;
  for (const e of entries ?? []) {
    if (e?.type !== "user" || !e.origin) continue;
    const at = Date.parse(e.timestamp ?? "");
    if (since != null && Number.isFinite(at) && at <= since) continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((x) => x?.type === "tool_result")) continue;
    if (e.origin.kind === "peer") { seen = true; out.from.push(typeof e.origin.name === "string" ? e.origin.name : "?"); continue; }
    if (e.origin.kind !== "human") continue;
    seen = true;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "";
    const hc = String(text).match(/^\s*<hc from="([^"]+)">/);
    if (hc) out.from.push(hc[1]);
    else if (/^\s*omniloop:\s/.test(text)) out.from.push("omniloop");
    else out.you = true;
  }
  if (!seen) return null;
  out.from = [...new Set(out.from)];
  return out;
}

/** The turn record after a Stop: the turn ended, with the last reply (capped). */
export function turnEnd(prev, { address, pid, input, now, entries = null }) {
  // No carry-over: a Stop without a reply must not leave the previous turn's words to be quoted as this one's.
  const text = typeof input.last_assistant_message === "string" ? Array.from(input.last_assistant_message).slice(0, TEXT_MAX).join("") : null;
  const sessionId = input.session_id ?? prev?.sessionId ?? null;
  // first: this is the session's first turn (a started subagent's task). null when an older record can't say.
  const first = prev?.endSession != null ? prev.endSession !== sessionId : !Number.isFinite(prev?.endedAt) ? true : null;
  const since = first === true ? null : Number.isFinite(prev?.endedAt) ? prev.endedAt : null;
  return { ...prev, address, pid, sessionId, mode: input.permission_mode ?? prev?.mode ?? null, endedAt: now, text,
    endSession: sessionId, first, given: entries ? givenBy(entries, since) : null };
}

/** The turn record after a PostToolUse: when it was a Bash `hc send` / `omniloop send`, the turn is marked reported. Otherwise null (no change). */
export function turnReport(prev, { input, now }) {
  if (input.tool_name !== "Bash") return null;
  const to = sentTo(input.tool_input?.command);
  return to ? { ...prev, reportedAt: now, reportedTo: to } : null;
}

/**
 * Does this hook belong to someone else's record? A \`claude\` started inside an agent's terminal inherits its
 * HC_TERMINAL_ID: while the agent's session (another session id, a live pid) owns the address, the nested one
 * must not overwrite its records. alive(pid) -> boolean.
 */
export function foreign(prev, { input, pid }, alive) {
  return Boolean(prev?.sessionId && input.session_id && prev.sessionId !== input.session_id && prev.pid !== pid && alive(prev.pid));
}
