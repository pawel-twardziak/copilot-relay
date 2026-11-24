// The validator for a command a parent session proposes for a child. Pure, no imports: electron/ and src/ each hold
// a byte-identical copy (a test compares them). It accepts only `copilot` followed by plain arguments, so nothing
// here can reach the system shell as anything but arguments of the copilot program.

// keep equal to COMMAND_MAX in copilot-command.mjs (a test compares them)
export const CHILD_COMMAND_MAX = 4000;

const ARG_RE = /^[A-Za-z0-9_.,:=@/+-]+$/;
const REFUSED_TYPE = "The command must be text.";
const REFUSED_BREAK = "The command must be one line.";
const REFUSED_LONG = `The command is longer than ${CHILD_COMMAND_MAX} characters.`;
const REFUSED_EMPTY = "The command is empty.";

// the app sets these itself (the context tier is the `context` parameter)
const isAppFlag = (word) => word === "--acp" || word === "--stdio" || word === "--context" || word.startsWith("--context=");

/** The arguments after `copilot`, or why the command is refused. */
export function childCommandArgs(value) {
  if (typeof value !== "string") return { refused: REFUSED_TYPE };
  if (/[\r\n\0]/.test(value)) return { refused: REFUSED_BREAK };
  const line = value.trim();
  if (line.length > CHILD_COMMAND_MAX) return { refused: REFUSED_LONG };
  if (!line) return { refused: REFUSED_EMPTY };
  const [first, ...args] = line.split(/ +/);
  if (first !== "copilot") return { refused: `Only the copilot command is allowed, not "${first}".` };
  for (const word of args) {
    if (!ARG_RE.test(word)) {
      return { refused: `Argument "${word}" holds a character that is not allowed (allowed: letters, digits and _ . , : = @ / + -).` };
    }
    if (isAppFlag(word)) return { refused: `Argument "${word}" is set by the app itself.` };
  }
  return { args };
}
