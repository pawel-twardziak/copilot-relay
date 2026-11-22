// The changes browser's list (DOM): one collapsible group per repository, then the loose files, or the empty state.
// Loaded as a classic <script> before file-preview.js, which holds the state and calls ChangesList.render.
"use strict";
(function () {

const baseName = (p) => p.split(/[/\\]/).pop() || p;
const LOOSE = "\0loose"; // the fold id of the "No repository" group (never a root)

/**
 * The list's nodes for data { repos, loose }, built with the app's element helper h. `selKey` (a ChangesModel.key)
 * marks the active row, `isShut(foldId)` tells a folded group (foldId: a repository's root, or LOOSE).
 * on: { select(key), toggle(foldId), remove(root), add() }.
 */
function render(data, { h, selKey, isShut, on }) {
  const flag = (text, title) => h("span", { class: "fp-flag", title }, text);
  const note = (text, cls = "") => h("div", { class: `fp-note${cls}` }, text);

  function row(key, title, flags, dir, name, state) {
    return h(
      "div",
      { class: `fp-row${key === selKey ? " active" : ""}`, title, onclick: () => on.select(key) },
      h("span", { class: "fp-state" }, state),
      h("span", { class: "fp-flags" }, flags),
      // the folder part gives way first, cut at its start (see .fp-dir), so the name stays readable
      h("span", { class: "fp-row-path" }, dir && h("span", { class: "fp-dir" }, h("span", {}, dir)), h("span", { class: "fp-file" }, name)),
    );
  }

  /** A collapsible group; `root` (a repository's) adds the button that removes it from the list. */
  function group(foldId, name, title, root, body) {
    const shut = isShut(foldId);
    const remove = (e) => {
      e.stopPropagation();
      on.remove(root);
    };
    return h(
      "div",
      { class: "fp-group" },
      h(
        "div",
        { class: "fp-group-head", title, onclick: () => on.toggle(foldId) },
        h("span", { class: "fp-fold" }, shut ? "▸" : "▾"),
        h("span", { class: "fp-group-name" }, name),
        root != null && h("button", { title: "Remove from the list", onclick: remove }, "✕"),
      ),
      !shut && body,
    );
  }

  function repoGroup(r) {
    const body = [];
    if (r.error) body.push(note(r.error, " err"));
    else {
      if (r.note) body.push(note(r.note));
      for (const f of r.files) {
        const { dir, name } = ChangesModel.splitName(f.path);
        const flags = [
          f.touched && flag("●", "Edited by the agent"),
          f.dirtyAtStart && flag("⏱", "Changed before the session"),
          f.committed && !f.uncommitted && flag("✓", "Committed, no uncommitted change now"),
        ];
        body.push(row(ChangesModel.key(r.root, f.path), f.path, flags, dir, name, f.state));
      }
      if (!r.files.length && !r.note) body.push(note("No changes."));
      if (r.truncated) body.push(note("Only the first 2000 files are shown."));
    }
    const since = r.at ? `\nSince ${new Date(r.at).toLocaleString()}` : "";
    return group(r.root, r.name, r.root + since, r.root, body);
  }

  if (!data) return [];
  const groups = data.repos.map(repoGroup);
  if (data.loose.length) {
    const rows = data.loose.map((p) => row(ChangesModel.key(null, p), p, [flag("●", "Edited by the agent")], "", baseName(p), ""));
    groups.push(group(LOOSE, "No repository", "Files the agent edited outside any repository", null, rows));
  }
  if (!groups.length) {
    groups.push(h("div", { class: "fp-empty" }, h("p", {}, "No repository is recorded for this session yet."), h("button", { onclick: () => on.add() }, "+ Add repository")));
  }
  return groups;
}

const ChangesList = { render, LOOSE };
globalThis.ChangesList = ChangesList;
if (typeof module !== "undefined") module.exports = ChangesList;
})();
