import { test } from "node:test";
import assert from "node:assert/strict";
import { validId, loopHome, newManifest, addDir, dirsOn, claudeMd, updateClaudeMd, agentArgv, parseAliasWords, ADD_DIR_ENV, sharedWith } from "../core/loopdir.js";

test("ids", () => {
  assert.ok(validId("plenary-m2"));
  assert.ok(!validId("Plenary"));
  assert.ok(!validId("../x"));
  assert.ok(!validId(""));
  assert.equal(loopHome("/home/jane", "m2"), "/home/jane/loops/m2");
});

test("context folders: added once, per machine", () => {
  let m = newManifest({ id: "m2", goal: "Ship", dirs: ["/r/a"] });
  m = addDir(addDir(m, "/r/b"), "/r/b");
  m = addDir(m, "/home/x/c", "ska");
  assert.deepEqual(dirsOn(m), ["/r/a", "/r/b"]);
  assert.deepEqual(dirsOn(m, "ska"), ["/home/x/c"]);
});

test("CLAUDE.md: the context block is rewritten, the rest is kept", () => {
  const m = newManifest({ id: "m2", goal: "Ship", dirs: ["/r/a"] });
  let md = claudeMd(m);
  assert.match(md, /Goal:\*\* Ship/);
  assert.match(md, /`\/r\/a`/);
  assert.match(md, /engram search "m2 <topic>"/);
  assert.match(md, /--source "loop m2"/);
  assert.match(md, /## How to work/);
  assert.match(md, /code-foundations:build-agent.*Sonnet/);
  assert.match(md, /code-foundations:post-gate-agent.*Opus/);
  assert.match(md, /omniloop task done N/);
  assert.match(md, /give N <agent>/);
  assert.match(md, /todo list/);
  assert.match(md, /omniloop say "<text>"/);
  assert.match(md, /omniloop brief/);
  assert.doesNotMatch(md, /\b(lead|leads|helper|member|office)\b/i);
  assert.doesNotMatch(claudeMd({ ...m, temp: true }), /\b(lead|leads|helper|member|office)\b/i);
  md = md.replace("(The coordinator records decisions here, with the date and why.)", "- 2026-11-12: use sqlite");
  const md2 = updateClaudeMd(md, addDir(m, "/r/b"));
  assert.match(md2, /`\/r\/b`/);
  assert.match(md2, /use sqlite/);
  assert.equal(md2.match(/## Context/g).length, 1);
});

test("agent argv: the user's claude flags, --add-dir, the task, the env var through a login shell", () => {
  const argv = agentArgv({ shell: "/bin/zsh", claudeArgv: ["claude", "--plugin-dir", "/p"], dirs: ["/r/a", "/r/b"], task: "do x" });
  // The task comes right after claude: --add-dir takes a list and would swallow a task placed after it.
  assert.deepEqual(argv, ["/bin/zsh", "-lc", `export ${ADD_DIR_ENV}=1; exec "$@"`, "omniloop", "claude", "do x", "--plugin-dir", "/p", "--add-dir", "/r/a", "/r/b"]);
  assert.deepEqual(agentArgv({ claudeArgv: ["claude"] }).slice(4), ["claude"]);
  assert.equal(agentArgv({ binDir: "/r/omni/bin" })[2], `export PATH=/r/omni/bin:"$PATH"; export ${ADD_DIR_ENV}=1; exec "$@"`);
});

test("alias words", () => {
  assert.deepEqual(parseAliasWords("command\nclaude\n--settings\n/x\n"), ["claude", "--settings", "/x"]);
  assert.deepEqual(parseAliasWords(""), []);
});

test("sharedWith: other loops in the same folder, inside it or holding it, on this computer only", () => {
  const ms = [
    newManifest({ id: "a", dirs: ["/r/repos/x", "/r/repos/y", "/r/.config"] }),
    newManifest({ id: "b", dirs: ["/r/repos/x/"] }),
    newManifest({ id: "c", dirs: ["/r/repos/x-other", "/r/.config/claude"] }),
    newManifest({ id: "d", dirs: [{ path: "/r/repos/y", machine: "m1" }] }),
    newManifest({ id: "e", dirs: ["/r/repos"] }),
  ];
  assert.deepEqual(sharedWith(ms, "a"), [
    { path: "/r/repos/x", loops: [{ id: "b", path: "/r/repos/x/" }, { id: "e", path: "/r/repos" }] },
    { path: "/r/repos/y", loops: [{ id: "e", path: "/r/repos" }] },
    { path: "/r/.config", loops: [{ id: "c", path: "/r/.config/claude" }] },
  ]);
  assert.deepEqual(sharedWith(ms, "nope"), []);
});

test("every loop's CLAUDE.md says other loops may share its folders, without naming any", () => {
  const md = claudeMd(newManifest({ id: "a", dirs: ["/r/repos/x"] }));
  assert.match(md, /### Other loops may work here too/);
  assert.match(md, /omniloop shared/);
  const again = updateClaudeMd(md, newManifest({ id: "a", dirs: ["/r/repos/x", "/r/y"] }));
  assert.equal(again.match(/### Other loops may work here too/g).length, 1);
});

test("CLAUDE.md: codex build and review agents are listed beside the Claude ones, flagged as needing the sdd plugin", () => {
  const md = claudeMd(newManifest({ id: "cx", dirs: [] }));
  assert.match(md, /code-foundations:build-agent.*Sonnet/, "Claude options stay");
  assert.match(md, /code-foundations:post-gate-agent.*Opus/);
  assert.match(md, /Build via codex \(needs the sdd plugin\).*`sdd:codex-builder`.*codex CLI.*ugov status/);
  assert.match(md, /Second review via codex \(needs the sdd plugin\).*`sdd:codex-reviewer`.*verified/);
  assert.match(md, /codex build still gets the independent review/);
  assert.match(claudeMd({ ...newManifest({ id: "cx", dirs: [] }), temp: true }), /sdd:codex-builder/);
});
