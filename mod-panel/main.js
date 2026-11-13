// Omniloop panel: a docked, keyboard-driven view of your loops, beside the terminals. Two views:
//   1 Loop  the current loop: goal(s), your todo, the agents' tasks, members, context (folders, projects)
//   2 All   every loop on this machine, plus live ones from other machines; / filters
// The rules (rows, cursor, keys) are in core/panel.js, tested; this file draws rows and runs actions.
//
// Dock it as a layout block {"id": "omniloop-dock", "type": "block", "size": {"px": 380}, "resizable": true,
// "content": {"mod": "omniloop-panel", "props": {"dock": true}}}. It takes the keyboard only when sent there:
// pane.go (moving between blocks) or `omniloop-panel.focus`. It never focuses itself at start, so it can't steal
// the keyboard on launch or reload. Esc hands the keyboard back to the terminal you were in.
//
// Data: terminals() (live loops, via buildView), the watcher's state file, and bin/panel-loops.mjs, which lists
// every ~/loops/<id> (a mod can't list folders). Read on start, every 10 s while shown, and right after an action.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { terminals, focused, theme, run, exec, home, readTextFile, props, layout, nextCommand, shared } from "herdr";
import { buildView } from "./core/view.js";
import { onMachine, loopOfTerminal, splitLoop, allLoops, currentLoop, loopRows, allRows, chooserRows, cursorRow, step, keyName, initialState } from "./core/panel.js";
import { shq } from "./core/loopdir.js";
import { KEYS } from "./core/keys.js";
import { Help, isHelpKey } from "./help/help.js";
import { BIN } from "./config.js";

const MOD = "omniloop-panel";
const TICK_MS = 10000;
const REMOTE_EVERY = 3; // other machines are read every third tick (30 s), each over hc exec
// Another machine runs its own copy of this repo (the omniloop wrapper there points at it).
// Context folders on a machine (as the picker offers them): its repos, plus ~/.config.
const FOLDERS_SH = 'find "$HOME/repos" -mindepth 1 -maxdepth 1 -type d ! -name ".*" 2>/dev/null | sort; echo "$HOME/.config"';
const REMOTE_LOOPS = 'exec node "$HOME/repos/omniloop/bin/panel-loops.mjs"';
const LOOP_ROW = 46; // the All list's row height (two lines)

export default class OmniloopPanel extends View {
  init(_props, cx) {
    this.uid = Math.random().toString(36).slice(2, 8);
    this.s = initialState();
    this.disk = [];          // panel-loops.mjs output: this computer's, then each other machine's ("m1/x")
    this.local = []; this.remote = {}; this.remoteErr = {}; this.machines = []; this.ticks = 0;
    this.diskErr = null;
    this.watcher = null;
    this.lastTerm = null;    // the last terminal you were in: focus in a mod (this one) keeps it
    this.note = null;        // one line about the last action ("done: …", or an error)
    this.cands = [];         // the add chooser's candidates: [{ value, text, note }]
    // ? (or the ? chip) shows every Omniloop control, this panel's first in the list (core/keys.js).
    this.keysHelp = new Help(KEYS, { title: "Omniloop controls", mod: MOD, width: 520 });
    this.handle = cx.focus_handle(); // never focused in init: a dock must not steal the keyboard
    this.scroll = VirtualListScrollHandle.new();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // Test hooks too: "help" opens the controls, "add-project" / "add-dir" the chooser for the loop shown.
        if (!["focus", "all", "loop", "help", "add-project", "add-dir"].includes(c)) continue;
        if (props()?.dock && this.hidden()) run("layout.show", { id: this.blockId() ?? "omniloop-dock" });
        if (c === "all" || c === "loop") this.s = { ...this.s, view: c };
        if (c === "help" && !this.keysHelp.shown) this.keysHelp.open(cx);
        if (c === "add-project" || c === "add-dir") { const ctx = this.context(); this.key({ key: c === "add-dir" ? "a" : "p", modifiers: {} }, cx, ctx); }
        this.handle.focus();
        this.watchFocus(cx);
        this.load(cx);
        cx.notify();
      }
    });
    this.load(cx);
    cx.timer.every(TICK_MS, (cx) => { if (!(props()?.dock && this.hidden())) this.load(cx); });
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("node", [`${BIN}/panel-loops.mjs`], { timeout: 10000 });
        this.local = JSON.parse(r.stdout || "[]"); this.diskErr = null;
      } catch (e) { this.diskErr = `can't list ~/loops: ${String(e?.message ?? e).slice(0, 120)}`; }
      if (this.ticks++ % REMOTE_EVERY === 0) await this.loadRemote();
      this.disk = [...this.local, ...this.machines.flatMap((m) => this.remote[m] ?? [])];
      const raw = await readTextFile(`${home()}/.cache/omniloop/state.json`).catch(() => null);
      try { this.watcher = raw ? JSON.parse(raw) : null; } catch { this.watcher = null; }
      this.loading = false;
      cx.notify();
    });
  }

  hc() { return `${home()}/.local/bin/hc`; }

  // The omniloop command, here or on the loop's machine (there through a login shell, every word quoted).
  omniloop(machine, args) {
    return machine
      ? exec(this.hc(), ["exec", "--on", machine, "--", "/bin/zsh", "-lc", ["omniloop", ...args].map(shq).join(" ")], { timeout: 20000 })
      : exec(`${BIN}/omniloop`, args, { timeout: 15000 });
  }

  // The add chooser's candidates, read on the loop's machine: its projects, or its folders.
  loadChoices(kind, loop, cx) {
    const { machine } = splitLoop(loop);
    this.cands = []; this.candsErr = null; this.candsLoading = true;
    cx.spawn(async (cx) => {
      try {
        if (kind === "project") {
          const r = await this.omniloop(machine, ["project", "ls", "--json"]);
          this.cands = JSON.parse(r.stdout || "[]").map((p) => ({ value: p.name, text: p.name, note: p.description ?? "" }));
        } else {
          const r = machine
            ? await exec(this.hc(), ["exec", "--on", machine, "--", "/bin/zsh", "-lc", FOLDERS_SH], { timeout: 20000 })
            : await exec("sh", ["-c", FOLDERS_SH], { timeout: 10000 });
          const h = machine ? null : home();
          this.cands = r.stdout.split("\n").filter(Boolean).map((f) => ({ value: f, text: h && f.startsWith(h) ? `~${f.slice(h.length)}` : f }));
        }
      } catch (e) { this.candsErr = String(e?.message ?? e).slice(0, 100); }
      this.candsLoading = false;
      cx.notify();
    });
  }

  // Other machines' loops, read there (hc exec --on), all at once; one that fails keeps its last list.
  async loadRemote() {
    try {
      const r = await exec(this.hc(), ["machine", "ls", "--json"], { timeout: 10000 });
      this.machines = (JSON.parse(r.stdout || "{}").machines ?? []).filter((m) => m.state === "connected").map((m) => m.name);
    } catch { return; }
    await Promise.all(this.machines.map(async (m) => {
      try {
        const r = await exec(this.hc(), ["exec", "--on", m, "--", "/bin/zsh", "-lc", REMOTE_LOOPS], { timeout: 20000 });
        this.remote[m] = onMachine(JSON.parse(r.stdout || "[]"), m); delete this.remoteErr[m];
      } catch (e) { this.remoteErr[m] = String(e?.message ?? e).slice(0, 80); }
    }));
  }

  // The layout block holding this mod (and whether it, or a parent, is hidden).
  findBlock() {
    let found = null;
    const walk = (n, h) => {
      if (!n || typeof n !== "object" || found) return;
      const hid = h || Boolean(n.hidden);
      if (n.content?.mod === MOD) { found = { id: n.id, hidden: hid }; return; }
      for (const c of n.children ?? []) walk(c, hid);
    };
    try { walk(layout(), false); } catch {}
    return found;
  }
  hidden() { return this.findBlock()?.hidden === true; }
  blockId() { return this.findBlock()?.id ?? null; }

  // GPUI says nothing when a plain element loses the keyboard; while the panel has it, look every 400 ms and
  // redraw once when it's gone, so the cursor stops looking active.
  watchFocus(cx) {
    if (this.watching) return;
    this.watching = true;
    const look = () => cx.timer.after(400, () => {
      if (this.handle.is_focused()) return look();
      this.watching = false;
      cx.notify();
    });
    look();
  }

  leave() {
    if (this.lastTerm) run("pane.focus", { terminal: this.lastTerm });
  }

  act(a, ctx, cx) {
    if (!a) return;
    if (a.type === "leave") return this.leave();
    if (a.type === "jump" && a.terminal) return run("pane.focus", { terminal: a.terminal });
    if (a.type === "note") { this.note = a.text; return; }
    if (a.type === "open-file") {
      // Beside the terminal you were in: a markdown pane (herdr-md).
      try { run("pane.split", { direction: "right", mod: "herdr-md", props: { file: a.path }, ...(this.lastPane ? { pane: this.lastPane } : {}) }); }
      catch (e) { this.note = `couldn't open ${a.path}: ${String(e?.message ?? e).slice(0, 80)}`; }
      return;
    }
    if (a.type === "choose") return this.loadChoices(a.kind, a.loop, cx);
    if (a.type === "add-project" || a.type === "add-dir") {
      const { machine, id } = splitLoop(a.loop);
      const args = a.type === "add-project" ? ["project", "add", a.value, "--loop", id] : ["add-dir", a.value, "--loop", id];
      this.note = `adding ${a.value} to ${a.loop}…`;
      cx.spawn(async (cx) => {
        try {
          const r = await this.omniloop(machine, args);
          this.note = (r.stdout || r.stderr || "").trim().split("\n")[0] || `added ${a.value}`;
        } catch (e) { this.note = `couldn't add ${a.value}: ${String(e?.stderr || e?.message || e).trim().slice(0, 120)}`; }
        this.ticks = 0; this.load(cx); cx.notify();
      });
      return;
    }
    if (a.type === "lead") {
      const id = a.loop ?? ctx.cur;
      const lead = a.terminal ?? ctx.loops.find((l) => l.id === id)?.lead;
      if (lead) return run("pane.focus", { terminal: lead });
      this.note = `${id ?? "this loop"} has no live lead`; return;
    }
    if (a.type === "done") {
      const { machine, id } = splitLoop(a.loop);
      const args = ["task", "done", String(Number(a.n)), "--loop", id];
      cx.spawn(async (cx) => {
        try {
          // On another machine, its own omniloop finishes it there (the id passed validId there, so it's safe in a shell line).
          const r = await this.omniloop(machine, args);
          this.note = (r.stdout || r.stderr || "").trim().split("\n")[0] || `done: ${a.n}`;
        } catch (e) { this.note = `couldn't finish task ${a.n}: ${String(e?.message ?? e).slice(0, 100)}`; }
        this.ticks = 0; this.load(cx); cx.notify();
      });
    }
  }

  // Everything the views need. terminals() and focused() are read only while rendering (they may be empty in
  // event handlers), and kept, so a key or click works on the same loops the panel last drew.
  context(fresh = false) {
    if (fresh || !this.terms) {
      this.terms = terminals();
      const fo = focused(), f = fo?.terminal ?? null;
      if (f) { this.lastTerm = f; this.lastPane = fo?.pane ?? null; }
    }
    const all = this.terms;
    const live = buildView(all, this.watcher, Date.now(), shared("omniloop.withYou") ?? {}).loops;
    const loops = allLoops(this.disk, live);
    const focusedLoop = this.lastTerm ? loopOfTerminal(all, this.lastTerm) : null;
    const cur = currentLoop(this.s, loops, focusedLoop);
    const disk = this.disk.find((d) => d.id === cur) ?? null;
    const have = !this.s.adding ? [] : this.s.adding.kind === "project"
      ? (this.disk.find((d) => d.id === this.s.adding.loop)?.projects ?? []).map((p) => (typeof p === "string" ? p : p.name))
      : (this.disk.find((d) => d.id === this.s.adding.loop)?.dirs ?? []).map((d) => d.path);
    const rows = this.s.adding ? chooserRows(this.s.adding, this.cands, have)
      : this.s.view === "all" ? allRows(loops, this.s.query)
      : loopRows(cur, disk, live.find((l) => l.id === cur) ?? null, this.s.open);
    return { loops, live, cur, rows, focusedLoop, addable: disk ? cur : null };
  }

  key(e, cx, given = null) {
    // ? opens the controls, except while you type into the filter or the chooser (there it's a letter).
    const typing = this.s.filtering || this.s.adding;
    if (this.keysHelp.shown || (!typing && isHelpKey(e))) { if (this.keysHelp.key(e, cx)) return; }
    const k = keyName(e);
    if (!k) return;
    const ctx = given ?? this.context();
    const r = step({ ...this.s, addable: ctx.addable }, k, ctx.rows);
    this.s = r.state;
    if (r.action?.type !== "done") this.note = null;
    cx.stop_propagation?.(); // absent when a command (not a key) drives it
    this.act(r.action, ctx, cx);
    if (this.s.view === "all") { const n = this.context().rows; const at = cursorRow(n, this.s.sel.all); if (at >= 0) this.scroll.scroll_to_item(at); }
    cx.notify();
  }

  // ---- drawing ----

  tab(t, label, view, active, typing) {
    const on = this.s.view === view;
    return div().id(`pv-${view}-${this.uid}`).px(8).h(22).rounded(5).flex().items_center().cursor_pointer()
      .text_size(11.5).font_semibold()
      .bg(on ? (typing ? t.accent + "33" : t.hover) : t.background)
      .text_color(on ? t.foreground : t.dim)
      .on_click((_e, cx) => { this.s = { ...this.s, view }; cx.notify(); })
      .child(label);
  }

  statusColor(t, s) {
    return s === "working" ? t.working ?? t.accent : s === "blocked" ? t.blocked : s === "done" ? t.done ?? t.accent : t.dim;
  }

  rowEl(t, r, i, selected, typing) {
    const band = selected ? (typing ? t.accent + "33" : t.hover) : null;
    const base = (el) => el.px(10).when(Boolean(band), (x) => x.bg(band)).when(selected && typing, (x) => x.border_l(2).border_color(t.accent));
    switch (r.kind) {
      case "head": return h_flex().px(10).pt(14).pb(4).gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(10.5).font_semibold().text_color(t.dim).child(r.text))
        .when(Boolean(r.hint), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.hint)));
      case "empty": return div().px(10).py(3).text_size(12).text_color(t.dim).child(r.text);
      case "goal": return base(div().py(3)).text_size(r.current ? 15 : 12.5).font_semibold().text_color(r.current ? t.foreground : t.muted).child(r.text);
      case "todo": return base(h_flex().id(`pr-${i}-${this.uid}`).py(3).gap(8).items_start().cursor_pointer())
        .on_click((_e, cx) => this.act({ type: "done", loop: r.loop, n: r.n }, this.context(), cx))
        .child(div().flex_none().mt(1).w(13).h(13).rounded(3).border(1.5).border_color(t.accent))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(r.text))
        .when(r.by && r.by !== "you", (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`from ${r.by}`)));
      case "task": return base(h_flex().py(2).gap(8).items_start())
        .child(div().flex_none().w(40).text_size(10.5).text_color(t.dim).child(r.owner))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child(r.text));
      case "member": return base(h_flex().id(`pr-${i}-${this.uid}`).py(2).gap(6).items_center().cursor_pointer())
        .on_click(() => run("pane.focus", { terminal: r.terminal }))
        .child(div().flex_none().w(r.depth * 12))
        .child(div().flex_none().w(7).h(7).rounded(4).bg(this.statusColor(t, r.status)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.address))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${r.text}${r.isLead ? " ★" : ""}`))
        .when(Boolean(r.forYou), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(r.forYou)))
        .when(!r.forYou && Boolean(r.ago), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.ago)));
      case "dir": case "project": case "notes": {
        // Line 1: its name, big, so you can find it. Line 2: where it is (dim), and what instructions it carries.
        const where = r.kind === "dir" && r.machine ? `on ${r.machine} · ${r.where}` : r.where;
        const insColor = r.ins.state === "has" ? t.accent : t.dim;
        const icon = r.kind === "project" ? "◆" : r.kind === "notes" ? "✎" : "▣";
        return base(v_flex().id(`pr-${i}-${this.uid}`).py(5).gap(2).cursor_pointer())
          .on_click((_e, cx) => { this.s = { ...this.s, open: { ...this.s.open, [r.key]: !this.s.open[r.key] } }; cx.notify(); })
          .child(h_flex().gap(6).items_center()
            .child(div().flex_none().w(10).text_size(11).text_color(t.dim).child(this.s.open[r.key] ? "▾" : "▸"))
            .child(div().flex_none().text_size(11).text_color(r.kind === "project" ? t.accent : t.dim).child(icon))
            .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(r.name ?? r.text)))
          .child(h_flex().pl(32).gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(where ?? ""))
            .child(div().flex_none().text_size(11).text_color(insColor).child(r.ins.text)));
      }
      case "file": return base(h_flex().id(`pr-${i}-${this.uid}`).py(1).pl(42).gap(6).items_center().when(Boolean(r.path), (x) => x.cursor_pointer()))
        .when(Boolean(r.path) && r.local, (el) => el.on_click(() => this.act({ type: "open-file", path: r.path }, this.context(), null)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(r.path ? "·" : ""))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(r.path ? t.muted : t.dim).child(r.text));
      case "choice": return base(v_flex().py(3).gap(1))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(r.have ? t.dim : t.foreground).child(r.text))
          .when(r.have, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("already in"))))
        .when(Boolean(r.note), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(r.note)));
      default: return div();
    }
  }

  chooserView(t, ctx) {
    const a = this.s.adding;
    const at = cursorRow(ctx.rows, a.sel ?? 0);
    const what = a.kind === "project" ? "a project" : "a folder";
    const head = v_flex().px(10).pt(10).pb(6).gap(4).flex_none().border_b(1).border_color(t.border ?? t.input)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(`Add ${what} to ◎ ${a.loop}`))
      .child(h_flex().h(28).px(8).gap(6).items_center().rounded(6).border(1).border_color(t.accent).bg(t.raised ?? t.background)
        .child(div().text_size(12).text_color(t.dim).child("⌕"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(a.q ? t.foreground : t.dim)
          .child(a.q ? `${a.q}▏` : a.kind === "dir" ? "type to filter, or a path (~/… or /…)▏" : "type to filter▏")))
      .child(div().text_size(10.5).text_color(t.dim).child("↑↓ move · ⏎ add · esc cancel · the panel can't remove one yet"));
    const body = this.candsLoading ? [div().px(10).py(6).text_size(12).text_color(t.dim).child("Reading…")]
      : this.candsErr ? [div().px(10).py(6).text_size(12).text_color(t.blocked).child(`Couldn't read the list: ${this.candsErr}`)]
      : ctx.rows.map((r, i) => this.rowEl(t, r, i, i === at, true));
    return v_flex().flex_1().min_h(0).child(head).child(v_flex().id(`pc-${this.uid}`).flex_1().min_h(0).overflow_y_scroll().pb(10).children(body));
  }

  loopView(t, ctx, typing) {
    const at = cursorRow(ctx.rows, this.s.sel.loop);
    const cur = ctx.loops.find((l) => l.id === ctx.cur);
    const why = !ctx.cur ? "" : this.s.pinned === ctx.cur ? "picked · f follows your terminal" : ctx.cur === ctx.focusedLoop ? "follows your terminal" : "top of the list";
    const title = h_flex().px(10).pt(10).gap(6).items_center()
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.accent).child(ctx.cur ? `◎ ${ctx.cur}` : "No loop"))
      .when(Boolean(cur?.lead), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`lead ${cur.lead}`)))
      .when((cur?.needsYou ?? 0) > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(`${cur.needsYou} for you`)));
    return v_flex().id(`pl-${this.uid}`).flex_1().min_h(0).overflow_y_scroll().pb(10)
      .child(title)
      .child(div().px(10).text_size(10.5).text_color(t.dim).child(why))
      .children(ctx.rows.map((r, i) => this.rowEl(t, r, i, i === at, typing)));
  }

  allView(t, ctx, typing) {
    const rows = ctx.rows;
    const at = cursorRow(rows, this.s.sel.all);
    const filter = h_flex().px(10).h(28).flex_none().items_center().gap(6).border_b(1).border_color(t.border ?? t.input)
      .child(div().text_size(12).text_color(this.s.filtering ? t.accent : t.dim).child("/"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.s.query ? t.foreground : t.dim)
        .child(this.s.query ? `${this.s.query}${this.s.filtering ? "▏" : ""}` : this.s.filtering ? "▏" : `filter ${ctx.loops.length} loops`));
    if (rows[0]?.kind === "empty") return v_flex().flex_1().min_h(0).child(filter).child(this.rowEl(t, rows[0], 0, false, typing));
    const item = (i) => {
      const l = rows[i].loop, sel = i === at;
      const meta = [l.lead ? `lead ${l.lead}` : l.live ? "you lead" : "no live terminals", l.yours ? `${l.yours} todo` : "", l.agentTasks ? `${l.agentTasks} tasks` : "", l.ago ?? ""].filter(Boolean).join(" · ");
      return v_flex().id(`pa-${i}-${this.uid}`).h(LOOP_ROW).px(10).justify_center().gap(1)
        .when(sel, (x) => x.bg(typing ? t.accent + "33" : t.hover)).when(sel && typing, (x) => x.border_l(2).border_color(t.accent))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().w(6).h(6).rounded(3).bg(l.needsYou ? t.blocked : l.live ? t.accent : t.border ?? t.dim))
          .child(div().flex_none().text_size(12.5).font_semibold().text_color(l.id === ctx.cur ? t.accent : t.foreground).child(l.id))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(l.goal))
          .when(l.needsYou > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(`${l.needsYou} for you`))))
        .child(div().pl(12).truncate().text_size(10.5).text_color(t.dim).child(meta));
    };
    const list = div().flex_1().min_h(0).w_full().child(v_virtual_list(`pal-${this.uid}`, rows.length, LOOP_ROW, (i) => rows[i].text, (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) out.push(item(i));
      return out;
    }).track_scroll(this.scroll).size_full()
      .on_item_click((k, cx) => {
        const i = rows.findIndex((r) => r.text === k);
        if (i < 0) return;
        this.s = { ...this.s, sel: { ...this.s.sel, all: i }, pinned: k, view: "loop" };
        this.s.sel.loop = 0;
        cx.notify();
      }));
    return v_flex().flex_1().min_h(0).child(filter).child(list);
  }

  render(_cx) {
    const t = theme();
    const typing = this.handle.is_focused();
    const ctx = this.context(true);
    const bar = h_flex().px(8).h(32).flex_none().gap(4).items_center().border_b(1).border_color(t.border ?? t.input)
      .child(div().flex_none().pr(4).text_size(12.5).font_semibold().text_color(t.foreground).child("Omniloop"))
      .child(this.tab(t, "1 Loop", "loop", true, typing))
      .child(this.tab(t, `2 All (${ctx.loops.length})`, "all", true, typing))
      .child(div().flex_1())
      .child(div().text_size(10).text_color(typing ? t.accent : t.dim).child(typing ? "keys: on" : "keys: off"))
      .child(this.keysHelp.button());
    const hint = typing
      ? (this.s.view === "all" ? "j/k move · ⏎ open · / filter · o lead · tab view · esc back" : "j/k move · ⏎ open/jump · x finish · a/p add · ? help · esc back")
      : "click a row, or focus the panel for keys";
    const foot = v_flex().flex_none().px(10).py(4).gap(1).border_t(1).border_color(t.border ?? t.input)
      .when(Boolean(this.note), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(this.note)))
      .when(Object.keys(this.remoteErr).length > 0, (el) => el.child(div().truncate().text_size(11).text_color(t.dim)
        .child(`can't read loops on ${Object.keys(this.remoteErr).join(", ")} (showing the last list)`)))
      .when(Boolean(this.diskErr), (el) => el.child(div().truncate().text_size(11).text_color(t.blocked).child(this.diskErr)))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(hint));
    const help = this.keysHelp.panel();
    const root = v_flex().id(`omniloop-panel-${this.uid}`).relative().size_full().bg(t.surface ?? t.background).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx));
    // Herdr's own UI font, not the terminal's: a monospace font spaces out punctuation ("CLAUDE .md") and makes
    // dense rows hard to read. The picker and the other omniloop mods draw in the UI font too.
    return root
      .child(bar)
      .child(this.s.adding ? this.chooserView(t, ctx) : this.s.view === "all" ? this.allView(t, ctx, typing) : this.loopView(t, ctx, typing))
      .child(foot)
      .when(Boolean(help), (el) => el.child(help));
  }
}
