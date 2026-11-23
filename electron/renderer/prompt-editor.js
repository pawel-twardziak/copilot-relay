// The session prompt editor: the parts from Settings folded and read-only, a template select, and the session's own
// part in a text area. One component for every place that edits an own part (the new-session dialog, the child
// approval card, a running session's prompt). pickTemplate is pure; createPromptEditor and openPromptDialog build DOM.
// Loaded as a classic <script> (sets globalThis.PromptEditor) and via require() in tests.
(function () {
  "use strict";

  /** What picking `template` does to the own part: its text at once when the text area is empty (blanks only) or
   *  holds the untouched text of the last picked template; else { ask: true }, so typed text is never lost unasked. */
  function pickTemplate(state, template) {
    if (!state.text.trim() || state.text === state.lastTemplateText) return { text: template.text, lastTemplateText: template.text };
    return { ask: true };
  }

  /** A small DOM helper: el("div", { class: "x", onclick }, child, "text"). */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "class") node.className = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null && c !== false) node.append(c);
    return node;
  }

  /** A folded, read-only part from Settings. */
  const fold = (label, text) =>
    el("details", { class: "pe-fold" }, el("summary", {}, label), text ? el("pre", {}, text) : el("p", { class: "hint" }, "Empty. It is set in Settings."));

  /**
   * The editor. defaultPart / childPart: the Settings parts (childPart null: not a child, that fold is not shown);
   * templates: [{ id, name, text }]; own: the text the area starts with. The session stores the text, never which
   * template it came from.
   * @returns {{ el: HTMLElement, value(): string, focus(): void }}
   */
  function createPromptEditor({ defaultPart, childPart, templates, own }) {
    let lastTemplateText = null; // the text the last picked template put in, while it is untouched or edited
    let shown = ""; // the template the select shows ("" = — none —)
    let asked = null; // the template the Replace/Keep question is about

    const area = el("textarea", { class: "pe-own", rows: "7", spellcheck: "false", placeholder: "This session's own instructions (optional)" });
    area.value = own ?? "";
    const select = el(
      "select",
      { class: "pe-template", disabled: !templates.length, title: templates.length ? null : "Templates are added in Settings" },
      // a placeholder, not a choice: picking "none" would have to drop or keep the text, and the text is what counts
      el("option", { value: "", disabled: true }, "— none —"),
      ...templates.map((t) => el("option", { value: t.id }, t.name)),
    );
    select.value = "";
    const question = el("span");
    const ask = el(
      "div",
      { class: "pe-ask", hidden: true },
      question,
      el("button", { type: "button", class: "pe-replace", onclick: () => apply(asked) }, "Replace"),
      el("button", { type: "button", class: "pe-keep", onclick: keep }, "Keep"),
    );

    function apply(t) {
      area.value = t.text;
      lastTemplateText = t.text;
      shown = t.id;
      select.value = t.id;
      asked = null;
      ask.hidden = true;
      area.focus();
    }
    function keep() {
      select.value = shown;
      asked = null;
      ask.hidden = true;
      area.focus();
    }
    select.addEventListener("change", () => {
      const t = templates.find((x) => x.id === select.value);
      if (!t) return;
      if (!pickTemplate({ text: area.value, lastTemplateText }, t).ask) return apply(t);
      asked = t;
      question.textContent = `Replace your text with the template "${t.name}"?`;
      ask.hidden = false;
    });
    area.addEventListener("input", () => {
      if (area.value.trim()) return;
      lastTemplateText = null;
      shown = "";
      if (!asked) select.value = "";
    });

    const root = el(
      "div",
      { class: "prompt-editor" },
      fold("Default (from Settings)", defaultPart),
      childPart == null ? null : fold("Working with the parent (from Settings)", childPart),
      el("div", { class: "pe-template-row" }, el("span", {}, "Template:"), select),
      ask,
      area,
    );
    return { el: root, value: () => area.value, focus: () => area.focus() };
  }

  /**
   * Shows `editor` in #prompt-dialog with the title, the OK button's label and an optional note under the editor.
   * Resolves to the editor's text on OK (or Ctrl+Enter), null on Cancel or Esc; null at once while the dialog is
   * already open for another editor.
   */
  function openPromptDialog({ title, okLabel, note, editor }) {
    const dlg = document.querySelector("#prompt-dialog");
    if (dlg.open) return Promise.resolve(null);
    const body = dlg.querySelector("#prompt-body");
    const noteEl = dlg.querySelector("#prompt-note");
    dlg.querySelector("#prompt-title").textContent = title;
    dlg.querySelector("#prompt-ok").textContent = okLabel;
    noteEl.textContent = note ?? "";
    noteEl.hidden = !note;
    body.replaceChildren(editor.el);
    const onKey = (e) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
      e.preventDefault();
      dlg.close("ok");
    };
    dlg.addEventListener("keydown", onKey);
    dlg.returnValue = ""; // Esc keeps the previous value
    dlg.showModal();
    editor.focus();
    return new Promise((resolve) => {
      dlg.addEventListener(
        "close",
        () => {
          dlg.removeEventListener("keydown", onKey);
          const value = dlg.returnValue === "ok" ? editor.value() : null;
          body.replaceChildren();
          resolve(value);
        },
        { once: true },
      );
    });
  }

  const PromptEditor = { pickTemplate, createPromptEditor, openPromptDialog };
  globalThis.PromptEditor = PromptEditor;
  if (typeof module !== "undefined") module.exports = PromptEditor;
})();
