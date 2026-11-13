import { test } from "node:test";
import assert from "node:assert/strict";
import { addTask, finishTask, giveTask, openTasks, taskLines, taskNote, tasksOf, YOU } from "../core/tasks.js";

const seed = () => {
  let f = {};
  f = addTask(f, { text: "Approve the  design", owner: YOU, by: "t3", now: 1 }).file;
  f = addTask(f, { text: "Write the parser", owner: "t3", by: YOU, now: 2 }).file;
  f = addTask(f, { text: "Review the parser", owner: "t5", by: "t3", now: 3 }).file;
  f = addTask(f, { text: "Write tests", owner: "t3", by: "t3", now: 4 }).file;
  return f;
};

test("add numbers tasks and needs words and an owner", () => {
  const f = seed();
  assert.deepEqual(tasksOf(f).map((t) => [t.n, t.for, t.text]), [[1, YOU, "Approve the design"], [2, "t3", "Write the parser"], [3, "t5", "Review the parser"], [4, "t3", "Write tests"]]);
  assert.ok(addTask(f, { text: " ", owner: YOU, now: 5 }).error);
  assert.ok(addTask(f, { text: "x", owner: null, now: 5 }).error);
  assert.equal(tasksOf({}).length, 0);
});

test("openTasks splits yours from the agents', grouped by agent", () => {
  const { yours, agents } = openTasks(seed());
  assert.deepEqual(yours.map((t) => t.n), [1]);
  assert.deepEqual(agents.map((a) => [a.owner, a.tasks.map((t) => t.n)]), [["t3", [2, 4]], ["t5", [3]]]);
});

test("done and give", () => {
  let f = finishTask(seed(), 2, { by: "t3", now: 9 }).file;
  assert.equal(tasksOf(f)[1].done, 9);
  assert.match(finishTask(f, 2, { now: 10 }).error, /already done/);
  assert.ok(finishTask(f, 99, { now: 10 }).error);
  f = giveTask(f, 3, YOU).file;
  assert.deepEqual(openTasks(f).yours.map((t) => t.n), [1, 3]);
  assert.match(giveTask(f, 2, YOU).error, /done/);
  assert.ok(giveTask(f, 1, "").error);
});

test("taskLines and taskNote are short and say who asked", () => {
  assert.deepEqual(taskLines(seed(), "t3"), ["2. Write the parser (from you)", "4. Write tests"]);
  const t = tasksOf(seed())[2];
  assert.equal(taskNote(t, "m2"), "omniloop: task 3 in loop m2 is yours (from t3): Review the parser. Done: omniloop task done 3");
});
