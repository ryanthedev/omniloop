// Omniloop: your work as loops, not spaces. Each loop shows its lead (or "you"), its goal and its members as a
// tree; a chip marks what's for you. Data comes live from terminals() (labels) plus the watcher's small state
// file (~/.cache/omniloop/state.json); this mod runs no hc commands, so it stays cheap in the shared engine.
// Rules: core/omniloop.js; what's drawn: core/view.js. Each loop's goal is read from its folder
// (~/loops/<id>/loop.json, the one source of truth) and shown as a paragraph under the loop's name; its tasks
// (tasks.json) follow: yours as a checklist (click to finish), then each agent's.
//
// Chat: one local loop's feed (~/loops/<id>/feed.jsonl) is docked at the bottom as a chat; Enter in its box runs
// `omniloop reply` (posts as you, delivers to the loop's lead or holds it for the watcher). The pane runs no hc.
//
// Sound: off by default, because the app's own blocked sound still plays for every agent. Turn this on
// (click "sound") once settings.json sounds.blocked is off: then only alerts for you make a sound.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { terminals, theme, run, exec, home, readTextFile, watchFolder, playSound, shared, setShared, focused } from "herdr";
import { buildView, alertKey } from "./core/view.js";
import { openGoals } from "./core/goals.js";
import { openTasks } from "./core/tasks.js";
import { BIN } from "./config.js";
import { KEYS } from "./core/keys.js";
import { chatRows, chatThreads, parseFeed, FEED_FILE } from "./core/feed.js";
import { Help, isHelpKey } from "./help/help.js";

const SOUND_KEY = "omniloop.sound";
const CHAT_SHOWN = 40;   // newest messages drawn; the file tail read is 200 lines
const THREADS_SHOWN = 4; // thread tags in the chat header
const isLocal = (id) => !id.includes("/"); // chat is offered for local loops only

export default class Omniloop extends View {
  init(_props, cx) {
    this.dir = `${home()}/.cache/omniloop`;
    this.reload = null;
    this.watcher = null;
    this.heard = null; // alert keys already sounded; null until the first render (no sound at start)
    this.folded = new Set();
    // ? (or the ? chip in the bar) shows every Omniloop control: core/keys.js.
    this.keysHelp = new Help(KEYS, { title: "Omniloop controls", mod: "omniloop", width: 560 });
    this.handle = cx.focus_handle();
    // Test hook: a test home's shared.json {"omniloop.test": {"help": true}} opens it at start.
    if (shared("omniloop.test")?.help) this.keysHelp.open(cx);
    // When you were last in each loop member's terminal (ms), kept across restarts.
    try { this.withYou = JSON.parse(localStorage.getItem("withYou") ?? "{}"); } catch { this.withYou = {}; }
    setShared("omniloop.withYou", this.withYou);
    // Chat. chatPick: the loop you chose (null: the top-ranked local loop); chatId: the one shown now.
    this.chatPick = null; this.chatId = null; this.chatGen = 0;
    this.chat = { entries: [], error: null, notice: null, thread: null };
    this.sending = false;
    // Test hook (test home's shared.json {"omniloop.test": {"chat": "<loop>", "thread": "<tag>"}}): chat shows that
    // local loop by default even with no live terminals, optionally filtered; the window can't be clicked from outside.
    const seed = shared("omniloop.test");
    this.chatSeed = typeof seed?.chat === "string" && isLocal(seed.chat) ? seed.chat : null;
    this.seedThread = typeof seed?.thread === "string" ? seed.thread : null;
    this.input = InputState.new({ placeholder: "Reply to the loop…  (Enter sends)" });
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.goals = {}; // loop id -> open goals, current first (from loop.json)
    this.tasks = {}; // loop id -> { yours, agents } (from tasks.json)
    const load = async () => {
      const raw = await readTextFile(`${this.dir}/state.json`).catch(() => null);
      try { this.watcher = raw ? JSON.parse(raw) : null; } catch { this.watcher = null; }
      // The loop ids come from the last render: terminals() is only filled in while rendering.
      const ids = this.ids ?? [];
      const next = {}, tasks = {};
      for (const id of ids) {
        const m = await readTextFile(`${home()}/loops/${id}/loop.json`).catch(() => null);
        try { if (m) next[id] = openGoals(JSON.parse(m)); } catch {}
        const tf = await readTextFile(`${home()}/loops/${id}/tasks.json`).catch(() => null);
        try { if (tf) tasks[id] = openTasks(JSON.parse(tf)); } catch {}
      }
      this.goals = next; this.tasks = tasks;
    };
    // Instant updates while the folder exists; the folder may not exist yet (watcher never started), so the
    // 15 s timer re-reads the small file too. It also moves heartbeat age and stall times along.
    cx.spawn(async (cx) => {
      await load(); cx.notify();
      for (;;) {
        try { await watchFolder(this.dir); } catch { return; }
        await load(); cx.notify();
      }
    });
    this.reload = (cx) => cx.spawn(async (cx) => { await load(); cx.notify(); });
    cx.timer.every(15000, (cx) => {
      this.reload(cx);
      cx.spawn(async (cx) => { await this.loadChat(); cx.notify(); }); // the chat too: its folder watch may have ended
    });
  }

  // Re-read the chat loop's feed tail. A missing file is an empty chat; any other failure shows as an error line.
  async loadChat() {
    const id = this.chatId;
    if (!id) return;
    let next;
    try {
      const r = await exec("tail", ["-n", "200", `${home()}/loops/${id}/${FEED_FILE}`], { timeout: 10000 });
      if (r.code === 0) next = { entries: parseFeed(r.stdout), error: null };
      else if (/No such file/i.test(r.stderr ?? "")) next = { entries: [], error: null };
      else next = { error: `could not read the feed: ${(r.stderr || `tail exited ${r.code}`).trim()}` };
    } catch (e) { next = { error: `could not read the feed: ${String(e?.message ?? e)}` }; }
    if (id === this.chatId) Object.assign(this.chat, next); // ignore a read that finished after a switch
  }

  // Follow the chat loop's folder: reload on any change, until the chat loop changes (then this loop ends).
  armChat(cx) {
    const gen = ++this.chatGen, id = this.chatId;
    if (!id) return;
    cx.spawn(async (cx) => {
      await this.loadChat(); cx.notify();
      for (;;) {
        // No folder yet (watchFolder throws): this loop ends; the 15 s timer keeps the chat fresh from then on.
        try { await watchFolder(`${home()}/loops/${id}`); } catch { return; }
        if (gen !== this.chatGen) return;
        await this.loadChat(); cx.notify();
      }
    });
  }

  selectChat(id, cx) {
    this.chatPick = id; this.input.set_value(""); cx.notify();
  }

  // Enter in the box: `omniloop reply` posts it as you and delivers or holds it. The box is cleared once the
  // line is in the feed (reply can post and still exit 1, e.g. nobody could be told); on a real failure the typed text stays.
  send(cx) {
    const text = this.input.value().trim(), id = this.chatId;
    if (!text || !id || this.sending) return;
    this.sending = true; this.chat.error = null; this.chat.notice = null;
    const since = Date.now() - 2000;
    cx.spawn(async (cx) => {
      // `--` before the text: a message that starts with "--" must not be read as a flag.
      const args = ["reply", "--loop", id, ...(this.chat.thread ? ["--thread", this.chat.thread] : []), "--", text];
      let out = "", failed = false;
      try {
        const r = await exec(`${BIN}/omniloop`, args, { timeout: 30000 });
        out = (r.stdout || r.stderr || "").trim(); failed = r.code !== 0;
      } catch (e) { out = String(e?.message ?? e); failed = true; }
      await this.loadChat();
      if (id === this.chatId) {
        const landed = this.chat.entries.some((e) => e.from === "you" && e.text === text && e.ts >= since);
        if (landed) this.input.set_value("");
        if (failed) this.chat.error = out || "omniloop reply failed";
        else this.chat.notice = out || null;
      }
      this.sending = false; cx.notify();
    });
  }

  // Being in a loop member's terminal counts as interacting with it; refreshed on every render (at least every 15 s).
  trackFocus(all) {
    const f = focused()?.terminal;
    if (!f) return;
    const t = all.find((x) => x.address === f);
    if (!t?.labels?.omniloop) return;
    const now = Date.now();
    if (now - (this.withYou[f] ?? 0) < 10_000) return;
    this.withYou[f] = now;
    try { localStorage.setItem("withYou", JSON.stringify(this.withYou)); } catch {}
    setShared("omniloop.withYou", this.withYou); // the picker ranks by it too
  }

  sound(forYou) {
    const keys = new Set(forYou.map(alertKey));
    if (this.heard && shared(SOUND_KEY)) {
      const fresh = forYou.find((a) => !this.heard.has(alertKey(a)));
      if (fresh) playSound(fresh.kind === "done" ? "done" : "blocked");
    }
    this.heard = keys;
  }

  dot(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
    if (st === "idle") return div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(2).flex_none().rounded(4).bg(t[st] ?? t.dim);
  }

  chip(t, text, color) {
    return div().flex_none().px(6).h(17).rounded(5).bg(color + "26").text_size(10.5).font_semibold().text_color(color).flex().items_center().child(text);
  }

  row(t, r) {
    return h_flex()
      .id(`ol-${r.address}`)
      .h(24).gap(6).pl(8 + r.depth * 14).pr(8).rounded(5).items_center().text_size(12.5)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { terminal: r.address }))
      .child(this.dot(t, r.status))
      .child(div().flex_1().truncate().text_color(r.forYou ? t.foreground : t.muted).child(`${r.isLead ? "★ " : ""}${r.name}`))
      .when(Boolean(r.kind), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.kind)))
      .when(r.reportsToYou, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.ago ? `you ${r.ago}` : "you: never")))
      .when(Boolean(r.forYou), (el) => el.child(this.chip(t, r.forYou, t.blocked)));
  }

  loop(t, l) {
    const open = !this.folded.has(l.id);
    const head = h_flex()
      .id(`loop-${l.id}`)
      .gap(6).px(8).pt(10).pb(4).items_center().cursor_pointer()
      .on_click((_e, cx) => { open ? this.folded.add(l.id) : this.folded.delete(l.id); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_none().text_size(13.5).font_semibold().text_color(t.foreground).child(l.id))
      .child(div().flex_1())
      .when(isLocal(l.id), (el) => el.child(div().id(`chat-${l.id}`).flex_none().px(6).h(17).rounded(5).cursor_pointer()
        .bg(this.chatId === l.id ? t.accent : t.accent + "26").text_size(10.5).font_semibold()
        .text_color(this.chatId === l.id ? t.background : t.accent).flex().items_center().child("chat")
        .on_click((_e, cx) => { cx.stop_propagation(); this.selectChat(l.id, cx); })))
      .child(div().flex_none().text_size(10.5).text_color(l.ago ? t.muted : t.dim).child(l.ago ? `you ${l.ago}` : "you: never"))
      .when(l.needsYou > 0, (el) => el.child(this.chip(t, `${l.needsYou} for you`, t.blocked)))
      .when(l.handling > 0, (el) => el.child(this.chip(t, `${l.handling} handled in loop`, t.working)))
      .when(!l.lead, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("you lead")));
    const warn = l.warnings.length ? div().px(22).text_size(10.5).text_color(t.blocked).child(l.warnings.join("; ")) : null;
    // The goal, big and whole: loop.json first, else the members' label; a loop without one says so.
    const [cur, ...more] = this.goals[l.id] ?? (l.goal ? [{ n: 0, text: l.goal }] : []);
    const goal = v_flex().flex_none().pl(25).pr(10).pb(6).gap(3)
      .child(cur
        ? div().w_full().text_size(15).text_color(t.foreground).child(cur.text)
        : div().w_full().text_size(12).text_color(t.blocked).child("No goal. Every loop needs one: omniloop goal set \"…\""))
      .children(more.map((g) => div().w_full().text_size(12).text_color(t.muted).child(`also: ${g.text}`)));
    const tk = this.tasks[l.id] ?? { yours: [], agents: [] };
    const nameOf = (a) => l.rows.find((r) => r.address === a)?.name ?? a;
    const tasks = v_flex().flex_none().pl(25).pr(10).pb(6).gap(2)
      .when(tk.yours.length > 0, (el) => el
        .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("YOUR TASKS"))
        .children(tk.yours.map((x) => h_flex().id(`tk-${l.id}-${x.n}`).gap(8).items_start().py(2).cursor_pointer()
          .hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { exec(`${BIN}/omniloop`, ["task", "done", String(x.n), "--loop", l.id], { timeout: 10000 }).then(() => this.reload?.(cx)).catch(() => {}); })
          .child(div().mt(2).size(13).flex_none().rounded(3).border(1.5).border_color(t.accent))
          .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(x.text)))))
      .when(tk.agents.length > 0, (el) => el
        .child(div().pt(tk.yours.length ? 4 : 0).text_size(10.5).font_semibold().text_color(t.dim).child("AGENT TASKS"))
        .children(tk.agents.flatMap((a) => a.tasks.map((x) => h_flex().gap(6).items_start()
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`${a.owner} ${nameOf(a.owner)}`))
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.muted).child(x.text))))));
    return v_flex().flex_none().child(head.flex_none()).child(goal).child(tasks).when(Boolean(warn), (el) => el.child(warn)).when(open, (el) => el.children(l.rows.map((r) => this.row(t, r))));
  }

  // The docked chat: header (loop, all / #thread filter), the newest messages with the newest at the bottom, the box.
  chatSection(t, v) {
    const id = this.chatId;
    const lp = v.loops.find((l) => l.id === id);
    const names = Object.fromEntries((lp?.rows ?? []).map((r) => [r.address, r.name]));
    const entries = this.chat.entries;
    const rows = chatRows(entries, { thread: this.chat.thread, now: Date.now(), names }).slice(-CHAT_SHOWN);
    const setThread = (th, cx) => { this.chat.thread = th; cx.notify(); };
    const tag = (th, key, on) => div().id(key).flex_none().px(5).h(16).rounded(4).cursor_pointer().text_size(10.5).font_semibold()
      .bg(on ? t.accent : t.accent + "22").text_color(on ? t.background : t.accent).flex().items_center()
      .child(`#${th}`)
      .on_click((_e, cx) => setThread(this.chat.thread === th ? null : th, cx));
    const filter = this.chat.thread;
    const header = h_flex().gap(6).px(10).h(26).flex_none().items_center().border_t(1).border_color(t.border ?? t.input)
      .child(div().flex_none().text_size(11).font_semibold().text_color(t.dim).child(`CHAT · ${id}`))
      .child(div().id("chat-all").flex_none().px(5).h(16).rounded(4).cursor_pointer().text_size(10.5).font_semibold()
        .bg(filter ? t.hover : t.accent + "22").text_color(filter ? t.muted : t.accent).flex().items_center().child("all")
        .on_click((_e, cx) => setThread(null, cx)))
      .children(chatThreads(entries).slice(0, THREADS_SHOWN).map((x) => tag(x.thread, `chat-th-${x.thread}`, filter === x.thread)))
      .when(filter && !chatThreads(entries).slice(0, THREADS_SHOWN).some((x) => x.thread === filter), (el) => el.child(tag(filter, "chat-th-cur", true)));
    const color = (r) => (r.mine ? t.accent : r.system ? t.dim : t.foreground);
    const msg = (r, i) => v_flex().flex_none().px(10).py(3).gap(1)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_size(11.5).font_semibold().text_color(color(r)).child(r.who))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(r.age))
        .when(Boolean(r.thread), (el) => el.child(tag(r.thread, `m-th-${i}`, filter === r.thread))))
      .child(div().w_full().text_size(12.5).text_color(r.system ? t.muted : t.foreground).child(r.text));
    const empty = !this.chat.error && rows.length === 0
      ? [div().px(10).py(6).text_size(12).text_color(t.dim).child(filter ? `No messages in #${filter}.` : "No messages yet.")] : [];
    const err = (text, color) => div().px(10).py(3).flex_none().text_size(11.5).text_color(color).child(text);
    return v_flex().flex_none().h(300).child(header)
      // A reversed column that scrolls: its start is the bottom, so the newest message shows and the wheel reaches
      // older ones. Rows are given newest first; a short chat sits at the bottom (justify_start of a reversed column).
      .child(v_flex().id("chat-msgs").flex_col_reverse().flex_auto().min_h(0).overflow_y_scroll()
        .children(rows.map(msg).reverse()).children(empty))
      .when(Boolean(this.chat.error), (el) => el.child(err(this.chat.error, t.blocked)))
      .when(Boolean(this.chat.notice), (el) => el.child(err(this.chat.notice, t.muted)))
      .child(h_flex().flex_none().mx(8).mb(8).mt(4).px(10).h(34).items_center().rounded(8).border(1.5).border_color(t.accent).bg(t.raised)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.input.focus(); })
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .when(Boolean(filter), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`→ #${filter}`))));
  }

  render(cx) {
    const t = theme();
    const all = terminals();
    this.trackFocus(all);
    const ids = [...new Set(all.map((x) => x.labels?.omniloop).filter(Boolean))].sort();
    if (ids.join() !== (this.ids ?? []).join()) { this.ids = ids; this.reload?.(cx); }
    const v = buildView(all, this.watcher, Date.now(), this.withYou);
    this.sound(v.forYou);
    const local = v.loops.filter((l) => isLocal(l.id));
    const chatId = local.find((l) => l.id === this.chatPick)?.id ?? this.chatSeed ?? local[0]?.id ?? null;
    if (chatId !== this.chatId) {
      this.chatId = chatId; this.chat = { entries: [], error: null, notice: null, thread: chatId === this.chatSeed ? this.seedThread : null }; this.armChat(cx);
    }
    const on = Boolean(shared(SOUND_KEY));
    const w = v.watcher;

    const bar = h_flex().gap(8).px(10).h(30).items_center().flex_none().border_b(1).border_color(t.border ?? t.input)
      .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("Omniloop"))
      .child(w.running
        ? div().text_size(10.5).text_color(t.dim).child(`watcher on · ${w.sent} notes`)
        : this.chip(t, `watcher off (${w.why}): loops are silent`, t.blocked))
      .child(div().id("ol-sound").text_size(10.5).px(5).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .text_color(on ? t.foreground : t.dim)
        .on_click((_e, cx) => { setShared(SOUND_KEY, !on); cx.notify(); })
        .child(on ? "sound: mine only" : "sound: off"))
      .child(this.keysHelp.button());

    const body = v.loops.length
      ? v.loops.map((l) => this.loop(t, l))
      : [div().p(14).text_size(12).text_color(t.muted).child("No loops yet. In an agent: omniloop join <loop> --lead")];

    const help = this.keysHelp.panel();
    return v_flex().id("omniloop").relative().size_full().bg(t.background)
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus()) // a click anywhere in the pane lets ? reach it
      // ? opens help while the box is empty (or when focus is elsewhere in the pane); with text in the box it types.
      .on_key_down((e, cx) => {
        const was = this.keysHelp.shown;
        if (!was && isHelpKey(e) && this.input.value().replace(/\?$/, "") !== "") return;
        // Opening: drop the ? the box just took, and move focus off it so help's keys don't type into it.
        if (this.keysHelp.key(e, cx) && !was) cx.timer.after(0, (cx) => { this.input.set_value(this.input.value().replace(/\?$/, "")); this.handle.focus(); cx.notify(); });
      })
      .child(bar)
      .child(v_flex().id("ol-list").flex_auto().min_h(0).px(6).pb(10).overflow_y_scroll().children(body))
      .when(Boolean(this.chatId), (el) => el.child(this.chatSection(t, v)))
      .child(div().px(12).h(22).flex_none().text_size(10.5).text_color(t.dim).flex().items_center()
        .child(`${v.loose} agent${v.loose === 1 ? "" : "s"} in no loop (they reach you as before)`))
      .when(Boolean(help), (el) => el.child(help));
  }
}
