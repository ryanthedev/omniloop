// mcp.js: the request handling of a stdio MCP server (JSON-RPC 2.0), with no I/O. Pure.
// bin/omniloop-mcp.mjs reads lines from stdin, calls handle() and writes what it returns.
//
// A tool is { name, description, inputSchema, run(args) }. run returns text (or a promise of it); a throw becomes
// a tool error (isError: true), so a bad call never crashes the server.

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "omniloop", version: "0.1.0" };

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Answer one parsed JSON-RPC message. Returns the response object, or null when none is owed
 * (a notification, which has no id).
 */
export async function handle(message, tools = []) {
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string")
    return fail(message?.id ?? null, -32600, "invalid request");
  const { id, method, params } = message;
  const isNote = id === undefined || id === null;
  if (isNote) return null;
  switch (method) {
    case "initialize":
      return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const text = await tool.run(params.arguments ?? {});
        return ok(id, { content: [{ type: "text", text: String(text ?? "") }] });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

/** One input line to its response line (newline included), or "" when nothing is owed. Bad JSON gets -32700. */
export async function handleLine(line, tools) {
  if (!line.trim()) return "";
  let msg;
  try { msg = JSON.parse(line); } catch { return JSON.stringify(fail(null, -32700, "parse error")) + "\n"; }
  const r = await handle(msg, tools);
  return r ? JSON.stringify(r) + "\n" : "";
}
