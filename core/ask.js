// ask.js: the pure tests behind bin/ask-hook.mjs (Claude Code Stop and UserPromptSubmit hooks). No Node imports.

const TAIL_LINES = 3;

/** Does an agent's last message ask the user something? A question mark ending one of its last lines, or a
 *  "What you need to do" line (bold or plain, with or without a colon). */
export function asksUser(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => /^\W{0,4}what you need to do\b/i.test(l))) return true;
  return lines.slice(-TAIL_LINES).some((l) => /\?[\s*_`"')\]]*$/.test(l));
}

/** The text of the last assistant message in a Claude Code transcript (JSONL), or "". */
export function lastAssistantText(jsonl) {
  const lines = String(jsonl ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.type !== "assistant") continue;
    const c = e.message?.content;
    const text = typeof c === "string" ? c : (c ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
    if (text.trim()) return text;
  }
  return "";
}

/** Is this prompt something a person typed? Not empty, not another agent's message (hc note, socket message). */
export function isHumanPrompt(prompt) {
  const p = String(prompt ?? "").trimStart();
  return p !== "" && !p.startsWith("<hc from=") && !p.startsWith("<cross-session-message") && !p.startsWith("Another Claude session sent a message");
}
