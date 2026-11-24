// Tests for electron/copilot-command.mjs: the Copilot command of a session as a line for the system shell.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNotFoundExit, normalizeCommand, resolveCommand, shellLine, startFailureText } from "../copilot-command.mjs";

test("normalizeCommand trims and takes an empty command", () => {
  assert.deepEqual(normalizeCommand("  copilot --x  "), { command: "copilot --x" });
  assert.deepEqual(normalizeCommand(""), { command: "" });
});
test("normalizeCommand refuses what is not one line of text", () => {
  assert.deepEqual(normalizeCommand("a\nb"), { refused: "The command must be one line." });
  assert.deepEqual(normalizeCommand("a\rb"), { refused: "The command must be one line." });
  assert.deepEqual(normalizeCommand("a\0b"), { refused: "The command must be one line." });
  assert.deepEqual(normalizeCommand("x".repeat(4001)), { refused: "The command is longer than 4000 characters." });
  assert.deepEqual(normalizeCommand(7), { refused: "The command must be text." });
});
test("resolveCommand: own, then Settings, then $COPILOT_PATH, then copilot", () => {
  assert.deepEqual(resolveCommand({ own: "a", settings: "b", envPath: "c" }), { command: "a", source: "session" });
  assert.deepEqual(resolveCommand({ own: "a", ownSource: "parent" }), { command: "a", source: "parent" });
  assert.deepEqual(resolveCommand({ own: "", settings: "b", envPath: "c" }), { command: "b", source: "settings" });
  assert.deepEqual(resolveCommand({ envPath: "c" }), { command: "c", source: "settings" });
  assert.deepEqual(resolveCommand({}), { command: "copilot", source: "settings" });
});
test("resolveCommand skips a stored value that is not a valid command", () => {
  assert.deepEqual(resolveCommand({ own: "a\nb", settings: 7, envPath: "x".repeat(5000) }), { command: "copilot", source: "settings" });
});
const posix = { platform: "linux", isFile: (p) => p === "/opt/my tools/copilot" || p === "/opt/it's/copilot" };
test("shellLine (POSIX)", () => {
  assert.equal(shellLine("copilot", ["--acp", "--stdio"], posix), "copilot --acp --stdio");
  assert.equal(shellLine("FOO=1 copilot --x", ["--acp", "--stdio"], posix), "FOO=1 copilot --x --acp --stdio");
  assert.equal(shellLine("/opt/my tools/copilot", ["--acp", "--stdio"], posix), "'/opt/my tools/copilot' --acp --stdio");
  assert.equal(shellLine("/opt/it's/copilot", ["--acp"], posix), `'/opt/it'\\''s/copilot' --acp`);
  assert.equal(shellLine("/opt/my tools/copilot --x", ["--acp"], posix), "/opt/my tools/copilot --x --acp"); // not a file: as written
  assert.equal(shellLine("my tools/copilot", ["--acp"], { ...posix, isFile: () => true }), "my tools/copilot --acp"); // relative: never checked
});
const win = { platform: "win32", pathext: ".COM;.EXE;.CMD", isFile: (p) => p === "C:\\Program Files\\GH\\copilot.EXE" || p === "C:\\Users\\me\\npm\\copilot.cmd" };
test("shellLine (Windows)", () => {
  assert.equal(shellLine("C:\\Users\\me\\npm\\copilot.cmd", ["--acp"], win), '"C:\\Users\\me\\npm\\copilot.cmd" --acp');
  assert.equal(shellLine("C:\\Program Files\\GH\\copilot", ["--acp"], win), '"C:\\Program Files\\GH\\copilot" --acp'); // PATHEXT
  assert.equal(shellLine('"C:\\Program Files\\GH\\copilot.exe" --x', ["--acp"], win), '"C:\\Program Files\\GH\\copilot.exe" --x --acp');
  assert.equal(shellLine("copilot --x", ["--acp"], win), "copilot --x --acp");
});
test("shellLine refuses an argument of the app that is not a plain word", () => {
  assert.throws(() => shellLine("copilot", ["--context", "a b"], posix));
});
test("startFailureText names the command and where it is set", () => {
  const base = { command: "cop --x", detail: "copilot exited (127)", loginHint: "LOGIN", generalHint: "GENERAL" };
  assert.equal(startFailureText({ ...base, source: "session", notFound: true, login: false }),
    'Could not start "cop --x": copilot exited (127)\n\nThe program was not found, or cannot be run. This is this session\'s own command. Change it in the session\'s Setup.');
  assert.equal(startFailureText({ ...base, source: "parent", notFound: false, login: false }),
    'Could not start "cop --x": copilot exited (127)\n\nGENERAL This is the command from the child\'s approval card, which starts as the parent session\'s command. Change it on the next card, or in the parent\'s Setup.');
  assert.equal(startFailureText({ ...base, source: "settings", notFound: false, login: true }), 'Could not start "cop --x": copilot exited (127)\n\nLOGIN');
});
// Copilot (or the shell) ran the command and it ended with a message of its own, e.g. an argument it does not take:
// the remedy is the command, not installing Copilot
test("startFailureText: a command that stopped by itself is told to check its arguments", () => {
  const base = { command: "cop --bad", source: "session", detail: "copilot exited (1): Invalid rule", notFound: false, login: false, loginHint: "LOGIN", generalHint: "GENERAL", stopped: true };
  assert.equal(startFailureText({ ...base, platform: "linux" }),
    'Could not start "cop --bad": copilot exited (1): Invalid rule\n\nThe command stopped (see above). Check the program and its arguments; if they are right, check that you are signed in (`copilot login` in a terminal). This is this session\'s own command. Change it in the session\'s Setup.');
  assert.equal(startFailureText({ ...base, platform: "win32" }),
    'Could not start "cop --bad": copilot exited (1): Invalid rule\n\nThe command stopped (see above). Check that the program is installed, and its arguments (on Windows only double quotes "…" group an argument); if they are right, check that you are signed in (`copilot login` in a terminal). This is this session\'s own command. Change it in the session\'s Setup.');
  // the login and not-found remedies still come first
  assert.equal(startFailureText({ ...base, login: true }), 'Could not start "cop --bad": copilot exited (1): Invalid rule\n\nLOGIN');
  assert.match(startFailureText({ ...base, notFound: true }), /The program was not found, or cannot be run\. This is this session's own command\./);
  // not stopped by itself (a timeout, a signal): the general remedy
  assert.match(startFailureText({ ...base, stopped: false }), /\n\nGENERAL This is this session's own command\./);
});
test("isNotFoundExit", () => {
  assert.equal(isNotFoundExit({ exitCode: 127 }, "linux"), true);
  assert.equal(isNotFoundExit({ exitCode: 126 }, "darwin"), true);
  assert.equal(isNotFoundExit({ exitCode: 1 }, "linux"), false);
  assert.equal(isNotFoundExit({ exitCode: 127 }, "win32"), false);
});
