// Harness bootstrap: pure file specs (core/harness.js), the applier , and the CLI end to end
// under a temporary HOME (fake hc/herdr-app). Paths are made up; nothing here touches the real home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, lstatSync, readlinkSync, symlinkSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessFiles, HARNESSES } from "../core/harness.js";
import { bootstrapLoop } from "../bin/lib/harness-apply.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omniloop.mjs");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "omniloop-harness-")));
const manifest = {
  id: "app", dirs: [
    { path: "/home/jane/repos/app", machine: null },
    { path: "/home/jane/repos/lib", machine: null, worktree: "/home/jane/loops/app/wt/lib", branch: "app/work", base: "abc", dirty: 0 },
    { path: "/srv/remote/thing", machine: "box" },
  ],
};
const spec = (p) => harnessFiles(manifest).find((f) => f.path === p);

test("harnessFiles: claude settings and the Codex AGENTS.md link; worktree path replaces the shared one; remote folders excluded", () => {
  assert.deepEqual(harnessFiles(manifest).map((f) => f.path), [".claude/settings.json", "AGENTS.md"]);
  assert.equal(spec("AGENTS.md").link, "CLAUDE.md");
  const j = JSON.parse(spec(".claude/settings.json").merge(null).text);
  assert.deepEqual(j.permissions.additionalDirectories, ["/home/jane/repos/app", "/home/jane/loops/app/wt/lib"]);
  assert.ok(!JSON.stringify(harnessFiles(manifest).map((f) => f.merge?.(null).text)).includes("remote"));
  assert.deepEqual(HARNESSES.map((h) => h.name), ["claude", "codex"]);
});

test("settings merge replaces only additionalDirectories and keeps every other key", () => {
  const cur = JSON.stringify({ theme: "x", permissions: { allow: ["Bash(ls)"], additionalDirectories: ["/old"] } });
  const j = JSON.parse(spec(".claude/settings.json").merge(cur).text);
  assert.equal(j.theme, "x");
  assert.deepEqual(j.permissions.allow, ["Bash(ls)"]);
  assert.equal(j.permissions.additionalDirectories.length, 2);
  const bad = spec(".claude/settings.json").merge("{nope");
  assert.equal(bad.text, "{nope");
  assert.ok(bad.note);
});

const loopIn = (home, name = "app") => { const p = join(home, "loops", name); mkdirSync(p, { recursive: true }); return p; };

test("bootstrapLoop: writes files, AGENTS.md links to CLAUDE.md, a real AGENTS.md is left alone, rerun is quiet", async () => {
  const home = tmp(), loop = loopIn(home);
  const lines = await bootstrapLoop(loop, manifest);
  assert.ok(lines.some((l) => l.includes("AGENTS.md -> CLAUDE.md")));
  assert.equal(readlinkSync(join(loop, "AGENTS.md")), "CLAUDE.md");
  assert.deepEqual(await bootstrapLoop(loop, manifest), []);
  assert.ok(!existsSync(join(loop, ".codex")));
  const loop2 = loopIn(home, "two");
  writeFileSync(join(loop2, "AGENTS.md"), "mine\n");
  const l2 = await bootstrapLoop(loop2, manifest);
  assert.ok(l2.some((l) => l.includes("real file")));
  assert.equal(readFileSync(join(loop2, "AGENTS.md"), "utf8"), "mine\n");
  assert.ok(!lstatSync(join(loop2, "AGENTS.md")).isSymbolicLink());
});

test("AGENTS.md: a link to anywhere but CLAUDE.md is left alone with a note", async () => {
  const loop = loopIn(tmp());
  symlinkSync("elsewhere.md", join(loop, "AGENTS.md"));
  const lines = await bootstrapLoop(loop, manifest);
  assert.ok(lines.some((l) => l.includes("AGENTS.md is a link to elsewhere.md")), lines.join("|"));
  assert.equal(readlinkSync(join(loop, "AGENTS.md")), "elsewhere.md");
});

test("an unreadable .claude/settings.json is left byte-identical with a note; other files still get written", { skip: process.getuid?.() === 0 }, async () => {
  const loop = loopIn(tmp());
  mkdirSync(join(loop, ".claude"));
  const f = join(loop, ".claude/settings.json");
  writeFileSync(f, '{"theme":"x"}\n'); chmodSync(f, 0o000);
  try {
    const lines = await bootstrapLoop(loop, manifest);
    assert.ok(lines.some((l) => l.startsWith(".claude/settings.json can't be read")), lines.join("|"));
    assert.equal(lstatSync(f).mode & 0o777, 0);
    assert.equal(readlinkSync(join(loop, "AGENTS.md")), "CLAUDE.md");
  } finally { chmodSync(f, 0o600); }
  assert.equal(readFileSync(f, "utf8"), '{"theme":"x"}\n');
});

test(".claude being a symlink to a folder outside the loop: the outside file is untouched, a note says why", async () => {
  const home = tmp(), loop = loopIn(home), out = join(home, "outside");
  mkdirSync(out);
  writeFileSync(join(out, "settings.json"), '{"keep":1}\n');
  symlinkSync(out, join(loop, ".claude"));
  const lines = await bootstrapLoop(loop, manifest);
  assert.ok(lines.some((l) => l.includes(".claude is a symlink")), lines.join("|"));
  assert.equal(readFileSync(join(out, "settings.json"), "utf8"), '{"keep":1}\n');
  assert.deepEqual(readdirSync(out), ["settings.json"]);
});

test(".claude/settings.json being a symlink: its target is untouched, no temp file is left", async () => {
  const home = tmp(), loop = loopIn(home), out = join(home, "dots");
  mkdirSync(out); mkdirSync(join(loop, ".claude"));
  writeFileSync(join(out, "s.json"), '{"keep":1}\n');
  symlinkSync(join(out, "s.json"), join(loop, ".claude/settings.json"));
  const lines = await bootstrapLoop(loop, manifest);
  assert.ok(lines.some((l) => l.includes(".claude/settings.json: .claude/settings.json is a symlink")), lines.join("|"));
  assert.equal(readFileSync(join(out, "s.json"), "utf8"), '{"keep":1}\n');
  assert.ok(lstatSync(join(loop, ".claude/settings.json")).isSymbolicLink());
  assert.deepEqual(readdirSync(join(loop, ".claude")), ["settings.json"]);
});

test("a write that fails leaves no temp file; a regular file in place of .claude is a note, not a throw", async () => {
  const loop = loopIn(tmp());
  writeFileSync(join(loop, ".claude"), "not a folder");
  const lines = await bootstrapLoop(loop, manifest);
  assert.ok(lines.some((l) => l.includes(".claude/settings.json")), lines.join("|"));
  assert.equal(readFileSync(join(loop, ".claude"), "utf8"), "not a folder");
  assert.deepEqual(readdirSync(loop).filter((n) => n.endsWith(".tmp")), []);
});

test("an existing settings file keeps its mode when rewritten", async () => {
  const loop = loopIn(tmp());
  mkdirSync(join(loop, ".claude"));
  const f = join(loop, ".claude/settings.json");
  writeFileSync(f, '{"theme":"x"}\n'); chmodSync(f, 0o640);
  await bootstrapLoop(loop, manifest);
  assert.equal(lstatSync(f).mode & 0o777, 0o640);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).theme, "x");
  assert.deepEqual(readdirSync(join(loop, ".claude")), ["settings.json"]);
});

function sandbox() {
  const home = tmp(), fake = join(home, "fakebin");
  mkdirSync(fake);
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake, n), "#!/bin/sh\nexit 1\n"); chmodSync(join(fake, n), 0o755); }
  const env = { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, OMNILOOP_HOME: join(home, ".cache", "omniloop"), HC_TERMINAL_ID: "" };
  const omniloop = (...args) => execFileSync("node", [BIN, ...args], { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { home, omniloop };
}

test("CLI: new, add-dir, rm-dir, rename, bootstrap and rm keep the files in step and never touch ~/.codex", () => {
  const s = sandbox();
  mkdirSync(join(s.home, ".codex"));
  const a = join(s.home, "repos/a"), b = join(s.home, "repos/b");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  s.omniloop("new", "demo", "--goal", "g", "--dir", a, "--no-coordinator");
  const loop = join(s.home, "loops/demo");
  const dirsOf = () => JSON.parse(readFileSync(join(loop, ".claude/settings.json"), "utf8")).permissions.additionalDirectories;
  assert.deepEqual(dirsOf(), [a]);
  assert.equal(readlinkSync(join(loop, "AGENTS.md")), "CLAUDE.md");
  s.omniloop("add-dir", b, "--loop", "demo");
  assert.deepEqual(dirsOf(), [a, b]);
  s.omniloop("rm-dir", b, "--loop", "demo");
  assert.deepEqual(dirsOf(), [a]);
  s.omniloop("rename", "demo", "demo2");
  const loop2 = join(s.home, "loops/demo2");
  assert.deepEqual(JSON.parse(readFileSync(join(loop2, ".claude/settings.json"), "utf8")).permissions.additionalDirectories, [a]);
  writeFileSync(join(loop2, ".claude/settings.json"), "{}");
  assert.match(s.omniloop("bootstrap", "demo2"), /bootstrapped demo2: wrote \.claude\/settings\.json/);
  s.omniloop("rm", "demo2", "--force");
  assert.deepEqual(readdirSync(join(s.home, ".codex")), []);
});

test("CLI: without ~/.codex, new succeeds and creates none, in the loop or the home", () => {
  const s = sandbox();
  s.omniloop("new", "plain", "--goal", "g", "--no-coordinator");
  assert.ok(!existsSync(join(s.home, "loops/plain/.codex")));
  assert.ok(!existsSync(join(s.home, ".codex")));
});

test("CLI: a harness failure is a note, never a failed command (.claude is a regular file)", () => {
  const s = sandbox();
  const a = join(s.home, "repos/a"), b = join(s.home, "repos/b");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  const loop = join(s.home, "loops/bad");
  mkdirSync(loop, { recursive: true });
  writeFileSync(join(loop, ".claude"), "not a folder");
  const note = /\.claude\/settings\.json/;
  assert.match(s.omniloop("new", "bad", "--goal", "g", "--dir", a, "--no-coordinator"), new RegExp(`harness config: .*${note.source}`));
  assert.match(s.omniloop("add-dir", b, "--loop", "bad"), /harness config: .*\.claude\/settings\.json/);
  s.omniloop("rm-dir", b, "--loop", "bad");
  s.omniloop("rename", "bad", "bad2");
  assert.match(s.omniloop("bootstrap", "bad2"), new RegExp(`bootstrapped bad2: .*${note.source}`));
  assert.equal(readFileSync(join(s.home, "loops/bad2/.claude"), "utf8"), "not a folder");
});
