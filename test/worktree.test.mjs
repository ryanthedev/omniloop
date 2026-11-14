// End to end: `omniloop new --no-coordinator` and `add-dir` against throwaway repos under a temporary HOME (so ~/loops is
// temporary too). Covers the user's rule: a worktree only when another loop already uses the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { worktreeChoice, worktreeTarget, launchDirsOn, dirsOn, setWorktree, newManifest } from "../core/loopdir.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omniloop-wt-")));
  const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", HC_TERMINAL_ID: "" };
  const sh = (cmd, args, cwd = home) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repo = (rel, { commit = true } = {}) => {
    const p = join(home, rel); mkdirSync(p, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], p);
    if (commit) { writeFileSync(join(p, "a.txt"), "a\n"); sh("git", ["add", "."], p); sh("git", ["commit", "-qm", "a"], p); }
    return p;
  };
  const omniloop = (...args) => sh("node", [BIN, ...args]);
  const manifest = (id) => JSON.parse(readFileSync(join(home, "loops", id, "loop.json"), "utf8"));
  return { home, sh, repo, omniloop, manifest };
}

test("worktreeChoice: only shared whole repos with commits, never live config", () => {
  const h = "/h";
  assert.equal(worktreeChoice("/h/r/a", { home: h, top: "/h/r/a", commits: 3, others: ["x"] }).worktree, true);
  assert.equal(worktreeChoice("/h/r/a", { home: h, top: "/h/r/a", commits: 3, others: [] }).worktree, false);
  assert.equal(worktreeChoice("/h/.config", { home: h, top: "/h/.config", commits: 9, others: ["x"] }).worktree, false);
  assert.equal(worktreeChoice("/h/.claude/x", { home: h, top: "/h/.claude/x", commits: 9, others: ["x"] }).worktree, false);
  assert.equal(worktreeChoice("/h/r/a/sub", { home: h, top: "/h/r/a", commits: 3, others: ["x"] }).worktree, false);
  assert.equal(worktreeChoice("/h/r/a", { home: h, top: "/h/r/a", commits: 0, others: ["x"] }).worktree, false);
  assert.equal(worktreeChoice("/h/r/a", { home: h, top: null, commits: 0, others: ["x"] }).worktree, false);
  assert.equal(worktreeTarget("/l/x", "/r/a", ["/l/x/wt/a"]), "/l/x/wt/a-2");
});

test("launch dirs use the worktree; identity (dirsOn) keeps the shared path", () => {
  const m = setWorktree(newManifest({ id: "x", dirs: ["/r/a", "/r/b"] }), "/r/a", { worktree: "/l/x/wt/a", branch: "x/work", base: "abc" });
  assert.deepEqual(launchDirsOn(m), ["/l/x/wt/a", "/r/b"]);
  assert.deepEqual(dirsOn(m), ["/r/a", "/r/b"]);
});

test("omniloop new: first loop stays in place; a second loop on the same repo gets its own worktree", () => {
  const s = sandbox();
  const a = s.repo("repos/app");
  writeFileSync(join(a, "wip.txt"), "uncommitted\n");
  const out1 = s.omniloop("new", "first", "--goal", "g", "--dir", a, "--no-coordinator");
  assert.match(out1, /shared \(no other loop uses it\)/);
  assert.equal(s.manifest("first").dirs[0].worktree, undefined);

  const out2 = s.omniloop("new", "second", "--goal", "g", "--dir", a, "--no-coordinator");
  const d = s.manifest("second").dirs[0];
  assert.equal(d.path, a);
  assert.equal(d.worktree, join(s.home, "loops", "second", "wt", "app"));
  assert.equal(d.branch, "second/work");
  assert.equal(d.dirty, 1);
  assert.ok(existsSync(join(d.worktree, "a.txt")) && !existsSync(join(d.worktree, "wip.txt")));
  assert.match(out2, /own copy .*second\/work \(also used by first\); 1 uncommitted/);
  const md = readFileSync(join(s.home, "loops", "second", "CLAUDE.md"), "utf8");
  assert.match(md, /your own copy is `.*wt\/app`/);
  assert.match(md, /Other loops may work here too/);
});

test("fails soft and skips: no commits, subfolder, not git, live config, branch already exists, dry run", () => {
  const s = sandbox();
  const empty = s.repo("repos/empty", { commit: false });
  const app = s.repo("repos/app");
  const sub = join(app, "pkg"); mkdirSync(sub);
  const plain = join(s.home, "repos", "plain"); mkdirSync(plain, { recursive: true });
  const cfg = s.repo(".config");
  s.omniloop("new", "one", "--goal", "g", "--dir", empty, "--dir", app, "--dir", plain, "--dir", cfg, "--no-coordinator");
  // A branch named like the loop's already exists: it is reused, not an error.
  s.sh("git", ["branch", "two/work"], app);
  const dry = s.omniloop("new", "two", "--goal", "g", "--dir", app, "--dry-run", "--no-coordinator");
  assert.match(dry, /would get its own worktree/);
  const out = s.omniloop("new", "two", "--goal", "g", "--dir", empty, "--dir", sub, "--dir", plain, "--dir", cfg, "--dir", app, "--no-coordinator");
  assert.match(out, /empty: shared \(the repo has no commits yet\)/);
  assert.match(out, /pkg: shared \(inside the repo/);
  assert.match(out, /plain: shared \(not a git repo\)/);
  assert.match(out, /\.config: shared \(live config/);
  const d = s.manifest("two").dirs.find((x) => x.path === app);
  assert.equal(d.branch, "two/work");
  assert.ok(existsSync(join(d.worktree, "a.txt")));
});

test("add-dir: a repo another loop uses gets a worktree; the target name moves aside when taken", () => {
  const s = sandbox();
  const a = s.repo("repos/lib");
  const b = s.repo("other/lib");
  s.omniloop("new", "owner", "--goal", "g", "--dir", a, "--dir", b, "--no-coordinator");
  s.omniloop("new", "late", "--goal", "g", "--no-coordinator");
  s.omniloop("add-dir", a, "--loop", "late");
  s.omniloop("add-dir", b, "--loop", "late");
  const dirs = s.manifest("late").dirs;
  assert.deepEqual(dirs.map((d) => d.worktree), [join(s.home, "loops", "late", "wt", "lib"), join(s.home, "loops", "late", "wt", "lib-2")]);
});
