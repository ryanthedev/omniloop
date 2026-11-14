// harness.js: config that makes each AI coding harness started in a loop folder see the loop's folders. Pure.
//
// One entry per harness in HARNESSES; adding opencode or cursor later is one more entry. An entry lists the files
// to keep in the loop folder (`files`). Nothing outside the loop folder is ever written. Nothing here touches the
// disk: bin/lib/harness-apply.mjs reads, calls and writes.
//
// A file spec is { path, merge(existingText|null) -> { text, note? } } or { path, link } (a relative symlink).
// merge keeps what the user wrote: it owns one setting and returns the rest as it found it.

import { launchDirsOn } from "./loopdir.js";

// ---- Claude Code: .claude/settings.json, permissions.additionalDirectories ----

function claudeSettings(dirs) {
  return (cur) => {
    let obj = {};
    if (cur != null && cur.trim()) {
      try { obj = JSON.parse(cur); } catch { return { text: cur, note: ".claude/settings.json isn't valid JSON: left alone" }; }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { text: cur, note: ".claude/settings.json isn't an object: left alone" };
    }
    const perms = obj.permissions && typeof obj.permissions === "object" && !Array.isArray(obj.permissions) ? obj.permissions : {};
    return { text: JSON.stringify({ ...obj, permissions: { ...perms, additionalDirectories: dirs } }, null, 2) + "\n" };
  };
}

// ---- the table ----

/** One entry per harness. `files(dirs)`: specs under the loop folder. */
export const HARNESSES = [
  {
    name: "claude",
    files: (dirs) => [{ path: ".claude/settings.json", merge: claudeSettings(dirs) }],
  },
  {
    name: "codex",
    // Codex reads AGENTS.md from the cwd: a relative link keeps it in sync with CLAUDE.md and survives a rename.
    // No Codex config file: only the link.
    files: () => [{ path: "AGENTS.md", link: "CLAUDE.md" }],
  },
];

/** The files to write in a loop folder: this computer's launch folders (a worktree where there is one), no remote ones. */
export function harnessFiles(manifest) {
  const dirs = launchDirsOn(manifest, null);
  return HARNESSES.flatMap((h) => h.files(dirs).map((f) => ({ harness: h.name, ...f })));
}
