// lifecycle.js: renaming, removing and self-destructing loops. Pure; bin/omniloop.mjs does the moving and deleting.
//
// A loop's id is its folder name (~/loops/<id>), its Herdr space's name, its members' omniloop.loop label, its
// worktrees' branch (<id>/work) and the Claude project its sessions are saved under. Renaming moves all of them;
// "move" and "rename" are the same thing here.
//
// A temporary loop (loop.json "temp": true) keeps no memory: its members start without Engram (no credentials,
// the ingest tools disallowed), and when it ends its folder, its Claude transcripts, scratchpads and prompt-history
// lines are deleted. It ends on `omniloop rm`, or by itself once its last member is gone (the watcher's sweep).

import { worktreeBranch } from "./loopdir.js";

/** The folder name Claude Code saves a project's sessions under (~/.claude/projects/<key>): every non-alphanumeric is "-". */
export function claudeProjectKey(path) {
  return String(path).replace(/[^A-Za-z0-9]/g, "-");
}

/** Is a ~/.claude/projects (or /tmp/claude-<uid>) entry this loop's? Its own key, or a scratchpad of one of its sessions. */
export function isLoopClaudeEntry(name, key) {
  if (name === key) return true;
  const esc = key.replace(/[-]/g, "\\-");
  return new RegExp(`^-private-tmp-claude-\\d+-${esc}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-scratchpad`).test(name);
}

/**
 * The manifest after renaming: new id, worktree paths moved with the folder, branches renamed.
 * Remembers the old name ("formerly"), so a loop's Engram notes under the old id stay findable.
 */
export function renamedManifest(m, { from, to, fromHome, toHome, now }) {
  const dirs = (m.dirs ?? []).map((d) => {
    if (!d.worktree) return d;
    const worktree = d.worktree.startsWith(fromHome + "/") ? toHome + d.worktree.slice(fromHome.length) : d.worktree;
    const branch = d.branch === worktreeBranch(from) ? worktreeBranch(to) : d.branch;
    return { ...d, worktree, branch };
  });
  return { ...m, id: to, dirs, formerly: [...(m.formerly ?? []), { id: from, at: now }] };
}

/**
 * Put the new id into the slots omniloop's CLAUDE.md template gives it (title, member line, tools table, Engram
 * lines). Only those: an id like "omniloop" or "engram" also names commands and markers, which must stay.
 */
export function renameText(text, from, to) {
  const e = from.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const slots = [
    [new RegExp(`^# Loop: ${e}$`, "m"), `# Loop: ${to}`],
    [new RegExp(`member of the omniloop \`${e}\``, "g"), `member of the omniloop \`${to}\``],
    [new RegExp(`This is the omniloop \`${e}\``, "g"), `This is the omniloop \`${to}\``],
    [new RegExp(`\`omniloop (ls|start) ${e}(?=[\` ])`, "g"), (_, c) => `\`omniloop ${c} ${to}`],
    [new RegExp(`engram search "${e} `, "g"), `engram search "${to} `],
    [new RegExp(`--event-id ${e}-<`, "g"), `--event-id ${to}-<`],
    [new RegExp(`--source "loop ${e}"`, "g"), `--source "loop ${to}"`],
  ];
  return slots.reduce((t, [re, by]) => t.replace(re, by), String(text));
}

/** Add (once) a line under the Memory heading saying what the loop used to be called. */
export function withFormerlyNote(text, from, date) {
  const line = `- **Formerly \`${from}\`** (renamed ${date}): Engram notes from before then are tagged \`${from}\`; search that too.`;
  if (text.includes(`**Formerly \`${from}\`**`)) return text;
  const h = text.match(/^## Memory.*$/m);
  if (!h) return `${text.trimEnd()}\n\n${line}\n`;
  const at = text.indexOf(h[0]) + h[0].length;
  // After the heading's intro paragraph, i.e. before its first bullet.
  const rest = text.slice(at);
  const b = rest.search(/^- /m);
  const i = b < 0 ? at : at + b;
  return text.slice(0, i) + line + "\n" + text.slice(i);
}

/**
 * Can this loop be removed? facts per worktree: { path, worktree, branch, dirty (uncommitted files), ahead (commits on
 * its branch not in the repo's checked-out branch) }. Returns { ok, problems: [string] }. `force` overrides.
 */
export function removeCheck(worktrees, { force = false } = {}) {
  const problems = [];
  for (const w of worktrees) {
    if (w.dirty) problems.push(`${w.worktree} has ${w.dirty} uncommitted file(s)`);
    if (w.ahead) problems.push(`${w.branch} has ${w.ahead} commit(s) not merged into ${w.path}`);
  }
  return { ok: force || !problems.length, problems };
}

export const TEMP_GRACE_MS = 2 * 60_000;
export const TEMP_ORPHAN_MS = 24 * 3600_000;

/**
 * The watcher's sweep: which temporary loops have ended. A temp loop ends once it has had a member and now has none
 * (`seen`: ids the watcher saw members in; it is updated in place), or when it never had one for a day.
 * live: the ids of loops with a live member on this computer right now. Never call this when hc failed.
 */
export function endedTempLoops(manifests, live, seen, now) {
  const out = [];
  for (const m of manifests) {
    if (!m?.temp || !m.id) continue;
    if (live.has(m.id)) { seen.add(m.id); continue; }
    const age = now - (m.created_ms ?? now);
    if ((seen.has(m.id) && age > TEMP_GRACE_MS) || age > TEMP_ORPHAN_MS) out.push(m.id);
  }
  return out;
}

/** An id for a temporary loop: tmp-<base36 time>. */
export function tempId(now, taken = []) {
  let id = `tmp-${now.toString(36)}`, n = 2;
  while (taken.includes(id)) id = `tmp-${now.toString(36)}-${n++}`;
  return id;
}

/** Drop prompt-history lines (~/.claude/history.jsonl) made in one of these folders. Returns { text, dropped }. */
export function scrubHistory(text, folders) {
  let dropped = 0;
  const keep = String(text).split("\n").filter((line) => {
    if (!line.trim()) return false;
    try {
      const p = JSON.parse(line).project;
      if (p && folders.some((f) => p === f || p.startsWith(f + "/"))) { dropped++; return false; }
    } catch {}
    return true;
  });
  return { text: keep.length ? keep.join("\n") + "\n" : "", dropped };
}

/** Engram stays out of a temporary loop: no credentials in the members' environment, and its write tools disallowed. */
export const NO_MEMORY_ENV = ["ENGRAM_TOKEN", "ENGRAM_ADDR"];
export const NO_MEMORY_TOOLS = [
  "mcp__plugin_engram_engram__memory_ingest",
  "mcp__plugin_engram_engram__knowledge_ingest",
  "mcp__plugin_engram_engram__knowledge_create_collection",
  "Bash(engram ingest:*)",
];
