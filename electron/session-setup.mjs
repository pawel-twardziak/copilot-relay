// The setup of a session that takes a new Copilot process: its own prompt part and its own Copilot command, saved
// together so the session restarts once.
import { normalizeCommand } from "./copilot-command.mjs";

/**
 * Save a session's own prompt and command and close its process (the caller reopens it). Refusals come back as
 * { refused } before anything changes: a prompt that is not text, a refused command, then the guards' `refusal()`.
 * Nothing changed: { unchanged: true }, nothing closed. A failed close restores both and rethrows; if saving the
 * second throws, the first is restored.
 * @param {{ sessionId: string, own: unknown, command: unknown, prompts: ReturnType<typeof import("./session-prompts.mjs").createPromptStore>,
 *           commands: ReturnType<typeof import("./session-prompts.mjs").createPromptStore>,
 *           refusal: () => string | null, close: () => Promise<void> }} o
 */
export async function saveSetup({ sessionId, own, command, prompts, commands, refusal, close }) {
  if (typeof own !== "string") return { refused: "The session's prompt must be text." };
  const typed = normalizeCommand(command);
  if (typed.refused) return { refused: typed.refused };
  const refused = refusal();
  if (refused) return { refused };
  const prevOwn = prompts.get(sessionId);
  const prevCommand = commands.get(sessionId);
  if (own === prevOwn && typed.command === prevCommand) return { unchanged: true };
  prompts.set(sessionId, own);
  try {
    commands.set(sessionId, typed.command);
  } catch (e) {
    prompts.set(sessionId, prevOwn);
    throw e;
  }
  try {
    await close();
  } catch (e) {
    try {
      prompts.set(sessionId, prevOwn);
    } finally {
      commands.set(sessionId, prevCommand);
    }
    throw e;
  }
  return { reopen: true };
}
