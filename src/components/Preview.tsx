// Previews in the file tab (instead of the text): images, rendered Markdown, CSV tables, a JSON tree, PDF, audio and
// video, a binary file's textconv text, and preview plugins. Plugins run in a sandboxed frame (no access to Strand,
// the repository or the network) and are sent the file's bytes once their page says it's ready.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errOf, inTauri } from "../api/commands";
import type { PreviewPlugin, Textconv } from "../api/types";
import { extOf, isDark, matchesExtensions, pluginUrl, type Choice, type PreviewInput, type PreviewProvider } from "../preview";
import { markdownProvider } from "./MarkdownPreview";
import { useSettings } from "../settings";
import { t, tr, lang } from "../i18n";

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", opus: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg",
};

type Bytes = { buf: ArrayBuffer | null; error: string | null };

/** The file's raw bytes at a revision (worktree when rev is null) */
function useBytes(path: string, rev: string | null, reloadKey?: number): Bytes {
  const [st, setSt] = useState<Bytes & { key: string }>({ key: "", buf: null, error: null });
  const key = JSON.stringify([path, rev, reloadKey]);
  useEffect(() => {
    let live = true;
    api.fileBytes(path, rev).then(
      (buf) => live && setSt({ key, buf, error: null }),
      (e) => live && setSt({ key, buf: null, error: errOf(e).message }),
    );
    return () => {
      live = false;
    };
  }, [key, path, rev]);
  return st.key === key ? st : { buf: null, error: null };
}

/** A blob URL for the bytes, revoked when they change */
function useBlobUrl(buf: ArrayBuffer | null, type: string): string | null {
  const [file, setFile] = useState<{ buf: ArrayBuffer; type: string; url: string } | null>(null);
  useEffect(() => {
    if (!buf) return;
    const url = URL.createObjectURL(new Blob([buf], { type }));
    setFile({ buf, type, url });
    return () => URL.revokeObjectURL(url);
  }, [buf, type]);
  return file?.buf === buf && file.type === type ? file.url : null;
}

const format = (id: string, label: () => string, extensions: string[], View: PreviewProvider["View"]): PreviewProvider => ({ id, label, matches: matchesExtensions(extensions), View });

/** The host uses the same input for every built-in viewer. New local formats register here. */
export const previewProviders: readonly PreviewProvider[] = [
  markdownProvider,
  format("image", () => t("图片"), ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"], (input) => <MediaView {...input} kind="image" />),
  format("csv", () => t("表格"), ["csv", "tsv"], ({ path, file }) => <CsvView text={file?.text ?? ""} tsv={extOf(path) === "tsv"} />),
  format("json", () => t("JSON 树"), ["json", "geojson", "webmanifest"], ({ file }) => <JsonView text={file?.text ?? ""} />),
  format("pdf", () => "PDF", ["pdf"], (input) => <MediaView {...input} kind="pdf" />),
  format("audio", () => t("音频"), ["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"], (input) => <MediaView {...input} kind="audio" />),
  format("video", () => t("视频"), ["mp4", "webm", "mov", "m4v", "ogv"], (input) => <MediaView {...input} kind="video" />),
  { id: "textconv", label: () => t("转成文本（textconv）"), matches: ({ file }) => !!file?.binary && !!file.textconv, View: TextconvView },
];

export function PreviewPane({ choice, ...input }: PreviewInput & { choice: Choice }) {
  return (
    <div className="pv">
      {choice.provider ? <choice.provider.View {...input} /> : inTauri ? (
        <PluginFrame key={JSON.stringify([choice.plugin.id, choice.plugin.version, choice.plugin.entry, input.path, input.rev])} plugin={choice.plugin} {...input} />
      ) : <p className="pad dim">{t("预览插件需要在 Strand 桌面应用中运行")}</p>}
    </div>
  );
}

// ---------- Images, PDF, audio, video ----------

function MediaView({ kind, path, rev, reloadKey }: PreviewInput & { kind: "image" | "pdf" | "audio" | "video" }) {
  const b = useBytes(path, rev, reloadKey);
  const url = useBlobUrl(b.buf, MIME[extOf(path)] ?? "application/octet-stream");
  const [fit, setFit] = useState(true);
  // Keyed by the URL so a newer image never shows an older one's size
  const [loaded, setDims] = useState<{ url: string; w: number; h: number } | null>(null);
  const dims = loaded?.url === url ? loaded : null;
  if (b.error) return <p className="pad err">{tr(b.error)}</p>;
  if (!url || !b.buf) return <p className="pad dim">{t("正在读取…")}</p>;
  const size = fmtSize(b.buf.byteLength);
  if (kind === "pdf") return <iframe className="pv-pdf" src={url} title={path} />;
  if (kind === "audio")
    return (
      <div className="pv-center">
        <audio controls src={url} aria-label={path} />
        <p className="dim small">{size}</p>
      </div>
    );
  if (kind === "video")
    return (
      <div className="pv-center">
        <video controls src={url} className="pv-video" aria-label={path} />
        <p className="dim small">{size}</p>
      </div>
    );
  return (
    <div className="pv-img-wrap">
      <div className="pv-tools small">
        <span className="dim">{dims ? `${dims.w} × ${dims.h} · ${size}` : size}</span>
        <span className="grow" />
        <span className="seg" role="radiogroup" aria-label={t("图片大小")}>
          <button type="button" role="radio" aria-checked={fit} className={fit ? "on" : ""} onClick={() => setFit(true)}>
            {t("适应窗口")}
          </button>
          <button type="button" role="radio" aria-checked={!fit} className={!fit ? "on" : ""} onClick={() => setFit(false)}>
            {t("原始大小")}
          </button>
        </span>
      </div>
      <div className={"pv-img" + (fit ? " fit" : "")}>
        <img
          src={url}
          alt={path}
          className="checker"
          onLoad={(e) => setDims({ url, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setDims(null)}
        />
      </div>
    </div>
  );
}

// ---------- CSV ----------

const MAX_ROWS = 5000;

/** CSV with quoted fields ("" is a quote inside one); the delimiter is guessed from the first line unless TSV */
export function parseCsv(text: string, tsv: boolean): string[][] {
  const first = text.slice(0, text.indexOf("\n") >>> 0);
  const delim = tsv ? "\t" : [",", ";", "\t", "|"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length <= MAX_ROWS; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function CsvView({ text, tsv }: { text: string; tsv: boolean }) {
  const rows = useMemo(() => parseCsv(text, tsv), [text, tsv]);
  const [head, ...body] = rows;
  if (!head) return <p className="pad dim">{t("空文件")}</p>;
  const cols = Math.max(...rows.slice(0, 200).map((r) => r.length));
  return (
    <div className="pv-table-wrap">
      <table className="pv-table">
        <thead>
          <tr>
            <th className="rn">#</th>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>{head[i] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX_ROWS).map((r, i) => (
            <tr key={i}>
              <td className="rn">{i + 1}</td>
              {Array.from({ length: cols }, (_, j) => (
                <td key={j} className={/^-?[\d.,]+%?$/.test(r[j] ?? "") ? "num" : undefined}>
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && <p className="pad dim small">{t("只显示了前 {0} 行", MAX_ROWS)}</p>}
    </div>
  );
}

// ---------- JSON ----------

function JsonView({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch (e) {
      return { ok: false as const, error: String((e as Error).message) };
    }
  }, [text]);
  if (!parsed.ok) return <p className="pad err">{t("不是有效的 JSON：{0}", parsed.error)}</p>;
  return (
    <div className="pv-json mono">
      <JsonNode k={null} v={parsed.value} depth={0} />
    </div>
  );
}

const MAX_KIDS = 500;

function JsonNode({ k, v, depth }: { k: string | null; v: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const [all, setAll] = useState(false);
  const key = k !== null && <span className="j-key">{k}: </span>;
  if (v === null || typeof v !== "object") {
    const cls = v === null ? "j-null" : typeof v === "string" ? "j-str" : typeof v === "number" ? "j-num" : "j-bool";
    return (
      <div className="j-row">
        {key}
        <span className={cls}>{typeof v === "string" ? JSON.stringify(v) : String(v)}</span>
      </div>
    );
  }
  const arr = Array.isArray(v);
  const entries: [string, unknown][] = arr ? v.map((x, i) => [String(i), x]) : Object.entries(v as Record<string, unknown>);
  const shown = all ? entries : entries.slice(0, MAX_KIDS);
  return (
    <div className="j-row">
      <button type="button" className="j-tog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"}
      </button>
      {key}
      <span className="dim">{arr ? `[${entries.length}]` : `{${entries.length}}`}</span>
      {open && (
        <div className="j-kids">
          {shown.map(([ck, cv]) => (
            <JsonNode key={ck} k={arr ? null : ck} v={cv} depth={depth + 1} />
          ))}
          {shown.length < entries.length && (
            <button type="button" className="btn sm" onClick={() => setAll(true)}>
              {t("还有 {0} 项，全部显示", entries.length - shown.length)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- textconv ----------

function TextconvView({ path, rev, reloadKey }: PreviewInput) {
  const [st, setSt] = useState<{ data: Textconv | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    setSt({ data: null, error: null });
    api.fileTextconv(path, rev).then(
      (data) => live && setSt({ data, error: null }),
      (e) => live && setSt({ data: null, error: errOf(e).message }),
    );
    return () => {
      live = false;
    };
  }, [path, rev, reloadKey]);
  if (st.error) return <p className="pad err">{tr(st.error)}</p>;
  if (!st.data) return <p className="pad dim">{t("正在转换…")}</p>;
  return (
    <div className="pv-tc">
      <div className="pv-tools small dim">
        {t("用仓库设置的 textconv 命令转成的文本：")}
        <code className="mono">{st.data.command}</code>
      </div>
      <pre className="pv-tc-text mono">{st.data.text || t("（没有输出）")}</pre>
      {st.data.truncated && <p className="pad dim small">{t("文件太大，只显示了前面一部分")}</p>}
    </div>
  );
}

// ---------- Plugins ----------

function PluginFrame({ plugin, path, rev, reloadKey }: PreviewInput & { plugin: PreviewPlugin }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const b = useBytes(path, rev, reloadKey);
  const [ready, setReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const theme = useSettings().theme;

  useLayoutEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data as { type?: string } | null;
      if (m?.type === "strand:ready") setReady(true);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => setTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, [ready]);

  // Send the file once the page is ready (a copy: the bytes stay usable here)
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!ready || !b.buf || !w) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const bytes = b.buf.slice(0);
    w.postMessage({ type: "strand:file", apiVersion: 1, name, path, ext: extOf(path), rev, size: bytes.byteLength, bytes, theme: isDark() ? "dark" : "light", lang }, "*", [bytes]);
  }, [ready, b.buf, path, rev, lang]);

  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: "strand:theme", theme: isDark() ? "dark" : "light" }, "*");
  }, [theme, ready]);

  return (
    <div className="pv-plugin">
      {b.error && <p className="pad err">{tr(b.error)}</p>}
      {!ready && <p className={timedOut ? "pad err" : "pad dim"}>{timedOut ? t("预览插件没有响应") : t("正在启动预览插件…")}</p>}
      <iframe
        ref={frame}
        src={pluginUrl(plugin)}
        title={t("插件 {0}", plugin.name)}
        // Scripts only: no same-origin (so no access to Strand), no forms, popups or top navigation
        sandbox="allow-scripts"
        className="pv-frame"
      />
    </div>
  );
}
