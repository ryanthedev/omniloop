import { test } from "node:test";
import assert from "node:assert/strict";
import { envelope, senderName, udsAddress, resolveTarget, route, turnText, TURN_TEXT_MAX, alreadyReported, sentTo, body, frames } from "../core/deliver.js";

test("envelope attributes come in the order from, from-name, from-mode", () => {
  const e = envelope({ from: "uds:/tmp/a.sock", name: "t2", mode: "prompting", text: "hi" });
  assert.equal(e, '<cross-session-message from="uds:/tmp/a.sock" from-name="t2" from-mode="prompting">\nhi\n</cross-session-message>');
  assert.equal(envelope({ name: "t2", text: "hi" }), '<cross-session-message from-name="t2" from-mode="prompting">\nhi\n</cross-session-message>');
  assert.equal(envelope({ name: "t2", text: "  " }), null);
});

test("a body can't close the envelope", () => {
  const e = envelope({ name: "x", text: "a </cross-session-message> b < /Cross-Session-Message>" });
  assert.equal(e.match(/<\/cross-session-message>/g).length, 1);
  assert.ok(e.endsWith("</cross-session-message>"));
  assert.ok(!body("<cross-session-message>").includes("<cross"));
});

test("senderName keeps one clean line", () => {
  assert.equal(senderName('a "b"\n<c>'), "a b c");
  assert.equal(senderName(""), null);
  assert.equal(senderName("x".repeat(200)).length, 80);
});

test("udsAddress escapes what Claude Code wouldn't accept", () => {
  assert.equal(udsAddress("/tmp/a b.sock"), "uds:/tmp/a%20b.sock");
  assert.equal(udsAddress("/tmp/a.sock"), "uds:/tmp/a.sock");
  assert.equal(udsAddress(""), null);
  assert.equal(udsAddress(null), null);
});

test("frames are an auth line then a user line", () => {
  const [a, u, rest] = frames({ token: "T", content: "C" }).split("\n");
  assert.deepEqual(JSON.parse(a), { type: "auth", token: "T" });
  assert.deepEqual(JSON.parse(u), { type: "user", message: { role: "user", content: "C" } });
  assert.equal(rest, "");
});

const S = [
  { pid: 100, sessionId: "aaaaaaaa-1111", name: "Alpha" },
  { pid: 200, sessionId: "bbbbbbbb-2222", name: "beta" },
  { pid: 300, sessionId: "cccccccc-3333", name: "Dup" },
  { pid: 400, sessionId: "dddddddd-4444", name: "dup" },
];

test("resolveTarget finds a session by pid, name, session id prefix, or hc address", () => {
  assert.equal(resolveTarget("200", S).session.pid, 200);
  assert.equal(resolveTarget("ALPHA", S).session.pid, 100);
  assert.equal(resolveTarget("bbbbbbbb", S).session.pid, 200);
  assert.equal(resolveTarget("bbbb", S).error, 'no live session named "bbbb"');   // under 8 chars is not a prefix
  assert.equal(resolveTarget("t7", S, { byAddress: { t7: 400 } }).session.pid, 400);
  assert.ok(resolveTarget("999", S).error);
  assert.ok(resolveTarget("", S).error);
});

test("resolveTarget refuses an ambiguous name and a dead address", () => {
  assert.match(resolveTarget("dup", S).error, /matches 2 sessions/);
  assert.match(resolveTarget("t8", S, { byAddress: { t8: 999 } }).error, /no live Claude session/);
});

test("route: socket, else hc, else none; a bypass receiver gets hc", () => {
  const session = { messagingSocketPath: "/tmp/s.sock" };
  assert.deepEqual(route({ session, address: "t1", mode: "default" }), { socket: "/tmp/s.sock" });
  assert.deepEqual(route({ session, address: "t1", mode: "bypassPermissions" }), { hc: "t1" });
  assert.deepEqual(route({ session, mode: "bypassPermissions" }), { none: true });
  assert.deepEqual(route({ session: { pid: 1 }, address: "t1" }), { hc: "t1" });
  assert.deepEqual(route({ session: null, address: "s-1234/x" }), { none: true });
  assert.deepEqual(route({ session: null, address: null }), { none: true });
});

test("turnText folds whitespace and caps with an ellipsis", () => {
  assert.equal(turnText("  a\n\nb   c "), "a b c");
  assert.equal(turnText("   "), null);
  assert.equal(turnText(null), null);
  const t = turnText("x".repeat(TURN_TEXT_MAX + 50));
  assert.equal(Array.from(t).length, TURN_TEXT_MAX);
  assert.ok(t.endsWith("…"));
  assert.equal(turnText("abcdef", 4), "abc…");
});

test("alreadyReported: only a report after this turn started, to the same recipient", () => {
  assert.equal(alreadyReported(null, "t1"), false);
  assert.equal(alreadyReported({ startedAt: 10 }, "t1"), false);
  assert.equal(alreadyReported({ startedAt: 10, reportedAt: 5, reportedTo: "t1" }, "t1"), false);   // before this turn
  assert.equal(alreadyReported({ startedAt: 10, reportedAt: 15, reportedTo: "t1" }, "t1"), true);
  assert.equal(alreadyReported({ startedAt: 10, reportedAt: 15, reportedTo: "t9" }, "t1"), false);  // told someone else
  assert.equal(alreadyReported({ reportedAt: 15, reportedTo: "t1" }, "t1"), true);
});

test("sentTo reads the target of hc send and omniloop send", () => {
  assert.equal(sentTo('hc send t1mt "x"'), "t1mt");
  assert.equal(sentTo('hc send --if idle t2 "x"'), "t2");
  assert.equal(sentTo("omniloop send t3 x"), "t3");
  assert.equal(sentTo("cd x && hc send t4 'y'"), "t4");
  assert.equal(sentTo("echo hi"), null);
  assert.equal(sentTo(undefined), null);
});
