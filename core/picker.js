// picker.js: the full-page "what are you working on?" picker, as plain data. Pure.
//
// Step "ask": you type a request; existing loops are ranked against it, and "start a new loop" is always offered.
// Step "context": for a new loop, pick its context folders (type to filter, Tab to toggle, Enter to create).
//
// Ranking is one function, `rank`, so a semantic ranker (embeddings of each loop's goal and conversations,
// debounced as you type) can replace the word match later without touching the rest.

import { validId } from "./loopdir.js";
import { fuzzyFields, tokenScore, tokens, snippet } from "./fuzzy.js";
import { slotOf } from "./pins.js";

const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** How well `text` matches `query`: every query word must appear as a prefix of some word (or a substring). */
export function matchScore(query, text) {
  const q = words(query);
  if (!q.length) return 1;
  const t = words(text);
  const hay = t.join(" ");
  let score = 0;
  for (const w of q) {
    if (t.some((x) => x === w)) score += 3;
    else if (t.some((x) => x.startsWith(w))) score += 2;
    else if (hay.includes(w)) score += 1;
    else return 0;
  }
  return score;
}

/**
 * Loops for the picker, best first. loops: buildView(...).loops (each with lastWithYou, needsYou, rows).
 * With no query: by when you last worked in them. With a query: by match, then recency. Non-matches drop out.
 */
export function rank(loops, query) {
  const scored = loops
    .map((l) => ({ l, s: matchScore(query, [l.id, l.goal, ...l.rows.map((r) => r.name)].join(" ")) }))
    .filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || (b.l.lastWithYou ?? -1) - (a.l.lastWithYou ?? -1) || b.l.needsYou - a.l.needsYou || a.l.id.localeCompare(b.l.id));
  return scored.map((x) => x.l);
}

const STOP = new Set(["a", "an", "the", "to", "for", "and", "of", "in", "on", "with", "my", "i", "want", "need", "please", "can", "you", "we", "let", "lets", "let's", "make", "do", "is", "it", "this", "that"]);

/** A loop id from a request: its first few meaningful words, made unique against `taken`. */
/** A link, as a short name: an Instagram reel becomes "reel-<id>", a YouTube video "yt-<id>", anything else its site. */
export function linkTag(url) {
  let u;
  try { u = new URL(url); } catch { return ""; }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host.endsWith("instagram.com") && parts.length >= 2) return `${parts[0] === "p" ? "post" : parts[0]} ${parts[1]}`;
  if (host === "youtu.be" && parts[0]) return `yt ${parts[0]}`;
  if (host.endsWith("youtube.com")) return `yt ${u.searchParams.get("v") ?? (parts[0] === "shorts" ? parts[1] : parts.at(-1)) ?? ""}`;
  if (host.endsWith("tiktok.com")) return `tiktok ${parts.at(-1) ?? ""}`;
  if (host.endsWith("podcasts.apple.com")) return `podcast ${parts.at(-2) ?? ""}`;
  return host.split(".").slice(-2, -1)[0] ?? host;
}

export function slugify(text, taken = []) {
  text = String(text ?? "").replace(/https?:\/\/\S+/g, (m) => ` ${linkTag(m)} `);
  const w = words(text).filter((x, i, all) => !STOP.has(x) && all.indexOf(x) === i);
  let base = (w.length ? w : words(text)).slice(0, 4).join("-").slice(0, 36).replace(/-+$/, "") || "loop";
  if (!/^[a-z0-9]/.test(base)) base = `l-${base}`;
  const used = new Set(taken);
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return validId(id) ? id : "loop";
}

/** The rows of step "ask": ranked loops, then the new-loop row (first when nothing matches). */
export function askRows(loops, query, takenIds = loops.map((l) => l.id)) {
  const found = rank(loops, query).map((l) => ({ kind: "loop", loop: l }));
  const q = String(query ?? "").trim();
  const fresh = q ? { kind: "new", id: slugify(q, takenIds), goal: q } : { kind: "new", id: null, goal: null };
  return found.length ? [...found, fresh] : [fresh];
}

/** Folders for step "context": selected ones first, then fuzzy matches on the folder's name (then its path). */
export function folderRows(folders, query, selected = []) {
  const sel = new Set(selected);
  const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
  const score = (p) => fuzzyFields(query, [{ name: "name", text: base(p), weight: 2 }, { name: "path", text: p }])?.score ?? -1;
  const hits = folders.filter((p) => !sel.has(p) && score(p) >= 0)
    .sort((a, b) => score(b) - score(a) || base(a).localeCompare(base(b)));
  return [...selected.map((p) => ({ path: p, name: base(p), on: true })), ...hits.map((p) => ({ path: p, name: base(p), on: false }))];
}

/**
 * The context step's project rows, shown above the folders: picked projects first, then the rest that match what's typed.
 * projects: [{ name, description }]; picked: names. Rows: { kind: "project", name, description, on }.
 */
export function projectRows(projects, query, picked = []) {
  const sel = new Set(picked);
  const score = (p) => fuzzyFields(query, [{ name: "name", text: p.name, weight: 2 }, { name: "description", text: p.description ?? "", long: true }])?.score ?? -1;
  const on = projects.filter((p) => sel.has(p.name)).map((p) => ({ kind: "project", name: p.name, description: p.description ?? "", on: true }));
  const off = projects.filter((p) => !sel.has(p.name) && score(p) >= 0).sort((a, b) => score(b) - score(a))
    .map((p) => ({ kind: "project", name: p.name, description: p.description ?? "", on: false }));
  return [...on, ...off];
}

/** Keep a selection index inside a list of n rows. */
export function clampAt(at, n) {
  return n ? Math.max(0, Math.min(at, n - 1)) : 0;
}

/**
 * The context step's machine rows, shown first, only when this computer can see other machines (one that sees none
 * gets no rows, so it can only make loops on itself). machines: names of connected machines; chosen: a name, or
 * null for this computer. Rows: { kind: "machine", name (null = here), label, on }.
 */
export function machineRows(machines, chosen = null) {
  if (!machines?.length) return [];
  return [null, ...machines].map((name) => ({ kind: "machine", name, label: name ?? "this computer", on: name === chosen }));
}

/**
 * How to make the loop. Here: `<bin>/omniloop new ...`. On another machine: the same command run there through
 * `hc exec --on`, with that machine's own omniloop (on its PATH) and only that machine's folders and projects;
 * nothing from this computer is passed but the goal you typed.
 */
export function newLoopCommand({ machine = null, id, goal, projects = [], dirs = [], bin, hc }) {
  const args = ["new", id, "--goal", goal, ...projects.flatMap((p) => ["--project", p]), ...dirs.flatMap((d) => ["--dir", d])];
  if (!machine) return { cmd: `${bin}/omniloop`, args };
  return { cmd: hc, args: ["exec", "--on", machine, "--", "/bin/zsh", "-lc", 'exec omniloop "$@"', "omniloop", ...args] };
}

/** The lead's terminal from `omniloop new`'s output ("lead t7 in space x"), as an address seen from here. */
export function leadAddress(stdout, machine = null) {
  const m = String(stdout ?? "").match(/^lead (\S+) in space /m);
  if (!m) return null;
  return machine ? `${machine}/${m[1]}` : m[1];
}

// ---- every loop, searched (the ⌘O list) ---------------------------------------------------------------------

/** What a loop on this computer shows as its machine when the computer's own name isn't known. */
export const LOCAL_NAME = "this computer";
const HERE = ["here", "local"];

const baseName = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

/**
 * One entry per loop, from the loops with sessions (buildView(...).loops, keyed by loopKey: "<id>" or "<machine>/<id>")
 * and this computer's loop folders (`omniloop index --json`: [{ id, goal, dirs, projects, tasks, feed, touched }]),
 * so a loop with nobody running still shows and can be searched. Entry:
 * { key, id, machine, goal, lead, needsYou, status, ago, lastWithYou, touched, running, members, dirs, projects, tasks, feed, pin }
 */
export function loopEntries(viewLoops = [], index = [], pins = [], local = LOCAL_NAME) {
  const byId = new Map(index.map((x) => [x.id, x]));
  const out = [];
  for (const l of viewLoops) {
    const i = l.id.indexOf("/");
    const machine = i < 0 ? null : l.id.slice(0, i);
    const disk = machine ? null : byId.get(l.id);
    out.push({ key: l.id, where: machine ?? local, id: machine ? l.id.slice(i + 1) : l.id, machine, goal: l.goal ?? disk?.goal ?? "", lead: l.lead ?? l.rows?.[0]?.address ?? null,
      needsYou: l.needsYou ?? 0, forYouLabel: l.forYouLabel ?? (l.needsYou ? `${l.needsYou} for you` : ""), status: l.status ?? null, ago: l.ago ?? null, lastWithYou: l.lastWithYou ?? null, touched: disk?.touched ?? null,
      running: true, members: (l.rows ?? []).map((r) => r.name).filter(Boolean), dirs: disk?.dirs ?? [], projects: disk?.projects ?? [],
      tasks: disk?.tasks ?? [], feed: disk?.feed ?? [], pin: slotOf(pins, l.id) });
  }
  const seen = new Set(out.map((e) => e.key));
  for (const x of index) {
    if (seen.has(x.id)) continue;
    out.push({ key: x.id, where: local, id: x.id, machine: null, goal: x.goal ?? "", lead: null, needsYou: 0, forYouLabel: "", status: null, ago: null, lastWithYou: null,
      touched: x.touched ?? null, running: false, members: [], dirs: x.dirs ?? [], projects: x.projects ?? [], tasks: x.tasks ?? [], feed: x.feed ?? [],
      pin: slotOf(pins, x.id) });
  }
  return out;
}

const FIELD_LABEL = { member: "session", folder: "folder", project: "project", task: "task", chat: "chat" };

/** How an entry matches a query: { score, why } or null. `why` is one short line, only when the hit isn't in the id or goal. */
export function entryMatch(e, query) {
  const m = fuzzyFields(query, [
    { name: "id", text: e.id, weight: 3 }, { name: "machine", text: e.where ?? e.machine ?? "", weight: 1.2 }, { name: "goal", text: e.goal, weight: 2, long: true },
    { name: "member", text: e.members, weight: 1.2 }, { name: "folder", text: e.dirs.map(baseName), weight: 1.5 },
    { name: "project", text: e.projects, weight: 1.5 }, { name: "task", text: e.tasks, long: true }, { name: "chat", text: e.feed, weight: 0.8, long: true },
  ]);
  if (!m) return null;
  const why = FIELD_LABEL[m.field] ? `${FIELD_LABEL[m.field]}: ${snippet(m.text, query, 56)}` : null;
  return { score: m.score, why };
}

/**
 * A query's "@machine" token, apart from the rest: "@ska plenary" -> { machine: "ska", rest: "plenary" }. A lone "@"
 * is no filter. Only the first @token counts; any others stay in the rest.
 */
export function splitMachine(query) {
  const ws = String(query ?? "").trim().split(/\s+/).filter(Boolean);
  const i = ws.findIndex((w) => w.length > 1 && w[0] === "@");
  if (i < 0) return { machine: null, rest: ws.filter((w) => w !== "@").join(" ") };
  return { machine: ws[i].slice(1).toLowerCase(), rest: ws.filter((w, j) => j !== i && w !== "@").join(" ") };
}

/** Is this entry on the machine a query named? Another machine's by its name; this computer's by its name, "here" or "local". */
export function onMachine(e, name) {
  if (!name) return true;
  const names = e.machine ? [e.machine] : [e.where ?? LOCAL_NAME, ...HERE];
  return names.some((n) => String(n).toLowerCase().startsWith(name));
}

const recency = (a, b) => (b.lastWithYou ?? -1) - (a.lastWithYou ?? -1) || (b.touched ?? -1) - (a.touched ?? -1) || a.key.localeCompare(b.key);
const pinOrder = (a, b) => (a.pin ?? 99) - (b.pin ?? 99);

/**
 * The ⌘O rows. No query: pinned loops in slot order, then the ones you talked to most recently (then most recently
 * changed). A query: every loop that fuzzy-matches, best first (pins, then recency, break ties), each with a short
 * `why`. Rows: { kind: "loop", entry, why } then { kind: "new", id, goal } (first and alone when nothing matches).
 */
export function pickerRows(entries, query, takenIds = entries.filter((e) => !e.machine).map((e) => e.id)) {
  const { machine, rest: q } = splitMachine(query);
  entries = entries.filter((e) => onMachine(e, machine));
  let found;
  if (!q) found = [...entries].sort((a, b) => pinOrder(a, b) || recency(a, b)).map((entry) => ({ kind: "loop", entry, why: null }));
  else found = entries.map((entry) => ({ entry, m: entryMatch(entry, q) })).filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score || pinOrder(a.entry, b.entry) || recency(a.entry, b.entry))
    .map((x) => ({ kind: "loop", entry: x.entry, why: x.m.why }));
  const fresh = q ? { kind: "new", id: slugify(q, takenIds), goal: q } : { kind: "new", id: null, goal: null };
  return found.length ? [...found, fresh] : [fresh];
}

const SUGGEST_STOP = new Set([...STOP, "fix", "add", "new", "get", "use", "work", "working", "loop", "build", "would", "should", "could", "also", "just", "like", "from", "into", "when", "what", "have", "will", "some"]);

/**
 * Existing loops that might already cover a goal you're writing, best first, at most `n`. Unlike search, a goal is
 * a sentence, so not every word must hit: a loop needs two of its meaningful words in its id, goal, folders or
 * projects (one when the goal has only one or two), or one word that is exactly its id, a folder's name or a
 * project's name ("omniloop" names the loops working in ~/repos/omniloop). Returns entries.
 */
export function suggestLoops(entries, goal, n = 3) {
  const ws = [...new Set(tokens(goal).map((w) => w.replace(/[^a-z0-9-]/g, "")).filter((w) => w.length >= 3 && !SUGGEST_STOP.has(w)))];
  if (!ws.length) return [];
  const need = ws.length <= 2 ? 1 : 2;
  const scored = entries.map((e) => {
    const hay = [e.id, e.goal, ...e.dirs.map(baseName), ...e.projects];
    const names = new Set([e.id, ...e.dirs.map(baseName), ...e.projects].map((x) => String(x).toLowerCase()));
    let hits = 0, score = 0, exact = 0;
    for (const w of ws) {
      const s = Math.max(0, ...hay.map((t) => tokenScore(w, t, { subsequence: false })));
      if (s > 0) { hits++; score += s; }
      if (w === e.id) exact += 2; else if (names.has(w)) exact += 1;
    }
    return { e, hits, score, exact };
  }).filter((x) => x.hits >= need || x.exact > 0);
  scored.sort((a, b) => b.exact - a.exact || b.hits - a.hits || b.score - a.score || recency(a.e, b.e));
  return scored.slice(0, n).map((x) => x.e);
}
