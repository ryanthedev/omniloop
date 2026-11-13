import { test } from "node:test";
import assert from "node:assert/strict";
import { asksUser, lastAssistantText, isHumanPrompt } from "../core/ask.js";

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
