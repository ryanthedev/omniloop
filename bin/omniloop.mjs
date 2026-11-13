#!/usr/bin/env node
// omniloop: run work as loops of agents in herdr-core terminals. Needs only `hc` (herdr-core) and node.
// Output is short on purpose: agents read it, and every line costs them tokens.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, rm, rename, open, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL, buildLoops, statusOf } from "../core/omniloop.js";
import { initState, step, parseDuration, touchedByYou, sendFailed, hold } from "../core/watch.js";
import { validId, loopHome, newManifest, addDir, dirsOn, claudeMd, updateClaudeMd, memberArgv, parseAliasWords, sharedWith, LOOPS_DIR } from "../core/loopdir.js";
import { matchProjects, addProject, projectLaunch, withProjectsBlock } from "../core/projects.js";
import { goalsOf, openGoals, setGoal, addGoal, finishGoal, withGoalBlock, goalNote } from "../core/goals.js";
import { feedEntry, feedLine, parseFeed, replyPlan, FEED_FILE } from "../core/feed.js";
import { proposeArgs, checkProposal, fallbackProposal, identityTerms } from "../core/intake.js";
import { userInfo, hostname } from "node:os";
import { YOU, addTask, finishTask, giveTask, openTasks, taskLines, taskNote, tasksOf } from "../core/tasks.js";

const run = promisify(execFile);
const HOME = process.env.OMNILOOP_HOME ?? join(homedir(), ".cache", "omniloop");
const TIMERS = join(HOME, "timers");
const TICK_MS = 15_000;
// hc send waits up to 60 s for a person's draft before typing; allow well past that.
const SEND_TIMEOUT_MS = 180_000;
const WATCHER_FRESH_MS = 45_000;

// Start programs through the user's login shell, so they get the PATH and tools of a normal terminal.
const viaLogin = (argv) => [process.env.SHELL || "/bin/sh", "-lc", 'exec "$@"', "omniloop", ...argv];

async function hc(args, { json = true } = {}) {
  // --json goes before any "--", or it becomes an argument of the program being started.
  const cut = args.indexOf("--");
  const full = !json ? args : cut < 0 ? [...args, "--json"] : [...args.slice(0, cut), "--json", ...args.slice(cut)];
  const { stdout } = await run("hc", full, { maxBuffer: 64 << 20 });
  return json ? JSON.parse(stdout) : stdout;
}
const me = () => process.env.HC_TERMINAL_ID || null;
const SHELL = process.env.SHELL || "/bin/sh";
// This folder holds the `omniloop` command; members get it on their PATH.
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

/** The loop's context folders plus its projects' repos and plugin folders, for a member on this computer. */
// omniloop's own plugin (its goal hook) goes to every member started in a loop with a folder.
const PLUGIN = join(BIN, "..", "plugin");

async function launchOf(manifest) {
  if (!manifest) return { dirs: [], pluginDirs: [] };
  const { pluginDirs, dirs, missing } = projectLaunch(manifest, await loadProjects());
  if (missing.length) console.error(`omniloop: loop ${manifest.id} lists missing project(s): ${missing.join(", ")}`);
  const all = dirsOn(manifest);
  for (const d of dirs) if (!all.includes(d)) all.push(d);
  return { dirs: all, pluginDirs: [PLUGIN, ...pluginDirs] };
}

/** CLAUDE.md for a loop, with its projects' CONTEXT.md in the projects block. */
async function writeClaudeMd(home, manifest, existing = null) {
  const projects = await loadProjects();
  const contexts = [];
  for (const name of manifest.projects ?? []) {
    const p = projects.find((x) => x.name === name);
    const text = p && (await readFile(join(p.dir, "CONTEXT.md"), "utf8").catch(() => null));
    if (text) contexts.push({ name, text });
  }
  const base = existing ? updateClaudeMd(existing, manifest) : claudeMd(manifest);
  await writeFile(join(home, "CLAUDE.md"), withGoalBlock(withProjectsBlock(base, contexts), manifest));
}

/** The Herdr space named after the loop (on this computer), or null. */
async function loopSpace(id) {
  try {
    const { stdout } = await run("herdr-app", ["ls"], { maxBuffer: 16 << 20 });
    return JSON.parse(stdout).spaces.find((sp) => sp.name === id && !sp.machine) ?? null;
  } catch { return null; }
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
const BOOL = new Set(["json", "dry-run", "lead", "no-lead"]);
function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); flags["--"] = true; break; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (BOOL.has(k) || v === undefined || v.startsWith("--")) flags[k] = true; else { flags[k] = v; i++; }
    } else rest.push(a);
  }
  return { flags, rest };
}

async function allTerminals() {
  // hc ls --json leaves labels out; hc get has them.
  const { terminals } = await hc(["ls"]);
  return Promise.all(terminals.map((t) => hc(["get", t.address]).catch(() => null))).then((x) => x.filter(Boolean));
}

// ---- commands -------------------------------------------------------------------------------

async function cmdLs({ rest }) {
  const built = buildLoops(await allTerminals());
  const loops = built.loops.filter((l) => !rest[0] || l.id === rest[0]);
  if (!loops.length) return console.log(rest[0] ? `no loop ${rest[0]}` : "no loops");
  for (const l of loops) {
    console.log(`${l.id}${l.goal ? ` — ${l.goal}` : ""} (lead: ${l.lead ?? "you"})${l.warnings.length ? ` ! ${l.warnings.join("; ")}` : ""}`);
    const by = new Map(l.members.map((m) => [m.address, m]));
    const show = (a, depth) => {
      const m = by.get(a);
      const st = m.status + (m.kind ? `/${m.kind}` : "");
      const name = m.terminal.labels["omniloop.job"] ?? m.terminal.title ?? "";
      console.log(`${"  ".repeat(depth + 1)}${a}${m.isLead ? "*" : ""} ${st}${name ? ` ${String(name).slice(0, 50)}` : ""}${m.needsYou ? " [needs you]" : ""}`);
      for (const c of m.children) show(c, depth + 1);
    };
    for (const r of l.roots) show(r, 0);
  }
}

async function cmdStart({ flags, rest }) {
  const loop = rest.shift();
  if (!loop || !flags["--"] || !rest.length) die("usage: omniloop start <loop> [--lead] [--to T] [--job J] [--goal G] [--cwd D] -- <program...>");
  const to = flags.to ?? (flags.lead ? null : me());
  const labels = { [LABEL.loop]: loop };
  if (flags.lead) labels[LABEL.lead] = "1";
  if (to) labels[LABEL.reportsTo] = to;
  if (flags.goal) labels[LABEL.goal] = flags.goal;
  if (flags.job) labels["omniloop.job"] = flags.job;
  // Show it as a tab in the starter's space, when there is one.
  if (me()) {
    const space = (await hc(["get", me()]).catch(() => null))?.labels?.["herdr.space"];
    if (space && !flags.space) labels["herdr.space"] = space;
  }
  if (flags.space) labels["herdr.space"] = flags.space;
  const args = ["run", "--bg", "--no-parent", "--no-notify", ...(flags.cwd ? ["--cwd", flags.cwd] : [])];
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  const manifest = await manifestOf(loop);
  let argv;
  if (/(^|\/)claude$/.test(rest[0])) {
    // A Claude helper: the user's own claude flags, the loop's context folders, and a task that starts with the brief.
    const { flags, task } = splitTask(rest);
    argv = memberArgv({ shell: SHELL, claudeArgv: [...(await claudeLaunch()), ...flags], ...(await launchOf(manifest)), binDir: BIN,
      task: task ? `First run \`omniloop brief\`. ${task}` : null });
  } else argv = viaLogin(rest);
  if (manifest) {
    // Start in the loop folder (the members' shared Claude project), in the loop's own space when it has one.
    if (!flags.cwd) args.push("--cwd", loopHome(homedir(), loop));
    const sp = !flags.space && (await loopSpace(loop));
    if (sp) { const i = args.indexOf(`herdr.space=${labels["herdr.space"]}`); if (i >= 0) args[i] = `herdr.space=${sp.id}`; else args.push("--label", `herdr.space=${sp.id}`); }
  }
  if (flags["dry-run"]) return console.log(JSON.stringify({ hc: [...args, "--", ...argv] }, null, 1));
  const r = await hc([...args, "--", ...argv]);
  console.log(r.address);
}

async function cmdJoin({ flags, rest }) {
  const loop = rest[0];
  const t = flags.terminal ?? me();
  if (!loop || !t) die("usage: omniloop join <loop> [--lead] [--to T] [--goal G] [--job J] [--terminal T]");
  const kv = [`${LABEL.loop}=${loop}`];
  if (flags.lead) kv.push(`${LABEL.lead}=1`);
  if (flags.to) kv.push(`${LABEL.reportsTo}=${flags.to}`);
  if (flags.goal) kv.push(`${LABEL.goal}=${flags.goal}`);
  if (flags.job) kv.push(`omniloop.job=${flags.job}`);
  await hc(["label", t, ...kv], { json: false });
  console.log(`${t} in ${loop}`);
}

async function cmdLeave({ flags }) {
  const t = flags.terminal ?? me();
  await hc(["label", t, ...[LABEL.loop, LABEL.lead, LABEL.reportsTo, LABEL.goal, LABEL.notify, LABEL.needs, "omniloop.job"].map((k) => `${k}=`)], { json: false });
  console.log(`${t} left its loop`);
}

async function cmdNeedsYou({ flags, rest }) {
  const t = flags.terminal ?? me();
  const off = rest[0] === "off";
  await hc(["label", t, `${LABEL.needs}=${off ? "" : "you"}`], { json: false });
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
  const t = await hc(["get", old]);
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
  // otherwise reuse the old command line and folder. The task goes right after the program (see memberArgv).
  const manifest = await manifestOf(t.labels[LABEL.loop]);
  const args = ["run", "--bg", "--no-parent", "--no-notify", "--cwd", manifest ? loopHome(homedir(), manifest.id) : t.cwd];
  for (const [k, v] of labels) args.push("--label", `${k}=${v}`);
  const base = manifest ? await claudeLaunch() : keep;
  const r = await hc([...args, "--", ...memberArgv({ shell: SHELL, claudeArgv: base, ...(await launchOf(manifest)), binDir: BIN,
    task: `First run \`omniloop brief\`. Then read ${file} and continue where it leaves off.` })]);
  await hc(["label", old, `${LABEL.retired}=${r.address}`, `${LABEL.lead}=`], { json: false });
  // Re-point the old one's reports.
  const kids = (await allTerminals()).filter((x) => x.labels?.[LABEL.reportsTo] === old);
  for (const k of kids) await hc(["label", k.address, `${LABEL.reportsTo}=${r.address}`], { json: false });
  // And its open tasks.
  let moved = 0;
  if (manifest) await withTasks(loopHome(homedir(), manifest.id), (f) => {
    let file = f;
    for (const x of tasksOf(f)) if (!x.done && x.for === old) { file = giveTask(file, x.n, r.address).file; moved++; }
    return { file };
  });
  console.log(`${r.address} continues as ${old}; ${kids.length} report(s) and ${moved} task(s) moved. You can stop now.`);
}

async function cmdNew({ flags, rest }) {
  const id = rest[0];
  if (!validId(id)) die("usage: omniloop new <id> [--goal G] [--dir D]... [--project P]... [--task T] [--no-lead]   (id: a-z 0-9 - _)");
  const home = loopHome(homedir(), id);
  if (await manifestOf(id)) die(`loop ${id} already exists: ${home}`);
  const dirs = [];
  for (let i = 0; i < argvRaw.length; i++) if (argvRaw[i] === "--dir" && argvRaw[i + 1]) dirs.push(resolvePath(argvRaw[++i]));
  if (typeof flags.goal !== "string" || !flags.goal.trim()) die("every loop needs a goal: omniloop new <id> --goal \"what this loop is for\"");
  let manifest = newManifest({ id, goal: flags.goal.replace(/\s+/g, " ").trim(), dirs, now: Date.now() });
  const known = await loadProjects();
  // Several projects: --project a --project b, or --project a,b.
  for (let i = 0; i < argvRaw.length; i++) if (argvRaw[i] === "--project" && argvRaw[i + 1]) {
    for (const name of argvRaw[++i].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!known.some((p) => p.name === name)) die(`no project named ${name} (omniloop project ls)`);
      manifest = addProject(manifest, name);
    }
  }
  const dry = Boolean(flags["dry-run"]);
  if (!dry) {
    await mkdir(home, { recursive: true });
    await writeJson(join(home, "loop.json"), manifest);
    await writeClaudeMd(home, manifest);
  }
  const np = manifest.projects?.length ?? 0;
  console.log(`loop ${id}: ${home} (${dirs.length} context folder${dirs.length === 1 ? "" : "s"}${np ? `; project${np === 1 ? "" : "s"} ${manifest.projects.join(", ")}` : ""})${dry ? " [dry run: nothing written]" : ""}`);
  if (flags["no-lead"]) return;

  // A space named after the loop, started in its folder, with the lead as its first tab.
  // A project with "autostart" (study) makes the goal a whole job ("study <link>"): start on it. Otherwise ask first.
  const autostart = manifest.goal && known.some((p) => p.autostart && manifest.projects?.includes(p.name));
  const task = typeof flags.task === "string" ? flags.task : autostart
    ? `You lead the loop ${id}. Read CLAUDE.md, run \`omniloop brief\`, then do the goal with your project's skill: ${manifest.goal}`
    : `You lead the loop ${id}. Read CLAUDE.md, run \`omniloop brief\`, then ask the user what to do first.`;
  const argv = memberArgv({ shell: SHELL, claudeArgv: await claudeLaunch(), ...(await launchOf(manifest)), task, binDir: BIN });
  if (flags["dry-run"]) return console.log(JSON.stringify({ "space.new": { name: id, folder: home, argv } }, null, 1));
  await run("herdr-app", ["do", "space.new", JSON.stringify({ name: id, folder: home, argv })]);
  // Find the lead's terminal (the new space's first) and label it.
  let lead = null;
  for (let i = 0; i < 40 && !lead; i++) {
    const sp = await loopSpace(id);
    lead = sp?.tabs?.[0]?.terminals?.[0]?.terminal ?? null;
    if (!lead) await new Promise((r) => setTimeout(r, 250));
  }
  if (!lead) die(`space ${id} was made, but its lead didn't appear; label it yourself: omniloop join ${id} --lead --terminal <t>`);
  const kv = [`${LABEL.loop}=${id}`, `${LABEL.lead}=1`, "omniloop.job=lead"];
  if (manifest.goal) kv.push(`${LABEL.goal}=${manifest.goal}`);
  await hc(["label", lead, ...kv], { json: false });
  console.log(`lead ${lead} in space ${id}`);
}

function resolvePath(p) {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p.startsWith("/") ? p : join(process.cwd(), p);
}

async function cmdAddDir({ flags, rest }) {
  const path = rest[0] && resolvePath(rest[0]);
  let id = typeof flags.loop === "string" ? flags.loop : null;
  if (!id && me()) id = (await hc(["get", me()]).catch(() => null))?.labels?.[LABEL.loop] ?? null;
  if (!path || !id) die("usage: omniloop add-dir <path> [--loop id] [--on machine]");
  const home = loopHome(homedir(), id);
  const m = await manifestOf(id);
  if (!m) die(`loop ${id} has no folder (${home}); make one with omniloop new`);
  const on = typeof flags.on === "string" ? flags.on : null;
  const next = addDir(m, path, on);
  if (next === m) return console.log(`${path} is already in ${id}`);
  await writeJson(join(home, "loop.json"), next);
  await writeClaudeMd(home, next, await readFile(join(home, "CLAUDE.md"), "utf8").catch(() => null));
  console.log(`added ${path}${on ? ` (on ${on})` : ""} to ${id}: members started from now get it. Running ones see it in CLAUDE.md; reading it may ask for approval until they hand off.`);
}

async function allManifests() {
  const root = join(homedir(), LOOPS_DIR);
  const names = await readdir(root).catch(() => []);
  return (await Promise.all(names.map((n) => manifestOf(n)))).filter((m) => m?.id);
}

async function cmdShared({ flags }) {
  const id = await loopOfMe(flags);
  if (!id) die("usage: omniloop shared [--loop id]");
  const shared = sharedWith(await allManifests(), id);
  if (!shared.length) return console.log(`no other loop works in ${id}'s folders`);
  // Each other loop's live lead on this computer, to tell before a change.
  const leads = new Map();
  for (const t of await allTerminals().catch(() => []))
    if (t.state === "live" && t.labels?.[LABEL.lead] && !t.labels?.[LABEL.retired] && t.labels?.[LABEL.loop]) leads.set(t.labels[LABEL.loop], t.address);
  for (const s of shared) {
    console.log(s.path);
    for (const l of s.loops) console.log(`  ${l.id}${l.path !== s.path ? ` (${l.path})` : ""}: ${leads.has(l.id) ? `lead ${leads.get(l.id)}` : "no lead running (add a task with omniloop task add --loop, or tell the user)"}`);
  }
}

async function loopOfMe(flags) {
  if (typeof flags.loop === "string") return flags.loop;
  return me() ? (await hc(["get", me()]).catch(() => null))?.labels?.[LABEL.loop] ?? null : null;
}

async function cmdGoal({ flags, rest }) {
  const sub = rest[0] && ["set", "add", "done"].includes(rest[0]) ? rest.shift() : null;
  const id = await loopOfMe(flags);
  if (!id) die("usage: omniloop goal [set \"…\" | add \"…\" | done <n>] [--loop id]");
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
  const r = sub === "set" ? setGoal(m, rest.join(" "), now) : sub === "add" ? addGoal(m, rest.join(" "), now) : finishGoal(m, rest[0], now);
  if (r.error) die(r.error);
  if (r.manifest === m) return console.log(`${id}: no change`);
  const next = r.manifest;
  await writeJson(join(home, "loop.json"), next);
  await writeClaudeMd(home, next, await readFile(join(home, "CLAUDE.md"), "utf8").catch(() => null));
  // The feed line comes before anything that needs herdr-core, so it lands even when hc is down.
  const gone = sub === "done" ? goalsOf(m).find((g) => String(g.n) === String(rest[0]))?.text : null;
  await postFeed(id, me() ?? YOU, sub === "set" ? `goal set: ${openGoals(next)[0]?.text ?? ""}` : sub === "add" ? `goal added: ${rest.join(" ")}` : `goal ${rest[0]} done${gone ? `: ${gone}` : ""}`);
  // Members: the label carries the current goal (the tabs and status bar read it). Agents started with omniloop's
  // plugin hear about the change from its hook on their next prompt; others get the note typed in, if idle.
  let members = [];
  try { members = (await allTerminals()).filter((t) => !t.address.includes("/") && t.labels?.[LABEL.loop] === id && !t.labels?.[LABEL.retired]); }
  catch { console.error("omniloop: saved, but herdr-core (hc) didn't answer, so no member was told or relabelled"); }
  const note = goalNote(next, id);
  const told = [], later = [];
  await Promise.all(members.map(async (t) => {
    if (next.goal !== m.goal) await hc(["label", t.address, `${LABEL.goal}=${next.goal}`], { json: false }).catch(() => {});
    if (t.address === me()) return;
    if ((t.foreground?.argv ?? []).includes(PLUGIN)) return told.push(`${t.address} (hook)`);
    const st = statusOf(t);
    if (st === "idle" || st === "done") {
      // Only agents that are waiting, as the watcher does: never typed into a plain shell or a working agent.
      try { await hc(["send", ...(st === "idle" ? ["--if", "idle"] : []), t.address, note], { json: false }); told.push(t.address); } catch { later.push(t.address); }
    } else if (st) later.push(t.address);
  }));
  console.log(note);
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

// What the pane's Enter runs: post as you, then tell the lead the way the watcher does (now if it is waiting, else held).
async function cmdReply({ flags, rest }) {
  const id = await loopOfMe(flags);
  if (!id || flags.thread === true || !rest.length) die('usage: omniloop reply "<text>" --loop L [--thread T]');
  if (!validLoopId(id)) die(`bad loop id: ${id}`);
  if (!(await manifestOf(id))) die(`loop ${id} has no folder (${loopHome(homedir(), id)}); make one with omniloop new`);
  const r = feedEntry({ from: YOU, thread: flags.thread, text: rest.join(" "), now: Date.now() });
  if (r.error) die(r.error);
  await appendFeed(id, r.entry);
  let lead = null, status = null;
  try {
    const l = buildLoops(await allTerminals()).loops.find((x) => x.id === id); // this computer's loop: its key is the plain id
    lead = l?.lead ?? null;
    status = statusOf(l?.members.find((m) => m.address === lead)?.terminal); // not m.status: that turns "no status" (a shell) into idle
  } catch {
    const msg = "herdr-core (hc) didn't answer; this reply was not delivered";
    await postFeed(id, "omniloop", msg);
    die(msg);
  }
  const plan = replyPlan(lead, status), text = `you: ${r.entry.text.replace(/\s+/g, " ")}`;
  if (plan.none) {
    await postFeed(id, "omniloop", "no lead is running; nobody got this");
    return console.log(`no lead is running in ${id}; nobody got this`);
  }
  if (plan.send) {
    try {
      await run("hc", ["send", ...(plan.send.if ? ["--if", plan.send.if] : []), lead, text], { timeout: SEND_TIMEOUT_MS });
      return console.log(`sent to ${lead}`);
    } catch (e) {
      if (!sendFailed(e.code, `${e.stdout ?? ""}${e.stderr ?? ""}`)) return console.log(`sent to ${lead}`);
      // refused (it started working meanwhile) or timed out: hold it like any note
    }
  }
  await putTimer({ at: Date.now(), to: lead, text, note: true });
  if (await watcherLive(id)) return console.log(`held for ${lead} (${status ?? "not an agent"}); the watcher delivers it when it stops`);
  await postFeed(id, "omniloop", `your reply waits for a watcher: none is running (omniloop watch --loop ${id})`);
  console.log(`held for ${lead}; no watcher is running, so it waits for one (omniloop watch)`);
}

// "you" is the user; "me" is the terminal running this; anything else is an agent's terminal.
const ownerOf = (w) => (!w || w === true ? null : w === "you" ? YOU : w === "me" ? me() ?? YOU : w);

async function cmdTask({ flags, rest }) {
  const sub = rest[0] && ["ls", "add", "done", "give"].includes(rest[0]) ? rest.shift() : null;
  const id = await loopOfMe(flags);
  if (!id) die('usage: omniloop task [ls | add "…" [--for you|me|t3] | done N | give N you|t3] [--loop id]');
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
    const a = await hc(["get", t.for]).catch(() => null);
    const st = a && statusOf(a);
    if (st === "idle" || st === "done") await hc(["send", ...(st === "idle" ? ["--if", "idle"] : []), t.for, taskNote(t, id)], { json: false }).then(() => console.log(`told ${t.for}`)).catch(() => {});
  }
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
  if (sub === "add") {
    const name = rest[0];
    let id = typeof flags.loop === "string" ? flags.loop : null;
    if (!id && me()) id = (await hc(["get", me()]).catch(() => null))?.labels?.[LABEL.loop] ?? null;
    if (!name || !id) die("usage: omniloop project add <project> [--loop id]");
    if (!projects.some((p) => p.name === name)) die(`no project named ${name} (omniloop project ls)`);
    const home = loopHome(homedir(), id);
    const m = await manifestOf(id);
    if (!m) die(`loop ${id} has no folder (${home}); make one with omniloop new`);
    const next = addProject(m, name);
    if (next === m) return console.log(`${id} already has the ${name} project`);
    await writeJson(join(home, "loop.json"), next);
    await writeClaudeMd(home, next, await readFile(join(home, "CLAUDE.md"), "utf8").catch(() => null));
    return console.log(`added the ${name} project to ${id}: members started from now get its skills and tools; running ones see its notes in CLAUDE.md.`);
  }
  die("usage: omniloop project ls [--json] | project match <text> [--json] | project add <project> [--loop id]");
}

const BRIEF = `omniloop: you are in a loop (a piece of work with one lead). Commands (short output):
  omniloop ls [loop]                      the loop as a tree; * = lead
  omniloop start <loop> --job J -- claude "<task>"   start a helper that reports to you; prints its id
  omniloop timer 20m "<what to check>"    get a note later; don't sleep or poll
  omniloop needs-you [off]                this block is the user's (credentials, spending, anything public)
  omniloop goal [set "…" | add "…" | done N]   the user's end goal for this loop (always one); your work serves it
  omniloop task [ls | add "…" --for you|me|t3 | done N | give N t3]   tasks: yours, other agents', the user's
  omniloop say "…" [--thread T]           post to the loop's chat feed (the user reads it there)
  omniloop add-dir <path>                 add a context folder to the loop (CLAUDE.md lists them)
  omniloop shared                         other loops in this loop's folders, and their leads (tell them before a change)
  omniloop project ls | project add <project>      reusable context (skills, tools, notes) for a kind of work
  omniloop handoff <file>                 at ~60% context: write <file>, run this, then stop
  hc send <t> "<text>"                    answer a helper; hc read <t> to see its screen
Rules: end your turn when you wait; the watcher types a one-line note into you when a helper blocks,
finishes or stalls ("omniloop: t3 blocked (question): ..."). Never poll, sleep or loop on hc wait.
Only the lead (and needs-you) reaches the user; answer your helpers' questions yourself.`;

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
    const r = step(state, [...terms.values()], Date.now(), { loop });
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
      const p = spawn("hc", ["send", ...(a.if ? ["--if", a.if] : []), a.to, a.text], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      const kill = setTimeout(() => p.kill(), SEND_TIMEOUT_MS);
      // Refused (it started working or blocked meanwhile) or timed out: hold the note for the next stop.
      p.on("exit", (code) => {
        clearTimeout(kill);
        if (!sendFailed(code, out)) { if (code !== 0) log("SENT", a.to, `(hc send exit ${code}, but it was typed: ${out.trim().slice(0, 100)})`); return; }
        log("REQUEUE", a.to, `(hc send exit ${code})`);
        hold(state.pending, a.to, a.text.replace(/^omniloop: /, ""));
      });
    }
    await persist(r.you);
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(tick, 300); };

  const args = ["events", "--json", ...(loop ? ["--label", `${LABEL.loop}=${loop}`] : [])];
  const ev = spawn("hc", args, { stdio: ["ignore", "pipe", "inherit"] });
  ev.on("exit", (code) => { log(`hc events ended (${code})`); process.exit(1); });
  const rl = createInterface({ input: ev.stdout });
  rl.on("line", (raw) => {
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
    if (p.type === "created") terms.set(p.terminal, { ...p.data, event_ms: now });
    else if (p.type === "removed") terms.delete(p.terminal);
    else if (cur) {
      const d = p.data ?? {};
      const before = { ...cur, labels: { ...cur.labels } };
      if (p.type === "finished") Object.assign(cur, d, { state: "finished" });
      else if (p.type === "turn") Object.assign(cur, { turn: d.turn });
      else Object.assign(cur, d);
      cur.event_ms = now;
      // When you last interacted with a loop member (shown and ranked by the view).
      if (cur.labels?.[LABEL.loop] && (p.type === "status" || p.type === "labels")) {
        const m = buildLoops([...terms.values()]).loops.flatMap((l) => l.members).find((x) => x.address === p.terminal);
        if (touchedByYou(before, cur, { reportsToYou: Boolean(m?.reportsToYou), sentAt: sentAt[p.terminal] ?? null, now })) {
          withYou[p.terminal] = now;
          soon();
        }
      }
    }
    soon();
  });
  setInterval(tick, TICK_MS);
  const stop = () => { ev.kill(); process.exit(0); };
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
  try { machines = (JSON.parse((await run("hc", ["machine", "ls", "--json"], { timeout: 10_000 })).stdout).machines ?? []).map((m) => m.name); } catch {}
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
const table = {
  ls: cmdLs, new: cmdNew, goal: cmdGoal, task: cmdTask, say: cmdSay, feed: cmdFeed, reply: cmdReply, "add-dir": cmdAddDir, project: cmdProject, start: cmdStart, join: cmdJoin, leave: cmdLeave, "needs-you": cmdNeedsYou, shared: cmdShared,
  timer: cmdTimer, handoff: cmdHandoff, watch: cmdWatch, index: cmdIndex, propose: cmdPropose, brief: async () => console.log(BRIEF),
};
if (!table[cmd]) {
  console.log("omniloop new | propose | index | goal | task | say | feed | reply | add-dir | shared | project | ls | start | join | leave | needs-you | timer | handoff | watch [--loop id] [--dry-run] | brief");
  process.exit(cmd ? 1 : 0);
}
await table[cmd](parsed).catch((e) => die(e.stderr?.toString().trim() || e.message));
