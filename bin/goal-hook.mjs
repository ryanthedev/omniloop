#!/usr/bin/env node
// Claude Code hook (SessionStart, UserPromptSubmit) for loop members: when the loop's goal changed since this
// session last saw it, print one line, which Claude Code adds to the agent's context. Otherwise print nothing,
// so an unchanged goal costs no tokens. Never blocks: every failure exits 0 silently.
//   Which loop: the terminal's omniloop label (HC_TERMINAL_ID), else a loop.json in the session's folder.
//   Seen: ~/.cache/omniloop/goal-seen/<session id> holds "<loop>:<goal rev>".
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const quiet = () => process.exit(0);
process.on("uncaughtException", quiet);
try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const sid = String(input.session_id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!sid) quiet();
  let loop = null;
  if (process.env.HC_TERMINAL_ID) {
    try {
      const t = JSON.parse(execFileSync("hc", ["get", "--json", process.env.HC_TERMINAL_ID], { timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      loop = t?.labels?.omniloop || null;
    } catch {}
  }
  const loopsDir = join(homedir(), "loops");
  let m = null;
  try { m = loop ? JSON.parse(readFileSync(join(loopsDir, loop, "loop.json"), "utf8")) : JSON.parse(readFileSync(join(input.cwd ?? ".", "loop.json"), "utf8")); } catch {}
  if (!m?.id) quiet();
  const home = join(loopsDir, m.id);
  const key = `${m.id}:${m.goalRev ?? 0}`;
  const dir = join(homedir(), ".cache", "omniloop", "goal-seen");
  let seen = null;
  try { seen = readFileSync(join(dir, sid), "utf8").trim(); } catch {}
  // A session that started in the loop folder read the goal in CLAUDE.md already.
  const readClaudeMd = input.cwd === home;
  const fresh = input.hook_event_name === "SessionStart" && input.source === "startup";
  let say = false;
  if (input.hook_event_name === "SessionStart" && !fresh) say = true;          // after /compact, resume, clear: remind
  else if (seen === null) say = !readClaudeMd;                                  // first sight: only if CLAUDE.md didn't say it
  else say = seen !== key;                                                      // changed since last seen
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sid), key);
  if (!say) quiet();
  const { goalNote } = await import("../core/goals.js");
  process.stdout.write(goalNote(m, m.id) + "\n");
} catch {}
quiet();
