// Persistent peer-key → name/role store, so a Copilot session keeps its relay name across
// broker restarts and `copilot --resume`. Stored in $XDG_STATE_HOME/copilot-relay/names.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ENTRIES = 1000;

const ADJ = [
  "amber", "brave", "calm", "clever", "cosmic", "crisp", "dusty", "eager", "fuzzy", "gentle",
  "golden", "happy", "icy", "jolly", "keen", "lucky", "mellow", "misty", "nimble", "noble",
  "quiet", "rapid", "rusty", "shiny", "silent", "sly", "snowy", "sunny", "swift", "witty",
];
const ANIMAL = [
  "badger", "beaver", "bison", "crane", "falcon", "ferret", "fox", "gecko", "heron", "ibis",
  "koala", "lemur", "lynx", "marten", "moose", "newt", "otter", "owl", "panda", "puffin",
  "raven", "seal", "shrew", "sloth", "stoat", "tapir", "tiger", "walrus", "wolf", "yak",
];

export function randomName() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJ)}-${pick(ANIMAL)}`;
}

export class NameStore {
  constructor(file = defaultFile()) {
    this.file = file;
    try {
      this.data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, name, role) {
    const prev = this.data[key] ?? {};
    this.data[key] = { name, role: role ?? prev.role ?? "", seen: Date.now() };
    this.#save();
  }

  /** Names currently reserved by other keys (so new random names don't collide with them). */
  isTakenByOther(name, key) {
    return Object.entries(this.data).some(([k, v]) => k !== key && v.name === name);
  }

  #save() {
    const entries = Object.entries(this.data);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].seen - a[1].seen);
      this.data = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }
}

function defaultFile() {
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "copilot-relay", "names.json");
}
