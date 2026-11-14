import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProjects, strongMatches, addProject, projectLaunch, withProjectsBlock, PROJECTS_START, PROJECTS_END } from "../core/projects.js";
import { claudeMd, newManifest, agentArgv } from "../core/loopdir.js";

const study = { name: "study", triggers: { words: ["reel", "podcast", "test me"], urls: ["instagram.com", "youtu.be"] } };
const booking = { name: "booking", triggers: { words: ["pnr", "fare", "booking"], urls: [] } };

test("matchProjects: urls count double, whole words only, best first", () => {
  const m = matchProjects([booking, study], "study this https://www.instagram.com/reel/abc and test me");
  assert.deepEqual(m.map((x) => x.name), ["study"]);
  assert.equal(m[0].score, 2 + 1 + 1); // instagram.com, reel, test me
  assert.deepEqual(matchProjects([booking, study], "the fareless reels"), []); // no partial words
  assert.deepEqual(matchProjects([booking, study], "PNR fare bug").map((x) => x.name), ["booking"]);
  assert.deepEqual(matchProjects([booking, study], ""), []);
});

test("strongMatches: a link or two words pre-tick; one stray word doesn't", () => {
  assert.deepEqual(strongMatches(matchProjects([study], "fix the reel component")), []);
  assert.deepEqual(strongMatches(matchProjects([study], "https://youtu.be/x")).map((m) => m.name), ["study"]);
  assert.deepEqual(strongMatches(matchProjects([study], "make a podcast reel")).map((m) => m.name), ["study"]);
});

test("addProject adds once", () => {
  const m = newManifest({ id: "a" });
  const m1 = addProject(m, "study");
  assert.deepEqual(m1.projects, ["study"]);
  assert.equal(addProject(m1, "study"), m1);
});

test("projectLaunch: plugin dirs in order, repos once, missing projects reported", () => {
  const m = { projects: ["study", "booking", "gone"] };
  const r = projectLaunch(m, [
    { name: "booking", dir: "/p/booking", repos: ["/r/a", "/r/b"] },
    { name: "study", dir: "/p/study", repos: ["/r/a"] },
  ]);
  assert.deepEqual(r, { pluginDirs: ["/p/study", "/p/booking"], dirs: ["/r/a", "/r/b"], missing: ["gone"] });
  assert.deepEqual(projectLaunch({}, []), { pluginDirs: [], dirs: [], missing: [] });
});

test("withProjectsBlock: inserted after the context block, then replaced in place", () => {
  const md = claudeMd(newManifest({ id: "x", goal: "g" }));
  const one = withProjectsBlock(md, [{ name: "study", text: "## Study project\nhello\n" }]);
  assert.ok(one.indexOf(PROJECTS_START) > one.indexOf("<!-- /omniloop:context -->"));
  assert.ok(one.indexOf(PROJECTS_START) < one.indexOf("## Memory"));
  assert.match(one, /## Study project\nhello\n<!-- \/omniloop:projects -->/);
  const two = withProjectsBlock(one + "\n## Mine\nkeep\n", [{ name: "study", text: "## Study project\nchanged" }]);
  assert.equal(two.split(PROJECTS_START).length, 2);
  assert.match(two, /changed/);
  assert.doesNotMatch(two, /hello/);
  assert.match(two, /## Mine\nkeep/);
  assert.match(withProjectsBlock("plain", []), new RegExp(`plain\\n\\n${PROJECTS_START}\\n${PROJECTS_END}`));
});

test("agentArgv: --plugin-dir per project, before the variadic --add-dir", () => {
  const a = agentArgv({ claudeArgv: ["claude", "--x"], dirs: ["/d"], task: "go", pluginDirs: ["/p/study", "/p/b"] });
  const argv = a.slice(4);
  assert.deepEqual(argv, ["claude", "go", "--x", "--plugin-dir", "/p/study", "--plugin-dir", "/p/b", "--add-dir", "/d"]);
});
