// A fake `omni` executable for tests: records each call's argv (one JSON line in <dir>/calls.log) and answers from <dir>/cfg.json:
//   { terminals: [...], loops: { id: {goal, workspace} }, screens: [..one capture per call, last repeats..], sendExit, sendErr, failVerbs: [..] }
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function fakeOmni(dir, cfg = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const set = (c) => writeFileSync(join(dir, "cfg.json"), JSON.stringify(c));
  set({ terminals: [], loops: {}, screens: [""], ...cfg });
  writeFileSync(join(bin, "omni"), `#!/usr/bin/env node
const fs = require("fs"), d = ${JSON.stringify(dir)}, a = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(d + "/cfg.json", "utf8"));
fs.appendFileSync(d + "/calls.log", JSON.stringify(a) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const verb = a[0] === "loop" ? "loop " + a[1] : a[0];
if ((cfg.failVerbs || []).includes(verb)) { process.stderr.write("omni: denied (" + verb + ")\\n"); process.exit(cfg.failCode || 4); }
if (a[0] === "ls") out({ terminals: cfg.terminals });
else if (a[0] === "get") { const t = cfg.terminals.find((x) => x.address === val("--pane")); if (t) out(t); else { process.stderr.write("omni: no such pane\\n"); process.exit(1); } }
else if (a[0] === "capture") { const n = +(fs.existsSync(d + "/n") ? fs.readFileSync(d + "/n", "utf8") : 0); fs.writeFileSync(d + "/n", String(n + 1)); process.stdout.write((cfg.screens[Math.min(n, cfg.screens.length - 1)]) + "\\n"); }
else if (a[0] === "send") { if (cfg.sendErr) process.stderr.write(cfg.sendErr); process.exit(cfg.sendExit || 0); }
else if (a[0] === "label") out({});
else if (a[0] === "loop" && a[1] === "new") { cfg.loops[a[2]] = { goal: val("--goal") }; fs.writeFileSync(d + "/cfg.json", JSON.stringify(cfg)); out({ id: a[2] }); }
else if (a[0] === "loop" && a[1] === "rm") { delete cfg.loops[a[2]]; fs.writeFileSync(d + "/cfg.json", JSON.stringify(cfg)); out({}); }
else if (a[0] === "spawn") out({ pane: "pn_NEW" + (cfg.spawnN || 1), address: "pn_NEW" + (cfg.spawnN || 1), loop: val("--loop") });
else if (a[0] === "loop" && a[1] === "get") { const l = cfg.loops[a[2]]; if (l) out({ id: a[2], ...l }); else { process.stderr.write("omni: no such loop\\n"); process.exit(1); } }
else if (a[0] === "events") { out({ seq: 1, terminals: cfg.terminals, loops: [] }); for (const [ms, ev] of cfg.events || []) setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: ev }), ms); if (!cfg.eventsEnd) setInterval(() => {}, 1e6); else setTimeout(() => process.exit(0), cfg.eventsEnd); }
else out({});
`);
  chmodSync(join(bin, "omni"), 0o755);
  return {
    bin, set,
    calls: () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    reset: () => { try { writeFileSync(join(dir, "calls.log"), ""); writeFileSync(join(dir, "n"), "0"); } catch {} },
  };
}
