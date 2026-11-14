// harness.js: config that makes each AI coding harness started in a loop folder see the loop's folders. Pure.
//
// One entry per harness in HARNESSES; adding opencode or cursor later is one more entry. An entry lists the files
// to keep in the loop folder (`files`) and, when the harness needs the folder trusted in a user-global config,
// how to edit that file (`user`). Nothing here touches the disk: bin/lib/harness-apply.mjs reads, calls and writes.
//
// A file spec is { path, merge(existingText|null) -> { text, note? } } or { path, link } (a relative symlink).
// merge keeps what the user wrote: it owns one setting and returns the rest as it found it.

import { launchDirsOn } from "./loopdir.js";

export const TOML_BEGIN = "# omniloop:begin (managed block: `omniloop bootstrap` rewrites it)";
export const TOML_END = "# omniloop:end";

const esc = (s) => JSON.stringify(String(s));

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

// ---- Codex: .codex/config.toml, [sandbox_workspace_write] writable_roots, in an omniloop-marked block ----

const block = (dirs) => `${TOML_BEGIN}\n[sandbox_workspace_write]\nwritable_roots = [${dirs.map(esc).join(", ")}]\n${TOML_END}`;

function codexConfig(dirs) {
  return (cur) => {
    const text = cur ?? "";
    const a = text.indexOf(TOML_BEGIN), b = text.indexOf(TOML_END);
    if (a >= 0 && b > a) return { text: text.slice(0, a) + block(dirs) + text.slice(b + TOML_END.length) };
    if (/^\s*\[sandbox_workspace_write\]/m.test(text)) return { text, note: ".codex/config.toml has its own [sandbox_workspace_write]: left alone (add writable_roots there yourself)" };
    return { text: text.trim() ? `${text.replace(/\s+$/, "")}\n\n${block(dirs)}\n` : `${block(dirs)}\n` };
  };
}

// ---- Codex trust: the user-global ~/.codex/config.toml entry [projects."<path>"] trust_level = "trusted" ----
//
// A line editor, not a TOML parser: it edits only the plain header form it writes itself. When the path shows up in
// any other form ([projects.'<p>'], a header with a comment, a [projects] table key, a dotted key), it changes
// nothing and returns a note, so it never writes a duplicate table. Line endings (CRLF) and a missing final newline
// are kept, so add-then-remove gives the file back byte for byte. Each op returns { text, note? }.

const header = (path) => `[projects.${esc(path)}]`;
const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const HEADER = new RegExp(String.raw`^\s*\[\[?\s*${KEY}(?:\s*\.\s*${KEY})*\s*\]\]?\s*(?:#.*)?$`);
/**
 * Per line: is it a table header? Lines inside a multi-line array, inline table or multi-line string are values,
 * never headers. The result's `balanced` is false when the scan ends inside one of those (then don't trust it).
 */
function headers(lines) {
  let depth = 0, ml = null; // ml: the closing delimiter while inside a multi-line string
  const out = lines.map((l) => {
    if (depth === 0 && !ml && HEADER.test(l)) return true;
    for (let i = 0; i < l.length; i++) {
      if (ml) { if (l.startsWith(ml, i)) { ml = null; i += 2; } else if (ml === '"""' && l[i] === "\\") i++; continue; }
      const c = l[i];
      if (c === "#") break;
      if (l.startsWith('"""', i) || l.startsWith("'''", i)) { ml = l.slice(i, i + 3); i += 2; continue; }
      if (c === '"' || c === "'") { for (i++; i < l.length && l[i] !== c; i++) if (c === '"' && l[i] === "\\") i++; continue; }
      if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && depth > 0) depth--;
    }
    return false;
  });
  out.balanced = depth === 0 && !ml;
  return out;
}

/** The plain [projects."<path>"] entry: its header line and the end of its body (trailing blanks/comments excluded). */
function findEntry(lines, path) {
  const start = lines.findIndex((l) => l.trim() === header(path));
  if (start < 0) return null;
  const isHeader = headers(lines);
  let end = start + 1;
  while (end < lines.length && !isHeader[end]) end++;
  while (end > start + 1 && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith("#"))) end--; // blanks and comments belong to what follows
  return { start, end, sure: isHeader.balanced };
}

/** Does `path` appear under projects in a form other than the plain header? (a quoted path on a line naming projects,
 * or a key line inside a [projects] table) */
function otherForm(lines, path) {
  const quoted = [esc(path), `'${path}'`];
  const isHeader = headers(lines);
  let inProjects = false;
  return lines.some((l, i) => {
    if (isHeader[i]) inProjects = /^\s*\[\s*projects\s*\]/.test(l);
    if (l.trim() === header(path) || !quoted.some((q) => l.includes(q))) return false;
    return /\bprojects\b/.test(l) || (inProjects && !isHeader[i]);
  });
}

// CRLF only when every line ends so; a mixed file splits on \n with its \r kept in the lines, so bytes survive either way.
const eolOf = (text) => (text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n");
const cantEdit = (path, what) => `~/.codex/config.toml lists ${path} in a form omniloop doesn't edit: ${what}`;

/** Append the trust entry after one blank line; the file is otherwise untouched. Same text back when already there. */
export function addTrust(text, path) {
  const eol = eolOf(text), lines = text.split(eol);
  if (findEntry(lines, path)) return { text };
  if (otherForm(lines, path)) return { text, note: cantEdit(path, "left alone") };
  const entry = `${header(path)}${eol}trust_level = "trusted"`;
  if (!text) return { text: entry + eol };
  return text.endsWith("\n") ? { text: `${text}${eol}${entry}${eol}` } : { text: `${text}${eol}${eol}${entry}` };
}

/** Remove exactly that entry (and the one blank line addTrust put before it). Same text back when absent. */
export function removeTrust(text, path) {
  const eol = eolOf(text), lines = text.split(eol);
  const e = findEntry(lines, path);
  if (!e) return otherForm(lines, path) ? { text, note: cantEdit(path, "remove it yourself") } : { text };
  if (!e.sure) return { text, note: `~/.codex/config.toml: couldn't tell where the entry for ${path} ends: left alone (remove it yourself)` };
  let { start, end } = e;
  const restBlank = end >= lines.length || lines[end].trim() === "";
  if (start > 0 && lines[start - 1].trim() === "" && restBlank) start--;
  lines.splice(start, end - start);
  const out = lines.join(eol);
  return otherForm(lines, path) ? { text: out, note: cantEdit(path, "remove the rest yourself") } : { text: out };
}

/** Repoint the entry at a new path, in place, keeping its settings; when `to` is already listed, drop the old one. */
export function moveTrust(text, from, to) {
  const eol = eolOf(text), lines = text.split(eol);
  const i = lines.findIndex((l) => l.trim() === header(from));
  if (i < 0) return otherForm(lines, from) ? { text, note: cantEdit(from, `point it at ${to} yourself`) } : { text };
  if (findEntry(lines, to) || otherForm(lines, to)) return removeTrust(text, from);
  lines[i] = header(to);
  return { text: lines.join(eol) };
}

// ---- the table ----

/** One entry per harness. `files(dirs)`: specs under the loop folder. `user`: edits to a file under the user's home. */
export const HARNESSES = [
  {
    name: "claude",
    files: (dirs) => [{ path: ".claude/settings.json", merge: claudeSettings(dirs) }],
  },
  {
    name: "codex",
    // Codex reads AGENTS.md from the cwd: a relative link keeps it in sync with CLAUDE.md and survives a rename.
    files: (dirs) => [
      { path: ".codex/config.toml", merge: codexConfig(dirs) },
      { path: "AGENTS.md", link: "CLAUDE.md" },
    ],
    // .codex/config.toml only applies to a trusted folder; skipped when `requires` (Codex's own folder) is absent.
    user: { path: ".codex/config.toml", requires: ".codex", add: addTrust, remove: removeTrust, move: moveTrust },
  },
];

/** The files to write in a loop folder: this computer's launch folders (a worktree where there is one), no remote ones. */
export function harnessFiles(manifest) {
  const dirs = launchDirsOn(manifest, null);
  return HARNESSES.flatMap((h) => h.files(dirs).map((f) => ({ harness: h.name, ...f })));
}
