// sock.mjs: the I/O half of core/deliver.js. Reads Claude Code's session registry and the omniloop hook records,
// and writes one labelled message to a session's messaging socket. No herdr needed: hc is only the fallback.
import { readFile, readdir, open } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { envelope, frames, resolveTarget, route, senderName, udsAddress } from "../../core/deliver.js";

export const CLAUDE_SESSIONS = process.env.OMNILOOP_CLAUDE_SESSIONS ?? join(homedir(), ".claude", "sessions");
export const CACHE = process.env.OMNILOOP_HOME ?? join(homedir(), ".cache", "omniloop");
export const SESSIONS_DIR = join(CACHE, "sessions"); // <address>.json from the hook: { address, pid, sessionId, mode, at }
export const TURNS_DIR = join(CACHE, "turns");       // <address>.json: see core/deliver.js "Turn records"

const readJson = async (p) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Live Claude Code sessions on this computer: registry records whose pid is alive. */
export async function liveSessions(dir = CLAUDE_SESSIONS) {
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const r = await readJson(join(dir, n));
    if (r && Number.isInteger(r.pid) && alive(r.pid)) out.push(r);
  }
  return out;
}

/** The hook's records: { [address]: { address, pid, sessionId, mode, at } }. */
export async function hookRecords(dir = SESSIONS_DIR) {
  const out = {};
  let names = [];
  try { names = await readdir(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const r = await readJson(join(dir, n));
    if (r?.address && Number.isInteger(r.pid)) out[r.address] = r;
  }
  return out;
}

export async function turnRecord(address, dir = TURNS_DIR) {
  if (!address || /[/\\]|\.\./.test(address)) return null;
  return readJson(join(dir, `${address}.json`));
}

/** The auth token for a session: peerToken in ~/.claude/sessions/<pid>.<hash>.key. null when there is none. */
export async function tokenOf(pid, dir = CLAUDE_SESSIONS) {
  let names = [];
  try { names = await readdir(dir); } catch { return null; }
  for (const n of names) if (n.startsWith(`${pid}.`) && n.endsWith(".key")) {
    const k = await readJson(join(dir, n));
    if (typeof k?.peerToken === "string") return k.peerToken;
  }
  return null;
}

/**
 * Write the frames and close. Rejects only when nothing can have reached the session (connect failed or timed
 * out before connecting). Once connected and written, a late error resolves { uncertain: true }: the receiver
 * may have the message, and sending it again (hc, or a requeue) could deliver it twice.
 */
export function writeSocket(path, data, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let written = false, settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(t); fn(v); } };
    const s = createConnection(path);
    const t = setTimeout(() => { s.destroy(); written ? done(resolve, { uncertain: true }) : done(reject, new Error(`socket ${path}: timed out`)); }, timeoutMs);
    s.on("error", (e) => (written ? done(resolve, { uncertain: true }) : done(reject, e)));
    s.on("connect", () => { written = true; s.end(data, () => done(resolve, {})); });
  });
}

/**
 * A session's permission mode from the end of its transcript (the last "permissionMode" written), for sessions
 * that have no omniloop hook record. null when it can't be read.
 */
export async function modeFromTranscript(session) {
  if (!session?.sessionId || !session?.cwd) return null;
  const dir = join(homedir(), ".claude", "projects", session.cwd.replace(/[^A-Za-z0-9]/g, "-"));
  let fh;
  try {
    fh = await open(join(dir, `${session.sessionId}.jsonl`), "r");
    const { size } = await fh.stat();
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const all = [...buf.toString("utf8").matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
    return all.length ? all[all.length - 1][1] : null;
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
}

/**
 * Find where a target lives: { session, address, mode } (session may be null for a terminal with no Claude
 * session we know of). target: hc address, pid, session id or name.
 */
export async function locate(target) {
  const [sessions, hooks] = await Promise.all([liveSessions(), hookRecords()]);
  const byAddress = Object.fromEntries(Object.entries(hooks).map(([a, r]) => [a, r.pid]));
  const r = resolveTarget(target, sessions, { byAddress });
  const hook = hooks[target] ?? Object.values(hooks).find((h) => r.session && h.pid === r.session.pid) ?? null;
  const looksLikeAddress = /^[a-z][a-z0-9]*$/i.test(String(target)) && !r.session;
  // Unknown mode is not "prompting": a bypass session reached by name must still get hc, so read its transcript.
  const mode = hook?.mode ?? (r.session ? await modeFromTranscript(r.session) : null);
  return { session: r.session ?? null, address: hook?.address ?? (looksLikeAddress ? String(target) : null), mode, error: r.error };
}

/**
 * Deliver one message. from: the sender's display name ("omniloop", "you", an agent address);
 * replyTo: the sender session's own socket path, so the receiver can answer (optional).
 * hcSend(address, text): the fallback (the caller owns hc: --if guards, timeouts).
 * Returns { via: "socket" | "hc", to } or throws with a reason.
 */
export async function deliver(target, { from, text, replyTo = process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null, hcSend = null, typed = true } = {}) {
  const where = await locate(target);
  // typed: false is for an agent's own words (omniloop send, the MCP tool). They are never typed into a terminal,
  // where they would read as the user's: a bypass receiver gets the socket message and holds it for its person's
  // approval (that gate is the point of bypass), and a session without a socket can't be sent to this way.
  const how = typed ? route(where) : where.session?.messagingSocketPath ? { socket: where.session.messagingSocketPath } : { none: true };
  if (!typed) hcSend = null;
  if (how.socket) {
    const token = await tokenOf(where.session.pid);
    const content = envelope({ from: replyTo ? udsAddress(replyTo) : null, name: from, mode: "prompting", text });
    if (!content) throw new Error("a message needs words");
    if (token) {
      try {
        const w = await writeSocket(how.socket, frames({ token, content }));
        return { via: "socket", to: where.session.name ?? String(where.session.pid), pid: where.session.pid, uncertain: Boolean(w.uncertain) };
      } catch (e) {
        if (!where.address || !hcSend) throw e;
      }
    } else if (!where.address || !hcSend) throw new Error(`no auth key for session ${where.session.pid}`);
  }
  if ((how.hc || where.address) && hcSend) {
    // Typed text: control characters out (an ESC must not reach a terminal), one line.
    const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
    await hcSend(how.hc ?? where.address, `${from ? `${clean(senderName(from) ?? "")}: ` : ""}${clean(text)}`);
    return { via: "hc", to: how.hc ?? where.address };
  }
  if (!typed && where.session) throw new Error(`${target} has no messaging socket (Claude Code older than 2.1.319, or not Claude); hc send types it as if from the user`);
  throw new Error(where.error ?? `can't reach ${target}`);
}

/** This session's own omniloop address (the key of its turn record): HC_TERMINAL_ID, else its hook record's. */
export async function myAddress() {
  if (process.env.HC_TERMINAL_ID) return process.env.HC_TERMINAL_ID;
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!sock) return null;
  const pid = (await liveSessions()).find((x) => x.messagingSocketPath === sock)?.pid;
  return pid == null ? null : Object.values(await hookRecords()).find((h) => h.pid === pid)?.address ?? null;
}
