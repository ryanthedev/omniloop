// loopdir.js: a loop is a folder, and that folder is the Claude Code project its members share. Pure.
//
//   ~/loops/<id>/CLAUDE.md   goal and context; every member reads it at start (it is their project's CLAUDE.md)
//   ~/loops/<id>/loop.json   { id, goal, dirs: [{ path, machine }], created_ms }
//
// Members start in the loop folder, with --add-dir for each context folder on their machine, and with
// CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 so those folders' own CLAUDE.md files load too.
// Their sessions are saved under one Claude project (the loop folder), so a loop's history stays together.

export const LOOPS_DIR = "loops";
export const ADD_DIR_ENV = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD";

/** Loop ids name folders, spaces and labels: a-z 0-9 - _, 1-40 characters, starting with a letter or digit. */
export function validId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id);
}

export function loopHome(home, id) {
  return `${home}/${LOOPS_DIR}/${id}`;
}

export function newManifest({ id, goal = null, dirs = [], now = 0 }) {
  return { id, goal, dirs: dirs.map((d) => (typeof d === "string" ? { path: d, machine: null } : d)), created_ms: now };
}

/** Add a folder once (same path and machine). Returns a new manifest. */
export function addDir(manifest, path, machine = null) {
  if (manifest.dirs.some((d) => d.path === path && (d.machine ?? null) === machine)) return manifest;
  return { ...manifest, dirs: [...manifest.dirs, { path, machine }] };
}

/** The folders a member on `machine` (null = this computer) can be given with --add-dir. */
export function dirsOn(manifest, machine = null) {
  return manifest.dirs.filter((d) => (d.machine ?? null) === (machine ?? null)).map((d) => d.path);
}

const CONTEXT_START = "<!-- omniloop:context -->";
const CONTEXT_END = "<!-- /omniloop:context -->";

function contextBlock(manifest) {
  const dirs = manifest.dirs.length
    ? manifest.dirs.map((d) => `- \`${d.path}\`${d.machine ? ` (on ${d.machine})` : ""}`).join("\n")
    : "- (none yet: `omniloop add-dir <path>`)";
  return `${CONTEXT_START}\n## Context\n\nThe folders this loop works in (each was given to you with --add-dir). Work in them by absolute\npath, e.g. \`git -C <folder> status\`; this loop folder is for the loop's own notes.\n\n${dirs}\n\n${SHARED_RULES}\n${CONTEXT_END}`;
}

// Names no other loop: who shares a folder changes, so \`omniloop shared\` looks it up live.
const SHARED_RULES = `### Other loops may work here too

These folders can be shared with other loops, at the same time as you. \`omniloop shared\` lists them and their leads.

- **Before a change, say so:** run \`omniloop shared\`; if another loop is in that folder, tell its lead which files
  you'll touch (\`hc send <lead> "…"\`), and answer such notes from them. Once per change, not per edit.
- **In a git repo, use a branch:** work on \`<loop>/<topic>\` (or a \`git worktree\`), not on the checkout others use.
  Merge only with the tests passing.
- **Never change what others stand on without the user:** \`git init\`, reset, force-push, rewriting a shared branch,
  or moving or deleting files you didn't make.`;

/** Is one path the other, or inside it (by whole folder names, so /a/b-c is not inside /a/b)? */
function overlaps(a, b) {
  const x = a.replace(/\/+$/, ""), y = b.replace(/\/+$/, "");
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

/**
 * The other loops working in this loop's folders on this computer.
 * manifests: every loop's loop.json. Returns [{ path, loops: [{ id, path }] }] for each folder that is shared;
 * a loop counts when one of its folders is the same folder, inside it, or holds it.
 */
export function sharedWith(manifests, id) {
  const mine = manifests.find((m) => m?.id === id);
  if (!mine) return [];
  const out = [];
  for (const path of dirsOn(mine)) {
    const loops = [];
    for (const m of manifests)
      if (m?.id && m.id !== id) for (const p of dirsOn(m)) if (overlaps(path, p)) { loops.push({ id: m.id, path: p }); break; }
    if (loops.length) out.push({ path, loops });
  }
  return out;
}

/** The loop's CLAUDE.md, first time. Everything outside the context block is the loop's to edit. */
export function claudeMd(manifest) {
  return `# Loop: ${manifest.id}

${manifest.goal ? `**Goal:** ${manifest.goal}` : "**Goal:** (not set)"}

You are a member of the omniloop \`${manifest.id}\`. Run \`omniloop brief\` once for the commands and rules.

${contextBlock(manifest)}

## Memory (Engram)

Your Engram rules are in your global instructions; in this loop also:

- **Recall by loop:** start with \`engram search "${manifest.id} <topic>"\`, then the repo or problem. Hits are leads; check them.
- **Tag what you write:** \`engram ingest --event-id ${manifest.id}-<topic>-<date> --source "loop ${manifest.id}" --text "…"\`,
  so the next member of this loop finds it. Only verified results, as always.
- **Decisions belong here too:** the lead copies loop decisions into the Decisions section below.

## Tools

| Tool | Use it for |
|---|---|
| \`omniloop ls ${manifest.id}\` | who is in this loop, as a tree; * = lead |
| \`omniloop start ${manifest.id} --job J -- claude "<task>"\` | a helper that reports to you, with this loop's context |
| \`omniloop timer 20m "<check>"\` | a note later; never sleep or poll |
| \`omniloop needs-you\` | this block is the user's (credentials, spending, anything public) |
| \`omniloop say "<text>"\` | post to the loop's chat feed, which the user reads |
| \`omniloop add-dir <path>\` | add a context folder to the loop |
| \`omniloop shared\` | other loops in this loop's folders, and their leads |
| \`omniloop handoff <file>\` | at about 60% context: write \`<file>\`, run this, stop |
| \`hc read <t>\` / \`hc send <t> "<text>"\` | see a helper's screen / answer it |
| \`engram search\` / \`engram ingest\` | the shared memory (above) |

## Decisions

(The lead records decisions here, with the date and why.)
`;
}

/** Rewrite only the context block of an existing CLAUDE.md, keeping everything else. */
export function updateClaudeMd(text, manifest) {
  const a = text.indexOf(CONTEXT_START), b = text.indexOf(CONTEXT_END);
  if (a < 0 || b < a) return `${text.trimEnd()}\n\n${contextBlock(manifest)}\n`;
  return text.slice(0, a) + contextBlock(manifest) + text.slice(b + CONTEXT_END.length);
}

/**
 * The argv to start a member: claude (with the user's own flags), --add-dir for each folder on its machine,
 * and the task. Wrapped so the env var is set and the login shell's PATH applies.
 * claudeArgv: the user's claude launch (e.g. from their alias), without "command".
 */
// The task goes right after the program: --add-dir takes a list, so a task after it would be read as a folder.
// binDir: put on PATH so members can run `omniloop`.
// pluginDirs: the loop's projects, each loaded as a Claude Code plugin (its skills and tools).
export function memberArgv({ shell = "/bin/sh", claudeArgv = ["claude"], dirs = [], task = null, binDir = null, pluginDirs = [] }) {
  const [prog, ...flags] = claudeArgv;
  const argv = [prog, ...(task ? [task] : []), ...flags];
  for (const p of pluginDirs) argv.push("--plugin-dir", p);
  if (dirs.length) argv.push("--add-dir", ...dirs);
  const path = binDir ? `export PATH=${shq(binDir)}:"$PATH"; ` : "";
  return [shell, "-lc", `${path}export ${ADD_DIR_ENV}=1; exec "$@"`, "omniloop", ...argv];
}

/** Quote for sh. */
export function shq(s) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Turn `print -rl` output of an alias's words into a launch argv, dropping a leading `command`. */
export function parseAliasWords(text) {
  const words = String(text ?? "").split("\n").filter((w) => w.length);
  return words[0] === "command" || words[0] === "builtin" ? words.slice(1) : words;
}
