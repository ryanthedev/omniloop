// backend.js: the pure half of the terminal-backend port (no I/O). Which backend a process uses, who "I" am in it,
// what an address looks like, and when a person's unsent draft should hold a typed note back.
// The port itself (the interface both adapters implement) is documented in bin/lib/backend/index.mjs.

export const BACKENDS = ["herdr", "omni"];

/**
 * Which backend: OMNILOOP_BACKEND=omni|herdr wins; otherwise omni when this process runs in an omni pane (OMNI_PANE set,
 * HC_TERMINAL_ID not) and omniReachable(env) says the daemon's socket is there, else herdr. An unknown OMNILOOP_BACKEND throws (a typo must not silently pick herdr).
 */
export function backendName(env = {}, omniReachable = () => false) {
  const want = String(env.OMNILOOP_BACKEND ?? "").trim().toLowerCase();
  if (want) {
    if (!BACKENDS.includes(want)) throw new Error(`OMNILOOP_BACKEND=${env.OMNILOOP_BACKEND}: expected one of ${BACKENDS.join(", ")}`);
    return want;
  }
  // A stale OMNI_PANE inherited on a herdr machine must not switch backends: auto-select omni only when its daemon is reachable.
  return env.OMNI_PANE && !env.HC_TERMINAL_ID && omniReachable(env) ? "omni" : "herdr";
}

/** This process's own terminal id: HC_TERMINAL_ID (herdr) or OMNI_PANE (omni), the named backend's first. null outside a terminal. */
export function selfId(env = {}, name = null) {
  name ??= String(env.OMNILOOP_BACKEND ?? "").trim().toLowerCase() || null; // a forced backend decides when both ids are set
  const hc = env.HC_TERMINAL_ID || null, omni = env.OMNI_PANE || null;
  return (name === "omni" ? omni ?? hc : hc ?? omni) || null;
}

/** A herdr terminal id (t7, t1g9) or an omni pane id (pn_<ULID>). */
export const isPaneId = (s) => /^(t[0-9a-z]+|pn_[0-9A-Za-z]+)$/.test(String(s ?? ""));

/** Could this word be a terminal address rather than a session name? A herdr id is a plain word; an omni id is pn_<ULID>. */
export const looksLikeAddress = (s) => /^[a-z][a-z0-9]*$/i.test(String(s ?? "")) || /^pn_[0-9A-Za-z]+$/.test(String(s ?? ""));

/** Cut a string to at most `max` UTF-8 bytes, on a character boundary. */
export function clipBytes(s, max) {
  s = String(s ?? "");
  if (Buffer.byteLength(s) <= max) return s;
  let out = "";
  for (const ch of s) { if (Buffer.byteLength(out + ch) > max) break; out += ch; }
  return out;
}

const PLACEHOLDER = /^(try "|ask anything|type a message|send a message)/i;

/**
 * Is a person's unsent text sitting in the prompt of this screen? Looks at the last lines for an input row
 * ("❯ text", "> text", "│ > text │") with words after the marker that are not the program's own placeholder
 * ('Try "..."'). A heuristic: a wrong yes only delays a typed note (see waitForNoDraft), a wrong no types over a draft.
 */
export function hasDraft(screen) {
  const lines = String(screen ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  for (const line of lines.slice(-8).reverse()) {
    const m = line.match(/^[\s│|]*[❯>›]\s(.*?)[\s│|]*$/);
    if (m) return m[1].trim() !== "" && !PLACEHOLDER.test(m[1].trim());
  }
  return false;
}

/**
 * Emulates hc send's wait for a person's draft (omni send has none): poll `read()` until no draft is showing, at most
 * `maxMs`, then give up and let the caller type anyway (as hc does after its 60 s). Returns { waitedMs, gaveUp }.
 * read: () => Promise<string>, sleep: (ms) => Promise, now: () => ms. A failing read counts as "no draft".
 */
export async function waitForNoDraft({ read, sleep, now = Date.now, maxMs = 60_000, pollMs = 1000 }) {
  if (maxMs <= 0) return { waitedMs: 0, gaveUp: false };
  const t0 = now();
  for (;;) {
    let draft = false;
    try { draft = hasDraft(await read()); } catch {}
    const waited = now() - t0;
    if (!draft) return { waitedMs: waited, gaveUp: false };
    if (waited >= maxMs) return { waitedMs: waited, gaveUp: true };
    await sleep(Math.min(pollMs, maxMs - waited));
  }
}
