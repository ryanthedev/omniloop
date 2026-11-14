import { test } from "node:test";
import assert from "node:assert/strict";
import { initState, step, parseDuration, STALL_MS, START_MS, startingClaude, sendFailed, hold, withoutReplies, REPLY_WAIT_MS, adoptions, whereOf, ADOPT_AFTER_MS, ADOPT_WITHIN_MS } from "../core/watch.js";
import { ESCALATE_MS } from "../core/omniloop.js";

const T = (address, status, labels = {}, extra = {}) =>
  ({ address, state: "live", status: typeof status === "string" ? { state: status } : status, labels, turn: 1, created_ms: 0, event_ms: 0, ...extra });
const L = (extra = {}) => ({ omniloop: "m2", ...extra });
const base = () => [
  T("t1", "working", L({ "omniloop.coordinator": "1" })),
  T("t2", "working", L({ "omniloop.to": "t1" })),
  T("t3", "working", L({ "omniloop.to": "t2" })),
];
const put = (ts, address, patch) => ts.map((t) => t.address === address ? { ...t, ...patch } : t);

test("start is silent: what is already true is not news", () => {
  const ts = put(put(base(), "t3", { status: { state: "done" } }), "t2", { status: { state: "idle" } });
  const s = initState(ts, 0);
  assert.deepEqual(step(s, ts, 1).actions, []);
});

test("a blocked agent's note waits for its working parent, then goes as one line", () => {
  let s = initState(base(), 0);
  let ts = put(base(), "t3", { status: { state: "blocked", kind: "question", msg: "which db?" } });
  let r = step(s, ts, 1);
  assert.deepEqual(r.actions, []);                                   // t2 is working: held
  ts = put(ts, "t2", { status: { state: "done" } });
  r = step(r.state, ts, 2);
  // t2 finishing is t1's news (t1 working: held); t3's block goes to t2 now.
  assert.deepEqual(r.actions, [{ type: "send", to: "t2", text: "omniloop: t3 blocked (question): which db?", if: null }]);
  assert.deepEqual(step(r.state, ts, 3).actions, []);                // told once
});

test("several notes for one agent go in one send", () => {
  const ts0 = [...base(), T("t4", "working", L({ "omniloop.to": "t2" }))];
  let r = step(initState(ts0, 0), put(put(ts0, "t3", { status: { state: "done" } }), "t4", { status: { state: "done" } }), 1);
  r = step(r.state, put(put(put(ts0, "t3", { status: { state: "done" } }), "t4", { status: { state: "done" } }), "t2", { status: { state: "idle" } }), 2);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].text, "omniloop: t3 finished its turn · t4 finished its turn");
});

test("never type into a blocked agent", () => {
  let r = step(initState(base(), 0), put(base(), "t3", { status: { state: "blocked", kind: "question" } }), 1);
  r = step(r.state, put(put(base(), "t3", { status: { state: "blocked", kind: "question" } }), "t2", { status: { state: "blocked", kind: "question" } }), 2);
  assert.ok(!r.actions.some((a) => a.type === "send" && a.to === "t2"));
});

test("the coordinator's block is for you, once", () => {
  const ts = put(base(), "t1", { status: { state: "blocked", kind: "question" } });
  const r = step(initState(base(), 0), ts, 1);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, "you");
  assert.equal(step(r.state, ts, 2).actions.length, 0);
});

test("a delivered note isn't re-sent up the chain when its parent blocks later", () => {
  const q = { state: "blocked", kind: "question" };
  let ts = put(put(base(), "t3", { status: q }), "t2", { status: { state: "idle" } });
  let r = step(initState(base(), 0), ts, 1);
  assert.equal(r.actions.length, 1);                                  // t2 hears it
  ts = put(put(ts, "t2", { status: { state: "blocked", kind: "permission" } }), "t1", { status: { state: "idle" } });
  r = step(r.state, ts, 2);
  assert.deepEqual(r.actions.map((a) => [a.type, a.alert?.address ?? a.to]), [["you", "t2"]]);
});

test("a permission prompt anywhere is for you", () => {
  const ts = put(base(), "t3", { status: { state: "blocked", kind: "permission", msg: "approve Bash: rm -rf x" } });
  const r = step(initState(base(), 0), ts, 1);
  assert.deepEqual(r.actions.map((a) => a.type), ["you"]);
});

test("a block nobody clears escalates to you after ESCALATE_MS", () => {
  const ts = put(base(), "t3", { status: { state: "blocked", kind: "question" } });
  let r = step(initState(base(), 0), ts, 0);
  r = step(r.state, ts, ESCALATE_MS);
  assert.deepEqual(r.actions.map((a) => [a.type, a.alert.why]), [["you", "nobody cleared it"]]);
});

test("a stall is told once to the parent, and again only after new progress", () => {
  let r = step(initState(base(), 0), base(), STALL_MS - 1);
  assert.equal(Object.keys(r.state.pending).length, 0);
  r = step(r.state, base(), STALL_MS);
  // t1 (coordinator) stalled: you; t2 stalled: t1 (held, working); t3: t2 (held).
  assert.deepEqual(r.actions.map((a) => a.type), ["you"]);
  assert.deepEqual(Object.keys(r.state.pending).sort(), ["t1", "t2"]);
  const again = step(r.state, base(), STALL_MS + 1000);
  assert.equal(again.actions.length, 0);
});

test("timers fire as a note when the agent stops", () => {
  let s = initState(base(), 0, { timers: [{ id: "a", at: 100, to: "t2", text: "check the build" }] });
  let r = step(s, base(), 100);
  assert.equal(r.state.timers.length, 0);
  r = step(r.state, put(base(), "t2", { status: { state: "idle" } }), 101);
  assert.deepEqual(r.actions, [{ type: "send", to: "t2", text: "omniloop: timer: check the build", if: "idle" }]);
});

test("notes for a gone parent come to you", () => {
  let r = step(initState(base(), 0), put(base(), "t3", { status: { state: "done" } }), 1);
  r = step(r.state, put(put(base(), "t3", { status: { state: "done" } }), "t2", { state: "finished" }), 2);
  assert.ok(r.actions.some((a) => a.type === "you" && a.alert.kind === "undeliverable"));
});

test("scoped to one loop: terminals outside it are never touched", () => {
  const ts = [...put(base(), "t1", { status: { state: "blocked" } }), T("x1", "blocked", { omniloop: "other", "omniloop.coordinator": "1" }), T("t9", "blocked", {})];
  const r = step(initState(base(), 0, { loop: "m2" }), ts, 1, { loop: "m2" });
  assert.deepEqual(r.actions.map((a) => a.alert?.address ?? a.to), ["t1"]);
});

test("parseDuration", () => {
  assert.equal(parseDuration("20m"), 1200000);
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration("90s"), 90000);
  assert.equal(parseDuration("soon"), null);
});

test("never type into a plain shell: a parent with no agent status gets nothing, you hear instead", () => {
  let r = step(initState(base(), 0), put(base(), "t3", { status: { state: "done" } }), 1);
  r = step(r.state, put(put(base(), "t3", { status: { state: "done" } }), "t2", { status: null }), 2);
  assert.ok(!r.actions.some((a) => a.type === "send"));
  assert.ok(r.actions.some((a) => a.type === "you" && a.alert.why === "its parent isn't an agent now"));
});

test("touchedByYou: only the omniloop.you label changing to a value counts", async () => {
  const { touchedByYou } = await import("../core/watch.js");
  const a = (status, labels = {}) => ({ status: { state: status }, labels });
  assert.equal(touchedByYou(a("idle"), a("idle", { "omniloop.you": "100" })), true);                         // a person prompted it
  assert.equal(touchedByYou(a("idle", { "omniloop.you": "100" }), a("idle", { "omniloop.you": "200" })), true);
  assert.equal(touchedByYou(a("idle", { "omniloop.you": "100" }), a("working", { "omniloop.you": "100" })), false); // unchanged
  assert.equal(touchedByYou(a("idle", { "omniloop.you": "100" }), a("idle", { "omniloop.you": "" })), false);       // removed
  assert.equal(touchedByYou(a("done", { "herdr.seen": "3" }), a("idle", { "herdr.seen": "4" })), false);            // no longer a signal
  assert.equal(touchedByYou(a("idle"), a("working")), false);   // an agent's message looks like this: not you
  assert.equal(touchedByYou(a("working"), a("done")), false);
  assert.equal(touchedByYou(null, a("idle", { "omniloop.you": "1" })), false);
});

test("joining a loop isn't news: an agent that arrives already done is told nothing", () => {
  const s0 = initState(base(), 0);
  const joined = [...base(), T("t5", "done", L({ "omniloop.to": "t1" }))];
  assert.deepEqual(step(s0, joined, 1).actions, []);
  // ...but its next turn is.
  const r = step(step(s0, joined, 1).state, put(put(joined, "t5", { turn: 2 }), "t1", { status: { state: "idle" } }), 2);
  assert.ok(r.actions.some((a) => a.type === "send" && a.to === "t1"));
});

test("another machine's loop is watched, never typed into: its own watcher tells its agents", () => {
  const R = (extra = {}) => ({ omniloop: "m2", ...extra });
  const remote = () => [
    T("m1/t1", "idle", R({ "omniloop.coordinator": "1" })),
    T("m1/t2", "working", R({ "omniloop.to": "t1" })),
    T("m1/t3", "working", R({ "omniloop.to": "t2", "omniloop.needs": "you" })),
  ];
  const ts = () => [...base(), ...remote()];
  let s = initState(ts(), 0, { timers: [{ id: "a", at: 5, to: "m1/t1", text: "check" }] });
  let r = step(s, put(put(ts(), "m1/t2", { status: { state: "blocked" } }), "m1/t3", { status: { state: "blocked" } }), 10);
  assert.equal(r.actions.filter((a) => a.type === "send").length, 0);
  assert.deepEqual(Object.keys(r.state.pending), []);
  // What is for you still reaches this computer's view.
  assert.ok(r.you.some((a) => a.address === "m1/t3" && a.loop === "m1/m2"));
  // This computer's own loop of the same name is untouched by the remote one.
  r = step(r.state, put(put(put(ts(), "t3", { status: { state: "done" } }), "m1/t2", { status: { state: "blocked" } }), "m1/t3", { status: { state: "blocked" } }), 11);
  assert.deepEqual(r.state.pending, { t2: ["t3 finished its turn"] });
});

// A Claude agent at a dialog before its first prompt (folder trust) never reports a status, so no stall fires.
const starting = (address, labels, extra = {}) =>
  T(address, null, labels, { reported: false, status_ms: null, turn: 0, created_ms: 1000, argv: ["/bin/zsh", "-lc", "exec \"$@\"", "omniloop", "claude", "task"], ...extra });

test("a Claude agent that never starts is told to you once, after START_MS, even when it has a parent", () => {
  let s = initState(base(), 0);
  const ts = [...base(), starting("t4", L({ "omniloop.to": "t2" }))];
  let r = step(s, ts, 1000);                                          // just made: joining isn't news
  r = step(r.state, ts, 1000 + START_MS - 1);
  assert.deepEqual(r.actions, []);
  r = step(r.state, ts, 1000 + START_MS);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, "you");
  assert.match(r.actions[0].text, /^omniloop m2: t4 stuck at start: .*folder trust/);
  assert.deepEqual(step(r.state, ts, 1000 + START_MS + 5000).actions, []);   // told once
});

test("startingClaude: only a live, never-reported Claude", () => {
  assert.equal(startingClaude(starting("a", L())), true);
  assert.equal(startingClaude(starting("a", L(), { foreground: { argv: ["claude"] }, argv: ["sh"] })), true);
  assert.equal(startingClaude(starting("a", L(), { argv: ["/bin/zsh", "-l"] })), false);     // a plain shell
  assert.equal(startingClaude(starting("a", L(), { reported: true })), false);
  assert.equal(startingClaude(starting("a", L(), { status_ms: 5 })), false);
  assert.equal(startingClaude(starting("a", L(), { status: { state: "idle" } })), false);
  assert.equal(startingClaude(starting("a", L(), { state: "finished" })), false);
  assert.equal(startingClaude(starting("a", L(), { argv: ["claudette"] })), false);
});

test("sendFailed: a note typed before herdr-core failed to save is delivered, not held", () => {
  assert.equal(sendFailed(0, ""), false);
  assert.equal(sendFailed(1, '{"error":{"kind":"internal","message":"cannot save terminals: registry writer stopped"}}'), false);
  assert.equal(sendFailed(1, '{"error":{"kind":"refused","message":"not idle"}}'), true);
  assert.equal(sendFailed(null, ""), true);                          // killed on timeout
});

test("hold: the same line is held once per agent", () => {
  const p = {};
  hold(p, "t1", "t3 finished its turn"); hold(p, "t1", "t3 finished its turn"); hold(p, "t1", "t4 finished its turn");
  assert.deepEqual(p, { t1: ["t3 finished its turn", "t4 finished its turn"] });
});

// ---- the feed: what the watcher says in each loop's chat (phase 2) ----

const texts = (r) => r.feed.map((f) => `${f.loop}|${f.entry.from}|${f.entry.text}`);

test("DW-2.1 feed: a block routed to its parent is posted once, as omniloop, in the agent's loop", () => {
  const ts = put(base(), "t3", { status: { state: "blocked", kind: "question", msg: "which db?" } });
  let r = step(initState(base(), 0), ts, 1);
  assert.deepEqual(texts(r), ["m2|omniloop|t3 blocked (question): which db?"]);
  assert.equal(r.feed[0].entry.ts, 1);
  r = step(r.state, ts, 2);
  assert.deepEqual(r.feed, []);                                       // once across repeated steps
  r = step(r.state, ts, 3);
  assert.deepEqual(r.feed, []);
});

test("DW-2.1 feed: an alert for you is posted once", () => {
  const ts = put(base(), "t1", { status: { state: "blocked", kind: "question", msg: "ship it?" } });
  let r = step(initState(base(), 0), ts, 1);
  assert.deepEqual(texts(r), ["m2|omniloop|t1 (coordinator) blocked (question): ship it?"]);
  assert.deepEqual(step(r.state, ts, 2).feed, []);
});

test("DW-2.1 feed: a stall is posted once", () => {
  const s = initState(base(), 0);
  let r = step(s, base(), STALL_MS + 1);
  assert.ok(r.feed.some((f) => /t3 stalled, no progress for 20 min/.test(f.entry.text)));
  const n = r.feed.length;
  assert.equal(step(r.state, base(), STALL_MS + 2).feed.length, 0);
  assert.ok(n >= 1);
});

test("DW-2.1 feed: a due timer is posted once as 'timer for t3: …' in t3's loop, and still reaches pending", () => {
  const ts = base();
  const s = initState(ts, 0, { timers: [{ id: "a", at: 5, to: "t3", text: "check the build" }] });
  assert.deepEqual(step(s, ts, 4).feed, []);                          // not due yet
  const r = step(s, ts, 5);
  assert.deepEqual(texts(r), ["m2|omniloop|timer for t3: check the build"]);
  assert.deepEqual(step(r.state, ts, 6).feed, []);
});

test("DW-2.1 feed: an undeliverable note is posted (the parent became a shell)", () => {
  const ts = [T("t1", "working", L({ "omniloop.coordinator": "1" })), T("t2", null, L({ "omniloop.to": "t1" })), T("t3", "working", L({ "omniloop.to": "t2" }))];
  const s = initState(ts, 0);
  const r = step(s, put(ts, "t3", { status: { state: "done" } }), 1);
  assert.ok(r.actions.some((a) => a.type === "you" && a.alert.kind === "undeliverable"));
  assert.ok(texts(r).includes("m2|omniloop|for t2 (its parent isn't an agent now): t3 finished its turn"));
});

test("DW-2.1 feed: nothing for a remote agent, a remote loop, or a remote timer target; nothing at initState", () => {
  const remoteLoop = [
    T("m1/t1", "working", { omniloop: "x", "omniloop.coordinator": "1" }),
    T("m1/t2", "working", { omniloop: "x", "omniloop.to": "m1/t1" }),
  ];
  const s = initState(remoteLoop, 0, { timers: [{ id: "r", at: 1, to: "m1/t2", text: "x" }] });
  const r = step(s, put(put(remoteLoop, "m1/t2", { status: { state: "blocked", kind: "question" } }), "m1/t1", { status: { state: "blocked", kind: "question" } }), 2);
  assert.deepEqual(r.feed, []);
  // initState itself returns state only: no feed, and what is already true stays silent
  const blocked = put(base(), "t3", { status: { state: "blocked", kind: "question" } });
  assert.equal(initState(blocked, 0).feed, undefined);
  assert.deepEqual(step(initState(blocked, 0), blocked, 1).feed, []);
});

test("feed: a timer or note for a terminal outside any loop makes no feed entry", () => {
  const ts = [...base(), T("t9", "idle", {})];
  const r = step(initState(ts, 0, { timers: [{ id: "z", at: 1, to: "t9", text: "hi" }] }), ts, 2);
  assert.deepEqual(r.feed, []);
});

test("DW-2.2 a note: true timer reaches the agent without the timer: prefix, and makes no feed entry", () => {
  const ts = put(base(), "t1", { status: { state: "idle" } });
  const s = initState(ts, 0, { timers: [{ id: "n", at: 1, to: "t1", text: "you: hello", note: true }] });
  const r = step(s, ts, 2);
  assert.deepEqual(r.actions, [{ type: "send", to: "t1", text: "omniloop: you: hello", if: "idle" }]);
  assert.deepEqual(r.feed, []);
});

test("DW-2.2 a held reply and an agent note for the coordinator go out as one line joined by ' · '", () => {
  const ts = base();
  let s = initState(ts, 0, { timers: [{ id: "n", at: 1, to: "t1", text: "you: hello", note: true }] });
  let r = step(s, put(ts, "t2", { status: { state: "done" } }), 2);   // t1 is working: both held
  assert.deepEqual(r.actions, []);
  r = step(r.state, put(put(ts, "t2", { status: { state: "done" } }), "t1", { status: { state: "idle" } }), 3);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].text, "omniloop: t2 finished its turn · you: hello");
});

test("DW-2.6 a --loop scoped step leaves another loop's timer in state (so its file stays) and fires its own", () => {
  const other = [T("t7", "idle", { omniloop: "other", "omniloop.coordinator": "1" })];
  const ts = [...base(), ...other];
  const timers = [{ id: "mine", at: 1, to: "t3", text: "a" }, { id: "theirs", at: 1, to: "t7", text: "b" }];
  const s = initState(ts, 0, { loop: "m2", timers });
  const r = step(s, ts, 5, { loop: "m2" });
  assert.deepEqual(r.state.timers.map((t) => t.id), ["theirs"]);
  assert.deepEqual(texts(r), ["m2|omniloop|timer for t3: a"]);
  assert.ok(!r.actions.some((a) => a.to === "t7"));
  // unscoped, the same step does fire it
  assert.equal(step(initState(ts, 0, { timers }), ts, 5).state.timers.length, 0);
});

// ---- the watcher process, against a stub `hc events` (temp HOME and OMNILOOP_HOME; the real hc can't make terminals now) ----

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");
const term = (address, state, labels, extra = {}) => ({ address, state: "live", status: { state }, labels, turn: 1, created_ms: 0, ...extra });

/** Run `omniloop watch <args>` until its output matches `until` (or 8 s), then stop it. Returns { out, feed, timers }. */
async function watcher(t, args, { timers = [], until = /FEED|SEND|YOU/, settle = 400, cacheFiles = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "omniloop-watch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin"), cache = join(home, "cache"), loopDir = join(home, "loops", "X");
  await mkdir(bin, { recursive: true }); await mkdir(loopDir, { recursive: true }); await mkdir(join(cache, "timers"), { recursive: true });
  await writeFile(join(loopDir, "loop.json"), JSON.stringify({ id: "X", goal: "g", dirs: [], created_ms: 1 }));
  const terms = [term("t1", "working", { omniloop: "X", "omniloop.coordinator": "1" }), term("t2", "working", { omniloop: "X", "omniloop.to": "t1" }), term("t7", "idle", { omniloop: "Y", "omniloop.coordinator": "1" })];
  // after the watcher is ready, t2 blocks: its note goes to the working coordinator t1 (held), and the block is news for the feed
  const events = [[1500, { params: { terminal: "t2", type: "status", data: { status: { state: "blocked", kind: "question", msg: "which db?" } } } }]];
  await writeFile(join(bin, "cfg.json"), JSON.stringify({ terms, events }));
  await writeFile(join(bin, "hc"), `#!/usr/bin/env node
const cfg = JSON.parse(require("fs").readFileSync(${JSON.stringify(join(bin, "cfg.json"))}, "utf8")), a = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a[0] !== "events") process.exit(1);
out({ terminals: cfg.terms });
for (const [ms, ev] of cfg.events) setTimeout(() => out(ev), ms);
setInterval(() => {}, 1e6);
`);
  await chmod(join(bin, "hc"), 0o755);
  for (const [f, body] of Object.entries(cacheFiles)) await writeFile(join(cache, f), JSON.stringify(body));
  for (const tm of timers) await writeFile(join(cache, "timers", `${tm.id}.json`), JSON.stringify(tm));
  const env = { ...process.env, HOME: home, OMNILOOP_HOME: cache, PATH: `${bin}:${process.env.PATH}` };
  delete env.HC_TERMINAL_ID;
  const p = spawn("node", [BIN, "watch", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((r) => p.on("exit", r));
  for (let i = 0; i < 160 && !until.test(out) && p.exitCode == null; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, settle)); // let the ticks (and the 1.5 s block event) finish their file work
  p.kill(); await exited;
  const files = async (d) => (await readdir(d).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
  return { out, cache, feed: await readFile(join(loopDir, "feed.jsonl"), "utf8").catch(() => null), timers: await files(join(cache, "timers")) };
}
const timersFor = [{ id: "mine", at: 1, to: "t2", text: "check it" }, { id: "theirs", at: 1, to: "t7", text: "other loop's" }];

test("DW-2.4 watch --loop X --dry-run logs the feed lines it would post and posts none", async (t) => {
  const r = await watcher(t, ["--loop", "X", "--dry-run"]);
  console.log(r.out);                                                  // shown for the report
  assert.match(r.out, /watching loop X: 3 terminals \(dry run\)/);
  assert.match(r.out, /FEED X t2 blocked \(question\): which db\?/);
  assert.equal(r.feed, null);
});

test("watch --loop X (not a dry run) posts the block to X's feed once, as omniloop", async (t) => {
  const r = await watcher(t, ["--loop", "X"], { until: /watching/, settle: 2500 });
  const lines = (r.feed ?? "").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual({ from: lines[0].from, thread: lines[0].thread, text: lines[0].text }, { from: "omniloop", thread: null, text: "t2 blocked (question): which db?" });
});

test("DW-2.6 a --dry-run watcher (scoped or not) leaves every timer file in place", async (t) => {
  for (const args of [["--loop", "X", "--dry-run"], ["--dry-run"]]) {
    const r = await watcher(t, args, { timers: timersFor });
    assert.deepEqual(r.timers, ["mine.json", "theirs.json"], args.join(" "));
  }
});

test("DW-2.6 a --loop X watcher fires its own timer (file removed, feed line) and leaves loop Y's timer file", async (t) => {
  const r = await watcher(t, ["--loop", "X"], { timers: timersFor, until: /watching/, settle: 1000 });
  assert.deepEqual(r.timers, ["theirs.json"]);
  assert.match(r.feed ?? "", /timer for t2: check it/);
  assert.doesNotMatch(r.feed ?? "", /other loop/);
});

test("a --dry-run watcher keeps its own state file: a real watcher's state (pid, heartbeat) is never touched or created", async (t) => {
  const real = { pid: process.pid, heartbeat: 123, loop: "X", marker: "real" };
  for (const args of [["--loop", "X", "--dry-run"], ["--dry-run"]]) {
    const r = await watcher(t, args, { cacheFiles: { "state-X.json": real, "state.json": real } });
    for (const f of ["state-X.json", "state.json"]) assert.deepEqual(JSON.parse(await readFile(join(r.cache, f), "utf8")), real, `${args.join(" ")} ${f}`);
    const dry = JSON.parse(await readFile(join(r.cache, args.includes("--loop") ? "dry-X.json" : "dry.json"), "utf8"));
    assert.notEqual(dry.marker, "real");
    assert.ok(dry.pid > 0 && dry.heartbeat > 123);
  }
});

test("a dry-run watcher doesn't refuse to start because a real watcher is running, and a real one starts beside a dry one", async (t) => {
  const live = { pid: process.pid, heartbeat: Date.now(), loop: "X" };
  const r = await watcher(t, ["--loop", "X", "--dry-run"], { cacheFiles: { "state-X.json": live }, until: /watching|already/ });
  assert.match(r.out, /watching loop X/);
  const r2 = await watcher(t, ["--loop", "X"], { cacheFiles: { "dry-X.json": live }, until: /watching|already/ });
  assert.match(r2.out, /watching loop X/);
});

test("a done note carries the turn text, and is not queued for the parent when the agent already reported", () => {
  const done = put(base(), "t3", { status: { state: "done" } });
  // t2 (t3's parent) is idle, so a queued note would be sent at once.
  const idle2 = put(done, "t2", { status: { state: "idle" } });
  const rec = { startedAt: 10, endedAt: 20, text: "built the thing\n and tested it" };
  let r = step(initState(put(base(), "t2", { status: { state: "idle" } }), 0), idle2, 1, { turns: { t3: rec } });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].to, "t2");
  assert.match(r.actions[0].text, /t3.* finished its turn, last reply: «built the thing and tested it»/);
  // Same turn, but t3 already messaged t2 itself: nothing to say twice.
  r = step(initState(put(base(), "t2", { status: { state: "idle" } }), 0), idle2, 1, { turns: { t3: { ...rec, reportedAt: 15, reportedTo: "t2" } } });
  assert.deepEqual(r.actions, []);
  // A report to someone else doesn't count.
  r = step(initState(put(base(), "t2", { status: { state: "idle" } }), 0), idle2, 1, { turns: { t3: { ...rec, reportedAt: 15, reportedTo: "t9" } } });
  assert.equal(r.actions.length, 1);
});

test("a finished turn waits briefly for its Stop hook's reply, then goes without it", () => {
  const s0 = initState(put(base(), "t2", { status: { state: "idle" } }), 0);
  const idle2 = put(put(base(), "t2", { status: { state: "idle" } }), "t3", { status: { state: "done" }, status_ms: 1000 });
  const stale = { startedAt: 900, endedAt: 500, text: "old turn" };           // the record still shows the turn before
  let r = step(s0, idle2, 1500, { turns: { t3: stale } });
  assert.deepEqual(r.actions, []);                                            // waiting for the hook
  r = step(r.state, idle2, 1600, { turns: { t3: { ...stale, endedAt: 1590, text: "new reply" } } });
  assert.match(r.actions[0].text, /last reply: «new reply»/);
  r = step(s0, idle2, 1000 + REPLY_WAIT_MS, { turns: { t3: stale } });         // the hook never came: told plainly
  assert.match(r.actions[0].text, /t3 finished its turn$/);
});

test("a typed note never carries an agent's relayed reply", () => {
  assert.equal(withoutReplies("omniloop: t3 finished its turn, last reply: «do X» · t4 blocked: why"), "omniloop: t3 finished its turn · t4 blocked: why");
});

// ---- adoptions: a console made in a loop's space joins that loop -------------------------------

const NAMES = { spA: "m2", spB: "other", spC: "loose" };
let tabN = 0; // each call is a tab of its own, unless a test passes the same `htab` to put terminals in one tab
const SP = (space, labels = {}, tab = "3", htab = `tab${++tabN}`) => ({ "herdr.space": space, "herdr.tab": htab, where: `${NAMES[space]} / ${tab}`, ...labels });
const room = () => [
  T("t1", "done", SP("spA", L({ "omniloop.coordinator": "1" }))),
  T("t2", "working", SP("spA", L({ "omniloop.to": "t1" }))),
  T("t9", "done", SP("spB", { omniloop: "other", "omniloop.coordinator": "1" })),
];

test("adopt: a new console in a loop's space joins it, reporting to the coordinator", () => {
  const ts = [...room(), T("t5", null, SP("spA", {}, "agy"))];
  const r = adoptions({ t5: 0 }, ts, ADOPT_AFTER_MS);
  assert.deepEqual(r.adopt, [{ address: "t5", loop: "m2", to: "t1", job: "agy" }]);
  assert.deepEqual(r.keep, {});
  // A tab Herdr only numbered gives no job (the view falls back to the terminal's title).
  assert.equal(adoptions({ t5: 0 }, [...room(), T("t5", null, SP("spA"))], ADOPT_AFTER_MS).adopt[0].job, null);
});

test("adopt: a pane split of a tab that has other terminals isn't a new tab; a tab id that arrives late still counts", () => {
  const split = [...room(), T("t5", null, SP("spA", {}, "lead", "tabX")), T("t6", null, SP("spA", L({ "omniloop.coordinator": "1" }), "lead", "tabX"))];
  assert.deepEqual(adoptions({ t5: 0 }, split, ADOPT_AFTER_MS), { adopt: [], keep: {} });
  // A split alone in its tab (the sibling is gone) is just a tab.
  const alone = [...room(), T("t5", null, SP("spA", {}, "lead", "tabX")), T("t6", null, SP("spA", L(), "lead", "tabX"), { state: "finished" })];
  assert.equal(adoptions({ t5: 0 }, alone, ADOPT_AFTER_MS).adopt.length, 1);
  const noTab = { ...SP("spA", {}, "agy") }; delete noTab["herdr.tab"];
  assert.deepEqual(adoptions({ t5: 0 }, [...room(), T("t5", null, noTab)], ADOPT_AFTER_MS), { adopt: [], keep: { t5: 0 } });
});

test("whereOf splits on the first ' / ' (a tab name may contain one)", () => {
  assert.deepEqual(whereOf({ labels: { where: "m2 / fix a / b" } }), { space: "m2", tab: "fix a / b" });
  assert.deepEqual(whereOf({ labels: {} }), { space: null, tab: null });
});

test("adopt: waits a moment, so a terminal its maker labels right away is left alone", () => {
  const ts = [...room(), T("t5", null, SP("spA"))];
  assert.deepEqual(adoptions({ t5: 0 }, ts, ADOPT_AFTER_MS - 1), { adopt: [], keep: { t5: 0 } });
  const labelled = [...room(), T("t5", null, SP("spA", L({ "omniloop.coordinator": "1" })))];
  assert.deepEqual(adoptions({ t5: 0 }, labelled, ADOPT_AFTER_MS), { adopt: [], keep: {} });
});

test("adopt: only the loop's own space (named after it), not a space its agents merely sit in", () => {
  const borrowed = [T("t1", "done", { "herdr.space": "spP", where: "plenary / 1", omniloop: "m2", "omniloop.coordinator": "1" }),
    T("t5", null, { "herdr.space": "spP", "herdr.tab": "tabP5", where: "plenary / 5" })];
  assert.deepEqual(adoptions({ t5: 0 }, borrowed, ADOPT_AFTER_MS), { adopt: [], keep: {} });
});

test("adopt: a space label that arrives late still counts; a console that never gets one is dropped", () => {
  const bare = [...room(), T("t5", null, {})];
  assert.deepEqual(adoptions({ t5: 0 }, bare, ADOPT_AFTER_MS), { adopt: [], keep: { t5: 0 } });
  assert.deepEqual(adoptions({ t5: 0 }, bare, ADOPT_WITHIN_MS + 1), { adopt: [], keep: {} });
});

test("adopt: no loop, two loops, another machine, a subagent or a finished console: left alone", () => {
  const none = [...room(), T("t5", null, SP("spC"))];
  assert.deepEqual(adoptions({ t5: 0 }, none, ADOPT_AFTER_MS).adopt, []);
  const mixed = [...room(), T("t8", "done", SP("spA", { omniloop: "other" })), T("t5", null, SP("spA"))];
  assert.deepEqual(adoptions({ t5: 0 }, mixed, ADOPT_AFTER_MS), { adopt: [], keep: {} });
  const remote = [...room(), T("m1/t5", null, SP("spA"))];
  assert.deepEqual(adoptions({ "m1/t5": 0 }, remote, ADOPT_AFTER_MS).adopt, []);
  const subagent = [...room(), T("t5", null, SP("spA"), { parent: "t1" })];
  assert.deepEqual(adoptions({ t5: 0 }, subagent, ADOPT_AFTER_MS).adopt, []);
  const gone = [...room(), T("t5", null, SP("spA"), { state: "finished" })];
  assert.deepEqual(adoptions({ t5: 0 }, gone, ADOPT_AFTER_MS).adopt, []);
});

test("adopt: a loop with no coordinator (you coordinate it) adopts with no parent; retired agents don't claim a space", () => {
  const nocoordinator = [T("t2", "done", SP("spA", L())), T("t5", null, SP("spA"))];
  assert.deepEqual(adoptions({ t5: 0 }, nocoordinator, ADOPT_AFTER_MS).adopt, [{ address: "t5", loop: "m2", to: null, job: null }]);
  const retired = [T("t2", "done", SP("spA", L({ "omniloop.retired": "t3" }))), T("t5", null, SP("spA"))];
  assert.deepEqual(adoptions({ t5: 0 }, retired, ADOPT_AFTER_MS).adopt, []);
});

test("a finished turn reaches the parent only when it was work given to it, and when unsure", async () => {
  const { worthTelling, ADOPTED } = await import("../core/watch.js");
  const idle2 = put(put(base(), "t2", { status: { state: "idle" } }), "t3", { status: { state: "done" } });
  const s0 = () => initState(put(base(), "t2", { status: { state: "idle" } }), 0);
  const rec = (given, first = false) => ({ startedAt: 10, endedAt: 20, text: "reply", given, first });
  const sent = (r, ts = idle2) => step(s0(), ts, 1, { turns: { t3: r } }).actions.filter((a) => a.type === "send").length;
  const adopted = put(idle2, "t3", { labels: { ...idle2[2].labels, [ADOPTED]: "1" } });
  assert.equal(sent(rec({ you: false, from: ["t2"] })), 1);                 // its parent asked (message or hc send)
  assert.equal(sent(rec({ you: true, from: ["t2"] })), 1);                  // its parent asked, then a person added a line
  assert.equal(sent(rec({ you: false, from: ["omniloop"] })), 1);           // a watcher note or timer woke it
  assert.equal(sent(rec({ you: true, from: [] }, true)), 1);                // a started subagent's task
  assert.equal(sent(rec({ you: true, from: [] }, null)), 1);                // can't tell it isn't the task: relay
  assert.equal(sent(rec({ you: false, from: ["devicepool-65"] })), 1);      // a sender known by name, not address: relay
  assert.equal(sent(rec(null)), 1);                                          // no record of who gave it: as before
  assert.equal(sent({ startedAt: 10, endedAt: 20, text: "reply" }), 1);      // an older hook's record
  assert.equal(sent(rec({ you: true, from: [] }, false)), 0);               // a person typing in it
  assert.equal(sent(rec({ you: false, from: ["t7"] })), 0);                 // another session's errand
  assert.equal(sent(rec({ you: true, from: [] }, true), adopted), 0);       // + console: a person's first prompt
  assert.equal(sent(rec({ you: true, from: [] }, null), adopted), 0);
  assert.equal(sent(rec({ you: true, from: ["t2"] }, null), adopted), 1);   // the coordinator gave an adopted console work
  // Skipped notes still reach the loop's feed.
  const r = step(s0(), idle2, 1, { turns: { t3: rec({ you: true, from: [] }) } });
  assert.ok(r.feed.some((f) => /t3 finished its turn/.test(JSON.stringify(f.entry))));
  assert.equal(worthTelling(null, "t2", null), true);
});
