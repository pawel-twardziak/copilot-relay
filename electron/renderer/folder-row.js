// A folder with a "Change…" button: the new-session dialog and the delegation card show the folder a session starts in
// and let it be changed. The path is set as text (it can come from a model); the picker is the caller's (pick).
// Loaded as a classic <script> (sets globalThis.FolderRow) and via require() in tests.
(function () {
  "use strict";

  const CHANGE = "Change…";

  /**
   * value: the folder it starts with; pick(current): resolves to the chosen folder or null (cancelled); h: the app's
   * DOM helper. el._row is the returned object, for the UI checks (the native picker cannot be driven).
   * @returns {{ el: HTMLElement, value(): string, set(path: string): void, setDisabled(b: boolean): void }}
   */
  function createFolderRow({ value, pick, h }) {
    let current = value;
    let picking = false;
    const path = h("span", { class: "folder-path" });
    const button = h("button", { type: "button", class: "folder-change", onclick: change }, CHANGE);
    const set = (p) => {
      current = p;
      path.textContent = p;
      path.title = p;
    };
    async function change() {
      if (picking) return;
      picking = true;
      try {
        const chosen = await pick(current);
        if (chosen) set(chosen);
      } finally {
        picking = false;
      }
    }
    set(value);
    const row = {
      el: h("div", { class: "folder-row" }, path, button),
      value: () => current,
      set,
      setDisabled: (b) => {
        button.disabled = b;
      },
    };
    row.el._row = row;
    return row;
  }

  const FolderRow = { createFolderRow, CHANGE };
  globalThis.FolderRow = FolderRow;
  if (typeof module !== "undefined") module.exports = FolderRow;
})();
