import { test } from "node:test";
import assert from "node:assert/strict";
import { stampFocus, mergeFocus, FOCUS_EVERY_MS } from "../core/focus.js";

const terms = [{ address: "t1", labels: { omniloop: "demo" } }, { address: "t2", labels: {} }, { address: "t3" }];
const NOW = 1_000_000_000_000;

test("stampFocus: a loop terminal in focus is stamped; others are kept", () => {
  assert.deepEqual(stampFocus({ t9: 5 }, "t1", terms, NOW), { t9: 5, t1: NOW });
});

test("stampFocus: nothing focused, unknown, unlabelled or label-less terminals change nothing", () => {
  for (const f of [null, undefined, "t2", "t3", "t404"]) assert.equal(stampFocus({}, f, terms, NOW), null);
});

test("stampFocus: throttled to once per 10 s per terminal", () => {
  const rec = { t1: NOW - FOCUS_EVERY_MS + 1 };
  assert.equal(stampFocus(rec, "t1", terms, NOW), null);
  assert.deepEqual(stampFocus(rec, "t1", terms, NOW + 1), { t1: NOW + 1 });
});

test("stampFocus does not mutate its input", () => {
  const rec = {}; stampFocus(rec, "t1", terms, NOW); assert.deepEqual(rec, {});
});

test("mergeFocus: newest per address wins, junk and month-old entries are dropped", () => {
  const m = mergeFocus(NOW, { a: 10 + NOW - 100, b: NOW - 50 }, { a: NOW - 20, c: "x", d: NOW - 31 * 24 * 3600_000 }, null, undefined);
  assert.deepEqual(m, { a: NOW - 20, b: NOW - 50 });
});
