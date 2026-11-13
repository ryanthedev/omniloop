// pins.js: harpoon for loops. Pure. A short, ordered list of loop keys (core/omniloop.js loopKey: "<id>" here,
// "<machine>/<id>" on another machine); slot 1 is the first. The picker shows pinned loops on top, numbered, and
// your leader keys jump to a slot's lead. The list lives in the app's shared state (PINS_KEY), one for the app.

export const PINS_KEY = "omniloop.pins";
export const MAX_PINS = 9;

/** A clean list from whatever shared state holds: unique non-empty strings, at most MAX_PINS. */
export function sanitizePins(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const k of v) if (typeof k === "string" && k.trim() && !out.includes(k)) out.push(k);
  return out.slice(0, MAX_PINS);
}

/** 1-based slot of a key, or null. */
export const slotOf = (pins, key) => { const i = pins.indexOf(key); return i < 0 ? null : i + 1; };

/** Pin (to the end) or unpin a key. Returns { pins, slot (new slot or null), full (true when there was no room) }. */
export function togglePin(pins, key) {
  if (pins.includes(key)) return { pins: pins.filter((k) => k !== key), slot: null, full: false };
  if (pins.length >= MAX_PINS) return { pins, slot: null, full: true };
  return { pins: [...pins, key], slot: pins.length + 1, full: false };
}

/** Move a pinned key up (-1) or down (+1) one slot. Unpinned keys and moves off either end change nothing. */
export function movePin(pins, key, by) {
  const i = pins.indexOf(key), j = i + by;
  if (i < 0 || j < 0 || j >= pins.length) return pins;
  const out = [...pins];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
