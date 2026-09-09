import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";

// Highlighting only: the real Wasm compiler remains the schema parser and
// diagnostic authority. No declarations are inferred from these tokens.
const language = StreamLanguage.define({
  startState: () => ({ block: false }),
  token(stream, state) {
    if (state.block) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.block = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//") || stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.block = true;
      return "comment";
    }
    if (stream.match(/"(?:[^"\\]|\\.)*(?:"|$)/)) return "string";
    if (stream.match(/@(?:0x[\da-f]+|\d+)/i)) return "meta";
    if (
      stream.match(
        /\b(?:struct|enum|interface|union|using|import|const|annotation|extends|in|of|as|fn|pub|use|impl|type|func|package|return|class|namespace|template|if|else|switch|case|var|let|try|catch)\b/,
      )
    ) return "keyword";
    if (
      stream.match(
        /\b(?:Void|Bool|U?Int(?:8|16|32|64)|Float(?:32|64)|Text|Data|List|AnyPointer|Self|String|bool|u(?:8|16|32|64)|i(?:8|16|32|64)|f(?:32|64))\b/,
      )
    ) return "typeName";
    if (stream.match(/\b(?:true|false|null|void)\b/)) return "atom";
    if (stream.match(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?)/i)) return "number";
    if (stream.match(/[a-zA-Z_$][\w$]*/)) return "variableName";
    stream.next();
    return null;
  },
});

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "0.875rem", backgroundColor: "#fff" },
  ".cm-scroller": {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    lineHeight: "1.75",
  },
  ".cm-content": { padding: "18px 0" },
  ".cm-line": { padding: "0 18px 0 10px" },
  ".cm-gutters": {
    backgroundColor: "#fff",
    color: "#919baa",
    border: "none",
    paddingLeft: "10px",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#f3f7f8" },
  ".cm-cursor": { borderLeftColor: "#087e8b" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#dceff0",
  },
  ".cm-searchMatch": { backgroundColor: "#ffeaa5" },
});

export function createEditor(
  parent,
  { label, readonly = false, onChange, onSelection, onRun },
) {
  const extensions = [
    basicSetup,
    language,
    theme,
    EditorView.contentAttributes.of({
      "aria-label": label,
      "aria-readonly": String(readonly),
      tabindex: "0",
    }),
    EditorState.readOnly.of(readonly),
    EditorView.editable.of(!readonly),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange?.(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        const position = update.state.selection.main.head;
        const line = update.state.doc.lineAt(position);
        onSelection?.(line.number, position - line.from + 1);
      }
    }),
    keymap.of([{
      key: "Mod-Enter",
      run: () => {
        onRun?.();
        return true;
      },
    }]),
  ];
  const view = new EditorView({ parent, extensions });
  return {
    view,
    state: () => view.state,
    setState: (state) => view.setState(state),
    setText: (doc) => view.setState(EditorState.create({ doc, extensions })),
    focus: () => view.focus(),
    text: () => view.state.doc.toString(),
    destroy: () => view.destroy(),
  };
}
