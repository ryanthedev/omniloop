import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView, watcherOf } from "../core/view.js";

const T = (address, status, labels = {}, extra = {}) => ({ address, state: "live", status, labels, created_ms: 0, ...extra });

const ts = [
  T("t1", "working", { omniloop: "m2", "omniloop.lead": "1", "omniloop.goal": "Ship M2" }),
  T("t2", "working", { omniloop: "m2", "omniloop.to": "t1", "omniloop.job": "manager parser" }),
  T("t3", "blocked", { omniloop: "m2", "omniloop.to": "t2" }, { title: "builder" }),
  T("t4", "idle", { omniloop: "m2" }),
  T("s1", "blocked", { omniloop: "solo" }),
  T("x9", "working", {}),
  T("x8", null, {}),
];

test("loops in tree order, members with no parent under the lead, loops that need you first", () => {
  const v = buildView(ts, null, 0);
  assert.deepEqual(v.loops.map((l) => [l.id, l.needsYou, l.handling]), [["solo", 1, 0], ["m2", 0, 1]]);
  const m2 = v.loops[1];
  assert.deepEqual(m2.rows.map((r) => [r.address, r.depth, r.name]), [["t1", 0, "t1"], ["t2", 1, "manager parser"], ["t3", 2, "builder"], ["t4", 1, "t4"]]);
  assert.equal(v.loops[0].rows[0].forYou, "you lead this loop");
  assert.equal(v.loose, 1);
});

test("the watcher is running only with a fresh heartbeat, and its stalls show", () => {
  assert.equal(watcherOf(null, 0).running, false);
  assert.equal(watcherOf({ heartbeat: 0 }, 60_000).running, false);
  const w = { heartbeat: 1000, you: [{ address: "t1", to: "you", kind: "stalled", why: "no progress for 20 min" }] };
  const v = buildView(ts, w, 2000);
  assert.equal(v.watcher.running, true);
  assert.equal(v.loops.find((l) => l.id === "m2").rows[0].forYou, "stalled");
});

test("loops rank by when you last interacted with any member; times show only on agents that report to you", () => {
  const now = 10 * 3600_000;
  const v = buildView(ts, { heartbeat: now, withYou: { t3: now - 5 * 60_000 } }, now, { t1: now - 2 * 3600_000 });
  assert.deepEqual(v.loops.map((l) => [l.id, l.ago]), [["m2", "5m"], ["solo", null]]);
  const rows = Object.fromEntries(v.loops[0].rows.map((r) => [r.address, r.ago]));
  assert.deepEqual(rows, { t1: "2h", t2: null, t3: null, t4: null });   // only the lead reports to you
  assert.equal(v.loops[1].rows[0].reportsToYou, true);                    // no lead: you lead, so it reports to you
});

test("ago", async () => {
  const { ago } = await import("../core/view.js");
  assert.equal(ago(null, 0), null);
  assert.equal(ago(0, 30_000), "now");
  assert.equal(ago(0, 90 * 60_000), "1h");
  assert.equal(ago(0, 49 * 3600_000), "2d");
});

test("loopTabs: the focused terminal's loop, across spaces, lead first; another machine's same id is its own loop", async () => {
  const { loopTabs } = await import("../core/view.js");
  const ts2 = [...ts, T("m1/t7", "working", { omniloop: "m2", "omniloop.lead": "1", "omniloop.job": "remote builder" }),
    T("m1/t8", "working", { omniloop: "m2", "omniloop.to": "t7" })];
  const r = loopTabs(ts2, "t3");
  assert.equal(r.loop, "m2");
  assert.deepEqual(r.tabs.map((x) => [x.address, x.isLead, x.active, x.machine]),
    [["t1", true, false, null], ["t2", false, false, null], ["t3", false, true, null], ["t4", false, false, null]]);
  const rr = loopTabs(ts2, "m1/t8");
  assert.equal(rr.loop, "m1/m2");
  assert.deepEqual(rr.tabs.map((x) => [x.address, x.isLead, x.machine]), [["m1/t7", true, "m1"], ["m1/t8", false, "m1"]]);
  assert.equal(loopTabs(ts2, "x9"), null);                 // a terminal in no loop: the space's own tabs
  assert.equal(loopTabs(ts2, null, "solo").loop, "solo");  // focus in a mod: keep the loop shown last
  assert.equal(loopTabs(ts2, null, null), null);
});

test("whoIs: id, agent name, loop, parent", async () => {
  const { whoIs, cleanTitle } = await import("../core/view.js");
  const w = whoIs(ts, "t3", { now: 0 });
  assert.deepEqual([w.address, w.name, w.loop, w.goal, w.lead, w.parent, w.parentName, w.reportsToYou], ["t3", "builder", "m2", "Ship M2", "t1", "t2", "manager parser", false]);
  assert.equal(whoIs(ts, "t1").isLead, true);
  assert.equal(whoIs(ts, "x9").loop, null);
  assert.equal(whoIs(ts, "nope"), null);
  assert.equal(cleanTitle("✳ Fix login"), "Fix login");
  assert.equal(cleanTitle("user@host:~/repos/x"), null);
});
