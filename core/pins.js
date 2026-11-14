// pins.js: harpoon for loops. Pure. Up to MAX_PINS numbered slots, each a loop key (core/omniloop.js loopKey: "<id>"
// here, "<machine>/<id>" on another machine) or null for an empty slot; slot 1 is index 0. Slots are fixed: a pin
// keeps its number until you move or unpin it (the leader keys jump to a slot by number), and a new pin takes the
// lowest empty slot. The picker shows pinned loops on top, numbered. The list lives in the app's shared state
// (PINS_KEY), one for the app; a plain list of keys (the old form, no holes) reads the same.

export const PINS_KEY = "omniloop.pins";
export const MAX_PINS = 9;

/** No empty slots at the end: what is stored. */
const trim = (pins) => { const out = [...pins]; while (out.length && out[out.length - 1] == null) out.pop(); return out; };

/** A clean list from whatever shared state holds: up to MAX_PINS slots, each a unique non-empty string or null. */
export function sanitizePins(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const k of v.slice(0, MAX_PINS)) out.push(typeof k === "string" && k.trim() && !out.includes(k) ? k : null);
  return trim(out);
}

/** 1-based slot of a key, or null. */
export const slotOf = (pins, key) => { const i = key == null ? -1 : pins.indexOf(key); return i < 0 ? null : i + 1; };

/** The pinned keys with their slots, in slot order: [{ key, slot }]. */
export const pinnedSlots = (pins) => pins.flatMap((key, i) => (key ? [{ key, slot: i + 1 }] : []));

/** The lowest empty slot (1-based), or null when all MAX_PINS are taken. */
function freeSlot(pins) {
  for (let i = 0; i < MAX_PINS; i++) if (!pins[i]) return i + 1;
  return null;
}

/** Pin a key to the lowest empty slot, or unpin it (its slot goes empty; the others keep theirs).
 *  Returns { pins, slot (new slot or null), full (true when there was no room) }. */
export function togglePin(pins, key) {
  if (pins.includes(key)) return { pins: trim(pins.map((k) => (k === key ? null : k))), slot: null, full: false };
  const slot = freeSlot(pins);
  if (!slot) return { pins, slot: null, full: true };
  const out = [...pins];
  while (out.length < slot) out.push(null);
  out[slot - 1] = key;
  return { pins: out, slot, full: false };
}

/**
 * Put a key in slot `slot` (1..MAX_PINS). The loop already there swaps into the key's old slot; when the key wasn't
 * pinned, it moves to the lowest empty slot instead, and is unpinned only when there is none.
 * Returns { pins, moved: { key, slot (or null: unpinned) } | null }.
 */
export function pinTo(pins, key, slot) {
  if (!(slot >= 1 && slot <= MAX_PINS)) return { pins, moved: null };
  const out = [...pins];
  while (out.length < MAX_PINS) out.push(null);
  const from = out.indexOf(key), there = out[slot - 1];
  if (from === slot - 1) return { pins, moved: null };
  if (from >= 0) out[from] = null;
  out[slot - 1] = key;
  let moved = null;
  if (there) {
    const to = from >= 0 ? from + 1 : freeSlot(out);
    if (to) out[to - 1] = there;
    moved = { key: there, slot: to };
  }
  return { pins: trim(out), moved };
}

/** Move a pinned key up (-1) or down (+1) one slot, swapping with what is there (an empty slot included).
 *  Unpinned keys and moves off either end change nothing. */
export function movePin(pins, key, by) {
  const i = pins.indexOf(key), j = i + by;
  if (i < 0 || j < 0 || j >= MAX_PINS) return pins;
  const out = [...pins];
  while (out.length <= j) out.push(null);
  [out[i], out[j]] = [out[j] ?? null, out[i]];
  return trim(out);
}
