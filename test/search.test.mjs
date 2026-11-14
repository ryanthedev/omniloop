import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenScore, fuzzyFields, snippet } from "../core/fuzzy.js";
import { sanitizePins, togglePin, movePin, slotOf, pinTo, pinnedSlots, MAX_PINS } from "../core/pins.js";
import { cleanId, uniqueId, checkProposal, fallbackProposal, proposeArgs, PROPOSE_SYSTEM } from "../core/intake.js";
import { loopEntries, pickerRows, entryMatch, suggestLoops, folderRows, projectRows, splitMachine, onMachine, LOCAL_NAME } from "../core/picker.js";

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
  assert.deepEqual(togglePin(p, "a").pins, [null, "ska/b"]);   // slot 2 stays 2
  const full = Array.from({ length: MAX_PINS }, (_, i) => `l${i}`);
  assert.equal(togglePin(full, "x").full, true);
  assert.deepEqual(sanitizePins(["a", "a", 3, "", "b"]), ["a", null, null, null, "b"]);
  assert.deepEqual(sanitizePins(["a", null, "b", null, null]), ["a", null, "b"]);
  assert.deepEqual(sanitizePins(null), []);
});

test("pins: slots are fixed; unpin leaves a hole and a new pin takes the lowest empty slot", () => {
  let p = ["a", "b", "c", "d"];
  p = togglePin(p, "a").pins;
  assert.deepEqual(p, [null, "b", "c", "d"]);
  assert.equal(slotOf(p, "d"), 4);                       // the leader's slot 4 still jumps to d
  const t = togglePin(p, "e");
  assert.equal(t.slot, 1);
  assert.deepEqual(t.pins, ["e", "b", "c", "d"]);
  assert.deepEqual(togglePin(["a", "b"], "b").pins, ["a"]); // no empty slots at the end
  assert.deepEqual(pinnedSlots([null, "b", null, "d"]), [{ key: "b", slot: 2 }, { key: "d", slot: 4 }]);
});

test("pins: ⌘<n> puts a loop in slot n; the one there swaps or takes the lowest empty slot", () => {
  assert.deepEqual(pinTo(["a", "b", "c"], "c", 1), { pins: ["c", "b", "a"], moved: { key: "a", slot: 3 } });
  assert.deepEqual(pinTo(["a", null, "c"], "x", 3), { pins: ["a", "c", "x"], moved: { key: "c", slot: 2 } });
  assert.deepEqual(pinTo(["a"], "x", 5), { pins: ["a", null, null, null, "x"], moved: null });
  assert.deepEqual(pinTo(["a", "b"], "a", 1), { pins: ["a", "b"], moved: null });
  const full = Array.from({ length: MAX_PINS }, (_, i) => `l${i}`);
  assert.deepEqual(pinTo(full, "x", 2).moved, { key: "l1", slot: null });  // nowhere to go: unpinned
  assert.deepEqual(pinTo(["a"], "x", 0).pins, ["a"]);
});

test("pins: moving swaps with the next slot, empty ones included", () => {
  assert.deepEqual(movePin([null, "b"], "b", -1), ["b"]);
  assert.deepEqual(movePin(["a"], "a", 1), [null, "a"]);
  assert.deepEqual(movePin(["a"], "a", -1), ["a"]);
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
  { id: "omniloop", goal: "Build omniloop", coordinator: "t1", needsYou: 0, lastWithYou: 300, ago: "5m", rows: [{ address: "t1", name: "coordinator" }] },
  { id: "ska/remote-x", goal: "Remote work", coordinator: "ska/t2", needsYou: 1, lastWithYou: 100, rows: [{ address: "ska/t2", name: "coordinator" }] },
];
const index = [
  { id: "omniloop", goal: "Build omniloop", dirs: ["/r/omniloop"], projects: [], tasks: ["write the spec"], feed: ["shipped the watcher"], touched: 50 },
  { id: "plenary-m2", goal: "Ship Plenary M2", dirs: ["/r/plenary"], projects: ["study"], tasks: [], feed: ["the parser is flaky"], touched: 900 },
  { id: "old", goal: "Old idea", dirs: [], projects: [], tasks: [], feed: [], touched: 10 },
];

test("loopEntries: a pin whose loop isn't found still shows, at its slot, so you can unpin it", () => {
  const e = loopEntries([], [{ id: "here", goal: "g" }], [null, "vana/gone", "here", "old-local"], undefined, { indexLoaded: true });
  const by = Object.fromEntries(e.map((x) => [x.key, x]));
  assert.equal(by["here"].pin, 3);
  assert.equal(by["here"].stale, undefined);
  assert.deepEqual([by["vana/gone"].pin, by["vana/gone"].stale, by["vana/gone"].machine, by["vana/gone"].id], [2, true, "vana", "gone"]);
  assert.deepEqual([by["old-local"].pin, by["old-local"].stale, by["old-local"].machine], [4, true, null]);
  assert.deepEqual(pickerRows(e, "").filter((r) => r.kind === "loop").map((r) => r.entry.key), ["vana/gone", "here", "old-local"]);
});

test("loopEntries: before the index loads, a pinned local loop is a quiet placeholder, not stale; remote keys may be stale", () => {
  const pins = ["idle-one", "vana/gone"];
  const by = (e) => Object.fromEntries(e.map((x) => [x.key, x]));
  let e = by(loopEntries([], [], pins));
  assert.deepEqual([e["idle-one"].placeholder, e["idle-one"].stale, e["idle-one"].pin], ["loading", undefined, 1]);
  assert.deepEqual([e["vana/gone"].stale, e["vana/gone"].placeholder], [true, undefined]);
  e = by(loopEntries([], [], pins, undefined, { indexFailed: true }));
  assert.deepEqual([e["idle-one"].placeholder, e["idle-one"].stale], ["unreadable", undefined]);
  // Once loaded, an idle pinned loop that is in the index is a normal entry; one that isn't is stale.
  e = by(loopEntries([], [{ id: "idle-one", goal: "g" }], ["idle-one", "nope"], undefined, { indexLoaded: true }));
  assert.deepEqual([e["idle-one"].stale, e["idle-one"].placeholder, e["nope"].stale], [undefined, undefined, true]);
});

test("stale entries aren't taken ids and aren't suggested", () => {
  const e = loopEntries([], [{ id: "real", goal: "build the parser", dirs: [], projects: [] }], ["parser-gone", "vana/parser-x"], undefined, { indexLoaded: true });
  assert.ok(e.find((x) => x.key === "parser-gone").stale);
  const fresh = pickerRows(e, "parser gone").at(-1);
  assert.equal(fresh.id, "parser-gone"); // the removed loop's name is free again
  assert.deepEqual(suggestLoops(e, "parser-gone parser").map((x) => x.key), ["real"]);
  const loading = loopEntries([], [], ["parser-gone"]);
  assert.deepEqual(suggestLoops(loading, "parser-gone"), []);
});

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

test("identity guard (code, not prompt): a goal naming this computer or its person falls back to the typed text", async () => {
  const { identityTerms, identityLeak } = await import("../core/intake.js");
  const id = identityTerms({ names: ["Pat Example"], emails: ["pat@example.dev"], user: "pat", host: "pats-mbp.local", home: "/Users/pat", machines: ["ska", "vana"] });
  assert.ok(id.has("pat") && id.has("example") && id.has("ska") && id.has("mbp") && !id.has("users") && !id.has("dev"));
  const req = "fix the login timeout";
  const leak = checkProposal({ structured_output: { id: "fix-login", goal: "Fix the login timeout Pat reported." } }, req, [], { identity: id });
  assert.deepEqual(leak, { id: "fix-login-timeout", goal: "fix the login timeout", source: "typed" });
  assert.equal(checkProposal({ structured_output: { id: "ska-login", goal: "Fix the login timeout." } }, req, [], { identity: id }).source, "typed");
  // A word the person typed themselves is theirs to send.
  assert.equal(identityLeak({ id: "deploy-to-ska", goal: "Deploy to ska." }, "deploy to ska", id), null);
  assert.equal(checkProposal({ structured_output: { id: "fix-login", goal: "Fix the login timeout." } }, req, [], { identity: id }).source, "model");
});

test("person guard: 'the user', he/she in a goal the request didn't use falls back", async () => {
  const { personLeak } = await import("../core/intake.js");
  assert.equal(personLeak("Remember the last machine the user selected.", "remember the last machine i used"), "user");
  assert.equal(personLeak("Fix the bug he found.", "fix the bug"), "he");
  assert.equal(personLeak("Plan their trip.", "plan their trip"), null);
  assert.equal(checkProposal({ structured_output: { id: "x-y", goal: "Fix what the user saw." } }, "fix what i saw").source, "typed");
});

// ---- machine chip, search and @filter ----

const mk = () => loopEntries(
  [{ id: "plenary", goal: "ship", rows: [] }, { id: "ska/plenary-ska", goal: "remote one", rows: [] }, { id: "vana/other", goal: "x", rows: [] }],
  [{ id: "plenary", goal: "ship" }, { id: "idle-one", goal: "nobody here" }]);

test("machine: every entry has a chip name; this computer's is 'this computer' unless named", () => {
  const es = mk();
  assert.deepEqual(es.map((e) => [e.key, e.where]), [["plenary", LOCAL_NAME], ["ska/plenary-ska", "ska"], ["vana/other", "vana"], ["idle-one", LOCAL_NAME]]);
  assert.equal(LOCAL_NAME, "this computer");
  assert.equal(loopEntries([{ id: "a", rows: [] }], [], [], "mymac")[0].where, "mymac");
  assert.equal(es[1].machine, "ska"); // machine itself unchanged: null here, the name there
  assert.equal(es[0].machine, null);
});

test("machine: typing the machine name lists its loops", () => {
  const keys = (q) => pickerRows(mk(), q).filter((r) => r.kind === "loop").map((r) => r.entry.key);
  assert.deepEqual(keys("ska"), ["ska/plenary-ska"]);
  assert.ok(entryMatch(mk()[1], "ska"));
});

test("splitMachine: @name is pulled out; a lone @ is no filter", () => {
  assert.deepEqual(splitMachine("@ska plenary"), { machine: "ska", rest: "plenary" });
  assert.deepEqual(splitMachine("plenary @SKA"), { machine: "ska", rest: "plenary" });
  assert.deepEqual(splitMachine("@"), { machine: null, rest: "" });
  assert.deepEqual(splitMachine("@ plenary"), { machine: null, rest: "plenary" });
  assert.deepEqual(splitMachine(""), { machine: null, rest: "" });
});

test("@filter: keeps only that machine's loops, then the rest searches as usual", () => {
  const keys = (q, es = mk()) => pickerRows(es, q).filter((r) => r.kind === "loop").map((r) => r.entry.key);
  assert.deepEqual(keys("@ska"), ["ska/plenary-ska"]);
  assert.deepEqual(keys("@ska plenary"), ["ska/plenary-ska"]);
  assert.deepEqual(keys("@ska other"), []);
  assert.deepEqual(keys("@here").sort(), ["idle-one", "plenary"]);
  assert.deepEqual(keys("@local plenary"), ["plenary"]);
  assert.deepEqual(keys("@this plenary"), ["plenary"]);
  assert.deepEqual(keys("@nope"), []);
  assert.equal(keys("@").length, 4); // no filter
  const named = loopEntries([], [{ id: "x", goal: "" }], [], "mymac");
  assert.deepEqual(keys("@mymac", named), ["x"]);
  assert.ok(onMachine(named[0], "here") && !onMachine(named[0], "ska"));
});

test("@filter: the new-loop row carries only the words after the @token", () => {
  const rows = pickerRows(mk(), "@ska zebra");
  assert.deepEqual(rows.map((r) => r.kind), ["new"]);
  assert.equal(rows[0].goal, "zebra");
});

test("screenLines: strips ANSI and '[hc] ' notices, trailing blanks, keeps the last n; screenLabel names a real coordinator only", async () => {
  const { screenLines, screenLabel } = await import("../core/picker.js");
  assert.deepEqual(screenLines("[hc] note\n\x1b[1mone\x1b[0m  \ntwo\n\n\n"), ["one", "two"]);
  assert.deepEqual(screenLines("a\nb\nc\nd", 2), ["c", "d"]);
  assert.equal(screenLabel(true, "t1"), "COORDINATOR'S SCREEN");
  assert.equal(screenLabel(false, "t1"), "SCREEN · t1");
});
