// proc.mjs: the process transport the backend adapters take (so tests can hand them a fake). One small interface:
//   run(cmd, args, { timeoutMs, maxBuffer, env, cwd }) -> Promise<{ code, stdout, stderr, timedOut }>
//        resolves for ANY exit (code null on a timeout); rejects only when the program can't be started (ENOENT).
//   start(cmd, args, { env }) -> ChildProcess with stdout piped (a long-running reader, e.g. an event stream).
import { execFile, spawn } from "node:child_process";

export const nodeProc = {
  run(cmd, args, { timeoutMs = 0, maxBuffer = 64 << 20, env, cwd } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer, env, cwd, encoding: "utf8" }, (err, stdout, stderr) => {
        if (err && typeof err.code === "string") return reject(err); // ENOENT, EACCES...
        resolve({ code: err ? err.code ?? null : 0, stdout, stderr, timedOut: Boolean(err?.killed) });
      });
      child.stdin?.end();
    });
  },
  start(cmd, args, { env } = {}) { return spawn(cmd, args, { env, stdio: ["ignore", "pipe", "inherit"] }); },
};

/** An exit that is not 0 as an Error carrying stdout, stderr and code (what the CLI's die() prints). */
export function failure(what, r) {
  const text = (r.stderr || r.stdout || "").trim();
  return Object.assign(new Error(r.timedOut ? `${what} timed out` : `${what} exit ${r.code}${text ? `: ${text.split("\n")[0]}` : ""}`), { code: r.code, stdout: r.stdout, stderr: r.stderr });
}
