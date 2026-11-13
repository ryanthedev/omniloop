// Omniloop picker (⌘O): every loop, fuzzy-searched, and the way to start a new one.
//
//   ask      Your loops: pinned ones first (numbered), then the ones you talked to most recently. Typing
//            fuzzy-searches everything (name, goal, sessions, folders, projects, tasks, recent chat). Enter opens a
//            loop (jumps to its lead); ⌘P pins or unpins it; ⌘↑/⌘↓ moves a pin; ⌘↵ (or the last row) starts a new loop.
//   machine  New loop: which machine (only when this computer sees others).
//   goal     New loop: what it's for. Loops that might already cover it show underneath; Enter on one opens it.
//   context  New loop: search and Tab to add projects and folders (the goal pre-ticks matching ones).
//   review   New loop: a small model's folder name and cleaned-up goal (asked when you left the goal step);
//            edit either, Enter creates.
//
// Opened by a key (keys.json: "mod.open:omniloop-picker"); mod.json makes it a full-window dialog. Another mod
// can open it as a 2×2 frameless popup with props { action: "jump", slot } to jump to a pinned loop's lead and
// close (the leader's harpoon keys).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { terminals, theme, run, exec, home, readTextFile, props, closeOverlay, shared, setShared, notify, nextCommand } from "herdr";
import { buildView, ago } from "./core/view.js";
import { folderRows, projectRows, machineRows, newLoopCommand, leadAddress, clampAt, loopEntries, pickerRows, suggestLoops } from "./core/picker.js";
import { matchProjects, strongMatches } from "./core/projects.js";
import { PINS_KEY, sanitizePins, togglePin, movePin } from "./core/pins.js";
import { cleanId, fallbackProposal } from "./core/intake.js";
import { tokens } from "./core/fuzzy.js";
import { BIN } from "./config.js";
import { KEYS } from "./core/keys.js";
import { Help, isHelpKey } from "./help/help.js";

const LOOPS_SHOWN = 8, FOLDERS_SHOWN = 10;
// Context folders on a machine: its repos, plus ~/.config ($HOME is that machine's own).
const FOLDERS_SH = 'find "$HOME/repos" -mindepth 1 -maxdepth 1 -type d ! -name ".*" 2>/dev/null | sort; echo "$HOME/.config"';
const PLACEHOLDER = {
  ask: "Search your loops, or describe something new…  (? for controls)",
  machine: "Enter picks the machine under the cursor",
  goal: "What is this loop for?",
  context: "Search folders and projects; Tab adds one",
  review: "Edit the selected line",
};
const base = (p) => p.split("/").filter(Boolean).pop() ?? p;

export default class OmniloopPicker extends View {
  init(_props, cx) {
    // Jump mode: act and close, no page.
    const p = props() ?? {};
    if (p.action === "jump") { this.jumping = true; this.jumpTo(Number(p.slot)); return; }

    this.step = "ask";          // "ask" | "machine" | "goal" | "context" | "review" | "creating"
    this.query = "";
    this.at = 0;
    this.index = [];            // this computer's loop folders (omniloop index)
    this.fresh = null;          // the new loop: { goal, proposal, pending, id, finalGoal, field, edited }
    this.picked = [];
    this.folders = [];
    this.projects = [];
    this.pickedProjects = [];
    this.machines = [];
    this.machine = null;        // where the new loop goes: null = this computer
    this.error = null;
    this.watcher = null;
    this.keysHelp = new Help(KEYS, { title: "Omniloop controls", mod: "omniloop-picker" });
    this.makeInput("ask", "");
    cx.timer.after(400, () => { if (!this.keysHelp.shown) this.input.focus(); });
    // Test hook: a test home's shared.json can pre-fill {"omniloop-picker.test": {query, step, goal, picked, projects, help}}.
    const seed = shared("omniloop-picker.test");
    if (seed) {
      if (seed.step && seed.step !== "ask") { this.step = seed.step; this.fresh = { goal: seed.goal ?? "", proposal: seed.proposal ?? null, pending: false, field: "id" }; this.picked = seed.picked ?? []; this.pickedProjects = seed.projects ?? []; if (seed.proposal) this.useProposal(seed.proposal); this.makeInput(seed.step, this.fresh.id ?? ""); this.query = this.fresh.id ?? ""; }
      if (seed.query) { this.input.set_value(seed.query); this.query = seed.query; }
      if (seed.help) this.keysHelp.open(cx);
    }
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const raw = await readTextFile(`${home()}/.cache/omniloop/state.json`).catch(() => null);
      try { this.watcher = raw ? JSON.parse(raw) : null; } catch {}
      try {
        const r = await exec(this.hc(), ["machine", "ls", "--json"], { timeout: 10000 });
        this.machines = (JSON.parse(r.stdout || "{}").machines ?? []).filter((m) => m.state === "connected").map((m) => m.name);
      } catch {}
      this.machinesKnown = true;
      // ⌘↵ pressed before the machines were known: go on now, so the machine step isn't skipped.
      if (this.pendingNew != null) { const g = this.pendingNew; this.pendingNew = null; this.startNew(g, cx); }
      cx.notify();
      try { this.index = JSON.parse((await exec(`${BIN}/omniloop`, ["index"], { timeout: 10000 })).stdout || "[]"); } catch {}
      cx.notify();
      await this.loadContext(null);
      cx.notify();
    });
    // keys.json "mod:omniloop-picker" bindings arrive here (e.g. "cmd-p": "omniloop-picker.pin").
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(c, cx); cx.notify(); } });
  }

  hc() { return `${home()}/.local/bin/hc`; }

  /** A fresh text box for a step, so each step has its own placeholder. */
  makeInput(step, value) {
    this.input = InputState.new({ placeholder: PLACEHOLDER[step] ?? "", value: value ?? "" });
    this.input.on("change", (_e, cx) => this.changed(cx));
    // ⌘↵ (a secondary submit) starts a new loop from whatever is typed, from the search step.
    this.input.on("submit", (e, cx) => { e?.secondary && this.step === "ask" ? this.startNew(this.query, cx) : this.enter(cx); cx.notify(); });
    this.input.focus();
  }
  close() { const id = props()?.overlay; if (id) closeOverlay(id); }
  pins() { return sanitizePins(shared(PINS_KEY)); }

  view() { return buildView(terminals(), this.watcher, Date.now(), shared("omniloop.withYou") ?? {}); }
  entries() { return loopEntries(this.view().loops, this.index, this.pins()); }

  // ---- loops ----

  open(entry) {
    if (!entry.lead) { this.error = `Nobody is running in ${entry.id} right now (its folder: ~/loops/${entry.id}).`; return; }
    this.close();
    run("pane.focus", { terminal: entry.lead });
  }

  /** Jump to pin `slot`'s lead and close (the popup the leader opens). */
  jumpTo(slot) {
    const key = this.pins()[slot - 1];
    const entry = key ? loopEntries(buildView(terminals(), null, Date.now()).loops, [], this.pins()).find((e) => e.key === key) : null;
    this.close();
    if (!key) return notify({ title: "Omniloop", body: `No loop pinned at ${slot}`, level: "warning", timeout: 1800 });
    if (!entry?.lead) return notify({ title: "Omniloop", body: `${slot} · ${key}: nobody is running in it`, level: "warning", timeout: 2500 });
    run("pane.focus", { terminal: entry.lead });
  }

  selected() { const rows = this.rows(); return rows[clampAt(this.at, rows.length)]; }

  command(c, cx) {
    if (c === "new" && this.step === "ask") return this.startNew(this.query, cx);
    const r = this.selected();
    if (this.step !== "ask" || r?.kind !== "loop") return;
    const key = r.entry.key;
    if (c === "pin") {
      const t = togglePin(this.pins(), key);
      if (t.full) { this.error = "All 9 pins are taken; unpin one first (⌘P on it)."; return; }
      setShared(PINS_KEY, t.pins);
      notify({ title: "Omniloop", body: t.slot ? `Pinned ${r.entry.id} at ${t.slot}` : `Unpinned ${r.entry.id}`, level: "success", timeout: 1400 });
    } else if (c === "pin-up" || c === "pin-down") {
      setShared(PINS_KEY, movePin(this.pins(), key, c === "pin-up" ? -1 : 1));
      // Keep the moved loop selected.
      if (!this.query) this.at = Math.max(0, this.rows().findIndex((x) => x.entry?.key === key));
    }
  }

  // ---- the new-loop steps ----

  startNew(goal, cx) {
    if (!this.machinesKnown) { this.pendingNew = String(goal ?? ""); this.error = "Checking your machines…"; return; }
    this.fresh = { goal: String(goal ?? "").trim(), proposal: null, pending: false, field: "id" };
    this.error = null; this.picked = []; this.pickedProjects = [];
    this.go(this.machines.length ? "machine" : "goal", this.machines.length ? "" : this.fresh.goal, cx);
  }

  go(step, text, cx) {
    this.step = step; this.at = 0;
    this.makeInput(step, text ?? ""); this.query = text ?? "";
    cx.notify();
  }

  changed(cx) {
    this.query = this.input.value();
    // Review: the box edits the selected field. Only a real change counts as an edit (set_value may echo a change).
    if (this.step === "review" && this.fresh) {
      const f = this.fresh;
      if ((f[f.field] ?? "") !== this.query) { f[f.field] = this.query; f.edited = true; }
    }
    else this.at = 0;
    cx.notify();
  }

  async loadContext(machine) {
    const on = (script) => machine
      ? exec(this.hc(), ["exec", "--on", machine, "--", "/bin/zsh", "-lc", script], { timeout: 15000 })
      : exec("sh", ["-c", script], { timeout: 10000 });
    let folders = [], projects = [];
    try { folders = (await on(FOLDERS_SH)).stdout.split("\n").filter(Boolean); } catch {}
    try {
      const r = machine ? await on("omniloop project ls --json") : await exec(`${BIN}/omniloop`, ["project", "ls", "--json"], { timeout: 10000 });
      projects = JSON.parse(r.stdout || "[]");
    } catch {}
    // A late answer for a machine no longer chosen is dropped: one machine's paths never show (or go) to another.
    if (this.machine !== machine) return;
    this.folders = folders; this.projects = projects;
  }

  pickMachine(name, cx) {
    if (name !== this.machine) {
      this.machine = name; this.picked = []; this.pickedProjects = []; this.folders = []; this.projects = [];
      cx.spawn(async (cx) => { await this.loadContext(name); if (this.machine === name) this.preTick(); cx.notify(); });
    }
    this.go("goal", this.fresh.goal, cx);
  }

  /** From the goal: projects whose triggers match strongly, and folders whose name is a word in it. */
  preTick() {
    const goal = this.fresh?.goal ?? "";
    this.pickedProjects = [...new Set([...this.pickedProjects, ...strongMatches(matchProjects(this.projects, goal)).map((m) => m.name)])];
    const words = new Set(tokens(goal).map((w) => w.replace(/[^a-z0-9._-]/g, "")));
    const named = this.folders.filter((f) => base(f).length >= 4 && words.has(base(f).toLowerCase()));
    this.picked = [...new Set([...this.picked, ...named])];
  }

  /** Ask the model for a folder name and a cleaned-up goal, in the background. Only the typed goal is sent;
   *  the answer is checked in core/intake.js and falls back to the goal as typed. */
  propose(cx) {
    const f = this.fresh, goal = f.goal;
    const taken = this.machine ? [] : this.index.map((x) => x.id);
    f.pending = true; f.proposal = null;
    cx.spawn(async (cx) => {
      let p = fallbackProposal(goal, taken);
      try {
        const r = await exec(`${BIN}/omniloop`, ["propose", goal, ...(taken.length ? ["--taken", taken.join(",")] : [])], { timeout: 40000 });
        p = JSON.parse(r.stdout || "null") ?? p;
      } catch {}
      if (this.fresh !== f || f.goal !== goal) return;
      f.pending = false; f.proposal = p;
      if (!f.edited) this.useProposal(p);
      if (this.step === "review") this.input.set_value(f[f.field] ?? "");
      cx.notify();
    });
  }

  useProposal(p) { this.fresh.id = p.id; this.fresh.finalGoal = p.goal; }

  rows() {
    if (this.step === "machine") return machineRows(this.machines, this.machine);
    if (this.step === "goal") {
      const g = this.query.trim();
      return [{ kind: "continue", goal: g }, ...suggestLoops(this.entries(), g).map((entry) => ({ kind: "loop", entry, why: null }))];
    }
    if (this.step === "context") return [...projectRows(this.projects, this.query, this.pickedProjects), ...folderRows(this.folders, this.query, this.picked)];
    if (this.step === "review" || this.step === "creating") {
      const f = this.fresh;
      return [{ kind: "field", field: "id", label: "Folder", value: f.id ?? "" }, { kind: "field", field: "finalGoal", label: "Goal", value: f.finalGoal ?? "" }];
    }
    return pickerRows(this.entries(), this.query);
  }

  enter(cx) {
    const r = this.selected();
    this.error = null;
    if (this.step === "ask") {
      if (!r) return;
      if (r.kind === "loop") return this.open(r.entry);
      return this.startNew(r.goal ?? "", cx);
    }
    if (this.step === "machine") return r && this.pickMachine(r.name, cx);
    if (this.step === "goal") {
      if (r?.kind === "loop") return this.open(r.entry);
      const g = this.query.trim();
      if (!g) { this.error = "Say what this loop is for."; return; }
      if (g !== this.fresh.goal || !this.fresh.proposal && !this.fresh.pending) { this.fresh.goal = g; this.fresh.edited = false; this.propose(cx); }
      this.preTick();
      return this.go("context", "", cx);
    }
    if (this.step === "context") {
      const f = this.fresh;
      if (!f.edited && f.proposal) this.useProposal(f.proposal);
      f.field = "id";
      return this.go("review", f.id ?? "", cx);
    }
    if (this.step === "review") return this.create(cx);
  }

  toggle(cx) {
    if (this.step !== "context") return;
    const r = this.selected();
    if (!r) return;
    if (r.kind === "project") this.pickedProjects = r.on ? this.pickedProjects.filter((p) => p !== r.name) : [...this.pickedProjects, r.name];
    else this.picked = r.on ? this.picked.filter((p) => p !== r.path) : [...this.picked, r.path];
    this.input.set_value(""); this.query = ""; this.at = 0;
    cx.notify();
  }

  /** Review: move between the folder name and the goal; the box edits the one selected. */
  field(to, cx) {
    const f = this.fresh;
    f.field = to; this.at = to === "id" ? 0 : 1;
    this.input.set_value(f[to] ?? ""); this.query = f[to] ?? "";
    cx.notify();
  }

  create(cx) {
    const f = this.fresh;
    if (f.pending && !f.edited) { this.error = "Still naming it… a moment."; return; }
    const id = cleanId(f.id), goal = String(f.finalGoal ?? "").replace(/\s+/g, " ").trim() || f.goal;
    if (!id) { this.error = "The folder name needs letters or digits (a-z 0-9 -)."; return; }
    f.id = id;
    this.step = "creating"; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const machine = this.machine;
        const { cmd, args } = newLoopCommand({ machine, id, goal, projects: this.pickedProjects, dirs: this.picked, bin: BIN, hc: this.hc() });
        const r = await exec(cmd, args, { timeout: 60000 });
        if (r.code === 0) {
          this.close();
          const lead = machine ? leadAddress(r.stdout, machine) : null;
          if (lead) run("pane.focus", { terminal: lead });
          return;
        }
        this.error = (r.stderr || r.stdout || `omniloop new exited ${r.code}`).trim();
      } catch (e) { this.error = String(e?.message ?? e); }
      this.step = "review"; cx.notify();
    });
  }

  back(cx) {
    this.error = null;
    if (this.step === "ask") return this.close();
    if (this.step === "review") return this.go("context", "", cx);
    if (this.step === "context") return this.go("goal", this.fresh.goal, cx);
    if (this.step === "goal" && this.machines.length) return this.go("machine", "", cx);
    this.go("ask", this.fresh?.goal ?? "", cx);
  }

  window(rows, n) {
    const at = clampAt(this.at, rows.length);
    const start = Math.max(0, Math.min(at - Math.floor(n / 2), rows.length - n));
    return { at, start, shown: rows.slice(start, start + n) };
  }

  // ---- drawing ----

  dot(t, st, running = true) {
    if (!running) return div().size(9).mx(2).flex_none().rounded(5).border(1).border_color(t.dim).opacity(0.5);
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900);
    if (!st || st === "idle") return div().size(9).mx(2).flex_none().rounded(5).border(1.5).border_color(t.dim);
    return div().size(9).mx(2).flex_none().rounded(5).bg(t[st] ?? t.dim);
  }

  chip(t, text, color) {
    return div().flex_none().px(6).h(17).rounded(5).bg(color + "26").text_size(10.5).font_semibold().text_color(color).flex().items_center().child(text);
  }

  newRow(t, r, on, i) {
    const label = r.kind === "continue"
      ? (r.goal ? `Continue: ${r.goal}` : "Type what this loop is for")
      : (r.goal ? `Start a new loop: ${r.goal}` : "Start a new loop");
    const sub = r.kind === "continue" ? "Next: pick folders and projects, then check its name" : "⌘↵ from anywhere in the list";
    return h_flex().id(`pk-new-${r.kind}`).h(60).px(18).gap(14).items_center().rounded(12).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => { this.at = i; this.enter(cx); })
      .child(div().size(22).flex_none().rounded(6).bg(t.accent + "26").text_color(t.accent).text_size(15).font_bold().flex().items_center().justify_center().child(r.kind === "continue" ? "→" : "+"))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(label))
        .child(div().text_size(12).text_color(t.dim).truncate().child(sub)));
  }

  loopRow(t, r, on, i) {
    const e = r.entry;
    const n = e.members.length;
    const when = e.running ? (e.ago ? `you ${e.ago}` : "you: never") : (e.touched ? `idle · ${ago(e.touched, Date.now())}` : "idle");
    return h_flex().id(`pk-${e.key}`).h(60).px(18).gap(14).items_center().rounded(12).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => { this.at = i; this.enter(cx); })
      .child(div().w(16).flex_none().text_size(12).font_bold().text_color(t.accent).child(e.pin ? String(e.pin) : ""))
      .child(this.dot(t, e.status, e.running))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(15).font_semibold().text_color(e.running ? t.foreground : t.muted).child(e.id))
          .when(Boolean(e.machine), (el) => el.child(this.chip(t, e.machine, t.dim)))
          .when(e.needsYou > 0, (el) => el.child(this.chip(t, `${e.needsYou} for you`, t.blocked))))
        .child(div().text_size(12.5).text_color(r.why ? t.accent : t.muted).truncate().child(r.why ?? e.goal ?? "")))
      .child(v_flex().flex_none().items_end().gap(2)
        .child(div().text_size(11.5).text_color(e.ago ? t.muted : t.dim).child(when))
        .when(e.running, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${n} session${n === 1 ? "" : "s"}`))));
  }

  checkRow(t, r, on, i, { id, tag, name, sub, round = false }) {
    return h_flex().id(id).h(tag === "PROJECT" ? 52 : 40).px(16).gap(12).items_center().rounded(10).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => { this.at = i; this.step === "machine" ? this.enter(cx) : this.toggle(cx); })
      .child(div().size(16).flex_none().rounded(round ? 8 : 4).border(1.5).border_color(r.on ? t.accent : t.dim).bg(r.on ? t.accent : t.background)
        .text_size(11).font_bold().text_color(t.background).flex().items_center().justify_center().child(r.on && !round ? "✓" : ""))
      .when(Boolean(tag), (el) => el.child(this.chip(t, tag, t.accent)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(14).font_semibold().text_color(r.on ? t.foreground : t.muted).child(name))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(sub))));
  }

  fieldRow(t, r, on, i) {
    const f = this.fresh;
    const note = r.field === "id" ? `~/loops/${r.value || "…"}${this.machine ? ` on ${this.machine}` : ""}`
      : f.pending && !f.edited ? "Cleaning up your goal…" : f.proposal?.source === "model" && !f.edited ? "Reworded from what you typed; edit it if it's off" : "";
    return v_flex().id(`pr-${r.field}`).px(16).py(10).gap(3).rounded(10).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => this.field(r.field, cx))
      .child(h_flex().gap(10).items_center()
        .child(div().w(52).flex_none().text_size(11).font_semibold().text_color(t.dim).child(r.label.toUpperCase()))
        .child(div().flex_1().min_w(0).text_size(14.5).text_color(r.value ? t.foreground : t.dim).child(r.value || (f.pending ? "…" : "(empty)"))))
      .when(Boolean(note), (el) => el.child(div().pl(62).text_size(11.5).text_color(t.dim).child(note)));
  }

  row(t, r, on, i) {
    if (r.kind === "loop") return this.loopRow(t, r, on, i);
    if (r.kind === "new" || r.kind === "continue") return this.newRow(t, r, on, i);
    if (r.kind === "field") return this.fieldRow(t, r, on, i);
    if (r.kind === "machine") return this.checkRow(t, r, on, i, { id: `pm-${r.label}`, tag: "MACHINE", name: r.label, round: true });
    if (r.kind === "project") return this.checkRow(t, r, on, i, { id: `pp-${r.name}`, tag: "PROJECT", name: r.name, sub: r.description });
    return this.checkRow(t, r, on, i, { id: `pf-${r.path}`, name: r.name, sub: r.path });
  }

  heading() {
    const f = this.fresh, where = this.machine ? ` on ${this.machine}` : "";
    switch (this.step) {
      case "machine": return ["Where should it run?", "Pick the machine for the new loop."];
      case "goal": return [`New loop${where}`, "What's it for? Loops that might already cover it show below."];
      case "context": return [`Context${where}`, f.goal];
      case "review": case "creating": return [`Check it${where}`, "A folder name and the goal, cleaned up. Edit either."];
      default: return ["What are you working on?", "Pinned first, then the loops you talked to last. Type to search everything."];
    }
  }

  hints() {
    const f = this.fresh;
    switch (this.step) {
      case "machine": return "↑↓ move · Enter pick · Esc back";
      case "goal": return "Enter continue (or open a suggested loop) · Esc back";
      case "context": return `↑↓ move · Tab add or remove · Enter next with ${this.pickedProjects.length ? `${this.pickedProjects.join(", ")} + ` : ""}${this.picked.length} folder${this.picked.length === 1 ? "" : "s"} · Esc back`;
      case "review": return f?.pending && !f.edited ? "Naming it…" : "↑↓ folder or goal · type to edit · Enter create · Esc back";
      case "creating": return `Creating the loop, its space and its lead${this.machine ? ` on ${this.machine}` : ""}…`;
      default: return "↑↓ move · Enter open · ⌘P pin · ⌘↵ new loop · Esc close";
    }
  }

  render(cx) {
    if (this.jumping) return div();
    const t = theme();
    const rows = this.rows();
    const list = this.step === "ask" || this.step === "goal";
    const { at, start, shown } = this.window(rows, list ? LOOPS_SHOWN : FOLDERS_SHOWN);
    this.at = at;
    const [title, sub] = this.heading();

    const help = this.keysHelp.panel();
    if (Boolean(this.helpWas) !== this.keysHelp.shown) {
      const toHelp = this.keysHelp.shown;
      cx.timer.after(0, () => (toHelp ? this.handle.focus() : this.input.focus()));
    }
    this.helpWas = this.keysHelp.shown;
    return v_flex().id("omniloop-picker").relative().track_focus(this.handle).size_full().bg(t.background).items_center()
      .on_key_down((e, cx) => {
        if (this.keysHelp.shown) { this.keysHelp.key(e, cx); return; }
        if (this.step === "ask" && isHelpKey(e) && this.query.replace(/\?$/, "") === "") {
          this.keysHelp.open(cx); cx.stop_propagation();
          cx.timer.after(0, (cx) => { this.input.set_value(""); this.query = ""; cx.notify(); });
          return;
        }
        const k = e.key, ks = e.keystroke;
        if (k === "escape") return this.back(cx);
        // Pins, also reachable without keys.json (if the app hands these chords to the dialog).
        if (ks === "cmd-p") { this.command("pin", cx); cx.stop_propagation(); return cx.notify(); }
        if (ks === "cmd-up" || ks === "cmd-down") { this.command(ks === "cmd-up" ? "pin-up" : "pin-down", cx); cx.stop_propagation(); return cx.notify(); }
        const n = Math.max(1, rows.length);
        const down = k === "down" || (k === "n" && e.modifiers.control), up = k === "up" || (k === "p" && e.modifiers.control);
        if (this.step === "review" && (down || up)) return (cx.stop_propagation(), this.field(this.fresh.field === "id" ? "finalGoal" : "id", cx));
        if (down) this.at = (at + 1) % n;
        else if (up) this.at = (at + n - 1) % n;
        else if (k === "tab") return (cx.stop_propagation(), this.toggle(cx));
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(v_flex().w_full().max_w(760).px(32).pt(96).gap(18)
        .child(div().text_size(11).font_semibold().text_color(t.dim).child("OMNILOOP"))
        .child(v_flex().gap(6)
          .child(div().text_size(30).font_semibold().text_color(t.foreground).child(title))
          .child(div().text_size(14).text_color(t.muted).truncate().child(sub ?? "")))
        .child((() => { const el = h_flex().h(54).px(18).gap(12).items_center().rounded(14).border(1.5).border_color(t.accent).bg(t.raised)
          .child(svg("mods/workspace-chrome/search.svg").size(18).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(18).text_color(t.foreground)); return el; })())
        .when(Boolean(this.error), (el) => el.child(div().px(4).text_size(12).text_color(t.blocked).child(this.error)))
        .when(this.step === "context" && this.folders.length === 0, (el) => el.child(div().px(4).text_size(12).text_color(t.dim).child("Looking for folders…")))
        .child(v_flex().gap(6).children(shown.flatMap((r, k) => {
          const el = this.row(t, r, start + k === at, start + k);
          // Goal step: the suggestions sit under a label, after the Continue row.
          return this.step === "goal" && r.kind === "continue" && rows.length > 1
            ? [el, div().px(4).pt(10).text_size(11).font_semibold().text_color(t.dim).child("ALREADY A LOOP FOR THIS?")] : [el];
        })))
        .when(rows.length > shown.length, (el) => el.child(div().px(4).text_size(11.5).text_color(t.dim).child(`${rows.length - shown.length} more; keep typing to narrow`))))
      .child(div().flex_1())
      .child(h_flex().pb(22).gap(10).items_center()
        .child(div().text_size(12).text_color(t.dim).child(this.hints()))
        .child(this.keysHelp.button()))
      .when(Boolean(help), (el) => el.child(help));
  }
}
