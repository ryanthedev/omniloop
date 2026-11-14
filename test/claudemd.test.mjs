// What a loop's CLAUDE.md says: the work block and the gated Git rules in the context block. Pure; made-up paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeMd, updateClaudeMd, newManifest, setWorktree } from "../core/loopdir.js";

const WS = "<!-- omniloop:work -->", WE = "<!-- /omniloop:work -->";
const plain = newManifest({ id: "app", goal: "g", dirs: ["/home/jane/repos/app"] });
const wt = setWorktree(plain, "/home/jane/repos/app", { worktree: "/home/jane/loops/app/wt/app", branch: "app/work", base: "abc1234", dirty: 0, onto: "trunk" });

test("no folders: no git section and no stash rule", () => {
  const md = claudeMd(newManifest({ id: "app", goal: "g" }));
  assert.doesNotMatch(md, /stash/);
  assert.doesNotMatch(md, /### Git/);
});

test("folders without a worktree: the 4 general rules, not the worktree rules", () => {
  const md = claudeMd(plain);
  assert.match(md, /### Git/);
  for (const t of ["Never switch the branch of a folder others use", "No `git stash`", "**Subagents:**", "git clone --depth 1 <url> ref/<name>"]) assert.ok(md.includes(t), t);
  assert.ok(md.includes("git -C <folder> worktree add ~/loops/app/wt/<name> -b app/<topic>"), "the real id, not <id>");
  assert.doesNotMatch(md, /starts bare|Stay on your branch|Leave cleanup/);
});

test("the old bullet and its '(or a `git worktree`)' wording are gone", () => {
  for (const m of [plain, wt]) assert.doesNotMatch(claudeMd(m), /In a git repo, use your own copy|or a `git worktree`/);
});

test("a worktree adds the 3 worktree rules and names the branch to land on", () => {
  const md = claudeMd(wt);
  assert.match(md, /No `git stash`/);
  for (const t of ["Your copy starts bare", "Stay on your branch", "Leave cleanup to `omniloop rm` and `rm-dir`"]) assert.ok(md.includes(t), t);
  assert.match(md, /`git -C \/home\/jane\/repos\/app status`\n  must be clean and on `trunk` before `git -C \/home\/jane\/repos\/app merge --ff-only app\/work`/);
});

test("an older manifest with no onto tells the agent to check the branch first", () => {
  const { onto, ...old } = wt.dirs[0];
  const md = claudeMd({ ...wt, dirs: [old] });
  assert.match(md, /git -C \/home\/jane\/repos\/app branch --show-current/);
  assert.doesNotMatch(md, /and on `/);
});

test("work block: present, just before the context block, holds the tasks rule; the roster stays outside it", () => {
  const md = claudeMd(plain);
  const a = md.indexOf(WS), b = md.indexOf(WE), c = md.indexOf("<!-- omniloop:context -->");
  assert.ok(a > 0 && b > a && c > b && md.slice(b + WE.length, c) === "\n\n");
  assert.match(md.slice(a, b), /Keep tasks current[\s\S]*Every agent/);
  assert.match(md.slice(0, a), /\*\*Build:\*\* `code-foundations:build-agent`/);
  assert.doesNotMatch(md.slice(0, a) + md.slice(b), /Keep tasks current/);
});

test("updateClaudeMd: an old file gets the work block before the context block, its old copy of the rule moves in", () => {
  const fresh = claudeMd(plain);
  const old = fresh.replace(/<!-- \/?omniloop:work -->\n?/g, "");               // the pre-block template: rule as plain text
  assert.ok(old.includes("Keep tasks current") && !old.includes(WS));
  const out = updateClaudeMd(old, plain);
  assert.equal(out, fresh);
  assert.equal(out.split("Keep tasks current").length, 2, "no duplicate rule");
});

test("updateClaudeMd: managed text changes, hand edits outside the blocks stay, a second pass changes nothing", () => {
  const md = claudeMd(plain).replace("## Decisions", "- 2026: we picked X.\n\n## Decisions").replace("Keep tasks current", "STALE tasks");
  const out = updateClaudeMd(md, wt);
  assert.match(out, /- 2026: we picked X\./);
  assert.match(out, /Keep tasks current/); assert.doesNotMatch(out, /STALE/);
  assert.match(out, /starts bare/);
  assert.equal(updateClaudeMd(out, wt), out);
});
