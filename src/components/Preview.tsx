// Previews in the file tab (instead of the text): images, rendered Markdown, CSV tables, a JSON tree, PDF, audio and
// video, a binary file's textconv text, and preview plugins. Plugins run in a sandboxed frame (no access to Strand,
// the repository or the network) and are sent the file's bytes once their page says it's ready.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errOf, openUrl } from "../api/commands";
import type { FileText, PreviewPlugin, Textconv } from "../api/types";
import { type Choice, extOf, isDark, pluginUrl } from "../preview";
import { jump } from "../nav";
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
function useBytes(path: string, rev: string | null, on = true): Bytes {
  const [st, setSt] = useState<Bytes & { key: string }>({ key: "", buf: null, error: null });
  const key = `${path}@${rev ?? ""}`;
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.fileBytes(path, rev).then(
      (buf) => live && setSt({ key, buf, error: null }),
      (e) => live && setSt({ key, buf: null, error: errOf(e).message }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on]);
  return st.key === key ? st : { buf: null, error: null };
}

/** A blob URL for the bytes, revoked when they change */
function useBlobUrl(buf: ArrayBuffer | null, type: string): string | null {
  const url = useMemo(() => (buf ? URL.createObjectURL(new Blob([buf], { type })) : null), [buf, type]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url;
}

export function PreviewPane({ choice, path, rev, file }: { choice: Choice; path: string; rev: string | null; file: FileText | null }) {
  const p = choice.plugin;
  return (
    <div className="pv">
      {p ? (
        <PluginFrame plugin={p} path={path} rev={rev} />
      ) : choice.builtin === "markdown" ? (
        <MarkdownView path={path} rev={rev} text={file?.text ?? ""} />
      ) : choice.builtin === "csv" ? (
        <CsvView text={file?.text ?? ""} tsv={extOf(path) === "tsv"} />
      ) : choice.builtin === "json" ? (
        <JsonView text={file?.text ?? ""} />
      ) : choice.builtin === "textconv" ? (
        <TextconvView path={path} rev={rev} />
      ) : (
        <MediaView kind={choice.builtin ?? "image"} path={path} rev={rev} />
      )}
    </div>
  );
}

// ---------- Images, PDF, audio, video ----------

function MediaView({ kind, path, rev }: { kind: string; path: string; rev: string | null }) {
  const b = useBytes(path, rev);
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

// ---------- Markdown ----------

/** A path relative to a file, inside the repository ("" when it leaves the repository) */
function resolveRel(from: string, rel: string): string {
  const base = rel.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of rel.replace(/^\//, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!base.length) return "";
      base.pop();
    } else base.push(part);
  }
  return base.join("/");
}

function MarkdownView({ path, rev, text }: { path: string; rev: string | null; text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Loaded on first use: the editor bundle stays small
    Promise.all([import("marked"), import("dompurify")]).then(([{ marked }, { default: purify }]) => {
      const raw = marked.parse(text, { gfm: true, breaks: false, async: false }) as string;
      if (live) setHtml(purify.sanitize(raw, { FORBID_TAGS: ["style", "form", "input", "button"], FORBID_ATTR: ["style"] }));
    });
    return () => {
      live = false;
    };
  }, [text]);

  // Images: ones in the repository are read at the same revision; ones on the web aren't loaded (no network)
  useEffect(() => {
    const el = box.current;
    if (!el || html === null) return;
    const urls: string[] = [];
    let live = true;
    for (const img of Array.from(el.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:)?\/\//i.test(src)) {
        const s = document.createElement("span");
        s.className = "md-ext-img";
        s.textContent = img.alt ? t("[网上的图片：{0}]", img.alt) : t("[网上的图片]");
        s.title = src;
        img.replaceWith(s);
        continue;
      }
      if (/^(data:|blob:)/i.test(src)) continue;
      const target = resolveRel(path, decodeURIComponent(src.split(/[?#]/)[0]));
      img.removeAttribute("src");
      if (!target) continue;
      api.fileBytes(target, rev).then(
        (buf) => {
          if (!live) return;
          const u = URL.createObjectURL(new Blob([buf], { type: MIME[extOf(target)] ?? "image/png" }));
          urls.push(u);
          img.src = u;
        },
        () => img.classList.add("md-missing"),
      );
    }
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [html, path, rev]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) return void openUrl(href);
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const head = Array.from(box.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? []).find((h) => slug(h.textContent ?? "") === id);
      return head?.scrollIntoView({ block: "start" });
    }
    const target = resolveRel(path, decodeURIComponent(href.split("#")[0]));
    if (target) jump({ path: target, line: 1 }, { path, line: 1 });
  };

  if (html === null) return <p className="pad dim">{t("正在读取…")}</p>;
  return <div className="md-body" ref={box} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");

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

function TextconvView({ path, rev }: { path: string; rev: string | null }) {
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
  }, [path, rev]);
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

function PluginFrame({ plugin, path, rev }: { plugin: PreviewPlugin; path: string; rev: string | null }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const b = useBytes(path, rev);
  const [ready, setReady] = useState(false);
  const theme = useSettings().theme;
  // A new page for every file: plugins start from a clean slate
  const src = useMemo(() => pluginUrl(plugin) + `?n=${encodeURIComponent(path)}@${rev ?? ""}`, [plugin, path, rev]);
  useEffect(() => setReady(false), [src]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data as { type?: string } | null;
      if (m?.type === "strand:ready") setReady(true);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Send the file once the page is ready (a copy: the bytes stay usable here)
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!ready || !b.buf || !w) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    w.postMessage({ type: "strand:file", name, path, ext: extOf(path), rev, size: b.buf.byteLength, bytes: b.buf.slice(0), theme: isDark() ? "dark" : "light", lang }, "*");
  }, [ready, b.buf, path, rev]);

  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: "strand:theme", theme: isDark() ? "dark" : "light" }, "*");
  }, [theme, ready]);

  return (
    <div className="pv-plugin">
      {b.error && <p className="pad err">{tr(b.error)}</p>}
      <iframe
        ref={frame}
        key={src}
        src={src}
        title={t("插件 {0}", plugin.name)}
        // Scripts only: no same-origin (so no access to Strand), no forms, popups or top navigation
        sandbox="allow-scripts"
        className="pv-frame"
      />
    </div>
  );
}
