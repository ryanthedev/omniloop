import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle, handleLine } from "../core/mcp.js";

const tools = [
  { name: "echo", description: "d", inputSchema: { type: "object" }, run: ({ x }) => `got ${x}` },
  { name: "boom", description: "d", inputSchema: { type: "object" }, run: () => { throw new Error("nope"); } },
];

test("initialize reports protocol, server and tools capability", async () => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, tools);
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.equal(r.result.serverInfo.name, "omniloop");
  assert.deepEqual(r.result.capabilities, { tools: {} });
});

test("notifications get no response", async () => {
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, tools), null);
  assert.equal(await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), tools), "");
});

test("ping and tools/list", async () => {
  assert.deepEqual((await handle({ jsonrpc: "2.0", id: 2, method: "ping" }, tools)).result, {});
  const r = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }, tools);
  assert.deepEqual(r.result.tools.map((t) => t.name), ["echo", "boom"]);
  assert.equal(r.result.tools[0].run, undefined);
});

test("tools/call returns text, and a throw becomes isError", async () => {
  const a = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { x: 7 } } }, tools);
  assert.deepEqual(a.result.content, [{ type: "text", text: "got 7" }]);
  assert.notEqual(a.result.isError, true);
  const b = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom" } }, tools);
  assert.equal(b.result.isError, true);
  assert.equal(b.result.content[0].text, "nope");
});

test("unknown method is -32601; bad JSON is -32700", async () => {
  assert.equal((await handle({ jsonrpc: "2.0", id: 6, method: "nope" }, tools)).error.code, -32601);
  assert.equal(JSON.parse(await handleLine("{oops", tools)).error.code, -32700);
});

test("the server speaks over stdio and lists its four tools", async () => {
  const bin = fileURLToPath(new URL("../bin/omniloop-mcp.mjs", import.meta.url));
  const p = spawn("node", [bin], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let buf = "";
  const got = new Promise((res) => p.stdout.on("data", (d) => {
    buf += d; const parts = buf.split("\n"); buf = parts.pop();
    for (const l of parts) if (l) lines.push(JSON.parse(l));
    if (lines.length >= 2) res();
  }));
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await got;
  p.stdin.end();
  assert.equal(lines[0].result.serverInfo.name, "omniloop");
  assert.deepEqual(lines[1].result.tools.map((t) => t.name).sort(), ["list_sessions", "read_feed", "say", "send_message"]);
});
