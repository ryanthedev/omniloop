// The two adapters of the backend port. OmniBackend runs against a fake `omni` executable on PATH (argv recorded, canned
// JSON); HerdrBackend against a recording fake process transport. Nothing sleeps for real and nothing needs a live terminal.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniBackend, HerdrBackend, selectBackend } from "../bin/lib/backend/index.mjs";
import { sendArgs } from "../bin/lib/backend/omni.mjs";
import { nodeProc } from "../bin/lib/proc.mjs";
import { foregroundPid } from "../bin/lib/sock.mjs";
import { sendFailed } from "../core/watch.js";
import { fakeOmni } from "./helpers/fake-omni.mjs";
import { FakeBackend } from "./helpers/fake-backend.mjs";

const PORT = ["self", "list", "get", "read", "send", "label", "spawnPlan", "spawn", "kill", "remove", "foregroundPid", "events", "machines",
  "groupOf", "startCoordinator", "renameGroup", "closeGroup", "retireGroup", "syncLoop", "place"];
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "omniloop-be-"))); roots.push(d); return d; };

/** An OmniBackend over the fake omni at the front of PATH. */
function omniRig(cfg = {}, opts = {}) {
  const dir = scratch(), fake = fakeOmni(dir, cfg);
  const was = process.env.PATH;
  process.env.PATH = `${fake.bin}:${was}`;
  after(() => { process.env.PATH = was; });
  const slept = [];
  let t = 0;
  const be = new OmniBackend({ proc: nodeProc, env: { OMNI_PANE: "pn_ME" }, sleep: async (ms) => { slept.push(ms); t += ms; }, now: () => t, draftWaitMs: 0, ...opts });
  return { be, fake, slept };
}

test("every backend implements the whole port (fake, herdr, omni)", () => {
  for (const be of [new FakeBackend(), new HerdrBackend({ proc: {} }), new OmniBackend({ proc: {} })]) {
    for (const m of PORT) assert.equal(typeof be[m], "function", `${be.name}.${m}`);
    assert.ok(be.words.read && be.words.wait && be.words.down, be.name);
  }
});

test("selectBackend picks the adapter from env", () => {
  assert.equal(selectBackend({}).name, "herdr");
  assert.equal(selectBackend({ OMNI_PANE: "pn_A" }).name, "omni");
  assert.equal(selectBackend({ OMNILOOP_BACKEND: "omni", HC_TERMINAL_ID: "t1" }).name, "omni");
  assert.equal(selectBackend({ OMNI_PANE: "pn_A" }).self(), "pn_A");
  assert.equal(selectBackend({ HC_TERMINAL_ID: "t4" }).self(), "t4");
});

test("policy over a fake backend: foregroundPid goes through the port", async () => {
  const be = new FakeBackend([{ address: "pn_A", foreground: { pid: 4242 } }]);
  assert.equal(await foregroundPid("pn_A", { backend: be }), 4242);
  assert.equal(await foregroundPid("pn_B", { backend: be }), null);
});

// ---- OmniBackend -------------------------------------------------------------------------------------------------

test("omni: list is one `omni ls --json` call and keeps the labels; get names the pane with --pane", async () => {
  const { be, fake } = omniRig({ terminals: [{ address: "pn_A", labels: { omniloop: "X" }, state: "live" }] });
  const ts = await be.list();
  assert.deepEqual(ts.map((t) => [t.address, t.labels.omniloop]), [["pn_A", "X"]]);
  assert.deepEqual(fake.calls(), [["ls", "--json"]]);
  assert.equal((await be.get("pn_A")).address, "pn_A");
  await assert.rejects(be.get("pn_Z"), (e) => /no such pane/.test(e.stderr) && e.code === 1);
});

test("omni: send is `omni send --pane P --enter [--if idle] -- text`; text starting with -- stays text", async () => {
  const { be, fake } = omniRig();
  assert.deepEqual(await be.send("pn_A", "omniloop: t3 done", { if: "idle" }), { code: 0, output: "" });
  await be.send("pn_A", "--force go on");
  assert.deepEqual(fake.calls(), [
    ["send", "--pane", "pn_A", "--enter", "--if", "idle", "--", "omniloop: t3 done"],
    ["send", "--pane", "pn_A", "--enter", "--", "--force go on"],
  ]);
  assert.deepEqual(sendArgs("pn_A", "x"), ["send", "--pane", "pn_A", "--enter", "--", "x"]);
});

test("omni: a refused guard (exit 3) resolves with the code and message, and sendFailed holds it", async () => {
  const { be } = omniRig({ sendExit: 3, sendErr: "omni: refused as stale (status working)\n" });
  const r = await be.send("pn_A", "note", { if: "idle" });
  assert.equal(r.code, 3);
  assert.match(r.output, /stale/);
  assert.equal(sendFailed(r.code, r.output), true);
});

test("omni: send waits for a person's draft before typing (emulating hc send), reading the screen again each second", async () => {
  const { be, fake, slept } = omniRig({ screens: ["old\n❯ half a thought", "old\n❯ half a thought", "old\n❯ "] }, { draftWaitMs: 60_000 });
  await be.send("pn_A", "note");
  assert.deepEqual(fake.calls().map((c) => c[0]), ["capture", "capture", "capture", "send"]);
  assert.deepEqual(slept, [1000, 1000]);
  assert.deepEqual(fake.calls()[0], ["capture", "--pane", "pn_A"]);
});

test("omni: a draft that never goes is waited for draftWaitMs, then the note is typed anyway", async () => {
  const { be, fake, slept } = omniRig({ screens: ["❯ my long draft"] }, { draftWaitMs: 3000 });
  const r = await be.send("pn_A", "note");
  assert.equal(r.code, 0);
  assert.equal(slept.reduce((a, b) => a + b, 0), 3000);
  assert.equal(fake.calls().at(-1)[0], "send");
});

test("omni: draftWaitMs 0 (or OMNILOOP_DRAFT_WAIT_MS=0) never reads the screen", async () => {
  const { be, fake } = omniRig({ screens: ["❯ draft"] });
  await be.send("pn_A", "note");
  assert.deepEqual(fake.calls().map((c) => c[0]), ["send"]);
  const off = new OmniBackend({ proc: nodeProc, env: { OMNILOOP_DRAFT_WAIT_MS: "0" } });
  assert.equal(off.draftWaitMs, 0);
});

test("omni: label sets and deletes (k=), and cuts a value over omni's 2048-byte limit", async () => {
  const { be, fake } = omniRig();
  await be.label("pn_A", ["omniloop=X", "omniloop.to=", `omniloop.goal=${"é".repeat(2000)}`]);
  const [verb, flag, pane, ...kv] = fake.calls()[0];
  assert.deepEqual([verb, flag, pane], ["label", "--pane", "pn_A"]);
  assert.deepEqual(kv.slice(0, 2), ["omniloop=X", "omniloop.to="]);
  assert.ok(Buffer.byteLength(kv[2]) <= "omniloop.goal=".length + 2048 && kv[2].startsWith("omniloop.goal=é"));
});

test("omni: spawn into a loop that does not exist makes it first, then starts the pane as lead", async () => {
  const { be, fake } = omniRig();
  const r = await be.spawn({ argv: ["claude", "-p", "hi"], cwd: "/w", labels: { omniloop: "X", "omniloop.job": "j" }, loop: "X", role: "lead", goal: "ship it", dirs: ["/r"] });
  assert.equal(r.address, "pn_NEW1");
  assert.deepEqual(fake.calls(), [
    ["loop", "get", "X"],
    ["loop", "new", "X", "--goal", "ship it", "--dir", "/r"],
    ["spawn", "--json", "--cwd", "/w", "--loop", "X", "--role", "lead", "--label", "omniloop=X", "--label", "omniloop.job=j", "--", "claude", "-p", "hi"],
  ]);
});

test("omni: spawn into an existing loop skips loop new; with no loop it is a plain pane", async () => {
  const { be, fake } = omniRig({ loops: { X: { goal: "g" } } });
  await be.spawn({ argv: ["sh"], labels: {}, loop: "X", role: "helper" });
  await be.spawn({ argv: ["sh"], cwd: "/w", labels: { a: "b" } });
  assert.deepEqual(fake.calls(), [
    ["loop", "get", "X"],
    ["spawn", "--json", "--loop", "X", "--role", "helper", "--", "sh"],
    ["spawn", "--json", "--cwd", "/w", "--label", "a=b", "--", "sh"],
  ]);
});

test("omni: spawnPlan is pure (no calls) and a refused spawn throws with omni's message", async () => {
  const { be, fake } = omniRig({ failVerbs: ["spawn"] });
  const p = await be.spawnPlan({ argv: ["x"], labels: {}, loop: "X" });
  assert.equal(p.cmd, "omni");
  assert.deepEqual(fake.calls(), []);
  await assert.rejects(be.spawn({ argv: ["x"], labels: {}, loop: "X", role: "helper" }), (e) => /denied \(spawn\)/.test(e.stderr) && e.code === 4);
});

test("omni: kill and remove never reject; foregroundPid reads foreground.pid or says null", async () => {
  const { be, fake } = omniRig({ failVerbs: ["kill", "rm"], terminals: [{ address: "pn_A", foreground: { pid: 77 } }] });
  await be.kill("pn_A"); await be.remove("pn_A");
  assert.deepEqual(fake.calls(), [["kill", "--pane", "pn_A"], ["rm", "--pane", "pn_A"]]);
  assert.equal(await be.foregroundPid("pn_A"), 77);
  assert.equal(await be.foregroundPid("pn_none"), null);
});

test("omni: groupOf, syncLoop (create or set goal), place (join or leave)", async () => {
  const { be, fake } = omniRig({ loops: { X: { goal: "old" } } });
  assert.equal(await be.groupOf("X"), "X");
  assert.equal(await be.groupOf("Y"), null);
  fake.reset();
  await be.syncLoop("X", { goal: "new goal" });
  await be.syncLoop("Y", { goal: "g", dirs: ["/a", "/b"] });
  await be.place("pn_A", "X", "lead");
  await be.place("pn_A", null);
  assert.deepEqual(fake.calls(), [
    ["loop", "get", "X"], ["loop", "set", "X", "--goal", "new goal"],
    ["loop", "get", "Y"], ["loop", "new", "Y", "--goal", "g", "--dir", "/a", "--dir", "/b"],
    ["join", "--pane", "pn_A", "X", "--role", "lead"],
    ["join", "--pane", "pn_A", "-"],
  ]);
});

test("omni: startCoordinator makes the lead pane; dry run returns the plan and calls nothing", async () => {
  const { be, fake } = omniRig({ loops: { X: { goal: "g" } } });
  const dry = await be.startCoordinator({ id: "X", home: "/h", argv: ["claude"], labels: { omniloop: "X" }, goal: "g", dirs: [] }, { dry: true });
  assert.deepEqual(dry.plan.omni.slice(0, 5), ["spawn", "--json", "--cwd", "/h", "--loop"]);
  assert.deepEqual(fake.calls(), []);
  const r = await be.startCoordinator({ id: "X", home: "/h", argv: ["claude"], labels: { omniloop: "X" }, goal: "g", dirs: [] });
  assert.equal(r.address, "pn_NEW1");
  assert.ok(fake.calls().some((c) => c[0] === "spawn" && c.includes("lead")));
});

test("omni: renameGroup makes the new loop with the old goal, moves the panes, removes the old loop; a refused move throws", async () => {
  const { be, fake } = omniRig({ loops: { old: { goal: "the goal", workspace: [{ path: "/r" }] } } });
  await be.renameGroup("old", { from: "old", to: "new", terms: ["pn_A", "pn_B"] });
  assert.deepEqual(fake.calls(), [
    ["loop", "get", "old"], ["loop", "get", "new"], ["loop", "new", "new", "--goal", "the goal", "--dir", "/r"],
    ["join", "--pane", "pn_A", "new"], ["join", "--pane", "pn_B", "new"], ["loop", "rm", "old"],
  ]);
  fake.reset();
  fake.set({ terminals: [], loops: { old: { goal: "g" } }, failVerbs: ["join"] });
  await assert.rejects(be.renameGroup("old", { from: "old", to: "n2", terms: ["pn_A"] }), /denied/);
  assert.ok(!fake.calls().some((c) => c[0] === "loop" && c[1] === "rm"), "the old loop stays when a pane could not move");
});

test("omni: retireGroup retries loop rm (fake clock) and gives up quietly", async () => {
  const { be, fake, slept } = omniRig({ failVerbs: ["loop rm"] });
  await be.retireGroup("X");
  assert.equal(fake.calls().filter((c) => c[1] === "rm").length, 6);
  assert.equal(slept.length, 6);
});

test("omni: events is `omni events --all --json [--label k=v]`; the stream's first line lists the terminals", async () => {
  const { be, fake } = omniRig({ terminals: [{ address: "pn_A", labels: {} }], eventsEnd: 50, events: [[5, { terminal: "pn_A", type: "status", data: { status: { state: "idle" } } }]] });
  assert.equal(be.eventsReconnect, true);
  const ev = be.events({ label: "omniloop=X" });
  let out = "";
  ev.stdout.on("data", (d) => { out += d; });
  await new Promise((r) => ev.on("exit", r));
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(fake.calls()[0], ["events", "--all", "--json", "--label", "omniloop=X"]);
  assert.equal(lines[0].terminals[0].address, "pn_A");
  assert.equal(lines[1].params.type, "status");
  assert.deepEqual(await be.machines(), []);
});

// ---- HerdrBackend (a recording fake transport) ------------------------------------------------------------------------

function herdrRig(answer = () => ({ code: 0, stdout: "{}", stderr: "" })) {
  const calls = [];
  const proc = { run: async (cmd, args, o = {}) => { calls.push([cmd, ...args]); return answer(cmd, args, o); }, start: (cmd, args) => { calls.push([cmd, ...args]); return { fake: true }; } };
  return { be: new HerdrBackend({ proc, env: { HC_TERMINAL_ID: "t9" }, sleep: async () => {} }), calls };
}
const json = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });

test("herdr: list is hc ls then one hc get per terminal (a failing get is dropped); get puts --json last, hooks' timeout form first", async () => {
  const { be, calls } = herdrRig((cmd, a) => a[0] === "ls" ? json({ terminals: [{ address: "t1" }, { address: "t2" }] }) : a[1] === "t2" ? { code: 1, stdout: "", stderr: "x" } : json({ address: "t1", labels: {} }));
  assert.deepEqual((await be.list()).map((t) => t.address), ["t1"]);
  assert.deepEqual(calls, [["hc", "ls", "--json"], ["hc", "get", "t1", "--json"], ["hc", "get", "t2", "--json"]]);
  calls.length = 0;
  await be.get("t1", { timeoutMs: 1500 });
  assert.deepEqual(calls, [["hc", "get", "--json", "t1"]]);
});

test("herdr: send is hc send [--if idle] <t> <text> and resolves with the exit code and output", async () => {
  const { be, calls } = herdrRig(() => ({ code: 2, stdout: "", stderr: "cannot save terminals" }));
  const r = await be.send("t3", "hello", { if: "idle" });
  assert.deepEqual(calls, [["hc", "send", "--if", "idle", "t3", "hello"]]);
  assert.deepEqual(r, { code: 2, output: "cannot save terminals" });
  assert.equal(sendFailed(r.code, r.output), false);
});

test("herdr: spawn is hc run --bg --no-parent --no-notify ... -- argv --json; --json goes before the --", async () => {
  const { be, calls } = herdrRig(() => json({ address: "t12" }));
  const r = await be.spawn({ argv: ["sh", "-c", "true"], cwd: "/w", labels: { omniloop: "X" }, loop: "X", role: "helper" });
  assert.equal(r.address, "t12");
  assert.deepEqual(calls[0], ["hc", "run", "--bg", "--no-parent", "--no-notify", "--cwd", "/w", "--label", "omniloop=X", "--json", "--", "sh", "-c", "true"]);
});

test("herdr: placement - the starter's space, overridden by --space, overridden by the loop's own space", async () => {
  const ans = (cmd, a) => cmd === "herdr-app" ? json({ spaces: [{ id: "sp9", name: "X" }] }) : a[0] === "get" ? json({ labels: { "herdr.space": "sp1" } }) : json({});
  const { be } = herdrRig(ans);
  const base = { argv: ["x"], labels: { omniloop: "X" }, loop: "X" };
  const space = async (spec) => (await be.spawnPlan(spec)).args.filter((a) => a.startsWith("herdr.space="));
  assert.deepEqual(await space({ ...base, starter: "t9" }), ["herdr.space=sp1"]);
  assert.deepEqual(await space({ ...base, starter: "t9", space: "spF" }), ["herdr.space=spF"]);
  assert.deepEqual(await space({ ...base, starter: "t9", inLoopSpace: true }), ["herdr.space=sp9"]);
  assert.deepEqual(await space({ ...base, starter: "t9", space: "spF", inLoopSpace: true }), ["herdr.space=spF"]);
  assert.deepEqual(await space(base), []);
});

test("herdr: startCoordinator dry run names the herdr-app command; machines, kill, remove, events use hc", async () => {
  const { be, calls } = herdrRig((cmd, a) => cmd === "herdr-app" ? json({ spaces: [] }) : a[0] === "machine" ? json({ machines: [{ name: "m1" }] }) : { code: 1, stdout: "", stderr: "" });
  const r = await be.startCoordinator({ id: "X", home: "/h", argv: ["claude"], labels: {} }, { dry: true });
  assert.deepEqual(Object.keys(r.plan), ["space.new"]);
  assert.deepEqual(await be.machines(), ["m1"]);
  await be.kill("t1"); await be.remove("t1");
  be.events({ label: "omniloop=X" });
  assert.deepEqual(calls.slice(-3), [["hc", "kill", "t1"], ["hc", "rm", "t1"], ["hc", "events", "--json", "--label", "omniloop=X"]]);
  assert.equal(be.eventsReconnect, false);
  assert.equal(be.self(), "t9");
});
