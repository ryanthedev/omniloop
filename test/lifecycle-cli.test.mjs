// End to end: rename, task and folder changes, rm and temporary loops through the real CLI, under a temporary HOME
// (so ~/loops and ~/.claude are temporary too) with fake `hc` and `herdr-app` that always fail, so nothing reaches
// the real herdr-core or the Herdr app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, lstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectKey } from "../core/lifecycle.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omniloop-life-")));
  const fake = join(home, "fakebin");
  mkdirSync(fake);
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake, n), "#!/bin/sh\nexit 1\n"); chmodSync(join(fake, n), 0o755); }
  const env = { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, OMNILOOP_HOME: join(home, ".cache", "omniloop"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", HC_TERMINAL_ID: "" };
  const sh = (cmd, args, cwd = home) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repo = (rel) => {
    const p = join(home, rel); mkdirSync(p, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], p);
    writeFileSync(join(p, "a.txt"), "a\n"); sh("git", ["add", "."], p); sh("git", ["commit", "-qm", "a"], p);
    return p;
  };
  const omniloop = (...args) => sh("node", [BIN, ...args]);
  const fails = (...args) => { try { sh("node", [BIN, ...args]); } catch (e) { return String(e.stderr); } assert.fail(`expected failure: ${args.join(" ")}`); };
  const manifest = (id) => JSON.parse(readFileSync(join(home, "loops", id, "loop.json"), "utf8"));
  const gone = async (p) => { for (let i = 0; i < 40 && existsSync(p); i++) await new Promise((r) => setTimeout(r, 250)); return !existsSync(p); };
  return { home, sh, repo, omniloop, fails, manifest, gone };
}

test("rename moves the folder, worktree and branch; the old name links to it; tasks and goals edit", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  s.omniloop("new", "first", "--goal", "g1", "--dir", r, "--no-lead");
  s.omniloop("new", "crud", "--goal", "make crud", "--dir", r, "--no-lead");
  assert.equal(s.manifest("crud").dirs[0].branch, "crud/work");
  s.omniloop("task", "add", "write it", "--for", "you", "--loop", "crud");
  s.omniloop("task", "add", "test it", "--for", "you", "--loop", "crud");

  const out = s.omniloop("rename", "crud", "edit");
  assert.match(out, /renamed crud to edit/);
  const m = s.manifest("edit");
  assert.equal(m.id, "edit");
  assert.equal(m.dirs[0].worktree, join(s.home, "loops/edit/wt/app"));
  assert.equal(m.dirs[0].branch, "edit/work");
  assert.deepEqual(m.formerly.map((f) => f.id), ["crud"]);
  assert.ok(lstatSync(join(s.home, "loops/crud")).isSymbolicLink());
  assert.equal(s.sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], m.dirs[0].worktree).trim(), "edit/work");
  assert.match(s.sh("git", ["worktree", "list"], r), /loops\/edit\/wt\/app\s+\w+ \[edit\/work\]/);
  const md = readFileSync(join(s.home, "loops/edit/CLAUDE.md"), "utf8");
  assert.match(md, /^# Loop: edit/);
  assert.match(md, /\*\*Formerly `crud`\*\*/);
  assert.match(md, /loops\/edit\/wt\/app/);
  assert.doesNotMatch(md, /omniloop ls crud/);
  // The alias isn't a second loop; the old name is free again for `new`.
  assert.equal(JSON.parse(s.omniloop("index")).filter((x) => x.id === "crud").length, 0);

  s.omniloop("task", "edit", "1", "write it well", "--loop", "edit");
  s.omniloop("task", "done", "2", "--loop", "edit");
  s.omniloop("task", "reopen", "2", "--loop", "edit");
  assert.match(s.omniloop("task", "move", "2", "first", "--loop", "edit"), /now first task 1/);
  const tasks = JSON.parse(readFileSync(join(s.home, "loops/edit/tasks.json"), "utf8")).tasks;
  assert.deepEqual(tasks.map((t) => [t.n, t.text, Boolean(t.done)]), [[1, "write it well", false]]);
  s.omniloop("task", "rm", "1", "--loop", "edit");
  assert.equal(JSON.parse(readFileSync(join(s.home, "loops/edit/tasks.json"), "utf8")).tasks.length, 0);
  s.omniloop("goal", "edit", "1", "make crud, all of it", "--loop", "edit");
  assert.equal(s.manifest("edit").goal, "make crud, all of it");
  assert.match(readFileSync(join(s.home, "loops/edit/feed.jsonl"), "utf8"), /loop renamed: crud → edit/);

  s.omniloop("new", "crud", "--goal", "again", "--no-lead");
  assert.equal(s.manifest("crud").id, "crud");
  assert.ok(!lstatSync(join(s.home, "loops/crud")).isSymbolicLink());
});

test("rm refuses unmerged work, then removes the loop and its worktree but never the repo", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  s.omniloop("new", "first", "--goal", "g1", "--dir", r, "--no-lead");
  s.omniloop("new", "doomed", "--goal", "g2", "--dir", r, "--no-lead");
  const wt = s.manifest("doomed").dirs[0].worktree;
  writeFileSync(join(wt, "b.txt"), "b\n");
  assert.match(s.fails("rm", "doomed"), /uncommitted/);
  s.sh("git", ["add", "."], wt); s.sh("git", ["commit", "-qm", "b"], wt);
  assert.match(s.fails("rm", "doomed"), /1 commit\(s\) not merged/);
  s.sh("git", ["merge", "-q", "--ff-only", "doomed/work"], r);
  // hc is down (fake): members can't be checked, so it needs --force.
  assert.match(s.fails("rm", "doomed"), /herdr-core/);
  const out = s.omniloop("rm", "doomed", "--force");
  assert.match(out, /loop doomed deleted/);
  assert.match(out, /deleted branch doomed\/work \(merged\)/);
  assert.ok(await s.gone(join(s.home, "loops/doomed")));
  assert.ok(!existsSync(wt));
  assert.ok(existsSync(join(r, "b.txt")), "the context repo is untouched");
  assert.ok(existsSync(join(s.home, "loops/first/loop.json")));
  assert.match(s.fails("rm", "nope"), /no loop nope/);
});

test("a temporary loop keeps no memory: no Engram in CLAUDE.md, and rm purges transcripts and history", async () => {
  const s = sandbox();
  const out = s.omniloop("new", "--temp", "--no-lead");
  const id = out.match(/temporary loop (tmp-[a-z0-9-]+)/)[1];
  const home = join(s.home, "loops", id);
  assert.equal(s.manifest(id).temp, true);
  const md = readFileSync(join(home, "CLAUDE.md"), "utf8");
  assert.match(md, /Temporary loop: no memory/);
  assert.doesNotMatch(md, /engram ingest --event-id/);
  // What Claude Code would have saved for a session in it.
  const sid = "26fa1055-269f-4ed4-882a-912677cf56d3";
  const proj = join(s.home, ".claude/projects", claudeProjectKey(home));
  mkdirSync(proj, { recursive: true }); writeFileSync(join(proj, `${sid}.jsonl`), "{}\n");
  const other = join(s.home, ".claude/projects", claudeProjectKey(home) + "-other"); mkdirSync(other, { recursive: true });
  mkdirSync(join(s.home, ".claude/file-history", sid), { recursive: true });
  writeFileSync(join(s.home, ".claude/history.jsonl"), [JSON.stringify({ display: "secret", project: home }), JSON.stringify({ display: "keep", project: "/elsewhere" })].join("\n") + "\n");
  s.omniloop("rm", id, "--force");
  assert.ok(await s.gone(home));
  assert.ok(await s.gone(proj));
  assert.ok(!existsSync(join(s.home, ".claude/file-history", sid)));
  assert.ok(existsSync(other), "another project's folder stays");
  const hist = readFileSync(join(s.home, ".claude/history.jsonl"), "utf8");
  assert.doesNotMatch(hist, /secret/);
  assert.match(hist, /keep/);
});
