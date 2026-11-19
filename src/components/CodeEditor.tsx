// The code editor (CodeMirror 6) used to edit worktree files: syntax colors per file type, line numbers, undo and redo,
// find and replace (⌘F, ⌥⌘F), go to line (⌘L), bracket matching and auto-closing, folding, Tab indents.
// Loaded on demand (React.lazy) so the editor code only arrives when someone edits a file.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
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
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { classHighlighter } from "@lezer/highlight";
import { lang, t } from "../i18n";
import type { EditorFormatAction } from "../preview";
import { comboFromEvent, matches, showCombo } from "../keymap";
import type { MarkdownMode } from "../settings";
import { navigateAt } from "../nav";
import { Menu, type MenuState } from "./Menu";
import { markdownHeadings, markdownInline } from "./markdownEditor";
import { markdownImagePaste } from "./markdownImagePaste";
import { ROLLBACK_ICON, rollbackLabel, type RollbackControls, type RollbackLine } from "./lineRollback";
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
  actions?: readonly EditorFormatAction[];
  wrap?: boolean;
  markdownMode?: MarkdownMode;
  onImageImporting?: (change: number) => void;
  rollback?: RollbackControls;
  onRollback?: (row: RollbackLine) => Promise<string | null>;
  diskEdit?: { from: string; to: string } | null;
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

function applyFormat(view: EditorView, action: EditorFormatAction) {
  if (view.state.readOnly) return;
  const { state } = view;
  // Block actions use one contiguous set of lines, so cursors on the same line never create overlapping edits.
  const scope = action.wholeLines ? state.update({ selection: EditorSelection.single(state.selection.main.anchor, state.selection.main.head) }).state : state;
  const change = scope.changeByRange((range) => {
    let from = action.wholeLines ? state.doc.lineAt(range.from).from : range.from;
    let to = action.wholeLines ? state.doc.lineAt(Math.max(range.from, range.to - 1)).to : range.to;
    const selected = state.sliceDoc(from, to);
    let result: ReturnType<EditorFormatAction["apply"]>;
    const [left, right] = action.delimiters ?? ["", ""];
    if (selected && left && right && scope.selection.ranges.length === 1 && from >= left.length && to + right.length <= state.doc.length &&
      state.sliceDoc(from - left.length, from) === left && state.sliceDoc(to, to + right.length) === right) {
      from -= left.length;
      to += right.length;
      result = { text: selected };
    } else result = action.apply(selected, range.empty);
    return {
      changes: { from, to, insert: result.text },
      range: EditorSelection.range(from + (result.from ?? 0), from + (result.to ?? result.text.length)),
    };
  });
  view.dispatch({ ...change, userEvent: "input.format", scrollIntoView: true });
  view.focus();
}

/** Update just the changed range, keeping the current selection and local editing history. */
function adoptDiskEdit(view: EditorView, from: string, to: string) {
  if (from === to || view.state.doc.toString() !== from) return;
  let start = 0;
  let end = 0;
  while (start < Math.min(from.length, to.length) && from[start] === to[start]) start++;
  while (end < Math.min(from.length, to.length) - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  view.dispatch({ changes: { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }, annotations: Transaction.addToHistory.of(false) });
}

class GitRollbackMarker extends GutterMarker {
  constructor(readonly row: RollbackLine, readonly run: () => void, readonly busy: boolean) { super(); }
  toDOM() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "line-rollback-button";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS(svg.namespaceURI, "path");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", ROLLBACK_ICON);
    svg.append(path);
    btn.append(svg);
    btn.title = rollbackLabel(this.row);
    btn.setAttribute("aria-label", btn.title);
    btn.disabled = this.busy;
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", (event) => { event.stopPropagation(); this.run(); });
    return btn;
  }
}

export default function CodeEditor({ path, value, line, indent, onChange, onSave, onBlur, onEscape, label, goto, actions, wrap, markdownMode, onImageImporting, rollback, onRollback, diskEdit }: CodeEditorProps) {
  const viewRef = useRef<EditorView | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [presentation] = useState(() => new Compartment());
  const [worktreeGutter] = useState(() => new Compartment());
  const [worktreeWrite] = useState(() => new Compartment());
  const inline = useMemo(() => markdownInline(path), [path]);
  const [outline, setOutline] = useState<ReturnType<typeof markdownHeadings> | null>(null);
  const [outlinePos, setOutlinePos] = useState(0);
  const [insert, setInsert] = useState<MenuState | null>(null);
  const outlineOpen = useRef(false);
  outlineOpen.current = outline !== null;
  // Callbacks change on every render; the editor reads the latest through refs
  const cb = useRef({ onChange, onSave, onBlur, onEscape, onImageImporting, onRollback });
  cb.current = { onChange, onSave, onBlur, onEscape, onImageImporting, onRollback };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const md = markdownMode != null;
    const language = new Compartment();
    let outlineTimer: number | undefined;
    const state = EditorState.create({
      doc: value,
      extensions: [
        ...(wrap ? [EditorView.lineWrapping] : []),
        worktreeGutter.of([]),
        worktreeWrite.of([]),
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
        language.of(md ? markdown({ base: markdownLanguage, codeLanguages: languages }) : []),
        ...(md ? [Prec.highest(markdownImagePaste(path, (change) => cb.current.onImageImporting?.(change)))] : []),
        presentation.of(markdownMode === "inline" ? inline : []),
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
              if (e.isComposing) return false;
              if (matches(e, "save")) {
                e.preventDefault();
                cb.current.onSave();
                return true;
              }
              const shortcut = md && comboFromEvent(e);
              const action = shortcut ? actions?.find((item) => item.shortcut === shortcut) : undefined;
              if (action) {
                e.preventDefault();
                applyFormat(view, action);
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
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          if (md && outlineOpen.current) {
            if (u.selectionSet || u.docChanged) setOutlinePos(u.state.selection.main.head);
            if (u.docChanged) {
              window.clearTimeout(outlineTimer);
              outlineTimer = window.setTimeout(() => {
                if (outlineOpen.current) setOutline(markdownHeadings(u.view));
              }, 160);
            }
          }
        }),
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
    const desc = md ? null : LanguageDescription.matchFilename(languages, name);
    desc?.load().then(
      (support) => live && view.dispatch({ effects: language.reconfigure(support) }),
      () => {},
    );
    return () => {
      live = false;
      window.clearTimeout(outlineTimer);
      viewRef.current = null;
      view.destroy();
    };
    // Created once per file; the content is not driven from outside afterwards
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: presentation.reconfigure(markdownMode === "inline" ? inline : []) });
  }, [markdownMode, inline, presentation]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const run = async (row: RollbackLine) => {
      if (view.state.readOnly || !cb.current.onRollback) return;
      const before = view.state.doc.toString();
      view.dispatch({ effects: worktreeWrite.reconfigure(EditorState.readOnly.of(true)) });
      try {
        const after = await cb.current.onRollback(row);
        if (after !== null && viewRef.current === view) adoptDiskEdit(view, before, after);
      } finally {
        if (viewRef.current === view) view.dispatch({ effects: worktreeWrite.reconfigure([]) });
      }
    };
    view.dispatch({ effects: worktreeGutter.reconfigure(rollback ? [
      EditorView.editorAttributes.of({ class: "cm-has-line-rollback" }),
      gutter({ class: "cm-line-rollback", lineMarker: (_, block) => {
        const line = view.state.doc.lineAt(block.from);
        const changed = rollback.current.get(line.number);
        const row = changed?.new_text === line.text ? changed : rollback.deleted.get(line.number)?.[0] ?? (line.number === view.state.doc.lines ? rollback.deleted.get(line.number + 1)?.[0] : undefined);
        return row ? new GitRollbackMarker(row, () => void run(row), rollback.busy) : null;
      } }),
    ] : []) });
    // CodeMirror's stock gutters are visual only. Expose our button gutter while keeping line numbers decorative.
    const gutters = view.scrollDOM.querySelector(".cm-gutters");
    if (gutters && rollback) {
      gutters.removeAttribute("aria-hidden");
      for (const child of Array.from(gutters.children)) {
        if (!child.classList.contains("cm-line-rollback")) child.setAttribute("aria-hidden", "true");
      }
    } else gutters?.setAttribute("aria-hidden", "true");
  }, [path, rollback, worktreeGutter, worktreeWrite]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && diskEdit) adoptDiskEdit(view, diskEdit.from, diskEdit.to);
  }, [diskEdit]);

  // A jump to a line of this file while editing it
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !goto) return;
    const n = Math.min(Math.max(1, goto.line), view.state.doc.lines);
    const pos = view.state.doc.line(n).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  }, [goto?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const format = (action: EditorFormatAction) => {
    const view = viewRef.current;
    if (view) applyFormat(view, action);
  };

  const openOutline = () => {
    const view = viewRef.current;
    if (!view) return;
    setOutline(outline ? null : markdownHeadings(view));
    setOutlinePos(view.state.selection.main.head);
  };
  const menuActions = actions?.filter((action) => action.insertMenu) ?? [];
  let activeHeading: number | undefined;
  for (const heading of outline ?? []) if (heading.from <= outlinePos) activeHeading = heading.from;

  return (
    <div className="code-editor-wrap">
      {!!actions?.length && <div className="md-format" role="group" aria-label={t("Markdown 格式")}>
        {actions.filter((action) => !action.insertMenu).map((action) => <button key={action.id} type="button" className={`ib sm md-format-${action.id}`} title={action.shortcut ? `${action.label()} (${showCombo(action.shortcut)})` : action.label()} aria-label={action.label()} onMouseDown={(e) => e.preventDefault()} onClick={() => format(action)}>{action.icon}</button>)}
        {!!menuActions.length && <button type="button" className="btn sm md-insert" aria-haspopup="menu" aria-expanded={insert !== null} onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setInsert({ x: rect.left, y: rect.bottom + 4, items: menuActions.map((action) => ({ label: action.label(), run: () => format(action) })) });
        }}>{t("插入")}</button>}
        {markdownMode && <button type="button" className="btn sm md-outline-toggle" aria-pressed={outline !== null} onClick={openOutline}>{t("文档大纲")}</button>}
      </div>}
      <div className="code-editor-main">
        {outline && <nav className="md-outline" aria-label={t("文档大纲")}>
          {!outline.length && <span className="dim small">{t("没有标题")}</span>}
          {outline.map((heading) => <button key={heading.from} type="button" aria-current={activeHeading === heading.from ? "location" : undefined} title={heading.label} style={{ paddingInlineStart: `${Math.min(4, heading.level - 1) * 10 + 8}px` }} onClick={() => {
            const view = viewRef.current;
            if (!view) return;
            const pos = Math.min(heading.from, view.state.doc.length);
            view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
            view.focus();
          }}>{heading.label}</button>)}
        </nav>}
        <div className="code-editor" ref={host} />
      </div>
      {insert && createPortal(<Menu menu={insert} onClose={() => setInsert(null)} />, document.body)}
    </div>
  );
}
