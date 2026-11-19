import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { t } from "../i18n";
import { embeddedImage, MarkdownImageCache, resolveMarkdownPath, webImage } from "./markdownAssets";

const HEADING = /^(?:ATX|Setext)Heading([1-6])$/;
const replacement = Decoration.replace({});
type MarkdownNode = ReturnType<typeof syntaxTree>["topNode"];
const inlineMarks = new Map([
  ["StrongEmphasis", "md-inline-strong"], ["Emphasis", "md-inline-emphasis"],
  ["InlineCode", "md-inline-code"], ["Strikethrough", "md-inline-strike"],
  ["Link", "md-inline-link"], ["Autolink", "md-inline-link"], ["URL", "md-inline-link"],
]);
const hiddenMarks = new Set(["CodeMark", "EmphasisMark", "LinkMark", "StrikethroughMark"]);

class Bullet extends WidgetType {
  toDOM() {
    const node = document.createElement("span");
    node.className = "md-inline-bullet";
    node.setAttribute("aria-hidden", "true");
    node.textContent = "•";
    return node;
  }
}

class Task extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean) { super(); }
  eq(other: Task) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view: EditorView) {
    const node = document.createElement("input");
    node.type = "checkbox";
    node.checked = this.checked;
    node.tabIndex = -1;
    node.className = "md-inline-task";
    node.setAttribute("aria-label", this.checked ? t("标记为未完成") : t("标记为完成"));
    node.addEventListener("mousedown", (e) => e.preventDefault());
    node.addEventListener("change", () => {
      if (view.state.readOnly) { node.checked = this.checked; return; }
      if (!/^\[[ xX]\]$/.test(view.state.sliceDoc(this.from, this.from + 3))) return;
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: node.checked ? "x" : " " }, userEvent: "input.task" });
    });
    return node;
  }
}

class TableRow extends WidgetType {
  readonly text: string[];
  constructor(readonly cells: (MarkdownNode | null)[], readonly header: boolean, readonly doc: Text) {
    super();
    this.text = cells.map((cell) => cell ? doc.sliceString(cell.from, cell.to).trim() : "");
  }
  eq(other: TableRow) {
    return this.header === other.header && this.text.length === other.text.length && this.text.every((cell, i) => cell === other.text[i]);
  }
  toDOM() {
    const row = document.createElement("span");
    row.className = "md-inline-table-row" + (this.header ? " md-inline-table-head" : "");
    row.style.setProperty("--md-cols", String(this.cells.length));
    for (const node of this.cells) {
      const cell = document.createElement("span");
      if (node) {
        const source = this.doc.sliceString(node.from, node.to);
        const from = node.from + source.length - source.trimStart().length;
        appendInline(cell, this.doc, node, from, node.from + source.trimEnd().length);
      }
      if (!cell.hasChildNodes()) cell.textContent = "\u00a0";
      row.append(cell);
    }
    return row;
  }
  ignoreEvent() { return false; }
}

/** Format table cells from parsed ranges, without turning any document string into DOM markup. */
function appendInline(parent: HTMLElement, doc: Text, node: MarkdownNode, from: number, to: number) {
  if (from >= to) return;
  const raw = (a: number, b: number) => doc.sliceString(a, b).replace(/\\\|/g, "|");
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from < from || child.to > to) continue;
    if (child.from > pos) parent.append(raw(pos, child.from));
    const style = inlineMarks.get(child.name);
    if (style) {
      const span = document.createElement("span");
      span.className = style;
      const [open, close] = child.name === "Link" ? child.getChildren("LinkMark") : [];
      appendInline(span, doc, child, open?.to ?? child.from, close?.from ?? child.to);
      parent.append(span);
    } else if (child.name === "Escape") parent.append(raw(child.from + 1, child.to));
    else if (!hiddenMarks.has(child.name)) parent.append(raw(child.from, child.to));
    pos = child.to;
  }
  if (pos < to) parent.append(raw(pos, to));
}

class InlineImage extends WidgetType {
  constructor(readonly path: string, readonly src: string, readonly alt: string, readonly cache: MarkdownImageCache) { super(); }
  eq(other: InlineImage) { return this.path === other.path && this.src === other.src && this.alt === other.alt; }
  toDOM(view: EditorView) {
    const figure = document.createElement("span");
    figure.className = "md-inline-image";
    const caption = this.alt || t("图片");
    figure.textContent = webImage.test(this.src) ? t("[网上的图片：{0}]", caption) : caption;
    const target = resolveMarkdownPath(this.path, this.src);
    if (!target && !embeddedImage.test(this.src)) return figure;
    const url = target ? this.cache.load(target, null) : Promise.resolve(this.src);
    void url.then((src) => {
      if (!figure.isConnected) return;
      const image = document.createElement("img");
      image.alt = this.alt;
      image.addEventListener("load", () => {
        if (!figure.isConnected) return;
        figure.replaceChildren(image);
        view.requestMeasure();
      }, { once: true });
      image.src = src;
    }, () => {});
    return figure;
  }
  ignoreEvent() { return false; }
}

const bullet = Decoration.replace({ widget: new Bullet() });

function decorate(view: EditorView, path: string, assets: MarkdownImageCache): DecorationSet {
  const { state } = view;
  const showSource = view.hasFocus ? state.selection.ranges.map((r) => ({ from: state.doc.lineAt(r.from).from, to: state.doc.lineAt(r.to).to })) : [];
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const lineStyles = new Map<number, Set<string>>();
  const active = (from: number, to: number) => showSource.some((range) => from <= range.to && to >= range.from);
  const lineStyle = (pos: number, style: string) => {
    const from = state.doc.lineAt(pos).from;
    if (!lineStyles.has(from)) lineStyles.set(from, new Set());
    lineStyles.get(from)!.add(style);
  };

  for (const visible of view.visibleRanges) syntaxTree(state).iterate({
    from: visible.from, to: visible.to,
    enter({ name, from, to, node }) {
      const heading = HEADING.exec(name);
      if (heading) lineStyle(from, `md-inline-heading md-inline-h${heading[1]}`);
      if (name === "CodeBlock" || name === "FencedCode") {
        for (let n = state.doc.lineAt(Math.max(from, visible.from)).number; n <= state.doc.lineAt(Math.min(to, visible.to)).number; n++) {
          lineStyle(state.doc.line(n).from, "md-inline-code-block");
        }
        return false;
      }
      if (name === "QuoteMark") lineStyle(from, "md-inline-quote");
      if (active(from, to)) return;

      if (name === "Image") {
        const [open, close] = node.getChildren("LinkMark");
        const url = node.getChild("URL");
        if (open && close && url && state.doc.lineAt(from).number === state.doc.lineAt(to).number) {
          const src = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "");
          const alt = state.sliceDoc(open.to, close.from);
          ranges.push(Decoration.replace({ widget: new InlineImage(path, src, alt, assets) }).range(from, to));
        }
        return false;
      }

      if (name === "TableHeader" || name === "TableRow") {
        const header = name === "TableHeader";
        const cells = node.getChildren("TableCell");
        const columns = header ? cells.length : node.parent?.getChild("TableHeader")?.getChildren("TableCell").length ?? cells.length;
        if (columns) {
          const values = Array.from({ length: columns }, (_, i) => cells[i] ?? null);
          ranges.push(Decoration.replace({ widget: new TableRow(values, header, state.doc) }).range(from, to));
        }
        return false;
      }
      if (name === "TableDelimiter" && node.parent?.name === "Table") {
        lineStyle(from, "md-inline-table-delimiter");
        ranges.push(replacement.range(from, to));
      }

      if (name === "Link" && state.doc.lineAt(from).number === state.doc.lineAt(to).number) {
        const [open, close] = node.getChildren("LinkMark");
        if (open && close && open.to < close.from) {
          ranges.push(replacement.range(from, open.to));
          ranges.push(replacement.range(close.from, to));
          ranges.push(Decoration.mark({ class: "md-inline-link" }).range(open.to, close.from));
          return false;
        }
      }
      const style = inlineMarks.get(name);
      if (style && from < to) ranges.push(Decoration.mark({ class: style }).range(from, to));
      if (name === "HeaderMark") {
        const end = to + (state.sliceDoc(to, state.doc.lineAt(to).to).match(/^[ \t]*/)?.[0].length ?? 0);
        ranges.push(replacement.range(from, end));
      } else if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "QuoteMark" ||
        (name === "CodeMark" && node.parent?.name === "InlineCode") || (name === "LinkMark" && node.parent?.name === "Autolink")) {
        ranges.push(replacement.range(from, to));
      } else if (name === "ListMark" && node.parent?.parent?.name === "BulletList") {
        ranges.push((node.parent.getChild("Task") ? replacement : bullet).range(from, to));
      } else if (name === "TaskMarker") {
        ranges.push(Decoration.replace({ widget: new Task(from, /x/i.test(state.sliceDoc(from, to))) }).range(from, to));
      }
    },
  });
  for (const [from, styles] of lineStyles) ranges.push(Decoration.line({ class: [...styles].join(" ") }).range(from));
  return Decoration.set(ranges, true);
}

/** Keep Markdown as a single source document and render syntax around the lines being edited. */
export function markdownInline(path: string) {
  return [
    EditorView.editorAttributes.of({ class: "cm-md-rendered" }),
    ViewPlugin.fromClass(class {
      readonly assets = new MarkdownImageCache();
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = decorate(view, path, this.assets); }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
          this.decorations = decorate(update.view, path, this.assets);
        }
      }
      destroy() { this.assets.clear(); }
    }, { decorations: (plugin) => plugin.decorations }),
  ];
}

export function markdownHeadings(view: EditorView) {
  const { state } = view;
  const headings: { level: number; label: string; from: number }[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 40) ?? syntaxTree(state);
  tree.iterate({ enter({ name, from, to, node }) {
    if (name === "FencedCode" || name === "CodeBlock") return false;
    const depth = HEADING.exec(name);
    if (!depth) return;
    const marks = node.getChildren("HeaderMark");
    const start = name.startsWith("ATX") ? marks[0]?.to ?? from : from;
    const end = name.startsWith("Setext") || marks.length > 1 ? marks[marks.length - 1]?.from ?? to : to;
    const label = state.sliceDoc(start, end).trim().replace(/\s+/g, " ");
    headings.push({ level: Number(depth[1]), label: label || t("无标题"), from });
    return false;
  } });
  return headings;
}
