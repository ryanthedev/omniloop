#!/usr/bin/env node
// Build the root page that lists every study kit. Each loop writes its own entry at ~/loops/<id>/study/entry.json
// after it publishes, so loops finishing at the same time never edit a shared file; this script reads them all.
// Usage: study-index.mjs <out dir> [--loops ~/loops]
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) { console.error("usage: study-index.mjs <out dir> [--loops dir]"); process.exit(2); }
const li = process.argv.indexOf("--loops");
const LOOPS = li > 0 ? process.argv[li + 1] : join(homedir(), "loops");
// The root page's name lives in project.json (publish.name), so renaming it is a one-line change.
const PUB = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "project.json"), "utf8")).publish ?? {};
const NAME = PUB.name ?? "Study kits";

const entries = [];
for (const id of existsSync(LOOPS) ? readdirSync(LOOPS) : []) {
  const f = join(LOOPS, id, "study", "entry.json");
  if (!existsSync(f)) continue;
  try { const e = JSON.parse(readFileSync(f, "utf8")); if (e.url && e.title) entries.push({ ...e, url: e.url.replace(/\/?$/, "/"), loop: id }); }
  catch (err) { console.error(`skipping ${f}: ${err.message}`); }
}
entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const card = (e) => `
  <article class="card">
    <div class="meta"><span class="kind">${esc(e.date)}</span>${e.creator ? `<span>${esc(e.creator)}</span>` : ""}</div>
    <h2><a href="${esc(e.url)}">${esc(e.title)}</a></h2>
    ${e.summary ? `<p>${esc(e.summary)}</p>` : ""}
    <div class="row">
      <a class="btn" href="${esc(e.url)}slides.html">Slides${e.slides ? ` · ${e.slides}` : ""}</a>
      <a class="btn run" href="${esc(e.url)}test.html">Test${e.questions ? ` · ${e.questions} in bank` : ""}</a>
      ${e.source ? `<a class="src" href="${esc(e.source)}">original ↗</a>` : ""}
    </div>
  </article>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(NAME)}</title>
<meta name="description" content="Ideas worth keeping, as slide decks to skim and practice rounds you play until you win.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root { --bg:#f6f3ee; --bg-2:#fffdf9; --text:#1b1916; --muted:#6d665d; --line:#e2dcd2; --accent:#1f7a4d; --pad:20px;
          --display:"Bricolage Grotesque",system-ui,sans-serif; --mono:"JetBrains Mono",ui-monospace,monospace; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#13110f; --bg-2:#1d1a17; --text:#f2ede6; --muted:#a39a8f; --line:#2f2a25; --accent:#45d483; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:17px/1.5 var(--display); }
  main { max-width: 760px; margin: 0 auto; padding: max(40px, env(safe-area-inset-top)) var(--pad) 60px; }
  .kicker { font: 600 12px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  h1 { font-size: clamp(44px, 12vw, 84px); line-height:.92; letter-spacing:-.04em; margin: 12px 0 14px; font-weight:800; }
  .lede { color: var(--muted); max-width: 34em; margin: 0 0 36px; }
  .card { background: var(--bg-2); border:1px solid var(--line); border-radius:16px; padding:18px 18px 16px; margin: 0 0 14px; }
  .meta { display:flex; flex-wrap:wrap; gap:10px; font: 12px var(--mono); color: var(--muted); }
  .kind { color: var(--accent); font-weight:600; text-transform:uppercase; letter-spacing:.08em; }
  .card h2 { font-size: clamp(22px, 5.4vw, 28px); line-height:1.15; letter-spacing:-.015em; margin: 8px 0 6px; }
  .card h2 a { color: inherit; text-decoration: none; }
  .card p { margin: 0 0 12px; color: var(--muted); }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .btn { font: 600 14px var(--display); text-decoration:none; color: var(--text); border:1.5px solid var(--line); border-radius: 999px; padding: 8px 14px; }
  .btn.run { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  .src { font: 12px var(--mono); color: var(--muted); margin-left: auto; }
  .empty { color: var(--muted); border: 1.5px dashed var(--line); border-radius: 16px; padding: 24px; }
</style>
</head>
<body>
<main>
  <span class="kicker">${esc(NAME)} · ${entries.length} kit${entries.length === 1 ? "" : "s"}</span>
  <h1>Read it.<br>Then win it.</h1>
  <p class="lede">Ideas worth keeping, as slide decks you can skim and practice rounds you play until you win. Miss one and it comes back until it sticks.</p>
  ${entries.length ? entries.map(card).join("") : `<p class="empty">Nothing yet.</p>`}
</main>
</body>
</html>
`;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
console.log(`${join(out, "index.html")}: ${entries.length} kit${entries.length === 1 ? "" : "s"}`);
