// fuzzy.js: fzf-style matching for the picker. Pure.
//
// A query is space-separated tokens; each token must match. In a short field (a name, a goal) a token matches
// as a subsequence, letters in order, like fzf ("omlp" finds "omniloop"). In a long field (a task, a chat line)
// it must be a substring, so stray letters scattered over a paragraph don't count as a hit.

const lower = (s) => String(s ?? "").toLowerCase();
const isWordStart = (t, i) => i === 0 || /[^a-z0-9]/.test(t[i - 1]);

/** Score one token against one text, or 0. Higher is better: substrings beat scattered letters, word starts and runs score extra. */
export function tokenScore(token, text, { subsequence = true } = {}) {
  const q = lower(token), t = lower(text);
  if (!q) return 1;
  if (!t) return 0;
  const at = t.indexOf(q);
  if (at >= 0) {
    // A whole word, then a word's start, then anywhere inside.
    const end = at + q.length;
    const whole = isWordStart(t, at) && (end === t.length || /[^a-z0-9]/.test(t[end]));
    return 100 + q.length * 4 + (whole ? 40 : isWordStart(t, at) ? 25 : 0) - Math.min(at, 20) / 4;
  }
  if (!subsequence) return 0;
  // Greedy subsequence, preferring word starts: walk the text once, taking each next letter as soon as it appears.
  let score = 0, qi = 0, last = -2, first = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    if (first < 0) first = i;
    score += 2 + (i === last + 1 ? 5 : 0) + (isWordStart(t, i) ? 6 : 0);
    last = i; qi++;
  }
  if (qi < q.length) return 0;
  const spread = last - first + 1 - q.length;   // letters skipped between the first and last hit
  return Math.max(1, score - spread * 0.5);
}

export const tokens = (query) => lower(query).split(/\s+/).filter(Boolean);

/**
 * Match a query against named fields. fields: [{ name, text, weight = 1, long = false }]; a field's text may be an
 * array (several tasks, several chat lines). Every token must hit some field. Returns null on a miss, else
 * { score, field, text }: the total, and the field and text that carried the best hit (for "why it matched").
 */
export function fuzzyFields(query, fields) {
  const ts = tokens(query);
  if (!ts.length) return { score: 0, field: null, text: null };
  let total = 0, best = null;
  for (const tok of ts) {
    let top = null;
    for (const f of fields) {
      const texts = Array.isArray(f.text) ? f.text : [f.text];
      for (const text of texts) {
        const s = tokenScore(tok, text, { subsequence: !f.long }) * (f.weight ?? 1);
        if (s > 0 && (!top || s > top.score)) top = { score: s, field: f.name, text };
      }
    }
    if (!top) return null;
    total += top.score;
    if (!best || top.score > best.score) best = top;
  }
  return { score: total, field: best.field, text: best.text };
}

/** A short snippet of `text` around the first hit of any token, at most `n` characters. */
export function snippet(text, query, n = 60) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const l = lower(t);
  const at = Math.max(0, Math.min(...tokens(query).map((q) => l.indexOf(q)).filter((i) => i >= 0), Infinity));
  const start = at === Infinity ? 0 : Math.max(0, Math.min(at - Math.floor(n / 3), t.length - n));
  return `${start > 0 ? "…" : ""}${t.slice(start, start + n).trim()}${start + n < t.length ? "…" : ""}`;
}
