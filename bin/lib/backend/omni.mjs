// omni.mjs: the OmniBackend adapter. Every call goes through the `omni` CLI (omni job 5d's loop surface: ls, get, label,
// spawn, send, capture, kill, rm, join, events --all, loop new|get|set|rm). omniloop keeps its labels as the source of
// truth (same keys as on herdr); omni's own `loop` is mirrored from them, best effort. Implements the port in ./index.mjs.
import { selfId, clipBytes, waitForNoDraft } from "../../../core/backend.js";
import { failure } from "../proc.mjs";

const LABEL_MAX = 2048;   // omni refuses a label value over 2048 bytes (5d report: Loop model)
const GOAL_MAX = 2048;
const CAPTURE_TIMEOUT_MS = 2000; // a hung capture counts as "no draft" so send() cannot hang
const DRAFT_WAIT_MS = 60_000; // what hc send waits for a person's draft; omni send has none, so omniloop emulates it

const kvOf = (item) => { const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)]; };
const labelArg = (k, v) => `${k}=${clipBytes(v, LABEL_MAX)}`;

/** The argv of `omni send` for a note: --enter pastes then presses Enter (hc send's behavior); `--` keeps text that starts with -- from being a flag. */
export function sendArgs(address, text, guard = null) {
  return ["send", "--pane", address, "--enter", ...(guard ? ["--if", guard] : []), "--", String(text)];
}

export class OmniBackend {
  name = "omni";
  words = { read: "omni capture --pane <t>", wait: "omni capture", down: "the omni daemon" };
  eventsReconnect = true; // the daemon ends a watcher that falls behind (pane.dropped): the watcher reconnects

  /** draftWaitMs: how long a typed note waits for a person's draft (0 turns the emulation off). */
  constructor({ proc, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, draftWaitMs = Number(env.OMNILOOP_DRAFT_WAIT_MS ?? DRAFT_WAIT_MS) }) {
    Object.assign(this, { proc, env, sleep, now, draftWaitMs: Number.isFinite(draftWaitMs) ? draftWaitMs : DRAFT_WAIT_MS });
  }

  self() { return selfId(this.env, "omni"); }

  async #omni(args, { json = true, timeoutMs = 0 } = {}) {
    const r = await this.proc.run("omni", args, { timeoutMs });
    if (r.code !== 0) throw failure(`omni ${args[0]}${args[0] === "loop" ? ` ${args[1]}` : ""}`, r);
    return json ? JSON.parse(r.stdout) : r.stdout;
  }

  async list() { return (await this.#omni(["ls", "--json"])).terminals ?? []; } // labels are included: one call
  get(address, { timeoutMs = 0 } = {}) { return this.#omni(["get", "--pane", address], { timeoutMs }); }
  read(address, { timeoutMs = 0 } = {}) { return this.#omni(["capture", "--pane", address], { json: false, timeoutMs }); }

  /** Type a note: wait (bounded) for a person's draft first, then paste + Enter. Resolves { code, output } for any exit (3 = the --if guard refused). */
  async send(address, text, { if: guard = null, timeoutMs = 180_000 } = {}) {
    await waitForNoDraft({ read: () => this.read(address, { timeoutMs: CAPTURE_TIMEOUT_MS }), sleep: this.sleep, now: this.now, maxMs: this.draftWaitMs });
    const r = await this.proc.run("omni", sendArgs(address, text, guard), { timeoutMs });
    return { code: r.code, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  async label(address, kv, { timeoutMs = 0 } = {}) {
    await this.#omni(["label", "--pane", address, ...kv.map((i) => labelArg(...kvOf(i)))], { json: false, timeoutMs });
  }

  /** spec: { argv, cwd, labels, loop, role }. A coordinator (role "lead") or a helper; with no loop, a plain pane. */
  async spawnPlan(spec) {
    const args = ["spawn", "--json", ...(spec.cwd ? ["--cwd", spec.cwd] : []), ...(spec.loop ? ["--loop", spec.loop, "--role", spec.role ?? "helper"] : [])];
    for (const [k, v] of Object.entries(spec.labels ?? {})) args.push("--label", labelArg(k, v));
    return { cmd: "omni", args: [...args, "--", ...spec.argv] };
  }
  async spawn(spec) {
    if (spec.loop) await this.#ensureLoop(spec.loop, spec);
    const r = await this.#omni((await this.spawnPlan(spec)).args);
    return { ...r, address: r.address ?? r.pane };
  }

  async kill(address) { await this.proc.run("omni", ["kill", "--pane", address]).catch(() => {}); }
  async remove(address) { await this.proc.run("omni", ["rm", "--pane", address]).catch(() => {}); }

  async foregroundPid(address, { timeoutMs = 3000 } = {}) {
    try { const p = (await this.get(address, { timeoutMs }))?.foreground?.pid; return Number.isInteger(p) ? p : null; } catch { return null; }
  }

  /** Snapshot line { seq, terminals, loops }, then { method: "event", params } lines: the shape hc events has. */
  events({ label = null } = {}) { return this.proc.start("omni", ["events", "--all", "--json", ...(label ? ["--label", label] : [])]); }

  async machines() { return []; } // omni v1 is one computer

  // ---- the loop's group: an omni loop with the loop's id ----
  async groupOf(id) { try { await this.#omni(["loop", "get", id]); return id; } catch { return null; } }

  /** Create the omni loop when it is missing (goal and local folders from the manifest). Returns whether it was created. */
  async #ensureLoop(id, { goal = null, dirs = [] } = {}) {
    if (await this.groupOf(id)) return false;
    await this.#omni(["loop", "new", id, ...(goal ? ["--goal", clipBytes(goal, GOAL_MAX)] : []), ...dirs.flatMap((d) => ["--dir", d])], { json: false });
    return true;
  }
  /** Mirror a loop: make it, or bring its goal up to date. Callers treat a failure as a warning (labels stay the truth). */
  async syncLoop(id, { goal = null, dirs = [] } = {}) {
    if (!(await this.#ensureLoop(id, { goal, dirs })) && goal) await this.#omni(["loop", "set", id, "--goal", clipBytes(goal, GOAL_MAX)], { json: false });
  }
  /** Put a pane in a loop (or take it out: loop null). The daemon decides who may (the user; a pane for itself; a lead). */
  async place(address, loop, role = null) { await this.#omni(["join", "--pane", address, loop ?? "-", ...(role ? ["--role", role] : [])], { json: false }); }

  /** spec: { id, home, argv, labels, goal, dirs }. The coordinator is the loop's lead pane. dry: { plan } only. */
  async startCoordinator({ id, home, argv, labels, goal, dirs }, { dry = false } = {}) {
    const spec = { argv, cwd: home, labels, loop: id, role: "lead", goal, dirs };
    if (dry) return { plan: { omni: (await this.spawnPlan(spec)).args } };
    return { address: (await this.spawn(spec)).address };
  }

  /** Omni loop ids are fixed: make the new loop, move the panes into it, remove the old one. Moving another pane is the user's call (5d), so a refusal throws. */
  async renameGroup(handle, { to, terms = [] }) {
    const old = await this.#omni(["loop", "get", handle]).catch(() => ({}));
    await this.#ensureLoop(to, { goal: old.goal, dirs: (old.workspace ?? []).map((w) => w.path) });
    for (const t of terms) await this.place(t, to);
    await this.#omni(["loop", "rm", handle], { json: false });
  }
  async closeGroup() {}
  /** After its panes are gone: remove the omni loop (retried: a pane's program may take a moment to end). */
  async retireGroup(handle) {
    for (let i = 0; i < 6; i++) {
      try { await this.#omni(["loop", "rm", handle], { json: false }); return; } catch { await this.sleep(500); }
    }
  }
}
