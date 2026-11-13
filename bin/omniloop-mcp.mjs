#!/usr/bin/env node
// omniloop-mcp: omniloop's messaging as MCP tools for a Claude session (stdio, newline-delimited JSON-RPC).
// Request handling is core/mcp.js; this file wires stdin/stdout and the real tools.
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { handleLine } from "../core/mcp.js";
import { feedEntry, feedLine, parseFeed, FEED_FILE } from "../core/feed.js";
import { loopHome, validId } from "../core/loopdir.js";
import { deliver, liveSessions, hookRecords, TURNS_DIR } from "./lib/sock.mjs";

const SEND_TIMEOUT_MS = 180_000;

const needText = (v, what) => { if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`); return v; };

/** Who is calling: HC_TERMINAL_ID, else the registry name of this session (by its socket), else "agent". */
async function sender() {
  if (process.env.HC_TERMINAL_ID) return process.env.HC_TERMINAL_ID;
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (sock) {
    const n = (await liveSessions()).find((x) => x.messagingSocketPath === sock)?.name;
    if (n) return n;
  }
  return "agent";
}

// hc send <addr> <text>, failing on a non-zero exit or a timeout.
const hcSend = (addr, text) => new Promise((res, rej) => {
  const p = spawn("hc", ["send", addr, text], { stdio: "ignore" });
  const t = setTimeout(() => { p.kill(); rej(new Error(`hc send to ${addr} timed out`)); }, SEND_TIMEOUT_MS);
  p.on("error", (e) => { clearTimeout(t); rej(e); });
  p.on("exit", (code) => { clearTimeout(t); code === 0 ? res() : rej(new Error(`hc send to ${addr} failed (exit ${code})`)); });
});

// Tell the watcher this turn already reported to `to`, so it won't send a duplicate "finished its turn".
async function markReported(from, to) {
  if (/[/\\]|\.\./.test(from)) return;
  const file = join(TURNS_DIR, `${from}.json`);
  let rec;
  try { rec = JSON.parse(await readFile(file, "utf8")); } catch { return; }
  if (!rec || typeof rec !== "object") return;
  rec.reportedAt = Date.now();
  rec.reportedTo = to;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec));
  await rename(tmp, file);
}

/** The loop whose loop.json is in the session's cwd or a parent. */
async function loopOfCwd() {
  let dir = process.cwd();
  for (;;) {
    try { const m = JSON.parse(await readFile(join(dir, "loop.json"), "utf8")); if (validId(m?.id)) return m.id; } catch {}
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function loopArg(v) {
  const id = v ?? (await loopOfCwd());
  if (!id) throw new Error("no loop: pass loop, or run in a loop's folder");
  if (!validId(id)) throw new Error(`bad loop id: ${id}`);
  return id;
}

const str = (description) => ({ type: "string", description });

const tools = [
  {
    name: "send_message",
    description: "Send a message to another Claude session. It arrives labelled with your name, not as user input, and wakes an idle session. to: terminal address, session name, pid or session id (see list_sessions).",
    inputSchema: { type: "object", properties: { to: str("who to send to"), text: str("the message") }, required: ["to", "text"] },
    async run({ to, text }) {
      needText(to, "to"); needText(text, "text");
      const from = await sender();
      const d = await deliver(to, { from, text, hcSend });
      await markReported(from, to).catch(() => {});
      return `sent to ${to} via ${d.via}`;
    },
  },
  {
    name: "list_sessions",
    description: "Live Claude sessions on this computer: address, name, pid, status, socket, cwd.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const [ss, hooks] = await Promise.all([liveSessions(), hookRecords()]);
      const addrOf = new Map(Object.values(hooks).map((h) => [h.pid, h.address]));
      const rows = ss.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .map((x) => `${addrOf.get(x.pid) ?? "-"}\t${x.name ?? "-"}\t${x.pid}\t${x.status ?? "?"}\t${x.messagingSocketPath ? "socket" : "no socket"}\t${x.cwd ?? ""}`);
      return rows.length ? rows.join("\n") : "no Claude sessions running";
    },
  },
  {
    name: "say",
    description: "Post a message to a loop's chat feed, which the user reads. loop defaults to the loop of your working folder.",
    inputSchema: { type: "object", properties: { text: str("the message"), loop: str("loop id"), thread: str("short thread tag") }, required: ["text"] },
    async run({ text, loop, thread }) {
      needText(text, "text");
      const id = await loopArg(loop);
      const r = feedEntry({ from: await sender(), thread, text, now: Date.now() });
      if (r.error) throw new Error(r.error);
      const home = loopHome(homedir(), id);
      await mkdir(home, { recursive: true });
      await appendFile(join(home, FEED_FILE), feedLine(r.entry));
      return `said in ${id}${r.entry.thread ? ` #${r.entry.thread}` : ""}`;
    },
  },
  {
    name: "read_feed",
    description: "The last N (default 20) messages of a loop's chat feed, as HH:MM sender: text lines.",
    inputSchema: { type: "object", properties: { loop: str("loop id"), last: { type: "integer", description: "how many (default 20)" } } },
    async run({ loop, last }) {
      const id = await loopArg(loop);
      const n = last === undefined ? 20 : Number(last);
      if (!Number.isInteger(n) || n < 1) throw new Error("last must be a positive integer");
      let raw = "";
      try { raw = await readFile(join(loopHome(homedir(), id), FEED_FILE), "utf8"); } catch {}
      const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);
      const rows = parseFeed(raw, { last: n }).map((e) => `${hhmm(e.ts)} ${e.from}${e.thread ? ` #${e.thread}` : ""}: ${e.text.replace(/\s+/g, " ")}`);
      return rows.length ? rows.join("\n") : `no messages in ${id} yet`;
    },
  },
];

const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => {
  // Answer in order, one at a time.
  chain = chain.then(async () => {
    try { const out = await handleLine(line, tools); if (out) process.stdout.write(out); } catch {}
  });
});
rl.on("close", () => { chain.then(() => process.exit(0)); });
