// Harness bootstrap: pure file specs (core/harness.js), the applier under an injected user home, and the CLI end to end
// under a temporary HOME (fake hc/herdr-app). Paths are made up; nothing here touches the real ~/.codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, lstatSync, readlinkSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessFiles, addTrust as addT, removeTrust as removeT, moveTrust as moveT, HARNESSES } from "../core/harness.js";
import { bootstrapLoop, trustLoop } from "../bin/lib/harness-apply.mjs";

// The trust ops return { text, note? }; most tests want the text.
const addTrust = (t, p) => addT(t, p).text, removeTrust = (t, p) => removeT(t, p).text, moveTrust = (t, a, b) => moveT(t, a, b).text;

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

test("harnessFiles: three files; worktree path replaces the shared one; remote folders excluded", () => {
  assert.deepEqual(harnessFiles(manifest).map((f) => f.path), [".claude/settings.json", ".codex/config.toml", "AGENTS.md"]);
  assert.equal(spec("AGENTS.md").link, "CLAUDE.md");
  const j = JSON.parse(spec(".claude/settings.json").merge(null).text);
  assert.deepEqual(j.permissions.additionalDirectories, ["/home/jane/repos/app", "/home/jane/loops/app/wt/lib"]);
  assert.match(spec(".codex/config.toml").merge(null).text, /writable_roots = \["\/home\/jane\/repos\/app", "\/home\/jane\/loops\/app\/wt\/lib"\]/);
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

test("codex config: managed block keeps other content, is replaced in place, and defers to a user's own table", () => {
  const m = spec(".codex/config.toml").merge;
  const first = m('model = "m"\n').text;
  assert.match(first, /^model = "m"\n\n# omniloop:begin/);
  const again = m(first).text;
  assert.equal(again, first);
  assert.equal(m(first.replace("/home/jane/repos/app", "/gone")).text, first);
  const own = '[sandbox_workspace_write]\nnetwork_access = true\n';
  assert.deepEqual(m(own).text, own);
  assert.ok(m(own).note);
});

test("trust: add is idempotent and appends; remove takes only that entry; move repoints in place", () => {
  const base = 'model = "m"\n\n[projects."/home/jane/other"]\ntrust_level = "trusted"\n\n[tui]\ntheme = "x"\n';
  const added = addTrust(base, "/home/jane/loops/app");
  assert.ok(added.startsWith(base));
  assert.equal(addTrust(added, "/home/jane/loops/app"), added);
  assert.equal(removeTrust(added, "/home/jane/loops/app"), base.replace(/\s*$/, "\n"));
  // an entry in the middle: neighbours and their formatting stay
  const mid = base.replace('[tui]', '[projects."/home/jane/loops/app"]\ntrust_level = "untrusted"\n\n# about tui\n[tui]');
  assert.equal(removeTrust(mid, "/home/jane/loops/app"), base.replace("[tui]", "# about tui\n[tui]"));
  assert.equal(removeTrust(base, "/nope"), base);
  const moved = moveTrust(mid, "/home/jane/loops/app", "/home/jane/loops/web");
  assert.equal(moved, mid.replace("loops/app", "loops/web"));
  assert.equal(addTrust("", "/p"), '[projects."/p"]\ntrust_level = "trusted"\n');
  assert.equal(removeTrust(addTrust("", "/p"), "/p"), "");
});

test("bootstrapLoop: writes files, AGENTS.md links to CLAUDE.md, a real AGENTS.md is left alone, rerun is quiet", async () => {
  const home = tmp(), loop = join(home, "loops/app");
  mkdirSync(loop, { recursive: true });
  const lines = await bootstrapLoop(home, loop, manifest);
  assert.ok(lines.some((l) => l.includes("AGENTS.md -> CLAUDE.md")));
  assert.equal(readlinkSync(join(loop, "AGENTS.md")), "CLAUDE.md");
  assert.deepEqual(await bootstrapLoop(home, loop, manifest), []);
  const loop2 = join(home, "loops/two");
  mkdirSync(loop2, { recursive: true });
  writeFileSync(join(loop2, "AGENTS.md"), "mine\n");
  const l2 = await bootstrapLoop(home, loop2, manifest);
  assert.ok(l2.some((l) => l.includes("real file")));
  assert.equal(readFileSync(join(loop2, "AGENTS.md"), "utf8"), "mine\n");
  assert.ok(!lstatSync(join(loop2, "AGENTS.md")).isSymbolicLink());
  // a wrong link is repaired
  const loop3 = join(home, "loops/three");
  mkdirSync(loop3, { recursive: true });
  symlinkSync("elsewhere.md", join(loop3, "AGENTS.md"));
  await bootstrapLoop(home, loop3, manifest);
  assert.equal(readlinkSync(join(loop3, "AGENTS.md")), "CLAUDE.md");
});

test("~/.codex absent: no trust file is created; present: add, remove, move touch only the entry", async () => {
  const home = tmp(), loop = join(home, "loops/app");
  mkdirSync(loop, { recursive: true });
  await bootstrapLoop(home, loop, manifest);
  assert.ok(!existsSync(join(home, ".codex")));
  mkdirSync(join(home, ".codex"));
  const cfg = join(home, ".codex/config.toml");
  writeFileSync(cfg, 'model = "m"   # keep\n[tui]\ntheme="x"\n');
  chmodSync(cfg, 0o600);
  await bootstrapLoop(home, loop, manifest);
  const once = readFileSync(cfg, "utf8");
  assert.ok(once.startsWith('model = "m"   # keep\n[tui]\ntheme="x"\n'));
  assert.ok(once.includes(`[projects."${loop}"]`));
  assert.equal((lstatSync(cfg).mode & 0o777), 0o600);
  assert.deepEqual(await trustLoop(home, loop, "add"), []);
  assert.equal(readFileSync(cfg, "utf8"), once);
  await trustLoop(home, loop, "move", join(home, "loops/web"));
  assert.ok(readFileSync(cfg, "utf8").includes(`[projects."${join(home, "loops/web")}"]`));
  await trustLoop(home, join(home, "loops/web"), "remove");
  assert.equal(readFileSync(cfg, "utf8"), 'model = "m"   # keep\n[tui]\ntheme="x"\n');
  assert.ok(!existsSync(join(home, ".codex", "config.toml.omniloop-" + process.pid + ".tmp")));
});

function sandbox() {
  const home = tmp(), fake = join(home, "fakebin");
  mkdirSync(fake);
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake, n), "#!/bin/sh\nexit 1\n"); chmodSync(join(fake, n), 0o755); }
  const env = { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}`, OMNILOOP_HOME: join(home, ".cache", "omniloop"), HC_TERMINAL_ID: "" };
  const omniloop = (...args) => execFileSync("node", [BIN, ...args], { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { home, omniloop };
}

test("CLI: new, add-dir, rename, bootstrap and rm keep the files and the codex trust entry in step", async () => {
  const s = sandbox();
  mkdirSync(join(s.home, ".codex"));
  const cfg = join(s.home, ".codex/config.toml");
  writeFileSync(cfg, 'model = "m"\n');
  const a = join(s.home, "repos/a"), b = join(s.home, "repos/b");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  s.omniloop("new", "demo", "--goal", "g", "--dir", a, "--no-coordinator");
  const loop = join(s.home, "loops/demo");
  const dirsOf = () => JSON.parse(readFileSync(join(loop, ".claude/settings.json"), "utf8")).permissions.additionalDirectories;
  assert.deepEqual(dirsOf(), [a]);
  assert.equal(readlinkSync(join(loop, "AGENTS.md")), "CLAUDE.md");
  assert.ok(readFileSync(cfg, "utf8").includes(`[projects."${loop}"]`));
  s.omniloop("add-dir", b, "--loop", "demo");
  assert.deepEqual(dirsOf(), [a, b]);
  s.omniloop("rm-dir", b, "--loop", "demo");
  assert.deepEqual(dirsOf(), [a]);
  s.omniloop("rename", "demo", "demo2");
  const loop2 = join(s.home, "loops/demo2");
  const t = readFileSync(cfg, "utf8");
  assert.ok(t.includes(`[projects."${loop2}"]`) && !t.includes(`[projects."${loop}"]`));
  assert.deepEqual(JSON.parse(readFileSync(join(loop2, ".claude/settings.json"), "utf8")).permissions.additionalDirectories, [a]);
  writeFileSync(join(loop2, ".claude/settings.json"), "{}");
  assert.match(s.omniloop("bootstrap", "demo2"), /bootstrapped demo2: wrote \.claude\/settings\.json/);
  s.omniloop("rm", "demo2", "--force");
  assert.equal(readFileSync(cfg, "utf8"), 'model = "m"\n');
});

test("CLI: without ~/.codex, new succeeds and creates none", () => {
  const s = sandbox();
  s.omniloop("new", "plain", "--goal", "g", "--no-coordinator");
  assert.ok(existsSync(join(s.home, "loops/plain/.codex/config.toml")));
  assert.ok(!existsSync(join(s.home, ".codex")));
});

// ---- review fixes: real paths, symlinked config files, foreign entry forms, arrays, move onto a listed target, EOLs ----

/** A HOME that is a symlink to another temp folder (tmp() resolves links, so build it by hand). */
function linkedHome() {
  const realHome = tmp(), link = join(tmp(), "linkhome");
  symlinkSync(realHome, link);
  return { realHome, link };
}

test("symlinked home: trust names the real loop path on add, move and remove; a link-path entry is removed too", async () => {
  const { realHome, link } = linkedHome();
  mkdirSync(join(realHome, ".codex"));
  const cfg = join(realHome, ".codex/config.toml"), orig = 'model = "m"\n';
  writeFileSync(cfg, orig);
  const t1 = join(link, "loops/t1"), t2 = join(link, "loops/t2");
  mkdirSync(t1, { recursive: true });
  await bootstrapLoop(link, t1, manifest);
  let text = readFileSync(cfg, "utf8");
  assert.ok(text.includes(`[projects."${realHome}/loops/t1"]`), text);
  assert.ok(!text.includes(link));
  // rename as cmdRename does it: move the folder, leave a link at the old name, then move trust
  execFileSync("mv", [t1, t2]);
  symlinkSync(t2, t1);
  await trustLoop(link, t1, "move", t2);
  text = readFileSync(cfg, "utf8");
  assert.ok(text.includes(`[projects."${realHome}/loops/t2"]`) && !text.includes("loops/t1"), text);
  // an entry under the link path (written before this fix) goes with remove as well
  writeFileSync(cfg, addTrust(text, t2));
  await trustLoop(link, t2, "remove");
  assert.equal(readFileSync(cfg, "utf8"), orig);
});

test("CLI under a symlinked HOME: new trusts the real path; rename and rm keep it in step", () => {
  const { realHome, link } = linkedHome();
  const fake = join(realHome, "fakebin");
  mkdirSync(fake);
  for (const n of ["hc", "herdr-app"]) { writeFileSync(join(fake, n), "#!/bin/sh\nexit 1\n"); chmodSync(join(fake, n), 0o755); }
  const env = { ...process.env, HOME: link, PATH: `${fake}:${process.env.PATH}`, OMNILOOP_HOME: join(link, ".cache", "omniloop"), HC_TERMINAL_ID: "" };
  const omniloop = (...args) => execFileSync("node", [BIN, ...args], { cwd: link, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(join(realHome, ".codex"));
  const cfg = join(realHome, ".codex/config.toml");
  writeFileSync(cfg, 'model = "m"\n');
  const a = join(link, "repos/a");
  mkdirSync(a, { recursive: true });
  omniloop("new", "demo", "--goal", "g", "--dir", a, "--no-coordinator");
  assert.ok(readFileSync(cfg, "utf8").includes(`[projects."${realHome}/loops/demo"]`));
  assert.ok(!readFileSync(cfg, "utf8").includes(link));
  // .claude/settings.json keeps the folders as the loop launches with them (--add-dir), unresolved: by choice
  const settings = JSON.parse(readFileSync(join(realHome, "loops/demo/.claude/settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.additionalDirectories, [a]);
  omniloop("rename", "demo", "demo2");
  const t = readFileSync(cfg, "utf8");
  assert.ok(t.includes(`[projects."${realHome}/loops/demo2"]`) && !t.includes("loops/demo\""), t);
  omniloop("rm", "demo2", "--force");
  assert.equal(readFileSync(cfg, "utf8"), 'model = "m"\n');
});

test("a symlinked ~/.codex/config.toml and loop config files are written through to their targets, mode kept", async () => {
  const home = tmp(), dots = join(home, "dotfiles"), loop = join(home, "loops/app");
  mkdirSync(dots); mkdirSync(join(home, ".codex")); mkdirSync(join(loop, ".claude"), { recursive: true }); mkdirSync(join(loop, ".codex"));
  const target = join(dots, "codex.toml"), cfg = join(home, ".codex/config.toml");
  writeFileSync(target, 'model = "m"\n'); chmodSync(target, 0o600);
  symlinkSync(target, cfg);
  writeFileSync(join(dots, "settings.json"), '{"theme":"x"}');
  symlinkSync(join(dots, "settings.json"), join(loop, ".claude/settings.json"));
  writeFileSync(join(dots, "loop-codex.toml"), 'model = "m"\n');
  symlinkSync("../../../dotfiles/loop-codex.toml", join(loop, ".codex/config.toml")); // relative link
  await bootstrapLoop(home, loop, manifest);
  for (const p of [cfg, join(loop, ".claude/settings.json"), join(loop, ".codex/config.toml")]) assert.ok(lstatSync(p).isSymbolicLink(), p);
  assert.ok(readFileSync(target, "utf8").includes(`[projects."${loop}"]`));
  assert.equal(lstatSync(target).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dots, "settings.json"), "utf8")).theme, "x");
  assert.ok(JSON.parse(readFileSync(join(dots, "settings.json"), "utf8")).permissions.additionalDirectories.length === 2);
  assert.match(readFileSync(join(dots, "loop-codex.toml"), "utf8"), /writable_roots/);
  assert.deepEqual(execFileSync("ls", ["-a", dots, join(home, ".codex")], { encoding: "utf8" }).match(/omniloop-.*\.tmp/g), null);
  await trustLoop(home, loop, "remove");
  assert.equal(readFileSync(target, "utf8"), 'model = "m"\n');
  assert.ok(lstatSync(cfg).isSymbolicLink());
});

test("trust: a path listed in a form the line editor doesn't write is never duplicated; remove and move leave it, with a note", () => {
  const forms = [
    '[projects."/p"] # mine\ntrust_level = "trusted"\n',
    "[projects.'/p']\ntrust_level = \"trusted\"\n",
    '[projects]\n"/p" = { trust_level = "trusted" }\n',
    'projects."/p".trust_level = "trusted"\n',
    '[ projects . "/p" ]\ntrust_level = "trusted"\n',
  ];
  for (const f of forms) {
    for (const r of [addT(f, "/p"), removeT(f, "/p"), moveT(f, "/p", "/q")]) {
      assert.equal(r.text, f, f);
      assert.match(r.note, /\/p in a form omniloop doesn't edit/, f);
    }
  }
  // another path in those forms doesn't block, and isn't touched
  const other = '[projects]\n"/x" = { trust_level = "trusted" }\n';
  assert.equal(addT(other, "/p").note, undefined);
  assert.ok(addT(other, "/p").text.startsWith(other));
  // "/p" inside some other setting isn't a projects entry
  assert.equal(addT('[sandbox_workspace_write]\nwritable_roots = ["/p"]\n', "/p").note, undefined);
  // a prefix isn't the path
  assert.equal(addT('[projects."/p/sub"]\ntrust_level = "trusted"\n', "/p").note, undefined);
});

test("trust: an entry whose body has a multi-line array with [-leading lines is removed whole", () => {
  const base = 'model = "m"\n\n[tui]\ntheme = "x"\n';
  const entry = '[projects."/p"]\ntrust_level = "trusted"\nextra = [\n  ["a", "b"],\n  ["c"]\n]\n\n';
  const text = base.replace("[tui]", `${entry}[tui]`);
  assert.equal(removeTrust(text, "/p"), base);
  // and a real header after it still ends the entry
  assert.equal(removeTrust('[projects."/p"]\ntrust_level = "trusted"\n[[arr]]\nk = 1\n', "/p"), "[[arr]]\nk = 1\n");
});

test("trust: moving onto a path that is already listed drops the old entry instead of leaving it stale", () => {
  const both = addTrust(addTrust('model = "m"\n', "/old"), "/new");
  assert.equal(moveTrust(both, "/old", "/new"), addTrust('model = "m"\n', "/new"));
  const foreign = 'model = "m"\n\n[projects."/old"]\ntrust_level = "trusted"\n\n[projects]\n"/new" = { trust_level = "trusted" }\n';
  assert.equal(moveTrust(foreign, "/old", "/new"), 'model = "m"\n\n[projects]\n"/new" = { trust_level = "trusted" }\n');
});

test("trust: CRLF stays CRLF and a missing final newline stays missing; add-then-remove is byte-identical", () => {
  for (const base of ['model = "m"\r\n[tui]\r\ntheme = "x"\r\n', 'model = "m"\n[tui]\ntheme = "x"', 'model = "m"\r\ntheme = "x"', 'a = 1\n\n\n', ""]) {
    const added = addTrust(base, "/p");
    assert.ok(added.startsWith(base));
    if (base.includes("\r\n")) assert.ok(!/[^\r]\n/.test(added), JSON.stringify(added));
    assert.equal(added.endsWith("\n"), base === "" || base.endsWith("\n"));
    assert.equal(removeTrust(added, "/p"), base, JSON.stringify(base));
    const moved = moveTrust(added, "/p", "/q");
    assert.equal(removeTrust(moved, "/q"), base);
  }
});

test("trust: a multi-line string with [ in it doesn't hide the headers after it; an unreadable tail is left alone", () => {
  const other = '\n[projects."/other"]\ntrust_level = "trusted"\n';
  const base = 'notes = """\nsee [docs\n"""\n' + other;
  const text = base.replace(other, '\n[projects."/p"]\ntrust_level = "trusted"\n' + other);
  assert.equal(removeTrust(text, "/p"), base);
  assert.equal(removeTrust(text.replace(/"""/g, "'''"), "/p"), base.replace(/"""/g, "'''"));
  // an array that never closes: no guessing where the entry ends
  const open = '[projects."/p"]\ntrust_level = "trusted"\nx = [\n[tui]\n';
  const r = removeT(open, "/p");
  assert.equal(r.text, open);
  assert.match(r.note, /couldn't tell where the entry for \/p ends/);
});

test("trust: a file with mixed line endings keeps its bytes, and the plain entry is still found", () => {
  const base = 'a = 1\r\nb = 2\n';
  const added = addTrust(base, "/p");
  assert.equal(addT(added, "/p").note, undefined);
  assert.equal(addTrust(added, "/p"), added);
  assert.equal(removeTrust(added, "/p"), base);
});
