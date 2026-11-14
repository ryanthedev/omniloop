// goalwords.js: does a loop goal read like a person wrote it? The user reads the goal at a glance (panel, tab bar),
// so it should be one plain sentence about the outcome. Plans, file paths and job numbers belong in tasks.
// Pure: returns the problems found, an empty list when the goal reads fine. omniloop goal prints them as a hint.

export const GOAL_MAX_WORDS = 30;

/** The ways `text` reads like notes rather than a goal; [] when it reads fine. */
export function goalProblems(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const out = [];
  const words = t.split(/\s+/).length;
  if (words > GOAL_MAX_WORDS) out.push(`${words} words; keep it to one sentence of ${GOAL_MAX_WORDS} or fewer`);
  if (/(^|\s)(~|\.{0,2})\/\S|\S\/\S+\.[a-z]{1,5}\b/i.test(t)) out.push("a file path; name the thing, not the file");
  if (/\b(job|phase|step|stage|milestone)\s*#?\d+[a-z]?\b|\b\d+[a-z]\b/i.test(t)) out.push("internal numbers (like job 5d or phase 7) the user won't remember");
  if ((t.match(/\(/g) ?? []).length >= 2) out.push("asides in brackets; drop them or make them tasks");
  if ((t.match(/[.;]\s+\S/g) ?? []).length >= 2) out.push("several sentences; one is enough");
  return out;
}

/** The hint omniloop goal prints after saving a goal that has problems, or null. */
export function goalHint(text, n = 1) {
  const p = goalProblems(text);
  if (!p.length) return null;
  return `This goal reads like notes, not a goal: ${p.join("; ")}.\n`
    + `Reword it: omniloop goal edit ${n} "<one plain sentence the user would say: what is true when it's done>". `
    + "Put the plan, files and steps in tasks.";
}
