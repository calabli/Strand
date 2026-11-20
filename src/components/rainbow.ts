// Rainbow brackets in the code editor, for every file: (), [] and {} colored by nesting depth, the same classes and
// colors as the file view and diffs; in languages where every bracket has a partner, one without is marked. Brackets
// inside strings and comments (by the syntax tree) don't count. Recomputed when the text or the parse changes; very
// large files are left alone.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { CLOSE, LEVELS, OPEN, strictBrackets } from "../highlight/brackets";
import { langOf } from "../highlight";

/** Over this many characters the editor doesn't color brackets (each edit rescans the file) */
const MAX = 200_000;
/** Syntax node names whose brackets are text, not code */
const QUIET = /string|comment|regexp|char|quote|doc/i;

const marks = Array.from({ length: LEVELS }, (_, i) => Decoration.mark({ class: "tk-br" + i }));
const bad = Decoration.mark({ class: "tk-br-bad" });

function build(view: EditorView, strict: boolean): DecorationSet {
  const { state } = view;
  if (state.doc.length > MAX) return Decoration.none;
  const tree = syntaxTree(state);
  const text = state.doc.toString();
  const found: { at: number; deco: Decoration }[] = [];
  const open: { want: string; idx: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const want = OPEN[ch];
    if (!want && !CLOSE.has(ch)) continue;
    if (QUIET.test(tree.resolveInner(i, 1).name)) continue;
    if (want) {
      open.push({ want, idx: found.length });
      found.push({ at: i, deco: marks[(open.length - 1) % LEVELS] });
    } else if (open.length && open[open.length - 1].want === ch) {
      open.pop();
      found.push({ at: i, deco: marks[open.length % LEVELS] });
    } else found.push({ at: i, deco: strict ? bad : marks[0] });
  }
  // The part of the file not parsed yet may hide strings; don't call its open brackets errors
  const parsedTo = tree.length;
  if (strict) for (const o of open) if (found[o.idx].at < parsedTo) found[o.idx].deco = bad;
  const b = new RangeSetBuilder<Decoration>();
  for (const f of found) b.add(f.at, f.at + 1, f.deco);
  return b.finish();
}

/** The editor extension for this file */
export function rainbowBrackets(path: string) {
  const strict = strictBrackets(langOf(path));
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, strict);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = build(u.view, strict);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
