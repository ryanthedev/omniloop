#!/usr/bin/env node
// Drive a study site in headless Chrome: the deck navigates, and a test round with a miss runs to the win.
// Usage: study-smoke.mjs <site dir>. Uses the Chrome DevTools protocol directly; no npm packages.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const site = resolve(process.argv[2] ?? "");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = mkdtempSync(join(tmpdir(), "study-smoke-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=390,844", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];

try {
  let tab;
  for (let i = 0; i < 50 && !tab; i++) { await sleep(200); tab = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null); }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const wait = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Runtime.enable");
  const open = async (f) => { await cmd("Page.navigate", { url: `file://${site}/${f}` }); await sleep(800); };

  for (const f of ["index.html", "slides.html", "test.html"]) { await open(f); }
  // Deck: count slides, press ArrowRight through them, and see that something changes.
  await open("slides.html");
  const n = await ev(`document.querySelectorAll(".slide, section").length`);
  if (!(n >= 6)) fail.push(`slides.html: only ${n} slides found`);
  // Which slide is on screen: the one under the viewport's centre (works for scrolling, sliding and fading decks).
  const where = `(() => { const all = [...document.querySelectorAll(".slide, section")];
    const vis = all.filter((el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width && r.height && r.left < innerWidth / 2 && r.right > innerWidth / 2 && r.top < innerHeight / 2 && r.bottom > innerHeight / 2
        && cs.visibility !== "hidden" && +cs.opacity > 0.5; });
    return vis.map((el) => all.indexOf(el)).join(","); })()`;
  const before = await ev(where);
  for (let i = 0; i < 3; i++) { await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }); await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }); await sleep(250); }
  const after = await ev(where);
  if (!before) fail.push("slides.html: no slide is on screen at the start");
  if (before === after) fail.push("slides.html: ArrowRight changed nothing");

  // Test: a round with a deliberate miss. The miss must come back reworded, the round must end in a win,
  // the hint and the slide link must name the right slide, and a reload mid-round must resume it.
  await open("test.html");
  await ev(`sessionStorage.clear(); localStorage.clear(); document.getElementById("start").click()`);
  await sleep(100);
  const first = JSON.parse(await ev(`(() => {
    const q = window.__q; document.getElementById("hint").click();
    const hint = document.getElementById("hinttext").textContent;
    document.querySelectorAll(".choice")[1 - q.correct].click();
    const link = document.getElementById("slidelink").getAttribute("href");
    return JSON.stringify({ id: q.id, prompt: q.prompt, slide: q.slide, n: q.choices.length, hint, link, head: window.QUIZ.meta.slides[q.slide - 1] });
  })()`));
  const want = await ev(`window.__round.ids.length`);
  if (first.n !== 2) fail.push(`test.html: question shows ${first.n} answers, not 2`);
  if (first.hint !== `Slide ${first.slide}: ${first.head}`) fail.push(`test.html: hint reads "${first.hint}"`);
  if (first.link !== `slides.html#${first.slide}`) fail.push(`test.html: slide link is "${first.link}"`);
  await ev(`document.getElementById("nx").click()`);
  const mid = await ev(`window.__q.id + "|" + window.__round.pos`);
  await open("test.html"); // reload mid-round: the round must resume at the same question
  const resumed = await ev(`window.__q ? window.__q.id + "|" + window.__round.pos : "none"`);
  if (resumed !== mid) fail.push(`test.html: reload mid-round showed ${resumed}, expected ${mid}`);
  const run = JSON.parse(await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms)); const back = [];
    for (let i = 0; i < 60 && !document.querySelector(".score"); i++) {
      const q = window.__q; if (q.id === ${JSON.stringify(first.id)}) back.push({ prompt: q.prompt, retry: !!q.retry });
      document.querySelectorAll(".choice")[q.correct].click(); await s(20);
      document.getElementById("nx").click(); await s(20);
    }
    return JSON.stringify({ back, score: document.querySelector(".score")?.textContent ?? null,
      revisit: [...document.querySelectorAll(".revisit a")].map(a => a.getAttribute("href")), again: !!document.getElementById("again") });
  })()`));
  if (run.back.length !== 1 || !run.back[0].retry) fail.push(`test.html: the missed question came back ${run.back.length} times`);
  else if (run.back[0].prompt === first.prompt) fail.push("test.html: the missed question came back with the same wording");
  if (!run.score || !run.again) fail.push("test.html: the round never reached the win screen");
  else if (!run.score.startsWith(`${want - 1}/${want}`)) fail.push(`test.html: first-try score shows "${run.score}", expected ${want - 1}/${want}`);
  if (!run.revisit.includes(`slides.html#${first.slide}`)) fail.push(`test.html: slides to revisit ${JSON.stringify(run.revisit)} lack slide ${first.slide}`);
  const stats = await ev(`localStorage.getItem(window.QUIZ.meta.slug + "-test-v2")`);
  if (!stats || JSON.parse(stats).rounds !== 1) fail.push(`test.html: stats after one round: ${stats}`);
  // The slide link lands on its slide.
  await open(`slides.html#${first.slide}`);
  const at = await ev(`window.deck ? window.deck.index : (${where})`);
  if (String(at) !== String(first.slide - 1)) fail.push(`slides.html#${first.slide} opened slide index ${at}`);
  for (const e of new Set(errors)) fail.push(`console: ${e.split("\n")[0]}`);
  ws.close();
  console.log(fail.length ? fail.join("\n") : `ok: ${n} slides navigate; a round with a miss resumed after reload, re-asked it reworded, won ${want - 1}/${want} first try; hint and slide link land on slide ${first.slide}; no console errors`);
} finally {
  chrome.kill(); await sleep(300); rmSync(prof, { recursive: true, force: true });
}
process.exit(fail.length ? 1 : 0);
