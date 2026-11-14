// herdr.mjs: the HerdrBackend adapter. Every `hc` and `herdr-app` call omniloop makes lives here, behavior unchanged from
// when they were inlined in bin/omniloop.mjs. Implements the port described in ./index.mjs.
import { selfId } from "../../../core/backend.js";
import { failure } from "../proc.mjs";

const SEND_TIMEOUT_MS = 180_000; // hc send waits up to 60 s for a person's draft before typing; allow well past that

export class HerdrBackend {
  name = "herdr";
  // Wording for the brief and for messages.
  words = { read: "hc read <t>", wait: "hc wait", down: "herdr-core (hc)" };
  eventsReconnect = false;

  constructor({ proc, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) { Object.assign(this, { proc, env, sleep }); }

  self() { return selfId(this.env, "herdr"); }

  /** hc <args> [--json]: --json goes before any "--", or it becomes an argument of the program being started. */
  async #hc(args, { json = true, timeoutMs = 0 } = {}) {
    const cut = args.indexOf("--");
    const full = !json ? args : cut < 0 ? [...args, "--json"] : [...args.slice(0, cut), "--json", ...args.slice(cut)];
    const r = await this.proc.run("hc", full, { timeoutMs });
    if (r.code !== 0) throw failure(`hc ${args[0]}`, r);
    return json ? JSON.parse(r.stdout) : r.stdout;
  }

  async #app(args) {
    const r = await this.proc.run("herdr-app", args, { maxBuffer: 16 << 20 });
    if (r.code !== 0) throw failure(`herdr-app ${args[0]}`, r);
    return r.stdout;
  }

  async list() {
    // hc ls --json leaves labels out; hc get has them.
    const { terminals } = await this.#hc(["ls"]);
    return Promise.all(terminals.map((t) => this.get(t.address).catch(() => null))).then((x) => x.filter(Boolean));
  }
  /** hc get <addr> --json. The hooks (ask-hook, goal-hook) pass timeoutMs and always ran `hc get --json <addr>`: kept byte for byte. */
  async get(address, { timeoutMs = 0 } = {}) {
    return timeoutMs ? JSON.parse(await this.#hc(["get", "--json", address], { json: false, timeoutMs })) : this.#hc(["get", address]);
  }
  read(address) { return this.#hc(["read", address], { json: false }); }

  /** Type a note. Resolves { code, output } for any exit (see sendFailed in core/watch.js); rejects only if hc can't start. */
  async send(address, text, { if: guard = null, timeoutMs = SEND_TIMEOUT_MS } = {}) {
    const r = await this.proc.run("hc", ["send", ...(guard ? ["--if", guard] : []), address, text], { timeoutMs });
    return { code: r.code, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  async label(address, kv, { timeoutMs = 0 } = {}) { await this.#hc(["label", address, ...kv], { json: false, timeoutMs }); }

  /**
   * The `hc run` command line for a spawn. spec: { argv, cwd, labels, loop, role, space, inLoopSpace, starter }.
   * Placement: --space flag, else the loop's own space when the loop has a folder (inLoopSpace), else the starter's space.
   */
  async spawnPlan(spec) {
    const labels = { ...spec.labels };
    if (spec.starter) {
      const space = (await this.get(spec.starter).catch(() => null))?.labels?.["herdr.space"];
      if (space && !spec.space) labels["herdr.space"] = space;
    }
    if (spec.space) labels["herdr.space"] = spec.space;
    const args = ["run", "--bg", "--no-parent", "--no-notify", ...(spec.cwd ? ["--cwd", spec.cwd] : [])];
    for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
    if (spec.inLoopSpace) {
      const sp = !spec.space && (await this.groupOf(spec.loop));
      if (sp) { const i = args.indexOf(`herdr.space=${labels["herdr.space"]}`); if (i >= 0) args[i] = `herdr.space=${sp}`; else args.push("--label", `herdr.space=${sp}`); }
    }
    return { cmd: "hc", args: [...args, "--", ...spec.argv] };
  }
  async spawn(spec) {
    const { args } = await this.spawnPlan(spec);
    return this.#hc(args); // { address, ... }
  }

  async kill(address) { await this.proc.run("hc", ["kill", address]).catch(() => {}); }
  async remove(address) { await this.proc.run("hc", ["rm", address]).catch(() => {}); }

  async foregroundPid(address, { timeoutMs = 3000 } = {}) {
    try { const p = (await this.get(address, { timeoutMs }))?.foreground?.pid; return Number.isInteger(p) ? p : null; } catch { return null; }
  }

  /** The event stream: a child process whose stdout is JSON lines (first line { terminals }, then { params: { terminal, type, data } }). */
  events({ label = null } = {}) { return this.proc.start("hc", ["events", "--json", ...(label ? ["--label", label] : [])]); }

  /** Names of the other computers herdr-core knows (none when it doesn't answer). */
  async machines() {
    try { return (JSON.parse((await this.proc.run("hc", ["machine", "ls", "--json"], { timeoutMs: 10_000 })).stdout).machines ?? []).map((m) => m.name); } catch { return []; }
  }

  // ---- the loop's group: a Herdr space named after the loop ----
  /** The space id of the loop's space on this computer, or null. */
  async groupOf(id) {
    try { return JSON.parse(await this.#app(["ls"])).spaces.find((sp) => sp.name === id && !sp.machine)?.id ?? null; } catch { return null; }
  }
  async #madeTerminal(made) {
    if (made?.terminal) return made.terminal;
    try {
      for (const sp of JSON.parse(await this.#app(["ls"])).spaces ?? []) {
        if (made?.tab) { const tb = (sp.tabs ?? []).find((t) => t.id === made.tab); if (tb) return tb.terminals?.[0]?.terminal ?? null; }
        else if (made?.space && sp.id === made.space) return sp.tabs?.[0]?.terminals?.[0]?.terminal ?? null;
      }
    } catch {}
    return null;
  }
  /**
   * Start a loop's coordinator and label it. spec: { id, home, argv, labels, goal }. In the loop's space when one is open
   * here (a new tab named "coordinator"), else in a new space named after the loop. The terminal comes from what
   * `herdr-app do` printed, never from a name lookup (an old space with the loop's name may still be open).
   * dry: returns { plan } and starts nothing. Else { address }.
   */
  async startCoordinator({ id, home, argv, labels }, { dry = false } = {}) {
    const sp = await this.groupOf(id);
    const [cmd, args] = sp ? ["tab.new", { space: sp, name: "coordinator", folder: home, argv }] : ["space.new", { name: id, folder: home, argv }];
    if (dry) return { plan: { [cmd]: args } };
    const out = await this.#app(["do", cmd, JSON.stringify(args)]);
    let made = null;
    try { made = JSON.parse(out); } catch {}
    let address = null;
    for (let i = 0; i < 40 && !address; i++) {
      address = await this.#madeTerminal(made);
      if (!address) await this.sleep(250);
    }
    if (!address) throw new Error(`${cmd} ran for ${id}, but its coordinator didn't appear; label it yourself: omniloop join ${id} --coordinator --terminal <t>`);
    await this.label(address, Object.entries(labels).map(([k, v]) => `${k}=${v}`));
    return { address };
  }
  async renameGroup(handle, { to }) { await this.#app(["do", "space.rename", JSON.stringify({ id: handle, name: to })]); }
  async closeGroup(handle) { await this.#app(["do", "space.close", JSON.stringify({ id: handle, confirmed: true })]).catch(() => {}); }
  async retireGroup() {}

  // Herdr groups terminals by label and space: nothing to mirror, nothing to place.
  async syncLoop() {}
  async place() {}
}
