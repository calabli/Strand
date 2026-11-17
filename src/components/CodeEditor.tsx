// The code editor (CodeMirror 6) used to edit worktree files: syntax colors per file type, line numbers, undo and redo,
// find and replace (⌘F, ⌥⌘F), go to line (⌘L), bracket matching and auto-closing, folding, Tab indents.
// Loaded on demand (React.lazy) so the editor code only arrives when someone edits a file.

import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { LanguageDescription, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { languages } from "@codemirror/language-data";
import { classHighlighter } from "@lezer/highlight";
import { lang } from "../i18n";

export interface CodeEditorProps {
  /** Picks the syntax colors by file name */
  path: string;
  /** Initial content (read once on mount) */
  value: string;
  /** Put the cursor on this line (1-based) */
  line?: number;
  /** One level of indentation: a tab or some spaces */
  indent: string;
  onChange: (text: string) => void;
  onSave: () => void;
  /** Esc when no panel of the editor is open; return true when handled */
  onEscape?: () => boolean;
  label: string;
}

/** The editor's own words (search panel, go to line, folding) in Chinese; English is CodeMirror's default */
const ZH: Record<string, string> = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳到行",
  go: "跳转",
  "current match": "当前匹配",
  "on line": "在第几行",
  "replaced match on line $": "替换了第 $ 行的匹配",
  "replaced $ matches": "替换了 $ 处",
  "Folded lines": "已折叠",
  "Unfolded lines": "已展开",
  to: "到",
  "folded code": "折叠的代码",
  unfold: "展开",
  "Fold line": "折叠",
  "Unfold line": "展开",
  "Control character": "控制字符",
};

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--win)", color: "var(--fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--fg)", padding: "6px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--side)", color: "var(--fg2)", borderRight: "1px solid var(--line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover)", color: "var(--fg)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #f5c400 40%, transparent)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#f5c400", color: "#1a1a1a" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--chip)", border: "none", color: "var(--fg2)", padding: "0 4px" },
  ".cm-panels": { backgroundColor: "var(--side)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-tooltip": { backgroundColor: "var(--win)", border: "1px solid var(--line)", borderRadius: "6px" },
});

export default function CodeEditor({ path, value, line, indent, onChange, onSave, onEscape, label }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  // Callbacks change on every render; the editor reads the latest through refs
  const cb = useRef({ onChange, onSave, onEscape });
  cb.current = { onChange, onSave, onEscape };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const language = new Compartment();
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(classHighlighter),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        indentUnit.of(indent),
        EditorState.tabSize.of(indent === "\t" ? 4 : indent.length || 4),
        language.of([]),
        lang === "zh" ? EditorState.phrases.of(ZH) : [],
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
          { key: "Mod-l", run: gotoLine },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
          // Last: only when the search panel or another part of the editor didn't take Esc
          { key: "Escape", run: () => cb.current.onEscape?.() ?? false },
        ]),
        EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
        EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        theme,
      ],
    });
    const view = new EditorView({ state, parent: el });

    // The cursor on the requested line, scrolled to the middle
    const n = Math.min(Math.max(1, line ?? 1), view.state.doc.lines);
    const pos = view.state.doc.line(n).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();

    // Syntax colors: the language for this file name is loaded on demand
    const name = path.slice(path.lastIndexOf("/") + 1);
    let live = true;
    const desc = LanguageDescription.matchFilename(languages, name);
    desc?.load().then(
      (support) => live && view.dispatch({ effects: language.reconfigure(support) }),
      () => {},
    );
    return () => {
      live = false;
      view.destroy();
    };
    // Created once per file; the content is not driven from outside afterwards
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div className="code-editor" ref={host} />;
}
