import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseTo, forYouTotal, STRIP_PX, OPEN_PX, placeOf, onMachine, loopOfTerminal, splitLoop, allLoops, currentLoop, loopRows, allRows, step, cursorRow, keyName, initialState } from "../core/panel.js";

const disk = [
  { id: "alpha", goals: [{ n: 1, text: "Ship alpha" }, { n: 2, text: "Docs" }], dirs: [{ path: "/r/alpha", machine: null }], projects: ["study"],
    tasks: { yours: [{ n: 3, text: "Approve design", by: "t3" }], agents: [{ owner: "t3", tasks: [{ n: 4, text: "Write parser" }] }] }, touched: 50 },
  { id: "beta", goals: [{ n: 1, text: "Beta things" }], dirs: [], projects: [], tasks: { yours: [], agents: [] }, touched: 90 },
  { id: "gamma", goals: [{ n: 1, text: "Old" }], dirs: [], projects: [], tasks: { yours: [], agents: [] }, touched: 10 },
];
const live = [
  { id: "alpha", goal: "Ship alpha", coordinator: "t1", needsYou: 0, lastWithYou: 100, ago: "1m",
    rows: [{ address: "t1", name: "coordinator", depth: 0, status: "working", isCoordinator: true }, { address: "t3", name: "parser", depth: 1, status: "idle" }] },
  { id: "ska/remote", goal: "Remote", coordinator: "ska/t9", needsYou: 2, lastWithYou: null, rows: [] },
];

test("allLoops joins disk and live loops; needs-you, then recent, then touched", () => {
  const ls = allLoops(disk, live);
  assert.deepEqual(ls.map((l) => l.id), ["ska/remote", "alpha", "beta", "gamma"]);
  const a = ls.find((l) => l.id === "alpha");
  assert.equal(a.goal, "Ship alpha"); assert.equal(a.yours, 1); assert.equal(a.agentTasks, 1); assert.equal(a.agents, 2);
  assert.ok(a.live && a.local);
  const r = ls[0]; assert.ok(r.live && !r.local);
});

test("currentLoop: pinned, else focused, else first", () => {
  const ls = allLoops(disk, live);
  assert.equal(currentLoop({ pinned: "beta" }, ls, "alpha"), "beta");
  assert.equal(currentLoop({ pinned: "gone" }, ls, "alpha"), "alpha");
  assert.equal(currentLoop({ pinned: null }, ls, null), "ska/remote");
  assert.equal(currentLoop({ pinned: null }, [], null), null);
});

test("loopRows shows goals, your todo, agents' tasks, agents and context", () => {
  const rows = loopRows("alpha", disk[0], live[0]);
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, ["head", "goal", "goal", "head", "todo", "head", "task", "head", "agent", "agent", "head", "dir", "project"]);
  assert.equal(rows[0].text, "GOALS (2)");
  assert.ok(rows[1].current && !rows[2].current);
  const empty = loopRows("beta", disk[1], null);
  assert.ok(empty.some((r) => r.text === "Nothing for you."));
  assert.ok(empty.some((r) => r.text === "No live terminals in this loop."));
  assert.ok(loopRows("ska/remote", null, live[1]).some((r) => r.text.startsWith("Its folder couldn't be read")));
  assert.equal(loopRows(null)[0].kind, "empty");
});

test("allRows filters by id and goal", () => {
  const ls = allLoops(disk, live);
  assert.equal(allRows(ls).length, 4);
  assert.deepEqual(allRows(ls, "beta").map((r) => r.text), ["beta"]);
  assert.deepEqual(allRows(ls, "ship").map((r) => r.text), ["alpha"]);
  assert.equal(allRows(ls, "zzz")[0].kind, "empty");
});

test("cursor moves over pickable rows only and clamps", () => {
  const rows = loopRows("alpha", disk[0], live[0]);
  let s = initialState();
  assert.equal(rows[cursorRow(rows, s.sel.loop)].kind, "todo");
  s = step(s, "j", rows).state; assert.equal(rows[cursorRow(rows, s.sel.loop)].kind, "task");
  s = step(s, "G", rows).state; assert.equal(rows[cursorRow(rows, s.sel.loop)].kind, "project");
  s = step(s, "j", rows).state; assert.equal(rows[cursorRow(rows, s.sel.loop)].kind, "project");
  s = step(s, "g", rows).state; s = step(s, "k", rows).state; assert.equal(s.sel.loop, 0);
});

test("x or space on your todo finishes it (enter doesn't: no undo); enter on an agent jumps", () => {
  const rows = loopRows("alpha", disk[0], live[0]);
  let s = initialState();
  assert.equal(step(s, "enter", rows).action, undefined);
  assert.deepEqual(step(s, "x", rows).action, { type: "done", loop: "alpha", n: 3 });
  assert.deepEqual(step(s, " ", rows).action, { type: "done", loop: "alpha", n: 3 });
  s = step(s, "j", rows).state; s = step(s, "j", rows).state;
  assert.deepEqual(step(s, "enter", rows).action, { type: "jump", terminal: "t1" });
  assert.equal(step(s, "x", rows).action, undefined);
});

test("views switch with 1, 2 and tab; enter on a loop pins it and opens the loop view", () => {
  const ls = allLoops(disk, live);
  let s = initialState();
  s = step(s, "2", []).state; assert.equal(s.view, "all");
  s = step(s, "tab", []).state; assert.equal(s.view, "loop");
  s = step(s, "tab", []).state;
  const rows = allRows(ls);
  s = step(s, "j", rows).state;
  const r = step(s, "enter", rows);
  assert.equal(r.state.pinned, "alpha"); assert.equal(r.state.view, "loop"); assert.equal(r.action.type, "open-loop");
  assert.deepEqual(step(s, "o", rows).action, { type: "coordinator", loop: "alpha", terminal: "t1" });
  assert.equal(step(r.state, "f", []).state.pinned, null);
});

test("/ filters the list; typing, backspace, enter, escape", () => {
  const ls = allLoops(disk, live);
  let s = step(initialState(), "/", []).state;
  assert.ok(s.filtering); assert.equal(s.view, "all");
  for (const c of "bet") s = step(s, c, allRows(ls, s.query)).state;
  assert.equal(s.query, "bet");
  s = step(s, "backspace", []).state; assert.equal(s.query, "be");
  s = step(s, "t", []).state;
  const r = step(s, "enter", allRows(ls, s.query));
  assert.equal(r.state.pinned, "beta"); assert.ok(!r.state.filtering);
  // j while filtering types j; escape clears the filter, a second escape leaves
  let f = step(initialState(), "/", []).state;
  f = step(f, "j", []).state; assert.equal(f.query, "j");
  f = step(f, "escape", []).state; assert.equal(f.query, ""); assert.ok(!f.filtering);
  assert.deepEqual(step(f, "escape", []).action, { type: "leave" });
});

test("keyName normalizes gpui key events and leaves chords to Herdr", () => {
  assert.equal(keyName({ key: "j", modifiers: {} }), "j");
  assert.equal(keyName({ key: "g", key_char: "G", modifiers: { shift: true } }), "G");
  assert.equal(keyName({ key: "tab", modifiers: { shift: true } }), "shift-tab");
  assert.equal(keyName({ key: "n", modifiers: { control: true } }), "ctrl-n");
  assert.equal(keyName({ key: "o", modifiers: { platform: true } }), null);
  assert.equal(keyName({ key: "enter", modifiers: {} }), "enter");
  assert.equal(keyName({ key: "space", modifiers: {} }), " ");
  assert.equal(keyName({ key: "/", modifiers: {} }), "/");
});

test("other machines: keys join live loops, a remote terminal's loop is found, keys split", () => {
  const remote = onMachine([{ id: "hub", goals: [{ n: 1, text: "Hub" }], dirs: [], projects: [], tasks: { yours: [{ n: 1, text: "Check" }], agents: [] }, touched: 1 }], "vana");
  assert.equal(remote[0].id, "vana/hub");
  const ls = allLoops(remote, [{ id: "vana/hub", goal: "Hub", coordinator: "vana/t29", needsYou: 0, lastWithYou: 5, rows: [] }]);
  assert.equal(ls.length, 1); assert.ok(ls[0].live && ls[0].local); assert.equal(ls[0].yours, 1);
  const terms = [{ address: "vana/t29", labels: { omniloop: "hub" } }, { address: "t1", labels: { omniloop: "here" } }, { address: "t2", labels: {} }];
  assert.equal(loopOfTerminal(terms, "vana/t29"), "vana/hub");
  assert.equal(loopOfTerminal(terms, "t1"), "here");
  assert.equal(loopOfTerminal(terms, "t2"), null);
  assert.deepEqual(splitLoop("vana/hub"), { machine: "vana", id: "hub" });
  assert.deepEqual(splitLoop("here"), { machine: null, id: "here" });
  assert.deepEqual(onMachine(null, "x"), []);
});

import { instructions, chooserRows } from "../core/panel.js";

test("instructions: has, none, and unchecked are kept apart", () => {
  const has = instructions({ checked: true, claude: "/r/a/CLAUDE.md", agents: null, context: null, skills: [{ name: "s1", path: "/r/a/.claude/skills/s1/SKILL.md" }], agentDefs: [] });
  assert.equal(has.state, "has"); assert.equal(has.text, "CLAUDE.md · 1 skill"); assert.equal(has.files.length, 2);
  assert.equal(instructions({ checked: true, skills: [], agentDefs: [] }).state, "none");
  assert.equal(instructions(null).state, "unchecked");
  assert.equal(instructions(undefined, "vana").text, "not checked (on vana)");
  assert.equal(instructions({ checked: true, missing: true }).state, "unchecked");
});

test("context rows unfold their files on Enter; a file opens, a remote one only notes", () => {
  const d = { ...disk[0], dirs: [{ path: "/r/alpha", machine: null, files: { checked: true, claude: "/r/alpha/CLAUDE.md", skills: [], agentDefs: [] } }],
    projects: [{ name: "study", description: "S", files: { checked: true, context: "/p/CONTEXT.md", skills: [], agentDefs: [] } }] };
  let s = initialState();
  let rows = loopRows("alpha", d, live[0], s.open);
  const dirAt = rows.findIndex((r) => r.kind === "dir");
  assert.equal(rows[dirAt].ins.text, "CLAUDE.md");
  // move the cursor onto the folder
  s.sel.loop = rows.filter((r) => r.pick).findIndex((r) => r.kind === "dir");
  s = step(s, "enter", rows).state;
  rows = loopRows("alpha", d, live[0], s.open);
  const file = rows.find((r) => r.kind === "file");
  assert.equal(file.path, "/r/alpha/CLAUDE.md");
  s.sel.loop = rows.filter((r) => r.pick).findIndex((r) => r.kind === "file");
  assert.deepEqual(step(s, "enter", rows).action, { type: "open-file", path: "/r/alpha/CLAUDE.md" });
  const remote = loopRows("vana/alpha", { ...d, machine: "vana" }, null, s.open);
  const rs = { ...s, sel: { ...s.sel, loop: remote.filter((r) => r.pick).findIndex((r) => r.kind === "file") } };
  assert.equal(step(rs, "enter", remote).action.type, "note");
  // old-format remote lister: plain project names, no files → not checked
  assert.equal(loopRows("x", { ...disk[0] }, null).find((r) => r.kind === "project").ins.state, "unchecked");
});

test("a / p open the chooser for the loop shown; the chooser takes every key; Enter adds; Esc closes", () => {
  let s = { ...initialState(), addable: "alpha" };
  let r = step(s, "p", []);
  assert.deepEqual(r.action, { type: "choose", kind: "project", loop: "alpha" });
  s = r.state;
  const cands = [{ value: "study", text: "study", note: "slides and tests" }, { value: "web", text: "web" }];
  for (const c of "x?j1") s = step(s, c, chooserRows(s.adding, cands)).state;
  assert.equal(s.adding.q, "x?j1"); assert.equal(s.adding.loop, "alpha");
  s = { ...s, adding: { ...s.adding, q: "" } };
  s = step(s, "down", chooserRows(s.adding, cands)).state;
  assert.deepEqual(step(s, "enter", chooserRows(s.adding, cands)).action, { type: "add-project", loop: "alpha", value: "web" });
  assert.equal(step(s, "escape", []).state.adding, null);
  assert.equal(step(s, "escape", []).action, undefined);
  // no folder for the loop → nothing opens
  assert.equal(step(initialState(), "a", []).state.adding, null);
});

test("chooserRows: filters, marks what the loop has, offers a typed path", () => {
  const cands = [{ value: "/r/a", text: "~/a" }, { value: "/r/b", text: "~/b" }];
  const rows = chooserRows({ kind: "dir", q: "" }, cands, ["/r/a"]);
  assert.ok(rows[0].have && !rows[0].pick); assert.ok(rows[1].pick);
  assert.equal(chooserRows({ kind: "dir", q: "~/new" }, cands)[0].value, "~/new");
  assert.equal(chooserRows({ kind: "project", q: "zzz" }, cands).at(-1).kind, "empty");
});

test("placeOf puts a folder's own name first and shortens any home to ~", () => {
  assert.deepEqual(placeOf("/Users/jane.doe@example.com/repos/claude-stuff"), { name: "claude-stuff", where: "~/repos" });
  assert.deepEqual(placeOf("/home/r/loops/proj/"), { name: "proj", where: "~/loops" });
  assert.deepEqual(placeOf("/Users/r"), { name: "~", where: "" });
  assert.deepEqual(placeOf("/opt/x"), { name: "x", where: "/opt" });
  assert.deepEqual(placeOf("/x"), { name: "x", where: "/" });
  const rows = loopRows("alpha", { ...disk[0], notes: { checked: true, claude: "/l/CLAUDE.md", skills: [], agentDefs: [] } }, null);
  const head = rows.find((r) => r.text === "CONTEXT");
  assert.equal(head.hint, "a add folder · p add project");
  assert.equal(rows.find((r) => r.kind === "dir").name, "alpha");
  assert.equal(rows.find((r) => r.kind === "notes").name, "Loop notes");
});

test("a folder the loop works on in its own copy (git worktree) carries the copy and branch", () => {
  const d = { ...disk[0], dirs: [{ path: "/Users/r/repos/omniloop", machine: null, worktree: "/Users/r/loops/alpha/wt/omniloop", branch: "alpha/work", base: "abc1234", dirty: [] }] };
  const row = loopRows("alpha", d, null).find((r) => r.kind === "dir");
  assert.equal(row.name, "omniloop"); assert.equal(row.where, "~/repos");
  assert.deepEqual(row.copy, { name: "omniloop", where: "~/loops/alpha/wt" });
  assert.equal(row.branch, "alpha/work");
  assert.equal(loopRows("alpha", disk[0], null).find((r) => r.kind === "dir").copy, undefined);
});

test("c asks to collapse; collapseTo shrinks to a strip and opens to the last width", () => {
  assert.deepEqual(step(initialState(), "c", []).action, { type: "collapse" });
  // typed into the filter, c is a letter
  const f = step({ ...initialState(), view: "all", filtering: true }, "c", []);
  assert.equal(f.action, undefined); assert.equal(f.state.query, "c");
  assert.deepEqual(collapseTo(452, null), { px: STRIP_PX, wide: 452 });
  assert.deepEqual(collapseTo(40, 452), { px: 452, wide: 452 });
  assert.deepEqual(collapseTo(40, null), { px: OPEN_PX, wide: null });
  assert.deepEqual(collapseTo(null, null), { px: STRIP_PX, wide: null });
  assert.deepEqual(collapseTo(456, null, 380), { px: STRIP_PX, wide: 380 }); // the layout's size beats a zoomed width
  assert.deepEqual(collapseTo(456, null, 40), { px: STRIP_PX, wide: 456 });
  assert.equal(forYouTotal([{ needsYou: 2 }, { needsYou: 0 }, {}]), 2);
});

test("for-you words: the loop's label and an agent's word replace counts and reasons", () => {
  const lv = [{ ...live[0], needsYou: 3, forYouLabel: "1 needs approval · 2 asked you",
    rows: [{ ...live[0].rows[0], forYou: "the coordinator", forYouLabel: "asked you" }, live[0].rows[1]] }];
  const a = allLoops(disk, lv).find((l) => l.id === "alpha");
  assert.equal(a.forYou, "1 needs approval · 2 asked you");
  const m = loopRows("alpha", disk[0], lv[0]).find((r) => r.kind === "agent" && r.isCoordinator);
  assert.equal(m.forYou, "asked you");
  // an older view (another machine's) with counts only
  assert.equal(allLoops([], [{ ...live[1] }])[0].forYou, "2 for you");
  assert.equal(allLoops(disk, [])[0].forYou, "");
});

test("a temporary loop is marked temp", () => {
  const ls = allLoops([{ ...disk[0], temp: true }, disk[1]], []);
  assert.equal(ls.find((l) => l.id === "alpha").temp, true);
  assert.equal(ls.find((l) => l.id === "beta").temp, false);
  assert.equal(allLoops([], [live[1]])[0].temp, false);
});
