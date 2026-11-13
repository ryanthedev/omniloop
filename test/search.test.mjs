import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenScore, fuzzyFields, snippet } from "../core/fuzzy.js";
import { sanitizePins, togglePin, movePin, slotOf, MAX_PINS } from "../core/pins.js";
import { cleanId, uniqueId, checkProposal, fallbackProposal, proposeArgs, PROPOSE_SYSTEM } from "../core/intake.js";
import { loopEntries, pickerRows, entryMatch, suggestLoops, folderRows, projectRows } from "../core/picker.js";

// ---- fuzzy ----

test("fuzzy: letters in order match short fields; substrings and word starts score higher", () => {
  assert.ok(tokenScore("omlp", "omniloop") > 0);
  assert.equal(tokenScore("pmo", "omniloop"), 0);
  assert.ok(tokenScore("loop", "omniloop") > tokenScore("olp", "omniloop"));
  assert.ok(tokenScore("intake", "omni loop intake") > tokenScore("ntak", "omni loop intake"));
});

test("fuzzy: long fields need a substring, so scattered letters in a chat line don't count", () => {
  assert.equal(tokenScore("xyz", "x marks the y of z", { subsequence: false }), 0);
  assert.ok(tokenScore("marks", "x marks the spot", { subsequence: false }) > 0);
});

test("fuzzyFields: every token must hit some field; reports the field of the best hit", () => {
  const f = [{ name: "id", text: "plenary-m2", weight: 3 }, { name: "task", text: ["deploy the parser"], long: true }];
  assert.equal(fuzzyFields("plen parser", f).field, "id");
  assert.equal(fuzzyFields("parser", f).field, "task");
  assert.equal(fuzzyFields("plen zebra", f), null);
});

test("snippet: short text whole, long text around the hit", () => {
  assert.equal(snippet("short", "x"), "short");
  const s = snippet("a ".repeat(60) + "needle here " + "b ".repeat(60), "needle", 30);
  assert.ok(s.includes("needle") && s.startsWith("…") && s.length <= 32);
});

// ---- pins ----

test("pins: toggle, order, cap, move, sanitize", () => {
  let p = [];
  ({ pins: p } = togglePin(p, "a")); ({ pins: p } = togglePin(p, "ska/b"));
  assert.deepEqual(p, ["a", "ska/b"]);
  assert.equal(slotOf(p, "ska/b"), 2);
  assert.deepEqual(movePin(p, "ska/b", -1), ["ska/b", "a"]);
  assert.deepEqual(movePin(p, "a", -1), p);
  assert.deepEqual(togglePin(p, "a").pins, ["ska/b"]);
  const full = Array.from({ length: MAX_PINS }, (_, i) => `l${i}`);
  assert.equal(togglePin(full, "x").full, true);
  assert.deepEqual(sanitizePins(["a", "a", 3, "", "b"]), ["a", "b"]);
  assert.deepEqual(sanitizePins(null), []);
});

// ---- intake (name + goal proposal) ----

test("cleanId / uniqueId", () => {
  assert.equal(cleanId("Fix Loop Intake!"), "fix-loop-intake");
  assert.equal(cleanId("---"), "");
  assert.ok(cleanId("a".repeat(50)).length <= 32);
  assert.equal(uniqueId("x", ["x", "x-2"]), "x-3");
});

test("checkProposal: takes a good answer, falls back on a bad one", () => {
  const ok = checkProposal({ structured_output: { id: "fix-intake", goal: "Fix  the intake flow." } }, "fix intake", ["fix-intake"]);
  assert.deepEqual(ok, { id: "fix-intake-2", goal: "Fix the intake flow.", source: "model" });
  assert.equal(checkProposal({ structured_output: { id: "!!", goal: "x" } }, "redo onboarding").source, "typed");
  assert.equal(checkProposal({ structured_output: { id: "a-b", goal: "Work in /private/tmp/x on it" } }, "a b").source, "typed");
  assert.equal(checkProposal(null, "redo onboarding").id, "redo-onboarding");
  assert.equal(fallbackProposal("  redo   onboarding ").goal, "redo onboarding");
});

test("proposeArgs: the model gets only the request, no tools or settings", () => {
  const a = proposeArgs("my request");
  assert.equal(a.at(-1), "my request");
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  assert.ok(a.includes("--no-session-persistence") && a.includes("--strict-mcp-config"));
  assert.ok(!/\/Users|~\//.test(PROPOSE_SYSTEM));
});

// ---- the ⌘O list ----

const view = [
  { id: "omniloop", goal: "Build omniloop", lead: "t1", needsYou: 0, lastWithYou: 300, ago: "5m", rows: [{ address: "t1", name: "lead" }] },
  { id: "ska/remote-x", goal: "Remote work", lead: "ska/t2", needsYou: 1, lastWithYou: 100, rows: [{ address: "ska/t2", name: "lead" }] },
];
const index = [
  { id: "omniloop", goal: "Build omniloop", dirs: ["/r/omniloop"], projects: [], tasks: ["write the spec"], feed: ["shipped the watcher"], touched: 50 },
  { id: "plenary-m2", goal: "Ship Plenary M2", dirs: ["/r/plenary"], projects: ["study"], tasks: [], feed: ["the parser is flaky"], touched: 900 },
  { id: "old", goal: "Old idea", dirs: [], projects: [], tasks: [], feed: [], touched: 10 },
];

test("loopEntries: running loops plus folders with nobody running; remote keys keep their machine", () => {
  const e = loopEntries(view, index, ["plenary-m2"]);
  assert.deepEqual(e.map((x) => [x.key, x.running]), [["omniloop", true], ["ska/remote-x", true], ["plenary-m2", false], ["old", false]]);
  assert.equal(e.find((x) => x.key === "ska/remote-x").machine, "ska");
  assert.deepEqual(e.find((x) => x.key === "omniloop").tasks, ["write the spec"]);
  assert.equal(e.find((x) => x.key === "plenary-m2").pin, 1);
});

test("pickerRows, no query: pins in slot order, then talked-to recency, then last changed", () => {
  const e = loopEntries(view, index, ["old", "plenary-m2"]);
  assert.deepEqual(pickerRows(e, "").filter((r) => r.kind === "loop").map((r) => r.entry.key), ["old", "plenary-m2", "omniloop", "ska/remote-x"]);
  assert.equal(pickerRows(e, "").at(-1).kind, "new");
});

test("pickerRows, query: fuzzy over everything, with a short why when the hit isn't the name or goal", () => {
  const e = loopEntries(view, index, []);
  const rows = (q) => pickerRows(e, q).filter((r) => r.kind === "loop");
  assert.equal(rows("omlp")[0].entry.key, "omniloop");
  assert.equal(rows("omlp")[0].why, null);
  assert.deepEqual(rows("flaky").map((r) => [r.entry.key, r.why]), [["plenary-m2", "chat: the parser is flaky"]]);
  assert.equal(rows("study")[0].why, "project: study");
  assert.equal(rows("spec")[0].why, "task: write the spec");
  assert.deepEqual(pickerRows(e, "zzqx").map((r) => r.kind), ["new"]);
  assert.equal(pickerRows(e, "omniloop thing").at(-1).id, "omniloop-thing");
});

test("entryMatch: the remote loop is found by its id without the machine", () => {
  const e = loopEntries(view, index, []);
  assert.ok(entryMatch(e.find((x) => x.key === "ska/remote-x"), "remote"));
});

test("suggestLoops: a goal sentence suggests loops sharing two meaningful words", () => {
  const e = loopEntries(view, index, []);
  assert.deepEqual(suggestLoops(e, "I want to ship the plenary release").map((x) => x.key), ["plenary-m2"]);
  assert.deepEqual(suggestLoops(e, "omniloop"), [e.find((x) => x.key === "omniloop")]);
  assert.deepEqual(suggestLoops(e, "bake bread tonight"), []);
  assert.deepEqual(suggestLoops(e, "the a to"), []);
});

test("folderRows / projectRows are fuzzy", () => {
  assert.deepEqual(folderRows(["/r/omniloop", "/r/plenary"], "omlp").map((r) => r.name), ["omniloop"]);
  assert.deepEqual(projectRows([{ name: "study", description: "" }], "sdy").map((r) => r.name), ["study"]);
});

test("a long goal doesn't match on scattered letters; snippets start on a word", () => {
  const e = loopEntries([], [{ id: "x", goal: "we orchestrate key tasks reliably every evening", dirs: [], projects: [], tasks: [], feed: [], touched: 1 }], []);
  assert.equal(pickerRows(e, "worktree").filter((r) => r.kind === "loop").length, 0);
  const s = snippet("alpha beta gamma delta epsilon zeta eta theta needle iota kappa lambda", "needle", 30);
  assert.ok(!/…[a-z]+a needle/.test(s) && s.includes("needle"));
  assert.match(s, /^… ?[a-z]/);
});

test("suggestLoops: one word that is exactly a loop's id or folder name is enough", () => {
  const e = loopEntries([], [
    { id: "omniloop", goal: "Build it", dirs: ["/r/omniloop"], projects: [], tasks: [], feed: [], touched: 1 },
    { id: "panel", goal: "The panel", dirs: ["/r/omniloop"], projects: [], tasks: [], feed: [], touched: 2 },
    { id: "other", goal: "Else", dirs: ["/r/else"], projects: [], tasks: [], feed: [], touched: 3 },
  ], []);
  assert.deepEqual(suggestLoops(e, "make the omniloop picker use worktrees for shared folders").map((x) => x.id), ["omniloop", "panel"]);
});
