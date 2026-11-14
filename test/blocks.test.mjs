// Managed blocks in CLAUDE.md: replaceBlock and the three callers (context, goal, projects). Pure, plus one CLI check
// under a temp HOME. Paths are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceBlock } from "../core/blocks.js";
import { claudeMd, updateClaudeMd, newManifest } from "../core/loopdir.js";
import { withGoalBlock, goalBlock } from "../core/goals.js";
import { withProjectsBlock, PROJECTS_START, PROJECTS_END } from "../core/projects.js";

const S = "<!-- omniloop:x -->", E = "<!-- /omniloop:x -->";
const append = (t, b) => `${t}\n${b}\n`;

test("replaceBlock: only what is between the markers changes; every byte outside stays", () => {
  const before = "head \r\n\n  indented  \n", after = "\n\ntail with $& and $1\n";
  const r = replaceBlock(`${before}${S}\nold\n${E}${after}`, S, E, `${S}\nnew $&\n${E}`, append);
  assert.equal(r.text, `${before}${S}\nnew $&\n${E}${after}`);
  assert.equal(r.note, null);
});

test("replaceBlock: no markers inserts at the anchor", () => {
  assert.equal(replaceBlock("a\n", S, E, "B", append).text, "a\n\nB\n");
});

for (const [name, text] of [
  ["a lone start marker", `top\n${S}\nrest\n`],
  ["a lone end marker", `top\n${E}\nrest\n`],
  ["a duplicated pair", `${S}\na\n${E}\nmid\n${S}\nb\n${E}\n`],
  ["markers in the wrong order", `${E}\nmid\n${S}\n`],
]) {
  test(`replaceBlock: ${name} leaves the text unchanged with a note`, () => {
    const r = replaceBlock(text, S, E, "NEW", () => assert.fail("must not insert"));
    assert.equal(r.text, text);
    assert.match(r.note, /CLAUDE\.md x block markers are damaged: left alone/);
  });
}

for (const [name, text] of [
  ["a marker quoted mid-line", `Use the ${S} marker to start.\n`],
  ["a quoted pair mid-line", `see \`${S}\` and \`${E}\`\n`],
]) {
  test(`replaceBlock: ${name} is not damage, the block is inserted`, () => {
    const r = replaceBlock(text, S, E, `${S}\nNEW\n${E}`, append);
    assert.equal(r.text, `${text}\n${S}\nNEW\n${E}\n`);
    assert.equal(r.note, null);
  });
}

test("replaceBlock: a body with marker lines inside is defused and refreshes cleanly twice", () => {
  const body = `${S}\nhello\n${E}\n${S}\n${S}\nbye\n<!-- /omniloop:other -->\n${E}`;
  const once = replaceBlock("top\n", S, E, body, append);
  assert.equal(once.note, null);
  const twice = replaceBlock(once.text, S, E, body, append);
  assert.equal(twice.note, null);
  assert.equal(twice.text, once.text);
  assert.ok(once.text.includes(` ${E}\n`) && once.text.includes(" <!-- /omniloop:other -->"));
});

test("withProjectsBlock: a project text holding the projects end marker alone on a line refreshes cleanly twice", () => {
  const ctx = [{ name: "s", text: `intro\n${PROJECTS_END}\nmore` }];
  const once = withProjectsBlock("# T\n", ctx);
  const notes = [];
  assert.equal(withProjectsBlock(once, ctx, notes), once);
  assert.deepEqual(notes, []);
});

test("a hand note quoting the work marker mid-line still lets the work block be added", () => {
  const md = claudeMd(m).replace(/<!-- omniloop:work -->[\s\S]*?<!-- \/omniloop:work -->\n*/, "") + `\nSee <!-- omniloop:work --> here.\n`;
  const notes = [];
  const out = updateClaudeMd(md, m, notes);
  assert.deepEqual(notes, []);
  assert.match(out, /^<!-- omniloop:work -->$/m);
  assert.match(out, /See <!-- omniloop:work --> here\./);
});

test("replaceBlock: a mid-line quote does not stop a clean pair from being replaced", () => {
  const text = `say ${S} in prose\n${S}\nold\n${E}\n`;
  assert.equal(replaceBlock(text, S, E, `${S}\nnew\n${E}`, append).text, `say ${S} in prose\n${S}\nnew\n${E}\n`);
});

const m = newManifest({ id: "q", goal: "g", dirs: ["/home/jane/repos/app"] });

test("updateClaudeMd, withGoalBlock, withProjectsBlock: damaged markers leave the text alone and add a note", () => {
  const md = claudeMd(m);
  const hurt = (marker) => md.replace(marker, "");
  const ctx = hurt("<!-- /omniloop:context -->");
  const n1 = []; assert.equal(updateClaudeMd(ctx, m, n1), ctx); assert.match(n1[0], /context block markers are damaged/);
  const g = withGoalBlock(md, m).replace("<!-- /omniloop:goal -->", "");
  const n2 = []; assert.equal(withGoalBlock(g, m, n2), g); assert.match(n2[0], /goal block markers are damaged/);
  const p = withProjectsBlock(md, [{ name: "s", text: "hi" }]).replace(PROJECTS_END, "");
  const n3 = []; assert.equal(withProjectsBlock(p, [], n3), p); assert.match(n3[0], /projects block markers are damaged/);
  const dup = `${md}\n${PROJECTS_START}\n${PROJECTS_END}\n${PROJECTS_START}\n${PROJECTS_END}\n`;
  const n4 = []; assert.equal(withProjectsBlock(dup, [], n4), dup); assert.equal(n4.length, 1);
});

test("the three blocks keep every byte outside them, in any order of rewriting", () => {
  let md = withProjectsBlock(withGoalBlock(claudeMd(m), m), [{ name: "s", text: "FIRST" }]);
  md = md.replace("## Decisions", "Hand note: <!-- omniloop:goal --> quoted.\n\n## Decisions");
  const next = newManifest({ id: "q", goal: "other", dirs: [] });
  const out = withProjectsBlock(withGoalBlock(updateClaudeMd(md, next), next), [{ name: "s", text: "SECOND" }]);
  assert.match(out, /Hand note: <!-- omniloop:goal --> quoted\./);
  assert.match(out, /SECOND/); assert.doesNotMatch(out, /FIRST/);
  assert.equal(updateClaudeMd(out, next), out, "context rewrite is idempotent");
  assert.equal(withGoalBlock(out, next), out);
  assert.ok(out.includes(goalBlock(next)));
});

test("old format: a lone **Goal:** line becomes the block, a heading gets one, projects go after the context block", () => {
  assert.equal(withGoalBlock("# T\n\n**Goal:** old\n\nrest", m).includes("**Goal:** old"), false);
  assert.match(withGoalBlock("# T\n\nrest", m), /^# T\n\n<!-- omniloop:goal -->/);
  assert.match(withGoalBlock("rest", m), /^<!-- omniloop:goal -->/);
});

test("CLI: an unreadable CLAUDE.md is left alone with a note, never regenerated", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omniloop-blocks-")));
  const fake = join(home, "fakebin"); mkdirSync(fake);
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake, n), "#!/bin/sh\nexit 1\n"); chmodSync(join(fake, n), 0o755); }
  const env = { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, OMNILOOP_HOME: join(home, ".cache", "omniloop"), HC_TERMINAL_ID: "" };
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");
  const run = (...a) => spawnSync("node", [bin, ...a], { cwd: home, env, encoding: "utf8" });
  const a = join(home, "repos/a"), b = join(home, "repos/b");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  assert.equal(run("new", "demo", "--goal", "g", "--dir", a, "--no-coordinator").status, 0);
  const md = join(home, "loops/demo/CLAUDE.md");
  writeFileSync(md, readFileSync(md, "utf8") + "\nmine\n");
  chmodSync(md, 0o000);                       // present but unreadable: not ENOENT
  const r = run("add-dir", b, "--loop", "demo");
  chmodSync(md, 0o644);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /CLAUDE\.md can't be read \(EACCES\): left alone/);
  assert.match(readFileSync(md, "utf8"), /\nmine\n$/);
  assert.doesNotMatch(readFileSync(md, "utf8"), new RegExp(b));
});

test("CLI: a goal quoting a marker still gets a goal block, and goal set updates it", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omniloop-blocks-")));
  const fake = join(home, "fakebin"); mkdirSync(fake);
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake, n), "#!/bin/sh\nexit 1\n"); chmodSync(join(fake, n), 0o755); }
  const env = { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, OMNILOOP_HOME: join(home, ".cache", "omniloop"), HC_TERMINAL_ID: "" };
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");
  const run = (...a) => spawnSync("node", [bin, ...a], { cwd: home, env, encoding: "utf8" });
  const r = run("new", "gm", "--goal", "fix parsing of <!-- omniloop:goal --> markers", "--no-coordinator");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr + r.stdout, /damaged/);
  const md = join(home, "loops/gm/CLAUDE.md");
  assert.match(readFileSync(md, "utf8"), /^<!-- omniloop:goal -->$/m);
  const g = run("goal", "set", "ship it", "--loop", "gm");
  assert.equal(g.status, 0, g.stderr);
  assert.doesNotMatch(g.stderr, /damaged/);
  assert.match(readFileSync(md, "utf8"), /ship it/);
});
