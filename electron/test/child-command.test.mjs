// Tests for the command validator, run against both copies (electron/ and src/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMAND_MAX } from "../copilot-command.mjs";
import * as electronCopy from "../child-command.mjs";
import * as relayCopy from "../../src/child-command.mjs";

const R_TYPE = "The command must be text.";
const R_BREAK = "The command must be one line.";
const R_LONG = "The command is longer than 4000 characters.";
const R_EMPTY = "The command is empty.";
const program = (first) => `Only the copilot command is allowed, not "${first}".`;
const badChar = (word) => `Argument "${word}" holds a character that is not allowed (allowed: letters, digits and _ . , : = @ / + -).`;
const appFlag = (word) => `Argument "${word}" is set by the app itself.`;

for (const [name, { childCommandArgs, CHILD_COMMAND_MAX }] of [["electron", electronCopy], ["src", relayCopy]]) {
  test(`${name}: passing commands give their arguments`, () => {
    assert.deepEqual(childCommandArgs("copilot"), { args: [] });
    assert.deepEqual(childCommandArgs("  copilot   --foo  bar "), { args: ["--foo", "bar"] });
    assert.deepEqual(childCommandArgs("copilot --model=gpt-5 -x a/b@c+d,e:f"), {
      args: ["--model=gpt-5", "-x", "a/b@c+d,e:f"],
    });
  });

  test(`${name}: the limit is the app's command limit`, () => {
    assert.equal(CHILD_COMMAND_MAX, 4000);
  });

  test(`${name}: refuses what is not text, one line or of a sane size`, () => {
    assert.deepEqual(childCommandArgs(5), { refused: R_TYPE });
    for (const v of ["copilot\n--x", "copilot\r", "copilot\0"]) assert.deepEqual(childCommandArgs(v), { refused: R_BREAK }, JSON.stringify(v));
    assert.deepEqual(childCommandArgs("copilot " + "a".repeat(4000)), { refused: R_LONG });
    assert.deepEqual(childCommandArgs(""), { refused: R_EMPTY });
    assert.deepEqual(childCommandArgs("   "), { refused: R_EMPTY });
  });

  test(`${name}: only the copilot program is allowed`, () => {
    for (const line of ["node x", "/usr/bin/copilot", "Copilot", "copilot.exe"]) {
      const first = line.split(" ")[0];
      assert.deepEqual(childCommandArgs(line), { refused: program(first) }, line);
    }
  });

  test(`${name}: refuses each shell character inside an argument`, () => {
    for (const c of [";", "|", "&", "$", "`", "<", ">", "(", ")", "*", "?", "~", "!", "\\", "%", "'", '"']) {
      const word = `--x${c}y`;
      assert.deepEqual(childCommandArgs(`copilot ${word}`), { refused: badChar(word) }, c);
    }
  });

  test(`${name}: only spaces separate words`, () => {
    // a tab right after the program makes the first word "copilot\t--x"
    assert.deepEqual(childCommandArgs("copilot\t--x"), { refused: program("copilot\t--x") });
    // a tab between arguments lands inside a word
    assert.deepEqual(childCommandArgs("copilot --a\t--b"), { refused: badChar("--a\t--b") });
  });

  test(`${name}: refuses the flags the app sets itself`, () => {
    for (const w of ["--acp", "--stdio", "--context", "--context=long_context"]) {
      assert.deepEqual(childCommandArgs(`copilot ${w}`), { refused: appFlag(w) }, w);
    }
  });
}

test("both copies are byte-identical", () => {
  const read = (u) => readFileSync(new URL(u, import.meta.url));
  assert.ok(read("../child-command.mjs").equals(read("../../src/child-command.mjs")));
});

test("CHILD_COMMAND_MAX equals COMMAND_MAX", () => {
  assert.equal(electronCopy.CHILD_COMMAND_MAX, COMMAND_MAX);
});
