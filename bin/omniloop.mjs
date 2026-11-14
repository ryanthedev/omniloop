#!/usr/bin/env node
// omniloop: run work as loops of agents in terminals owned by a backend: herdr-core (`hc`) or omni (`omni`), see bin/lib/backend.
// Needs only that backend's CLI and node.
// Output is short on purpose: agents read it, and every line costs them tokens.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, rm, rename, open, stat, lstat, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL, COORDINATOR_KEYS, isCoordinatorLabeled, buildLoops, statusOf } from "../core/omniloop.js";
import { initState, step, parseDuration, touchedByYou, sendFailed, hold, withoutReplies, adoptions, ADOPT_AFTER_MS, ADOPTED } from "../core/watch.js";
import { validId, loopHome, newManifest, addDir, removeDir, dirsOn, launchDirsOn, worktreeChoice, worktreeTarget, worktreeBranch, setWorktree, overlaps, agentArgv, parseAliasWords, sharedWith, LOOPS_DIR } from "../core/loopdir.js";
import { bootstrapLoop, refreshClaudeMd } from "./lib/harness-apply.mjs";
import { matchProjects, addProject, removeProject, projectLaunch } from "../core/projects.js";
import { goalsOf, openGoals, setGoal, addGoal, finishGoal, editGoal, goalNote } from "../core/goals.js";
import { feedEntry, feedLine, parseFeed, replyPlan, FEED_FILE } from "../core/feed.js";
import { proposeArgs, checkProposal, fallbackProposal, identityTerms } from "../core/intake.js";
import { userInfo, hostname } from "node:os";
import { deliver, liveSessions, hookRecords, turnRecord, foregroundPid } from "./lib/sock.mjs";
import { YOU, addTask, finishTask, giveTask, editTask, reopenTask, removeTask, openTasks, taskLines, taskNote, tasksOf } from "../core/tasks.js";
import { claudeProjectKey, isLoopClaudeEntry, renamedManifest, renameText, withFormerlyNote, removeCheck, endedTempLoops, tempId, scrubHistory, NO_MEMORY_ENV, NO_MEMORY_TOOLS } from "../core/lifecycle.js";
import { goalHint } from "../core/goalwords.js";
import { selectBackend } from "./lib/backend/index.mjs";

const run = promisify(execFile);
const HOME = process.env.OMNILOOP_HOME ?? join(homedir(), ".cache", "omniloop");
const TIMERS = join(HOME, "timers");
const TICK_MS = 15_000;
const WATCHER_FRESH_MS = 45_000;

// Start programs through the user's login shell, so they get the PATH and tools of a normal terminal.
const viaLogin = (argv) => [process.env.SHELL || "/bin/sh", "-lc", 'exec "$@"', "omniloop", ...argv];

// Every terminal call goes through this port (HerdrBackend or OmniBackend; OMNILOOP_BACKEND=omni|herdr, see core/backend.js).
const backend = selectBackend();
const me = () => backend.self();
const SHELL = process.env.SHELL || "/bin/sh";
// This folder holds the `omniloop` command; agents get it on their PATH.
const BIN = dirname(fileURLToPath(import.meta.url));
const LOOPS = join(homedir(), "loops");

// ---- loop folders --------------------------------------------------------------------------

async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function writeJson(path, v) { await writeFile(path + ".tmp", JSON.stringify(v, null, 2) + "\n"); await rename(path + ".tmp", path); }
const manifestOf = (id) => readJson(join(loopHome(homedir(), id), "loop.json"));

// How the user starts Claude: ~/loops/config.json "claude" (edit it to change), else their shell's `claude`
// alias (it carries their settings and plugins; a non-interactive shell would skip it), else plain claude.
async function claudeLaunch() {
  const cfgPath = join(LOOPS, "config.json");
  const cfg = (await readJson(cfgPath)) ?? {};
  if (Array.isArray(cfg.claude) && cfg.claude.length) return cfg.claude;
  let argv = ["claude"];
  try {
    const { stdout } = await run(SHELL, ["-ic", 'eval "set -- ${aliases[claude]}"; print -rl -- "$@"'], { timeout: 10_000 });
    const words = parseAliasWords(stdout);
    if (words[0]?.endsWith("claude")) argv = words;
  } catch {}
  await mkdir(LOOPS, { recursive: true });
  await writeJson(cfgPath, { ...cfg, claude: argv });
  return argv;
}

// ---- projects ---------------------------------------------------------------------------------
// Your own projects (~/loops/projects) first, then the ones shipped with omniloop; the first of a name wins.
const PROJECT_DIRS = [join(LOOPS, "projects"), join(BIN, "..", "projects")];

async function loadProjects() {
  const out = [];
  for (const root of PROJECT_DIRS) {
    const names = await readdir(root).catch(() => []);
    for (const n of names.sort()) {
      const dir = join(root, n);
      const j = await readJson(join(dir, "project.json"));
      if (!j?.name || out.some((p) => p.name === j.name)) continue;
      out.push({ ...j, dir, repos: (j.repos ?? []).map(resolvePath) });
    }
  }
  return out;
}

/** The loop's context folders plus its projects' repos and plugin folders, for an agent on this computer. */
// omniloop's own plugin (its goal hook) goes to every agent started in a loop with a folder.
const PLUGIN = join(BIN, "..", "plugin");

async function launchOf(manifest) {
  if (!manifest) return { dirs: [], pluginDirs: [], noMemory: null };
  const { pluginDirs, dirs, missing } = projectLaunch(manifest, await loadProjects());
  if (missing.length) console.error(`omniloop: loop ${manifest.id} lists missing project(s): ${missing.join(", ")}`);
  const all = launchDirsOn(manifest);
  for (const d of dirs) if (!all.includes(d)) all.push(d);
  return { dirs: all, pluginDirs: [PLUGIN, ...pluginDirs], noMemory: manifest.temp ? { env: NO_MEMORY_ENV, tools: NO_MEMORY_TOOLS } : null };
}

/** The projects' CONTEXT.md for a loop's CLAUDE.md: [{ name, text }]. */
async function projectContexts(manifest) {
  const projects = await loadProjects();
  const contexts = [];
  for (const name of manifest.projects ?? []) {
    const p = projects.find((x) => x.name === name);
    const text = p && (await readFile(join(p.dir, "CONTEXT.md"), "utf8").catch(() => null));
    if (text) contexts.push({ name, text });
  }
  return contexts;
}

/**
 * Bring a loop's CLAUDE.md up to date (harness-apply.mjs refreshClaudeMd): only its managed blocks change. A file that
 * can't be read, or a block with damaged markers, is left alone with a note on stderr. `edit`: see refreshClaudeMd.
 */
async function writeClaudeMd(home, manifest, edit = undefined) {
  const r = await refreshClaudeMd(home, manifest, { contexts: await projectContexts(manifest), edit });
  for (const n of r.notes) console.error(`omniloop: ${n}`);
}

/** Harness config (core/harness.js) for a loop folder; a problem is one line, never a failure. */
async function bootstrapHarnesses(home, manifest) {
  let lines;
  try { lines = await bootstrapLoop(home, manifest, { claude: false }); } catch (e) { lines = [`failed (${String(e.message).split("\n")[0]})`]; }
  if (lines.length) console.log(`  harness config: ${lines.join("; ")}`);
}

/** Split a claude command line into its flags and its task: the last word, unless it's a flag or a flag's value. */
function splitTask(argv) {
  const rest = argv.slice(1);
  const n = rest.length;
  if (n && !rest[n - 1].startsWith("-") && (n === 1 || !rest[n - 2].startsWith("-"))) return { flags: rest.slice(0, -1), task: rest[n - 1] };
  return { flags: rest, task: null };
}
function die(msg) { console.error(`omniloop: ${msg}`); process.exit(1); }

// Flags that never take a value, so `--json some text` keeps the text.
const BOOL = new Set(["json", "all", "dry-run", "coordinator", "no-coordinator", "temp", "force", "purge", "auto"]);
// Old flag names, still accepted (silently) as aliases of the new ones.
const FLAG_ALIAS = { lead: "coordinator", "no-lead": "no-coordinator" };
function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); flags["--"] = true; break; }
    if (a.startsWith("--")) {
      const k = FLAG_ALIAS[a.slice(2)] ?? a.slice(2);
      const v = argv[i + 1];
      if (BOOL.has(k) || v === undefined || v.startsWith("--")) flags[k] = true; else { flags[k] = v; i++; }
    } else rest.push(a);
  }
  return { flags, rest };
}

const allTerminals = () => backend.list();

/** Keep the backend's own loop (omni) in step with loop.json. Best effort: the labels stay the source of truth. */
const mirrorLoop = (id, m) => backend.syncLoop(id, { goal: openGoals(m)[0]?.text ?? m.goal, dirs: (m.dirs ?? []).filter((d) => !d.machine).map((d) => d.path) })
  .catch((e) => console.error(`omniloop: ${backend.name} didn't take loop ${id}'s goal and folders: ${String(e.stderr || e.message).trim().split("\n")[0]}`));

/** Type a note into a terminal now (the guard "idle" refuses unless it is waiting); throws when it was not typed. */
async function typed(address, text, guard = null) {
  const r = await backend.send(address, text, { if: guard });
  if (r.code !== 0) throw new Error(`${backend.name} send exit ${r.code}: ${r.output.trim().slice(0, 100)}`);
}

// ---- commands -------------------------------------------------------------------------------

async function cmdLs({ rest }) {
  const built = buildLoops(await allTerminals());
  const loops = built.loops.filter((l) => !rest[0] || l.id === rest[0]);
  if (!loops.length) return console.log(rest[0] ? `no loop ${rest[0]}` : "no loops");
  for (const l of loops) {
    console.log(`${l.id}${l.goal ? ` — ${l.goal}` : ""} (coordinator: ${l.coordinator ?? "you"})${l.warnings.length ? ` ! ${l.warnings.join("; ")}` : ""}`);
    const by = new Map(l.agents.map((m) => [m.address, m]));
    const show = (a, depth) => {
      const m = by.get(a);
      const st = m.status + (m.kind ? `/${m.kind}` : "");
      const name = m.terminal.labels["omniloop.job"] ?? m.terminal.title ?? "";
      console.log(`${"  ".repeat(depth + 1)}${a}${m.isCoordinator ? "*" : ""} ${st}${name ? ` ${String(name).slice(0, 50)}` : ""}${m.needsYou ? " [needs you]" : ""}`);
      for (const c of m.children) show(c, depth + 1);
    };
    for (const r of l.roots) show(r, 0);
  }
}

async function cmdStart({ flags, rest }) {
  const loop = rest.shift();
  if (!loop || !flags["--"] || !rest.length) die("usage: omniloop start <loop> [--coordinator] [--to T] [--job J] [--goal G] [--cwd D] -- <program...>");
  const to = flags.to ?? (flags.coordinator ? null : me());
  const labels = { [LABEL.loop]: loop };
  if (flags.coordinator) for (const k of COORDINATOR_KEYS) labels[k] = "1";
  if (to) labels[LABEL.reportsTo] = to;
  if (flags.goal) labels[LABEL.goal] = flags.goal;
  if (flags.job) labels["omniloop.job"] = flags.job;
  const manifest = await manifestOf(loop);
  let argv;
  if (/(^|\/)claude$/.test(rest[0])) {
    // A Claude subagent: the user's own claude flags, the loop's context folders, and a task that starts with the brief.
    const { flags, task } = splitTask(rest);
    argv = agentArgv({ shell: SHELL, claudeArgv: [...(await claudeLaunch()), ...flags], ...(await launchOf(manifest)), binDir: BIN,
      task: task ? `First run \`omniloop brief\`. ${task}` : null });
  } else argv = viaLogin(rest);
  // In a loop with a folder, start in it (the agents' shared Claude project), in the loop's own space when it has one.
  const spec = { argv, cwd: flags.cwd ?? (manifest ? loopHome(homedir(), loop) : undefined), labels, loop, role: flags.coordinator ? "lead" : "helper",
    space: flags.space, inLoopSpace: Boolean(manifest), starter: me() };
  if (flags["dry-run"]) { const { cmd, args } = await backend.spawnPlan(spec); return console.log(JSON.stringify({ [cmd]: args }, null, 1)); }
  console.log((await backend.spawn(spec)).address);
}

async function cmdJoin({ flags, rest }) {
  const loop = rest[0];
  const t = flags.terminal ?? me();
  if (!loop || !t) die("usage: omniloop join <loop> [--coordinator] [--to T] [--goal G] [--job J] [--terminal T]");
  const kv = [`${LABEL.loop}=${loop}`];
  if (flags.coordinator) kv.push(...COORDINATOR_KEYS.map((k) => `${k}=1`));
  if (flags.to) kv.push(`${LABEL.reportsTo}=${flags.to}`);
  if (flags.goal) kv.push(`${LABEL.goal}=${flags.goal}`);
  if (flags.job) kv.push(`omniloop.job=${flags.job}`);
  await backend.label(t, kv);
  // The labels are what omniloop reads; the backend's own loop (omni) follows when it lets this caller place the pane.
  await backend.place(t, loop, flags.coordinator ? "lead" : "helper").catch((e) => console.error(`omniloop: ${t} is labelled, but ${backend.name} did not move it into ${loop}: ${String(e.stderr || e.message).trim().split("\n")[0]}`));
  console.log(`${t} in ${loop}`);
}

async function cmdLeave({ flags }) {
  const t = flags.terminal ?? me();
  await backend.label(t, [LABEL.loop, ...COORDINATOR_KEYS, LABEL.reportsTo, LABEL.goal, LABEL.notify, LABEL.needs, "omniloop.job"].map((k) => `${k}=`));
  await backend.place(t, null).catch(() => {});
  console.log(`${t} left its loop`);
}

async function cmdNeedsYou({ flags, rest }) {
  const t = flags.terminal ?? me();
  const off = rest[0] === "off";
  await backend.label(t, [`${LABEL.needs}=${off ? "" : "you"}`]);
  console.log(off ? "cleared" : "the user will be told when you stop");
}

/** Drop a timer file for the watcher (`note: true`: the text is a finished note, delivered without a "timer:" prefix). */
async function putTimer({ at, to, text, note = false }) {
  await mkdir(TIMERS, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tmp = join(TIMERS, `.${id}`);
  await writeFile(tmp, JSON.stringify({ id, at, to, text, ...(note ? { note: true } : {}) }));
  await rename(tmp, join(TIMERS, `${id}.json`));
  return id;
}

async function cmdTimer({ flags, rest }) {
  const ms = parseDuration(rest[0]);
  const text = rest.slice(1).join(" ");
  const to = flags.to ?? me();
  if (ms == null || !text || !to) die("usage: omniloop timer <20m|1h|90s> <text> [--to T]");
  const id = await putTimer({ at: Date.now() + ms, to, text });
  console.log(`timer ${id}: ${to} hears "${text}" in ${rest[0]} (once it stops working)`);
}

async function cmdHandoff({ flags, rest }) {
  const file = rest[0];
  const old = flags.terminal ?? me();
  if (!file || !old) die("usage: omniloop handoff <handoff-file> [--terminal T]");
  const t = await backend.get(old);
  if (!t.labels?.[LABEL.loop]) die(`${old} is in no loop`);
  const argv = t.foreground?.argv ?? [];
  if (!/claude/.test(argv[0] ?? "")) die(`${old} runs ${argv[0] ?? "nothing"}; handoff only restarts Claude Code`);
  // Same program and flags, a fresh conversation: drop a trailing prompt and resume flags.
  const keep = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--resume", "-r", "--continue", "-c"].includes(argv[i])) { if (argv[i] === "--resume" || argv[i] === "-r") i++; continue; }
    keep.push(argv[i]);
  }
  if (keep.length > 1 && !keep[keep.length - 1].startsWith("-") && !keep[keep.length - 2]?.startsWith("--")) keep.pop();
  const labels = Object.entries(t.labels).filter(([k]) => k.startsWith("omniloop") || k === "herdr.space");
  // In a loop with a folder, start fresh from it (the user's claude, the loop's context folders, its CLAUDE.md);
  // otherwise reuse the old command line and folder. The task goes right after the program (see agentArgv).
  const manifest = await manifestOf(t.labels[LABEL.loop]);
  const base = manifest ? await claudeLaunch() : keep;
  const loopId = t.labels[LABEL.loop];
  const r = await backend.spawn({ cwd: manifest ? loopHome(homedir(), manifest.id) : t.cwd, labels: Object.fromEntries(labels), loop: loopId,
    role: isCoordinatorLabeled(t.labels) ? "lead" : "helper",
    argv: agentArgv({ shell: SHELL, claudeArgv: base, ...(await launchOf(manifest)), binDir: BIN,
      task: `First run \`omniloop brief\`. Then read ${file} and continue where it leaves off.` }) });
  await backend.label(old, [`${LABEL.retired}=${r.address}`, ...COORDINATOR_KEYS.map((k) => `${k}=`)]);
  // Re-point the old one's reports.
  const kids = (await allTerminals()).filter((x) => x.labels?.[LABEL.reportsTo] === old);
  for (const k of kids) await backend.label(k.address, [`${LABEL.reportsTo}=${r.address}`]);
  // And its open tasks.
  let moved = 0;
  if (manifest) await withTasks(loopHome(homedir(), manifest.id), (f) => {
    let file = f;
    for (const x of tasksOf(f)) if (!x.done && x.for === old) { file = giveTask(file, x.n, r.address).file; moved++; }
    return { file };
  });
  console.log(`${r.address} continues as ${old}; ${kids.length} report(s) and ${moved} task(s) moved. You can stop now.`);
}

// ---- a worktree per loop, for a repo another loop already uses ----------------------------------

async function git(dir, args) { return (await run("git", ["-C", dir, ...args], { timeout: 30_000 })).stdout.trim(); }
const exists = async (p) => Boolean(await stat(p).catch(() => null));

/**
 * Give the loop its own git worktree of each folder on this computer that another loop already uses (core/loopdir.js
 * worktreeChoice: whole repos with commits, never live config). `only`: just that folder. Fails soft: on any git
 * error the folder stays shared and the line says why. Never stashes, commits or inits anything.
 * Returns { manifest, lines } (one line per folder, for the command's output).
 */
async function isolateDirs(id, manifest, { dry = false, only = null } = {}) {
  const home = loopHome(homedir(), id);
  const others = (await allManifests()).filter((o) => o.id !== id);
  let m = manifest;
  const lines = [];
  for (const d of manifest.dirs) {
    if (d.machine || d.worktree || (only && d.path !== only)) continue;
    let top = null, commits = 0, real = d.path;
    try { real = await realpath(d.path); top = await git(d.path, ["rev-parse", "--show-toplevel"]); commits = Number(await git(d.path, ["rev-list", "--count", "HEAD"])) || 0; } catch {}
    const using = others.filter((o) => dirsOn(o).some((p) => overlaps(p, d.path))).map((o) => o.id);
    const choice = worktreeChoice(real, { home: homedir(), top, commits, others: using });
    if (!choice.worktree) { lines.push(`  ${d.path}: shared (${choice.why})`); continue; }
    if (dry) { lines.push(`  ${d.path}: would get its own worktree (${choice.why})`); continue; }
    try {
      const taken = m.dirs.map((x) => x.worktree).filter(Boolean);
      let target = worktreeTarget(home, d.path, taken);
      while (await exists(target)) target = worktreeTarget(home, d.path, [...taken, target]);
      const branch = worktreeBranch(id);
      const has = await git(d.path, ["branch", "--list", branch]);
      await git(d.path, ["worktree", "add", target, ...(has ? [branch] : ["-b", branch])]);
      const onto = await git(d.path, ["branch", "--show-current"]);
      const base = await git(target, ["rev-parse", "--short", "HEAD"]);
      const dirty = (await git(d.path, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
      m = setWorktree(m, d.path, { worktree: target, branch, base, dirty, onto });
      lines.push(`  ${d.path}: own copy ${target} on ${branch} (${choice.why})${dirty ? `; ${dirty} uncommitted file(s) there are not in it` : ""}`);
    } catch (e) {
      lines.push(`  ${d.path}: shared (no worktree: ${String(e.stderr || e.message || e).trim().split("\n")[0].slice(0, 140)})`);
    }
  }
  return { manifest: m, lines };
}

async function cmdNew({ flags, rest }) {
  const temp = Boolean(flags.temp);
  const id = rest[0] ?? (temp ? tempId(Date.now(), (await allManifests()).map((m) => m.id)) : null);
  if (!validId(id)) die("usage: omniloop new <id> [--goal G] [--dir D]... [--project P]... [--task T] [--no-coordinator] [--temp]   (id: a-z 0-9 - _; --temp: no id needed)");
  const home = loopHome(homedir(), id);
  await dropAlias(id);
  if (await manifestOf(id)) die(`loop ${id} already exists: ${home}`);
  if (temp && typeof flags.goal !== "string") flags.goal = "A temporary loop: do what the user asks, then it deletes itself.";
  const dirs = [];
  for (let i = 0; i < argvRaw.length; i++) if (argvRaw[i] === "--dir" && argvRaw[i + 1]) dirs.push(resolvePath(argvRaw[++i]));
  if (typeof flags.goal !== "string" || !flags.goal.trim()) die("every loop needs a goal: omniloop new <id> --goal \"what this loop is for\"");
  let manifest = newManifest({ id, goal: flags.goal.replace(/\s+/g, " ").trim(), dirs, now: Date.now() });
  if (temp) manifest = { ...manifest, temp: true };
  const known = await loadProjects();
  // Several projects: --project a --project b, or --project a,b.
  for (let i = 0; i < argvRaw.length; i++) if (argvRaw[i] === "--project" && argvRaw[i + 1]) {
    for (const name of argvRaw[++i].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!known.some((p) => p.name === name)) die(`no project named ${name} (omniloop project ls)`);
      manifest = addProject(manifest, name);
    }
  }
  const dry = Boolean(flags["dry-run"]);
  if (!dry) await mkdir(home, { recursive: true });
  const iso = await isolateDirs(id, manifest, { dry });
  manifest = iso.manifest;
  if (!dry) {
    await writeJson(join(home, "loop.json"), manifest);
    await writeClaudeMd(home, manifest);
    await bootstrapHarnesses(home, manifest);
    await mirrorLoop(id, manifest);
  }
  const np = manifest.projects?.length ?? 0;
  console.log(`${temp ? "temporary " : ""}loop ${id}: ${home} (${dirs.length} context folder${dirs.length === 1 ? "" : "s"}${np ? `; project${np === 1 ? "" : "s"} ${manifest.projects.join(", ")}` : ""})${dry ? " [dry run: nothing written]" : ""}`);
  for (const l of iso.lines) console.log(l);
  if (flags["no-coordinator"]) return;

  // A space named after the loop, started in its folder, with the coordinator as its first tab.
  // A project with "autostart" (study) makes the goal a whole job ("study <link>"): start on it. Otherwise ask first.
  const autostart = manifest.goal && known.some((p) => p.autostart && manifest.projects?.includes(p.name));
  const task = typeof flags.task === "string" ? flags.task : autostart
    ? `You coordinate the loop ${id}. Read CLAUDE.md, run \`omniloop brief\`, then do the goal with your project's skill: ${manifest.goal}`
    : temp ? `You coordinate the temporary loop ${id}. Read CLAUDE.md, run \`omniloop brief\`, then ask the user what to do first. When they say they're done, run \`omniloop rm\`.`
    : `You coordinate the loop ${id}. Read CLAUDE.md, run \`omniloop brief\`, then ask the user what to do first.`;
  await startCoordinator(id, manifest, task, { dry: flags["dry-run"] });
}

/**
 * Start a loop's coordinator on this computer and label it (the backend decides where it lives: herdr, a tab in the
 * loop's space or a new space named after the loop; omni, the loop's lead pane). See HerdrBackend.startCoordinator.
 */
async function startCoordinator(id, manifest, task, { dry = false } = {}) {
  const home = loopHome(homedir(), id);
  const argv = agentArgv({ shell: SHELL, claudeArgv: await claudeLaunch(), ...(await launchOf(manifest)), task, binDir: BIN });
  const labels = { [LABEL.loop]: id, ...Object.fromEntries(COORDINATOR_KEYS.map((k) => [k, "1"])), "omniloop.job": "coordinator", ...(manifest.goal ? { [LABEL.goal]: manifest.goal } : {}) };
  const dirs = (manifest.dirs ?? []).filter((d) => !d.machine).map((d) => d.path);
  const r = await backend.startCoordinator({ id, home, argv, labels, goal: manifest.goal, dirs }, { dry });
  if (dry) return console.log(JSON.stringify(r.plan, null, 1));
  console.log(`coordinator ${r.address} in space ${id}`);
}

/**
 * omniloop revive <id>: start a fresh coordinator for a loop nobody is running in (Enter on an idle loop in ⌘O). It catches
 * up from the loop's own notes and asks; it never redoes a project's autostart job. A loop with a running coordinator
 * gets nothing new: its coordinator's address is printed instead. This computer's loops only.
 */
async function cmdRevive({ flags, rest }) {
  const id = rest[0];
  if (!validId(id)) die("usage: omniloop revive <id> [--dry-run]");
  const manifest = await manifestOf(id);
  if (!manifest) die(`loop ${id} has no folder here (${loopHome(homedir(), id)})`);
  const built = buildLoops(await allTerminals());
  const live = built.loops.find((l) => l.id === id);
  if (live?.coordinator) return console.log(`coordinator ${live.coordinator} in space ${id} (already running)`);
  const task = typeof flags.task === "string" ? flags.task
    : `You coordinate the loop ${id}, picking it up again: nobody was running in it. Read CLAUDE.md (goal and decisions), run \`omniloop brief\`, \`omniloop task ls\` and \`omniloop feed\`, and \`engram search "${id}"\`. Then tell the user in a few lines where things stand and ask what to do next.`;
  await startCoordinator(id, manifest, task, { dry: flags["dry-run"] });
}

function resolvePath(p) {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p.startsWith("/") ? p : join(process.cwd(), p);
}

async function cmdAddDir({ flags, rest }) {
  const path = rest[0] && resolvePath(rest[0]);
  let id = typeof flags.loop === "string" ? flags.loop : null;
  if (!id && me()) id = (await backend.get(me()).catch(() => null))?.labels?.[LABEL.loop] ?? null;
  if (!path || !id) die("usage: omniloop add-dir <path> [--loop id] [--on machine]");
  const home = loopHome(homedir(), id);
  const m = await manifestOf(id);
  if (!m) die(`loop ${id} has no folder (${home}); make one with omniloop new`);
  const on = typeof flags.on === "string" ? flags.on : null;
  let next = addDir(m, path, on);
  if (next === m) return console.log(`${path} is already in ${id}`);
  let lines = [];
  if (!on) ({ manifest: next, lines } = await isolateDirs(id, next, { only: path }));
  await writeJson(join(home, "loop.json"), next);
  await writeClaudeMd(home, next);
  await bootstrapHarnesses(home, next);
  console.log(`added ${path}${on ? ` (on ${on})` : ""} to ${id}: agents started from now get it. Running ones see it in CLAUDE.md; reading it may ask for approval until they hand off.`);
  for (const l of lines) console.log(l);
}

// omniloop bootstrap [<loop> | --all] [--dry-run]: (re)apply every harness's config to existing loops and refresh the
// managed blocks of their CLAUDE.md. A loop that can't be handled is one printed line, never a failed command.
async function bootstrapOne(id, dry) {
  const home = loopHome(homedir(), id);
  let m;
  try { m = JSON.parse(await readFile(join(home, "loop.json"), "utf8")); }
  catch (e) { return `${id}: loop.json can't be used (${e.code ?? "not valid JSON"}): left alone`; }
  if (m?.id !== id || !Array.isArray(m.dirs)) return `${id}: loop.json has no id and dirs list that fit: left alone`;
  try {
    const lines = await bootstrapLoop(home, m, { contexts: await projectContexts(m), dry });
    return `${dry ? "would bootstrap" : "bootstrapped"} ${id}${lines.length ? `: ${lines.join("; ")}` : " (already up to date)"}`;
  } catch (e) { return `${id}: failed (${String(e.message).split("\n")[0]})`; }
}

async function cmdBootstrap({ flags, rest }) {
  const dry = Boolean(flags["dry-run"]);
  if (flags.all) {
    if (rest.length) die("usage: omniloop bootstrap [<loop> | --all] [--dry-run]");
    const root = join(homedir(), LOOPS_DIR);
    // Real folders only: a renamed loop leaves its old name as a link to the new folder.
    const names = [];
    for (const n of (await readdir(root).catch(() => [])).sort()) if (validId(n) && (await lstat(join(root, n)).catch(() => null))?.isDirectory()) names.push(n);
    if (!names.length) return console.log("no loops here");
    for (const n of names) console.log(await bootstrapOne(n, dry));
    return;
  }
  const id = rest[0] ?? (await loopOfMe(flags));
  if (!validId(id)) die("usage: omniloop bootstrap [<loop> | --all] [--dry-run]   (in a loop, <loop> defaults to it)");
  if (!(await exists(join(loopHome(homedir(), id), "loop.json")))) die(`no loop ${id} here`);
  console.log(await bootstrapOne(id, dry));
}

async function allManifests() {
  const root = join(homedir(), LOOPS_DIR);
  const names = await readdir(root).catch(() => []);
  // A renamed loop leaves its old name as a link to the new folder: count each loop once, under its own name.
  return (await Promise.all(names.map(async (n) => { const m = await manifestOf(n); return m?.id === n ? m : null; }))).filter(Boolean);
}

async function cmdShared({ flags }) {
  const id = await loopOfMe(flags);
  if (!id) die("usage: omniloop shared [--loop id]");
  const shared = sharedWith(await allManifests(), id);
  if (!shared.length) return console.log(`no other loop works in ${id}'s folders`);
  // Each other loop's live coordinator on this computer, to tell before a change.
  const coordinators = new Map();
  for (const t of await allTerminals().catch(() => []))
    if (t.state === "live" && isCoordinatorLabeled(t.labels) && !t.labels?.[LABEL.retired] && t.labels?.[LABEL.loop]) coordinators.set(t.labels[LABEL.loop], t.address);
  for (const s of shared) {
    console.log(s.path);
    for (const l of s.loops) console.log(`  ${l.id}${l.path !== s.path ? ` (${l.path})` : ""}: ${coordinators.has(l.id) ? `coordinator ${coordinators.get(l.id)}` : "no coordinator running (add a task with omniloop task add --loop, or tell the user)"}`);
  }
}

async function loopOfMe(flags) {
  if (typeof flags.loop === "string") return flags.loop;
  return me() ? (await backend.get(me()).catch(() => null))?.labels?.[LABEL.loop] ?? null : null;
}

async function cmdGoal({ flags, rest }) {
  const sub = rest[0] && ["set", "add", "done", "edit"].includes(rest[0]) ? rest.shift() : null;
  const id = await loopOfMe(flags);
  if (!id) die("usage: omniloop goal [set \"…\" | add \"…\" | edit <n> \"…\" | done <n>] [--loop id]");
  const home = loopHome(homedir(), id);
  const m = await manifestOf(id);
  if (!m) die(`loop ${id} has no folder (${home}); make one with omniloop new`);
  if (!sub) {
    const [cur, ...more] = openGoals(m);
    if (!cur) return console.log(`${id}: no goal. Set one: omniloop goal set "…"`);
    console.log(`${id} goal: ${cur.text}`);
    for (const g of more) console.log(`  also (${g.n}): ${g.text}`);
    return;
  }
  const now = Date.now();
  const r = sub === "set" ? setGoal(m, rest.join(" "), now) : sub === "add" ? addGoal(m, rest.join(" "), now)
    : sub === "edit" ? editGoal(m, rest[0], rest.slice(1).join(" "), now) : finishGoal(m, rest[0], now);
  if (r.error) die(r.error);
  if (r.manifest === m) return console.log(`${id}: no change`);
  const next = r.manifest;
  await writeJson(join(home, "loop.json"), next);
  await writeClaudeMd(home, next);
  await mirrorLoop(id, next);
  // The feed line comes before anything that needs herdr-core, so it lands even when hc is down.
  const gone = sub === "done" ? goalsOf(m).find((g) => String(g.n) === String(rest[0]))?.text : null;
  await postFeed(id, me() ?? YOU, sub === "set" ? `goal set: ${openGoals(next)[0]?.text ?? ""}` : sub === "add" ? `goal added: ${rest.join(" ")}` : sub === "edit" ? `goal ${rest[0]} reworded: ${rest.slice(1).join(" ")}` : `goal ${rest[0]} done${gone ? `: ${gone}` : ""}`);
  // Agents: the label carries the current goal (the tabs and status bar read it). Agents started with omniloop's
  // plugin hear about the change from its hook on their next prompt; others get the note typed in, if idle.
  let agents = [];
  try { agents = (await allTerminals()).filter((t) => !t.address.includes("/") && t.labels?.[LABEL.loop] === id && !t.labels?.[LABEL.retired]); }
  catch { console.error(`omniloop: saved, but ${backend.words.down} didn't answer, so no agent was told or relabelled`); }
  const note = goalNote(next, id);
  const told = [], later = [];
  await Promise.all(agents.map(async (t) => {
    if (next.goal !== m.goal) await backend.label(t.address, [`${LABEL.goal}=${next.goal}`]).catch(() => {});
    if (t.address === me()) return;
    if ((t.foreground?.argv ?? []).includes(PLUGIN)) return told.push(`${t.address} (hook)`);
    const st = statusOf(t);
    if (st === "idle" || st === "done") {
      // Only agents that are waiting, as the watcher does: never typed into a plain shell or a working agent.
      try { await typed(t.address, note, st === "idle" ? "idle" : null); told.push(t.address); } catch { later.push(t.address); }
    } else if (st) later.push(t.address);
  }));
  console.log(note);
  if (sub !== "done") {
    const n = sub === "edit" ? rest[0] : sub === "add" ? goalsOf(next).at(-1)?.n : openGoals(next)[0]?.n;
    const hint = goalHint(sub === "edit" ? rest.slice(1).join(" ") : rest.join(" "), n ?? 1);
    if (hint) console.log(hint);
  }
  if (told.length) console.log(`told: ${told.join(", ")}`);
  if (later.length) console.log(`not told (busy): ${later.join(", ")}; they'll see it in CLAUDE.md or \`omniloop goal\``);
}

// Several agents write one loop's files: take a lock (a folder `<name>.lock` in the loop folder), drop a stale one after 5 s.
async function withLock(home, name, f) {
  const lock = join(home, `${name}.lock`);
  // Always sleep between tries; drop a stale lock once after ~5 s; give up after ~10 s (or at once if the folder is gone).
  for (let i = 0; ; i++) {
    try { await mkdir(lock); break; } catch (e) {
      if (e.code === "ENOENT" || i > 200) throw new Error(`couldn't take the ${name} lock in ${home}${e.code === "ENOENT" ? " (no such folder)" : ""}`);
      if (i === 100) await rm(lock, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await f(); } finally { await rm(lock, { recursive: true, force: true }); }
}

const withTasks = (home, f) => withLock(home, "tasks", async () => {
  const file = (await readJson(join(home, "tasks.json"))) ?? { tasks: [] };
  const r = f(file);
  if (r.file) await writeJson(join(home, "tasks.json"), r.file);
  return r;
});

// ---- feed: the loop's chat, ~/loops/<id>/feed.jsonl --------------------------------------------

const FEED_TAIL_BYTES = 64 * 1024;

/** Append one entry (from feedEntry) under the feed lock; a torn last line (crash) is closed first so it can't swallow this one. */
async function appendFeed(id, entry) {
  const home = loopHome(homedir(), id), path = join(home, FEED_FILE);
  await withLock(home, "feed", async () => {
    const fh = await open(path, "a+");
    try {
      const { size } = await fh.stat();
      const last = Buffer.alloc(1);
      const torn = size > 0 && (await fh.read(last, 0, 1, size - 1), last[0] !== 10);
      await fh.appendFile((torn ? "\n" : "") + feedLine(entry));
    } finally { await fh.close(); }
  });
}

/** The newest n entries, oldest first, reading only the last 64 KB of the file. A missing file is an empty feed. */
async function readFeedTail(id, n) {
  let fh;
  try { fh = await open(join(loopHome(homedir(), id), FEED_FILE), "r"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - FEED_TAIL_BYTES), buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // the window began mid-line
    return parseFeed(text, { last: n });
  } finally { await fh.close(); }
}

const validLoopId = (id) => /^[A-Za-z0-9][\w-]*$/.test(id ?? ""); // it becomes a folder name

/** Append a finished entry to a local loop's feed. False (never a throw) when the loop has no folder or the write fails:
 *  a feed line must not break the command or watcher that made it, and withLock would wait forever in a missing folder. */
async function postEntry(id, entry) {
  try {
    if (!validLoopId(id) || !(await manifestOf(id))) return false;
    await appendFeed(id, entry);
    return true;
  } catch (e) { console.error(`omniloop: couldn't post to ${id}'s feed: ${e.message}`); return false; }
}
async function postFeed(id, from, text, thread = null) {
  const r = feedEntry({ from, thread, text, now: Date.now() });
  return r.error ? false : postEntry(id, r.entry);
}

// `omniloop feed [--last N] [--loop id]`: the loop's chat as short lines, oldest first.
async function cmdFeed({ flags }) {
  const id = await loopOfMe(flags);
  const n = flags.last === undefined ? 20 : Number(flags.last);
  if (!id || !Number.isInteger(n) || n < 1) die("usage: omniloop feed [--last N] [--loop id]");
  if (!validLoopId(id)) die(`bad loop id: ${id}`);
  const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);
  const rows = (await readFeedTail(id, n)).map((e) => `${hhmm(e.ts)} ${e.from}${e.thread ? ` #${e.thread}` : ""}: ${e.text.replace(/\s+/g, " ")}`);
  console.log(rows.length ? rows.join("\n") : `no messages in ${id} yet`);
}

async function cmdSay({ flags, rest }) {
  const usage = 'usage: omniloop say "<text>" [--thread T] [--loop id]';
  const id = await loopOfMe(flags);
  if (!id || flags.thread === true || !rest.length) die(usage);
  if (!validLoopId(id)) die(`bad loop id: ${id}`);
  if (!(await manifestOf(id))) die(`loop ${id} has no folder (${loopHome(homedir(), id)}); make one with omniloop new`);
  const r = feedEntry({ from: me() ?? YOU, thread: flags.thread, text: rest.join(" "), now: Date.now() });
  if (r.error) die(r.error);
  await appendFeed(id, r.entry);
  console.log(`said in ${id}${r.entry.thread ? ` #${r.entry.thread}` : ""}`);
}

/** Is a watcher running that would flush a held note for this loop? (its state file: pid alive, heartbeat fresh) */
async function watcherLive(loop) {
  for (const f of ["state.json", `state-${loop}.json`]) {
    const s = await readJson(join(HOME, f));
    if (!s?.pid || !(Date.now() - s.heartbeat < WATCHER_FRESH_MS)) continue;
    try { process.kill(s.pid, 0); return true; } catch {}
  }
  return false;
}

// What the pane's Enter runs: post as you, then tell the coordinator the way the watcher does (now if it is waiting, else held).
async function cmdReply({ flags, rest }) {
  const id = await loopOfMe(flags);
  if (!id || flags.thread === true || !rest.length) die('usage: omniloop reply "<text>" --loop L [--thread T]');
  if (!validLoopId(id)) die(`bad loop id: ${id}`);
  if (!(await manifestOf(id))) die(`loop ${id} has no folder (${loopHome(homedir(), id)}); make one with omniloop new`);
  const r = feedEntry({ from: YOU, thread: flags.thread, text: rest.join(" "), now: Date.now() });
  if (r.error) die(r.error);
  await appendFeed(id, r.entry);
  let coordinator = null, status = null;
  try {
    const l = buildLoops(await allTerminals()).loops.find((x) => x.id === id); // this computer's loop: its key is the plain id
    coordinator = l?.coordinator ?? null;
    status = statusOf(l?.agents.find((m) => m.address === coordinator)?.terminal); // not m.status: that turns "no status" (a shell) into idle
  } catch {
    const msg = `${backend.words.down} didn't answer; this reply was not delivered`;
    await postFeed(id, "omniloop", msg);
    die(msg);
  }
  const plan = replyPlan(coordinator, status), text = `you: ${r.entry.text.replace(/\s+/g, " ")}`;
  if (plan.none) {
    await postFeed(id, "omniloop", "no coordinator is running; nobody got this");
    return console.log(`no coordinator is running in ${id}; nobody got this`);
  }
  // Any reply from you counts as interacting with this loop, even when it is held: the watcher records a changed
  // omniloop.you label like a typed prompt. Never lets the reply fail.
  await backend.label(coordinator, [`${LABEL.you}=${Date.now()}`], { timeoutMs: 5000 }).catch(() => {});
  if (plan.send) {
    // Refused (it started working meanwhile) or timed out: hold it like any note.
    const r = await backend.send(coordinator, text, { if: plan.send.if }).catch(() => ({ code: null, output: "" }));
    if (!sendFailed(r.code, r.output)) return console.log(`sent to ${coordinator}`);
  }
  await putTimer({ at: Date.now(), to: coordinator, text, note: true });
  if (await watcherLive(id)) return console.log(`held for ${coordinator} (${status ?? "not an agent"}); the watcher delivers it when it stops`);
  await postFeed(id, "omniloop", `your reply waits for a watcher: none is running (omniloop watch --loop ${id})`);
  console.log(`held for ${coordinator}; no watcher is running, so it waits for one (omniloop watch)`);
}

// "you" is the user; "me" is the terminal running this; anything else is an agent's terminal.
const ownerOf = (w) => (!w || w === true ? null : w === "you" ? YOU : w === "me" ? me() ?? YOU : w);

async function cmdTask({ flags, rest }) {
  const sub = rest[0] && ["ls", "add", "done", "give", "edit", "rm", "reopen", "move"].includes(rest[0]) ? rest.shift() : null;
  const id = await loopOfMe(flags);
  if (!id) die('usage: omniloop task [ls | add "…" [--for you|me|t3] | done N | give N you|t3 | edit N "…" | reopen N | rm N | move N <loop>] [--loop id]');
  const home = loopHome(homedir(), id);
  if (!(await manifestOf(id))) die(`loop ${id} has no folder (${home}); make one with omniloop new`);
  const by = me() ?? YOU, now = Date.now();
  if (!sub || sub === "ls") {
    const file = (await readJson(join(home, "tasks.json"))) ?? { tasks: [] };
    if (!sub) { // just mine (or yours, from a plain shell)
      const lines = taskLines(file, by);
      return console.log(lines.length ? lines.join("\n") : `no open tasks for ${by === YOU ? "you" : by} in ${id} (omniloop task ls for all)`);
    }
    const { yours, agents } = openTasks(file);
    const out = [`${id} tasks`, `  you: ${yours.length ? "" : "none"}`, ...yours.map((t) => `    ${t.n}. ${t.text}${t.by !== YOU ? ` (from ${t.by})` : ""}`)];
    for (const a of agents) out.push(`  ${a.owner}${a.owner === me() ? " (me)" : ""}:`, ...a.tasks.map((t) => `    ${t.n}. ${t.text}${t.by !== a.owner ? ` (from ${t.by})` : ""}`));
    return console.log(out.join("\n"));
  }
  if (["edit", "rm", "reopen", "move"].includes(sub)) return taskChange(sub, id, home, rest, by, now);
  let r;
  if (sub === "add") {
    const owner = ownerOf(flags.for) ?? by; // no --for: the caller's own task (yours, from a plain shell)
    r = await withTasks(home, (f) => addTask(f, { text: rest.join(" "), owner, by, now }));
  } else if (sub === "done") r = await withTasks(home, (f) => finishTask(f, rest[0], { by, now }));
  else r = await withTasks(home, (f) => giveTask(f, rest[0], ownerOf(rest[1])));
  if (r.error) die(r.error);
  const t = r.task;
  console.log(sub === "done" ? `done: ${t.n}. ${t.text}` : `${t.n}. ${t.text} → ${t.for === YOU ? "you" : t.for}`);
  if (sub !== "give") await postFeed(id, by, sub === "done" ? `task ${t.n} done: ${t.text}` : `task ${t.n} added for ${t.for}: ${t.text}`);
  // A task handed to another agent: tell it now if it's waiting (as the watcher does); otherwise it sees it in its list.
  if (sub !== "done" && t.for !== YOU && t.for !== me()) {
    const a = await backend.get(t.for).catch(() => null);
    const st = a && statusOf(a);
    if (st === "idle" || st === "done") await typed(t.for, taskNote(t, id), st === "idle" ? "idle" : null).then(() => console.log(`told ${t.for}`)).catch(() => {});
  }
}

/** task edit / reopen / rm / move: change one task in place, or move it to another loop (same owner and number order there). */
async function taskChange(sub, id, home, rest, by, now) {
  const n = rest[0];
  if (sub === "move") {
    const to = rest[1];
    if (!to || to === id) die("usage: omniloop task move N <loop>");
    const toM = await manifestOf(to);
    if (!toM || toM.id !== to) die(`no loop ${to} here`);
    const peek = tasksOf((await readJson(join(home, "tasks.json"))) ?? {}).find((x) => x.n === Number(n));
    if (!peek) die(`no task ${n}`);
    const toHome = loopHome(homedir(), to);
    const added = await withTasks(toHome, (f) => addTask(f, { text: peek.text, owner: peek.for, by: peek.by, now }));
    if (added.error) die(added.error);
    await withTasks(home, (f) => removeTask(f, n));
    await postFeed(id, by, `task ${n} moved to ${to}: ${peek.text}`);
    await postFeed(to, by, `task ${added.task.n} moved here from ${id}: ${peek.text}`);
    return console.log(`moved: ${id} task ${n} is now ${to} task ${added.task.n}. ${peek.text}`);
  }
  const r = await withTasks(home, (f) => sub === "edit" ? editTask(f, n, rest.slice(1).join(" ")) : sub === "reopen" ? reopenTask(f, n) : removeTask(f, n));
  if (r.error) die(r.error);
  const t = r.task;
  const what = sub === "edit" ? "reworded" : sub === "reopen" ? "reopened" : "deleted";
  console.log(`${what}: ${t.n}. ${t.text}`);
  await postFeed(id, by, `task ${t.n} ${what}: ${t.text}`);
}

async function cmdProject({ flags, rest }) {
  const sub = rest.shift();
  const projects = await loadProjects();
  if (sub === "ls") {
    if (flags.json) return console.log(JSON.stringify(projects.map(({ name, description, triggers, dir }) => ({ name, description, triggers, dir }))));
    if (!projects.length) return console.log(`no projects (looked in ${PROJECT_DIRS.join(", ")})`);
    for (const p of projects) console.log(`${p.name}\t${p.description ?? ""}\t${p.dir}`);
    return;
  }
  if (sub === "match") {
    const m = matchProjects(projects, rest.join(" "));
    if (flags.json) return console.log(JSON.stringify(m.map((x) => ({ ...x, description: projects.find((p) => p.name === x.name)?.description ?? "" }))));
    return console.log(m.length ? m.map((x) => `${x.name} (${x.hits.join(", ")})`).join("\n") : "no project matches");
  }
  if (sub === "add" || sub === "rm") {
    const name = rest[0];
    let id = typeof flags.loop === "string" ? flags.loop : null;
    if (!id && me()) id = (await backend.get(me()).catch(() => null))?.labels?.[LABEL.loop] ?? null;
    if (!name || !id) die(`usage: omniloop project ${sub} <project> [--loop id]`);
    if (sub === "add" && !projects.some((p) => p.name === name)) die(`no project named ${name} (omniloop project ls)`);
    const home = loopHome(homedir(), id);
    const m = await manifestOf(id);
    if (!m) die(`loop ${id} has no folder (${home}); make one with omniloop new`);
    const next = sub === "add" ? addProject(m, name) : removeProject(m, name);
    if (next === m) return console.log(sub === "add" ? `${id} already has the ${name} project` : `${id} has no ${name} project`);
    await writeJson(join(home, "loop.json"), next);
    await writeClaudeMd(home, next);
    return console.log(sub === "add" ? `added the ${name} project to ${id}: agents started from now get its skills and tools; running ones see its notes in CLAUDE.md.`
      : `removed the ${name} project from ${id}: agents started from now don't get it; running ones keep what they loaded.`);
  }
  die("usage: omniloop project ls [--json] | project match <text> [--json] | project add|rm <project> [--loop id]");
}

const BRIEF = `omniloop: you are in a loop (a piece of work with one coordinator). Commands (short output):
  omniloop ls [loop]                      the loop as a tree; * = coordinator
  omniloop start <loop> --job J -- claude "<task>"   start a subagent that reports to you; prints its id
  omniloop timer 20m "<what to check>"    get a note later; don't sleep or poll
  omniloop needs-you [off]                this block is the user's (credentials, spending, anything public)
  omniloop goal [set "…" | add "…" | edit N "…" | done N]   the user's end goal for this loop (always one); your work serves it
    a goal is one plain sentence the user would say: what is true when it's done (30 words or fewer). No file paths,
    job or phase numbers, or plans; those go in tasks. Like: "Use omni instead of Herdr for daily work on the Mac."
  omniloop task [ls | add "…" --for you|me|t3 | done N | give N t3 | edit N "…" | reopen N | rm N | move N <loop>]
  omniloop say "…" [--thread T]           post to the loop's chat feed (the user reads it there)
  omniloop add-dir <path> | rm-dir <path> add or remove a context folder of the loop (CLAUDE.md lists them)
  omniloop bootstrap [<loop>|--all] [--dry-run]  refresh the loop's CLAUDE.md blocks and harness config (.claude/settings.json; AGENTS.md link)
  omniloop shared                         other loops in this loop's folders, and their coordinators (tell them before a change)
  omniloop project ls | project add|rm <project>   reusable context (skills, tools, notes) for a kind of work
  omniloop rename [<old>] <new>           rename (move) a loop: folder, worktrees, branches, space, labels
  omniloop rm [<loop>] [--force]          delete a loop and close its space (refuses unmerged work); ask the user first
  omniloop new --temp [--goal "…"]        a temporary loop: no memory, deleted on rm or once its last agent exits
  omniloop handoff <file>                 at ~60% context: write <file>, run this, then stop
  omniloop send <t> "<text>"              message a subagent or your coordinator (arrives labelled as you, not as the user)
  omniloop sessions                       Claude sessions you can send to (address, name, pid)
  ${backend.words.read.padEnd(40)}see a subagent's screen
Cheap helpers (spend Gemini $, not Claude quota; Agent tool): sdd:gemini-judge ranks/filters/checks a batch, sdd:video-digest
turns a video into a digest, sdd:spend-watch reports spend and limits (run it before a big fan-out).
Rules: end your turn when you wait; the watcher types a one-line note into you when a subagent blocks,
finishes or stalls ("omniloop: t3 blocked (question): ..."). Never poll, sleep or loop on ${backend.words.wait}.
Only the coordinator (and needs-you) reaches the user; answer your subagents' questions yourself.
Don't ask what you can decide: when one option is recommended or obvious, take it and say which. Ask the user
only for what is theirs (credentials, spending, anything public, a real choice between goals).`;

// ---- rename, remove, temporary loops (core/lifecycle.js has the rules) ---------------------------

/** A renamed loop leaves its old name as a link to the new folder. Drop that link, so the name can be used again. */
async function dropAlias(id) {
  const p = loopHome(homedir(), id);
  const st = await lstat(p).catch(() => null);
  if (!st?.isSymbolicLink() || (await manifestOf(id))?.id === id) return;
  await rm(p, { force: true });
  // and its Claude project link, or the new loop's sessions would be saved with the renamed one's
  const ck = join(homedir(), ".claude", "projects", claudeProjectKey(p));
  if ((await lstat(ck).catch(() => null))?.isSymbolicLink()) await rm(ck, { force: true });
}

/** The names in ~/loops that link to this loop's folder (left by renames). */
async function aliasesOf(home) {
  const root = join(homedir(), LOOPS_DIR), out = [];
  for (const n of await readdir(root).catch(() => [])) {
    const p = join(root, n);
    if ((await lstat(p).catch(() => null))?.isSymbolicLink() && (await realpath(p).catch(() => null)) === home) out.push(p);
  }
  return out;
}

/** This computer's terminals in a loop (null when herdr-core doesn't answer). */
async function agentsOf(id) {
  try { return (await allTerminals()).filter((t) => !t.address.includes("/") && t.labels?.[LABEL.loop] === id); } catch { return null; }
}

// omniloop rm-dir <path>: take a context folder out of the loop. Its worktree (if the loop has one) is removed like rm does.
async function cmdRmDir({ flags, rest }) {
  const path = rest[0] && resolvePath(rest[0]);
  const id = await loopOfMe(flags);
  if (!path || !id) die("usage: omniloop rm-dir <path> [--loop id] [--force]");
  const home = loopHome(homedir(), id);
  const m = await manifestOf(id);
  if (!m) die(`loop ${id} has no folder (${home})`);
  const next = removeDir(m, path);
  if (next === m) return console.log(`${path} isn't in ${id}`);
  for (const d of m.dirs) if (d.path === path && d.worktree && !d.machine && (await exists(d.worktree))) {
    const r = await worktreeFacts(d);
    const chk = removeCheck([r], { force: Boolean(flags.force) });
    if (!chk.ok) die(`not removed: ${chk.problems.join("; ")}. Land that work first, or rerun with --force (uncommitted files are lost; the branch is kept).`);
    for (const l of await dropWorktree(r, Boolean(flags.force))) console.log(l);
  }
  await writeJson(join(home, "loop.json"), next);
  await writeClaudeMd(home, next);
  await bootstrapHarnesses(home, next);
  await postFeed(id, me() ?? YOU, `context folder removed: ${path}`);
  console.log(`removed ${path} from ${id}: agents started from now don't get it.`);
}

/** A worktree's state: uncommitted files, and commits on its branch not in the repo's checked-out branch. */
async function worktreeFacts(d) {
  let dirty = 0, ahead = 0;
  const here = await exists(d.worktree);
  if (here) dirty = (await git(d.worktree, ["status", "--porcelain"]).catch(() => "")).split("\n").filter(Boolean).length;
  try {
    const main = await git(d.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    ahead = Number(await git(d.path, ["rev-list", "--count", `${main}..${d.branch}`])) || 0;
  } catch {}
  return { ...d, dirty, ahead, here };
}

/** Remove a loop's worktree, and its branch when merged (an unmerged branch is always kept). Returns output lines. */
async function dropWorktree(w, force) {
  const out = [];
  if (w.here) {
    try { await git(w.path, ["worktree", "remove", ...(force ? ["--force"] : []), w.worktree]); out.push(`  removed worktree ${w.worktree}`); }
    catch (e) { out.push(`  worktree ${w.worktree} not removed: ${String(e.stderr || e.message).trim().split("\n")[0]}`); return out; }
  }
  try { await git(w.path, ["branch", "-d", w.branch]); out.push(`  deleted branch ${w.branch} (merged)`); }
  catch { out.push(`  kept branch ${w.branch} in ${w.path} (not merged)`); }
  return out;
}

/**
 * omniloop rename [<old>] <new>: rename (move) a loop. The folder moves to ~/loops/<new> and the old name stays as a
 * link to it, so agents already running there keep working. Worktrees follow (git worktree repair) and their branch
 * becomes <new>/work; agents are relabelled, the space renamed, the Claude project folder moved (and linked).
 */
async function cmdRename({ flags, rest }) {
  const [a, b] = rest;
  const from = b ? a : await loopOfMe(flags), to = b ?? a;
  if (!validId(from) || !validId(to)) die("usage: omniloop rename [<old>] <new>   (a-z 0-9 - _; in a loop, <old> defaults to it)");
  if (from === to) return console.log(`${from} is already called that`);
  const m = await manifestOf(from);
  if (!m || m.id !== from) die(`no loop ${from} here`);
  await dropAlias(to);
  const fromHome = loopHome(homedir(), from), toHome = loopHome(homedir(), to);
  if (await lstat(toHome).catch(() => null)) die(`${toHome} already exists`);
  const agents = await agentsOf(from);
  const sp = await backend.groupOf(from);
  const now = Date.now();
  let next = renamedManifest(m, { from, to, fromHome, toHome, now });
  if (flags["dry-run"]) return console.log(JSON.stringify({ move: [fromHome, toHome], relabel: agents?.map((t) => t.address) ?? `${backend.name} down`, space: sp ?? null, dirs: next.dirs }, null, 1));

  await rename(fromHome, toHome);
  await symlink(toHome, fromHome);
  const lines = [];
  // Worktrees moved with the folder: repoint git at them, then rename their branch.
  next = { ...next, dirs: await Promise.all(next.dirs.map(async (d, i) => {
    const old = m.dirs[i];
    if (!d.worktree || d.machine || d.worktree === old.worktree) return d;
    try { await git(d.path, ["worktree", "repair", d.worktree]); } catch {}
    try { await git(d.worktree, ["rev-parse", "--git-dir"]); } catch (e) { lines.push(`  ${d.worktree}: git doesn't see this worktree yet; run git -C ${d.path} worktree repair ${d.worktree}`); }
    if (d.branch === old.branch) return d;
    try { await git(d.path, ["branch", "-m", old.branch, d.branch]); lines.push(`  ${d.path}: worktree ${d.worktree}, branch ${d.branch}`); return d; }
    catch (e) { lines.push(`  ${d.path}: branch stays ${old.branch} (${String(e.stderr || e.message).trim().split("\n")[0]})`); return { ...d, branch: old.branch }; }
  })) };
  await writeJson(join(toHome, "loop.json"), next);
  await writeClaudeMd(toHome, next, (md) => {
    md = renameText(md, from, to);
    return next.temp ? md : withFormerlyNote(md, from, new Date(now).toISOString().slice(0, 10));
  });
  await bootstrapHarnesses(toHome, next);
  // Claude Code saves sessions by folder: move them along, and link the old one for sessions still running.
  const projects = join(homedir(), ".claude", "projects");
  const ck = join(projects, claudeProjectKey(fromHome)), nk = join(projects, claudeProjectKey(toHome));
  if ((await lstat(ck).catch(() => null))?.isDirectory() && !(await exists(nk))) { await rename(ck, nk); await symlink(nk, ck); }
  await rename(join(HOME, `state-${from}.json`), join(HOME, `state-${to}.json`)).catch(() => {});
  if (agents) for (const t of agents) await backend.label(t.address, [`${LABEL.loop}=${to}`]).catch(() => lines.push(`  couldn't relabel ${t.address}: omniloop join ${to} --terminal ${t.address}`));
  else lines.push(`  ${backend.name === "herdr" ? "herdr-core" : backend.words.down} didn't answer: agents keep the old name; omniloop join <new> --terminal <t> for each`);
  if (sp) await backend.renameGroup(sp, { from, to, terms: (agents ?? []).map((t) => t.address) }).catch((e) => lines.push(`  space ${sp} keeps the old name${backend.name === "omni" ? ` (${String(e.stderr || e.message).trim().split("\n")[0]}; the user can move panes with omni join)` : ""}`));
  await postFeed(to, me() ?? YOU, `loop renamed: ${from} → ${to}`);
  console.log(`renamed ${from} to ${to}: ${toHome}${agents?.length ? `; ${agents.length} agent(s) relabelled` : ""}${sp ? "; space renamed" : ""}. ${fromHome} links to it for agents already running.`);
  for (const l of lines) console.log(l);
}

/**
 * omniloop rm [<loop>] [--force] [--purge]: delete a loop. Refuses when a worktree has uncommitted files or unmerged
 * commits (--force: drop the files, keep the branch), or when it has running agents and you're not one of them
 * (--force: stop them). Deletes the loop folder and its worktrees, never its context folders. Closes its space last,
 * from a detached process, so it works from inside the loop. --purge (always on for a temporary loop) also deletes
 * its Claude transcripts, scratchpads, prompt-history lines and omniloop's own records of its terminals.
 */
async function cmdRm({ flags, rest }) {
  const id = rest[0] ?? (await loopOfMe(flags));
  if (!validId(id)) die("usage: omniloop rm [<loop>] [--force] [--purge] [--dry-run]");
  const m = await manifestOf(id);
  if (!m || m.id !== id) die(`no loop ${id} here`);
  const root = await realpath(join(homedir(), LOOPS_DIR));
  const home = await realpath(loopHome(homedir(), id));
  if (dirname(home) !== root) die(`refusing: ${home} isn't a folder in ${root}`);
  const force = Boolean(flags.force), purge = Boolean(flags.purge) || Boolean(m.temp);
  const wts = [];
  for (const d of m.dirs ?? []) if (d.worktree && !d.machine) wts.push(await worktreeFacts(d));
  const chk = removeCheck(wts, { force });
  if (!chk.ok) die(`${id} not removed: ${chk.problems.join("; ")}. Land or drop that work first, or rerun with --force (uncommitted files are lost; an unmerged branch is kept).`);
  const agents = await agentsOf(id);
  if (agents === null && !force) die(`${backend.words.down} didn't answer, so the loop's running agents can't be found; rerun with --force to delete anyway`);
  const live = (agents ?? []).filter((t) => t.state === "live");
  const inside = me() && live.some((t) => t.address === me());
  if (live.length && !inside && !force) die(`${id} has ${live.length} running agent(s) (${live.map((t) => t.address).join(", ")}): rerun with --force to stop them, or run it from inside the loop`);
  const sp = await backend.groupOf(id);
  const aliases = await aliasesOf(home);
  const job = { id, home, root, space: sp ?? null, terms: (agents ?? []).map((t) => t.address), purge, aliases, formerly: await formerHomes(m, home) };
  if (flags["dry-run"]) return console.log(JSON.stringify({ worktrees: wts.map((w) => w.worktree), ...job }, null, 1));

  const lines = [];
  for (const w of wts) lines.push(...(await dropWorktree(w, force)));
  // Timers for its agents would only fire into nothing.
  for (const f of await readdir(TIMERS).catch(() => [])) {
    const t = await readJson(join(TIMERS, f));
    if (t && job.terms.includes(t.to)) await rm(join(TIMERS, f), { force: true });
  }
  await rm(join(HOME, `state-${id}.json`), { force: true });
  console.log(`${m.temp ? "temporary " : ""}loop ${id} deleted${purge ? ", with its transcripts and history" : ""}${sp ? "; its space closes now" : ""}.`);
  for (const l of lines) console.log(l);
  // The rest (stopping agents, closing the space, deleting the folder and transcripts) runs detached: when this runs
  // inside the loop, closing the space ends this very process.
  await mkdir(join(HOME, "reap"), { recursive: true, mode: 0o700 });
  const jobFile = join(HOME, "reap", `${id}-${process.pid}-${Date.now().toString(36)}.json`);
  await writeFile(jobFile, JSON.stringify(job), { mode: 0o600 });
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "_reap", jobFile], { cwd: tmpdir(), detached: true, stdio: "ignore" });
  p.unref();
}

/** A loop's former folders that no other loop has taken since (their names are free, or still link to this loop). */
async function formerHomes(m, home) {
  const out = [];
  for (const f of m.formerly ?? []) {
    if (!validId(f.id)) continue;
    const p = loopHome(homedir(), f.id);
    const st = await lstat(p).catch(() => null);
    if (!st || (st.isSymbolicLink() && (await realpath(p).catch(() => null)) === home)) out.push(p);
  }
  return out;
}

/** The detached second half of rm. Stops the loop's terminals, then deletes; checks the folder again before any rm. */
async function cmdReap({ rest }) {
  // The job comes in a private file rm wrote (0600, in OMNILOOP_HOME); root and home are worked out again here.
  const file = rest[0];
  if (!file || dirname(file) !== join(HOME, "reap") || !(await lstat(file).catch(() => null))?.isFile()) return;
  const job = await readJson(file);
  await rm(file, { force: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!job || !validId(job.id)) return;
  const root = await realpath(join(homedir(), LOOPS_DIR)).catch(() => null);
  if (!root || job.home !== join(root, job.id) || job.root !== root) return;
  const under = (p) => typeof p === "string" && dirname(p) === root;
  job.aliases = (job.aliases ?? []).filter(under);
  job.formerly = (job.formerly ?? []).filter(under);
  job.terms = (job.terms ?? []).filter((t) => /^[\w-]+$/.test(t));
  await wait(800); // let rm's caller finish printing
  for (const t of job.terms) await backend.kill(t);
  if (job.space) await backend.closeGroup(job.space);
  for (let i = 0; i < 40; i++) {
    const states = await Promise.all(job.terms.map((t) => backend.get(t).then((g) => g.state).catch(() => null)));
    if (!states.includes("live")) break;
    await wait(500);
  }
  await wait(1000); // a stopping Claude session writes its transcript last
  for (const t of job.terms) await backend.remove(t);
  if (job.space) await backend.retireGroup(job.space);
  for (const a of job.aliases) if ((await lstat(a).catch(() => null))?.isSymbolicLink()) await rm(a, { force: true });
  if ((await realpath(job.home).catch(() => null)) === job.home) await rm(job.home, { recursive: true, force: true });
  if (job.purge) await purgeTraces(job);
}

/** Delete what Claude Code and omniloop kept about a loop's sessions. */
async function purgeTraces(job) {
  const claude = join(homedir(), ".claude"), projects = join(claude, "projects");
  const folders = [job.home, ...job.aliases, ...job.formerly];
  const keys = folders.map(claudeProjectKey);
  const sessions = [];
  for (const n of await readdir(projects).catch(() => [])) {
    if (!keys.some((k) => isLoopClaudeEntry(n, k))) continue;
    const dir = join(projects, n);
    // A former name's own folder (not a link) belongs to whatever loop took that name since: leave it.
    if (keys.slice(1).includes(n) && !(await lstat(dir).catch(() => null))?.isSymbolicLink()) continue;
    for (const f of await readdir(dir).catch(() => [])) if (f.endsWith(".jsonl")) sessions.push(f.slice(0, -6));
    await rm(dir, { recursive: true, force: true });
  }
  const tmpRoot = `/private/tmp/claude-${process.getuid()}`;
  for (const k of keys) await rm(join(tmpRoot, k), { recursive: true, force: true });
  for (const sid of sessions) {
    if (!/^[0-9a-f-]{36}$/.test(sid)) continue;
    for (const p of [join(claude, "file-history", sid), join(claude, "session-env", sid), join(claude, "tasks", sid), join(claude, "debug", `${sid}.txt`), join(HOME, "goal-seen", sid)])
      await rm(p, { recursive: true, force: true });
    for (const f of await readdir(join(claude, "todos")).catch(() => [])) if (f.startsWith(sid)) await rm(join(claude, "todos", f), { force: true });
  }
  for (const t of job.terms) if (/^[\w-]+$/.test(t)) for (const d of ["sessions", "turns"]) await rm(join(HOME, d, `${t}.json`), { force: true });
  // Prompt history: drop the lines typed in this loop. Rewritten in one rename; a line another session appends in
  // that instant could be lost, so it's done once, last.
  const hist = join(claude, "history.jsonl");
  const text = await readFile(hist, "utf8").catch(() => null);
  if (text != null) {
    const r = scrubHistory(text, folders);
    if (r.dropped) { await writeFile(hist + ".omniloop-tmp", r.text); await rename(hist + ".omniloop-tmp", hist); }
  }
}

// ---- watch ----------------------------------------------------------------------------------

async function loadTimers() {
  await mkdir(TIMERS, { recursive: true });
  const out = [];
  for (const f of await readdir(TIMERS)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(await readFile(join(TIMERS, f), "utf8"))); } catch {}
  }
  return out;
}

async function cmdWatch({ flags }) {
  const loop = typeof flags.loop === "string" ? flags.loop : null;
  const quiet = Boolean(flags["dry-run"]);
  await mkdir(HOME, { recursive: true });
  // A dry run keeps its own state file: it never delivers, so it must not look like (or take over from) the real watcher.
  const stateFile = join(HOME, `${quiet ? "dry" : "state"}${loop ? `-${loop}` : ""}.json`);
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  // One watcher per state file, or every note is typed twice.
  let withYou = {};
  try {
    const prev = JSON.parse(await readFile(stateFile, "utf8"));
    withYou = prev.withYou ?? {};
    let alive = false;
    try { process.kill(prev.pid, 0); alive = true; } catch {}
    if (alive && prev.pid !== process.pid && Date.now() - prev.heartbeat < WATCHER_FRESH_MS)
      die(`a watcher is already running (pid ${prev.pid}${prev.terminal ? `, terminal ${prev.terminal}` : ""})`);
  } catch {}

  const terms = new Map();
  let newConsoles = {}; // address -> when it was created, until adopted or given up (core/watch.js adoptions)
  let state = null, ready = false, timer = null, sent = 0, chars = 0;
  const sentAt = {};
  const MONTH = 30 * 86400_000;

  const persist = async (you) => {
    for (const [a, at] of Object.entries(withYou)) if (Date.now() - at > MONTH) delete withYou[a];
    const body = { pid: process.pid, terminal: me(), loop, heartbeat: Date.now(), you, timers: state.timers, pending: state.pending, sent, chars, withYou };
    await writeFile(stateFile + ".tmp", JSON.stringify(body)).then(() => rename(stateFile + ".tmp", stateFile)).catch(() => {});
  };

  const tick = async () => {
    if (!ready) return;
    // Timers added by `omniloop timer` since the last tick.
    const files = await loadTimers();
    const known = new Set(state.timers.map((t) => t.id));
    for (const f of files) if (!known.has(f.id)) state.timers.push(f);
    // Each agent's last turn (its Stop hook's record): finished-turn notes carry the reply, and skip what it already said.
    const turns = {};
    await Promise.all([...terms.keys()].map(async (a) => { const t = await turnRecord(a); if (t) turns[a] = t; }));
    // A console made in a loop's space joins that loop (core/watch.js adoptions). Not in a dry run or a one-loop watcher.
    if (!quiet && !loop && Object.keys(newConsoles).length) {
      const candidates = newConsoles;
      const a = adoptions(candidates, [...terms.values()], Date.now());
      newConsoles = a.keep;
      for (const { address, loop: l, to, job } of a.adopt) {
        const seenAt = candidates[address];
        const kv = [`${LABEL.loop}=${l}`, ...(to ? [`${LABEL.reportsTo}=${to}`] : []), ...(job ? [`omniloop.job=${job}`] : []), `${ADOPTED}=1`];
        await backend.label(address, kv)
          .then(() => log("ADOPT", address, `joined ${l}${to ? `, reports to ${to}` : ""}`))
          .catch((e) => { newConsoles[address] = seenAt; log("ADOPT", address, `failed, will retry: ${String(e.message ?? e).slice(0, 100)}`); }); // back in, with its original time: retried until the 60 s give-up
      }
    }
    const r = step(state, [...terms.values()], Date.now(), { loop, turns });
    // Timers that fired are gone from state: remove their files.
    const left = new Set(r.state.timers.map((t) => t.id));
    // (A dry run only looks: it must not eat a timer file the real watcher still has to deliver.)
    if (!quiet) for (const f of files) if (!left.has(f.id)) await rm(join(TIMERS, `${f.id}.json`), { force: true });
    state = r.state;
    for (const { loop: l, entry } of r.feed) {
      if (quiet) log("FEED", l, entry.text);
      else await postEntry(l, entry);
    }
    for (const a of r.actions) {
      if (a.type === "you") { log("YOU", a.text); continue; }
      sent++; chars += a.text.length;
      log("SEND", a.to, a.text);
      sentAt[a.to] = Date.now();
      if (quiet) continue;
      // A Claude session with a messaging socket gets the note as a message from "omniloop" (not typed as you);
      // anything else (no socket, a bypass session, another program) gets it typed by the backend (hc send, omni send), as before.
      const hcSend = async (to, text) => {
        const r = await backend.send(to, text, { if: a.if });
        if (!sendFailed(r.code, r.output)) { if (r.code !== 0) log("SENT", to, `(${backend.name} send exit ${r.code}, but it was typed: ${r.output.trim().slice(0, 100)})`); return; }
        throw new Error(`${backend.name} send exit ${r.code}`);
      };
      deliver(a.to, { from: "omniloop", text: a.text.replace(/^omniloop: /, ""), replyTo: null, hcSend: (to) => hcSend(to, withoutReplies(a.text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")) })
        .then((d) => { if (d.via === "socket") log("SOCKET", a.to, `(${d.to})`); })
        .catch((e) => {
          // Refused (it started working or blocked meanwhile), timed out, or unreachable: hold the note for the next stop.
          log("REQUEUE", a.to, `(${String(e.message ?? e).slice(0, 100)})`);
          hold(state.pending, a.to, a.text.replace(/^omniloop: /, ""));
        });
    }
    await persist(r.you);
    if (!quiet && Date.now() - lastSweep > SWEEP_MS) { lastSweep = Date.now(); await sweepTemp().catch((e) => log("SWEEP", `failed: ${e.message}`)); }
  };

  // Temporary loops end by themselves once their last agent is gone (core/lifecycle.js endedTempLoops). The terminal
  // list comes from hc's own event stream, so a sweep never runs on a failed hc call.
  const SWEEP_MS = 60_000, seenTemp = new Set(), triedTemp = new Set();
  let lastSweep = 0;
  const sweepTemp = async () => {
    const temps = (await allManifests()).filter((m) => m.temp && (!loop || m.id === loop));
    if (!temps.length) return;
    const live = new Set([...terms.values()].filter((t) => t.state !== "finished" && !t.address.includes("/")).map((t) => t.labels?.[LABEL.loop]).filter(Boolean));
    for (const id of endedTempLoops(temps, live, seenTemp, Date.now())) {
      if (triedTemp.has(id)) continue;
      triedTemp.add(id);
      try { const { stdout } = await run(process.execPath, [fileURLToPath(import.meta.url), "rm", id, "--auto"], { timeout: 60_000 }); log("TEMP", stdout.trim()); }
      catch (e) { log("TEMP", `${id} kept: ${String(e.stderr || e.message).trim().split("\n")[0]}`); }
    }
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(tick, 300); };

  const onLine = (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    if (msg.terminals) {
      terms.clear();
      for (const t of msg.terminals) terms.set(t.address, { ...t, event_ms: now });
      if (!ready) {
        loadTimers().then((timers) => {
          state = initState([...terms.values()], now, { loop, timers });
          ready = true;
          log(`watching ${loop ? `loop ${loop}` : "all loops"}: ${terms.size} terminals${quiet ? " (dry run)" : ""}`);
          tick();
        });
      }
      return;
    }
    const p = msg.params;
    if (!p?.terminal) return;
    const cur = terms.get(p.terminal);
    if (p.type === "created") { terms.set(p.terminal, { ...p.data, event_ms: now }); if (ready) { newConsoles[p.terminal] = now; setTimeout(soon, ADOPT_AFTER_MS + 100); } }
    else if (p.type === "removed") terms.delete(p.terminal);
    else if (cur) {
      const d = p.data ?? {};
      const before = { ...cur, labels: { ...cur.labels } };
      if (p.type === "finished") Object.assign(cur, d, { state: "finished" });
      else if (p.type === "turn") Object.assign(cur, { turn: d.turn });
      else Object.assign(cur, d);
      cur.event_ms = now;
      // When you last interacted with a loop agent (shown and ranked by the view).
      if (cur.labels?.[LABEL.loop] && (p.type === "status" || p.type === "labels")) {
        if (touchedByYou(before, cur)) {
          withYou[p.terminal] = now;
          soon();
        }
      }
    }
    soon();
  };
  // The backend's event stream. The first line of every connection lists all terminals, so a reconnect (omni: the daemon
  // drops a reader that falls behind) rebuilds the picture; herdr's stream ending ends the watcher, as before.
  let ev = null, stopping = false;
  const connect = () => {
    ev = backend.events({ label: loop ? `${LABEL.loop}=${loop}` : null });
    ev.on("exit", (code) => {
      log(`${backend.name === "herdr" ? "hc" : backend.name} events ended (${code})`);
      if (backend.eventsReconnect && !stopping) return void setTimeout(connect, 1000);
      process.exit(1);
    });
    createInterface({ input: ev.stdout }).on("line", onLine);
  };
  connect();
  setInterval(tick, TICK_MS);
  const stop = () => { stopping = true; ev.kill(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}

// ---- the picker's search data and name proposals ---------------------------------------------

const INDEX_FEED = 30, INDEX_TEXT = 200;
const clip = (t) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, INDEX_TEXT);

/** Every loop folder on this computer, as what the ⌘O picker searches: id, goal, folders, projects, open tasks, the
 *  chat's last 30 lines (each clipped) and when it last changed. Only this computer's: nothing here goes elsewhere. */
async function cmdIndex() {
  const out = [];
  for (const m of await allManifests()) {
    if (!validId(m.id)) continue;
    const home = loopHome(homedir(), m.id);
    const tf = (await readJson(join(home, "tasks.json"))) ?? {};
    const { yours, agents } = openTasks(tf);
    const tasks = [...yours, ...agents.flatMap((a) => a.tasks)].map((t) => clip(t.text));
    const feed = (await readFeedTail(m.id, INDEX_FEED).catch(() => [])).map((e) => clip(e.text));
    const mt = async (f) => (await stat(join(home, f)).catch(() => null))?.mtimeMs ?? 0;
    const touched = Math.max(await mt("loop.json"), await mt("tasks.json"), await mt(FEED_FILE));
    out.push({ id: m.id, goal: openGoals(m)[0]?.text ?? m.goal ?? "", dirs: (m.dirs ?? []).map((d) => d.path), projects: m.projects ?? [], tasks, feed, touched });
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

/** What names this computer and its person, read here and only used here (core/intake.js identityTerms). */
async function localIdentity() {
  const acct = (await readJson(join(homedir(), ".claude.json")))?.oauthAccount ?? {};
  let machines = [];
  try { machines = await backend.machines(); } catch {}
  let user = null; try { user = userInfo().username; } catch {}
  return identityTerms({ names: [acct.displayName, acct.fullName, acct.organizationName], emails: [acct.emailAddress], user, host: hostname(), home: homedir(), machines });
}

/** omniloop propose "<request>" [--taken a,b]: a model's { id, goal, source } for a new loop, as JSON. The model sees
 *  only the request, run from an empty folder; on any failure the answer is slugify + the request (source "typed"). */
async function cmdPropose({ flags, rest }) {
  const request = rest.join(" ").trim();
  if (!request) die('usage: omniloop propose "<what you want to do>" [--taken id,id]');
  const taken = typeof flags.taken === "string" ? flags.taken.split(",").map((x) => x.trim()).filter(Boolean) : [];
  let answer = fallbackProposal(request, taken);
  const cwd = await mkdtemp(join(tmpdir(), "omniloop-name-"));
  try {
    const { stdout } = await run(SHELL, ["-lc", 'exec claude "$@"', "omniloop", ...proposeArgs(request)], { cwd, timeout: 30_000, maxBuffer: 1 << 20 });
    answer = checkProposal(JSON.parse(stdout), request, taken, { identity: await localIdentity() });
  } catch (e) {
    console.error(`omniloop: no model proposal (${String(e.message ?? e).split("\n")[0].slice(0, 120)}); using the request as typed`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
  process.stdout.write(JSON.stringify(answer) + "\n");
}

// ---- main -----------------------------------------------------------------------------------

const [cmd, ...argvRaw] = process.argv.slice(2);
const argv = argvRaw;
const parsed = parseArgs(argv);

// ---- messages between sessions -------------------------------------------------------------

// An agent's message to another session: it arrives as "Message from @<you>", not as if the user typed it.
// Works without herdr: <to> is an hc address, a Claude session name (omniloop sessions), a pid or a session id.
async function cmdSend({ flags, rest }) {
  const [to, ...words] = rest;
  if (!to || !words.length) die('usage: omniloop send <to> "<text>"   (<to>: address, session name, pid; see omniloop sessions)');
  let from = me();
  if (!from && process.env.CLAUDE_CODE_MESSAGING_SOCKET) from = (await liveSessions()).find((x) => x.messagingSocketPath === process.env.CLAUDE_CODE_MESSAGING_SOCKET)?.name ?? null;
  try {
    // Never typed (see deliver's typed option): your words arrive labelled as yours, or not at all.
    const d = await deliver(to, { from: from ?? "agent", text: words.join(" "), typed: false });
    console.log(`sent to ${d.to} (${d.via === "socket" ? "message" : "typed"})`);
  } catch (e) { die(`not sent: ${e.message ?? e}`); }
}

// Claude sessions on this computer that omniloop can send to.
async function cmdSessions() {
  const [ss, hooks] = await Promise.all([liveSessions(), hookRecords()]);
  const addrOf = new Map(Object.values(hooks).map((h) => [h.pid, h.address]));
  // Sessions without a hook record: herdr's terminals know their foreground pid.
  try {
    const ts = (await allTerminals()).filter((t) => t.agent === "claude-code" && !t.address.includes("/"));
    await Promise.all(ts.map(async (t) => { const p = await foregroundPid(t.address); if (p != null && !addrOf.has(p)) addrOf.set(p, t.address); }));
  } catch {}
  const rows = ss.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((x) => `${addrOf.get(x.pid) ?? "-"}\t${x.name ?? "-"}\t${x.pid}\t${x.status ?? "?"}\t${x.messagingSocketPath ? "socket" : "no socket"}\t${x.cwd ?? ""}`);
  console.log(rows.length ? ["address\tname\tpid\tstatus\tvia\tcwd", ...rows].join("\n") : "no Claude sessions running");
}

const table = {
  send: cmdSend, sessions: cmdSessions,
  rename: cmdRename, bootstrap: cmdBootstrap, rm: cmdRm, "rm-dir": cmdRmDir, _reap: cmdReap,
  ls: cmdLs, new: cmdNew, goal: cmdGoal, task: cmdTask, say: cmdSay, feed: cmdFeed, reply: cmdReply, "add-dir": cmdAddDir, project: cmdProject, start: cmdStart, join: cmdJoin, leave: cmdLeave, "needs-you": cmdNeedsYou, shared: cmdShared,
  timer: cmdTimer, handoff: cmdHandoff, watch: cmdWatch, index: cmdIndex, propose: cmdPropose, revive: cmdRevive, brief: async () => console.log(BRIEF),
};
if (!table[cmd]) {
  console.log("omniloop new [--temp] | bootstrap | rename | rm | rm-dir | revive | propose | index | goal | task | say | feed | reply | add-dir | shared | project | ls | start | join | leave | needs-you | timer | handoff | watch [--loop id] [--dry-run] | brief");
  process.exit(cmd ? 1 : 0);
}
await table[cmd](parsed).catch((e) => die(e.stderr?.toString().trim() || e.message));
