#!/usr/bin/env node
// panel-loops.mjs: every loop on this machine as one JSON array, for the docked panel (mod-panel). The panel
// can't list folders itself, so it runs this. Each:
//   { id, goals, dirs: [{ path, machine, files }], projects: [{ name, description, files }], notes, tasks, touched }
// touched is the newest change (ms) to loop.json, tasks.json or feed.jsonl. `files` says which instructions a
// folder or project carries, looking only at its top (it runs every few seconds): CLAUDE.md, AGENTS.md,
// CONTEXT.md (projects), and .claude/skills, .claude/agents or skills/ (projects). { checked: true, ... } when it
// looked; a folder kept on another machine is left unchecked, a project that isn't found is { missing: true }.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openGoals } from "../core/goals.js";
import { openTasks } from "../core/tasks.js";
import { validId } from "../core/loopdir.js";

const root = process.argv[2] ?? join(homedir(), "loops");
// Your own projects win over the ones shipped with omniloop (as in bin/omniloop.mjs).
const PROJECT_ROOTS = [join(root, "projects"), join(dirname(fileURLToPath(import.meta.url)), "..", "projects")];
const json = async (p) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };
const mtime = async (p) => { try { return (await stat(p)).mtimeMs; } catch { return 0; } };
const isFile = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };
const kids = async (p) => (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => !d.name.startsWith("."));

// Skills are folders holding SKILL.md; agents are .md files.
async function skillsIn(dir) {
  const out = [];
  for (const d of await kids(dir)) if (d.isDirectory() && (await isFile(join(dir, d.name, "SKILL.md")))) out.push({ name: d.name, path: join(dir, d.name, "SKILL.md") });
  return out;
}
async function agentsIn(dir) {
  return (await kids(dir)).filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => ({ name: d.name.replace(/\.md$/, ""), path: join(dir, d.name) }));
}
async function filesOf(dir, { project = false } = {}) {
  const at = async (name) => ((await isFile(join(dir, name))) ? join(dir, name) : null);
  return {
    checked: true,
    context: project ? await at("CONTEXT.md") : null,
    claude: await at("CLAUDE.md"),
    agents: await at("AGENTS.md"),
    skills: [...(await skillsIn(join(dir, ".claude", "skills"))), ...(project ? await skillsIn(join(dir, "skills")) : [])],
    agentDefs: await agentsIn(join(dir, ".claude", "agents")),
  };
}

const projectCache = new Map();
async function project(name) {
  if (projectCache.has(name)) return projectCache.get(name);
  let found = { name, description: "", files: { checked: true, missing: true } };
  for (const r of PROJECT_ROOTS) {
    const dir = join(r, name);
    const j = await json(join(dir, "project.json"));
    if (j) { found = { name, description: j.description ?? "", dir, files: await filesOf(dir, { project: true }) }; break; }
  }
  projectCache.set(name, found);
  return found;
}

const names = await readdir(root).catch(() => []);
const out = [];
for (const id of names) {
  if (!validId(id)) continue;
  const dir = join(root, id);
  const m = await json(join(dir, "loop.json"));
  if (!m || typeof m !== "object" || (m.id && m.id !== id)) continue; // a renamed loop's old name links to the new folder
  const tf = await json(join(dir, "tasks.json"));
  const touched = Math.max(await mtime(join(dir, "loop.json")), await mtime(join(dir, "tasks.json")), await mtime(join(dir, "feed.jsonl")));
  const dirs = [];
  for (const d of Array.isArray(m.dirs) ? m.dirs : []) dirs.push({ ...d, files: d.machine ? null : await filesOf(d.path) });
  const projects = [];
  for (const p of Array.isArray(m.projects) ? m.projects : []) projects.push(await project(p));
  out.push({ id, goals: openGoals(m), dirs, projects, notes: await filesOf(dir), tasks: openTasks(tf ?? {}), touched, temp: m.temp === true });
}
process.stdout.write(JSON.stringify(out));
