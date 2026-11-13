import { test } from "node:test";
import assert from "node:assert/strict";
import { matchScore, rank, slugify, askRows, folderRows, clampAt } from "../core/picker.js";
import { projectRows, linkTag } from "../core/picker.js";

const L = (id, goal, lastWithYou = null, names = []) => ({ id, goal, lastWithYou, needsYou: 0, rows: names.map((name) => ({ name })) });
const loops = [
  L("plenary-m2", "Ship Plenary M2", 100, ["parser manager"]),
  L("omniloop", "Build omniloop: manage work by loops", 300),
  L("sec-6096", "Fix the SEC-6096 auth bug", 200),
];

test("no query: most recently worked-in first", () => {
  assert.deepEqual(rank(loops, "").map((l) => l.id), ["omniloop", "sec-6096", "plenary-m2"]);
});

test("query: match first, every word must hit, recency breaks ties", () => {
  assert.deepEqual(rank(loops, "plen").map((l) => l.id), ["plenary-m2"]);
  assert.deepEqual(rank(loops, "parser").map((l) => l.id), ["plenary-m2"]);   // member names count
  assert.deepEqual(rank(loops, "auth bug").map((l) => l.id), ["sec-6096"]);
  assert.deepEqual(rank(loops, "zebra"), []);
  assert.ok(matchScore("ship", "Ship Plenary") > matchScore("shi", "Ship Plenary"));
});

test("slugify: meaningful words, unique", () => {
  assert.equal(slugify("I want to fix the login timeout on iOS"), "fix-login-timeout-ios");
  assert.equal(slugify("Ship Plenary M2", ["ship-plenary-m2"]), "ship-plenary-m2-2");
  assert.equal(slugify("!!!"), "loop");
});

test("askRows: loops then 'new'; only 'new' when nothing matches", () => {
  assert.deepEqual(askRows(loops, "plenary").map((r) => r.kind), ["loop", "new"]);
  const only = askRows(loops, "redesign the onboarding flow");
  assert.deepEqual(only, [{ kind: "new", id: "redesign-onboarding-flow", goal: "redesign the onboarding flow" }]);
  assert.equal(askRows(loops, "").at(-1).id, null);
});

test("folderRows: selected first, then matches", () => {
  const fs = ["/r/plenary", "/r/plenary-docs", "/r/omniloop", "/c/.config"];
  assert.deepEqual(folderRows(fs, "plen", ["/r/omniloop"]).map((r) => [r.name, r.on]), [["omniloop", true], ["plenary", false], ["plenary-docs", false]]);
  assert.equal(folderRows(fs, "").length, 4);
});

test("clampAt", () => {
  assert.equal(clampAt(5, 3), 2);
  assert.equal(clampAt(-1, 3), 0);
  assert.equal(clampAt(2, 0), 0);
});

test("projectRows: picked projects first, others only when the query matches", () => {
  const projects = [{ name: "study", description: "decks and tests from media" }, { name: "booking", description: "PNRs and fares" }];
  assert.deepEqual(projectRows(projects, "", ["study"]).map((r) => [r.name, r.on]), [["study", true], ["booking", false]]);
  assert.deepEqual(projectRows(projects, "pnr", ["study"]).map((r) => [r.name, r.on]), [["study", true], ["booking", false]]);
  assert.deepEqual(projectRows(projects, "zzz", []).map((r) => r.name), []);
});

test("slugify names links by platform and id", () => {
  assert.equal(linkTag("https://www.instagram.com/reel/DgX1abc/?igsh=xyz"), "reel DgX1abc");
  assert.equal(linkTag("https://youtu.be/dQw4w9WgXcQ?t=3"), "yt dQw4w9WgXcQ");
  assert.equal(linkTag("https://www.youtube.com/watch?v=abc123&t=9"), "yt abc123");
  assert.equal(linkTag("https://www.youtube.com/shorts/xyz9"), "yt xyz9");
  assert.equal(linkTag("not a url"), "");
  assert.equal(slugify("study this https://www.instagram.com/reel/DgX1abc/?igsh=xyz", []), "study-reel-dgx1abc");
  assert.equal(slugify("https://youtu.be/dQw4w9WgXcQ", []), "yt-dqw4w9wgxcq");
});

import { machineRows, newLoopCommand, leadAddress } from "../core/picker.js";

test("a computer that sees no other machines gets no machine rows; one that does picks here or there", () => {
  assert.deepEqual(machineRows([], null), []);
  const rows = machineRows(["m1", "m2"], "m2");
  assert.deepEqual(rows.map((r) => [r.name, r.label, r.on]), [[null, "this computer", false], ["m1", "m1", false], ["m2", "m2", true]]);
});

test("a new loop on another machine runs that machine's own omniloop, passing only the goal and its own folders", () => {
  const here = newLoopCommand({ id: "x", goal: "do it", projects: ["p"], dirs: ["/h/repos/a"], bin: "/b", hc: "/hc" });
  assert.deepEqual(here, { cmd: "/b/omniloop", args: ["new", "x", "--goal", "do it", "--project", "p", "--dir", "/h/repos/a"] });
  const there = newLoopCommand({ machine: "m1", id: "x", goal: "do it", dirs: ["/r/repos/a"], bin: "/b", hc: "/hc" });
  assert.equal(there.cmd, "/hc");
  assert.deepEqual(there.args.slice(0, 4), ["exec", "--on", "m1", "--"]);
  assert.deepEqual(there.args.slice(-6), ["new", "x", "--goal", "do it", "--dir", "/r/repos/a"]);
  assert.ok(!there.args.includes("/b"), "this computer's paths stay here");
});

test("the lead's address from omniloop new's output, qualified by machine when it's elsewhere", () => {
  const out = "loop x: /h/loops/x (0 context folders)\nlead t7 in space x\n";
  assert.equal(leadAddress(out), "t7");
  assert.equal(leadAddress(out, "m1"), "m1/t7");
  assert.equal(leadAddress("nothing"), null);
});
