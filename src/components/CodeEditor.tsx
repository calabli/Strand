// The code editor (CodeMirror 6) used to edit worktree files: syntax colors per file type, line numbers, undo and redo,
// find and replace (⌘F, ⌥⌘F), go to line (⌘L), bracket matching and auto-closing, folding, Tab indents.
// Loaded on demand (React.lazy) so the editor code only arrives when someone edits a file.

import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
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
import { matches } from "../keymap";
import { navigateAt } from "../nav";
import { rainbowBrackets } from "./rainbow";
import { isMac } from "./format";

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
  /** Focus left the editor (auto-save) */
  onBlur?: () => void;
  /** Move the cursor to this line when n changes (a jump into a file being edited) */
  goto?: { line: number; n: number } | null;
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

// While ⌘ (Ctrl) is held, the word under the pointer is underlined as a link (like an IDE)
const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-nav-link" });
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
function updateLink(view: EditorView, x: number, y: number, on: boolean) {
  const cur = view.state.field(linkField);
  let next: { from: number; to: number } | null = null;
  if (on) {
    const pos = view.posAtCoords({ x, y });
    const w = pos == null ? null : view.state.wordAt(pos);
    if (w && /^[A-Za-z_$]/.test(view.state.sliceDoc(w.from, w.to))) next = { from: w.from, to: w.to };
  }
  let same = false;
  cur.between(0, view.state.doc.length, (a, b) => {
    same = !!next && a === next.from && b === next.to;
  });
  if (same || (!next && cur.size === 0)) return;
  view.dispatch({ effects: setLink.of(next) });
}

export default function CodeEditor({ path, value, line, indent, onChange, onSave, onBlur, onEscape, label, goto }: CodeEditorProps) {
  const viewRef = useRef<EditorView | null>(null);
  const host = useRef<HTMLDivElement>(null);
  // Callbacks change on every render; the editor reads the latest through refs
  const cb = useRef({ onChange, onSave, onBlur, onEscape });
  cb.current = { onChange, onSave, onBlur, onEscape };

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
        rainbowBrackets(path),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        indentUnit.of(indent),
        EditorState.tabSize.of(indent === "\t" ? 4 : indent.length || 4),
        language.of([]),
        linkField,
        lang === "zh" ? EditorState.phrases.of(ZH) : [],
        keymap.of([
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
        // Save with the shortcut set in Settings (⌘S / Ctrl+S by default), before the editor's own keys
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: (e, view) => {
              view.dom.classList.toggle("nav-mod", (isMac ? e.metaKey : e.ctrlKey) && e.key !== "Shift");
              if (matches(e, "save")) {
                e.preventDefault();
                cb.current.onSave();
                return true;
              }
              // ⌘B / ⌥F7 at the cursor: definition, usages, or the file an import names
              const def = matches(e, "goDefinition");
              const all = matches(e, "allDefinitions");
              const use = matches(e, "findUsages");
              if (!def && !all && !use) return false;
              const pos = view.state.selection.main.head;
              const l = view.state.doc.lineAt(pos);
              navigateAt(l.text, pos - l.from, { path, line: l.number }, use ? "usages" : all ? "all" : "def");
              e.preventDefault();
              return true;
            },
            keyup: (e, view) => {
              view.dom.classList.toggle("nav-mod", isMac ? e.metaKey : e.ctrlKey);
              if (!(isMac ? e.metaKey : e.ctrlKey)) updateLink(view, 0, 0, false);
              return false;
            },
            mousemove: (e, view) => {
              updateLink(view, e.clientX, e.clientY, (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey);
              return false;
            },
            mouseleave: (_e, view) => {
              updateLink(view, 0, 0, false);
              return false;
            },
            // ⌘-click (Ctrl-click elsewhere) jumps instead of adding a cursor
            mousedown: (e, view) => {
              if (e.button !== 0 || !(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return false;
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos == null) return false;
              const l = view.state.doc.lineAt(pos);
              if (!navigateAt(l.text, pos - l.from, { path, line: l.number })) return false;
              e.preventDefault();
              return true;
            },
            blur: () => {
              cb.current.onBlur?.();
              return false;
            },
          }),
        ),
        EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
        EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        theme,
      ],
    });
    const view = new EditorView({ state, parent: el });
    viewRef.current = view;

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
      viewRef.current = null;
      view.destroy();
    };
    // Created once per file; the content is not driven from outside afterwards
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // A jump to a line of this file while editing it
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !goto) return;
    const n = Math.min(Math.max(1, goto.line), view.state.doc.lines);
    const pos = view.state.doc.line(n).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  }, [goto?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="code-editor" ref={host} />;
}
