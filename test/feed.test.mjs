import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { feedEntry, feedLine, parseFeed, chatRows, chatThreads, FEED_FILE } from "../core/feed.js";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");
const e = (n, extra = {}) => ({ ts: n, from: "t1", thread: null, text: `m${n}`, ...extra });

// ---- pure ----

test("feedEntry: cleaned text, thread null when absent, error when empty", () => {
  assert.deepEqual(feedEntry({ from: "t1", text: "  hi  ", now: 5 }), { entry: { ts: 5, from: "t1", thread: null, text: "hi" } });
  assert.equal(feedEntry({ from: "t1", thread: "  ", text: "x", now: 1 }).entry.thread, null);
  assert.equal(feedEntry({ from: "t1", thread: " a  b ", text: "x", now: 1 }).entry.thread, "a b");
  assert.ok(feedEntry({ from: "t1", text: "  \n ", now: 1 }).error);
  assert.ok(feedEntry({ from: "t1", text: undefined, now: 1 }).error);
  assert.ok(feedEntry({ from: "", text: "x", now: 1 }).error);
  assert.ok(feedEntry({ from: "t1", text: "x" }).error);
});

test("feedEntry: 2000-char cap, newlines kept, control characters dropped", () => {
  assert.equal(feedEntry({ from: "a", text: "a".repeat(3000), now: 1 }).entry.text.length, 2000);
  assert.equal(feedEntry({ from: "a", text: "😀".repeat(2500), now: 1 }).entry.text, "😀".repeat(2000));
  assert.equal(feedEntry({ from: "a", text: "one\r\ntwo\x1b[31m\x07", now: 1 }).entry.text, "one\ntwo[31m");
  assert.equal(feedEntry({ from: "a", thread: "x".repeat(99), text: "t", now: 1 }).entry.thread.length, 40);
});

test("feedLine: one line ending in a newline even when the text has newlines", () => {
  const line = feedLine(feedEntry({ from: "a", text: "l1\nl2", now: 1 }).entry);
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.deepEqual(JSON.parse(line), { ts: 1, from: "a", thread: null, text: "l1\nl2" });
});

test("DW-1.3 parseFeed: last N keeps the newest, oldest first", () => {
  const text = [1, 2, 3, 4].map((n) => feedLine(e(n))).join("");
  assert.deepEqual(parseFeed(text).map((x) => x.ts), [1, 2, 3, 4]);
  assert.deepEqual(parseFeed(text, { last: 2 }).map((x) => x.ts), [3, 4]);
  assert.deepEqual(parseFeed(text, { last: 10 }).map((x) => x.ts), [1, 2, 3, 4]);
  assert.deepEqual(parseFeed(text, { last: 0 }), []);
});

test("DW-1.3 parseFeed: a torn first line is skipped", () => {
  const text = `rt":1,"from":"t1","thread":null,"text":"cut"}\n` + feedLine(e(2)) + feedLine(e(3));
  assert.deepEqual(parseFeed(text).map((x) => x.ts), [2, 3]);
});

test("DW-1.3 parseFeed: bad lines are skipped (junk, wrong shape, torn last line)", () => {
  const text = feedLine(e(1)) + "not json\n\n[1,2]\n42\nnull\n" + '{"ts":"x","from":"a","text":"b"}\n' + '{"ts":2,"from":"a"}\n'
    + feedLine(e(3)) + '{"ts":4,"from":"t1","thre';
  assert.deepEqual(parseFeed(text).map((x) => x.ts), [1, 3]);
  assert.deepEqual(parseFeed(""), []);
  assert.deepEqual(parseFeed(undefined), []);
});

test("DW-1.3 parseFeed: thread is kept, a missing thread is null", () => {
  const text = feedLine(e(1, { thread: "build" })) + '{"ts":2,"from":"a","text":"b"}\n';
  assert.deepEqual(parseFeed(text).map((x) => x.thread), ["build", null]);
});

test("FEED_FILE name", () => assert.equal(FEED_FILE, "feed.jsonl"));

// ---- the command (spawned; temp HOME, never the real ~/loops) ----

async function scratch(t) {
  const home = await mkdtemp(join(tmpdir(), "omniloop-feed-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "loops", "X"), { recursive: true });
  await writeFile(join(home, "loops", "X", "loop.json"), JSON.stringify({ id: "X", goal: "g" }));
  const env = { ...process.env, HOME: home };
  delete env.HC_TERMINAL_ID;
  const say = (args, extra = {}) => run("node", [BIN, "say", ...args], { env: { ...env, ...extra } });
  return { home, env, say, feed: join(home, "loops", "X", FEED_FILE) };
}

test("DW-1.1 say appends one {ts, from, thread:null, text} line to ~/loops/X/feed.jsonl", async (t) => {
  const { say, feed } = await scratch(t);
  const before = Date.now();
  const { stdout } = await say(["hi", "--loop", "X"]);
  assert.match(stdout, /said in X/);
  const lines = (await readFile(feed, "utf8")).split("\n");
  assert.equal(lines.length, 2); assert.equal(lines[1], "");
  const o = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(o), ["ts", "from", "thread", "text"]);
  assert.deepEqual({ from: o.from, thread: o.thread, text: o.text }, { from: "you", thread: null, text: "hi" });
  assert.ok(o.ts >= before && o.ts <= Date.now());
});

test("say: from is HC_TERMINAL_ID, --thread kept, multi-word text and newlines stay one line", async (t) => {
  const { say, feed } = await scratch(t);
  await say(["two words\nand more", "--thread", "build", "--loop", "X"], { HC_TERMINAL_ID: "t9" });
  const text = await readFile(feed, "utf8");
  assert.equal(text.trim().split("\n").length, 1);
  assert.deepEqual(parseFeed(text).map(({ from, thread, text }) => ({ from, thread, text })), [{ from: "t9", thread: "build", text: "two words\nand more" }]);
});

test("say refuses: empty text, no loop folder, bad loop id, thread without a value", async (t) => {
  const { say, feed } = await scratch(t);
  for (const args of [["   ", "--loop", "X"], ["hi", "--loop", "nope"], ["hi", "--loop", "../X"], ["hi", "--loop", "X", "--thread"], ["--loop", "X"]]) {
    await assert.rejects(say(args), (err) => err.code === 1 && /omniloop:/.test(err.stderr), args.join(" "));
  }
  await assert.rejects(readFile(feed, "utf8"), { code: "ENOENT" });
});

test("say closes a torn last line (crash) so the next message survives", async (t) => {
  const { say, feed } = await scratch(t);
  await writeFile(feed, feedLine(e(1)) + '{"ts":2,"from":"t1","thre');
  await say(["after", "--loop", "X"]);
  assert.deepEqual(parseFeed(await readFile(feed, "utf8")).map((x) => x.text), ["m1", "after"]);
});

test("DW-1.2 two concurrent writers x 50 say: exactly 100 entries, each text once", { timeout: 120_000 }, async (t) => {
  const { say, feed, home } = await scratch(t);
  const writer = async (w) => { for (let i = 0; i < 50; i++) await say([`w${w}-${i}`, "--loop", "X"]); };
  await Promise.all([writer(1), writer(2)]);
  const entries = parseFeed(await readFile(feed, "utf8"));
  assert.equal(entries.length, 100);
  const want = [1, 2].flatMap((w) => Array.from({ length: 50 }, (_, i) => `w${w}-${i}`)).sort();
  assert.deepEqual(entries.map((x) => x.text).sort(), want);
  assert.equal((await readFile(feed, "utf8")).split("\n").filter(Boolean).length, 100); // no line is joined or torn
  await assert.rejects(readFile(join(home, "loops", "X", "feed.lock")), { code: "ENOENT" }); // lock released
});

test("DW-1.4 omniloop brief mentions omniloop say", async () => {
  const { stdout } = await run("node", [BIN, "brief"]);
  assert.match(stdout, /omniloop say /);
});

// ---- phase 2: goal/task posts and `reply` (spawned; temp HOME and OMNILOOP_HOME; a stub `hc` on PATH) ----

import { spawn } from "node:child_process";
import { chmod, readdir } from "node:fs/promises";
import { replyPlan } from "../core/feed.js";

/** A stub `hc`: `ls`/`get` serve cfg.terms (or fail like a degraded herdr-core when cfg.down), `send` is logged and exits cfg.sendExit. */
async function stubHc(dir, cfg) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cfg.json"), JSON.stringify(cfg));
  await writeFile(join(dir, "hc"), `#!/usr/bin/env node
const fs = require("fs"), d = ${JSON.stringify(dir)}, cfg = JSON.parse(fs.readFileSync(d + "/cfg.json", "utf8")), a = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (cfg.down && a[0] !== "events") { out({ error: { kind: "internal", message: "cannot save terminals: registry writer stopped" } }); process.exit(1); }
if (a[0] === "ls") out({ terminals: cfg.terms.map((t) => ({ address: t.address })) });
else if (a[0] === "get") { const t = cfg.terms.find((x) => x.address === a[1]); if (t) out(t); else process.exit(1); }
else if (a[0] === "label") process.exit(0);
else if (a[0] === "send") { fs.appendFileSync(d + "/sends.log", JSON.stringify(a.filter((x) => x !== "--json")) + "\\n"); if (cfg.sendOut) process.stderr.write(cfg.sendOut); process.exit(cfg.sendExit || 0); }
else if (a[0] === "events") { out({ terminals: cfg.terms }); for (const [ms, ev] of cfg.events || []) setTimeout(() => out(ev), ms); setInterval(() => {}, 1e6); }
else process.exit(1);
`);
  await chmod(join(dir, "hc"), 0o755);
}
const lead = (status, extra = {}) => ({ address: "t1", state: "live", status: status && { state: status }, labels: { omniloop: "X", "omniloop.lead": "1" }, turn: 1, ...extra });

async function cli(t, cfg = { terms: [] }) {
  const s = await scratch(t);
  await writeFile(join(s.home, "loops", "X", "loop.json"), JSON.stringify({ id: "X", goal: "g", dirs: [], created_ms: 1 })); // what cmdGoal/cmdTask read
  const bin = join(s.home, "bin"), cache = join(s.home, "cache");
  await stubHc(bin, cfg);
  const env = { ...s.env, PATH: `${bin}:${process.env.PATH}`, OMNILOOP_HOME: cache };
  const cmd = (args, extra = {}) => run("node", [BIN, ...args], { env: { ...env, ...extra } });
  const feedOf = async () => parseFeed(await readFile(s.feed, "utf8").catch(() => ""));
  const sends = async () => (await readFile(join(bin, "sends.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const timers = async () => Promise.all((await readdir(join(cache, "timers")).catch(() => [])).filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(join(cache, "timers", f), "utf8"))));
  return { ...s, bin, cache, cmd, feedOf, sends, timers, cfg: (c) => stubHc(bin, c) };
}
const brief = (f) => f.map(({ from, text }) => `${from}: ${text}`);

test("DW-2.2 replyPlan: idle sends guarded, done sends, working/blocked/shell hold, no or remote lead is none", () => {
  assert.deepEqual(replyPlan("t1", "idle"), { send: { if: "idle" } });
  assert.deepEqual(replyPlan("t1", "done"), { send: { if: null } });
  assert.deepEqual(replyPlan("t1", "working"), { hold: true });
  assert.deepEqual(replyPlan("t1", "blocked"), { hold: true });
  assert.deepEqual(replyPlan("t1", null), { hold: true });          // a plain shell: the watcher marks it undeliverable
  assert.deepEqual(replyPlan(null, "idle"), { none: true });
  assert.deepEqual(replyPlan(undefined, "idle"), { none: true });
  assert.deepEqual(replyPlan("m1/t1", "idle"), { none: true });     // never type into another machine
});

test("DW-2.3 goal set, task add and task done each append one feed line, even with herdr-core down", async (t) => {
  const c = await cli(t, { terms: [], down: true });
  await c.cmd(["goal", "set", "ship the chat", "--loop", "X"]);
  assert.deepEqual(brief(await c.feedOf()), ["you: goal set: ship the chat"]);
  await c.cmd(["task", "add", "write tests", "--for", "you", "--loop", "X"]);
  assert.deepEqual(brief(await c.feedOf()).slice(1), ["you: task 1 added for you: write tests"]);
  await c.cmd(["task", "done", "1", "--loop", "X"]);
  assert.deepEqual(brief(await c.feedOf()).slice(2), ["you: task 1 done: write tests"]);
  assert.equal((await c.feedOf()).length, 3);
  console.log(await readFile(c.feed, "utf8"));                       // shown for the report
});

test("goal add / goal done post too; an unchanged goal posts nothing; an agent's id is the sender", async (t) => {
  const c = await cli(t, { terms: [], down: true });
  await c.cmd(["goal", "set", "first", "--loop", "X"], { HC_TERMINAL_ID: "t4" });
  await c.cmd(["goal", "set", "first", "--loop", "X"]);              // no change
  await c.cmd(["goal", "add", "second", "--loop", "X"]);
  await c.cmd(["goal", "done", "2", "--loop", "X"]); // 1 was the scratch loop's starting goal, replaced by "first"
  assert.deepEqual(brief(await c.feedOf()), ["t4: goal set: first", "you: goal added: second", "you: goal 2 done: first"]);
});

test("a failed goal or task command posts nothing", async (t) => {
  const c = await cli(t, { terms: [], down: true });
  await assert.rejects(c.cmd(["task", "done", "9", "--loop", "X"]));
  await assert.rejects(c.cmd(["goal", "done", "9", "--loop", "X"]));
  assert.deepEqual(await c.feedOf(), []);
});

test("reply to an idle lead: posted as you (thread kept), sent now with --if idle, nothing held", async (t) => {
  const c = await cli(t, { terms: [lead("idle")] });
  const { stdout } = await c.cmd(["reply", "do it\nnow", "--loop", "X", "--thread", "plan"]);
  assert.match(stdout, /^sent to t1/);
  assert.deepEqual((await c.feedOf()).map(({ from, thread, text }) => ({ from, thread, text })), [{ from: "you", thread: "plan", text: "do it\nnow" }]);
  assert.deepEqual(await c.sends(), [["send", "--if", "idle", "t1", "you: do it now"]]);
  assert.deepEqual(await c.timers(), []);
});

test("reply to a done lead: sent with no idle guard", async (t) => {
  const c = await cli(t, { terms: [lead("done")] });
  await c.cmd(["reply", "hello", "--loop", "X"]);
  assert.deepEqual(await c.sends(), [["send", "t1", "you: hello"]]);
});

test("DW-2.2 reply to a working lead is held as a due-now note timer, and says no watcher is running", async (t) => {
  const c = await cli(t, { terms: [lead("working")] });
  const before = Date.now();
  const { stdout } = await c.cmd(["reply", "hello", "--loop", "X"]);
  assert.match(stdout, /^held for t1; no watcher is running/);
  assert.deepEqual(await c.sends(), []);
  const [tm] = await c.timers();
  assert.deepEqual({ to: tm.to, text: tm.text, note: tm.note }, { to: "t1", text: "you: hello", note: true });
  assert.ok(tm.at >= before && tm.at <= Date.now());
  const f = brief(await c.feedOf());
  assert.equal(f[0], "you: hello");
  assert.match(f[1], /^omniloop: your reply waits for a watcher: none is running/);
});

test("reply held with a live watcher: no 'waits for a watcher' line; a stale or dead watcher doesn't count", async (t) => {
  const c = await cli(t, { terms: [lead("blocked")] });
  await mkdir(c.cache, { recursive: true });
  const state = join(c.cache, "state-X.json");
  await writeFile(state, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
  let r = await c.cmd(["reply", "one", "--loop", "X"]);
  assert.match(r.stdout, /held for t1 \(blocked\); the watcher delivers/);
  assert.deepEqual(brief(await c.feedOf()), ["you: one"]);
  await writeFile(state, JSON.stringify({ pid: process.pid, heartbeat: Date.now() - 60_000 })); // stale
  r = await c.cmd(["reply", "two", "--loop", "X"]);
  assert.match(r.stdout, /no watcher is running/);
  await writeFile(state, JSON.stringify({ pid: 2 ** 30, heartbeat: Date.now() }));               // fresh but dead
  r = await c.cmd(["reply", "three", "--loop", "X"]);
  assert.match(r.stdout, /no watcher is running/);
  await writeFile(state, "not json");                                                            // unreadable
  assert.match((await c.cmd(["reply", "four", "--loop", "X"])).stdout, /no watcher is running/);
  assert.equal((await c.timers()).length, 4);
});

test("reply to a plain-shell lead (no status) is held, never typed", async (t) => {
  const c = await cli(t, { terms: [lead(null)] });
  const { stdout } = await c.cmd(["reply", "hi", "--loop", "X"]);
  assert.match(stdout, /^held for t1/);
  assert.deepEqual(await c.sends(), []);
  assert.equal((await c.timers()).length, 1);
});

test("reply with no lead running appends the omniloop line and exits 0", async (t) => {
  const c = await cli(t, { terms: [{ address: "t2", state: "live", status: { state: "idle" }, labels: { omniloop: "X" }, turn: 1 }] });
  const { stdout } = await c.cmd(["reply", "anyone?", "--loop", "X"]);
  assert.match(stdout, /no lead is running in X; nobody got this/);
  assert.deepEqual(brief(await c.feedOf()), ["you: anyone?", "omniloop: no lead is running; nobody got this"]);
  assert.deepEqual(await c.sends(), []);
});

test("reply never sends to another machine's lead", async (t) => {
  const c = await cli(t, { terms: [{ ...lead("idle"), address: "m1/t1", labels: { omniloop: "X", "omniloop.lead": "1" } }] });
  const { stdout } = await c.cmd(["reply", "hi", "--loop", "X"]);
  assert.match(stdout, /no lead is running/);
  assert.deepEqual(await c.sends(), []);
});

test("reply: hc send that typed the note then failed to save counts as sent; a refusal is held", async (t) => {
  const c = await cli(t, { terms: [lead("idle")], sendExit: 1, sendOut: "cannot save terminals: registry writer stopped" });
  assert.match((await c.cmd(["reply", "a", "--loop", "X"])).stdout, /^sent to t1/);
  assert.equal((await c.timers()).length, 0);
  await c.cfg({ terms: [lead("idle")], sendExit: 1, sendOut: "refused: not idle" });
  assert.match((await c.cmd(["reply", "b", "--loop", "X"])).stdout, /^held for t1/);
  assert.equal((await c.timers()).length, 1);
});

test("reply with herdr-core down: the reply stays in the feed, a line says it wasn't delivered, exit 1", async (t) => {
  const c = await cli(t, { terms: [], down: true });
  await assert.rejects(c.cmd(["reply", "hi", "--loop", "X"]), (err) => err.code === 1 && /not delivered/.test(err.stderr));
  assert.deepEqual(brief(await c.feedOf()), ["you: hi", "omniloop: herdr-core (hc) didn't answer; this reply was not delivered"]);
});

test("reply refuses: empty text, no loop folder, bad id, thread without a value; nothing is written", async (t) => {
  const c = await cli(t, { terms: [lead("idle")] });
  for (const args of [["   ", "--loop", "X"], ["hi", "--loop", "nope"], ["hi", "--loop", "../X"], ["hi", "--loop", "X", "--thread"], ["--loop", "X"]])
    await assert.rejects(c.cmd(["reply", ...args]), (err) => err.code === 1 && /omniloop:/.test(err.stderr), args.join(" "));
  assert.deepEqual(await c.feedOf(), []);
  assert.deepEqual(await c.sends(), []);
});

test("reply: a dry-run watcher's state file does not count as a running watcher", async (t) => {
  const c = await cli(t, { terms: [lead("working")] });
  await mkdir(c.cache, { recursive: true });
  const fresh = JSON.stringify({ pid: process.pid, heartbeat: Date.now(), loop: "X", dryRun: true });
  await writeFile(join(c.cache, "dry-X.json"), fresh);
  await writeFile(join(c.cache, "dry.json"), fresh);
  assert.match((await c.cmd(["reply", "hello", "--loop", "X"])).stdout, /no watcher is running/);
});

test("withLock drops a crashed writer's stale lock after ~5 s and then writes (it sleeps between tries, never spins)", async (t) => {
  const c = await cli(t, { terms: [] });
  await mkdir(join(c.home, "loops", "X", "feed.lock"));
  const t0 = Date.now();
  await c.cmd(["say", "after stale", "--loop", "X"]);
  assert.deepEqual((await c.feedOf()).map((x) => x.text), ["after stale"]);
  assert.ok(Date.now() - t0 >= 4500 && Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
});

test("feed prints the newest N lines as 'HH:MM from #thread: text' from a multi-MB feed; default 20; bad N refused", async (t) => {
  const c = await cli(t, { terms: [] });
  const base = Date.parse("2026-11-13T10:00:00");
  const big = Array.from({ length: 30_000 }, (_, i) => feedLine({ ts: base + i * 1000, from: i % 2 ? "t1" : "you", thread: i === 29_999 ? "plan" : null, text: `message ${i} ${"x".repeat(80)}` })).join("");
  await writeFile(c.feed, big);
  assert.ok(big.length > 3_000_000);
  const { stdout } = await c.cmd(["feed", "--last", "3", "--loop", "X"]);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d\d:\d\d t1: message 29997 x+$/);
  assert.match(lines[1], /^\d\d:\d\d you: message 29998 /);
  assert.match(lines[2], /^\d\d:\d\d t1 #plan: message 29999 /);
  assert.equal((await c.cmd(["feed", "--loop", "X"])).stdout.trim().split("\n").length, 20);
  for (const bad of [["--last", "0"], ["--last", "abc"], ["--loop", "../X"]])
    await assert.rejects(c.cmd(["feed", ...(bad[0] === "--loop" ? [] : ["--loop", "X"]), ...bad]), (err) => err.code === 1);
});

test("feed on an empty or missing feed says so", async (t) => {
  const c = await cli(t, { terms: [] });
  assert.match((await c.cmd(["feed", "--loop", "X"])).stdout, /no messages in X yet/);
});

// ---- chatRows / chatThreads (DW-3.1) ----

const NOW = 10_000_000;
const MIN = 60_000;
const feedOf3 = [
  { ts: NOW - 125 * MIN, from: "t1", thread: "plan", text: "first" },
  { ts: NOW - 5 * MIN, from: "omniloop", thread: null, text: "second" },
  { ts: NOW - 20_000, from: "you", thread: "plan", text: "third" },
  { ts: NOW - 2 * MIN, from: "t9", thread: "ui", text: "fourth" },
];

test("DW-3.1 chatRows keeps the order it is given (oldest first, newest last) and shows every thread by default", () => {
  assert.deepEqual(chatRows(feedOf3, { now: NOW }).map((r) => r.text), ["first", "second", "third", "fourth"]);
});

test("DW-3.1 chatRows: a thread filter keeps only that tag; an unknown tag gives nothing", () => {
  assert.deepEqual(chatRows(feedOf3, { thread: "plan", now: NOW }).map((r) => r.text), ["first", "third"]);
  assert.deepEqual(chatRows(feedOf3, { thread: "nope", now: NOW }), []);
});

test("DW-3.1 chatRows: names map addresses; you and omniloop stay literal; unknown addresses fall back to themselves", () => {
  const r = chatRows(feedOf3, { now: NOW, names: { t1: "builder", you: "SHOULD NOT APPLY" } });
  assert.deepEqual(r.map((x) => x.who), ["builder", "omniloop", "you", "t9"]);
  assert.deepEqual(r.map((x) => [x.mine, x.system]), [[false, false], [false, true], [true, false], [false, false]]);
});

test("DW-3.1 chatRows: ages are now / minutes / hours / days", () => {
  const r = chatRows(feedOf3, { now: NOW });
  assert.deepEqual(r.map((x) => x.age), ["2h", "5m", "now", "2m"]);
  assert.equal(chatRows([{ ts: NOW - 3 * 24 * 60 * MIN, from: "t1", text: "old" }], { now: NOW })[0].age, "3d");
});

test("chatRows: thread tags carry over (null for the main stream); long text is not cut; malformed entries are skipped", () => {
  const long = "w ".repeat(1500).trim();
  const r = chatRows([null, 7, { ts: "x", from: "t1", text: "bad ts" }, { ts: NOW, from: "t1", text: long, thread: "" }, feedOf3[0]], { now: NOW });
  assert.equal(r.length, 2);
  assert.equal(r[0].text, long);
  assert.equal(r[0].thread, null);
  assert.equal(r[1].thread, "plan");
  assert.deepEqual(chatRows(undefined, { now: NOW }), []);
  assert.deepEqual(chatRows([], { now: NOW }), []);
});

test("chatThreads: tags with counts, most recently posted-to first; main stream and bad entries ignored", () => {
  assert.deepEqual(chatThreads(feedOf3), [{ thread: "plan", count: 2 }, { thread: "ui", count: 1 }]);
  assert.deepEqual(chatThreads([{ ts: 1, from: "a", thread: null, text: "x" }, null]), []);
  assert.deepEqual(chatThreads(undefined), []);
});

test("reply: text after `--` is the message even when it starts with -- (the pane passes flags first, then `--`, then the text)", async (t) => {
  const c = await cli(t, { terms: [] });
  await c.cmd(["reply", "--loop", "X", "--", "--foo"]);
  await c.cmd(["reply", "--loop", "X", "--thread", "plan", "--", "--loop is just words here"]);
  const you = (await c.feedOf()).filter((e) => e.from === "you");
  assert.deepEqual(you.map((e) => [e.thread, e.text]), [[null, "--foo"], ["plan", "--loop is just words here"]]);
});
