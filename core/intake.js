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
// Words about the person asking ("the user", he/she…) that the request itself didn't use: the model guessed.
const PERSON = ["user", "user's", "users", "he", "she", "him", "her", "his", "hers", "they", "them", "their"];
export function personLeak(goal, request) {
  const typed = new Set(String(request ?? "").toLowerCase().match(/[a-z']+/g) ?? []);
  const said = String(goal ?? "").toLowerCase().match(/[a-z']+/g) ?? [];
  return said.find((w) => PERSON.includes(w) && !typed.has(w)) ?? null;
}
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

const wordsOf = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Words that name this computer or its person: the account's names and email, the local username, hostname and home
 * path, other machines' names. `facts`: { names: [], emails: [], user, host, home, machines: [] } (any missing).
 * Words under 3 letters are dropped (too common to mean anything). Pure: the CLI reads the facts.
 */
export function identityTerms(facts = {}) {
  const raw = [...(facts.names ?? []), ...(facts.emails ?? []), facts.user, facts.host, facts.home, ...(facts.machines ?? [])];
  const out = new Set();
  for (const r of raw) for (const w of wordsOf(r)) if (w.length >= 3) out.add(w);
  // Common words a path or a domain brings along mean nothing on their own.
  for (const w of ["users", "home", "com", "net", "org", "dev", "local", "mail", "gmail", "the"]) out.delete(w);
  return out;
}

/** The first identity word in the model's id or goal that the person didn't type themselves, or null. */
export function identityLeak(answer, request, terms) {
  if (!terms?.size) return null;
  const typed = new Set(wordsOf(request));
  for (const w of [...wordsOf(answer?.id), ...wordsOf(answer?.goal)]) if (terms.has(w) && !typed.has(w)) return w;
  return null;
}

/**
 * Check a model answer. raw: the parsed `claude -p --output-format json` result (its structured_output), or
 * anything. identity: identityTerms(...). Returns { id, goal, source: "model" }, or the fallback when the answer is
 * unusable, names a path, or names this computer or its person.
 */
export function checkProposal(raw, request, taken = [], { identity = null } = {}) {
  const out = raw?.structured_output ?? raw;
  const id = cleanId(out?.id);
  const goal = oneLine(out?.goal);
  if (!id || !goal || goal.length > MAX_GOAL || PATHY.test(goal)) return fallbackProposal(request, taken);
  // Code, not just the prompt: an answer naming this computer or its person (that the request didn't) is dropped,
  // so nothing about here reaches a loop on another machine.
  if (identityLeak({ id, goal }, request, identity) || personLeak(goal, request)) return fallbackProposal(request, taken);
  return { id: uniqueId(id, taken), goal, source: "model" };
}
