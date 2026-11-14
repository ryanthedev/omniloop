// harness-apply.mjs: write core/harness.js's files into a loop folder.
// Only files inside the loop folder are written, never through a symlink. Returns short lines for the command's
// output; a problem with one file is a line about that file, never a throw.

import { mkdir, readFile, writeFile, rename, rm, lstat, readlink, symlink, stat, chmod } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { harnessFiles } from "../../core/harness.js";

/** The file's text, or null when it doesn't exist. Any other error (no permission, not a folder) is thrown. */
async function read(p) {
  try { return await readFile(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

/** The first symlink on the way from `root` to `path` (each folder, then the file itself), or null. */
async function linkOnPath(root, path) {
  const parts = path.slice(root.length + 1).split(sep);
  for (let i = 1; i <= parts.length; i++) {
    const p = join(root, ...parts.slice(0, i));
    if ((await lstat(p).catch(() => null))?.isSymbolicLink()) return p.slice(root.length + 1);
  }
  return null;
}

/** Write an unpredictably named temp file (exclusive create) and rename it over `path`; keeps the old file's mode. */
export async function writeAtomic(path, text) {
  const mode = (await stat(path).catch(() => null))?.mode;
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, { flag: "wx" });
    if (mode != null) await chmod(tmp, mode & 0o777);
    await rename(tmp, path);
  } catch (e) { await rm(tmp, { force: true }); throw e; }
}

/** Apply every harness's files in the loop folder `loopPath`. Returns lines (what was written, or why not). */
export async function bootstrapLoop(loopPath, manifest) {
  const lines = [];
  for (const f of harnessFiles(manifest)) {
    const p = join(loopPath, f.path);
    try {
      const via = await linkOnPath(loopPath, p);
      if (f.link) {
        const st = await lstat(p).catch(() => null);
        if (via && via !== f.path) lines.push(`${f.path}: ${via} is a symlink: left alone`);
        else if (st && !st.isSymbolicLink()) lines.push(`${f.path} is a real file: left alone`);
        else if (st) { const to = await readlink(p); if (to !== f.link) lines.push(`${f.path} is a link to ${to}, not ${f.link}: left alone`); }
        else { await symlink(f.link, p); lines.push(`${f.path} -> ${f.link}`); }
        continue;
      }
      if (via) { lines.push(`${f.path}: ${via} is a symlink: left alone`); continue; }
      let cur;
      try { cur = await read(p); } catch (e) { lines.push(`${f.path} can't be read (${e.code ?? e.message}): left alone`); continue; }
      const { text, note } = f.merge(cur);
      if (note) lines.push(note);
      if (text === cur) continue;
      await mkdir(dirname(p), { recursive: true });
      await writeAtomic(p, text);
      lines.push(`wrote ${f.path}`);
    } catch (e) { lines.push(`${f.harness}: ${f.path} failed (${String(e.message).split("\n")[0]})`); }
  }
  return lines;
}
