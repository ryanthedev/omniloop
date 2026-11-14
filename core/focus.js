// focus.js: the record of when you were last in each loop agent's terminal ({ [address]: ms }), kept by the
// loop tab bar (mod-tabs, always on screen) in the shared `omniloop.withYou`. Pure (no I/O).

export const FOCUS_KEY = "omniloop.withYou";
export const FOCUS_EVERY_MS = 10_000; // a terminal you stay in is stamped again at most this often
const MONTH = 30 * 24 * 3600_000;     // older entries are dropped, as the watcher's record does

/** Merge records, newest time per address winning; entries older than 30 days or not numbers are dropped. */
export function mergeFocus(now, ...records) {
  const out = {};
  for (const r of records) {
    for (const [a, at] of Object.entries(r && typeof r === "object" ? r : {})) {
      if (Number.isFinite(at) && now - at <= MONTH && at > (out[a] ?? -Infinity)) out[a] = at;
    }
  }
  return out;
}

/**
 * The record after you are seen in `focusedAddress`, or null when nothing changes: nothing focused, the terminal
 * is not in a loop (no `omniloop` label) or unknown, or it was stamped less than 10 s ago.
 */
export function stampFocus(record, focusedAddress, terminals, now) {
  if (!focusedAddress) return null;
  if (!terminals.find((t) => t.address === focusedAddress)?.labels?.omniloop) return null;
  if (now - (record[focusedAddress] ?? 0) < FOCUS_EVERY_MS) return null;
  return { ...record, [focusedAddress]: now };
}
