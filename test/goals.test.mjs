import { test } from "node:test";
import assert from "node:assert/strict";
import { goalsOf, openGoals, setGoal, addGoal, finishGoal, withGoalBlock, goalNote, GOAL_START } from "../core/goals.js";
import { claudeMd, newManifest } from "../core/loopdir.js";

const base = () => newManifest({ id: "x", goal: "Ship M2", now: 100 });

test("an old manifest's single goal reads as goal 1", () => {
  assert.deepEqual(goalsOf(base()), [{ n: 1, text: "Ship M2", at: 100 }]);
  assert.deepEqual(goalsOf(newManifest({ id: "y" })), []);
});

test("set replaces the current goal and keeps the old one as history", () => {
  const { manifest: m } = setGoal(base(), "  Ship   M3 ", 200);
  assert.equal(m.goal, "Ship M3");
  assert.equal(m.goalRev, 1);
  assert.deepEqual(m.goals.map((g) => [g.n, g.text, g.how ?? null]), [[1, "Ship M2", "replaced"], [2, "Ship M3", null]]);
  assert.deepEqual(openGoals(m).map((g) => g.text), ["Ship M3"]);
  assert.equal(setGoal(m, "Ship M3", 300).manifest, m); // same text: no change, no rev bump
  assert.ok(setGoal(m, "   ", 300).error);
});

test("add keeps the current goal first; done closes one but never the last", () => {
  let m = addGoal(base(), "Write the docs", 200).manifest;
  assert.equal(m.goal, "Ship M2");
  assert.deepEqual(openGoals(m).map((g) => g.n), [1, 2]);
  assert.match(finishGoal(finishGoal(m, 2, 300).manifest, 1, 400).error, /only goal/);
  const closedCurrent = finishGoal(m, 1, 300).manifest;
  assert.equal(closedCurrent.goal, "Write the docs");
  assert.equal(closedCurrent.goalRev, 2);
  assert.ok(finishGoal(m, 9, 300).error);
  assert.equal(addGoal(newManifest({ id: "z" }), "first", 1).manifest.goal, "first");
});

test("CLAUDE.md: the old Goal line becomes a block, later rewrites keep the rest", () => {
  const old = claudeMd(base()); // written before goal blocks existed
  const md1 = withGoalBlock(old + "\n## Mine\nkeep me\n", base());
  assert.equal(md1.split(GOAL_START).length, 2);
  assert.equal((md1.match(/\*\*(End goal|Goal):\*\*/g) ?? []).length, 1);
  const m = addGoal(setGoal(base(), "Ship M3", 2).manifest, "Docs", 3).manifest;
  const md2 = withGoalBlock(md1, m);
  assert.match(md2, /\*\*End goal:\*\* Ship M3/);
  assert.match(md2, /\*\*Also open:\*\*\n- Docs/);
  assert.doesNotMatch(md2, /Ship M2/);
  assert.match(md2, /## Mine\nkeep me/);
  assert.match(withGoalBlock("# Loop: q\n\nhi", base()), /^# Loop: q\n\n<!-- omniloop:goal -->/);
});

test("goalNote is one line", () => {
  const m = addGoal(base(), "Docs", 2).manifest;
  assert.equal(goalNote(m, "x"), "omniloop: loop x end goal (what the user is working on) is now: Ship M2 (also open: Docs). Your task serves it.");
  assert.doesNotMatch(goalNote(m, "x"), /\n/);
});
