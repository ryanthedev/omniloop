// harness-apply.mjs: write core/harness.js's files into a loop folder, and keep the user-global Codex trust entry.
// `userHome` is injected (never read from the environment here), so tests use a temporary one.
// Everything returns short lines for the command's output; nothing throws for a harness problem.

import { mkdir, readFile, writeFile, rename, rm, lstat, readlink, symlink, stat, chmod, realpath } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { HARNESSES, harnessFiles } from "../../core/harness.js";

const read = (p) => readFile(p, "utf8").catch(() => null);

/** Where a write to `path` lands: through a symlink (say into a dotfiles repo) to its target, even a dangling one. */
async function writeTarget(path) {
  try { return await realpath(path); } catch {}
  const st = await lstat(path).catch(() => null);
  return st?.isSymbolicLink() ? resolve(dirname(path), await readlink(path)) : path;
}

/** Write temp file + rename, so a reader never sees half a file; keeps the old file's mode and writes through a link. */
export async function writeAtomic(path, text) {
  const target = await writeTarget(path);
  const mode = (await stat(target).catch(() => null))?.mode;
  const tmp = `${target}.omniloop-${process.pid}.tmp`;
  await writeFile(tmp, text);
  if (mode != null) await chmod(tmp, mode & 0o777);
  await rename(tmp, target);
}

// Codex keys trust by the real path (/private/tmp/x, never /tmp/x), so the entry must name it.
const real = (p) => realpath(p).catch(() => realParent(p));
/** The real path of p's folder plus p's own name: for a path that is gone or is now a link (the old name after a rename). */
const realParent = async (p) => join(await realpath(dirname(p)).catch(() => dirname(p)), basename(p));

/** Apply every harness's files in the loop folder `loopPath`. Returns lines (what was written, or why not). */
export async function bootstrapLoop(userHome, loopPath, manifest) {
  const lines = [];
  for (const f of harnessFiles(manifest)) {
    const p = join(loopPath, f.path);
    try {
      if (f.link) {
        const st = await lstat(p).catch(() => null);
        if (st && !st.isSymbolicLink()) { lines.push(`${f.path} is a real file: left alone`); continue; }
        if (st && (await readlink(p)) === f.link) continue;
        if (st) await rm(p);
        await symlink(f.link, p);
        lines.push(`${f.path} -> ${f.link}`);
        continue;
      }
      const cur = await read(p);
      const { text, note } = f.merge(cur);
      if (note) lines.push(note);
      if (text === cur) continue;
      await mkdir(dirname(p), { recursive: true });
      await writeAtomic(p, text);
      lines.push(`wrote ${f.path}`);
    } catch (e) { lines.push(`${f.harness}: ${f.path} failed (${String(e.message).split("\n")[0]})`); }
  }
  lines.push(...(await trustLoop(userHome, loopPath, "add")));
  return lines;
}

/**
 * Edit the user-global config of each harness that needs the loop folder trusted. op: "add" | "remove" | "move"
 * (move: `to` is the new path, already renamed). Paths are resolved to real ones; remove also drops the path as
 * given, and move also moves an entry under the old name as given. A harness whose folder isn't in userHome (not
 * installed) is skipped silently.
 */
export async function trustLoop(userHome, loopPath, op, to = null) {
  const lines = [];
  const uniq = async (...ps) => [...new Set(await Promise.all(ps))];
  const dest = op === "move" ? await real(to) : null;
  const steps =
    op === "add" ? [await real(loopPath)].map((p) => (u, t) => u.add(t, p))
    : op === "remove" ? (await uniq(loopPath, real(loopPath), realParent(loopPath))).map((p) => (u, t) => u.remove(t, p))
    : (await uniq(realParent(loopPath), loopPath)).map((p) => (u, t) => u.move(t, p, dest));
  for (const { user } of HARNESSES) {
    if (!user) continue;
    try {
      if (!(await stat(join(userHome, user.requires)).catch(() => null))?.isDirectory()) continue;
      const p = join(userHome, user.path);
      const cur = await read(p);
      if (cur == null && op !== "add") continue;
      let text = cur ?? "";
      for (const step of steps) {
        const r = step(user, text);
        if (r.note) lines.push(r.note);
        text = r.text;
      }
      if (text === cur) continue;
      await writeAtomic(p, text);
      lines.push(`~/${user.path}: trust ${op === "move" ? `moved to ${dest}` : op === "add" ? "added" : "removed"}`);
    } catch (e) { lines.push(`~/${user.path}: trust ${op} failed (${String(e.message).split("\n")[0]})`); }
  }
  return lines;
}
