// The terminal-backend port: what omniloop needs from the program that owns its terminals. Two adapters implement it:
// HerdrBackend (hc and herdr-app, ./herdr.mjs) and OmniBackend (the omni CLI, ./omni.mjs). Pick one with selectBackend();
// policy that is the same for both lives in core/backend.js and bin/omniloop.mjs, never in an adapter.
//
//   name                          "herdr" | "omni"
//   words                         { read, wait, down }: how the brief and messages name this backend's tools
//   eventsReconnect               true when the watcher should reconnect after the stream ends
//   self()                        this process's own terminal id, or null
//   list() / get(addr)            terminal records (hc shape: address, labels, state, status, foreground, cwd...), labels included
//   read(addr)                    the terminal's screen as text
//   send(addr, text, {if, timeoutMs})   type a note: Promise<{ code, output }> for any exit (judge it with sendFailed)
//   label(addr, ["k=v", "k="])    set labels ("k=" deletes)
//   spawnPlan(spec) / spawn(spec) the command line / start a program. spec: { argv, cwd, labels, loop, role,
//                                 space, inLoopSpace, starter }  (space, inLoopSpace, starter: placement hints, omni ignores them)
//   kill(addr) / remove(addr)     end a terminal / forget it (never reject)
//   foregroundPid(addr)           pid of the terminal's program, or null
//   events({label})               child process whose stdout is the JSON-lines event stream
//   machines()                    names of other computers (omni: none)
//   groupOf(id)                   the loop's group handle on this computer (herdr: space id, omni: loop id), or null
//   startCoordinator(spec, {dry}) start a loop's coordinator: { address } or, dry, { plan }
//   renameGroup(h, {to, terms}) / closeGroup(h) / retireGroup(h)   follow a loop rename / close its space / drop it once its panes are gone
//   syncLoop(id, {goal, dirs}) / place(addr, loop|null, role)      mirror the loop into the backend / put a pane in it (herdr: nothing)
import { backendName } from "../../../core/backend.js";
import { nodeProc } from "../proc.mjs";
import { HerdrBackend } from "./herdr.mjs";
import { OmniBackend } from "./omni.mjs";

export function selectBackend(env = process.env, proc = nodeProc, opts = {}) {
  return new (backendName(env) === "omni" ? OmniBackend : HerdrBackend)({ proc, env, ...opts });
}
export { HerdrBackend, OmniBackend };
