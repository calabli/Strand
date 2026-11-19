import { StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { api, errOf } from "../api/commands";
import { t, tr } from "../i18n";
import { notify } from "../notify";

type Position = { from: number; to: number };
const begin = StateEffect.define<{ id: number; position: Position }>();
const end = StateEffect.define<number>();
const imagePastes = StateField.define<ReadonlyMap<number, Position>>({
  create: () => new Map(),
  update(value, tx) {
    if (!tx.docChanged && !tx.effects.some((e) => e.is(begin) || e.is(end))) return value;
    const next = new Map<number, Position>();
    for (const [id, range] of value) {
      if (range.from === range.to) {
        // Continue past earlier image pastes at the same spot, but keep later typing after the image.
        const pos = tx.changes.mapPos(range.from, tx.isUserEvent("input.paste.image") ? 1 : -1);
        next.set(id, { from: pos, to: pos });
      } else if (tx.changes.touchesRange(range.from, range.to)) {
        const pos = tx.changes.mapPos(range.to, 1);
        next.set(id, { from: pos, to: pos });
      } else {
        next.set(id, { from: tx.changes.mapPos(range.from), to: tx.changes.mapPos(range.to) });
      }
    }
    for (const effect of tx.effects) {
      if (effect.is(begin)) next.set(effect.value.id, effect.value.position);
      if (effect.is(end)) next.delete(effect.value);
    }
    return next;
  },
});

function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const images = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
  if (images.length) return images;
  return Array.from(data.items).flatMap((item) => {
    const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

const linkPath = (path: string) => path.split("/").map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export function markdownImagePaste(document: string, activity: (change: number) => void) {
  let sequence = 0;
  let queue = Promise.resolve();

  const save = async (view: EditorView, id: number, files: File[], repo: Promise<string>) => {
    const results: string[] = [];
    let failure: unknown;
    try {
      const root = await repo;
      for (const file of files) {
        if (!view.dom.isConnected) return;
        try {
          if (file.size > MAX_IMAGE_BYTES) throw new Error(t("图片超过 30 MB"));
          const bytes = await file.arrayBuffer();
          if (!view.dom.isConnected) return;
          const path = await api.pasteMarkdownImage(root, document, bytes, file.type);
          results.push(`![${t("图片")}](${linkPath(path)})`);
        } catch (error) {
          failure ??= error;
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      if (view.dom.isConnected) {
        const range = view.state.field(imagePastes).get(id);
        const insert = results.join("\n\n");
        if (range && insert) {
          const current = view.state.selection;
          const atPaste = current.ranges.length === 1 && current.main.from === range.from && current.main.to === range.to;
          view.dispatch({
            changes: { ...range, insert },
            effects: end.of(id),
            selection: atPaste ? { anchor: range.from + insert.length } : undefined,
            scrollIntoView: atPaste && view.hasFocus,
            userEvent: "input.paste.image",
          });
        } else view.dispatch({ effects: end.of(id) });
        activity(-1);
        if (failure) notify({ kind: "error", title: t("无法粘贴图片"), body: tr(failure instanceof Error ? failure.message : errOf(failure).message) });
      }
    }
  };

  return [imagePastes, EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const files = clipboardImages(event.clipboardData);
      if (!files.length) return false;
      event.preventDefault();
      const id = ++sequence;
      const { from, to } = view.state.selection.main;
      view.dispatch({ effects: begin.of({ id, position: { from, to } }) });
      activity(1);
      const repo = api.repoState().then((state) => state.path);
      // The lookup can fail while an earlier paste is still writing. The queued handler reports it.
      void repo.catch(() => {});
      queue = queue.then(() => save(view, id, files, repo));
      return true;
    },
  })];
}
