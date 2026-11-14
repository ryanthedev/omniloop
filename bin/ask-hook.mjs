#!/usr/bin/env node
// Claude Code hook (Stop, UserPromptSubmit) for loop agents; inert in any other terminal. Labels only the terminal it runs in ($HC_TERMINAL_ID):
//   Stop:             omniloop.ask=1 when the agent's last message asks the user something, else removed.
//   UserPromptSubmit: omniloop.ask removed; and when a person typed the prompt (not another agent), omniloop.you=<now>,
//                     which the watcher reads as "you interacted" (SPEC.md, When you last interacted).
// Never blocks, prints nothing: every failure exits 0 silently. Text tests are in core/ask.js.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { addressOf, pidOf, foreign } from "../core/turns.js";
import { asksUser, lastAssistantText, isHumanPrompt, isLoopTerminal } from "../core/ask.js";

const quiet = () => process.exit(0);
process.on("uncaughtException", quiet);
try {
  const id = process.env.HC_TERMINAL_ID;
  if (!id) quiet();
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  // A nested `claude` inherits HC_TERMINAL_ID: when another live session already owns this terminal, say nothing
  // (the same rule as session-hook.mjs; its records are under $OMNILOOP_HOME/sessions).
  const address = addressOf(process.env, input.session_id);
  if (address) {
    let prev = null;
    try { prev = JSON.parse(readFileSync(join(process.env.OMNILOOP_HOME ?? join(homedir(), ".cache", "omniloop"), "sessions", `${address}.json`), "utf8")); } catch {}
    const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === "EPERM"; } };
    if (foreign(prev, { input, pid: pidOf(process.env, process.ppid) }, alive)) quiet();
  }
  // The plugin may be loaded by the user's own alias, in any Claude: only a loop agent's terminal (label `omniloop`)
  // gets labels. A failed or unreadable `hc get` counts as "not an agent".
  try {
    if (!isLoopTerminal(JSON.parse(execFileSync("hc", ["get", "--json", id], { timeout: 1500, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })))) quiet();
  } catch { quiet(); }
  const label = (...kv) => execFileSync("hc", ["label", id, ...kv], { stdio: "ignore", timeout: 2500 });
  if (input.hook_event_name === "Stop") {
    let text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    if (!text && input.transcript_path) text = lastAssistantText(readFileSync(input.transcript_path, "utf8"));
    label(`omniloop.ask=${asksUser(text) ? "1" : ""}`);
  } else if (input.hook_event_name === "UserPromptSubmit") {
    label("omniloop.ask=", ...(isHumanPrompt(input.prompt) ? [`omniloop.you=${Date.now()}`] : []));
  }
} catch {}
quiet();
