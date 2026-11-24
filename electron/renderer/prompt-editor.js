// The session prompt editor: the parts from Settings folded and read-only, a template select, and the session's own
// part in a text area. One component for every place that edits an own part (the new-session dialog, the child
// approval card, a running session's prompt). pickTemplate is pure; createPromptEditor builds DOM with the app's h,
// openPromptDialog fills the static #prompt-dialog.
// Loaded as a classic <script> (sets globalThis.PromptEditor) and via require() in tests.
(function () {
  "use strict";

  /** What picking `template` does to the own part: its text at once when the text area is empty (blanks only) or
   *  holds the untouched text of the last picked template; else { ask: true }, so typed text is never lost unasked. */
  function pickTemplate(state, template) {
    if (!state.text.trim() || state.text === state.lastTemplateText) return { text: template.text, lastTemplateText: template.text };
    return { ask: true };
  }

  /** A folded, read-only part from Settings. h: the app's DOM helper. */
  const fold = (h, label, text) =>
    h("details", { class: "pe-fold" }, h("summary", {}, label), text ? h("pre", {}, text) : h("p", { class: "hint" }, "Empty. It is set in Settings."));

  /**
   * The editor. defaultPart / childPart: the Settings parts (childPart null: not a child, that fold is not shown);
   * templates: [{ id, name, text }]; own: the text the area starts with; h: the app's DOM helper (app.js). The session
   * stores the text, never which template it came from. command ({ value, settings }, optional) adds the session's
   * Copilot command field under the text area: empty means the Settings command, shown as the placeholder. Without
   * it there is no field.
   * @returns {{ el: HTMLElement, value(): string, command(): string, focus(): void }}
   */
  function createPromptEditor({ defaultPart, childPart, templates, own, command, h }) {
    let lastTemplateText = null; // the text the last picked template put in, while it is untouched or edited
    let shown = ""; // the template the select shows ("" = — none —)
    let asked = null; // the template the Replace/Keep question is about

    const area = h("textarea", { class: "pe-own", rows: "7", spellcheck: "false", placeholder: "This session's own instructions (optional)" });
    area.value = own ?? "";
    const select = h(
      "select",
      { class: "pe-template", disabled: !templates.length, title: templates.length ? null : "Templates are added in Settings" },
      // a placeholder, not a choice: picking "none" would have to drop or keep the text, and the text is what counts
      h("option", { value: "", disabled: true }, "— none —"),
      ...templates.map((t) => h("option", { value: t.id }, t.name)),
    );
    select.value = "";
    const question = h("span");
    const ask = h(
      "div",
      { class: "pe-ask", hidden: true },
      question,
      h("button", { type: "button", class: "pe-replace", onclick: () => apply(asked) }, "Replace"),
      h("button", { type: "button", class: "pe-keep", onclick: keep }, "Keep"),
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

    const commandInput = command
      ? h("input", { class: "pe-command", maxlength: "4000", spellcheck: "false", placeholder: `Settings: ${command.settings}` })
      : null;
    if (commandInput) {
      commandInput.value = command.value ?? "";
      // a text input lets plain Enter submit the form through its first submit button, which is Cancel: it does
      // nothing here (Ctrl/Cmd+Enter still reaches the dialog's own handler and accepts, as in the text area)
      commandInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.isComposing) e.preventDefault();
      });
    }

    const root = h(
      "div",
      { class: "prompt-editor" },
      fold(h, "Default (from Settings)", defaultPart),
      childPart == null ? null : fold(h, "Working with the parent (from Settings)", childPart),
      h("div", { class: "pe-template-row" }, h("span", {}, "Template:"), select),
      ask,
      area,
      commandInput &&
        h(
          "label",
          { class: "pe-command-row" },
          h("span", {}, "Copilot command"),
          commandInput,
          h("span", { class: "hint" }, "Empty: the command from Settings. May carry arguments; the app adds --acp --stdio at the end."),
        ),
    );
    return { el: root, value: () => area.value, command: () => commandInput?.value ?? "", focus: () => area.focus() };
  }

  /**
   * Shows `editor` in #prompt-dialog with the title, the OK button's label and an optional note under the editor.
   * Resolves to the editor's text on OK (or Ctrl+Enter), null on Cancel or Esc; null at once while the dialog is
   * already open for another editor.
   * onOk(text, command) (optional) runs on OK while the dialog stays open, OK and Cancel disabled and Esc ignored meanwhile: a
   * returned non-empty string is shown as the note (an error) and the dialog stays open with the text; anything
   * else (or nothing) closes it and resolves to the text. A throw counts as its message. Should the dialog close
   * while onOk runs anyway, the promise waits for onOk and resolves to the text only if onOk accepted it.
   */
  function openPromptDialog({ title, okLabel, note, editor, onOk }) {
    const dlg = document.querySelector("#prompt-dialog");
    if (dlg.open) return Promise.resolve(null);
    // the close event comes as a task of its own, and may come after the next call opened the dialog: the call
    // before is finished here, so none of its listeners acts on this one (and a late close event of it finds the
    // dialog open, so it does not finish this one either)
    dlg._promptFinish?.();
    const body = dlg.querySelector("#prompt-body");
    const noteEl = dlg.querySelector("#prompt-note");
    const form = dlg.querySelector("form");
    const ok = dlg.querySelector("#prompt-ok");
    const cancel = dlg.querySelector("#prompt-cancel");
    const showNote = (text, error = false) => {
      noteEl.textContent = text ?? "";
      noteEl.hidden = !text;
      noteEl.classList.toggle("err", error);
    };
    dlg.querySelector("#prompt-title").textContent = title;
    ok.textContent = okLabel;
    ok.disabled = cancel.disabled = false;
    showNote(note);
    body.replaceChildren(editor.el);

    let running = null; // the onOk call in progress
    let accepted = false; // OK went through (onOk, if any, did not refuse)
    let finish; // set below: removes the listeners and resolves, once
    function accept() {
      if (running || finish.done) return;
      if (!onOk) {
        accepted = true;
        dlg.close("ok");
        return finish();
      }
      ok.disabled = cancel.disabled = true;
      running = (async () => {
        let error;
        try {
          error = await onOk(editor.value(), editor.command());
        } catch (e) {
          error = String(e?.message ?? e);
        }
        running = null;
        const refused = typeof error === "string" && error !== "";
        accepted = !refused;
        if (finish.done) return; // closed meanwhile: finish waits for this and resolves
        ok.disabled = cancel.disabled = false;
        if (refused) {
          showNote(error, true);
          editor.focus();
          return;
        }
        dlg.close("ok");
        finish();
      })();
    }
    const onKey = (e) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
      e.preventDefault();
      accept();
    };
    const onSubmit = (e) => {
      if (e.submitter !== ok) return; // Cancel closes the dialog as a form button does
      e.preventDefault();
      accept();
    };
    const onCancel = (e) => {
      if (running) e.preventDefault(); // Esc while onOk runs
    };
    const onClose = () => {
      if (!dlg.open) finish(); // open: the late close event of an earlier opening
    };
    dlg.addEventListener("keydown", onKey);
    form.addEventListener("submit", onSubmit);
    dlg.addEventListener("cancel", onCancel);
    dlg.showModal();
    editor.focus();
    return new Promise((resolve) => {
      finish = async () => {
        if (finish.done) return;
        finish.done = true;
        if (dlg._promptFinish === finish) dlg._promptFinish = null;
        dlg.removeEventListener("keydown", onKey);
        form.removeEventListener("submit", onSubmit);
        dlg.removeEventListener("cancel", onCancel);
        dlg.removeEventListener("close", onClose);
        const value = editor.value();
        if (editor.el.parentNode === body) body.replaceChildren();
        await running; // closed while onOk ran: its answer decides
        resolve(accepted ? value : null);
      };
      dlg._promptFinish = finish;
      dlg.addEventListener("close", onClose);
    });
  }

  const PromptEditor = { pickTemplate, createPromptEditor, openPromptDialog };
  globalThis.PromptEditor = PromptEditor;
  if (typeof module !== "undefined") module.exports = PromptEditor;
})();
