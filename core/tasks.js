// tasks.js: a loop's to-do list, with two kinds of owner: you, and the loop's agents (by terminal address).
// Pure. Stored in ~/loops/<id>/tasks.json, apart from loop.json, so task churn never touches the goal:
//
//   { tasks: [{ n, text, for: "you" | "<address>", by: "you" | "<address>", at, done?, doneBy? }] }
//
// The loop's goal is the end; tasks are the steps. An agent's own task can be narrower than the goal.

export const YOU = "you";

export function tasksOf(file) {
  return Array.isArray(file?.tasks) ? file.tasks : [];
}

const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const nextN = (ts) => ts.reduce((a, t) => Math.max(a, t.n), 0) + 1;

/** Add a task. Returns { file, task } or { error }. */
export function addTask(file, { text, owner, by, now }) {
  const t = clean(text);
  if (!t) return { error: "a task needs words" };
  if (!owner) return { error: "who is it for? --for you, or an agent's terminal (t3)" };
  const ts = tasksOf(file);
  const task = { n: nextN(ts), text: t, for: owner, by: by ?? YOU, at: now };
  return { file: { ...file, tasks: [...ts, task] }, task };
}

function change(file, n, f) {
  const ts = tasksOf(file);
  const t = ts.find((x) => x.n === Number(n));
  if (!t) return { error: `no task ${n}` };
  const r = f(t);
  if (r.error) return r;
  return { file: { ...file, tasks: ts.map((x) => (x.n === t.n ? r.task : x)) }, task: r.task };
}

/** Mark task n done. */
export function finishTask(file, n, { by, now }) {
  return change(file, n, (t) => (t.done ? { error: `task ${n} is already done` } : { task: { ...t, done: now, doneBy: by ?? YOU } }));
}

/** Give task n to someone else (you, or an agent). */
export function giveTask(file, n, owner) {
  if (!owner) return { error: "give it to whom? you, or an agent's terminal (t3)" };
  return change(file, n, (t) => (t.done ? { error: `task ${n} is done` } : { task: { ...t, for: owner } }));
}

/** Open tasks, oldest first: { yours: [...], agents: [{ owner, tasks: [...] }] } (agents in order of their first task). */
export function openTasks(file) {
  const open = tasksOf(file).filter((t) => !t.done);
  const yours = open.filter((t) => t.for === YOU);
  const agents = [];
  for (const t of open) {
    if (t.for === YOU) continue;
    let g = agents.find((a) => a.owner === t.for);
    if (!g) agents.push((g = { owner: t.for, tasks: [] }));
    g.tasks.push(t);
  }
  return { yours, agents };
}

/** What `omniloop task` prints for one owner: short lines, newest work last. */
export function taskLines(file, owner) {
  const open = tasksOf(file).filter((t) => !t.done && t.for === owner);
  return open.map((t) => `${t.n}. ${t.text}${t.by !== owner ? ` (from ${t.by})` : ""}`);
}

/** The one line typed into an agent that was just given a task. */
export function taskNote(task, loop) {
  return `omniloop: task ${task.n} in loop ${loop} is yours (from ${task.by}): ${task.text}. Done: omniloop task done ${task.n}`;
}

/** Reword task n (open or done). */
export function editTask(file, n, text) {
  const t = clean(text);
  if (!t) return { error: "a task needs words" };
  return change(file, n, (x) => ({ task: { ...x, text: t } }));
}

/** Open a done task again. */
export function reopenTask(file, n) {
  return change(file, n, (t) => {
    if (!t.done) return { error: `task ${n} is still open` };
    const { done, doneBy, ...rest } = t;
    return { task: rest };
  });
}

/** Delete task n for good (numbers of the others don't change). Returns { file, task } or { error }. */
export function removeTask(file, n) {
  const ts = tasksOf(file);
  const task = ts.find((x) => x.n === Number(n));
  if (!task) return { error: `no task ${n}` };
  return { file: { ...file, tasks: ts.filter((x) => x !== task) }, task };
}
