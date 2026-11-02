// Installs (or removes with --uninstall) the copilot-relay extension into the user's Copilot config:
//   $COPILOT_HOME/extensions/copilot-relay  (default ~/.copilot/extensions/copilot-relay)
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
const dest = path.join(home, "extensions", "copilot-relay");

if (process.argv.includes("--uninstall")) {
  rmSync(dest, { recursive: true, force: true });
  console.log(`Removed ${dest}`);
  process.exit(0);
}

const port = process.env.COPILOT_RELAY_PORT ?? 7777;
mkdirSync(dest, { recursive: true });
for (const f of ["extension.mjs", "relay-client.mjs"]) cpSync(path.join(root, "extension/copilot-relay", f), path.join(dest, f));
const noAutostart = process.argv.includes("--no-autostart");
writeFileSync(
  path.join(dest, "config.json"),
  JSON.stringify(
    {
      url: `http://127.0.0.1:${port}`,
      brokerScript: noAutostart ? null : path.join(root, "server.mjs"),
      // Extensions run inside the `copilot` binary (process.execPath = copilot, not node),
      // so remember the Node that ran this installer to start the broker with.
      nodePath: process.execPath,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Installed copilot-relay extension → ${dest}`);
console.log(noAutostart ? "Broker autostart: off (run `npm start` yourself)" : `Broker autostart: ${process.execPath} ${path.join(root, "server.mjs")}`);
console.log("Start a new `copilot` session (or /clear in a running one) to load it. Check with /env.");
