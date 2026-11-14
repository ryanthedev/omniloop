// omniloop bootstrap refreshes a loop's CLAUDE.md: managed blocks only, never through a symlink, never when unchanged;
// --all and --dry-run. All under a temporary HOME (fake hc/herdr-app); paths are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync, symlinkSync, statSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omniloop-bsmd-")));
  const fake = join(home, "fakebin"); mkdirSync(fake);
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake, n), "#!/bin/sh\nexit 1\n"); chmodSync(join(fake, n), 0o755); }
  const env = { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, OMNILOOP_HOME: join(home, ".cache", "omniloop"), HC_TERMINAL_ID: "" };
  const run = (...a) => spawnSync("node", [BIN, ...a], { cwd: home, env, encoding: "utf8" });
  const ok = (...a) => { const r = run(...a); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const dir = join(home, "repos/app"); mkdirSync(dir, { recursive: true });
  const loop = (id) => join(home, "loops", id);
  const make = (id) => { ok("new", id, "--goal", "g", "--dir", dir, "--no-coordinator"); return join(loop(id), "CLAUDE.md"); };
  return { home, run, ok, make, loop };
}

/** The text with every managed block cut out: what the loop owns. */
const outside = (t) => t.replace(/^<!-- omniloop:(\w+) -->$[\s\S]*?^<!-- \/omniloop:\1 -->$/gm, "<block>");

test("a hand-edited CLAUDE.md keeps every byte outside the managed blocks; stale blocks are rewritten; a second run is quiet", () => {
  const s = sandbox();
  const md = s.make("demo");
  const fresh = readFileSync(md, "utf8");
  const stale = fresh
    .replace("# Loop: demo", "# Loop: demo (my edit)")
    .replace(/(<!-- omniloop:work -->\n)[\s\S]*?(<!-- \/omniloop:work -->)/, "$1STALE WORK\n$2")
    .replace("- **Before a change, say so:**", "- STALE RULE\n- **Before a change, say so:**")
    .replace("## Decisions", "Hand note $& \\1 <!-- omniloop:work --> quoted\n\n## Decisions") + "\n- tail kept\n";
  writeFileSync(md, stale);
  assert.match(s.ok("bootstrap", "demo"), /^bootstrapped demo: wrote CLAUDE\.md\n$/);
  const after = readFileSync(md, "utf8");
  assert.equal(outside(after), outside(stale), "bytes outside the blocks are identical");
  assert.doesNotMatch(after, /STALE/);
  assert.match(after, /Keep tasks current/);
  assert.match(after, /# Loop: demo \(my edit\)/);
  assert.match(s.ok("bootstrap", "demo"), /^bootstrapped demo \(already up to date\)\n$/);
  assert.equal(readFileSync(md, "utf8"), after);
});

test("a missing CLAUDE.md is created from the template; an old one (rule as plain text) gets the work block", () => {
  const s = sandbox();
  const md = s.make("demo");
  const fresh = readFileSync(md, "utf8");
  rmSync(md);
  assert.match(s.ok("bootstrap", "demo"), /wrote CLAUDE\.md/);
  assert.equal(readFileSync(md, "utf8"), fresh);
  writeFileSync(md, fresh.replace(/<!-- \/?omniloop:work -->\n?/g, ""));
  s.ok("bootstrap", "demo");
  assert.equal(readFileSync(md, "utf8"), fresh);
});

test("damaged markers: a note saying 'left alone', the file unchanged", () => {
  const s = sandbox();
  const md = s.make("demo");
  const hurt = readFileSync(md, "utf8").replace("<!-- /omniloop:context -->", "").replace("<!-- omniloop:goal -->", "<!-- omniloop:goal -->\n<!-- omniloop:goal -->");
  writeFileSync(md, hurt);
  const out = s.ok("bootstrap", "demo");
  assert.match(out, /CLAUDE\.md context block markers are damaged: left alone/);
  assert.match(out, /CLAUDE\.md goal block markers are damaged: left alone/);
  assert.equal(readFileSync(md, "utf8"), hurt);
});

test("an unreadable CLAUDE.md is left alone, not regenerated", { skip: process.getuid?.() === 0 }, () => {
  const s = sandbox();
  const md = s.make("demo");
  writeFileSync(md, "mine only\n"); chmodSync(md, 0o000);
  let out;
  try { out = s.ok("bootstrap", "demo"); } finally { chmodSync(md, 0o644); }
  assert.match(out, /CLAUDE\.md can't be read \(EACCES\): left alone/);
  assert.equal(readFileSync(md, "utf8"), "mine only\n");
});

test("CLAUDE.md that is a symlink: the target is untouched", () => {
  const s = sandbox();
  const md = s.make("demo");
  const target = join(s.home, "elsewhere.md");
  writeFileSync(target, "outside\n");
  rmSync(md); symlinkSync(target, md);
  assert.match(s.ok("bootstrap", "demo"), /CLAUDE\.md is a symlink: left alone/);
  assert.equal(readFileSync(target, "utf8"), "outside\n");
  assert.ok(lstatSync(md).isSymbolicLink());
});

test("--dry-run reports what would change and writes nothing (no CLAUDE.md, no settings, no temp files)", () => {
  const s = sandbox();
  const md = s.make("demo");
  const stale = readFileSync(md, "utf8").replace(/(<!-- omniloop:work -->\n)[\s\S]*?(<!-- \/omniloop:work -->)/, "$1STALE\n$2");
  writeFileSync(md, stale);
  const before = statSync(md).mtimeMs;
  rmSync(join(s.loop("demo"), ".claude/settings.json"));
  const out = s.ok("bootstrap", "demo", "--dry-run");
  assert.match(out, /^would bootstrap demo: would write \.claude\/settings\.json; would write CLAUDE\.md\n$/);
  assert.equal(readFileSync(md, "utf8"), stale);
  assert.equal(statSync(md).mtimeMs, before);
  assert.ok(!existsSync(join(s.loop("demo"), ".claude/settings.json")));
  assert.deepEqual(readdirSync(s.loop("demo")).filter((n) => n.endsWith(".tmp")), []);
  rmSync(md);
  assert.match(s.ok("bootstrap", "demo", "--dry-run"), /would write CLAUDE\.md/);
  assert.ok(!existsSync(md));
});

test("--all covers every real loop folder, one line each, skipping a rename's old-name link; a broken loop is a note", () => {
  const s = sandbox();
  s.make("aa"); s.make("bb"); s.make("old");
  s.ok("rename", "old", "cc");
  assert.ok(lstatSync(s.loop("old")).isSymbolicLink());
  mkdirSync(s.loop("broken")); writeFileSync(join(s.loop("broken"), "loop.json"), "{nope");
  mkdirSync(s.loop("nodirs")); writeFileSync(join(s.loop("nodirs"), "loop.json"), '{"id":"nodirs"}');
  writeFileSync(join(s.home, "loops/config.json"), "{}");
  const r = s.run("bootstrap", "--all");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.deepEqual(lines.map((l) => l.match(/^(?:bootstrapped )?(\w+)/)[1]), ["aa", "bb", "broken", "cc", "nodirs"]);
  assert.match(lines[0], /^bootstrapped aa \(already up to date\)$/);
  assert.match(lines[2], /^broken: loop\.json can't be used .*left alone$/);
  assert.match(lines[4], /^nodirs: .*left alone$/);
  for (const bad of ["broken", "nodirs"]) assert.deepEqual(readdirSync(s.loop(bad)), ["loop.json"]);
  assert.equal(s.run("bootstrap", "--all", "aa").status, 1);
});

test("a single loop with a broken loop.json or without dirs is a printed note, exit 0 (was: crash on 'filter')", () => {
  const s = sandbox();
  mkdirSync(s.loop("nodirs"), { recursive: true }); writeFileSync(join(s.loop("nodirs"), "loop.json"), '{"id":"nodirs","goal":"g"}');
  const r = s.run("bootstrap", "nodirs");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^nodirs: .*left alone/);
  assert.doesNotMatch(r.stderr, /filter/);
  writeFileSync(join(s.loop("nodirs"), "loop.json"), "[1,");
  assert.match(s.ok("bootstrap", "nodirs"), /loop\.json can't be used/);
  assert.equal(s.run("bootstrap", "nosuch").status, 1);
});

test("a loop's projects keep their CONTEXT.md in the projects block through bootstrap", () => {
  const s = sandbox();
  const p = join(s.home, "loops/projects/study"); mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "project.json"), JSON.stringify({ name: "study" }));
  writeFileSync(join(p, "CONTEXT.md"), "## Study project\nmade-up notes\n");
  const md = s.make("demo");
  const j = join(s.loop("demo"), "loop.json");
  writeFileSync(j, JSON.stringify({ ...JSON.parse(readFileSync(j, "utf8")), projects: ["study"] }));
  assert.match(s.ok("bootstrap", "demo"), /wrote CLAUDE\.md/);
  assert.match(readFileSync(md, "utf8"), /<!-- omniloop:projects -->[\s\S]*made-up notes[\s\S]*<!-- \/omniloop:projects -->/);
  assert.match(s.ok("bootstrap", "demo"), /already up to date/);
  writeFileSync(join(p, "CONTEXT.md"), "## Study project\nnew notes\n");
  s.ok("bootstrap", "demo");
  assert.match(readFileSync(md, "utf8"), /new notes/);
  assert.doesNotMatch(readFileSync(md, "utf8"), /made-up notes/);
});

test("bootstrap --all skips a folder with no loop.json silently, but notes a broken loop.json", () => {
  const s = sandbox();
  s.make("real");
  mkdirSync(join(s.home, "loops/projects"));
  mkdirSync(join(s.home, "loops/broken"));
  writeFileSync(join(s.home, "loops/broken/loop.json"), "{nope");
  const out = s.ok("bootstrap", "--all");
  assert.match(out, /real/);
  assert.doesNotMatch(out, /projects/);
  assert.match(out, /broken: loop\.json can't be used \(not valid JSON\): left alone/);
});
