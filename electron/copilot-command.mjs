// The Copilot command of a session: what the user typed, which command a start gets, the line handed to the system
// shell, and the wording of a failed start. Pure: nothing here starts a process.
import { statSync } from "node:fs";
import path from "node:path";

export const COMMAND_MAX = 4000;

const REFUSED_BREAK = "The command must be one line.";
const REFUSED_LONG = `The command is longer than ${COMMAND_MAX} characters.`;
const REFUSED_TYPE = "The command must be text.";
const NOT_FOUND = "The program was not found, or cannot be run.";
const WHERE = {
  session: "This is this session's own command. Change it in the session's Setup.",
  settings: "This is the command from Settings. Change it there, or give the session its own Copilot command.",
  parent: "This is the command from the child's approval card, which starts as the parent session's command. Change it on the card, or in the parent's Setup.",
};
// the command ran and ended with a message of its own (an argument it does not take, a shell error): the remedy is
// the command. cmd.exe does not treat ' as a quote, so a line written for a POSIX shell fails this way on Windows.
const stoppedHint = (platform) =>
  "The command stopped with the message above. Check the program and its arguments" +
  (platform === "win32" ? ' (on Windows only double quotes "…" group an argument)' : "") +
  "; if they are right, check that you are signed in (`copilot login` in a terminal).";

/** The trimmed command (an empty one means "none"), or why it is refused. */
export function normalizeCommand(value) {
  if (typeof value !== "string") return { refused: REFUSED_TYPE };
  if (/[\r\n\0]/.test(value)) return { refused: REFUSED_BREAK };
  const command = value.trim();
  if (command.length > COMMAND_MAX) return { refused: REFUSED_LONG };
  return { command };
}

// A valid, non-empty command, or "" (a refused value counts as none).
function usable(value) {
  return normalizeCommand(value).command || "";
}

/** The first valid non-empty of own, settings and $COPILOT_PATH, else `copilot`. */
export function resolveCommand({ own, settings, envPath, ownSource = "session" } = {}) {
  const o = usable(own);
  if (o) return { command: o, source: ownSource };
  return { command: usable(settings) || usable(envPath) || "copilot", source: "settings" };
}

function defaultIsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The line for the system shell: the command, then the app's own arguments. A command that is the path of an
 *  existing file (so it may hold spaces) is quoted; anything else is the user's own shell text, as written. */
export function shellLine(command, args, { platform = process.platform, isFile = defaultIsFile, pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" } = {}) {
  for (const a of args) if (!/^[\w-]+$/.test(a)) throw new Error(`Not a plain argument: ${a}`);
  const win = platform === "win32";
  let head = command;
  if (win ? path.win32.isAbsolute(command) : path.posix.isAbsolute(command)) {
    const candidates = win ? [command, ...pathext.split(";").filter(Boolean).map((e) => command + e)] : [command];
    if (candidates.some((c) => isFile(c))) head = win ? `"${command}"` : `'${command.replaceAll("'", "'\\''")}'`;
  }
  return [head, ...args].join(" ");
}

/** The text of a failed start: the command, the detail, then what to do about it. `stopped`: the process ended by
 *  itself with an exit code (it said why in `detail`); without it (a deadline, a signal) the general hint is given. */
export function startFailureText({ command, source, detail, notFound, login, loginHint, generalHint, stopped = false, platform = process.platform }) {
  const hint = notFound ? NOT_FOUND : stopped ? stoppedHint(platform) : generalHint;
  const tail = login ? loginHint : `${hint} ${WHERE[source]}`;
  return `Could not start "${command}": ${detail}\n\n${tail}`;
}

/** The shell's "not found" (127) or "cannot execute" (126) exit; POSIX only. */
export function isNotFoundExit(error, platform = process.platform) {
  return platform !== "win32" && (error?.exitCode === 127 || error?.exitCode === 126);
}
