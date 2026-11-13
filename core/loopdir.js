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

/** Remove a context folder (every machine's entry for that path, or just `machine`'s). Returns a new manifest; the same one when absent. */
export function removeDir(manifest, path, machine = undefined) {
  const keep = manifest.dirs.filter((d) => !(d.path === path && (machine === undefined || (d.machine ?? null) === machine)));
  return keep.length === manifest.dirs.length ? manifest : { ...manifest, dirs: keep };
}

/** Add a folder once (same path and machine). Returns a new manifest. */
export function addDir(manifest, path, machine = null) {
  if (manifest.dirs.some((d) => d.path === path && (d.machine ?? null) === machine)) return manifest;
  return { ...manifest, dirs: [...manifest.dirs, { path, machine }] };
}

/**
 * The folders to start a member on `machine` with (--add-dir): a folder's own worktree when the loop has one, else
 * the folder. `path` stays the folder's identity everywhere else (sharing, the panel, search).
 */
export function launchDirsOn(manifest, machine = null) {
  return manifest.dirs.filter((d) => (d.machine ?? null) === (machine ?? null)).map((d) => d.worktree ?? d.path);
}

// ---- a worktree per loop, for a repo another loop already uses (user's rule, 2026-11-13) ----

/** Folders that are live configuration: edits must land in place, so they never get a worktree. */
export const LIVE_DIRS = [".config", ".claude"];

/**
 * Should this loop get its own worktree of `path`? Pure; the CLI gathers the facts.
 * facts: { home, top (the repo's top folder, or null when not git), commits (count), others (ids of other loops
 * using this folder, a folder inside it, or one holding it) }. Returns { worktree: bool, why }.
 */
export function worktreeChoice(path, { home, top, commits, others = [] }) {
  if (LIVE_DIRS.some((d) => path === `${home}/${d}` || path.startsWith(`${home}/${d}/`))) return { worktree: false, why: "live config, edited in place" };
  if (!top) return { worktree: false, why: "not a git repo" };
  if (top !== path) return { worktree: false, why: `inside the repo ${top}` };
  if (!commits) return { worktree: false, why: "the repo has no commits yet" };
  if (!others.length) return { worktree: false, why: "no other loop uses it" };
  return { worktree: true, why: `also used by ${others.join(", ")}` };
}

/** Where a loop's worktree of `path` goes: <loop home>/wt/<folder name>, with -2, -3… when that name is taken. */
export function worktreeTarget(loopHomePath, path, taken = []) {
  const name = path.split("/").filter(Boolean).pop() ?? "repo";
  const used = new Set(taken);
  let out = `${loopHomePath}/wt/${name}`, n = 2;
  while (used.has(out)) out = `${loopHomePath}/wt/${name}-${n++}`;
  return out;
}

/** The loop's branch in a worktree. */
export const worktreeBranch = (id) => `${id}/work`;

/** Record a worktree on a folder entry. Returns a new manifest. */
export function setWorktree(manifest, path, { worktree, branch, base, dirty = 0 }) {
  return { ...manifest, dirs: manifest.dirs.map((d) => (d.path === path && !d.machine ? { ...d, worktree, branch, base, dirty } : d)) };
}

/** The folders a member on `machine` (null = this computer) can be given with --add-dir. */
export function dirsOn(manifest, machine = null) {
  return manifest.dirs.filter((d) => (d.machine ?? null) === (machine ?? null)).map((d) => d.path);
}

const CONTEXT_START = "<!-- omniloop:context -->";
const CONTEXT_END = "<!-- /omniloop:context -->";

function contextBlock(manifest) {
  const dirs = manifest.dirs.length
    ? manifest.dirs.map((d) => d.worktree
      ? `- \`${d.path}\`: **your own copy is \`${d.worktree}\`** (git worktree, branch \`${d.branch}\`, from ${d.base}). Work there, not\n  in \`${d.path}\`, which other loops use.${d.dirty ? ` It started from the last commit: ${d.dirty} uncommitted file(s) in\n  the shared checkout are not in your copy.` : ""} To land: tests pass in your copy, then \`git -C ${d.path} status\`\n  must be clean before \`git -C ${d.path} merge --ff-only ${d.branch}\` (rebase on its branch first if it moved).`
      : `- \`${d.path}\`${d.machine ? ` (on ${d.machine})` : ""}`).join("\n")
    : "- (none yet: `omniloop add-dir <path>`)";
  return `${CONTEXT_START}\n## Context\n\nThe folders this loop works in (each was given to you with --add-dir). Work in them by absolute\npath, e.g. \`git -C <folder> status\`; this loop folder is for the loop's own notes.\n\n${dirs}\n\n${SHARED_RULES}\n${CONTEXT_END}`;
}

// Names no other loop: who shares a folder changes, so \`omniloop shared\` looks it up live.
const SHARED_RULES = `### Other loops may work here too

These folders can be shared with other loops, at the same time as you. \`omniloop shared\` lists them and their leads.

- **Before a change, say so:** run \`omniloop shared\`; if another loop is in that folder, tell its lead which files
  you'll touch (\`omniloop send <lead> "…"\`), and answer such notes from them. Once per change, not per edit.
- **In a git repo, use your own copy:** when a folder above names your own copy (a git worktree), work there and
  land it as it says. Otherwise work on a \`<loop>/<topic>\` branch (or a \`git worktree\`), not on the checkout
  others use. Merge only with the tests passing.
- **Never change what others stand on without the user:** \`git init\`, reset, force-push, rewriting a shared branch,
  or moving or deleting files you didn't make.`;

/** Is one path the other, or inside it (by whole folder names, so /a/b-c is not inside /a/b)? */
export function overlaps(a, b) {
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

function memoryBlock(manifest) {
  return `## Memory (Engram)

Your Engram rules are in your global instructions; in this loop also:

- **Recall by loop:** start with \`engram search "${manifest.id} <topic>"\`, then the repo or problem. Hits are leads; check them.
- **Tag what you write:** \`engram ingest --event-id ${manifest.id}-<topic>-<date> --source "loop ${manifest.id}" --text "…"\`,
  so the next member of this loop finds it. Only verified results, as always.
- **Decisions belong here too:** the lead copies loop decisions into the Decisions section below.

`;
}

// A temporary loop: nothing it does is remembered (core/lifecycle.js).
const TEMP_MEMORY = `## Temporary loop: no memory

This loop is temporary. When the user says they're done, run \`omniloop rm\`: it deletes this folder, the
sessions' transcripts and their prompt history. It also ends by itself once its last member is gone.

- **Never write memory:** no \`engram ingest\`, no memory files, no notes outside this folder. Engram is off here.
- **Code still lands normally:** commits in a context folder are the user's work, not memory; finish or say what's left.

`;

/** The loop's CLAUDE.md, first time. Everything outside the context block is the loop's to edit. */
export function claudeMd(manifest) {
  return `# Loop: ${manifest.id}

${manifest.goal ? `**Goal:** ${manifest.goal}` : "**Goal:** (not set)"}

You are a member of the omniloop \`${manifest.id}\`. Run \`omniloop brief\` once for the commands and rules.

${contextBlock(manifest)}

${manifest.temp ? TEMP_MEMORY : memoryBlock(manifest)}## Tools

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
| \`omniloop send <t> "<text>"\` | message a helper, your lead or another session; it arrives labelled as you, never as the user (MCP: \`send_message\`) |
| \`hc read <t>\` | see a helper's screen |
${manifest.temp ? "" : "| `engram search` / `engram ingest` | the shared memory (above) |\n"}
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
// noMemory: a temporary loop's member: these env vars unset and these tools disallowed (core/lifecycle.js).
export function memberArgv({ shell = "/bin/sh", claudeArgv = ["claude"], dirs = [], task = null, binDir = null, pluginDirs = [], noMemory = null }) {
  const [prog, ...flags] = claudeArgv;
  const argv = [prog, ...(task ? [task] : []), ...flags];
  for (const p of pluginDirs) argv.push("--plugin-dir", p);
  if (noMemory?.tools?.length) argv.push("--disallowedTools", ...noMemory.tools);
  if (dirs.length) argv.push("--add-dir", ...dirs);
  const path = binDir ? `export PATH=${shq(binDir)}:"$PATH"; ` : "";
  const unset = noMemory?.env?.length ? `unset ${noMemory.env.join(" ")}; ` : "";
  return [shell, "-lc", `${path}${unset}export ${ADD_DIR_ENV}=1; exec "$@"`, "omniloop", ...argv];
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
