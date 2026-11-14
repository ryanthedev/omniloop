import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { asksUser, lastAssistantText, isHumanPrompt, isLoopTerminal } from "../core/ask.js";
import { goalNote, setGoal } from "../core/goals.js";
import { taskNote } from "../core/tasks.js";
import { initState, step } from "../core/watch.js";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ask-hook.mjs");

test("asksUser: a question mark ending one of the last lines", () => {
  assert.equal(asksUser("Done.\n\nWhich option do you want?"), true);
  assert.equal(asksUser("Should I go on?\n\nI'll wait."), true);
  assert.equal(asksUser("Shall I proceed? **(yes/no)**"), false); // question not at the end
  assert.equal(asksUser("Ready for review. Want me to merge?**"), true);
  assert.equal(asksUser("Is this ok? (yes)"), false);
  assert.equal(asksUser("All done, tests pass."), false);
  assert.equal(asksUser("Why does it fail?\na\nb\nc\nd"), false); // too far up
  assert.equal(asksUser(""), false);
  assert.equal(asksUser(null), false);
});

test("asksUser: 'What you need to do' in bold or plain", () => {
  assert.equal(asksUser("Built.\n\n**What you need to do:** run the installer.\nThen restart.\nThanks\nBye"), true);
  assert.equal(asksUser("What you need to do\n1. log in\n2. paste the key\n3. done\n4. ok"), true);
  assert.equal(asksUser("**What you need to do**\nlogin"), true);
  assert.equal(asksUser("Notes on what you need to do later"), false);
});

test("lastAssistantText: last assistant message with text, skipping tool-only ones", () => {
  const j = [
    { type: "user", message: { content: "hi" } },
    { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "final?" }, { type: "tool_use", name: "x" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "y" }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\nnot json";
  assert.equal(lastAssistantText(j), "final?");
  assert.equal(lastAssistantText(""), "");
  assert.equal(lastAssistantText(JSON.stringify({ type: "assistant", message: { content: "plain" } })), "plain");
});

test("isHumanPrompt: not empty, not an agent's message", () => {
  assert.equal(isHumanPrompt("fix the bug"), true);
  assert.equal(isHumanPrompt(""), false);
  assert.equal(isHumanPrompt("   "), false);
  assert.equal(isHumanPrompt(undefined), false);
  assert.equal(isHumanPrompt('<hc from="t3">hi</hc>'), false);
  assert.equal(isHumanPrompt("<cross-session-message from=x>"), false);
  assert.equal(isHumanPrompt("Another Claude session sent a message: hi"), false);
  assert.equal(isHumanPrompt("  <hc from=t1 ..."), false);
});

test("isHumanPrompt: omniloop's own typed notes are not you (goal note, task note, the watcher's note)", () => {
  const goal = goalNote(setGoal({}, "ship it", 0).manifest, "L");
  assert.match(goal, /^omniloop:/);
  assert.equal(isHumanPrompt(goal), false);
  assert.equal(isHumanPrompt(goalNote({}, "L")), false);
  const task = taskNote({ n: 1, by: "t1", text: "do x" }, "L");
  assert.match(task, /^omniloop:/);
  assert.equal(isHumanPrompt(task), false);
  // The watcher's own send: an agent finishes, the idle coordinator is typed a note.
  const T = (address, status, labels, extra = {}) => ({ address, state: "live", status: { state: status }, labels: { omniloop: "L", ...labels }, created_ms: 0, ...extra });
  const before = [T("t1", "idle", { "omniloop.coordinator": "1" }), T("t2", "working", { "omniloop.to": "t1" }, { turn: 1 })];
  const after = [before[0], { ...before[1], status: { state: "done" }, turn: 2 }];
  const r = step(initState(before, 0), after, 1);
  const send = r.actions.find((a) => a.type === "send");
  assert.ok(send, "the watcher sends a note");
  assert.match(send.text, /^omniloop:/);
  assert.equal(isHumanPrompt(send.text), false);
  assert.equal(isHumanPrompt("  omniloop: x"), false);
  assert.equal(isHumanPrompt("omniloop is great"), true); // a person's words, no colon
});

// ---- the hook itself, with a fake hc first on PATH ----

const AGENT = JSON.stringify({ labels: { omniloop: "L" } });
function rig(fn) {
  const dir = mkdtempSync(join(tmpdir(), "askhook-"));
  const bin = join(dir, "bin"), calls = join(dir, "calls"), home = join(dir, "home");
  mkdirSync(bin);
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nif [ "$1" = get ]; then printf '%s\\n' "$*" >> "${calls}.get"; printf '%s' "$HC_FAKE_GET"; exit 0; fi\nprintf '%s\\n' "$*" >> "${calls}"\n`);
  chmodSync(join(bin, "hc"), 0o755);
  const run = (input, env = {}) => spawnSync("node", [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OMNILOOP_HOME: home, HC_TERMINAL_ID: "t9", HC_FAKE_GET: AGENT, ...env } });
  const seen = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
  try { return fn({ run, seen, home, calls }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const stop = (text) => ({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: text });
const prompt = (p) => ({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: p });

test("ask-hook Stop: a question sets omniloop.ask=1, anything else removes it", () => rig(({ run, seen }) => {
  const r = run(stop("Which one do you want?"));
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  run(stop("All done."));
  assert.deepEqual(seen(), ["label t9 omniloop.ask=1", "label t9 omniloop.ask="]);
}));

test("ask-hook Stop: reads the last assistant message from the transcript when the input has none", () => rig(({ run, seen, home }) => {
  mkdirSync(home, { recursive: true });
  const f = join(home, "t.jsonl");
  writeFileSync(f, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Proceed?" }] } }) + "\n");
  run({ hook_event_name: "Stop", session_id: "s1", transcript_path: f });
  assert.deepEqual(seen(), ["label t9 omniloop.ask=1"]);
}));

test("ask-hook UserPromptSubmit: a human prompt sets omniloop.you and removes ask", () => rig(({ run, seen }) => {
  const t0 = Date.now();
  run(prompt("please fix the bug"));
  const [c] = seen();
  const m = c.match(/^label t9 omniloop\.ask= omniloop\.you=(\d+)$/);
  assert.ok(m, c);
  assert.ok(+m[1] >= t0 && +m[1] <= Date.now());
}));

test("ask-hook UserPromptSubmit: omniloop notes, hc notes and cross-session messages do not set omniloop.you", () => rig(({ run, seen }) => {
  for (const p of [taskNote({ n: 1, by: "t1", text: "x" }, "L"), "omniloop: t2 finished its turn", '<hc from="t3">hi</hc>', "<cross-session-message from=x>", "Another Claude session sent a message: hi", ""])
    run(prompt(p));
  assert.ok(seen().length > 0 && seen().every((c) => c === "label t9 omniloop.ask="), seen().join("|"));
}));

test("ask-hook: no HC_TERMINAL_ID means no hc call; garbage stdin exits 0 silently", () => rig(({ run, seen }) => {
  const r = run(stop("Why?"), { HC_TERMINAL_ID: "" });
  assert.equal(r.status, 0);
  assert.deepEqual(seen(), []);
  const g = run("not json");
  assert.equal(g.status, 0); assert.equal(g.stdout, ""); assert.equal(g.stderr, "");
}));

test("ask-hook: a nested claude (another live session owns the terminal) labels nothing", () => rig(({ run, seen, home }) => {
  mkdirSync(join(home, "sessions"), { recursive: true });
  // The owner: a different session, a different pid that is alive (this test process).
  writeFileSync(join(home, "sessions", "t9.json"), JSON.stringify({ address: "t9", pid: process.pid, sessionId: "other" }));
  run(stop("Why?"), { CLAUDE_PID: "1" });
  run(prompt("hello"), { CLAUDE_PID: "1" });
  assert.deepEqual(seen(), []);
  // The same session is not foreign.
  writeFileSync(join(home, "sessions", "t9.json"), JSON.stringify({ address: "t9", pid: process.pid, sessionId: "s1" }));
  run(stop("Why?"), { CLAUDE_PID: "1" });
  assert.deepEqual(seen(), ["label t9 omniloop.ask=1"]);
}));

test("isLoopTerminal: only a non-empty omniloop label counts", () => {
  assert.equal(isLoopTerminal({ labels: { omniloop: "me/loop" } }), true);
  for (const t of [{ labels: {} }, { labels: { omniloop: "" } }, { labels: { "omniloop.ask": "1" } }, {}, null, undefined, { labels: { omniloop: 1 } }])
    assert.equal(isLoopTerminal(t), false);
});

test("ask-hook: outside a loop (no omniloop label, hc get fails or is garbage) it labels nothing and prints nothing", () => rig(({ run, seen }) => {
  for (const get of [JSON.stringify({ labels: { foo: "x" } }), "{}", "", "not json"])
    for (const input of [stop("Why?"), prompt("hello")]) {
      const r = run(input, { HC_FAKE_GET: get });
      assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
    }
  assert.deepEqual(seen(), []);
}));

test("ask-hook: a hand-started Claude in a loop terminal (labelled, no prior session record) still sets omniloop.you", () => rig(({ run, seen, calls }) => {
  run(prompt("hello"), { HC_FAKE_GET: JSON.stringify({ labels: { omniloop: "m/loop", "omniloop.coordinator": "1" } }) });
  assert.match(seen()[0], /^label t9 omniloop\.ask= omniloop\.you=\d+$/);
  assert.equal(readFileSync(`${calls}.get`, "utf8").trim(), "get --json t9");
}));

test("goal-hook: outside a loop (unlabelled terminal, no loop.json) prints nothing and writes nothing", () => rig(({ run, calls }) => {
  const home = mkdtempSync(join(tmpdir(), "goalhome-"));
  try {
    const r = spawnSync("node", [HOOK.replace("ask-hook", "goal-hook")], { cwd: home, encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: home }),
      env: { ...process.env, HOME: home, PATH: `${dirname(calls)}/bin:${process.env.PATH}`, HC_TERMINAL_ID: "t9", HC_FAKE_GET: "{}" } });
    assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
    assert.equal(existsSync(join(home, ".cache")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test("ask-hook: a hanging `hc get` is cut off within the hook's budget; exit 0, no output, no label", () => rig(({ run, seen, calls }) => {
  const bin = join(dirname(calls), "bin");
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nif [ "$1" = get ]; then sleep 10; fi\nprintf '%s\\n' "$*" >> "${calls}"\n`);
  const t0 = Date.now();
  const r = run(prompt("hello"));
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  assert.ok(Date.now() - t0 < 4000, "took too long");
  assert.deepEqual(seen(), []);
}));
