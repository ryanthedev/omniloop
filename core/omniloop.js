// omniloop.js: the rules for omniloops. Pure: no Herdr, UI or Node imports, no clock.
// Omniloop stands alone: it needs only herdr-core (`hc`) and, for the view, the Herdr app.
// install.sh copies this file into the mod (a Herdr mod can't import from outside its folder).
//
// An omniloop is one piece of work you're doing. It is not a space: its members can sit in any
// space on any machine. Everything is read from herdr-core terminal labels (see SPEC.md):
//
//   omniloop=<id>          this terminal works on loop <id>
//   omniloop.lead=1        this agent leads the loop (no lead in a loop: you lead it)
//   omniloop.goal=<text>   what the loop is for (read from the lead first, then any member)
//   omniloop.to=<terminal> who this member's blocks and results go to (its parent in the loop)
//   omniloop.notify=me     this member may reach you directly
//   omniloop.needs=you     set by the agent itself: this block is yours (credentials, spending, public)
//   omniloop.retired=<t>   handed off to <t> (omniloop handoff); out of the loop

export const LABEL = {
  loop: "omniloop",
  lead: "omniloop.lead",
  goal: "omniloop.goal",
  notify: "omniloop.notify",
  needs: "omniloop.needs",
  reportsTo: "omniloop.to",
  retired: "omniloop.retired",
  ask: "omniloop.ask",
  you: "omniloop.you",
};

/** Blocks a parent agent can't clear (it can't approve a prompt in another terminal): they go to you. */
export const YOURS_KINDS = new Set(["permission", "auth"]);

/** A block nobody clears for this long reaches you anyway. */
export const ESCALATE_MS = 10 * 60 * 1000;

const URGENCY = { blocked: 4, done: 3, working: 2, idle: 1 };

/** herdr-core gives status as a word (hc ls, terminals()) or {state} (hc get); "error" counts as blocked. */
export function statusOf(t) {
  const s = typeof t?.status === "object" && t.status ? t.status.state : t?.status;
  return s === "error" ? "blocked" : s ?? null;
}

/** herdr-core's blocked kind (permission | question | auth), when the program said. */
export function kindOf(t) {
  // hc get / hc events: status is {state, kind}; the app's terminals(): status is a word, the record is `report`.
  if (typeof t?.status === "object" && t.status) return t.status.kind ?? null;
  return t?.report?.kind ?? t?.blockedKind ?? t?.kind ?? null;
}

/** Out of the loop: handed off (labelled omniloop.retired=<successor>) or finished. */
export function isGone(t) {
  return Boolean(t?.labels?.[LABEL.retired]) || (t?.state != null && t.state !== "live");
}

/** "m1/t7" -> "m1"; "t7" -> null (this computer). */
export function machineOf(address) {
  const i = (address ?? "").indexOf("/");
  return i < 0 ? null : address.slice(0, i);
}

/** A remote terminal's labels name other terminals without the machine; add it back. */
export function qualify(ref, fromAddress) {
  if (!ref) return null;
  if (ref.includes("/")) return ref;
  const m = machineOf(fromAddress);
  return m ? `${m}/${ref}` : ref;
}

/**
 * A loop belongs to one machine: the same id on two machines is two loops. This computer's loops keep their
 * plain id ("x"); another machine's are keyed by machine ("m1/x"), so this computer can show them all while
 * each machine only ever sees its own.
 */
export function loopKey(t) {
  const id = t?.labels?.[LABEL.loop];
  if (!id) return null;
  const m = machineOf(t.address);
  return m ? `${m}/${id}` : id;
}

function isOn(value) {
  return value != null && value !== "" && value !== "0" && value !== "false";
}

/**
 * terminals: [{address, labels, status, created_ms?, space?, machine?, title?}]
 * Returns { loops: [Loop], loose: [terminal] } where loose terminals belong to no loop.
 * Loop: { id (loopKey: "x" here, "m1/x" on machine m1), name (the label's id), machine (null = here), goal, lead (address or null = you), leads (all lead-labelled), warnings,
 *         members: [Member], roots: [address] }
 * Retired or finished members are left out (loop.retired lists them); so are finished loose ones.
 * Member: { address, status, parent (qualified address or null), parentOutside, children, isLead,
 *           notifyMe, needsYou, terminal }
 */
export function buildLoops(terminals) {
  const byId = new Map();
  const loose = [];
  const gone = new Map();
  for (const raw of terminals ?? []) {
    const t = { ...raw, status: statusOf(raw), kind: kindOf(raw), labels: raw.labels ?? {} };
    const id = loopKey(t);
    if (!id) { if (!isGone(t)) loose.push(t); continue; }
    // A handed-off lead's successor carries every label, lead included; the retired one drops out.
    if (isGone(t)) { if (!gone.has(id)) gone.set(id, []); gone.get(id).push(t.address); continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(t);
  }

  const loops = [];
  for (const [id, ts] of byId) {
    const warnings = [];
    const leads = ts
      .filter((t) => isOn(t.labels[LABEL.lead]))
      .sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0))
      .map((t) => t.address);
    if (leads.length > 1) warnings.push(`${leads.length} leads; the oldest (${leads[0]}) leads`);
    const lead = leads[0] ?? null;

    const addresses = new Set(ts.map((t) => t.address));
    const members = ts.map((t) => {
      const parent = qualify(t.labels[LABEL.reportsTo], t.address);
      return {
        address: t.address,
        status: t.status ?? "idle",
        kind: t.status === "blocked" ? t.kind : null,
        parent: parent && addresses.has(parent) && parent !== t.address ? parent : null,
        parentOutside: Boolean(parent && !addresses.has(parent)),
        children: [],
        isLead: t.address === lead,
        notifyMe: t.labels[LABEL.notify] === "me",
        needsYou: t.labels[LABEL.needs] === "you",
        terminal: t,
      };
    });
    // Who reports to you: the lead, everyone in a loop you lead, and members set to reach you.
    for (const m of members) m.reportsToYou = m.isLead || !lead || m.notifyMe;
    const byAddr = new Map(members.map((m) => [m.address, m]));

    // Break reports-to cycles: walk up from each member; a repeat cuts the link that closed it.
    for (const m of members) {
      const seen = new Set([m.address]);
      let cur = m;
      while (cur.parent) {
        if (seen.has(cur.parent)) { warnings.push(`omniloop.to loop at ${cur.address}`); cur.parent = null; break; }
        seen.add(cur.parent);
        cur = byAddr.get(cur.parent);
      }
    }
    for (const m of members) if (m.parent) byAddr.get(m.parent).children.push(m.address);

    // Roots: the lead first, then everyone with no parent in the loop. Members with no parent hang
    // under the lead in a view, but routing treats them as reporting to the lead.
    const roots = members.filter((m) => !m.parent).map((m) => m.address)
      .sort((a, b) => (a === lead ? -1 : b === lead ? 1 : 0));

    const goalFrom = [byAddr.get(lead), ...members].find((m) => m?.terminal.labels[LABEL.goal]);
    const slash = id.indexOf("/");
    loops.push({ id, name: slash < 0 ? id : id.slice(slash + 1), machine: slash < 0 ? null : id.slice(0, slash), goal: goalFrom?.terminal.labels[LABEL.goal] ?? null, lead, leads, warnings, members, roots,
      retired: gone.get(id) ?? [] });
  }
  return { loops, loose };
}

/**
 * Where a member's news goes. Returns null when there is none (working, idle),
 * else { to: "you" | address, kind: "blocked" | "done", why }.
 * blockedSince: ms since the epoch when this member was first seen blocked (the adapter keeps it).
 */
export function route(loop, address, { now = 0, blockedSince = null } = {}) {
  const byAddr = new Map(loop.members.map((m) => [m.address, m]));
  const m = byAddr.get(address);
  if (!m) return null;
  const kind = m.status === "blocked" ? "blocked" : m.status === "done" ? "done" : null;
  if (!kind) return null;

  if (m.needsYou) return { to: "you", kind, why: "asked for you" };
  if (kind === "blocked" && YOURS_KINDS.has(m.kind)) return { to: "you", kind, why: `${m.kind} prompt` };
  if (m.isLead) return { to: "you", kind, why: "the lead" };
  if (!loop.lead) return { to: "you", kind, why: "you lead this loop" };
  if (m.notifyMe) return { to: "you", kind, why: "set to reach you" };
  if (kind === "blocked" && blockedSince != null && now - blockedSince >= ESCALATE_MS)
    return { to: "you", kind, why: "nobody cleared it" };

  // Up the reports-to chain to the first member who isn't blocked; the lead catches the rest.
  const seen = new Set([address]);
  let cur = m.parent ? byAddr.get(m.parent) : null;
  while (cur && cur.status === "blocked" && !cur.isLead && cur.parent && !seen.has(cur.parent)) {
    seen.add(cur.address);
    cur = byAddr.get(cur.parent);
  }
  const to = cur && !(cur.status === "blocked" && !cur.isLead) ? cur.address : loop.lead;
  return { to, kind, why: to === m.parent ? "its parent" : to === loop.lead ? "the lead" : "further up" };
}

/**
 * Every routed item across loops, plus terminals in no loop (those reach you, as today).
 * blockedSince: { [address]: ms }.
 * Returns [{ address, loop (id or null), to, kind, why }].
 */
export function alerts({ loops, loose }, { now = 0, blockedSince = {} } = {}) {
  const out = [];
  for (const loop of loops)
    for (const m of loop.members) {
      const since = blockedSince[m.address] ?? (m.status === "blocked" ? m.terminal.status_ms ?? null : null);
      const r = route(loop, m.address, { now, blockedSince: since });
      if (r) out.push({ address: m.address, loop: loop.id, ...r });
    }
  for (const t of loose) {
    if (t.status === "blocked" || t.status === "done")
      out.push({ address: t.address, loop: null, to: "you", kind: t.status, why: "in no loop" });
  }
  return out;
}

/** The alerts that should make a sound now: for you, and not already sounding last time.
 *  Play the sound by kind ("blocked" or "done"), not always "blocked". */
export function newForYou(prev, next) {
  const key = (a) => `${a.address}|${a.kind}`;
  const before = new Set((prev ?? []).filter((a) => a.to === "you").map(key));
  return next.filter((a) => a.to === "you" && !before.has(key(a)));
}

/** Track when each terminal was first seen blocked. Returns a new map; drops ones no longer blocked. */
export function trackBlocked(prev, terminals, now) {
  const next = {};
  for (const t of terminals ?? [])
    if (statusOf(t) === "blocked") next[t.address] = prev?.[t.address] ?? now;
  return next;
}

/** The words for what is for you, in the order they are listed. */
export const FOR_YOU_WORDS = { approval: "needs approval", asked: "asked you", finished: "finished", stalled: "stalled", undelivered: "not delivered", other: "needs you" };

/**
 * Which word an alert for you gets: "approval" (blocked on a permission or auth prompt: the agent can't continue),
 * "asked" (blocked with herdr kind "question", or finished its turn with a question: its Stop hook set
 * omniloop.ask), "finished" (done: finished its turn, nothing asked), "stalled" (watcher-only: stalled, or stuck at
 * start), "undelivered" (a note to that agent couldn't be delivered), "other" (any other kind: shown as "needs you").
 * t: the alert's terminal (for its labels), when known.
 */
export function forYouKind(a, t = null) {
  if (a.kind === "stalled" || a.kind === "stuck") return "stalled";
  if (a.kind === "blocked") return kindOf(t) === "question" ? "asked" : "approval";
  if (a.kind === "undeliverable") return "undelivered";
  if (a.kind !== "done") return "other";
  return isOn(t?.labels?.[LABEL.ask]) ? "asked" : "finished";
}

/** Counts per word from a list of kinds: { approval, asked, finished, stalled, undelivered, other }. */
export function forYouCounts(kinds = []) {
  const c = Object.fromEntries(Object.keys(FOR_YOU_WORDS).map((k) => [k, 0]));
  for (const k of kinds) if (k in c) c[k]++;
  return c;
}

/** "1 needs approval · 2 asked you": counts first, joined with " · "; "" when nothing is for you. */
export function forYouLabel(counts) {
  return Object.entries(FOR_YOU_WORDS).filter(([k]) => counts?.[k] > 0).map(([k, w]) => `${counts[k]} ${w}`).join(" · ");
}

/**
 * The view: loops ordered by what needs you, each with its status for you.
 * Returns [{ id, goal, lead, needsYou (count), handling (count of blocks the loop is handling
 *            itself), status (most urgent member), warnings, members, roots }].
 */
export function loopView(built, routed) {
  const rows = built.loops.map((loop) => {
    const mine = routed.filter((a) => a.loop === loop.id);
    const term = new Map(loop.members.map((m) => [m.address, m.terminal]));
    const forYouCount = forYouCounts(mine.filter((a) => a.to === "you").map((a) => forYouKind(a, term.get(a.address))));
    const status = loop.members.reduce((best, m) =>
      (URGENCY[m.status] ?? 0) > (URGENCY[best] ?? 0) ? m.status : best, null);
    return {
      ...loop,
      needsYou: mine.filter((a) => a.to === "you").length,
      forYouCounts: forYouCount,
      forYouLabel: forYouLabel(forYouCount),
      handling: mine.filter((a) => a.to !== "you" && a.kind === "blocked").length,
      status,
    };
  });
  return rows.sort((a, b) =>
    b.needsYou - a.needsYou || (URGENCY[b.status] ?? 0) - (URGENCY[a.status] ?? 0) || a.id.localeCompare(b.id));
}
