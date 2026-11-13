#!/usr/bin/env node
// Claude Code hook (Stop, UserPromptSubmit) for loop members. Labels only the terminal it runs in ($HC_TERMINAL_ID):
//   Stop:             omniloop.ask=1 when the agent's last message asks the user something, else removed.
//   UserPromptSubmit: omniloop.ask removed; and when a person typed the prompt (not another agent), omniloop.you=<now>,
//                     which the watcher reads as "you interacted" (SPEC.md, When you last interacted).
// Never blocks, prints nothing: every failure exits 0 silently. Text tests are in core/ask.js.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { asksUser, lastAssistantText, isHumanPrompt } from "../core/ask.js";

const quiet = () => process.exit(0);
process.on("uncaughtException", quiet);
try {
  const id = process.env.HC_TERMINAL_ID;
  if (!id) quiet();
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const label = (...kv) => execFileSync("hc", ["label", id, ...kv], { stdio: "ignore", timeout: 4000 });
  if (input.hook_event_name === "Stop") {
    let text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    if (!text && input.transcript_path) text = lastAssistantText(readFileSync(input.transcript_path, "utf8"));
    label(`omniloop.ask=${asksUser(text) ? "1" : ""}`);
  } else if (input.hook_event_name === "UserPromptSubmit") {
    label("omniloop.ask=", ...(isHumanPrompt(input.prompt) ? [`omniloop.you=${Date.now()}`] : []));
  }
} catch {}
quiet();
