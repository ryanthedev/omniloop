#!/usr/bin/env node
// Claude Code hook (SessionStart, UserPromptSubmit, Stop, PostToolUse:Bash): keeps two small records per session
// under $OMNILOOP_HOME (default ~/.cache/omniloop), so omniloop can address a session and say what its last turn
// was. sessions/<address>.json: who it is. turns/<address>.json: when its turn began and ended, what it said,
// and whether it already messaged someone. Record logic is in core/turns.js.
// Never blocks, prints nothing: every failure exits 0 silently.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressOf, pidOf, sessionRecord, turnStart, turnEnd, turnReport, foreign } from "../core/turns.js";

// The last entries of a transcript (its tail only: transcripts grow large). [] when it can't be read.
const tail = (p, max = 256 * 1024) => {
  let fd;
  try {
    fd = openSync(p, "r");
    const { size } = fstatSync(fd), len = Math.min(size, max), b = Buffer.alloc(len);
    readSync(fd, b, 0, len, size - len);
    return b.toString("utf8").split("\n").slice(size > len ? 1 : 0).flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  } catch { return []; } finally { if (fd != null) try { closeSync(fd); } catch {} }
};

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
    // Who gave this turn (a peer, an agent's typed note, or a person): the watcher relays only work it was given.
    const entries = typeof input.transcript_path === "string" ? tail(input.transcript_path) : null;
    write(turns, address, turnEnd(read(join(turns, `${address}.json`)), { ...ctx, entries }));
  } else if (ev === "PostToolUse") {
    const next = turnReport(read(join(turns, `${address}.json`)) ?? { address }, ctx);
    if (next) write(turns, address, next);
  }
} catch {}
quiet();
