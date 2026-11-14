// The pure half of the backend port (core/backend.js): selection, identity, addresses, the draft-wait emulation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backendName, selfId, isPaneId, looksLikeAddress, clipBytes, hasDraft, waitForNoDraft } from "../core/backend.js";
import { addressOf } from "../core/turns.js";

test("backendName: herdr by default; omni when OMNI_PANE is set and HC_TERMINAL_ID is not; OMNILOOP_BACKEND wins", () => {
  assert.equal(backendName({}), "herdr");
  assert.equal(backendName({ HC_TERMINAL_ID: "t1" }), "herdr");
  const up = () => true, down = () => false;
  assert.equal(backendName({ OMNI_PANE: "pn_A" }, up), "omni");
  assert.equal(backendName({ OMNI_PANE: "pn_A" }, down), "herdr", "a stale OMNI_PANE with no reachable daemon stays herdr");
  assert.equal(backendName({ OMNI_PANE: "pn_A" }), "herdr", "no probe: never auto-select");
  assert.equal(backendName({ OMNI_PANE: "pn_A", HC_TERMINAL_ID: "" }, up), "omni", "an empty HC_TERMINAL_ID is unset");
  assert.equal(backendName({ OMNILOOP_BACKEND: "omni", OMNI_PANE: "pn_A" }, down), "omni", "explicit omni forces it");
  assert.equal(backendName({ OMNI_PANE: "pn_A", HC_TERMINAL_ID: "t1" }), "herdr", "both set: herdr, as before");
  assert.equal(backendName({ OMNILOOP_BACKEND: "omni" }), "omni");
  assert.equal(backendName({ OMNILOOP_BACKEND: "HERDR", OMNI_PANE: "pn_A" }), "herdr");
  assert.throws(() => backendName({ OMNILOOP_BACKEND: "tmux" }), /expected one of herdr, omni/);
});

test("selfId: HC_TERMINAL_ID or OMNI_PANE, the named backend's first", () => {
  assert.equal(selfId({}), null);
  assert.equal(selfId({ HC_TERMINAL_ID: "t3" }), "t3");
  assert.equal(selfId({ OMNI_PANE: "pn_X" }), "pn_X");
  assert.equal(selfId({ HC_TERMINAL_ID: "t3", OMNI_PANE: "pn_X" }), "t3");
  assert.equal(selfId({ HC_TERMINAL_ID: "t3", OMNI_PANE: "pn_X" }, "omni"), "pn_X");
  assert.equal(selfId({ HC_TERMINAL_ID: "t3" }, "omni"), "t3");
  assert.equal(selfId({ HC_TERMINAL_ID: "", OMNI_PANE: "" }), null);
  assert.equal(selfId({ HC_TERMINAL_ID: "t3", OMNI_PANE: "pn_X", OMNILOOP_BACKEND: "omni" }), "pn_X", "a forced backend decides");
  assert.equal(selfId({ HC_TERMINAL_ID: "t3", OMNI_PANE: "pn_X", OMNILOOP_BACKEND: "herdr" }), "t3");
});

test("turns.addressOf keys a session by OMNI_PANE too", () => {
  assert.equal(addressOf({ OMNI_PANE: "pn_01HZ" }, "sess"), "pn_01HZ");
  assert.equal(addressOf({ HC_TERMINAL_ID: "t2", OMNI_PANE: "pn_01HZ" }, "sess"), "t2");
  assert.equal(addressOf({}, "abcdef123456"), "s-abcdef12");
});

test("looksLikeAddress accepts herdr ids and pn_ ids; isPaneId is stricter", () => {
  for (const a of ["t7", "t1g9", "coordinator"]) assert.ok(looksLikeAddress(a), a);
  assert.ok(looksLikeAddress("pn_01HZXK3Q9V4M2N8T6R5W7Y0ABC"));
  for (const a of ["", null, "m1/t7", "123", "pn_", "pn-x", "a b"]) assert.ok(!looksLikeAddress(a), String(a));
  assert.ok(isPaneId("t7") && isPaneId("pn_01HZXK3Q9V4M2N8T6R5W7Y0ABC"));
  assert.ok(!isPaneId("coordinator") && !isPaneId("pn_") && !isPaneId("m1/t7"));
});

test("clipBytes cuts on a character boundary", () => {
  assert.equal(clipBytes("abc", 10), "abc");
  assert.equal(clipBytes("abcdef", 3), "abc");
  assert.equal(clipBytes("é".repeat(5), 5), "éé");
  assert.equal(Buffer.byteLength(clipBytes("日本語日本語", 7)), 6);
});

test("hasDraft: text after the prompt marker is a draft; an empty prompt, the placeholder and no prompt are not", () => {
  assert.equal(hasDraft("working...\n╭────╮\n│ > fix the bu │\n╰────╯"), true);
  assert.equal(hasDraft("done\n❯ half a sentence"), true);
  assert.equal(hasDraft("done\n│ > │\n"), false);
  assert.equal(hasDraft("done\n❯ \n"), false);
  assert.equal(hasDraft('❯ Try "how do I build this?"'), false);
  assert.equal(hasDraft("$ ls\nfile\n"), false);
  assert.equal(hasDraft(""), false);
  assert.equal(hasDraft("\x1b[2m❯\x1b[0m typed words"), true);
  assert.equal(hasDraft("❯ old draft\n" + "x\n".repeat(20)), false, "only the last lines count");
});

function clock() { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; }

test("waitForNoDraft: no draft returns at once without sleeping", async () => {
  const c = clock();
  const r = await waitForNoDraft({ read: async () => "❯ ", ...c });
  assert.deepEqual(r, { waitedMs: 0, gaveUp: false });
});

test("waitForNoDraft: waits while a draft shows, returns when it is gone (fake clock, no real sleeping)", async () => {
  const c = clock(), screens = ["❯ typing", "❯ typing", "❯ "];
  let n = 0;
  const r = await waitForNoDraft({ read: async () => screens[Math.min(n++, 2)], ...c, pollMs: 1000 });
  assert.deepEqual(r, { waitedMs: 2000, gaveUp: false });
  assert.equal(n, 3);
});

test("waitForNoDraft: a draft that never goes gives up after maxMs (then the caller types anyway); maxMs 0 disables", async () => {
  const c = clock();
  const r = await waitForNoDraft({ read: async () => "❯ still here", ...c, maxMs: 5500, pollMs: 2000 });
  assert.deepEqual(r, { waitedMs: 5500, gaveUp: true });
  let reads = 0;
  assert.deepEqual(await waitForNoDraft({ read: async () => (reads++, "❯ x"), ...clock(), maxMs: 0 }), { waitedMs: 0, gaveUp: false });
  assert.equal(reads, 0);
});

test("waitForNoDraft: a failing read counts as no draft", async () => {
  const r = await waitForNoDraft({ read: async () => { throw new Error("no pane"); }, ...clock() });
  assert.equal(r.gaveUp, false);
});
