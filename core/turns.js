// turns.js: the record-merging half of bin/session-hook.mjs. Pure (no I/O).
// Writes two kinds of record under ~/.cache/omniloop (formats: core/deliver.js "Turn records"):
//   sessions/<address>.json  { address, pid, sessionId, mode, cwd, at }   who a session is, for delivery
//   turns/<address>.json     { address, sessionId, pid, mode, startedAt, endedAt, text, reportedAt, reportedTo }
import { sentTo } from "./deliver.js";

/** Longest last-reply text kept in a turn record. */
export const TEXT_MAX = 4000;

/** A name that is safe as a file name: no path separators, no "..", not empty. */
export function safeAddress(a) {
  const s = String(a ?? "");
  return s && !/[/\\\0]/.test(s) && !s.includes("..") ? s : null;
}

/** The address of a session: its herdr terminal id, else "s-" + the first 8 chars of the session id. null when neither is usable. */
export function addressOf(env, sessionId) {
  const hc = safeAddress(env?.HC_TERMINAL_ID);
  if (hc) return hc;
  const sid = String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return sid ? safeAddress("s-" + sid) : null;
}

/** The pid of the Claude process: CLAUDE_PID when set, else the hook's parent. */
export function pidOf(env, ppid) {
  return Number(env?.CLAUDE_PID) || ppid;
}

/** The session record after a SessionStart / UserPromptSubmit. mode: this event's permission_mode, else the last one seen. */
export function sessionRecord(prev, { address, pid, input, now }) {
  return { address, pid, sessionId: input.session_id ?? null, mode: input.permission_mode ?? prev?.mode ?? null, cwd: input.cwd ?? null, at: now };
}

/** The turn record after a UserPromptSubmit: a new turn begins (existing fields kept, the report marks cleared). */
export function turnStart(prev, { address, pid, input, now }) {
  const { reportedAt, reportedTo, ...rest } = prev ?? {};
  return { ...rest, address, pid, sessionId: input.session_id ?? rest.sessionId ?? null, mode: input.permission_mode ?? rest.mode ?? null, startedAt: now };
}

/** The turn record after a Stop: the turn ended, with the last reply (capped). */
export function turnEnd(prev, { address, pid, input, now }) {
  const text = typeof input.last_assistant_message === "string" ? Array.from(input.last_assistant_message).slice(0, TEXT_MAX).join("") : (prev?.text ?? null);
  return { ...prev, address, pid, sessionId: input.session_id ?? prev?.sessionId ?? null, mode: input.permission_mode ?? prev?.mode ?? null, endedAt: now, text };
}

/** The turn record after a PostToolUse: when it was a Bash `hc send` / `omniloop send`, the turn is marked reported. Otherwise null (no change). */
export function turnReport(prev, { input, now }) {
  if (input.tool_name !== "Bash") return null;
  const to = sentTo(input.tool_input?.command);
  return to ? { ...prev, reportedAt: now, reportedTo: to } : null;
}
