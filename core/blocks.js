// blocks.js: the one way to rewrite a managed block (between two HTML-comment markers) in a CLAUDE.md. Pure.
// Text outside a block is the loop's own, so a block is only touched when its markers are clean: exactly one start
// followed by exactly one end, each alone on its line. Anything else is left exactly as it was, with a note.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Positions of `marker` where it starts a line and ends it (trailing blanks allowed). */
function lineStarts(text, marker) {
  return [...text.matchAll(new RegExp(`^${esc(marker)}[ \\t]*\\r?$`, "gm"))].map((m) => m.index);
}

const MARKER_LINE = /^<!-- \/?omniloop:\w+ -->[ \t]*\r?$/;

/** `body` with every inner line that would read as a marker indented by one space; its own first and last line stay. */
function defuse(body, start, end) {
  const lines = body.split("\n"), last = lines.length - 1;
  return lines.map((l, i) => (MARKER_LINE.test(l) && !(i === 0 && l === start) && !(i === last && l === end) ? ` ${l}` : l)).join("\n");
}

/**
 * Put `body` (the block, markers included) between `start` and `end` in `text`.
 * - one clean pair: what is between them is replaced, every other byte stays;
 * - no markers at all: `anchor(text, body)` returns the text with the block inserted;
 * - anything else (one marker alone on its line, duplicates, wrong order): the text comes back unchanged.
Text that merely quotes a marker mid-line is not a marker.
 * Returns { text, note }; note is null unless the markers are damaged.
 */
export function replaceBlock(text, start, end, body, anchor) {
  const a = lineStarts(text, start), b = lineStarts(text, end);
  body = defuse(body, start, end);   // inserted text can never forge a marker
  if (a.length === 1 && b.length === 1 && b[0] > a[0]) return { text: text.slice(0, a[0]) + body + text.slice(b[0] + end.length), note: null };
  if (!a.length && !b.length) return { text: anchor(text, body), note: null };
  const name = start.match(/omniloop:(\w+)/)?.[1] ?? "managed";
  return { text, note: `CLAUDE.md ${name} block markers are damaged: left alone` };
}

/** Where `end` (a marker alone on its line) is in `text`, or -1. */
export const endOfBlock = (text, end) => { const p = lineStarts(text, end); return p.length ? p[0] + end.length : -1; };

/** Where `start` (a marker alone on its line) is in `text`, or -1. */
export const startOfBlock = (text, start) => { const p = lineStarts(text, start); return p.length ? p[0] : -1; };
