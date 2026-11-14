import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loopKey, COORDINATOR_KEYS, isCoordinatorLabeled,
  buildLoops, route, alerts, newForYou, trackBlocked, loopView, qualify, ESCALATE_MS, forYouKind, forYouCounts, forYouLabel,
} from "../core/omniloop.js";

const T = (address, status, labels = {}, created_ms = 0) => ({ address, status, labels, created_ms });
const loop = (id, extra = {}) => ({ omniloop: id, ...extra });

// A loop: coordinator t1, manager t2 under it, builder t3 under t2, verifier t4 with no parent.
const team = () => [
  T("t1", "working", loop("m2", { "omniloop.coordinator": "1", "omniloop.goal": "Ship Plenary M2" }), 1),
  T("t2", "working", loop("m2", { "omniloop.to": "t1" }), 2),
  T("t3", "working", loop("m2", { "omniloop.to": "t2" }), 3),
  T("t4", "working", loop("m2"), 4),
];
const set = (ts, address, status, labels) =>
  ts.map((t) => t.address === address ? { ...t, status, labels: { ...t.labels, ...labels } } : t);
const only = (ts, address, opts) => {
  const { loops } = buildLoops(ts);
  return route(loops[0], address, opts);
};

test("groups by loop id across spaces; terminals with no loop are loose", () => {
  const { loops, loose } = buildLoops([...team(), T("t9", "idle")]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].coordinator, "t1");
  assert.equal(loops[0].goal, "Ship Plenary M2");
  assert.deepEqual(loops[0].roots, ["t1", "t4"]);
  assert.deepEqual(loose.map((t) => t.address), ["t9"]);
});

test("a blocked agent goes to its parent, not you", () => {
  assert.deepEqual(only(set(team(), "t3", "blocked"), "t3"), { to: "t2", kind: "blocked", why: "its parent" });
});

test("an agent with no parent goes to the coordinator", () => {
  assert.deepEqual(only(set(team(), "t4", "blocked"), "t4"), { to: "t1", kind: "blocked", why: "the coordinator" });
});

test("a blocked parent passes it further up", () => {
  const ts = set(set(team(), "t3", "blocked"), "t2", "blocked");
  assert.equal(only(ts, "t3").to, "t1");
});

test("the coordinator reaches you", () => {
  assert.equal(only(set(team(), "t1", "blocked"), "t1").to, "you");
  assert.equal(only(set(team(), "t1", "done"), "t1").to, "you");
});

test("an agent's done is its parent's news", () => {
  assert.equal(only(set(team(), "t3", "done"), "t3").to, "t2");
});

test("no coordinator: you coordinate, every block reaches you", () => {
  const ts = [T("a", "blocked", loop("solo")), T("b", "working", loop("solo", { "omniloop.to": "a" }))];
  assert.deepEqual(only(ts, "a"), { to: "you", kind: "blocked", why: "you coordinate this loop" });
});

test("needs=you (credentials, spending, public) skips the chain", () => {
  const ts = set(team(), "t3", "blocked", { "omniloop.needs": "you" });
  assert.equal(only(ts, "t3").why, "asked for you");
});

test("notify=me lets an agent reach you directly", () => {
  const ts = set(team(), "t4", "blocked", { "omniloop.notify": "me" });
  assert.equal(only(ts, "t4").to, "you");
});

test("a block nobody clears reaches you after ESCALATE_MS", () => {
  const ts = set(team(), "t3", "blocked");
  assert.equal(only(ts, "t3", { now: ESCALATE_MS - 1, blockedSince: 0 }).to, "t2");
  assert.deepEqual(only(ts, "t3", { now: ESCALATE_MS, blockedSince: 0 }), { to: "you", kind: "blocked", why: "nobody cleared it" });
});

test("a permission or auth prompt reaches you: a parent can't approve it", () => {
  const ts = team().map((t) => t.address === "t3" ? { ...t, status: { state: "blocked", kind: "permission" } } : t);
  assert.deepEqual(only(ts, "t3"), { to: "you", kind: "blocked", why: "permission prompt" });
});

test("working and idle agents route nowhere", () => {
  assert.equal(only(team(), "t2"), null);
});

test("two coordinators: the oldest coordinates, with a warning", () => {
  const ts = set(team(), "t2", "working", { "omniloop.coordinator": "1" });
  const [l] = buildLoops(ts).loops;
  assert.equal(l.coordinator, "t1");
  assert.equal(l.warnings.length, 1);
});

test("omniloop.to cycles are cut", () => {
  const ts = [
    T("a", "blocked", loop("x", { "omniloop.coordinator": "1" })),
    T("b", "blocked", loop("x", { "omniloop.to": "c" })),
    T("c", "working", loop("x", { "omniloop.to": "b" })),
  ];
  const [l] = buildLoops(ts).loops;
  assert.ok(l.warnings.some((w) => w.includes("omniloop.to loop")));
  assert.ok(route(l, "b"));
});

test("remote labels get their machine back", () => {
  assert.equal(qualify("t7", "m1/t9"), "m1/t7");
  assert.equal(qualify("m2/t7", "m1/t9"), "m2/t7");
  const ts = [
    T("m1/t1", "working", loop("r", { "omniloop.coordinator": "1" })),
    T("m1/t2", "blocked", loop("r", { "omniloop.to": "t1" })),
  ];
  assert.equal(only(ts, "m1/t2").to, "m1/t1");
});

test("a loop belongs to one machine: the same id on two machines is two loops", () => {
  const ts = [
    T("t1", "working", loop("sec", { "omniloop.coordinator": "1" })),
    T("m1/t1", "working", loop("sec", { "omniloop.coordinator": "1" })),
    T("m1/t2", "blocked", loop("sec", { "omniloop.to": "t1" })),
    T("m2/t1", "idle", loop("sec")),
  ];
  const { loops } = buildLoops(ts);
  assert.deepEqual(loops.map((l) => [l.id, l.name, l.machine, l.coordinator, l.warnings.length]).sort(),
    [["m1/sec", "sec", "m1", "m1/t1", 0], ["m2/sec", "sec", "m2", null, 0], ["sec", "sec", null, "t1", 0]]);
  assert.equal(loopKey(ts[0]), "sec");
  assert.equal(loopKey(ts[1]), "m1/sec");
  const m1 = loops.find((l) => l.id === "m1/sec");
  assert.equal(route(m1, "m1/t2").to, "m1/t1");   // its own machine's coordinator, never this computer's t1
});

test("alerts: loose blocked terminals reach you as today", () => {
  const built = buildLoops([...set(team(), "t3", "blocked"), T("t9", "blocked")]);
  const a = alerts(built);
  assert.deepEqual(a.map((x) => [x.address, x.to]), [["t3", "t2"], ["t9", "you"]]);
});

test("newForYou sounds once per new item for you", () => {
  const prev = [{ address: "t1", kind: "blocked", to: "you" }];
  const next = [...prev, { address: "t3", kind: "blocked", to: "t2" }, { address: "t9", kind: "blocked", to: "you" }];
  assert.deepEqual(newForYou(prev, next).map((a) => a.address), ["t9"]);
});

test("trackBlocked keeps the first time seen and drops cleared ones", () => {
  const a = trackBlocked({}, [T("t1", "blocked"), T("t2", "working")], 100);
  assert.deepEqual(a, { t1: 100 });
  const b = trackBlocked(a, [T("t1", "blocked")], 500);
  assert.deepEqual(b, { t1: 100 });
  assert.deepEqual(trackBlocked(b, [T("t1", "working")], 900), {});
});

test("loopView puts loops that need you first and counts what they handle themselves", () => {
  const ts = [
    ...set(team(), "t3", "blocked"),
    T("s1", "blocked", loop("solo")),
  ];
  const built = buildLoops(ts);
  const v = loopView(built, alerts(built));
  assert.deepEqual(v.map((l) => [l.id, l.needsYou, l.handling]), [["solo", 1, 0], ["m2", 0, 1]]);
});

test("a handed-off coordinator: the successor carries every label, the retired one drops out", () => {
  // omniloop handoff copies all labels to the successor and labels the old one omniloop.retired=<successor>.
  const ts = [
    T("t1", "done", loop("m2", { "omniloop.coordinator": "1", "omniloop.retired": "t8" }), 1),
    T("t8", "blocked", loop("m2", { "omniloop.coordinator": "1" }), 8),
    T("t3", "blocked", loop("m2", { "omniloop.to": "t1" }), 3),
  ];
  const [l] = buildLoops(ts).loops;
  assert.equal(l.coordinator, "t8");
  assert.deepEqual(l.retired, ["t1"]);
  assert.equal(l.warnings.length, 0);
  assert.deepEqual(route(l, "t3"), { to: "t8", kind: "blocked", why: "the coordinator" });
});

test("finished terminals leave their loop", () => {
  const ts = [{ ...T("t1", "done", loop("m2", { "omniloop.coordinator": "1" }), 1), state: "finished" },
    T("t2", "blocked", loop("m2"), 2)];
  const [l] = buildLoops(ts).loops;
  assert.equal(l.coordinator, null);
  assert.equal(route(l, "t2").to, "you");
});

test("error counts as blocked; hc get's {state} status is read too", () => {
  const ts = [T("t1", "working", loop("m2", { "omniloop.coordinator": "1" })), T("t2", "error", loop("m2")),
    { ...T("t3", null, loop("m2")), status: { app: "claude-code", state: "blocked" } }];
  const [l] = buildLoops(ts).loops;
  assert.equal(route(l, "t2").to, "t1");
  assert.equal(route(l, "t3").to, "t1");
});

test("status_ms stands in for blockedSince when the adapter hasn't tracked it", () => {
  const ts = set(team(), "t3", "blocked").map((t) => t.address === "t3" ? { ...t, status_ms: 0 } : t);
  const a = alerts(buildLoops(ts), { now: ESCALATE_MS });
  assert.equal(a.find((x) => x.address === "t3").to, "you");
});

test("why names a grandparent as further up, not the coordinator", () => {
  const ts = [
    T("t1", "working", loop("x", { "omniloop.coordinator": "1" }), 1),
    T("t2", "working", loop("x", { "omniloop.to": "t1" }), 2),
    T("t3", "blocked", loop("x", { "omniloop.to": "t2" }), 3),
    T("t4", "blocked", loop("x", { "omniloop.to": "t3" }), 4),
  ];
  assert.deepEqual(only(ts, "t4"), { to: "t2", kind: "blocked", why: "further up" });
});

test("the app's terminals() shape: status is a word, kind is in report", () => {
  const ts = [T("t1", "working", loop("m2", { "omniloop.coordinator": "1" })),
    { ...T("t3", "blocked", loop("m2", { "omniloop.to": "t1" })), report: { state: "blocked", kind: "permission" } }];
  assert.equal(only(ts, "t3").why, "permission prompt");
});

test("for-you words: approval, asked, finished, stalled; counts first, joined with ' · '", () => {
  const t = (status, extra = {}, labels = {}) => ({ address: "t1", status, labels, ...extra });
  assert.equal(forYouKind({ kind: "blocked" }, t("blocked", { status: { state: "blocked", kind: "permission" } })), "approval");
  assert.equal(forYouKind({ kind: "blocked" }, t("blocked", { status: { state: "blocked", kind: "auth" } })), "approval");
  assert.equal(forYouKind({ kind: "blocked" }, t("blocked", { status: { state: "blocked", kind: "question" } })), "asked");
  assert.equal(forYouKind({ kind: "done" }, t("done", {}, { "omniloop.ask": "1" })), "asked");
  assert.equal(forYouKind({ kind: "done" }, t("done", {}, { "omniloop.ask": "" })), "finished");
  assert.equal(forYouKind({ kind: "done" }, t("done")), "finished");
  assert.equal(forYouKind({ kind: "done" }), "finished");
  assert.equal(forYouKind({ kind: "stalled" }), "stalled");
  assert.equal(forYouKind({ kind: "stuck" }), "stalled");
  const c = forYouCounts(["approval", "asked", "asked", "finished", "bogus"]);
  assert.deepEqual(c, { approval: 1, asked: 2, finished: 1, stalled: 0, undelivered: 0, other: 0 });
  assert.equal(forYouLabel(c), "1 needs approval · 2 asked you · 1 finished");
  assert.equal(forYouLabel(forYouCounts([])), "");
  assert.equal(forYouLabel(forYouCounts(["stalled"])), "1 stalled");
});

test("loopView carries forYouCounts and forYouLabel; needsYou unchanged", () => {
  let ts = team().map((x) => ({ ...x, kind: undefined }));
  ts = set(ts, "t1", "done", { "omniloop.ask": "1" });
  ts = ts.map((x) => x.address === "t4" ? { ...x, status: { state: "blocked", kind: "permission" } } : x);
  const built = buildLoops(ts);
  const [l] = loopView(built, alerts(built));
  assert.equal(l.needsYou, 2);
  assert.deepEqual(l.forYouCounts, { approval: 1, asked: 1, finished: 0, stalled: 0, undelivered: 0, other: 0 });
  assert.equal(l.forYouLabel, "1 needs approval · 1 asked you");
});

test("forYouKind: only a done terminal is 'finished'; unknown kinds say 'needs you'; undeliverable says 'not delivered'", () => {
  assert.equal(forYouKind({ kind: "undeliverable" }), "undelivered");
  assert.equal(forYouKind({ kind: "whatever" }), "other");
  assert.equal(forYouKind({ kind: "whatever" }, { labels: { "omniloop.ask": "1" } }), "other");
  assert.equal(forYouKind({ kind: "done" }), "finished");
  const c = forYouCounts(["undelivered", "other", "other"]);
  assert.equal(forYouLabel(c), "1 not delivered · 2 needs you");
});

test("an old-style label (omniloop.lead) is still recognised as the coordinator", () => {
  const ts = [T("t1", "working", loop("old", { "omniloop.lead": "1" }), 1), T("t2", "blocked", loop("old", { "omniloop.to": "t1" }), 2)];
  const [l] = buildLoops(ts).loops;
  assert.equal(l.coordinator, "t1");
  assert.equal(l.agents.find((a) => a.address === "t1").isCoordinator, true);
  assert.equal(only(ts, "t2").to, "t1");
  assert.equal(isCoordinatorLabeled({ "omniloop.lead": "1" }), true);
  assert.equal(isCoordinatorLabeled({ "omniloop.coordinator": "1" }), true);
  assert.equal(isCoordinatorLabeled({ "omniloop.lead": "", omniloop: "x" }), false);
});

test("one terminal carrying both the new and the old coordinator key is one coordinator, no warning", () => {
  const ts = [T("t1", "working", loop("both", { "omniloop.coordinator": "1", "omniloop.lead": "1" }), 1)];
  const [l] = buildLoops(ts).loops;
  assert.deepEqual([l.coordinator, l.coordinators, l.warnings], ["t1", ["t1"], []]);
  assert.deepEqual(COORDINATOR_KEYS, ["omniloop.coordinator", "omniloop.lead"]);
});
