// view.js: what the omniloop pane shows, as plain data. Pure; the mod only draws it.

import { buildLoops, alerts, loopView, forYouKind, forYouCounts, forYouLabel, FOR_YOU_WORDS, LABEL } from "./omniloop.js";

/** The watcher counts as running when its state file was written this recently (it ticks every 15 s). */
export const WATCHER_FRESH_MS = 45_000;

export function watcherOf(state, now) {
  if (!state?.heartbeat) return { running: false, why: "not started" };
  const age = now - state.heartbeat;
  return age <= WATCHER_FRESH_MS ? { running: true, sent: state.sent ?? 0, chars: state.chars ?? 0 } : { running: false, why: `silent for ${Math.round(age / 60000)} min` };
}

const nameOf = (t) => t.labels?.["omniloop.job"] || t.title || t.address;

/**
 * terminals: terminals() from the app. watcher: the watcher's state file (or null).
 * Returns { loops: [{ id, goal, lead, needsYou, handling, status, warnings, rows }], loose, forYou, watcher }
 * rows: [{ address, depth, status, kind, name, isLead, forYou (why or null) }] in tree order.
 */
/** "now", "5m", "2h", "3d". */
export function ago(ms, now) {
  if (ms == null) return null;
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * withYou: { [address]: ms } when you last interacted with each terminal (the view's own focus record);
 * merged with the watcher's (state.withYou), newest wins.
 */
export function buildView(terminals, watcher, now, withYou = {}) {
  const built = buildLoops(terminals);
  const routed = alerts({ loops: built.loops, loose: [] }, { now });
  // Stalls and escalations only the watcher knows about (it sees event times).
  const extra = watcherOf(watcher, now).running ? (watcher.you ?? []).filter((w) => !routed.some((r) => r.address === w.address && r.to === "you")) : [];
  const all = [...routed, ...extra];
  const why = new Map(all.filter((a) => a.to === "you").map((a) => [a.address, a.kind === "stalled" ? "stalled" : a.kind === "stuck" ? "stuck at start (folder trust?)" : a.why]));

  const termOf = new Map(built.loops.flatMap((l) => l.members.map((m) => [m.address, m.terminal])));
  const word = new Map(all.filter((a) => a.to === "you").map((a) => [a.address, FOR_YOU_WORDS[forYouKind(a, termOf.get(a.address))]]));
  const lastOf = (a) => Math.max(withYou[a] ?? -Infinity, watcher?.withYou?.[a] ?? -Infinity);
  const known = (x) => (x === -Infinity ? null : x);

  const loops = loopView(built, all).map((l) => {
    const by = new Map(l.members.map((m) => [m.address, m]));
    const rows = [];
    const walk = (a, depth) => {
      const m = by.get(a);
      const last = known(lastOf(a));
      rows.push({ address: a, depth, status: m.status, kind: m.kind, name: nameOf(m.terminal), isLead: m.isLead, forYou: why.get(a) ?? null, forYouLabel: word.get(a) ?? null,
        reportsToYou: m.reportsToYou, lastWithYou: m.reportsToYou ? last : null, ago: m.reportsToYou ? ago(last, now) : null });
      for (const c of m.children) walk(c, depth + 1);
    };
    // Members with no parent hang under the lead.
    for (const r of l.roots) walk(r, r === l.lead || !l.lead ? 0 : 1);
    // The loop's last time with you: any member you interacted with.
    const last = known(Math.max(...l.members.map((m) => lastOf(m.address))));
    // The same alerts the row chips show (routed plus the watcher's extras), matched by member, not by the alert's loop field.
    const counts = forYouCounts(all.filter((a) => a.to === "you" && by.has(a.address)).map((a) => forYouKind(a, termOf.get(a.address))));
    return { id: l.id, goal: l.goal, lead: l.lead, needsYou: l.needsYou, forYouCounts: counts, forYouLabel: forYouLabel(counts), handling: l.handling, status: l.status, warnings: l.warnings, rows,
      lastWithYou: last, ago: ago(last, now) };
  });
  // Most recently with you first; loops you never touched last, those that need you first among them.
  loops.sort((a, b) => (b.lastWithYou ?? -1) - (a.lastWithYou ?? -1) || b.needsYou - a.needsYou || a.id.localeCompare(b.id));

  const loose = built.loose.filter((t) => t.status != null);
  return { loops, loose: loose.length, forYou: all.filter((a) => a.to === "you"), watcher: watcherOf(watcher, now) };
}

/** Keys of alerts for you, for sounding only the new ones. */
export const alertKey = (a) => `${a.address}|${a.kind}`;

export { LABEL };

/**
 * The loop tab bar: every live session in the loop you're in, lead first, then the tree.
 * focusedAddr: the terminal you're in (null when focus is in a mod, e.g. this pane); sticky: the loop shown
 * last, kept while focus is in a mod so the bar doesn't flicker. Returns { loop, goal, tabs } or null
 * (you're in a terminal outside every loop: show the space's own tabs).
 */
export function loopTabs(terminals, focusedAddr, sticky = null) {
  const built = buildLoops(terminals);
  let loop = null;
  if (focusedAddr) {
    loop = built.loops.find((l) => l.members.some((m) => m.address === focusedAddr)) ?? null;
  } else if (sticky) {
    loop = built.loops.find((l) => l.id === sticky) ?? null;
  }
  if (!loop) return null;
  const by = new Map(loop.members.map((m) => [m.address, m]));
  const tabs = [];
  const walk = (a) => {
    const m = by.get(a);
    const i = a.indexOf("/");
    tabs.push({ address: a, name: nameOf(m.terminal), status: m.status, isLead: m.isLead, machine: i < 0 ? null : a.slice(0, i), active: a === focusedAddr });
    for (const c of m.children) walk(c);
  };
  for (const r of loop.roots) walk(r);
  return { loop: loop.id, goal: loop.goal, tabs };
}

/**
 * Who a terminal is, for the pane header, tab bar and status bar: its id, its agent's name, and its loop.
 * name: the omniloop job, else its terminal title, else its program. Returns null for an unknown address.
 * { address, name, loop, goal, lead, isLead, parent, parentName, reportsToYou, forYou, ago }
 */
export function whoIs(terminals, address, { watcher = null, withYou = {}, now = 0 } = {}) {
  const t = (terminals ?? []).find((x) => x.address === address);
  if (!t) return null;
  const name = t.labels?.["omniloop.job"] || cleanTitle(t.title) || t.program?.name || t.address;
  const base = { address, name, loop: null, goal: null, lead: null, isLead: false, parent: null, parentName: null, reportsToYou: false, forYou: null, ago: null };
  if (!t.labels?.[LABEL.loop]) return base;
  const v = buildView(terminals, watcher, now, withYou);
  const l = v.loops.find((x) => x.rows.some((r) => r.address === address));
  if (!l) return base;
  const row = l.rows.find((r) => r.address === address);
  const parent = buildLoops(terminals).loops.find((x) => x.id === l.id)?.members.find((m) => m.address === address)?.parent ?? null;
  const pt = parent && terminals.find((x) => x.address === parent);
  return { ...base, loop: l.id, goal: l.goal, lead: l.lead, isLead: row.isLead, parent,
    parentName: pt ? pt.labels?.["omniloop.job"] || cleanTitle(pt.title) || parent : null,
    reportsToYou: row.reportsToYou, forYou: row.forYou, forYouLabel: row.forYouLabel, ago: l.ago, needsYou: l.needsYou, forYouCounts: l.forYouCounts, loopForYouLabel: l.forYouLabel, size: l.rows.length };
}

/** Terminal titles: drop a leading spinner or symbol, and shell prompts like "user@host:~/x". */
export function cleanTitle(title) {
  const s = String(title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return !s || /^\S+@\S+:/.test(s) ? null : s;
}

/** The loop bar's label for a member: the Herdr tab's name when that tab was explicitly named (and the member has
 *  a pane in this window), else the member's own name. `tab` is a spaces() tab ({name, named}) or null. */
export function memberLabel(member, tab) {
  return tab?.named && tab.name ? tab.name : member.name;
}

/** What the loop bar's × should run for a member's pane: close just that pane when its tab holds other panes
 *  (a split), else close the whole tab. `allPanes` is panes(); returns [command, args], or null with no pane. */
export function closeCommand(allPanes, pane) {
  if (!pane) return null;
  const inTab = allPanes.filter((p) => p.tab === pane.tab).length;
  return inTab > 1 ? ["pane.close", { pane: pane.pane }] : ["tab.close", { id: pane.tab }];
}
