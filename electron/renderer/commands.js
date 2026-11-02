// Pure helpers for the slash-command popup and the agent picker (no DOM).
// Loaded as a classic <script> (sets globalThis.SlashCommands) and via require() in tests.
"use strict";

// Text after the leading "/" up to the caret, while the caret is still inside the first word.
function commandToken(text, caret) {
  if (text[0] !== "/" || caret < 1) return null;
  const head = text.slice(0, caret);
  if (/\s/.test(head)) return null;
  return head.slice(1);
}

// Prefix matches first, then substring matches; original order kept within each group.
function filterCommands(commands, token) {
  const t = token.toLowerCase();
  const starts = [];
  const contains = [];
  for (const c of commands) {
    const i = c.name.toLowerCase().indexOf(t);
    if (i === 0) starts.push(c);
    else if (i > 0) contains.push(c);
  }
  return [...starts, ...contains];
}

function insertCommand(text, name) {
  const rest = text.replace(/^\/\S*/, "").replace(/^\s+/, "");
  const head = `/${name} `;
  return { text: head + rest, caret: head.length };
}

function parseWithArg(text, command) {
  const m = new RegExp(`^/${command}(?:\\s+([\\s\\S]*))?$`).exec(text.trim());
  return m ? (m[1] ?? "").trim() : null;
}

function parseAgentCommand(text) {
  const arg = parseWithArg(text, "agent");
  return arg === null ? null : { arg };
}

function parseRenameCommand(text) {
  const name = parseWithArg(text, "rename");
  return name ? { name } : null;
}

function isCommandPrompt(text) {
  return text.trimStart().startsWith("/");
}

function matchAgent(options, arg) {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  const found = options.find((o) => String(o.value).toLowerCase() === a || String(o.name ?? "").toLowerCase() === a);
  if (found) return found;
  if (a === "copilot" || a === "default") return options.find((o) => o.value === "") ?? null;
  return null;
}

function agentPickerModel(option) {
  const entries = [];
  const seen = new Set();
  for (const o of option?.options ?? []) {
    if (seen.has(o.value)) continue;
    seen.add(o.value);
    entries.push({ value: o.value, name: o.name ?? o.value, description: o.description ?? "" });
  }
  const current = option?.currentValue ?? "";
  if (option?.currentValue != null && !seen.has(current)) {
    entries.push({ value: current, name: `${current} (not found)`, description: "", missing: true });
  }
  return { show: entries.length > 1, entries, current };
}

const SlashCommands = {
  commandToken,
  filterCommands,
  insertCommand,
  parseAgentCommand,
  parseRenameCommand,
  isCommandPrompt,
  matchAgent,
  agentPickerModel,
};
globalThis.SlashCommands = SlashCommands;
if (typeof module !== "undefined") module.exports = SlashCommands;
