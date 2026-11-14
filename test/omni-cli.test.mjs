// The omniloop CLI end to end with OMNILOOP_BACKEND=omni, under a temporary HOME, against a fake `omni` executable on PATH
// (argv recorded, canned JSON). Deterministic: no daemon, no terminal. The real-daemon run is test/omni-smoke.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeOmni } from "./helpers/fake-omni.mjs";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");

async function rig(t, cfg = {}, extraEnv = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omniloop-omni-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fake = fakeOmni(join(home, "fake"), cfg);
  const env = { ...process.env, HOME: home, PATH: `${fake.bin}:${process.env.PATH}`, OMNILOOP_HOME: join(home, "cache"), OMNILOOP_BACKEND: "omni",
    OMNI_PANE: "pn_ME", HC_TERMINAL_ID: "", OMNILOOP_DRAFT_WAIT_MS: "0", ...extraEnv };
  // The herdr tools must never be reached on the omni backend: a fake that records and fails.
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake.bin, n), `#!/bin/sh\necho "$0 $*" >> ${join(home, "herdr-called")}\nexit 1\n`, { mode: 0o755 }); }
  const cmd = (...args) => run("node", [BIN, ...args], { env, cwd: home });
  return { home, fake, cmd, env };
}
const calledHerdr = (r) => { try { return readFileSync(join(r.home, "herdr-called"), "utf8"); } catch { return ""; } };

const term = (address, labels, extra = {}) => ({ address, state: "live", status: { state: "idle" }, labels, ...extra });

test("omni: ls reads one `omni ls --json` and shows the loop tree with pn_ ids", async (t) => {
  const r = await rig(t, { terminals: [
    term("pn_LEAD", { omniloop: "x", "omniloop.coordinator": "1", "omniloop.goal": "ship" }),
    term("pn_KID", { omniloop: "x", "omniloop.to": "pn_LEAD", "omniloop.job": "tests" }, { status: { state: "working" } }),
  ] });
  await r.cmd("new", "x", "--goal", "ship", "--no-coordinator");
  r.fake.reset();
  const { stdout } = await r.cmd("ls");
  assert.match(stdout, /^x — ship \(coordinator: pn_LEAD\)/);
  assert.match(stdout, /pn_LEAD\* idle/);
  assert.match(stdout, /pn_KID working tests/);
  assert.deepEqual(r.fake.calls(), [["ls", "--json"]], "one call, no N+1 gets");
  assert.equal(calledHerdr(r), "");
});

test("omni: new makes the omni loop with goal and folders, then the coordinator as lead with the coordinator labels", async (t) => {
  const r = await rig(t);
  const { stdout } = await r.cmd("new", "ship-it", "--goal", "ship it");
  assert.match(stdout, /^loop ship-it:/m);
  assert.match(stdout, /coordinator pn_NEW1 in space ship-it/);
  const calls = r.fake.calls();
  assert.deepEqual(calls[0], ["loop", "get", "ship-it"]);
  assert.deepEqual(calls[1], ["loop", "new", "ship-it", "--goal", "ship it"]);
  const spawn = calls.find((c) => c[0] === "spawn");
  assert.ok(spawn.includes("--role") && spawn[spawn.indexOf("--role") + 1] === "lead");
  assert.ok(spawn.includes("--loop") && spawn[spawn.indexOf("--loop") + 1] === "ship-it");
  for (const l of ["omniloop=ship-it", "omniloop.coordinator=1", "omniloop.lead=1", "omniloop.job=coordinator", "omniloop.goal=ship it"]) assert.ok(spawn.includes(l), l);
  assert.ok(spawn.join(" ").includes(`--cwd ${r.home}/loops/ship-it`));
  assert.equal(calls.filter((c) => c[0] === "loop" && c[1] === "new").length, 1, "the loop is made once");
  assert.equal(calledHerdr(r), "", "no hc or herdr-app call on the omni backend");
});

test("omni: new --dry-run prints the omni spawn and starts nothing", async (t) => {
  const r = await rig(t);
  const { stdout } = await r.cmd("new", "dry", "--goal", "g", "--dry-run");
  assert.match(stdout, /"omni": \[/);
  assert.match(stdout, /You coordinate the loop dry/);
  assert.ok(!r.fake.calls().some((c) => c[0] === "spawn" || (c[0] === "loop" && c[1] === "new")));
});

test("omni: start puts a helper in the starter's loop (role helper, reports to OMNI_PANE) and prints the pane id", async (t) => {
  const r = await rig(t, { loops: { x: { goal: "g" } } });
  await r.cmd("new", "x", "--goal", "g", "--no-coordinator").catch(() => {});
  r.fake.reset();
  const { stdout } = await r.cmd("start", "x", "--job", "tests", "--", "sh", "-c", "true");
  assert.equal(stdout.trim(), "pn_NEW1");
  const spawn = r.fake.calls().find((c) => c[0] === "spawn");
  assert.ok(spawn.join(" ").includes("--loop x --role helper"));
  for (const l of ["omniloop=x", "omniloop.to=pn_ME", "omniloop.job=tests"]) assert.ok(spawn.includes(l), l);
  assert.ok(!spawn.some((a) => a.startsWith("herdr.space")));
  assert.deepEqual(spawn.slice(-3), ["sh", "-c", "true"]);
});

test("omni: identity comes from OMNI_PANE (needs-you labels the caller's own pane; join and leave place it)", async (t) => {
  const r = await rig(t, { loops: { x: { goal: "g" } } });
  await r.cmd("needs-you");
  assert.deepEqual(r.fake.calls().pop(), ["label", "--pane", "pn_ME", "omniloop.needs=you"]);
  r.fake.reset();
  await r.cmd("join", "x", "--coordinator");
  const calls = r.fake.calls();
  assert.deepEqual(calls[0].slice(0, 3), ["label", "--pane", "pn_ME"]);
  assert.ok(calls[0].includes("omniloop=x") && calls[0].includes("omniloop.coordinator=1"));
  assert.deepEqual(calls[1], ["join", "--pane", "pn_ME", "x", "--role", "lead"]);
  r.fake.reset();
  await r.cmd("leave");
  assert.deepEqual(r.fake.calls().map((c) => c[0]), ["label", "join"]);
  assert.deepEqual(r.fake.calls()[1], ["join", "--pane", "pn_ME", "-"]);
});

test("omni: join still succeeds (labels are the truth) when omni refuses the placement, and says so on stderr", async (t) => {
  const r = await rig(t, { failVerbs: ["join"] });
  const { stdout, stderr } = await r.cmd("join", "x", "--terminal", "pn_OTHER");
  assert.match(stdout, /^pn_OTHER in x/);
  assert.match(stderr, /pn_OTHER is labelled, but omni did not move it into x: omni: denied \(join\)/);
});

test("omni: reply types to the idle coordinator with --if idle, `--` before the text, and the omniloop.you label", async (t) => {
  const r = await rig(t, { terminals: [term("pn_LEAD", { omniloop: "x", "omniloop.coordinator": "1" })] });
  await r.cmd("new", "x", "--goal", "g", "--no-coordinator");
  r.fake.reset();
  const { stdout } = await r.cmd("reply", "go --force the build", "--loop", "x");
  assert.match(stdout, /^sent to pn_LEAD/);
  const send = r.fake.calls().find((c) => c[0] === "send");
  assert.deepEqual(send, ["send", "--pane", "pn_LEAD", "--enter", "--if", "idle", "--", "you: go --force the build"]);
  assert.ok(r.fake.calls().some((c) => c[0] === "label" && c[2] === "pn_LEAD" && c[3].startsWith("omniloop.you=")));
});

test("omni: a refused send (exit 3) is held as a timer, like on herdr", async (t) => {
  const r = await rig(t, { terminals: [term("pn_LEAD", { omniloop: "x", "omniloop.coordinator": "1" })], sendExit: 3, sendErr: "omni: refused as stale\n" });
  await r.cmd("new", "x", "--goal", "g", "--no-coordinator");
  const { stdout } = await r.cmd("reply", "later", "--loop", "x");
  assert.match(stdout, /^held for pn_LEAD/);
});

test("omni: reply waits for a person's draft (emulated), reading capture until it is gone", async (t) => {
  const r = await rig(t, { terminals: [term("pn_LEAD", { omniloop: "x", "omniloop.coordinator": "1" })], screens: ["❯ typing a reply", "❯ "] }, { OMNILOOP_DRAFT_WAIT_MS: "60000" });
  await r.cmd("new", "x", "--goal", "g", "--no-coordinator");
  r.fake.reset();
  await r.cmd("reply", "hello", "--loop", "x");
  const verbs = r.fake.calls().map((c) => c[0]).filter((v) => v === "capture" || v === "send");
  assert.deepEqual(verbs, ["capture", "capture", "send"]);
});

test("omni: goal set updates the omni loop's goal and relabels running agents", async (t) => {
  const r = await rig(t, { loops: { x: { goal: "old" } }, terminals: [term("pn_KID", { omniloop: "x" }, { status: { state: "working" } })] });
  await r.cmd("new", "x", "--goal", "old", "--no-coordinator").catch(() => {});
  r.fake.reset();
  await r.cmd("goal", "set", "a new goal", "--loop", "x");
  const calls = r.fake.calls();
  assert.deepEqual(calls.find((c) => c[0] === "loop" && c[1] === "set"), ["loop", "set", "x", "--goal", "a new goal"]);
  assert.deepEqual(calls.find((c) => c[0] === "label"), ["label", "--pane", "pn_KID", "omniloop.goal=a new goal"]);
});

test("omni: handoff starts the successor in the same loop, retires the old pane, repoints reports", async (t) => {
  const old = term("pn_OLD", { omniloop: "x", "omniloop.coordinator": "1", "omniloop.job": "coordinator" }, { foreground: { argv: ["claude", "--model", "x"] }, cwd: "/w" });
  const kid = term("pn_KID", { omniloop: "x", "omniloop.to": "pn_OLD" });
  const r = await rig(t, { loops: { x: { goal: "g" } }, terminals: [old, kid] });
  await r.cmd("new", "x", "--goal", "g", "--no-coordinator");
  r.fake.reset();
  const { stdout } = await r.cmd("handoff", "/tmp/h.md", "--terminal", "pn_OLD");
  assert.match(stdout, /^pn_NEW1 continues as pn_OLD; 1 report\(s\)/);
  const calls = r.fake.calls();
  const spawn = calls.find((c) => c[0] === "spawn");
  assert.ok(spawn.join(" ").includes("--loop x --role lead"));
  assert.deepEqual(calls.filter((c) => c[0] === "label").map((c) => c.slice(0, 3).join(" ")), ["label --pane pn_OLD", "label --pane pn_KID"]);
  assert.ok(calls.find((c) => c[0] === "label" && c[2] === "pn_KID").includes("omniloop.to=pn_NEW1"));
});

test("omni: rename follows through omni (new loop, panes moved, old loop removed)", async (t) => {
  const r = await rig(t, { loops: { old: { goal: "g" } }, terminals: [term("pn_KID", { omniloop: "old" })] });
  await r.cmd("new", "old", "--goal", "g", "--no-coordinator").catch(() => {});
  r.fake.reset();
  const { stdout } = await r.cmd("rename", "old", "newer");
  assert.match(stdout, /^renamed old to newer/);
  const calls = r.fake.calls().map((c) => c.join(" "));
  assert.ok(calls.includes("label --pane pn_KID omniloop=newer"));
  assert.ok(calls.includes("join --pane pn_KID newer"));
  assert.ok(calls.includes("loop rm old"));
  assert.ok(calls.indexOf("join --pane pn_KID newer") < calls.indexOf("loop rm old"));
});

test("omni: rename says so when omni refuses to move a pane (labels still carry the new name)", async (t) => {
  const r = await rig(t, { loops: { old: { goal: "g" } }, terminals: [term("pn_KID", { omniloop: "old" })], failVerbs: ["join"] });
  await r.cmd("new", "old", "--goal", "g", "--no-coordinator").catch(() => {});
  const { stdout } = await r.cmd("rename", "old", "newer");
  assert.match(stdout, /keeps the old name \(omni: denied \(join\)/);
});

test("omni: sessions finds claude panes from the one ls call", async (t) => {
  const r = await rig(t, { terminals: [term("pn_A", {}, { agent: "claude-code", foreground: { pid: 99999999 } })] });
  const { stdout } = await r.cmd("sessions");
  assert.match(stdout, /no Claude sessions running|address/);
  assert.equal(calledHerdr(r), "");
});
