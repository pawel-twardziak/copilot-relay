// The changes browser's list (DOM): one collapsible group per repository, then the loose files, or the empty state;
// below them the files opened from links that the list does not hold.
// Loaded as a classic <script> before file-preview.js, which holds the state and calls ChangesList.render.
"use strict";
(function () {

const baseName = (p) => p.split(/[/\\]/).pop() || p;
const LOOSE = "\0loose"; // the fold id of the "No repository" group (never a root)

/**
 * The list's nodes for data { repos, loose, opened }, built with the app's element helper h. `sel` ({ key, version } or null,
 * key a ChangesModel.key, version "uncommitted" or a commit's sha) marks the selected row, `isShut(foldId)` tells a
 * folded group (foldId: a repository's root, or LOOSE), `isUnfolded(key)` a file that shows its commits, and
 * `commitsOf(key)` gives them: undefined or "loading" while they are read, { error }, or [{ sha, subject, author, date }].
 * `opened` ([{ path, dir, name }], newest first) are the opened files to list; key(null, path) is a row's key.
 * on: { select(key), commit(key, sha), unfold(key), toggle(foldId), remove(root), add(), forget(path) }.
 */
function render(data, { h, sel, isShut, isUnfolded, commitsOf, opened = [], on }) {
  const flag = (text, title) => h("span", { class: "fp-flag", title }, text);
  const note = (text, cls = "") => h("div", { class: `fp-note${cls}` }, text);

  /** A file's row; `arrow` (a file with commits) is "▸" or "▾", else its place stays empty so the names line up.
   *  `tail` goes after the path (an opened file's button). */
  function row(key, title, flags, dir, name, state, arrow = "", tail = null) {
    const mark = sel?.key !== key ? "" : sel.version === "uncommitted" ? " active" : " current";
    const unfold = (e) => {
      e.stopPropagation(); // the fold changes, the selection does not
      on.unfold(key);
    };
    return h(
      "div",
      { class: `fp-row${mark}`, title, onclick: () => on.select(key) },
      h("span", { class: "fp-arrow", onclick: arrow ? unfold : null }, arrow),
      h("span", { class: "fp-state" }, state),
      h("span", { class: "fp-flags" }, flags),
      // the folder part gives way first, cut at its start (see .fp-dir), so the name stays readable
      h("span", { class: "fp-row-path" }, dir && h("span", { class: "fp-dir" }, h("span", {}, dir)), h("span", { class: "fp-file" }, name)),
      tail,
    );
  }

  /** The commits under an unfolded file, newest first, or a note while they are read, when they failed or are none. */
  function commitRows(key) {
    const value = commitsOf(key);
    let body;
    if (value === undefined || value === "loading") body = note("Reading…");
    else if (!Array.isArray(value)) body = note(value.error, " err");
    else if (!value.length) body = note("No commits.");
    else {
      body = value.map((c) => {
        const { label, title } = ChangesModel.commitLabel(c);
        const active = sel?.key === key && sel.version === c.sha ? " active" : "";
        return h("div", { class: `fp-commit${active}`, title, onclick: () => on.commit(key, c.sha) }, label);
      });
    }
    return h("div", { class: "fp-commits" }, body);
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
        const key = ChangesModel.key(r.root, f.path);
        const open = f.committed && isUnfolded(key);
        body.push(row(key, f.path, flags, dir, name, f.state, f.committed ? (open ? "▾" : "▸") : ""));
        if (open) body.push(commitRows(key));
      }
      if (!r.files.length && !r.note) body.push(note("No changes."));
      if (r.truncated) body.push(note("Only the first 2000 files are shown."));
    }
    const since = r.at ? `\nSince ${new Date(r.at).toLocaleString("en-GB")}` : "";
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
  if (opened.length) {
    const rows = opened.map(({ path, dir, name }) => {
      const forget = (e) => {
        e.stopPropagation(); // the row is not selected
        on.forget(path);
      };
      return row(ChangesModel.key(null, path), path, [], dir, name, "", "", h("button", { class: "fp-forget", title: "Remove from the list", onclick: forget }, "✕"));
    });
    const title = "Files opened from links in the chat that this session has not changed";
    groups.push(h("div", { class: "fp-opened" }, h("div", { class: "fp-opened-title", title }, "Opened files"), rows));
  }
  return groups;
}

const ChangesList = { render, LOOSE };
globalThis.ChangesList = ChangesList;
if (typeof module !== "undefined") module.exports = ChangesList;
})();
