// End to end: rename, task and folder changes, rm and temporary loops through the real CLI, under a temporary HOME
// (so ~/loops and ~/.claude are temporary too) with fake `hc` and `herdr-app` that always fail, so nothing reaches
// the real herdr-core or the Herdr app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, lstatSync, chmodSync, rmSync, renameSync, symlinkSync } from "node:fs";
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
  // hc that answers `ls` with no terminals, so rm without --force can see there are no running agents.
  const hcIdle = () => writeFileSync(join(fake, "hc"), '#!/bin/sh\n[ "$1" = ls ] && { echo \'{"terminals":[]}\'; exit 0; }\nexit 1\n');
  return { home, sh, repo, omniloop, fails, manifest, gone, hcIdle };
}

test("rename moves the folder, worktree and branch; the old name links to it; tasks and goals edit", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  s.omniloop("new", "first", "--goal", "g1", "--dir", r, "--no-coordinator");
  s.omniloop("new", "crud", "--goal", "make crud", "--dir", r, "--no-coordinator");
  assert.equal(s.manifest("crud").dirs[0].branch, "crud/work");
  s.omniloop("task", "add", "write it", "--for", "you", "--loop", "crud");
  s.omniloop("task", "add", "test it", "--for", "you", "--loop", "crud");

  const ckey = (id) => join(s.home, ".claude/projects", claudeProjectKey(join(s.home, "loops", id)));
  mkdirSync(ckey("crud"), { recursive: true }); writeFileSync(join(ckey("crud"), "s.jsonl"), "{}\n");
  const out = s.omniloop("rename", "crud", "edit");
  assert.ok(lstatSync(ckey("crud")).isSymbolicLink(), "running sessions keep writing to the moved transcripts");
  assert.ok(existsSync(join(ckey("edit"), "s.jsonl")));
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

  s.omniloop("new", "crud", "--goal", "again", "--no-coordinator");
  assert.equal(s.manifest("crud").id, "crud");
  assert.ok(!lstatSync(join(s.home, "loops/crud")).isSymbolicLink());
  assert.ok(!existsSync(ckey("crud")) || !lstatSync(ckey("crud")).isSymbolicLink(), "the new crud's sessions don't land in edit's transcripts");
  assert.ok(existsSync(join(ckey("edit"), "s.jsonl")));
});

test("rm refuses unmerged work, then removes the loop and its worktree but never the repo", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  s.omniloop("new", "first", "--goal", "g1", "--dir", r, "--no-coordinator");
  s.omniloop("new", "doomed", "--goal", "g2", "--dir", r, "--no-coordinator");
  const wt = s.manifest("doomed").dirs[0].worktree;
  writeFileSync(join(wt, "b.txt"), "b\n");
  assert.match(s.fails("rm", "doomed"), /uncommitted/);
  s.sh("git", ["add", "."], wt); s.sh("git", ["commit", "-qm", "b"], wt);
  assert.match(s.fails("rm", "doomed"), /1 commit\(s\) not merged/);
  s.sh("git", ["merge", "-q", "--ff-only", "doomed/work"], r);
  // hc is down (fake): agents can't be checked, so it needs --force.
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
  const out = s.omniloop("new", "--temp", "--no-coordinator");
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

test("--no-lead and --lead still work as aliases of --no-coordinator and --coordinator", () => {
  const s = sandbox();
  // --no-lead: the loop is made and no coordinator is started (the fake hc would fail it otherwise)
  s.omniloop("new", "old-flag", "--goal", "g", "--no-lead");
  s.omniloop("new", "new-flag", "--goal", "g", "--no-coordinator");
  assert.equal(s.manifest("old-flag").goal, s.manifest("new-flag").goal);
  // --lead on start: the labels carry both the new and the old coordinator key, and the loop's CLAUDE.md template is used
  for (const flag of ["--lead", "--coordinator"]) {
    const dry = JSON.parse(s.omniloop("start", "new-flag", flag, "--dry-run", "--", "sh", "-c", "true"));
    assert.ok(dry.hc.includes("omniloop.coordinator=1") && dry.hc.includes("omniloop.lead=1"), flag);
    assert.ok(!dry.hc.some((a) => a.startsWith("omniloop.to=")), `${flag}: a coordinator reports to you`);
  }
  assert.match(s.fails("new", "BAD id"), /--no-coordinator/);
});

test("the coordinator's starting prompt says coordinate, and the command still prints 'coordinator <t> in space <id>' form", () => {
  const s = sandbox();
  const out = s.omniloop("new", "prompted", "--goal", "do it", "--dry-run");
  assert.match(out, /You coordinate the loop prompted/);
  assert.doesNotMatch(out, /You lead/);
});

// ---- rm, rm-dir and rename over the git checkouts found inside a loop folder (bin/lib/checkouts.mjs) ----

// A worktree an agent made by hand inside the loop folder, with uncommitted work and an unmerged commit.
function handMade(s, r, id, name = "x") {
  s.omniloop("new", "first", "--goal", "g1", "--dir", r, "--no-coordinator");
  s.omniloop("new", id, "--goal", "g2", "--dir", r, "--no-coordinator");
  const wt = join(s.home, "loops", id, "wt", name);
  s.sh("git", ["-C", r, "worktree", "add", "-q", "-b", `hand-${name}`, wt]);
  writeFileSync(join(wt, "c.txt"), "c\n"); s.sh("git", ["add", "."], wt); s.sh("git", ["commit", "-qm", "c"], wt);
  writeFileSync(join(wt, "wip.txt"), "uncommitted\n");
  return wt;
}
const listed = (s, r) => s.sh("git", ["-C", r, "worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
const branchExists = (s, r, b) => { try { s.sh("git", ["-C", r, "rev-parse", "--verify", b]); return true; } catch { return false; } };
// The recorded worktree of a loop made with --dir (omniloop's own, wt/<repo name>).
const recorded = (s, r, id) => { s.omniloop("new", `first-${id}`, "--goal", "g1", "--dir", r, "--no-coordinator"); s.omniloop("new", id, "--goal", "g2", "--dir", r, "--no-coordinator"); return s.manifest(id).dirs[0].worktree; };

test("R1: rm checks a hand-made worktree from disk: refuses with its work in place; --force removes it, keeps the unmerged branch, leaves others' worktrees", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const wt = handMade(s, r, "doomed");
  // A worktree of the same repo outside the loop folder, and one in a folder whose name starts like the loop's.
  const other = join(s.home, "elsewhere", "o"), near = join(s.home, "loops", "doomed-2", "wt", "n");
  s.sh("git", ["-C", r, "worktree", "add", "-q", "-b", "other", other]);
  s.sh("git", ["-C", r, "worktree", "add", "-q", "-b", "near", near]);
  writeFileSync(join(other, "keep.txt"), "k\n");

  assert.match(s.fails("rm", "doomed", "--dry-run"), /uncommitted file/);
  const err = s.fails("rm", "doomed");
  assert.match(err, /uncommitted/);
  assert.match(err, /hand-x has 1 commit\(s\) not merged/);
  assert.ok(existsSync(join(wt, "wip.txt")), "refused: the file is still there");
  assert.ok(listed(s, r).includes(wt));

  const out = s.omniloop("rm", "doomed", "--force");
  assert.match(out, /removed worktree .*wt\/x/);
  assert.match(out, /kept branch hand-x/);
  assert.ok(await s.gone(join(s.home, "loops/doomed")));
  assert.ok(branchExists(s, r, "hand-x"), "the unmerged branch is kept");
  assert.deepEqual(listed(s, r).sort(), [r, other, near].sort(), "no repo-wide prune: only its own registration went");
  assert.ok(existsSync(join(other, "keep.txt")), "a worktree outside the loop is never touched");
  assert.ok(existsSync(near), "so is one in a folder with a similar name");
});

test("R1: the same refusal after the worktree's repo moved (git fails inside it: unchecked); --force deletes the folder", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const wt = handMade(s, r, "orphan");
  renameSync(r, `${r}-moved`);
  assert.match(s.fails("rm", "orphan"), /couldn't be checked/);
  assert.ok(existsSync(join(wt, "wip.txt")), "refused: the file is still there");
  s.omniloop("rm", "orphan", "--force");
  assert.ok(await s.gone(join(s.home, "loops/orphan")));
});

test("R1: a loop with empty dirs still has its hand-made worktree checked", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  s.omniloop("new", "bare", "--goal", "g", "--no-coordinator");
  assert.deepEqual(s.manifest("bare").dirs, []);
  const wt = join(s.home, "loops", "bare", "wt", "x");
  s.sh("git", ["-C", r, "worktree", "add", "-q", "-b", "hb", wt]);
  writeFileSync(join(wt, "wip.txt"), "uncommitted\n");
  assert.match(s.fails("rm", "bare"), /uncommitted/);
  assert.ok(existsSync(join(wt, "wip.txt")));
  s.sh("git", ["add", "."], wt); s.sh("git", ["commit", "-qm", "w"], wt);
  assert.match(s.fails("rm", "bare"), /1 commit\(s\) not merged/);
});

test("R1: a symlink inside the loop is not followed; a standalone clone with uncommitted files refuses, a clean one goes with the folder", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  s.omniloop("new", "links", "--goal", "g", "--no-coordinator");
  writeFileSync(join(r, "dirty.txt"), "d\n");
  symlinkSync(r, join(s.home, "loops/links/ref-link"));
  const clone = join(s.home, "loops/links/ref/app");
  mkdirSync(dirname(clone), { recursive: true });
  s.sh("git", ["clone", "-q", "--depth", "1", `file://${r}`, clone]);
  writeFileSync(join(clone, "wip.txt"), "uncommitted\n");
  const err = s.fails("rm", "links");
  assert.match(err, /ref\/app has 1 uncommitted/);
  assert.doesNotMatch(err, /ref-link/, "the repo behind the symlink is not walked");
  rmSync(join(clone, "wip.txt"));
  s.hcIdle();
  s.omniloop("rm", "links");
  assert.ok(await s.gone(join(s.home, "loops/links")));
  assert.ok(existsSync(join(r, "dirty.txt")), "nothing behind the symlink was deleted");
});

test("R1: --force on a detached worktree with unmerged commits prints its HEAD; a locked worktree is refused until --force", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  s.omniloop("new", "first", "--goal", "g1", "--dir", r, "--no-coordinator");
  s.omniloop("new", "det", "--goal", "g2", "--dir", r, "--no-coordinator");
  const wt = join(s.home, "loops", "det", "wt", "d");
  s.sh("git", ["-C", r, "worktree", "add", "-q", "--detach", wt]);
  writeFileSync(join(wt, "c.txt"), "c\n"); s.sh("git", ["add", "."], wt); s.sh("git", ["commit", "-qm", "c"], wt);
  const sha = s.sh("git", ["rev-parse", "HEAD"], wt).trim();
  s.sh("git", ["-C", r, "worktree", "lock", wt]);
  s.hcIdle();
  assert.match(s.fails("rm", "det"), /is locked in git/);
  assert.ok(existsSync(wt));
  const out = s.omniloop("rm", "det", "--force");
  assert.ok(out.includes(sha), out);
  assert.ok(await s.gone(join(s.home, "loops/det")));
  assert.ok(!listed(s, r).includes(wt));
});

test("R2: after rename and a new loop of the old name, rm of the new one leaves the renamed loop's worktree, registration and branch; rm of the renamed one refuses", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const wt = handMade(s, r, "crud");
  s.omniloop("rename", "crud", "edit");
  const editWt = join(s.home, "loops/edit/wt/x");
  assert.ok(existsSync(join(editWt, "wip.txt")));
  s.omniloop("new", "crud", "--goal", "again", "--dir", r, "--no-coordinator");
  assert.ok(!lstatSync(join(s.home, "loops/crud")).isSymbolicLink(), "the old-name link is gone");
  s.hcIdle();
  s.omniloop("rm", "crud");
  assert.ok(await s.gone(join(s.home, "loops/crud")));
  assert.ok(existsSync(join(editWt, "wip.txt")), "edit's hand-made worktree survives");
  assert.ok(listed(s, r).includes(editWt), "and so does its registration");
  assert.ok(branchExists(s, r, "hand-x"), "and its branch");
  assert.ok(!wt.includes("edit"));
  assert.match(s.fails("rm", "edit"), /uncommitted/);
  assert.ok(existsSync(join(editWt, "wip.txt")));
});

test("R3: rename repairs a hand-made worktree inside the moved folder too", () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const old = handMade(s, r, "crud");
  s.omniloop("rename", "crud", "edit");
  const wt = join(s.home, "loops/edit/wt/x");
  assert.match(s.sh("git", ["status", "--porcelain"], wt), /wip\.txt/);
  const l = listed(s, r);
  assert.ok(l.includes(wt), "git's registration follows the move");
  assert.ok(!l.includes(old), "and the old path is gone from it");
  assert.equal(s.sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], wt).trim(), "hand-x");
});

// A copy of someone else's worktree dropped into loop "a" must not take that worktree's registration over.
async function copyThenRenameThenForceRm(s, r, victim) {
  s.omniloop("new", "a", "--goal", "ga", "--dir", r, "--no-coordinator");
  const copy = join(s.home, "loops/a/wt/copy");
  mkdirSync(dirname(copy), { recursive: true });
  s.sh("cp", ["-R", victim, copy]);
  const out = s.omniloop("rename", "a", "a2");
  assert.match(out, /skipped, a copy or move of another worktree/);
  assert.ok(listed(s, r).includes(victim), "rename left the other registration alone");
  s.hcIdle();
  assert.match(s.fails("rm", "a2"), /copy or move of another worktree/);
  assert.ok(existsSync(join(s.home, "loops/a2/wt/copy")), "refused before removing anything");
  s.omniloop("rm", "a2", "--force");
  assert.ok(await s.gone(join(s.home, "loops/a2")));
  assert.match(s.sh("git", ["status", "--porcelain"], victim), /wip\.txt/, "the original still works");
  assert.ok(listed(s, r).includes(victim));
}

test("B1: a cp -r of another loop's worktree survives rename and rm --force without moving that worktree's registration or branch", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const victim = handMade(s, r, "other");
  await copyThenRenameThenForceRm(s, r, victim);
  assert.ok(branchExists(s, r, "hand-x"));
});

test("B1: the same for a copy of a worktree that lives outside ~/loops", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const victim = join(s.home, "elsewhere/wt");
  s.sh("git", ["-C", r, "worktree", "add", "-q", "-b", "outside", victim]);
  writeFileSync(join(victim, "wip.txt"), "uncommitted\n");
  await copyThenRenameThenForceRm(s, r, victim);
  assert.ok(branchExists(s, r, "outside"));
});

test("B2: after mv wt/x wt/y inside a loop, rm refuses before removing anything and rm --force finishes", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const old = handMade(s, r, "mv");
  const wt = s.manifest("mv").dirs[0].worktree;
  const moved = join(dirname(old), "y");
  renameSync(old, moved);
  s.hcIdle();
  const before = listed(s, r);
  assert.match(s.fails("rm", "mv"), /copy or move of another worktree/);
  assert.ok(existsSync(moved) && existsSync(wt), "nothing removed, the recorded worktree included");
  assert.deepEqual(listed(s, r), before);
  s.omniloop("rm", "mv", "--force");
  assert.ok(await s.gone(join(s.home, "loops/mv")));
  assert.ok(branchExists(s, r, "hand-x"), "no branch changed");
  assert.ok(!listed(s, r).includes(wt), "the recorded worktree went through git as usual");
});

test("R4: rm-dir of a subfolder leaves the parent entry's recorded and hand-made worktrees", () => {
  const s = sandbox();
  const r = s.repo("r/app");
  mkdirSync(join(r, "sub"));
  const hand = handMade(s, r, "two");
  s.omniloop("add-dir", join(r, "sub"), "--loop", "two");
  const wt = s.manifest("two").dirs[0].worktree;
  writeFileSync(join(wt, "wip.txt"), "uncommitted\n");
  s.omniloop("rm-dir", join(r, "sub"), "--loop", "two", "--force");
  assert.ok(existsSync(join(wt, "wip.txt")), "app's recorded worktree is untouched");
  assert.ok(existsSync(join(hand, "wip.txt")), "so is the hand-made one");
  assert.ok(listed(s, r).includes(wt) && listed(s, r).includes(hand));
  assert.equal(s.manifest("two").dirs.length, 1);
});

test("R4: rm-dir of the repo itself removes its recorded worktree, lists the hand-made one and leaves it for rm", () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const hand = handMade(s, r, "mine");
  const wt = s.manifest("mine").dirs[0].worktree;
  const out = s.omniloop("rm-dir", r, "--loop", "mine");
  assert.match(out, /removed worktree/);
  assert.ok(!existsSync(wt));
  assert.match(out, new RegExp(`left ${hand}`));
  assert.ok(existsSync(join(hand, "wip.txt")));
  assert.ok(listed(s, r).includes(hand));
  assert.equal(s.manifest("mine").dirs.length, 0);
});

test("R5: rm --auto keeps a temporary loop with a dirty worktree (feed line, printed, exit 0) and still reaps the next one", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const id = (o) => o.match(/temporary loop (tmp-[a-z0-9-]+)/)[1];
  const a = id(s.omniloop("new", "--temp", "--no-coordinator")), b = id(s.omniloop("new", "--temp", "--no-coordinator"));
  const wt = join(s.home, "loops", a, "wt", "x");
  s.sh("git", ["-C", r, "worktree", "add", "-q", "-b", "ha", wt]);
  writeFileSync(join(wt, "wip.txt"), "uncommitted\n");
  s.hcIdle();
  const out = s.omniloop("rm", a, "--auto");
  assert.match(out, new RegExp(`${a} kept: .*uncommitted`));
  assert.match(readFileSync(join(s.home, "loops", a, "feed.jsonl"), "utf8"), /kept: .*uncommitted/);
  assert.ok(existsSync(join(wt, "wip.txt")));
  assert.match(s.omniloop("rm", b, "--auto"), /temporary loop .* deleted/);
  assert.ok(await s.gone(join(s.home, "loops", b)));
  assert.ok(existsSync(join(s.home, "loops", a)));
});

test("with ~/loops reached through a symlink, rm handles the recorded worktree once and succeeds", async () => {
  const s = sandbox();
  mkdirSync(join(s.home, "store/loops"), { recursive: true });
  symlinkSync(join(s.home, "store/loops"), join(s.home, "loops"));
  const r = s.repo("r/app");
  const wt = recorded(s, r, "linked");
  s.sh("git", ["merge", "-q", "--ff-only", "linked/work"], r);
  s.hcIdle();
  const out = s.omniloop("rm", "linked");
  assert.equal(out.split("removed worktree").length - 1, 1, "processed once");
  assert.match(out, /deleted branch linked\/work/);
  assert.doesNotMatch(out, /kept branch/);
  assert.ok(await s.gone(wt));
  assert.deepEqual(listed(s, r), [r]);
});

test("a recorded worktree whose folder is gone needs no --force: its registration and merged branch go, others stay", async () => {
  const s = sandbox();
  const r = s.repo("r/app");
  const wt = recorded(s, r, "lost");
  const away = join(s.home, "loops", "theirs", "wt", "y");
  s.sh("git", ["-C", r, "worktree", "add", "-q", "-b", "theirs", away]);
  rmSync(wt, { recursive: true });
  s.hcIdle();
  s.omniloop("rm", "lost");
  assert.ok(await s.gone(join(s.home, "loops/lost")));
  assert.ok(!listed(s, r).includes(wt));
  assert.ok(!branchExists(s, r, "lost/work"));
  assert.ok(listed(s, r).includes(away), "another loop's worktree survives");
});
