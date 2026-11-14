import { test } from "node:test";
import assert from "node:assert/strict";
import { goalProblems, goalHint } from "../core/goalwords.js";

test("a plain one-sentence goal has no problems", () => {
  assert.deepEqual(goalProblems("Use omni instead of Herdr for daily work on the Mac, with omniloop running on it"), []);
  assert.deepEqual(goalProblems("Collapsible omniloop panel: a collapsed mode that keeps a thin strip with the for-you count, shipped to every machine"), []);
  assert.deepEqual(goalProblems(""), []);
  assert.equal(goalHint("Ship the panel"), null);
});

test("a goal written like notes is flagged for each problem", () => {
  const notes = "omni v1 (desktop): replace Herdr on the Mac for daily work, with omniloop running on omni as the priority "
    + "(job 5d plus omniloop's own backend switch). Native Rust workspace per .code-foundations/plans/2026-11-12-omni-v1.md "
    + "(amended by the 2026-11-13 speed review). Focus is the desktop app; Heel/phone (Phase 7) is parked.";
  const p = goalProblems(notes).join(" | ");
  for (const w of ["words", "file path", "internal numbers", "brackets", "several sentences"]) assert.match(p, new RegExp(w));
  assert.match(goalHint(notes, 2), /omniloop goal edit 2 "/);
});

test("each check on its own", () => {
  assert.match(goalProblems("Fix ~/repos/x so it builds").join(), /file path/);
  assert.match(goalProblems("Finish step 3 of the rollout").join(), /internal numbers/);
  assert.deepEqual(goalProblems("Make the panel readable at 1.2 zoom and/or 1.5"), []);
});
