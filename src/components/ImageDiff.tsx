// 图片对比（对照 JetBrains 的图片差异）：两边各读出这个版本的图片，三种看法——
// 并排（左旧右新）、滑动（拖动分界线左右对照）、叠加（调新图的透明度）。底下是棋盘格，透明的部分看得出来。
// 显示两边的尺寸和大小；只有一边时是新增或删除。

import { useEffect, useRef, useState } from "react";
import { api, errOf } from "../api/commands";
import { t, tr } from "../i18n";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();
/** 能当图片显示的文件（svg 是文本，平时看文本差异，这里也能当图片看） */
export const isImage = (p: string) => ext(p) in MIME;

type Side = { path: string; rev: string | null } | null | undefined;
interface Loaded {
  url: string;
  size: number;
  w: number;
  h: number;
}
type State = { status: "loading" } | { status: "none" } | { status: "error"; message: string } | ({ status: "ok" } & Loaded);

function useImage(side: Side): State {
  const [st, setSt] = useState<State>({ status: "loading" });
  const key = side ? `${side.path}@${side.rev ?? ""}` : "";
  useEffect(() => {
    if (!side) {
      setSt({ status: "none" });
      return;
    }
    let live = true;
    let url = "";
    setSt({ status: "loading" });
    api.fileBytes(side.path, side.rev).then(
      (buf) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([buf], { type: MIME[ext(side.path)] ?? "application/octet-stream" }));
        const img = new Image();
        img.onload = () => live && setSt({ status: "ok", url, size: buf.byteLength, w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => live && setSt({ status: "error", message: t("图片读不出来（格式不支持或文件坏了）") });
        img.src = url;
      },
      (e) => {
        if (!live) return;
        const err = errOf(e);
        setSt(err.code === "NOT_FOUND" ? { status: "none" } : { status: "error", message: err.message });
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return st;
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function Meta({ s, label }: { s: State; label: string }) {
  return (
    <span className="imd-meta">
      <span className="imd-label">{label}</span>
      {s.status === "ok" ? (
        <span className="dim mono">
          {s.w}×{s.h} · {bytes(s.size)}
        </span>
      ) : s.status === "none" ? (
        <span className="dim">{t("没有这个文件")}</span>
      ) : s.status === "loading" ? (
        <span className="dim">{t("正在读取…")}</span>
      ) : null}
    </span>
  );
}

type Mode = "side" | "swipe" | "fade";

export function ImageDiff({ left, right, compact }: { left: Side; right: Side; compact?: boolean }) {
  const a = useImage(left);
  const b = useImage(right);
  const [mode, setMode] = useState<Mode>("side");
  const [pos, setPos] = useState(50);
  const [alpha, setAlpha] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const both = a.status === "ok" && b.status === "ok";
  const m: Mode = both && !compact ? mode : "side";
  const same = both && a.size === b.size && a.w === b.w && a.h === b.h;
  // 两张图按较大的尺寸叠在一起
  const W = both ? Math.max(a.w, b.w) : 0;
  const H = both ? Math.max(a.h, b.h) : 0;

  const pane = (s: State, kind: "old" | "new") => (
    <div className={"imd-pane " + kind}>
      {s.status === "ok" ? (
        <div className="imd-checker">
          <img src={s.url} alt={kind === "old" ? t("旧版本") : t("新版本")} draggable={false} />
        </div>
      ) : s.status === "none" ? (
        <p className="imd-empty dim">{kind === "old" ? t("新增的图片") : t("图片已删除")}</p>
      ) : s.status === "error" ? (
        <p className="err small pad">{tr(s.message)}</p>
      ) : (
        <p className="imd-empty dim">{t("正在读取…")}</p>
      )}
    </div>
  );

  const drag = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const set = (x: number) => setPos(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)));
    set(e.clientX);
    const move = (ev: PointerEvent) => set(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className={"imd" + (compact ? " compact" : "")}>
      <div className="imd-head">
        <Meta s={a} label={t("旧")} />
        <Meta s={b} label={t("新")} />
        <span className="grow" />
        {same && <span className="dim small">{t("尺寸和大小都没变")}</span>}
        {both && !compact && (
          <div className="seg" role="radiogroup" aria-label={t("对比方式")}>
            {(
              [
                ["side", t("并排")],
                ["swipe", t("滑动")],
                ["fade", t("叠加")],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {m === "fade" && (
          <input type="range" min={0} max={100} value={alpha} onChange={(e) => setAlpha(+e.target.value)} aria-label={t("新图的透明度")} title={t("往右看新图，往左看旧图")} className="imd-range" />
        )}
      </div>
      {m === "side" ? (
        <div className="imd-side">
          {pane(a, "old")}
          {pane(b, "new")}
        </div>
      ) : a.status === "ok" && b.status === "ok" ? (
        <div className="imd-stage">
          <div ref={box} className="imd-stack imd-checker" style={{ aspectRatio: `${W} / ${H}`, maxWidth: W }} onPointerDown={m === "swipe" ? drag : undefined}>
            <img src={a.url} alt={t("旧版本")} draggable={false} style={{ width: `${(a.w / W) * 100}%` }} />
            <img
              src={b.url}
              alt={t("新版本")}
              draggable={false}
              className="top"
              style={{ width: `${(b.w / W) * 100}%`, ...(m === "swipe" ? { clipPath: `inset(0 0 0 ${pos}%)` } : { opacity: alpha / 100 }) }}
            />
            {m === "swipe" && (
              <div className="imd-handle" style={{ left: `${pos}%` }} role="slider" aria-label={t("分界线")} aria-valuenow={Math.round(pos)} aria-valuemin={0} aria-valuemax={100} tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") setPos((p) => Math.max(0, p - 5));
                  if (e.key === "ArrowRight") setPos((p) => Math.min(100, p + 5));
                }}
              />
            )}
          </div>
          {m === "swipe" && <p className="dim small imd-tip">{t("左边是旧图，右边是新图，拖动分界线对照")}</p>}
        </div>
      ) : null}
    </div>
  );
}
