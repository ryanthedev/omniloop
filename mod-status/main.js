// Loop status: a status bar block for the terminal you're in. In a loop it reads
//   ◎ plenary-m2  Ship Plenary M2 · t187 manager platform · reports to t1bx proxy · coordinator: you · 2 for you
// and outside every loop: "t3s zsh · not in a loop · ⌘O". Click: open the omniloop picker.
// Data: terminals() and focused(); "for you" includes the watcher's stalls (its state file).

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { terminals, focused, theme, run, home, readTextFile, shared } from "herdr";
import { whoIs } from "./core/view.js";

export default class LoopStatus extends View {
  init(_props, cx) {
    this.watcher = null;
    this.last = null; // the last terminal you were in: focus in a mod keeps it
    const load = async () => {
      const raw = await readTextFile(`${home()}/.cache/omniloop/state.json`).catch(() => null);
      try { this.watcher = raw ? JSON.parse(raw) : null; } catch { this.watcher = null; }
    };
    cx.spawn(async (cx) => { await load(); cx.notify(); });
    cx.timer.every(15000, (cx) => { cx.spawn(async (cx) => { await load(); cx.notify(); }); });
  }

  render() {
    const t = theme();
    const f = focused()?.terminal ?? null;
    if (f) this.last = f;
    const who = this.last ? whoIs(terminals(), this.last, { watcher: this.watcher, withYou: shared("omniloop.withYou") ?? {}, now: Date.now() }) : null;
    const dot = () => div().text_color(t.dim).child("·"); // a new element each time: one element can't be placed twice
    const part = (text, color = t.muted) => div().flex_none().truncate().text_color(color).child(text);
    const row = h_flex().id("loop-status").size_full().min_w(0).px(10).gap(6).items_center().text_size(11.5).cursor_pointer()
      .on_click(() => run("mod.open", { name: "omniloop-picker" }));
    if (!who) return row.child(part("No terminal focused · ⌘O loops", t.dim));
    const me = h_flex().flex_none().gap(5).items_center()
      .child(div().px(4).h(16).rounded(3).bg(t.hover).text_size(10.5).font_semibold().text_color(t.muted).flex().items_center().child(who.address))
      .child(part(who.name, t.foreground));
    if (!who.loop) return row.child(me).child(dot()).child(part("not in a loop · ⌘O", t.dim));
    return row
      .child(h_flex().flex_none().gap(5).items_center().px(6).h(18).rounded(4).bg(t.accent + "22")
        .child(div().text_size(11.5).font_semibold().text_color(t.accent).child(`◎ ${who.loop}`)))
      .when(Boolean(who.goal), (el) => el.child(div().flex_none().max_w(240).truncate().text_color(t.muted).child(who.goal)))
      .child(dot()).child(me)
      .child(dot()).child(part(who.isCoordinator ? "you coordinate it" : who.parent ? `reports to ${who.parent} ${who.parentName ?? ""}`.trim() : who.coordinator ? `reports to ${who.coordinator} (coordinator)` : "reports to you"))
      .child(dot()).child(part(`coordinator: ${who.coordinator ?? "you"}`))
      .when(who.needsYou > 0, (el) => el.child(dot()).child(part(who.loopForYouLabel || `${who.needsYou} for you`, t.blocked)))
      .child(dot()).child(part(`${who.size} session${who.size === 1 ? "" : "s"}`, t.dim));
  }
}
