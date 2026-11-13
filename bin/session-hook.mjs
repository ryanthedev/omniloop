#!/usr/bin/env node
// Claude Code hook (SessionStart, UserPromptSubmit, Stop, PostToolUse:Bash): keeps two small records per session
// under $OMNILOOP_HOME (default ~/.cache/omniloop), so omniloop can address a session and say what its last turn
// was. sessions/<address>.json: who it is. turns/<address>.json: when its turn began and ended, what it said,
// and whether it already messaged someone. Record logic is in core/turns.js.
// Never blocks, prints nothing: every failure exits 0 silently.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressOf, pidOf, sessionRecord, turnStart, turnEnd, turnReport, foreign } from "../core/turns.js";

const quiet = () => process.exit(0);
process.on("uncaughtException", quiet);

const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const write = (dir, address, rec) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${address}.json`), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, f);
};

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const address = addressOf(process.env, input.session_id);
  if (!address) quiet();
  const home = process.env.OMNILOOP_HOME ?? join(homedir(), ".cache", "omniloop");
  const sessions = join(home, "sessions"), turns = join(home, "turns");
  const now = Date.now(), pid = pidOf(process.env, process.ppid);
  const ctx = { address, pid, input, now };
  const ev = input.hook_event_name;
  const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  if (foreign(read(join(sessions, `${address}.json`)), ctx, alive)) quiet();
  if (ev === "SessionStart" || ev === "UserPromptSubmit") {
    write(sessions, address, sessionRecord(read(join(sessions, `${address}.json`)), ctx));
    if (ev === "UserPromptSubmit") write(turns, address, turnStart(read(join(turns, `${address}.json`)), ctx));
  } else if (ev === "Stop") {
    write(turns, address, turnEnd(read(join(turns, `${address}.json`)), ctx));
  } else if (ev === "PostToolUse") {
    const next = turnReport(read(join(turns, `${address}.json`)) ?? { address }, ctx);
    if (next) write(turns, address, next);
  }
} catch {}
quiet();
