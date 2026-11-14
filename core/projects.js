// projects.js: a project is a reusable bundle of context for a kind of work (e.g. "study": media into decks and tests).
// Pure; the CLI reads the folders. A project is a folder:
//
//   project.json      { name, description, triggers: { words: [], urls: [] }, repos: [], requires: {...}, ... }
//   CONTEXT.md     what every agent should know; copied into the loop's CLAUDE.md
//   .claude-plugin/plugin.json + skills/ (+ .mcp.json)   so the folder loads as a Claude Code plugin (--plugin-dir)
//
// A loop lists its projects by name in loop.json ("projects"). Agents started in it get each project's folder as a plugin
// (its skills and tools) and its repos as --add-dir folders; CLAUDE.md gets each project's CONTEXT.md.

import { replaceBlock, endOfBlock } from "./blocks.js";

/** Projects whose triggers appear in `text`, best first: [{ name, score, hits }]. URL hits count double. */
export function matchProjects(projects, text) {
  const t = String(text ?? "").toLowerCase();
  const out = [];
  for (const p of projects) {
    const hits = [];
    let score = 0;
    for (const u of p.triggers?.urls ?? []) if (t.includes(u.toLowerCase())) { hits.push(u); score += 2; }
    for (const w of p.triggers?.words ?? []) {
      const re = new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
      if (re.test(t)) { hits.push(w); score += 1; }
    }
    if (score) out.push({ name: p.name, score, hits });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Matches strong enough to pre-tick: a link hit (score 2) or two or more trigger words. One stray word isn't. */
export function strongMatches(matches) {
  return matches.filter((m) => m.score >= 2);
}

/** Add a project name once. Returns a new manifest (or the same one when it is already there). */
export function addProject(manifest, name) {
  const projects = manifest.projects ?? [];
  if (projects.includes(name)) return manifest;
  return { ...manifest, projects: [...projects, name] };
}

/** Remove a project name. Returns a new manifest (or the same one when it isn't there). */
export function removeProject(manifest, name) {
  const projects = manifest.projects ?? [];
  if (!projects.includes(name)) return manifest;
  return { ...manifest, projects: projects.filter((p) => p !== name) };
}

/**
 * What the loop's projects add to an agent's launch. `found`: [{ name, dir, repos }] for the loop's projects that exist
 * (repos already resolved to absolute paths). Returns { pluginDirs, dirs, missing }.
 */
export function projectLaunch(manifest, found) {
  const pluginDirs = [], dirs = [], missing = [];
  for (const name of manifest.projects ?? []) {
    const p = found.find((f) => f.name === name);
    if (!p) { missing.push(name); continue; }
    pluginDirs.push(p.dir);
    for (const r of p.repos ?? []) if (!dirs.includes(r)) dirs.push(r);
  }
  return { pluginDirs, dirs, missing };
}

export const PROJECTS_START = "<!-- omniloop:projects -->";
export const PROJECTS_END = "<!-- /omniloop:projects -->";

/** The CLAUDE.md block for the loop's projects. `contexts`: [{ name, text }] (each project's CONTEXT.md). */
export function projectsBlock(contexts) {
  if (!contexts.length) return `${PROJECTS_START}\n${PROJECTS_END}`;
  const body = contexts.map((c) => c.text.trim()).join("\n\n");
  const names = contexts.map((c) => `\`${c.name}\``).join(", ");
  return `${PROJECTS_START}\n<!-- Projects: ${names}. This block is rewritten by omniloop; edit the project, not this. -->\n${body}\n${PROJECTS_END}`;
}

/** Replace (or add, after the context block or at the end) the projects block in a CLAUDE.md. */
export function withProjectsBlock(text, contexts, notes = []) {
  const anchor = (t, block) => {
    const c = endOfBlock(t, "<!-- /omniloop:context -->");
    return c >= 0 ? t.slice(0, c) + `\n\n${block}` + t.slice(c) : `${t.trimEnd()}\n\n${block}\n`;
  };
  const r = replaceBlock(text, PROJECTS_START, PROJECTS_END, projectsBlock(contexts), anchor);
  if (r.note) notes.push(r.note);
  return r.text;
}
