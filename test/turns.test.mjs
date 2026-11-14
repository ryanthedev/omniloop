import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { safeAddress, addressOf, pidOf, sessionRecord, turnStart, turnEnd, turnReport, givenBy, TEXT_MAX } from "../core/turns.js";
import { writeFileSync } from "node:fs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "session-hook.mjs");

test("safeAddress rejects anything that isn't a plain file name", () => {
  assert.equal(safeAddress("t1mt"), "t1mt");
  for (const bad of ["", null, "a/b", "..", "a..b", "a\\b"]) assert.equal(safeAddress(bad), null);
});

test("addressOf: the herdr terminal, else s- plus 8 chars of the session id", () => {
  assert.equal(addressOf({ HC_TERMINAL_ID: "t9" }, "abcdef0123"), "t9");
  assert.equal(addressOf({}, "abcdef0123"), "s-abcdef01");
  assert.equal(addressOf({ HC_TERMINAL_ID: "../x" }, "abcdef0123"), "s-abcdef01");
  assert.equal(addressOf({}, undefined), null);
});

test("pidOf: CLAUDE_PID, else the parent", () => {
  assert.equal(pidOf({ CLAUDE_PID: "77" }, 5), 77);
  assert.equal(pidOf({}, 5), 5);
  assert.equal(pidOf({ CLAUDE_PID: "x" }, 5), 5);
});

const ctx = (input, now = 100) => ({ address: "t9", pid: 42, input, now });

test("sessionRecord keeps the previous mode when the event has none (same session only)", () => {
  const i = { session_id: "s1", cwd: "/w" };
  assert.deepEqual(sessionRecord({ sessionId: "s1", mode: "plan" }, ctx(i)), { address: "t9", pid: 42, sessionId: "s1", mode: "plan", cwd: "/w", at: 100 });
  assert.equal(sessionRecord(null, ctx(i)).mode, null);
  assert.equal(sessionRecord({ mode: "plan" }, ctx({ ...i, permission_mode: "default" })).mode, "default");
});

test("turnStart keeps fields, sets startedAt, clears the report", () => {
  const r = turnStart({ text: "old", endedAt: 50, reportedAt: 60, reportedTo: "t1" }, ctx({ session_id: "s1", permission_mode: "default" }));
  assert.deepEqual(r, { text: "old", endedAt: 50, address: "t9", pid: 42, sessionId: "s1", mode: "default", startedAt: 100 });
});

test("turnEnd sets endedAt and the capped text", () => {
  const r = turnEnd({ startedAt: 90 }, ctx({ session_id: "s1", permission_mode: "plan", last_assistant_message: "x".repeat(TEXT_MAX + 10) }));
  assert.equal(r.endedAt, 100);
  assert.equal(r.startedAt, 90);
  assert.equal(r.text.length, TEXT_MAX);
  assert.equal(r.mode, "plan");
});

test("turnReport marks a Bash send and ignores everything else", () => {
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(turnReport({ startedAt: 1 }, ctx(bash("hc send t1 hi"))), { startedAt: 1, reportedAt: 100, reportedTo: "t1" });
  assert.equal(turnReport({}, ctx(bash("ls"))), null);
  assert.equal(turnReport({}, ctx({ tool_name: "Read", tool_input: { command: "hc send t1 hi" } })), null);
});

test("bin/session-hook.mjs writes the session and turn records over a turn", () => {
  const home = mkdtempSync(join(tmpdir(), "omniloop-hook-"));
  try {
    const run = (input) => spawnSync("node", [HOOK], { input: JSON.stringify(input), env: { ...process.env, OMNILOOP_HOME: home, HC_TERMINAL_ID: "t9", CLAUDE_PID: "4242" }, encoding: "utf8" });
    const turn = () => JSON.parse(readFileSync(join(home, "turns", "t9.json"), "utf8"));
    const base = { session_id: "abcdef0123456789", cwd: "/w", permission_mode: "default" };
    let r = run({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" });
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
    const sess = JSON.parse(readFileSync(join(home, "sessions", "t9.json"), "utf8"));
    assert.equal(sess.address, "t9"); assert.equal(sess.pid, 4242); assert.equal(sess.mode, "default"); assert.equal(sess.cwd, "/w");
    const started = turn().startedAt;
    assert.ok(started > 0);
    run({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "hc send t1 hi" } });
    assert.equal(turn().reportedTo, "t1");
    assert.ok(turn().reportedAt >= started);
    run({ ...base, hook_event_name: "Stop", last_assistant_message: "all done" });
    const t = turn();
    assert.equal(t.text, "all done"); assert.equal(t.reportedTo, "t1");
    assert.equal(t.sessionId, base.session_id); assert.equal(t.pid, 4242); assert.equal(t.address, "t9");
    assert.ok(t.endedAt >= t.startedAt);
    assert.deepEqual(readdirSync(join(home, "turns")), ["t9.json"]);   // no tmp files left
    // Garbage in: still exit 0, nothing thrown.
    assert.equal(spawnSync("node", [HOOK], { input: "not json", env: { ...process.env, OMNILOOP_HOME: home } }).status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("review fixes: no reply carried over, mode not inherited across sessions, nested claude can't take the address", async () => {
  const { turnEnd, sessionRecord, foreign } = await import("../core/turns.js");
  const ctx = (input) => ({ address: "t9", pid: 2, input, now: 5 });
  assert.equal(turnEnd({ text: "old" }, ctx({ session_id: "a" })).text, null);
  assert.equal(sessionRecord({ sessionId: "a", mode: "bypassPermissions" }, ctx({ session_id: "b" })).mode, null);
  assert.equal(sessionRecord({ sessionId: "a", mode: "bypassPermissions" }, ctx({ session_id: "a" })).mode, "bypassPermissions");
  assert.equal(foreign({ sessionId: "a", pid: 1 }, ctx({ session_id: "b" }), () => true), true);
  assert.equal(foreign({ sessionId: "a", pid: 1 }, ctx({ session_id: "b" }), () => false), false);
  assert.equal(foreign({ sessionId: "a", pid: 1 }, ctx({ session_id: "a" }), () => true), false);
});

// Transcript entries shaped like Claude Code's (seen 2026-11-13): a peer message and a typed prompt.
const peer = (name) => ({ type: "user", isMeta: true, promptSource: "system", origin: { kind: "peer", from: "unknown", name }, message: { role: "user", content: "Another Claude session sent a message: <cross-session-message>…" } });
const typed = (text) => ({ type: "user", promptSource: "typed", origin: { kind: "human" }, message: { role: "user", content: text } });
const toolResult = { type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } };

const at = (e, ms) => ({ ...e, timestamp: new Date(ms).toISOString() });

test("givenBy: every prompt since the previous turn ended", () => {
  assert.deepEqual(givenBy([typed("hi"), peer("t1mb")]), { you: true, from: ["t1mb"] });
  assert.deepEqual(givenBy([at(peer("t1mb"), 1000), at(typed("can you check?"), 3000)], 2000), { you: true, from: [] });
  // The lead's task, then a person's line mid-turn: both count (the lead's is not hidden).
  assert.deepEqual(givenBy([at(peer("t1mb"), 3000), at(typed("also this"), 4000)], 2000), { you: true, from: ["t1mb"] });
  assert.deepEqual(givenBy([typed('<hc from="t11">read the brief</hc>')]), { you: false, from: ["t11"] });
  assert.deepEqual(givenBy([typed("omniloop: t1mc finished its turn")]), { you: false, from: ["omniloop"] });
  assert.deepEqual(givenBy([{ type: "user", origin: { kind: "human" }, message: { content: [{ type: "text", text: '<hc from="t2">x</hc>' }] } }]), { you: false, from: ["t2"] });
  assert.deepEqual(givenBy([typed("go"), toolResult, { type: "assistant" }]), { you: true, from: [] });
  assert.equal(givenBy([{ type: "assistant" }, toolResult]), null);
  assert.equal(givenBy([at(typed("old"), 1000)], 2000), null);   // nothing in this turn: unknown
  assert.equal(givenBy([]), null);
});

test("turnEnd: first is the session's first turn; an older record can't say", () => {
  const c = (sid) => ({ ...ctx({ session_id: sid, last_assistant_message: "x" }), entries: [] });
  assert.equal(turnEnd(null, c("s1")).first, true);
  assert.equal(turnEnd({ startedAt: 1 }, c("s1")).first, true);
  const one = turnEnd(null, c("s1"));
  assert.equal(turnEnd(one, c("s1")).first, false);
  assert.equal(turnEnd(one, c("s2")).first, true);                 // a new session at the address
  assert.equal(turnEnd({ endedAt: 50, sessionId: "s1" }, c("s1")).first, null);   // written before this existed
});

test("the Stop hook records who gave the turn from the transcript", () => {
  const home = mkdtempSync(join(tmpdir(), "omniloop-hook-"));
  try {
    const tr = join(home, "t.jsonl");
    writeFileSync(tr, [typed("task"), { type: "assistant" }, peer("t1mb")].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const run = (input) => spawnSync("node", [HOOK], { input: JSON.stringify(input), env: { ...process.env, OMNILOOP_HOME: home, HC_TERMINAL_ID: "t9", CLAUDE_PID: "4242" }, encoding: "utf8" });
    const base = { session_id: "abcdef0123456789", cwd: "/w", transcript_path: tr };
    run({ ...base, hook_event_name: "UserPromptSubmit", prompt: "x" });
    run({ ...base, hook_event_name: "Stop", last_assistant_message: "done" });
    const t = JSON.parse(readFileSync(join(home, "turns", "t9.json"), "utf8"));
    assert.deepEqual(t.given, { you: true, from: ["t1mb"] }); assert.equal(t.first, true);
    run({ ...base, transcript_path: join(home, "missing.jsonl"), hook_event_name: "Stop", last_assistant_message: "d" });
    const t2 = JSON.parse(readFileSync(join(home, "turns", "t9.json"), "utf8"));
    assert.equal(t2.given, null); assert.equal(t2.first, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
