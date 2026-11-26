// The packaged app contains only the files listed in package.json's build.files: every module main.mjs loads,
// directly or through other modules, has to be listed, or the installed app fails at start (ERR_MODULE_NOT_FOUND).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).build.files;
const listed = (rel) => files.includes(rel) || files.some((f) => f.endsWith("/**") && rel.startsWith(f.slice(0, -2)));

/** Relative module paths a source file imports (static `from "./x"` and dynamic `import("./x")`). */
function localImports(rel) {
  const src = readFileSync(path.join(ROOT, rel), "utf8");
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
  return specs.map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)));
}

test("every module main.mjs loads is in build.files", () => {
  const seen = new Set();
  const queue = ["main.mjs", "preload.cjs"];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    queue.push(...localImports(rel).filter((r) => !r.startsWith("renderer/") && r !== "relay-client.mjs"));
  }
  const missing = [...seen].filter((rel) => !listed(rel));
  assert.deepEqual(missing, [], `add to electron/package.json build.files: ${missing.join(", ")}`);
});

test("the SDK is pinned and its platform runtimes are excluded", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@microsoft/copilot-sdk"], "2.0.1");
  assert.ok(pkg.build.files.includes("!node_modules/@microsoft/copilot-sdk-*/**"));
});
