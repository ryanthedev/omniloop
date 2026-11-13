// intake.js: turning a rough request into a loop's name and goal. Pure; bin/omniloop.mjs `propose` makes the call.
//
// A small model (Haiku, through `claude -p`) reads only the text the person typed and proposes { id, goal }:
// a short folder name and the goal written as a person would say it. The person sees both and can edit them
// before the loop is made. Anything the model returns is checked here; a bad or missing answer falls back to
// slugify and the request as typed, so making a loop never depends on the model.
//
// Privacy rule (loops on other machines): the prompt holds the typed text and nothing else (no paths, loop ids,
// machines), and the call runs from an empty folder so Claude Code's own environment note names nothing real.

import { validId } from "./loopdir.js";
import { slugify } from "./picker.js";

export const PROPOSE_MODEL = "haiku";
export const MAX_ID = 32;
export const MAX_GOAL = 300;

export const PROPOSE_SYSTEM = "You name a piece of work from a rough request. Return id: a short folder name, 2-4 lowercase words joined by hyphens (a-z, 0-9, -), at most 32 characters. Return goal: one plain sentence (two only if the request holds that much) stating what the work is for, starting with a verb, the way a colleague would write it at the top of a ticket. Fix typos and filler. Keep every concrete detail from the request (names of things, links, numbers, ticket ids) and add nothing that isn't in it. Never refer to the person asking: no names, no pronouns, no 'the user'. Never mention folders, paths, machines, accounts, or your environment.";

export const PROPOSE_SCHEMA = { type: "object", properties: { id: { type: "string" }, goal: { type: "string" } }, required: ["id", "goal"], additionalProperties: false };

/** The `claude` arguments for a proposal (after the program name). No tools, no settings, no MCP, nothing saved. */
export function proposeArgs(request) {
  return ["-p", "--model", PROPOSE_MODEL, "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
    "--output-format", "json", "--json-schema", JSON.stringify(PROPOSE_SCHEMA), "--system-prompt", PROPOSE_SYSTEM, String(request)];
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// A path-looking word (/a/b, ~/x) in a goal means the model talked about its environment.
const PATHY = /(^|\s)(~\/|\/(private|tmp|users|home|var)\b)/i;

/** A clean id: lowercase, a-z 0-9 and single hyphens, at most MAX_ID, valid for a loop folder. "" when nothing is left. */
export function cleanId(s) {
  const id = String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, MAX_ID).replace(/-+$/, "");
  return id && validId(id) ? id : "";
}

/** Make `id` unique against `taken` with -2, -3… */
export function uniqueId(id, taken = []) {
  const used = new Set(taken);
  let out = id, n = 2;
  while (used.has(out)) out = `${id.slice(0, MAX_ID - String(n).length - 1)}-${n++}`;
  return out;
}

/** The fallback: no model. */
export function fallbackProposal(request, taken = []) {
  return { id: slugify(request, taken), goal: oneLine(request).slice(0, MAX_GOAL), source: "typed" };
}

/**
 * Check a model answer. raw: the parsed `claude -p --output-format json` result (its structured_output), or
 * anything. Returns { id, goal, source: "model" }, or the fallback when the answer is unusable.
 */
export function checkProposal(raw, request, taken = []) {
  const out = raw?.structured_output ?? raw;
  const id = cleanId(out?.id);
  const goal = oneLine(out?.goal);
  if (!id || !goal || goal.length > MAX_GOAL || PATHY.test(goal)) return fallbackProposal(request, taken);
  return { id: uniqueId(id, taken), goal, source: "model" };
}
