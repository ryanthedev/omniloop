// deliver.js: how omniloop hands a message to a Claude session as a labelled peer message, never as user input.
// Pure (no I/O). bin/lib/sock.mjs does the reading and the socket write.
//
// Claude Code (2.1.319+) gives every interactive session a Unix socket (messagingSocketPath in
// ~/.claude/sessions/<pid>.json; auth token: peerToken in the <pid>.<hash>.key file next to it). A frame
//   {"type":"auth","token":T}\n{"type":"user","message":{"role":"user","content":ENVELOPE}}\n
// reaches the session as "Message from @<name>", marked as another session (not the user). It wakes an idle
// session and queues behind a busy one. Verified 2026-11-13: ~/loops/agent-messaging/reports/2026-11-13-probe.md.
//
// Hold policy on the receiver: an explicit crossSessionInbound setting wins; else a sender that claims a
// different permission class (from-mode) than the receiver, or none at a bypass receiver, is held behind an
// approval dialog. So we always claim "prompting", and a bypass receiver gets hc send instead (see route).

export const TAG = "cross-session-message";
/** Longest body carried in one message (Claude Code accepts much more; this keeps a note a note). */
export const MAX_BODY = 8000;

// Attribute values Claude Code accepts. from: [A-Za-z0-9%:_/.\-]{1,300}; from-name: no " < > or newlines.
const FROM_OK = /^[A-Za-z0-9%:_/.\\-]{1,300}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** "uds:<path>" with Claude Code's own escaping, so a receiver can reply to a sender session's socket. */
export function udsAddress(path) {
  if (typeof path !== "string" || !path) return null;
  const enc = new TextEncoder();
  const esc = path.replace(/[^A-Za-z0-9:_/.\\-]/gu, (c) => Array.from(enc.encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
  const a = `uds:${esc}`;
  return FROM_OK.test(a) ? a : null;
}

/** A display name Claude Code will keep: one line, no quotes or angle brackets, at most 80 chars. */
export function senderName(name) {
  const s = String(name ?? "").replace(CONTROL, " ").replace(/["<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, 80).join("").trim() || null;
}

/** The permission class to claim, from a Claude Code permission_mode ("bypassPermissions" -> bypass; else prompting). */
export function modeClass(permissionMode) {
  return permissionMode === "bypassPermissions" ? "bypass" : "prompting";
}

/**
 * The message body: control characters dropped (newlines kept), trimmed, capped. null when empty.
 * The envelope tag inside a body is broken (a "‹" for its "<"), so a body can't close the envelope and fake
 * a second message from someone else.
 */
export function body(text) {
  const b = Array.from(String(text ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(new RegExp(`<(/?)\\s*${TAG}`, "gi"), "‹$1" + TAG).trim()).slice(0, MAX_BODY).join("").trim();
  return b || null;
}

/**
 * The envelope Claude Code parses. Attribute order is fixed by its parser: from, from-name, from-mode.
 * from: optional reply address (udsAddress of the sender's own socket); name: who it is from; mode: receiver's class.
 */
export function envelope({ from = null, name, mode = "prompting", text }) {
  const b = body(text);
  if (!b) return null;
  const attrs = [];
  if (from && FROM_OK.test(from)) attrs.push(`from="${from}"`);
  const n = senderName(name);
  if (n) attrs.push(`from-name="${n}"`);
  if (mode === "bypass" || mode === "prompting") attrs.push(`from-mode="${mode}"`);
  return `<${TAG}${attrs.length ? " " + attrs.join(" ") : ""}>\n${b}\n</${TAG}>`;
}

/** The two lines written to the socket (each newline-terminated). */
export function frames({ token, content }) {
  return JSON.stringify({ type: "auth", token }) + "\n" + JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/**
 * Pick a session from Claude Code's registry for a target.
 * target: an hc address (via the hook map: { [address]: pid }), a pid, a session id (or an 8+ char prefix),
 *         or a session name (registry `name`, exact, case-insensitive).
 * sessions: registry records [{ pid, sessionId, name, messagingSocketPath, status, cwd, version }], live only.
 * Returns { session } or { error }.
 */
export function resolveTarget(target, sessions, { byAddress = {} } = {}) {
  const t = String(target ?? "").trim();
  if (!t) return { error: "no target" };
  const list = (sessions ?? []).filter((s) => s && Number.isInteger(s.pid));
  const pick = (s) => (s ? { session: s } : null);
  if (byAddress[t] != null) {
    const s = list.find((x) => x.pid === Number(byAddress[t]));
    if (s) return { session: s };
    return { error: `${t} has no live Claude session (its last one, pid ${byAddress[t]}, is gone)` };
  }
  if (/^\d+$/.test(t)) return pick(list.find((s) => s.pid === Number(t))) ?? { error: `no live session with pid ${t}` };
  const lower = t.toLowerCase();
  const byId = list.filter((s) => typeof s.sessionId === "string" && (s.sessionId === t || (t.length >= 8 && s.sessionId.startsWith(t))));
  if (byId.length === 1) return { session: byId[0] };
  const byName = list.filter((s) => typeof s.name === "string" && s.name.toLowerCase() === lower);
  if (byName.length === 1) return { session: byName[0] };
  if (byName.length > 1 || byId.length > 1) return { error: `"${t}" matches ${byName.length || byId.length} sessions; use a pid` };
  return { error: `no live session named "${t}"` };
}

/**
 * How to deliver: { socket } when the session has a socket, else { hc } when there's an hc address, else { none }.
 * mode: the receiver's recorded permission_mode. A bypass receiver holds peer messages for its person's approval,
 * and claiming "bypass" to skip that gate is not ours to do (omniloop lead, 2026-11-13): it gets hc send instead.
 */
export function route({ session, address, mode = null }) {
  const bypass = modeClass(mode) === "bypass";
  if (session?.messagingSocketPath && !bypass) return { socket: session.messagingSocketPath };
  if (address && !String(address).includes("/")) return { hc: address };
  return { none: true };
}

// ---- Turn records (written by bin/session-hook.mjs; read by the watcher) ----
//
// ~/.cache/omniloop/turns/<address>.json: { address, sessionId, pid, mode, startedAt, endedAt, text, reportedAt, reportedTo }
//   startedAt: the last UserPromptSubmit (or a peer message that started a turn); endedAt + text: the last Stop.
//   reportedAt / reportedTo: the agent itself sent a message (omniloop send, hc send) during this turn.

/** Longest last-reply text carried in a watcher note. */
export const TURN_TEXT_MAX = 600;

/** The last reply, as one line for a note: whitespace folded, capped with an ellipsis. null when empty. */
export function turnText(text, max = TURN_TEXT_MAX) {
  const s = String(text ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const a = Array.from(s);
  return a.length > max ? a.slice(0, max - 1).join("") + "…" : s;
}

/**
 * Did the agent already report this turn to whoever the note is for? Then a "finished its turn" note is a duplicate.
 * rec: the turn record; to: the note's recipient address.
 */
export function alreadyReported(rec, to) {
  if (!rec || !Number.isFinite(rec.reportedAt)) return false;
  if (Number.isFinite(rec.startedAt) && rec.reportedAt < rec.startedAt) return false;
  return !to || !rec.reportedTo || rec.reportedTo === to;
}

/** From a Bash command, the target of an `hc send` or `omniloop send` (first one), or null. */
export function sentTo(command) {
  const m = String(command ?? "").match(/(?:^|[;&|(]\s*|\s)(?:hc|omniloop)\s+send\s+(?:--\S+\s+(?:\S+\s+)?)*?([A-Za-z0-9_./][A-Za-z0-9_./-]*)/);
  return m ? m[1] : null;
}
