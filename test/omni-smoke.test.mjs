// One real smoke test: omniloop's omni backend against a throwaway omni-daemon (own runtime dir, own HOME, no restore).
// Skipped unless the omni binaries exist: OMNI_BIN_DIR (default the D6 build, /Users/r/repos/omni/build/target/d6/debug) must hold
// `omni` and `omni-daemon` built from omni job 5d (the loop surface). Scratch lives under OMNI_SMOKE_TMP (default omni's build/tmp/d6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OmniBackend } from "../bin/lib/backend/omni.mjs";
import { nodeProc } from "../bin/lib/proc.mjs";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");
const OMNI_DIR = process.env.OMNI_BIN_DIR ?? "/Users/r/repos/omni/build/target/d6/debug";
const TMP = process.env.OMNI_SMOKE_TMP ?? "/Users/r/repos/omni/build/tmp/d6";
const have = existsSync(join(OMNI_DIR, "omni")) && existsSync(join(OMNI_DIR, "omni-daemon"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await sleep(150); }
}

test("smoke: loop new, start, ls, send, read, label, watch and rm against a real omni daemon", { skip: have ? false : `no omni binaries in ${OMNI_DIR}`, timeout: 120_000 }, async (t) => {
  mkdirSync(TMP, { recursive: true });
  const root = realpathSync(mkdtempSync(join(TMP, "s-")));
  const home = join(root, "home"); mkdirSync(home);
  const rt = join(root, "rt");
  const base = { ...process.env, HOME: home, PATH: `${OMNI_DIR}:${process.env.PATH}`, OMNI_RUNTIME_DIR: rt, OMNI_DATA_DIR: join(root, "data"), OMNI_NO_RESTORE: "1", OMNI_SHELL: "/bin/sh" };
  for (const k of ["OMNI_PANE", "OMNI_TOKEN", "HC_TERMINAL_ID", "OMNILOOP_BACKEND"]) delete base[k];
  const env = { ...base, OMNILOOP_BACKEND: "omni", OMNILOOP_HOME: join(root, "cache"), OMNILOOP_DRAFT_WAIT_MS: "0" };
  const daemon = spawn(join(OMNI_DIR, "omni-daemon"), [], { env: base, stdio: ["ignore", "ignore", "pipe"] });
  let derr = ""; daemon.stderr.on("data", (d) => { derr += d; });
  t.after(() => { daemon.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });
  await until("daemon socket", async () => (await run("omni", ["ls", "--json"], { env })).stdout, 20_000).catch((e) => { throw new Error(`${e.message}\n${derr}`); });

  const cmd = (...a) => run("node", [BIN, ...a], { env, cwd: home });
  const be = new OmniBackend({ proc: { run: (c, a, o) => nodeProc.run(c, a, { ...o, env }), start: (c, a) => nodeProc.start(c, a, { env }) }, env, draftWaitMs: 0 });

  // loop new (omni loop mirrors the manifest) and a coordinator that is the loop's lead
  await cmd("new", "smk", "--goal", "smoke test the omni backend", "--no-coordinator");
  assert.equal(JSON.parse((await run("omni", ["loop", "get", "smk"], { env })).stdout).goal, "smoke test the omni backend");
  const lead = (await cmd("start", "smk", "--coordinator", "--job", "lead", "--", "cat")).stdout.trim();
  assert.match(lead, /^pn_[0-9A-Za-z]+$/);
  const kid = (await cmd("start", "smk", "--job", "kid", "--", "cat")).stdout.trim();
  assert.notEqual(kid, lead);

  // ls shows both under the loop; the coordinator is the lead; omni's loop record has both members with roles
  const ls = (await cmd("ls", "smk")).stdout;
  assert.match(ls, new RegExp(`^smk .*coordinator: ${lead}`));
  assert.ok(ls.includes(`${lead}*`) && ls.includes(kid), ls);
  const rec = JSON.parse((await run("omni", ["loop", "get", "smk"], { env })).stdout);
  assert.deepEqual(rec.members.map((m) => [m.pane, m.role]).sort(), [[kid, "helper"], [lead, "lead"]].sort());

  // labels both ways (needs-you uses --terminal here: the test is not inside a pane)
  await cmd("needs-you", "--terminal", kid);
  assert.equal((await be.get(kid)).labels["omniloop.needs"], "you");
  assert.equal((await be.get(kid)).labels["omniloop.to"] ?? null, null);

  // send (text starting with --) and read it back from the screen
  assert.equal((await be.send(kid, "--smoke words")).code, 0);
  await until("sent text on screen", async () => (await be.read(kid)).includes("--smoke words"));
  const screen = await be.read(kid);
  assert.ok(screen.split("\n").filter((l) => l.includes("--smoke words")).length >= 1);

  // the guard: a plain `cat` has no agent status, so --if idle is refused (exit 3) and nothing is typed
  const refused = await be.send(kid, "never typed", { if: "idle" });
  assert.notEqual(refused.code, 0);
  await sleep(300);
  assert.ok(!(await be.read(kid)).includes("never typed"));

  // the watcher reads the event stream (first line lists terminals) and starts without a herdr
  const w = spawn("node", [BIN, "watch", "--loop", "smk", "--dry-run"], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let wout = ""; w.stdout.on("data", (d) => { wout += d; }); w.stderr.on("data", (d) => { wout += d; });
  t.after(() => w.kill());
  await until("watcher ready", async () => /watching loop smk: 2 terminals/.test(wout));

  // rm: panes ended and removed, the omni loop retired
  await be.kill(kid); await be.kill(lead);
  await until("panes finished", async () => (await be.get(kid)).state === "finished" && (await be.get(lead)).state === "finished");
  await be.remove(kid); await be.remove(lead);
  await be.retireGroup("smk");
  assert.equal(await be.groupOf("smk"), null);
});
