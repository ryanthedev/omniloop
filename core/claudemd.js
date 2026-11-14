// claudemd.js: the loop's CLAUDE.md in full: the template when there is none, else every managed block rewritten
// (work and context, projects, goal) with the loop's own text left exactly as it is. Pure.

import { claudeMd, updateClaudeMd } from "./loopdir.js";
import { withProjectsBlock } from "./projects.js";
import { withGoalBlock } from "./goals.js";

/** `existing`: the current text, or null for none. `contexts`: [{ name, text }] (projects' CONTEXT.md). Damage goes to `notes`. */
export function refreshedClaudeMd(existing, manifest, contexts = [], notes = []) {
  const base = existing === null ? claudeMd(manifest) : updateClaudeMd(existing, manifest, notes);
  return withGoalBlock(withProjectsBlock(base, contexts, notes), manifest, notes);
}
