// picker.js: the full-page "what are you working on?" picker, as plain data. Pure.
//
// Step "ask": you type a request; existing loops are ranked against it, and "start a new loop" is always offered.
// Step "context": for a new loop, pick its context folders (type to filter, Tab to toggle, Enter to create).
//
// Ranking is one function, `rank`, so a semantic ranker (embeddings of each loop's goal and conversations,
// debounced as you type) can replace the word match later without touching the rest.

import { validId } from "./loopdir.js";

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

/** Folders for step "context": selected ones first, then matches. folders: absolute paths. */
export function folderRows(folders, query, selected = []) {
  const sel = new Set(selected);
  const base = (p) => p.split("/").filter(Boolean).pop() ?? p;
  const hits = folders.filter((p) => !sel.has(p) && matchScore(query, `${base(p)} ${p}`) > 0)
    .sort((a, b) => matchScore(query, base(b)) - matchScore(query, base(a)) || base(a).localeCompare(base(b)));
  return [...selected.map((p) => ({ path: p, name: base(p), on: true })), ...hits.map((p) => ({ path: p, name: base(p), on: false }))];
}

/**
 * The context step's project rows, shown above the folders: picked projects first, then the rest that match what's typed.
 * projects: [{ name, description }]; picked: names. Rows: { kind: "project", name, description, on }.
 */
export function projectRows(projects, query, picked = []) {
  const sel = new Set(picked);
  const on = projects.filter((p) => sel.has(p.name)).map((p) => ({ kind: "project", name: p.name, description: p.description ?? "", on: true }));
  const off = projects.filter((p) => !sel.has(p.name) && matchScore(query, `${p.name} ${p.description ?? ""}`) > 0)
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
