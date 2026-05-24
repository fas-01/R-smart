import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";

let completeSeq = 0;

function rAutocompleteSource() {
  return async (context: CompletionContext) => {
    const word = context.matchBefore(/[\w.]+$/);
    if (!word && !context.explicit) return null;
    if (word && word.from === word.to && !context.explicit) return null;

    const prefix = word?.text ?? "";
    if (prefix.length < 1) return null;

    const seq = ++completeSeq;
    await new Promise((r) => setTimeout(r, 180));
    if (seq !== completeSeq) return null;

    try {
      const names = await invoke<string[]>("r_complete", {
        prefix,
        limit: 50,
        functions_only: true,
      });
      if (!names.length) return null;
      return {
        from: word!.from,
        options: names.map((label) => ({ label })),
      };
    } catch {
      return null;
    }
  };
}

const editorTheme = EditorView.theme({
  "&": {
    minHeight: "120px",
    fontSize: "14px",
  },
  ".cm-content": {
    fontFamily: '"Cascadia Code", Consolas, ui-monospace, monospace',
    caretColor: "var(--editor-caret)",
    padding: "12px 16px",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-editor": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--editor-text)",
  },
  ".cm-editor.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: '"Cascadia Code", Consolas, ui-monospace, monospace',
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--autocomplete-bg)",
    border: "1px solid var(--autocomplete-border)",
    borderRadius: "6px",
    color: "var(--text)",
    fontFamily: "Consolas, ui-monospace, monospace",
    fontSize: "13px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--autocomplete-selected-bg)",
    color: "var(--autocomplete-selected-text)",
  },
});

export type REditorOptions = {
  parent: HTMLElement;
  doc: string;
  onChange: (code: string) => void;
  onShiftEnter: () => void;
};

export function createREditor(opts: REditorOptions): EditorView {
  const shiftEnter = Prec.highest(
    keymap.of([
      {
        key: "Shift-Enter",
        run: () => {
          opts.onShiftEnter();
          return true;
        },
      },
    ]),
  );

  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      history(),
      closeBrackets(),
      EditorView.lineWrapping,
      editorTheme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange(u.state.doc.toString());
      }),
      shiftEnter,
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      autocompletion({
        override: [rAutocompleteSource()],
        activateOnTyping: true,
        maxRenderedOptions: 50,
      }),
    ],
  });

  return new EditorView({
    state,
    parent: opts.parent,
  });
}
