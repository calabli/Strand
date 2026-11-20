// Rainbow brackets in the code editor, for every file: (), [] and {} colored by nesting depth, the same classes and
// colors as the file view and diffs; in languages where every bracket has a partner, one without is marked. Brackets
// inside strings and comments (by the syntax tree) don't count. Markup tags (XML, HTML, JSX) are colored the same way:
// an element's start and end tags take the color of its depth, and in XML a tag without its partner is marked.
// Recomputed when the text or the parse changes; very large files are left alone.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { CLOSE, LEVELS, OPEN, strictBrackets } from "../highlight/brackets";
import { langOf } from "../highlight";

type Tree = ReturnType<typeof syntaxTree>;

/** Over this many characters the editor doesn't color brackets (each edit rescans the file) */
const MAX = 200_000;
/** Syntax node names whose brackets are text, not code */
const QUIET = /string|comment|regexp|char|quote|doctag|attributevalue/i;
/** Elements (each adds a level), the tags inside them, and the parts of a tag that are colored: "<", "</", the name, ">", "/>" */
const ELEMENT = new Set(["Element", "JSXElement"]);
const TAG = new Set(["OpenTag", "CloseTag", "SelfClosingTag", "MismatchedCloseTag", "JSXOpenTag", "JSXCloseTag", "JSXSelfClosingTag", "JSXFragmentTag"]);
const TAG_PART = new Set([
  "StartTag", "StartCloseTag", "EndTag", "SelfCloseEndTag", "SelfClosingEndTag", "TagName",
  "JSXStartTag", "JSXStartCloseTag", "JSXEndTag", "JSXSelfCloseEndTag", "JSXIdentifier", "JSXBuiltin", "JSXMemberExpression", "JSXNamespacedName",
]);

const marks = Array.from({ length: LEVELS }, (_, i) => Decoration.mark({ class: "tk-br" + i }));
const bad = Decoration.mark({ class: "tk-br-bad" });
/** Tags have their own classes: with rainbow brackets off they keep the tag color */
const tagMarks = Array.from({ length: LEVELS }, (_, i) => Decoration.mark({ class: "tk-tag-br" + i }));
const tagBad = Decoration.mark({ class: "tk-tag-br-bad" });

type Found = { from: number; to: number; deco: Decoration };

function brackets(text: string, tree: Tree, strict: boolean): Found[] {
  const found: Found[] = [];
  const open: { want: string; idx: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const want = OPEN[ch];
    if (!want && !CLOSE.has(ch)) continue;
    if (QUIET.test(tree.resolveInner(i, 1).name)) continue;
    if (want) {
      open.push({ want, idx: found.length });
      found.push({ from: i, to: i + 1, deco: marks[(open.length - 1) % LEVELS] });
    } else if (open.length && open[open.length - 1].want === ch) {
      open.pop();
      found.push({ from: i, to: i + 1, deco: marks[open.length % LEVELS] });
    } else found.push({ from: i, to: i + 1, deco: strict ? bad : marks[0] });
  }
  // The part of the file not parsed yet may hide strings; don't call its open brackets errors
  if (strict) for (const o of open) if (found[o.idx].from < tree.length) found[o.idx].deco = bad;
  return found;
}

/** Tags by element depth, from the syntax tree (the parser already knows HTML's void elements and implied end tags) */
function tags(tree: Tree, docLength: number, strictTags: boolean): Found[] {
  const found: Found[] = [];
  /** For each open element, the parts of its start tag (marked when XML says it's never closed) */
  const elements: Found[][] = [];
  tree.iterate({
    enter(n) {
      if (ELEMENT.has(n.name)) {
        elements.push([]);
        return;
      }
      if (!TAG.has(n.name)) return;
      const depth = Math.max(0, elements.length - 1);
      const deco = strictTags && n.name === "MismatchedCloseTag" ? tagBad : tagMarks[depth % LEVELS];
      const opening = n.name === "OpenTag" || n.name === "JSXOpenTag";
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        if (!TAG_PART.has(c.name) || c.to <= c.from) continue;
        const f = { from: c.from, to: c.to, deco };
        found.push(f);
        if (opening) elements[elements.length - 1]?.push(f);
      }
      return false;
    },
    leave(n) {
      if (!ELEMENT.has(n.name)) return;
      const start = elements.pop() ?? [];
      // XML: a start tag with no end tag (the parser ends such an element with MissingCloseTag, or an error node at the
      // end of the file); not in the part of the file that isn't parsed yet
      const parsed = n.to < tree.length || tree.length >= docLength;
      if (strictTags && parsed && n.node.firstChild?.name === "OpenTag" && !n.node.getChild("CloseTag")) for (const f of start) f.deco = tagBad;
    },
  });
  return found;
}

function build(view: EditorView, strict: boolean, strictTags: boolean): DecorationSet {
  const { state } = view;
  if (state.doc.length > MAX) return Decoration.none;
  const tree = syntaxTree(state);
  const found = [...brackets(state.doc.toString(), tree, strict), ...tags(tree, state.doc.length, strictTags)].sort((a, b) => a.from - b.from);
  const b = new RangeSetBuilder<Decoration>();
  for (const f of found) b.add(f.from, f.to, f.deco);
  return b.finish();
}

/** The editor extension for this file */
export function rainbowBrackets(path: string) {
  const lang = langOf(path);
  const strict = strictBrackets(lang);
  const strictTags = lang === "xml";
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, strict, strictTags);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = build(u.view, strict, strictTags);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
