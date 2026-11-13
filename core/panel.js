// panel.js: the docked Omniloop panel, as plain data. Pure.
//
// Two views, switched with 1 / 2 or Tab:
//   loop  the current loop: its goal(s), your todo (your tasks; x or space finishes one), the agents' tasks, its members, its context
//         (folders and projects). "Current" is the loop you picked in the list, else the loop of the last
//         terminal you were in, else the top of the list.
//   all   every loop: the ones on disk (~/loops/<id>/loop.json, via bin/panel-loops.mjs) joined with the live ones
//         (terminals carrying an omniloop label, from buildView). Type / to filter.
//
// `rowsFor` builds what a view shows; `step` turns one key into the next state and, maybe, an action for the mod
// to run (jump to a terminal, finish a task, leave). The mod only draws rows and runs actions.

import { matchScore } from "./picker.js";
import { loopKey } from "./omniloop.js";

export const VIEWS = ["loop", "all"];
export const initialState = () => ({ view: "loop", sel: { loop: 0, all: 0 }, pinned: null, query: "", filtering: false, open: {}, adding: null });

/**
 * What instruction files a folder or project has, from panel-loops.mjs. Three states, because "none" must
 * never stand in for "couldn't look": { state: "has" | "none" | "unchecked", text, files: [{ label, path }] }.
 */
export function instructions(info, where = null) {
  if (!info || !info.checked) return { state: "unchecked", text: where ? `not checked (on ${where})` : "not checked", files: [] };
  if (info.missing) return { state: "unchecked", text: "not found on this machine", files: [] };
  const files = [], parts = [];
  const add = (label, path) => { files.push({ label, path }); };
  if (info.context) { parts.push("CONTEXT.md"); add("CONTEXT.md", info.context); }
  if (info.claude) { parts.push("CLAUDE.md"); add("CLAUDE.md", info.claude); }
  if (info.agents) { parts.push("AGENTS.md"); add("AGENTS.md", info.agents); }
  const sk = info.skills ?? [], ag = info.agentDefs ?? [];
  if (sk.length) parts.push(`${sk.length} skill${sk.length === 1 ? "" : "s"}`);
  for (const k of sk) add(`skill: ${k.name}`, k.path);
  if (ag.length) parts.push(`${ag.length} agent${ag.length === 1 ? "" : "s"}`);
  for (const a of ag) add(`agent: ${a.name}`, a.path);
  return files.length ? { state: "has", text: parts.join(" · "), files } : { state: "none", text: "no instructions", files: [] };
}

/**
 * A folder path as the panel shows it: its own name first (that's what you look for), then where it sits, with
 * any home folder shortened to ~ (on another machine too, where our home() doesn't apply).
 * "/Users/x/repos/claude" → { name: "claude", where: "~/repos" }.
 */
export function placeOf(path) {
  const p = String(path ?? "").replace(/\/+$/, "");
  const short = p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^\/root(?=\/|$)/, "~");
  const i = short.lastIndexOf("/");
  if (i < 0) return { name: short || "/", where: "" };
  return { name: short.slice(i + 1) || "/", where: short.slice(0, i) || "/" };
}

/**
 * Every loop, best first. disk: [{ id, goals, dirs, projects, tasks: { yours, agents }, touched }] (panel-loops.mjs);
 * live: buildView(...).loops. A live loop with no folder here (another machine's) still shows.
 */
export function allLoops(disk = [], live = []) {
  const byId = new Map();
  for (const d of disk) byId.set(d.id, { id: d.id, disk: d, live: null });
  for (const l of live) {
    const x = byId.get(l.id) ?? { id: l.id, disk: null, live: null };
    x.live = l; byId.set(l.id, x);
  }
  const out = [...byId.values()].map(({ id, disk: d, live: l }) => ({
    id,
    goal: d?.goals?.[0]?.text ?? l?.goal ?? "",
    lead: l?.lead ?? null,
    members: l?.rows?.length ?? 0,
    needsYou: l?.needsYou ?? 0,
    yours: d?.tasks?.yours?.length ?? 0,
    agentTasks: (d?.tasks?.agents ?? []).reduce((n, a) => n + a.tasks.length, 0),
    lastWithYou: l?.lastWithYou ?? null,
    ago: l?.ago ?? null,
    touched: d?.touched ?? 0,
    live: Boolean(l),
    local: Boolean(d),
  }));
  // Needs you first, then the ones you were in most recently, then the most recently changed on disk.
  out.sort((a, b) => b.needsYou - a.needsYou || (b.lastWithYou ?? -1) - (a.lastWithYou ?? -1) || b.live - a.live
    || b.touched - a.touched || a.id.localeCompare(b.id));
  return out;
}

/** Another machine's panel-loops output, keyed like live loops there ("m1/x"), so the two join. */
export function onMachine(list, machine) {
  if (!machine) return list ?? [];
  return (list ?? []).map((d) => ({ ...d, id: `${machine}/${d.id}`, machine }));
}

/** The loop key ("x" here, "m1/x" on another machine) of the terminal at `address`, or null. */
export function loopOfTerminal(terminals, address) {
  return loopKey((terminals ?? []).find((x) => x.address === address)) ?? null;
}

/** Where a loop key lives: { machine (null = here), id (the loop's own id there) }. */
export function splitLoop(key) {
  const i = String(key ?? "").indexOf("/");
  return i < 0 ? { machine: null, id: key } : { machine: key.slice(0, i), id: key.slice(i + 1) };
}

/** The loop the "loop" view shows. */
export function currentLoop(state, loops, focusedLoop) {
  const has = (id) => id && loops.some((l) => l.id === id);
  if (has(state.pinned)) return state.pinned;
  if (has(focusedLoop)) return focusedLoop;
  return loops[0]?.id ?? null;
}

/**
 * Rows for one loop. Each row: { kind, text, ... , pick? } where pick marks rows the cursor can stop on.
 * Kinds: head (section title), goal, todo (yours: Enter finishes), task (an agent's), member (Enter jumps),
 * dir, project, empty.
 */
export function loopRows(id, disk, live, open = {}) {
  if (!id) return [{ kind: "empty", text: "No loops yet. ⌘O starts one." }];
  const rows = [];
  const head = (text) => rows.push({ kind: "head", text });
  const goals = disk?.goals?.length ? disk.goals : live?.goal ? [{ n: 1, text: live.goal }] : [];
  head(goals.length > 1 ? `GOALS (${goals.length})` : "GOAL");
  if (!goals.length) rows.push({ kind: "empty", text: "No goal set: omniloop goal set \"…\"" });
  goals.forEach((g, i) => rows.push({ kind: "goal", text: g.text, n: g.n, current: i === 0 }));

  const yours = disk?.tasks?.yours ?? [];
  head(`YOUR TODO${yours.length ? ` (${yours.length})` : ""}`);
  if (!yours.length) rows.push({ kind: "empty", text: "Nothing for you." });
  for (const t of yours) rows.push({ kind: "todo", text: t.text, n: t.n, by: t.by, loop: id, pick: true });

  const agents = disk?.tasks?.agents ?? [];
  if (agents.length) {
    head("AGENTS' TASKS");
    for (const a of agents) for (const t of a.tasks) rows.push({ kind: "task", owner: a.owner, text: t.text, n: t.n, pick: true, terminal: a.owner });
  }

  const members = live?.rows ?? [];
  head(`MEMBERS${members.length ? ` (${members.length})` : ""}`);
  if (!members.length) rows.push({ kind: "empty", text: "No live terminals in this loop." });
  for (const m of members) rows.push({ kind: "member", text: m.name, address: m.address, depth: m.depth, status: m.status,
    isLead: m.isLead, forYou: m.forYou, ago: m.ago, terminal: m.address, pick: true });

  const dirs = disk?.dirs ?? [], projects = disk?.projects ?? [];
  rows.push({ kind: "head", text: "CONTEXT", hint: disk ? "a folder · p project" : "" });
  if (!dirs.length && !projects.length) rows.push({ kind: "empty", text: disk ? "No folders or projects." : "Its folder couldn't be read (machine offline?)." });
  // Each folder and project says what instructions it carries; Enter unfolds the files (Enter on a file opens it).
  const local = !disk?.machine;
  const withFiles = (row, ins) => {
    rows.push({ ...row, ins, pick: true, key: `${row.kind}:${row.text}` });
    if (!open[`${row.kind}:${row.text}`]) return;
    if (!ins.files.length) rows.push({ kind: "file", text: ins.state === "none" ? "nothing to show" : ins.text, depth: 1, path: null });
    for (const f of ins.files) rows.push({ kind: "file", text: f.label, path: f.path, local, depth: 1, pick: true });
  };
  for (const d of dirs) {
    const machine = d.machine ?? disk?.machine ?? null;
    // A folder kept on another machine than the loop's can't be looked at from where the loop lives.
    withFiles({ kind: "dir", text: d.path, ...placeOf(d.path), machine }, instructions(d.machine ? null : d.files, d.machine ?? null));
  }
  for (const p of projects) {
    const name = typeof p === "string" ? p : p.name;
    const ins = instructions(typeof p === "string" ? null : p.files);
    withFiles({ kind: "project", text: name, name, where: (typeof p === "string" ? "" : p.description ?? "") || "project", description: typeof p === "string" ? "" : p.description ?? "" }, ins);
  }
  if (disk?.notes) withFiles({ kind: "notes", text: "this loop's own CLAUDE.md", name: "Loop notes", where: "this loop's own folder" }, instructions(disk.notes));
  return rows;
}

/**
 * The add chooser's rows. adding: { kind: "project" | "dir", loop, q }; cands: [{ value, text, note? }];
 * have: values the loop already has. A folder can also be typed as a path (starting / or ~).
 */
export function chooserRows(adding, cands = [], have = []) {
  const q = (adding?.q ?? "").trim();
  const hit = cands.filter((c) => !q || matchScore(q, `${c.text} ${c.note ?? ""}`) > 0 || c.value.includes(q));
  const rows = hit.map((c) => ({ kind: "choice", text: c.text, value: c.value, note: c.note ?? "", have: have.includes(c.value), pick: !have.includes(c.value) }));
  if (adding?.kind === "dir" && /^[~/]/.test(q) && !cands.some((c) => c.value === q)) rows.unshift({ kind: "choice", text: q, value: q, note: "the path you typed", have: false, pick: true });
  if (!rows.some((r) => r.pick)) rows.push({ kind: "empty", text: q ? `Nothing matches "${q}".` : "Nothing to add." });
  return rows;
}

/** Rows for the "all" view: one per loop, filtered by the query. */
export function allRows(loops, query = "") {
  const q = query.trim();
  const hit = q ? loops.filter((l) => matchScore(q, `${l.id} ${l.goal}`) > 0) : loops;
  if (!hit.length) return [{ kind: "empty", text: q ? `No loop matches "${q}".` : "No loops yet. ⌘O starts one." }];
  return hit.map((l) => ({ kind: "loop", text: l.id, loop: l, pick: true }));
}

const picks = (rows) => rows.map((r, i) => (r.pick ? i : -1)).filter((i) => i >= 0);

/** The row index the cursor is on (snapped to a pickable row), or -1. */
export function cursorRow(rows, sel) {
  const p = picks(rows);
  if (!p.length) return -1;
  return p[Math.max(0, Math.min(sel, p.length - 1))];
}

/**
 * One key. key: a normalized name ("j", "down", "enter", "escape", "tab", "shift-tab", "backspace", or a typed
 * character). rows: what the current view shows. Returns { state, action? }; action is one of
 *   { type: "open-loop" } (pinned a loop), { type: "jump", terminal }, { type: "done", loop, n },
 *   { type: "leave" } (hand the keyboard back), { type: "follow" }.
 */
export function step(state, key, rows) {
  const s = { ...state, sel: { ...state.sel } };
  const n = picks(rows).length;
  const v = s.view;
  const at = cursorRow(rows, s.sel[v]);
  const row = at >= 0 ? rows[at] : null;

  if (s.adding) { // the chooser takes every key: its own j/k/x/? are letters of the query
    const a = { ...s.adding };
    if (key === "escape") return { state: { ...s, adding: null } };
    if (key === "down" || key === "ctrl-n" || key === "up" || key === "ctrl-p") {
      const d = key === "down" || key === "ctrl-n" ? 1 : -1;
      a.sel = Math.max(0, Math.min(n - 1, Math.min(a.sel ?? 0, n - 1) + d)); return { state: { ...s, adding: a } };
    }
    if (key === "enter") {
      const at2 = cursorRow(rows, a.sel ?? 0), r = at2 >= 0 ? rows[at2] : null;
      if (!r) return { state: s };
      return { state: { ...s, adding: null }, action: { type: a.kind === "project" ? "add-project" : "add-dir", loop: a.loop, value: r.value } };
    }
    if (key === "backspace") { a.q = a.q.slice(0, -1); a.sel = 0; return { state: { ...s, adding: a } }; }
    if (key.length === 1) { a.q += key; a.sel = 0; return { state: { ...s, adding: a } }; }
    return { state: s };
  }

  if (s.filtering) {
    if (key === "escape") return { state: { ...s, filtering: false, query: "" } };
    if (key === "enter" || key === "down" || key === "up") s.filtering = false;
    else if (key === "backspace") { s.query = s.query.slice(0, -1); s.sel.all = 0; return { state: s }; }
    else if (key.length === 1) { s.query += key; s.sel.all = 0; return { state: s }; }
    else return { state: s };
    if (key === "enter") return step(s, "enter", rows);
  }

  const move = (d) => { s.sel[v] = Math.max(0, Math.min(n - 1, Math.min(s.sel[v], n - 1) + d)); return { state: s }; };
  switch (key) {
    case "j": case "down": case "ctrl-n": return move(1);
    case "k": case "up": case "ctrl-p": return move(-1);
    case "g": case "home": s.sel[v] = 0; return { state: s };
    case "G": case "end": s.sel[v] = Math.max(0, n - 1); return { state: s };
    case "1": s.view = "loop"; return { state: s };
    case "2": s.view = "all"; return { state: s };
    case "tab": case "shift-tab": case "h": case "l": case "left": case "right":
      s.view = v === "loop" ? "all" : "loop"; return { state: s };
    case "/": s.view = "all"; s.filtering = true; return { state: s };
    case "f": s.pinned = null; s.sel.loop = 0; return { state: s, action: { type: "follow" } };
    case "escape":
      if (s.query) return { state: { ...s, query: "" } };
      return { state: s, action: { type: "leave" } };
    case "o": { // jump to the lead of the loop under the cursor (all) or the current loop (loop)
      const lead = v === "all" ? row?.loop?.lead : null;
      return { state: s, action: { type: "lead", loop: v === "all" ? row?.loop?.id ?? null : null, terminal: lead } };
    }
    case "a": case "p": // add a folder or a project to the loop shown (captured now, so a reload can't move it)
      if (v !== "loop" || !state.addable) return { state: s };
      s.adding = { kind: key === "a" ? "dir" : "project", loop: state.addable, q: "", sel: 0 };
      return { state: s, action: { type: "choose", kind: s.adding.kind, loop: state.addable } };
    case "x": case " ":
      if (v === "loop" && row?.kind === "todo") return { state: s, action: { type: "done", loop: row.loop, n: row.n } };
      return { state: s };
    case "enter":
      if (!row) return { state: s };
      if (v === "all") { s.pinned = row.loop.id; s.view = "loop"; s.sel.loop = 0; return { state: s, action: { type: "open-loop" } }; }
      // Enter never finishes a todo (no undo): x or space does.
      if (row.terminal) return { state: s, action: { type: "jump", terminal: row.terminal } };
      if (row.key) { s.open = { ...s.open, [row.key]: !s.open?.[row.key] }; return { state: s }; }
      if (row.kind === "file" && row.path) return { state: s, action: row.local ? { type: "open-file", path: row.path } : { type: "note", text: "that file is on another machine" } };
      return { state: s };
    default: return { state: s };
  }
}

/** A gpui key event as one name for `step`: "j", "G", "enter", "shift-tab", "ctrl-n", or null to ignore. */
export function keyName(e) {
  const m = e?.modifiers ?? {}, k = e?.key ?? "";
  if (m.platform || m.alt) return null; // ⌘ and ⌥ chords belong to Herdr
  if (m.control) return ["n", "p"].includes(k) ? `ctrl-${k}` : null;
  if (k === "tab") return m.shift ? "shift-tab" : "tab";
  if (["enter", "escape", "backspace", "up", "down", "left", "right", "home", "end"].includes(k)) return k;
  if (k === "space") return " ";
  const c = e?.key_char ?? (k.length === 1 ? (m.shift ? k.toUpperCase() : k) : null);
  return c && c.length === 1 ? c : null;
}
