#!/usr/bin/env node
// Check a study site before it is published. Usage: study-check.mjs <site dir>
// Exits 1 and lists every problem; prints a one-line summary when the site passes.
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = process.argv[2];
if (!site) { console.error("usage: study-check.mjs <site dir>"); process.exit(2); }
const KIT = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");
const bad = [];
const need = (ok, msg) => { if (!ok) bad.push(msg); };
const stop = () => { console.error(bad.join("\n")); process.exit(1); };

for (const f of ["index.html", "slides.html", "test.html", "style.css", "bank.js", "quiz.js"]) need(existsSync(join(site, f)), `missing ${f}`);
if (bad.length) stop();

// The engine and runner are shared: a site must carry the kit's copies unchanged.
need(readFileSync(join(site, "quiz.js"), "utf8") === readFileSync(join(KIT, "quiz.js"), "utf8"), "quiz.js differs from the project kit (copy it, don't edit it)");
const strip = (s) => s.slice(s.indexOf("<style>")); // the <head> above <style> is the deck's own (fonts, icon)
need(strip(readFileSync(join(site, "test.html"), "utf8")) === strip(readFileSync(join(KIT, "test.html"), "utf8")), "test.html differs from the project kit beyond its <head> fonts and icon");

// style.css must define the tokens the shared runner uses.
const css = readFileSync(join(site, "style.css"), "utf8");
for (const t of ["--pad", "--bg-2", "--line", "--pass", "--fail", "--run", "--muted", "--text", "--display", "--mono"]) need(css.includes(t + ":"), `style.css lacks ${t}`);
for (const c of [".btn", ".kicker", ".dot", ".topbar", ".home"]) need(css.includes(c), `style.css lacks ${c}`);

// The slides' text, one string per slide, so questions can be checked against what the slides actually show.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rarr: "→", larr: "←", times: "×", hellip: "…", mdash: "—", ndash: "–" };
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
const norm = (s) => text(String(s)).toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9]+/g, "");
const deck = readFileSync(join(site, "slides.html"), "utf8");
const slideText = [...deck.matchAll(/<section class="slide\b[\s\S]*?<\/section>/g)].map((m) => norm(m[0]));
need(slideText.length >= 6, `slides.html: found ${slideText.length} <section class="slide"> blocks`);

// The owner cares about the ideas, not the medium: the pages never say "reel", "video" and the like,
// unless meta.mediaWords gives a reason (say, a kit about making podcasts). URLs don't count; only visible text.
const MEDIA = /\b(reels?|videos?|clips?|podcasts?|episodes?|tiktoks?|shorts)\b/i;
const visible = (f) => text(readFileSync(join(site, f), "utf8"));

// The bank.
const ctx = { globalThis: {} }; ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(join(site, "bank.js"), "utf8"), ctx);
const Q = ctx.QUIZ;
need(Q && Array.isArray(Q.bank), "bank.js must set globalThis.QUIZ = { meta, bank }");
if (!Q?.bank) stop();
const m = Q.meta ?? {};
for (const k of ["title", "slug", "headline", "source"]) need(typeof m[k] === "string" && m[k], `meta.${k} missing`);
need(Array.isArray(m.verdicts) && m.verdicts.length === 4, "meta.verdicts needs 4 lines (100%, 80%+, 50%+, below)");
// meta.slides: one short headline per slide, in deck order; the hint shows "Slide N: <headline>".
need(Array.isArray(m.slides) && m.slides.length === slideText.length, `meta.slides needs one headline per slide (${slideText.length}), has ${m.slides?.length ?? 0}`);
(m.slides ?? []).forEach((h, i) => need(slideText[i]?.includes(norm(h)), `meta.slides[${i}] "${h}" is not text on slide ${i + 1}`));

if (!m.mediaWords) for (const f of ["index.html", "slides.html"]) {
  const hit = visible(f).match(new RegExp(".{0,30}" + MEDIA.source + ".{0,30}", "i"));
  need(!hit, `${f} mentions the medium ("${hit?.[0].trim()}"); talk about the ideas, or set meta.mediaWords to the reason`);
}
const per = m.per ?? 10, B = Q.bank;
need(B.length >= 30, `bank has ${B.length} items; needs 30+`);
need(B.length >= per * 3, `bank (${B.length}) should be at least 3x the per-attempt count (${per})`);
const ids = new Set();
for (const it of B) {
  const w = `item ${it.id ?? "?"}`;
  need(it.id && !ids.has(it.id), `${w}: missing or duplicate id`); ids.add(it.id);
  need(typeof it.explain === "string" && it.explain, `${w}: explain missing`);
  // Every question comes from a slide: a valid slide number, and words copied from that slide.
  need(Number.isInteger(it.slide) && it.slide >= 1 && it.slide <= slideText.length, `${w}: slide must be 1..${slideText.length}`);
  need(typeof it.anchor === "string" && norm(it.anchor).length >= 6, `${w}: anchor (words copied from its slide) missing or too short`);
  if (Number.isInteger(it.slide) && it.anchor) need(slideText[it.slide - 1]?.includes(norm(it.anchor)), `${w}: anchor "${it.anchor}" is not on slide ${it.slide}`);
  // Ask about what the slides show, never about what the source said (the owner may not have watched it).
  const ATTRIB = /\b(in|from|per|according to) the (reel|video|clip|podcast|episode|speaker|host)\b|\bthe (reel|video|clip|podcast|episode|speaker|host)('s)? (says?|said|shows?|showed|mentions?|claims?)\b/i;
  need(!ATTRIB.test(JSON.stringify([it.prompts, it.trues, it.falses])), `${w}: asks what the source said; ask about the slide instead`);
  // Two answers, and a retry must be able to reword: 2+ wordings and 2+ wrong answers.
  if (it.type === "pick") {
    const answers = it.answers ?? [it.answer];
    need(it.prompts?.length >= 2, `${w}: pick needs 2+ prompts (a retry is reworded)`);
    need(answers.every(Boolean) && it.wrongs?.length >= 2, `${w}: pick needs answer and 2+ wrongs`);
    need(!it.wrongs?.some((x) => answers.includes(x)), `${w}: a wrong answer equals the right one`);
  } else if (it.type === "tf") need(it.trues?.length >= 1 && it.falses?.length >= 1 && it.trues.length + it.falses.length >= 3, `${w}: tf needs 3+ statements, at least one true and one false`);
  else bad.push(`${w}: unknown type ${it.type} (only pick and tf)`);
}
if (bad.length) stop();
for (let s = 1; s <= slideText.length; s++) if (!/^(title|recap)/i.test(m.slides[s - 1])) need(B.some((i) => i.slide === s) || slideText[s - 1].length < 120, `slide ${s} has no questions`);

// Run the kit's engine as a browser would: bank.js then quiz.js in one global scope (the repo is ESM, so no require).
const page = { Math }; page.globalThis = page; page.QUIZ = Q;
vm.runInNewContext(readFileSync(join(KIT, "quiz.js"), "utf8"), page);
const E = page.QuizBank;
const att = Array.from({ length: 200 }, () => E.generateAttempt(per));
const sig = (a, f) => JSON.stringify(a.map(f));
need(new Set(att.map((a) => sig(a, (q) => q.id).split(",").sort().join())).size > 1, "question sets never change");
need(new Set(att.map((a) => sig(a, (q) => q.id))).size > 1, "question order never changes");
need(new Set(att.map((a) => sig(a, (q) => q.choices.concat(q.prompt)))).size > 1, "wording and choices never change");
for (const q of att.flat()) {
  if (q.choices.length !== 2 || q.choices[q.correct] !== q.answerText || q.choices[0] === q.choices[1]) { bad.push(`item ${q.id}: rendered ${JSON.stringify(q.choices)}, not two distinct answers with the right one`); break; }
}
for (const it of B) { // a retry always changes the wording
  const q = E.build(it, Math.random);
  for (let k = 0; k < 20; k++) if (E.rebuild(q).prompt === q.prompt) { bad.push(`item ${it.id}: a retry repeated the same wording`); break; }
}
// A round: miss the first question every time it appears until the third, answer the rest right; it must end in a win.
const r = E.newRound(per);
const firstId = r.ids[0]; let seen = 0, steps = 0;
while (!E.done(r) && steps++ < 200) { const q = E.current(r); const miss = q.id === firstId && seen++ < 2; E.answer(r, !miss); }
need(E.done(r) && steps < 200, "a round never ends");
need(r.queue.filter((q) => q.id === firstId).length === 3, "a missed question did not come back until answered right");
need(E.firstTry(r) === per - 1, `first-try score is ${E.firstTry(r)}, expected ${per - 1}`);

if (bad.length) stop();
const types = [...new Set(B.map((i) => i.type))];
const covered = new Set(B.map((i) => i.slide)).size;
console.log(`ok: ${B.length} questions (${per} per round), ${types.join("/")}, two answers each, ${covered}/${slideText.length} slides covered, retries reword and end in a win`);
