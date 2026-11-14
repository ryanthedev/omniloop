// goals.js: every loop always has a goal. Pure. Stored in loop.json:
//
//   goal:  "<current goal text>"            (kept for everything that reads one line: CLAUDE.md, labels, projects)
//   goals: [{ n, text, at, ended?, how? }]  every goal ever: the current one, any added ones, and history
//   goalRev: <number>                        bumped on every change; the hook injects only when it moves
//
// "set" replaces the current goal (the old one is kept as history), "add" adds another open goal alongside it,
// "done n" closes one. The last open goal can't be closed: set a new one instead.

import { replaceBlock } from "./blocks.js";

export function goalsOf(m) {
  if (Array.isArray(m.goals) && m.goals.length) return m.goals;
  return m.goal ? [{ n: 1, text: m.goal, at: m.created_ms ?? 0 }] : [];
}

/** Open goals, current first: [{ n, text, at }]. */
export function openGoals(m) {
  const open = goalsOf(m).filter((g) => !g.ended);
  const cur = open.find((g) => g.text === m.goal) ?? open.at(-1);
  return cur ? [cur, ...open.filter((g) => g.n !== cur.n)] : [];
}

const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const nextN = (gs) => gs.reduce((a, g) => Math.max(a, g.n), 0) + 1;
const done = (m, goals, goal) => ({ ...m, goals, goal, goalRev: (m.goalRev ?? 0) + 1 });

/** Replace the current goal. Returns { manifest } or { error }. */
export function setGoal(m, text, now) {
  const t = clean(text);
  if (!t) return { error: "a goal needs words" };
  const open = openGoals(m);
  if (open[0]?.text === t) return { manifest: m };
  const gs = goalsOf(m).map((g) => (g.n === open[0]?.n ? { ...g, ended: now, how: "replaced" } : g));
  return { manifest: done(m, [...gs, { n: nextN(gs), text: t, at: now }], t) };
}

/** Add another open goal; the current one stays current. */
export function addGoal(m, text, now) {
  const t = clean(text);
  if (!t) return { error: "a goal needs words" };
  const gs = goalsOf(m);
  if (gs.some((g) => !g.ended && g.text === t)) return { manifest: m };
  if (!gs.length) return setGoal(m, t, now);
  return { manifest: done(m, [...gs, { n: nextN(gs), text: t, at: now }], m.goal ?? openGoals(m)[0]?.text ?? t) };
}

/** Close open goal n. Refused for the last open goal. Closing the current one makes the next open one current. */
export function finishGoal(m, n, now) {
  const open = openGoals(m);
  const g = open.find((x) => x.n === Number(n));
  if (!g) return { error: `no open goal ${n}` };
  if (open.length === 1) return { error: "that's the loop's only goal; set a new one instead (omniloop goal set \"…\")" };
  const gs = goalsOf(m).map((x) => (x.n === g.n ? { ...x, ended: now, how: "done" } : x));
  const cur = g.n === open[0].n ? open[1].text : open[0].text;
  return { manifest: done(m, gs, cur) };
}

/** Reword open goal n; rewording the current goal changes the loop's goal line too. */
export function editGoal(m, n, text, now) {
  const t = clean(text);
  if (!t) return { error: "a goal needs words" };
  const open = openGoals(m);
  const g = open.find((x) => x.n === Number(n));
  if (!g) return { error: `no open goal ${n}` };
  if (g.text === t) return { manifest: m };
  const gs = goalsOf(m).map((x) => (x.n === g.n ? { ...x, text: t, edited: now } : x));
  return { manifest: done(m, gs, g.n === open[0].n ? t : open[0].text) };
}

export const GOAL_START = "<!-- omniloop:goal -->";
export const GOAL_END = "<!-- /omniloop:goal -->";

export function goalBlock(m) {
  const [cur, ...more] = openGoals(m);
  const lines = [GOAL_START, `**End goal:** ${cur ? cur.text : "(not set: `omniloop goal set \"…\"`)"}`];
  if (more.length) lines.push("", "**Also open:**", ...more.map((g) => `- ${g.text}`));
  lines.push("", "This is what the user is working on in this loop. Your own task may be narrower; it serves this end.",
    "When they conflict, the end goal wins: say so instead of drifting. It can change while you work; a change",
    "reaches you as a note, and `omniloop goal` shows it. Tasks (yours, other agents', the user's): `omniloop task ls`.", GOAL_END);
  return lines.join("\n");
}

/** Rewrite the goal block of a CLAUDE.md; an old file's lone "**Goal:**" line becomes the block. */
export function withGoalBlock(text, m, notes = []) {
  const anchor = (t, block) => {
    const line = t.match(/^\*\*(?:End goal|Goal):\*\*.*$/m);
    if (line) return t.replace(line[0], () => block);
    const h = t.match(/^# .*$/m);
    return h ? t.replace(h[0], () => `${h[0]}\n\n${block}`) : `${block}\n\n${t}`;
  };
  const r = replaceBlock(text, GOAL_START, GOAL_END, goalBlock(m), anchor);
  if (r.note) notes.push(r.note);
  return r.text;
}

/** The one line an agent gets when the goal changed. */
export function goalNote(m, id) {
  const [cur, ...more] = openGoals(m);
  if (!cur) return `omniloop: loop ${id} has no goal; ask the user for one.`;
  return `omniloop: loop ${id} end goal (what the user is working on) is now: ${cur.text}${more.length ? ` (also open: ${more.map((g) => g.text).join("; ")})` : ""}. Your task serves it.`;
}
