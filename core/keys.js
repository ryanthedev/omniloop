// Every Omniloop control, as herdr-help sections ([title, [[keys, what it does], ...]]): the ? overlay in the
// Omniloop pane and the picker shows this list. Keys split on single spaces into keycaps; "click" is the mouse.
// Keep it in step with the mods: mod/ (pane), mod-picker/, mod-tabs/, mod-pane/, mod-status/, and keys.json.

export const KEYS = [
  ["OPEN", [
    ["⌘O", "the picker: find a loop or start a new one"],
    ["⌥⌘O", "the Omniloop pane (all loops, goals, tasks)"],
    ["⌘⇧U", "show or hide the docked Omniloop panel (⌘H / ⌘L move the keyboard into it)"],
    ["?", "this list (in the pane, or the picker with an empty box)"],
  ]],
  ["PICKER (⌘O)", [
    ["type", "fuzzy-search every loop: name, goal, sessions, folders, projects, tasks, recent chat"],
    ["↑ ↓", "move"],
    ["ctrl-n ctrl-p", "move (next / previous)"],
    ["Enter", "jump to a loop's lead (pinned first, then the loops you talked to last)"],
    ["Enter", "on an idle loop (nobody running): start a fresh lead that catches up and asks you"],
    ["⌘P", "pin or unpin the loop under the cursor (numbered 1-9)"],
    ["⌘↑ ⌘↓", "move a pinned loop up or down"],
    ["⌘Enter", "start a new loop from what you typed"],
    ["Esc", "back a step, then close"],
    ["click", "same as Enter"],
  ]],
  ["NEW LOOP", [
    ["Enter", "machine (when you have others), then goal, then folders and projects, then check"],
    ["type", "goal step: loops that might already cover it show below; Enter on one opens it"],
    ["Tab", "folders and projects step: add or remove the one under the cursor"],
    ["↑ ↓", "check step: switch between the folder name and the goal; type to edit"],
    ["Enter", "check step: create the loop, its space and its lead"],
  ]],
  ["PINS (leader)", [
    ["ctrl-space y u i o", "jump to pinned loop 1-4's lead"],
  ]],
  ["OMNILOOP PANE", [
    ["click", "a loop's name: fold or unfold its members"],
    ["click", "a member: jump to its terminal"],
    ["click", "a box under YOUR TASKS: mark it done"],
    ["click", "sound: alerts only for you, or off"],
    ["click", "chat (on a loop's name): show that loop's chat at the bottom"],
    ["click", "a #tag in the chat: show only that thread; click again, or all, for everything"],
    ["click", "the chat box, then type"],
    ["Enter", "in the chat box: post as you and tell the lead (typed in if idle, else held for the watcher)"],
    ["★", "the loop's lead; \"you lead\" means no agent leads"],
    ["N for you", "agents waiting on you (blocked, done, stalled)"],
  ]],
  ["OMNILOOP PANEL (docked)", [
    ["1 2 Tab", "this loop / all loops"],
    ["j k ↑ ↓", "move"],
    ["g G", "top / bottom"],
    ["Enter", "a loop in All: open it; a member or task: jump to its terminal"],
    ["Enter", "a folder or project: show its CLAUDE.md, AGENTS.md, CONTEXT.md, skills and agents; on a file: open it"],
    ["a", "add a folder to the loop (pick one, or type a path)"],
    ["p", "add a project to the loop"],
    ["?", "this list (Esc closes)"],
    ["x space", "finish your todo under the cursor"],
    ["o", "jump to the loop's lead"],
    ["/", "filter all loops (Esc clears)"],
    ["f", "follow your terminal's loop again"],
    ["Esc", "hand the keyboard back to your terminal"],
    ["click", "a folder or project: fold or unfold its files; a file: open it"],
  ]],
  ["TAB BAR (in a loop)", [
    ["click", "a session: jump there, in any space"],
    ["wheel", "next / previous tab"],
    ["◎ name", "the loop you're in; outside a loop it's the space's own tabs"],
  ]],
  ["TAB BAR (no loop)", [
    ["click", "select a tab; drag to reorder"],
    ["dbl-click", "rename a tab"],
    ["right-click", "tab menu"],
    ["+", "new tab"],
  ]],
  ["PANE HEADER", [
    ["click", "focus the pane"],
    ["hover", "split right, split down, zoom, close"],
    ["◎ loop ★", "this terminal's loop (★ = its lead)"],
  ]],
  ["STATUS BAR", [
    ["click", "open the picker"],
    ["◎ loop", "where you are: goal, who you report to, lead, sessions"],
  ]],
];
