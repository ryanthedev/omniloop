// Omniloop picker: a full-page "what are you working on?". Type a request; your loops are ranked against it
// (core/picker.js rank: words now, a semantic ranker later), most recently worked-in first. Enter on a loop
// jumps to its lead; Enter on "start a new loop" asks for its context (projects that match what you typed come
// pre-ticked, then folders), then runs `omniloop new`.
// Opened by a key (keys.json: "mod.open:omniloop-picker"); mod.json makes it a full-window dialog.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { terminals, theme, run, exec, home, readTextFile, props, closeOverlay, shared } from "herdr";
import { buildView } from "./core/view.js";
import { askRows, folderRows, projectRows, machineRows, newLoopCommand, leadAddress, clampAt } from "./core/picker.js";
import { matchProjects, strongMatches } from "./core/projects.js";
import { BIN } from "./config.js";
import { KEYS } from "./core/keys.js";
import { Help, isHelpKey } from "./help/help.js";

const LOOPS_SHOWN = 7, FOLDERS_SHOWN = 10;
// Context folders on a machine: its repos, plus ~/.config ($HOME is that machine's own).
const FOLDERS_SH = 'find "$HOME/repos" -mindepth 1 -maxdepth 1 -type d ! -name ".*" 2>/dev/null | sort; echo "$HOME/.config"';

export default class OmniloopPicker extends View {
  init(_props, cx) {
    this.step = "ask";          // "ask" | "context" | "creating"
    this.query = "";
    this.at = 0;
    this.fresh = null;          // { id, goal } while choosing context
    this.picked = [];
    this.folders = [];
    this.projects = [];            // every project (omniloop project ls --json)
    this.pickedProjects = [];      // pre-ticked from what you typed
    this.machines = [];            // other machines this computer sees (hc machine ls); none on a machine that sees none
    this.machine = null;           // where the new loop goes: null = this computer
    this.error = null;
    this.watcher = null;
    // ? with an empty box (or the ? chip) shows every Omniloop control: core/keys.js.
    this.keysHelp = new Help(KEYS, { title: "Omniloop controls", mod: "omniloop-picker" });
    this.input = InputState.new({ placeholder: "Describe what you want to do…  (? or the ? button: controls)" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.focus();
    cx.timer.after(400, () => { if (!this.keysHelp.shown) this.input.focus(); });
    // Test hook: a test home's shared.json can pre-fill {"omniloop-picker.test": {query, step, id, goal, picked}}.
    const seed = shared("omniloop-picker.test");
    if (seed) {
      if (seed.step === "context") { this.step = "context"; this.fresh = { id: seed.id, goal: seed.goal }; this.picked = seed.picked ?? []; this.pickedProjects = seed.projects ?? []; }
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
      await this.loadContext(null);
      cx.notify();
    });
  }

  hc() { return `${home()}/.local/bin/hc`; }

  // Context candidates on the chosen machine: its folders and its own projects. Another machine's are read
  // there (hc exec --on), so the lists, and the loop made from them, never carry this computer's paths.
  async loadContext(machine) {
    const on = (script) => machine
      ? exec(this.hc(), ["exec", "--on", machine, "--", "/bin/zsh", "-lc", script], { timeout: 15000 })
      : exec("sh", ["-c", script], { timeout: 10000 });
    this.folders = []; this.projects = [];
    try { this.folders = (await on(FOLDERS_SH)).stdout.split("\n").filter(Boolean); } catch {}
    try {
      const r = machine ? await on("omniloop project ls --json") : await exec(`${BIN}/omniloop`, ["project", "ls", "--json"], { timeout: 10000 });
      this.projects = JSON.parse(r.stdout || "[]");
    } catch {}
  }

  pickMachine(name, cx) {
    if (name === this.machine) return;
    this.machine = name; this.picked = []; this.pickedProjects = []; this.folders = [];
    cx.notify();
    cx.spawn(async (cx) => {
      await this.loadContext(name);
      if (this.machine !== name) return;
      if (this.fresh) this.pickedProjects = strongMatches(matchProjects(this.projects, this.fresh.goal)).map((m) => m.name);
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  view() {
    return buildView(terminals(), this.watcher, Date.now(), shared("omniloop.withYou") ?? {});
  }

  rows() {
    if (this.step === "context") return [...machineRows(this.machines, this.machine), ...projectRows(this.projects, this.query, this.pickedProjects), ...folderRows(this.folders, this.query, this.picked)];
    const loops = this.view().loops;
    return askRows(loops, this.query);
  }

  enter(cx) {
    const rows = this.rows();
    const r = rows[clampAt(this.at, rows.length)];
    if (this.step === "ask") {
      if (!r) return;
      if (r.kind === "loop") {
        const lead = r.loop.lead ?? r.loop.rows[0]?.address;
        this.close();
        if (lead) run("pane.focus", { terminal: lead });
        return;
      }
      if (!r.goal) return; // nothing typed yet
      this.fresh = { id: r.id, goal: r.goal };
      this.step = "context"; this.picked = []; this.at = 0;
      this.pickedProjects = strongMatches(matchProjects(this.projects, r.goal)).map((m) => m.name);
      this.input.set_value("");
      this.query = "";
      cx.notify();
      return;
    }
    if (this.step === "context") this.create(cx);
  }

  toggle(cx) {
    if (this.step !== "context") return;
    const rows = this.rows();
    const r = rows[clampAt(this.at, rows.length)];
    if (!r) return;
    if (r.kind === "machine") { this.pickMachine(r.name, cx); this.at = 0; return; }
    if (r.kind === "project") this.pickedProjects = r.on ? this.pickedProjects.filter((p) => p !== r.name) : [...this.pickedProjects, r.name];
    else this.picked = r.on ? this.picked.filter((p) => p !== r.path) : [...this.picked, r.path];
    this.input.set_value(""); this.query = ""; this.at = 0;
    cx.notify();
  }

  create(cx) {
    const { id, goal } = this.fresh;
    this.step = "creating"; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const machine = this.machine;
        const { cmd, args } = newLoopCommand({ machine, id, goal, projects: this.pickedProjects, dirs: this.picked, bin: BIN, hc: this.hc() });
        const r = await exec(cmd, args, { timeout: 60000 });
        if (r.code === 0) {
          this.close();
          // Made elsewhere: its space opened on that machine; jump to its lead from here.
          const lead = machine ? leadAddress(r.stdout, machine) : null;
          if (lead) run("pane.focus", { terminal: lead });
          return;
        }
        this.error = (r.stderr || r.stdout || `omniloop new exited ${r.code}`).trim();
      } catch (e) { this.error = String(e?.message ?? e); }
      this.step = "context"; cx.notify();
    });
  }

  back(cx) {
    if (this.step === "ask") return this.close();
    this.step = "ask"; this.at = 0;
    this.input.set_value(this.fresh?.goal ?? ""); this.query = this.fresh?.goal ?? "";
    cx.notify();
  }

  // Show a window of `n` rows that keeps the selection in view.
  window(rows, n) {
    const at = clampAt(this.at, rows.length);
    const start = Math.max(0, Math.min(at - Math.floor(n / 2), rows.length - n));
    return { at, start, shown: rows.slice(start, start + n) };
  }

  dot(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900);
    if (!st || st === "idle") return div().size(9).mx(2).flex_none().rounded(5).border(1.5).border_color(t.dim);
    return div().size(9).mx(2).flex_none().rounded(5).bg(t[st] ?? t.dim);
  }

  loopRow(t, r, on, i) {
    if (r.kind === "new") {
      return h_flex().id(`pk-new`).h(60).px(18).gap(14).items_center().rounded(12).cursor_pointer()
        .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
        .on_click((_e, cx) => { this.at = i; this.enter(cx); })
        .child(div().size(22).flex_none().rounded(6).bg(t.accent + "26").text_color(t.accent).text_size(15).font_bold().flex().items_center().justify_center().child("+"))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(r.goal ? `Start a new loop: ${r.goal}` : "Start a new loop"))
          .child(div().text_size(12).text_color(t.dim).truncate().child(r.id ? `~/loops/${r.id} · its own space and lead` : "Type what you want to do first")));
    }
    const l = r.loop;
    const members = l.rows.length;
    return h_flex().id(`pk-${l.id}`).h(60).px(18).gap(14).items_center().rounded(12).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => { this.at = i; this.enter(cx); })
      .child(this.dot(t, l.status))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(l.id))
          .when(l.needsYou > 0, (el) => el.child(div().px(6).h(17).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child(`${l.needsYou} for you`))))
        .child(div().text_size(12.5).text_color(t.muted).truncate().child(l.goal ?? "")))
      .child(v_flex().flex_none().items_end().gap(2)
        .child(div().text_size(11.5).text_color(l.ago ? t.muted : t.dim).child(l.ago ? `you ${l.ago}` : "you: never"))
        .child(div().text_size(11).text_color(t.dim).child(`${members} session${members === 1 ? "" : "s"}`)));
  }

  projectRow(t, r, on, i) {
    return h_flex().id(`pp-${r.name}`).h(52).px(16).gap(12).items_center().rounded(10).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => { this.at = i; this.toggle(cx); })
      .child(div().size(16).flex_none().rounded(4).border(1.5).border_color(r.on ? t.accent : t.dim).bg(r.on ? t.accent : t.background)
        .text_size(11).font_bold().text_color(t.background).flex().items_center().justify_center().child(r.on ? "✓" : ""))
      .child(div().flex_none().px(6).h(18).rounded(5).bg(t.accent + "22").text_size(10.5).font_semibold().text_color(t.accent).flex().items_center().child("PROJECT"))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(14).font_semibold().text_color(r.on ? t.foreground : t.muted).child(r.name))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(r.description)));
  }

  machineRow(t, r, on, i) {
    return h_flex().id(`pm-${r.label}`).h(40).px(16).gap(12).items_center().rounded(10).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => { this.at = i; this.toggle(cx); })
      .child(div().size(16).flex_none().rounded(8).border(1.5).border_color(r.on ? t.accent : t.dim).bg(r.on ? t.accent : t.background))
      .child(div().flex_none().px(6).h(18).rounded(5).bg(t.accent + "22").text_size(10.5).font_semibold().text_color(t.accent).flex().items_center().child("MACHINE"))
      .child(div().flex_1().text_size(14).font_semibold().text_color(r.on ? t.foreground : t.muted).child(r.label));
  }

  folderRow(t, r, on, i) {
    return h_flex().id(`pf-${r.path}`).h(40).px(16).gap(12).items_center().rounded(10).cursor_pointer()
      .bg(on ? t.raised : t.background).border(1).border_color(on ? t.accent : t.background)
      .on_click((_e, cx) => { this.at = i; this.toggle(cx); })
      .child(div().size(16).flex_none().rounded(4).border(1.5).border_color(r.on ? t.accent : t.dim).bg(r.on ? t.accent : t.background)
        .text_size(11).font_bold().text_color(t.background).flex().items_center().justify_center().child(r.on ? "✓" : ""))
      .child(div().flex_none().text_size(14).font_semibold().text_color(r.on ? t.foreground : t.muted).child(r.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.path));
  }

  render(cx) {
    const t = theme();
    const rows = this.rows();
    const ctx = this.step !== "ask";
    const { at, start, shown } = this.window(rows, ctx ? FOLDERS_SHOWN : LOOPS_SHOWN);
    this.at = at;

    const title = ctx ? `Context for ${this.fresh.id}${this.machine ? ` on ${this.machine}` : ""}` : "What are you working on?";
    const sub = ctx ? this.fresh.goal : "Pick up a loop, or describe something new.";
    const hints = this.step === "creating" ? `Creating the loop, its space and its lead${this.machine ? ` on ${this.machine}` : ""}…`
      : ctx ? `↑↓ move · Tab ${this.machines.length ? "pick the machine, or " : ""}add or remove (as many as you like) · Enter create with ${this.pickedProjects.length ? `${this.pickedProjects.join(", ")} + ` : ""}${this.picked.length} folder${this.picked.length === 1 ? "" : "s"} · Esc back`
        : "↑↓ move · Enter open · Esc close";

    const list = shown.map((r, k) => !ctx ? this.loopRow(t, r, start + k === at, start + k)
      : r.kind === "machine" ? this.machineRow(t, r, start + k === at, start + k)
      : r.kind === "project" ? this.projectRow(t, r, start + k === at, start + k) : this.folderRow(t, r, start + k === at, start + k));

    const help = this.keysHelp.panel();
    // While help is open the root holds focus (so keys don't type into the box); give it back when help closes.
    // Focus can't change during render, so it moves on the next tick.
    if (Boolean(this.helpWas) !== this.keysHelp.shown) {
      const toHelp = this.keysHelp.shown;
      cx.timer.after(0, () => (toHelp ? this.handle.focus() : this.input.focus()));
    }
    this.helpWas = this.keysHelp.shown;
    return v_flex().id("omniloop-picker").relative().track_focus(this.handle).size_full().bg(t.background).items_center()
      .on_key_down((e, cx) => {
        // Help open: it takes every key (Esc closes it, not the picker). Closed: ? opens it only while the box
        // is empty, so a request can still contain "?"; the ? it typed is cleared.
        if (this.keysHelp.shown) { this.keysHelp.key(e, cx); return; }
        if (isHelpKey(e) && this.query.replace(/\?$/, "") === "") {
          this.keysHelp.open(cx); cx.stop_propagation();
          cx.timer.after(0, (cx) => { this.input.set_value(""); this.query = ""; cx.notify(); });
          return;
        }
        const k = e.key;
        if (k === "escape") return this.back(cx);
        if (k === "down" || (k === "n" && e.modifiers.control)) this.at = (at + 1) % Math.max(1, rows.length);
        else if (k === "up" || (k === "p" && e.modifiers.control)) this.at = (at + Math.max(1, rows.length) - 1) % Math.max(1, rows.length);
        else if (k === "tab") return (cx.stop_propagation(), this.toggle(cx));
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(v_flex().w_full().max_w(760).px(32).pt(96).gap(18)
        .child(div().text_size(11).font_semibold().text_color(t.dim).child("OMNILOOP"))
        .child(v_flex().gap(6)
          .child(div().text_size(30).font_semibold().text_color(t.foreground).child(title))
          .child(div().text_size(14).text_color(t.muted).truncate().child(sub)))
        .child(h_flex().h(54).px(18).gap(12).items_center().rounded(14).border(1.5).border_color(t.accent).bg(t.raised)
          .child(svg("mods/workspace-chrome/search.svg").size(18).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(18).text_color(t.foreground)))
        .when(Boolean(this.error), (el) => el.child(div().px(4).text_size(12).text_color(t.blocked).child(this.error)))
        .when(ctx && this.folders.length === 0, (el) => el.child(div().px(4).text_size(12).text_color(t.dim).child("Looking for folders…")))
        .child(v_flex().gap(6).children(list))
        .when(rows.length > shown.length, (el) => el.child(div().px(4).text_size(11.5).text_color(t.dim).child(`${rows.length - shown.length} more; keep typing to narrow`))))
      .child(div().flex_1())
      .child(h_flex().pb(22).gap(10).items_center()
        .child(div().text_size(12).text_color(t.dim).child(hints))
        .child(this.keysHelp.button()))
      .when(Boolean(help), (el) => el.child(help));
  }
}
