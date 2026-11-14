import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeProjectKey, isLoopClaudeEntry, renamedManifest, renameText, withFormerlyNote, removeCheck, endedTempLoops, tempId, scrubHistory, TEMP_GRACE_MS, TEMP_ORPHAN_MS } from "../core/lifecycle.js";
import { addTask, finishTask, editTask, reopenTask, removeTask, tasksOf } from "../core/tasks.js";
import { setGoal, addGoal, editGoal, openGoals } from "../core/goals.js";
import { addProject, removeProject } from "../core/projects.js";
import { removeDir, agentArgv, claudeMd, validId } from "../core/loopdir.js";

test("claude project keys and which entries belong to a loop", () => {
  const key = claudeProjectKey("/home/jane/loops/my-loop");
  assert.equal(key, "-home-jane-loops-my-loop");
  assert.equal(claudeProjectKey("/a/b.c_d"), "-a-b-c-d");
  assert.ok(isLoopClaudeEntry(key, key));
  assert.ok(isLoopClaudeEntry(`-private-tmp-claude-501-${key}-26fa1055-269f-4ed4-882a-912677cf56d3-scratchpad`, key));
  assert.ok(!isLoopClaudeEntry(`${key}-2`, key), "another loop whose name starts the same");
  assert.ok(!isLoopClaudeEntry(`-private-tmp-claude-501-${key}-2-26fa1055-269f-4ed4-882a-912677cf56d3-scratchpad`, key));
});

test("renamedManifest moves worktrees with the folder and renames the loop's branch only", () => {
  const m = { id: "a", goal: "g", dirs: [
    { path: "/r/x", machine: null, worktree: "/h/loops/a/wt/x", branch: "a/work", base: "1" },
    { path: "/r/y", machine: null, worktree: "/elsewhere/y", branch: "custom" },
    { path: "/r/z", machine: null },
  ] };
  const n = renamedManifest(m, { from: "a", to: "b", fromHome: "/h/loops/a", toHome: "/h/loops/b", now: 5 });
  assert.equal(n.id, "b");
  assert.deepEqual(n.dirs.map((d) => [d.worktree, d.branch]), [["/h/loops/b/wt/x", "b/work"], ["/elsewhere/y", "custom"], [undefined, undefined]]);
  assert.deepEqual(n.formerly, [{ id: "a", at: 5 }]);
  assert.equal(m.id, "a", "pure");
});

test("renameText fills the template's id slots and leaves everything else, even for an id like omniloop", () => {
  const md = claudeMd({ id: "omniloop", goal: "g", dirs: [] }) + "\n- 2026: we chose omniloop rename over omniloop mv.\n";
  const out = renameText(md, "omniloop", "loops2");
  assert.equal(out, renameText(claudeMd({ id: "omniloop", goal: "g", dirs: [] }), "omniloop", "loops2") + "\n- 2026: we chose omniloop rename over omniloop mv.\n");
  assert.equal(out.replace(/\n- 2026.*\n$/, ""), claudeMd({ id: "loops2", goal: "g", dirs: [] }), "same as a fresh CLAUDE.md for the new id");
  assert.match(out, /<!-- omniloop:context -->/);
  const crud = claudeMd({ id: "crud", goal: "g", dirs: [] });
  assert.equal(renameText(crud, "crud", "edit"), claudeMd({ id: "edit", goal: "g", dirs: [] }));
});

test("a renamed loop's CLAUDE.md says what it was called, once", () => {
  const md = claudeMd({ id: "b", goal: "g", dirs: [] });
  const once = withFormerlyNote(md, "a", "2026-11-13");
  assert.match(once, /## Memory \(Engram\)\n\n.*\n\n- \*\*Formerly `a`\*\*/);
  assert.equal(withFormerlyNote(once, "a", "2026-11-14"), once);
});

test("removeCheck refuses uncommitted or unmerged work unless forced", () => {
  const w = [{ path: "/r/x", worktree: "/h/wt/x", branch: "a/work", dirty: 2, ahead: 1 }];
  const r = removeCheck(w);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.equal(removeCheck(w, { force: true }).ok, true);
  assert.equal(removeCheck([{ ...w[0], dirty: 0, ahead: 0 }]).ok, true);
  const u = [{ path: "/r/x", worktree: "/h/wt/x", dirty: 0, ahead: 0, unchecked: "not a git repository" }];
  assert.match(removeCheck(u).problems[0], /couldn't be checked/);
  assert.equal(removeCheck(u, { force: true }).ok, true);
  assert.match(removeCheck([{ ...u[0], unchecked: null, locked: true }]).problems[0], /locked/);
});

test("temporary loops end once their last agent is gone, or after a day with none", () => {
  const now = 10 * TEMP_ORPHAN_MS;
  const ms = [
    { id: "t1", temp: true, created_ms: now - 10 * 60_000 },
    { id: "t2", temp: true, created_ms: now - 10 * 60_000 },
    { id: "keep", created_ms: 0 },
    { id: "young", temp: true, created_ms: now - 30_000 },
    { id: "orphan", temp: true, created_ms: now - TEMP_ORPHAN_MS - 1 },
  ];
  const seen = new Set();
  assert.deepEqual(endedTempLoops(ms, new Set(["t1", "t2", "young"]), seen, now), ["orphan"]);
  assert.deepEqual(endedTempLoops(ms, new Set(["t2"]), seen, now), ["t1", "orphan"]);
  // a young loop whose agent left at once still gets the grace period
  const s2 = new Set(["young"]);
  assert.deepEqual(endedTempLoops([ms[3]], new Set(), s2, now), []);
  assert.deepEqual(endedTempLoops([ms[3]], new Set(), s2, now - 30_000 + TEMP_GRACE_MS + 1), ["young"]);
});

test("tempId is a valid loop id and avoids taken ones", () => {
  const a = tempId(1794604433768);
  assert.ok(validId(a));
  assert.notEqual(tempId(1794604433768, [a]), a);
});

test("scrubHistory drops lines typed in the loop's folders only", () => {
  const lines = [
    { display: "a", project: "/h/loops/t" }, { display: "b", project: "/h/loops/t/wt/x" },
    { display: "c", project: "/h/loops/t2" }, { display: "d", project: "/r/x" },
  ].map((x) => JSON.stringify(x)).join("\n") + "\nnot json\n";
  const r = scrubHistory(lines, ["/h/loops/t"]);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.text.trim().split("\n").map((l) => { try { return JSON.parse(l).display; } catch { return l; } }), ["c", "d", "not json"]);
});

test("tasks: edit, reopen, remove", () => {
  let f = addTask({}, { text: "one", owner: "you", now: 1 }).file;
  f = addTask(f, { text: "two", owner: "t3", now: 2 }).file;
  f = editTask(f, 1, "  one, reworded ").file;
  assert.equal(tasksOf(f)[0].text, "one, reworded");
  assert.ok(editTask(f, 1, " ").error);
  assert.ok(reopenTask(f, 1).error, "still open");
  f = finishTask(f, 1, { by: "you", now: 3 }).file;
  f = reopenTask(f, 1).file;
  assert.equal(tasksOf(f)[0].done, undefined);
  f = removeTask(f, 1).file;
  assert.deepEqual(tasksOf(f).map((t) => t.n), [2]);
  assert.ok(removeTask(f, 1).error);
  assert.equal(addTask(f, { text: "three", owner: "you", now: 4 }).task.n, 3, "numbers aren't reused");
});

test("goals: edit the current one or another open one", () => {
  let m = setGoal({ id: "x" }, "first", 1).manifest;
  m = addGoal(m, "second", 2).manifest;
  const cur = editGoal(m, 1, "first, better", 3).manifest;
  assert.equal(cur.goal, "first, better");
  assert.equal(cur.goalRev, m.goalRev + 1);
  const other = editGoal(m, 2, "second, better", 3).manifest;
  assert.equal(other.goal, "first");
  assert.deepEqual(openGoals(other).map((g) => g.text), ["first", "second, better"]);
  assert.ok(editGoal(m, 9, "x", 3).error);
  assert.equal(editGoal(m, 1, "first", 3).manifest, m);
});

test("projects and folders can be removed", () => {
  const m = addProject({ id: "x", dirs: [] }, "study");
  assert.deepEqual(removeProject(m, "study").projects, []);
  assert.equal(removeProject(m, "nope"), m);
  const d = { id: "x", dirs: [{ path: "/a", machine: null }, { path: "/a", machine: "box" }, { path: "/b", machine: null }] };
  assert.deepEqual(removeDir(d, "/a").dirs.map((x) => x.path), ["/b"]);
  assert.deepEqual(removeDir(d, "/a", "box").dirs.map((x) => x.machine), [null, null]);
  assert.equal(removeDir(d, "/c"), d);
});

test("a temporary loop's agents start without Engram, and its CLAUDE.md says so", () => {
  const argv = agentArgv({ claudeArgv: ["claude"], dirs: ["/r/x"], task: "go", noMemory: { env: ["ENGRAM_TOKEN"], tools: ["mcp__x__memory_ingest"] } });
  assert.match(argv[2], /unset ENGRAM_TOKEN; /);
  const rest = argv.slice(4);
  assert.deepEqual(rest, ["claude", "go", "--disallowedTools", "mcp__x__memory_ingest", "--add-dir", "/r/x"]);
  assert.doesNotMatch(agentArgv({ claudeArgv: ["claude"] })[2], /unset/);
  const md = claudeMd({ id: "t", goal: "g", dirs: [], temp: true });
  assert.match(md, /Temporary loop: no memory/);
  assert.doesNotMatch(md, /engram ingest --event-id/);
  assert.match(claudeMd({ id: "t", goal: "g", dirs: [] }), /engram ingest --event-id t-/);
});

test("renameText still renames an old-style CLAUDE.md (member of the omniloop `x`)", () => {
  const old = "# Loop: x\n\nYou are a member of the omniloop `x`. Run `omniloop brief`.\n\n| `omniloop ls x` | who is in this loop |\n";
  const out = renameText(old, "x", "y");
  assert.match(out, /^# Loop: y$/m);
  assert.match(out, /You are a member of the omniloop `y`\./);
  assert.match(out, /`omniloop ls y`/);
});
