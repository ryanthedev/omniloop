// Git checkouts inside a loop folder, found from disk. `omniloop rm`, `rm-dir` and `rename` use this instead of asking a
// repo which worktrees it lists: git's list can name paths that now belong to another loop (after a rename), and says
// nothing of a repo that moved. The rules (what rm may touch and why):
//   - walk the real folder, never through a symlink; stop at every folder that has a `.git` (file or folder);
//   - a linked worktree (`.git` is a FILE) is checked from inside and acted on through its OWN repo, found from the
//     worktree itself (rev-parse --git-common-dir), never from a path string git lists;
//   - what git can't act on (a repo that moved, an odd `.git`) is "unchecked": rm refuses it without --force and it
//     goes only with the loop folder.
// Out of scope on purpose: standalone clones (`.git` is a FOLDER, e.g. ref/<name> from `git clone --depth 1`) are only
// deleted with the loop folder, and are checked for uncommitted files only; a worktree nested inside another checkout is
// part of that checkout's folder; a hand-edited loop.json that points outside the loop is not followed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";

const run = promisify(execFile);
const first = (e) => String(e.stderr || e.message).trim().split("\n")[0];
const exists = async (p) => Boolean(await stat(p).catch(() => null));

/** git with a prefix such as ["-C", dir] or ["--git-dir", commonDir]; trimmed stdout. */
export async function gitVia(via, args) { return (await run("git", [...via, ...args], { timeout: 30_000 })).stdout.trim(); }

/** What a `.git` (from lstat) makes its folder: a linked worktree (file), a standalone clone (folder), or something odd. */
export const kindOf = (g) => (g.isFile() ? "linked" : g.isDirectory() ? "clone" : "odd");

export const isInside = (p, root) => p.startsWith(root.endsWith("/") ? root : root + "/");

/** A path's real path; for one that is gone, its folder's real path plus its name (so it still compares with a found one). */
export async function realOr(p) {
  try { return await realpath(p); } catch {}
  const d = await realpath(dirname(p)).catch(() => null);
  return d ? join(d, basename(p)) : p;
}

/**
 * Every git checkout under `root` (a real path), without following symlinks and without descending into a checkout.
 * Returns [{ dir, kind: "linked" | "clone" | "odd" | "unreadable" }].
 */
export async function findCheckouts(root) {
  const out = [];
  const walk = async (dir) => {
    const g = await lstat(join(dir, ".git")).catch(() => null);
    if (g) return void out.push({ dir, kind: kindOf(g) });
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return void out.push({ dir, kind: "unreadable" }); }
    for (const e of entries) if (e.isDirectory()) await walk(join(dir, e.name)); // a symlink is not a directory here
  };
  await walk(root);
  return out;
}

/**
 * What is in a checkout, asked from inside it: { dir, kind, dirty (uncommitted files), ahead (commits on its branch, or
 * detached HEAD, not in the repo's own checked-out branch), branch (null when detached), head, locked, via (git prefix
 * for acting on its repo), repo (label for messages), unchecked (why git couldn't say, else null) }.
 */
export async function checkoutFacts({ dir, kind }) {
  const f = { dir, kind, dirty: 0, ahead: 0, branch: null, head: null, locked: false, via: null, repo: null, unchecked: null, here: true };
  if (kind === "odd") return { ...f, unchecked: ".git is neither a file nor a folder" };
  if (kind === "unreadable") return { ...f, unchecked: "folder can't be read" };
  try {
    // A broken .git must not let git find a repo further up and answer for it.
    if ((await realpath(await gitVia(["-C", dir], ["rev-parse", "--show-toplevel"]))) !== dir) throw new Error("git doesn't see it as a checkout of its own");
    f.dirty = (await gitVia(["-C", dir], ["status", "--porcelain"])).split("\n").filter(Boolean).length;
    if (kind === "clone") return f;
    const common = resolve(dir, await gitVia(["-C", dir], ["rev-parse", "--git-common-dir"]));
    const gitdir = resolve(dir, await gitVia(["-C", dir], ["rev-parse", "--git-dir"]));
    f.via = ["--git-dir", common];
    f.repo = basename(common) === ".git" ? dirname(common) : common;
    f.locked = await exists(join(gitdir, "locked"));
    f.head = await gitVia(["-C", dir], ["rev-parse", "HEAD"]).catch(() => null);
    const b = await gitVia(["-C", dir], ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
    f.branch = b && b !== "HEAD" ? b : null;
    if (f.head) f.ahead = Number(await gitVia(f.via, ["rev-list", "--count", `${await gitVia(f.via, ["rev-parse", "--abbrev-ref", "HEAD"])}..${f.head}`])) || 0;
  } catch (e) { f.unchecked = first(e); }
  return f;
}

/**
 * Facts for a worktree loop.json records, `d` = { path, worktree, branch }, when it is not among the found checkouts:
 * its folder is gone (acted on through the recorded repo, so its registration and branch are still handled), or it has
 * no `.git` (unchecked), or it lies outside the loop folder (null: not ours to touch).
 */
export async function recordedFacts(d, home) {
  const dir = await realOr(d.worktree);
  const base = { dir, kind: "linked", dirty: 0, ahead: 0, branch: d.branch ?? null, head: null, locked: false, via: ["-C", d.path], repo: d.path, unchecked: null, here: false };
  if (await exists(dir)) return isInside(dir, home) ? { ...base, here: true, kind: "odd", via: null, unchecked: "no .git in it" } : null;
  try {
    const main = await gitVia(base.via, ["rev-parse", "--abbrev-ref", "HEAD"]);
    base.ahead = Number(await gitVia(base.via, ["rev-list", "--count", `${main}..${d.branch ?? "HEAD"}`])) || 0;
  } catch { base.via = null; } // the repo moved or the branch is gone: nothing git can do or lose here
  return base;
}

/**
 * Remove a checkout through its own repo, and its branch when merged (an unmerged branch is always kept). Never prunes:
 * only this worktree's registration goes. Returns { lines, failed }. Anything git can't act on is left for the loop
 * folder's deletion.
 */
export async function dropCheckout(w, force, recordedBranch = null) {
  const lines = [], branch = w.branch ?? recordedBranch;
  if (w.kind !== "linked" || !w.via) { if (w.here) lines.push(`  ${w.dir} is deleted with the loop folder`); return { lines, failed: false }; }
  if (force && w.ahead && !w.branch && w.head) lines.push(`  detached HEAD of ${w.dir} was ${w.head} (${w.ahead} unmerged commit(s); recover with: git -C ${w.repo} branch rescue ${w.head})`);
  try {
    // Doubled --force only reaches a locked worktree, and only when the user said --force.
    await gitVia(w.via, ["worktree", "remove", ...(force ? ["--force", "--force"] : []), w.dir]);
    if (w.here) lines.push(`  removed worktree ${w.dir}`);
  } catch (e) {
    const why = first(e);
    // A recorded worktree whose folder is gone may never have been registered: not an error, and nothing else to do.
    if (w.here || !/not a working tree/.test(why)) return { lines: [`  worktree ${w.dir} not removed: ${why}`], failed: true };
  }
  if (!branch) return { lines, failed: false };
  try { await gitVia(w.via, ["branch", "-d", branch]); lines.push(`  deleted branch ${branch} (merged)`); }
  catch { lines.push(`  kept branch ${branch} in ${w.repo} (not merged)`); }
  return { lines, failed: false };
}

/** Repair git's registration of every linked worktree under `root` (a loop folder that just moved). Returns note lines. */
export async function repairCheckouts(root) {
  const notes = [];
  for (const c of await findCheckouts(root)) {
    if (c.kind !== "linked") continue;
    try {
      const common = resolve(c.dir, await gitVia(["-C", c.dir], ["rev-parse", "--git-common-dir"]));
      await gitVia(["--git-dir", common], ["worktree", "repair", c.dir]);
      await gitVia(["-C", c.dir], ["rev-parse", "--git-dir"]);
    } catch (e) { notes.push(`  ${c.dir}: git doesn't see this worktree yet (${first(e)}); run git worktree repair ${c.dir} from its repo`); }
  }
  return notes;
}
