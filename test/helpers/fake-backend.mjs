// An in-memory backend implementing the port (bin/lib/backend/index.mjs): terminals in a Map, every call recorded.
export class FakeBackend {
  name = "fake";
  words = { read: "fake read <t>", wait: "fake wait", down: "the fake backend" };
  eventsReconnect = false;
  calls = [];
  terms = new Map();
  constructor(terms = []) { for (const t of terms) this.terms.set(t.address, { labels: {}, state: "live", ...t }); }
  #rec(...c) { this.calls.push(c); }
  self() { return "f1"; }
  async list() { this.#rec("list"); return [...this.terms.values()]; }
  async get(a) { this.#rec("get", a); const t = this.terms.get(a); if (!t) throw new Error(`no ${a}`); return t; }
  async read(a) { this.#rec("read", a); return this.terms.get(a)?.screen ?? ""; }
  async send(a, text, o = {}) { this.#rec("send", a, text, o.if ?? null); return { code: this.terms.has(a) ? 0 : 1, output: "" }; }
  async label(a, kv) { this.#rec("label", a, kv); const t = this.terms.get(a); for (const i of kv) { const [k, ...v] = i.split("="); if (v.join("=")) t.labels[k] = v.join("="); else delete t.labels[k]; } }
  async spawnPlan(spec) { return { cmd: "fake", args: ["spawn", ...spec.argv] }; }
  async spawn(spec) { this.#rec("spawn", spec); const address = `f${this.terms.size + 10}`; this.terms.set(address, { address, labels: { ...spec.labels }, state: "live" }); return { address }; }
  async kill(a) { this.#rec("kill", a); const t = this.terms.get(a); if (t) t.state = "finished"; }
  async remove(a) { this.#rec("remove", a); this.terms.delete(a); }
  async foregroundPid(a) { return this.terms.get(a)?.foreground?.pid ?? null; }
  events() { throw new Error("not in this fake"); }
  async machines() { return []; }
  async groupOf(id) { return this.loops?.has(id) ? id : null; }
  async startCoordinator(spec, { dry } = {}) { if (dry) return { plan: { fake: spec.argv } }; return { address: (await this.spawn({ ...spec, role: "lead" })).address }; }
  async renameGroup() {}
  async closeGroup() {}
  async retireGroup() {}
  async syncLoop() {}
  async place() {}
}
