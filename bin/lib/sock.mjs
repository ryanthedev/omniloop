// sock.mjs: the I/O half of core/deliver.js. Reads Claude Code's session registry and the omniloop hook records,
// and writes one labelled message to a session's messaging socket. No herdr needed: hc is only the fallback.
import { readFile, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { envelope, frames, resolveTarget, route, udsAddress } from "../../core/deliver.js";

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

/** Write the frames and close. Resolves when the socket has flushed; rejects on connect error or timeout. */
export function writeSocket(path, data, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const t = setTimeout(() => { s.destroy(); reject(new Error(`socket ${path}: timed out`)); }, timeoutMs);
    s.on("error", (e) => { clearTimeout(t); reject(e); });
    s.on("connect", () => s.end(data, () => { clearTimeout(t); resolve(); }));
  });
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
  return { session: r.session ?? null, address: hook?.address ?? (looksLikeAddress ? String(target) : null), mode: hook?.mode ?? null, error: r.error };
}

/**
 * Deliver one message. from: the sender's display name ("omniloop", "you", an agent address);
 * replyTo: the sender session's own socket path, so the receiver can answer (optional).
 * hcSend(address, text): the fallback (the caller owns hc: --if guards, timeouts).
 * Returns { via: "socket" | "hc", to } or throws with a reason.
 */
export async function deliver(target, { from, text, replyTo = process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null, hcSend = null } = {}) {
  const where = await locate(target);
  const how = route(where);
  if (how.socket) {
    const token = await tokenOf(where.session.pid);
    const content = envelope({ from: replyTo ? udsAddress(replyTo) : null, name: from, mode: "prompting", text });
    if (!content) throw new Error("a message needs words");
    if (token) {
      try {
        await writeSocket(how.socket, frames({ token, content }));
        return { via: "socket", to: where.session.name ?? String(where.session.pid), pid: where.session.pid };
      } catch (e) {
        if (!where.address || !hcSend) throw e;
      }
    } else if (!where.address || !hcSend) throw new Error(`no auth key for session ${where.session.pid}`);
  }
  if ((how.hc || where.address) && hcSend) {
    await hcSend(how.hc ?? where.address, `${from ? `${from}: ` : ""}${String(text).replace(/\s+/g, " ").trim()}`);
    return { via: "hc", to: how.hc ?? where.address };
  }
  throw new Error(where.error ?? `can't reach ${target}`);
}
