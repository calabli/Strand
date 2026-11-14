// 文件视图（中间的“文件 · 名字”标签）：左边是这个文件的修改链，右边是内容或差异。
//
// 修改链从新到旧：最上面是“当前（工作区）”，下面是改过这个文件的提交（跟着重命名往前找，改名的那一步标出旧名字）。
// - 选“当前”：显示现在的内容；有没提交的改动时可以切到“未提交的改动”。
// - 选一个提交：默认显示这次提交对这个文件的修改，可以切到“这个版本的内容”。
// - ⌘ 或 Shift 单击再选一个：比较这两个版本（旧的在左、新的在右，中间改过名也能比较）。
// 差异用差异标签页同一套显示（合并视图或左右对比、忽略空白、上下块跳转）。
// 从内容搜索结果打开时（at）：显示那个版本（或工作区）的全文，滚到那一行并标出来；在修改链里选别的就回到平常的样子。

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errOf, wholeFile } from "../api/commands";
import type { FileDiff, FileHistory, FileText } from "../api/types";
import { DiffView } from "./DiffView";
import { StatusBadge } from "./FileRow";
import { Splitter, sizeVars } from "./Splitter";
import { findRegExp, relTime, shortId } from "./format";
import { Found } from "./inlineDiff";
import { highlight, langOf, type Tok } from "../highlight";
import { settings, useSettings } from "../settings";
import { t, tr } from "../i18n";

const WORK = "work";
const MAX_LINES = 20000;

interface Props {
  path: string;
  /** 打开时就显示修改链（从“文件历史”图标打开时）；平时收起，点工具栏的“修改链”再显示 */
  showHistory?: boolean;
  /** 打开后跳到哪一行、看哪个版本（空是工作区）；n 每次不同 */
  at?: { line: number; rev: string | null; find?: { text: string; regex: boolean; caseSensitive: boolean } | null; n: number } | null;
  /** 工作区里这个文件有没提交的改动（或是未跟踪的） */
  changed: boolean;
  onClose: () => void;
  /** 在日志里定位这个提交 */
  onLocate: (id: string) => void;
  /** 逐行追溯；rev 为空是工作区 */
  onBlame: (path: string, rev: string | null) => void;
}

type Load<T> = { data: T | null; loading: boolean; error: string | null };
const idle = { data: null, loading: false, error: null };

export function FileView({ path, at, changed, onClose, onLocate, onBlame, showHistory }: Props) {
  /** 修改链那一栏开着没有：默认收起，内容占满宽度 */
  const [chain, setChain] = useState(!!showHistory);
  useEffect(() => setChain(!!showHistory), [path, showHistory]);
  const [hist, setHist] = useState<Load<FileHistory>>({ ...idle, loading: true });
  /** 选中的：WORK 或提交哈希；最多两个，按点的先后 */
  const [sel, setSel] = useState<string[]>([WORK]);
  /** 只选一个时看什么：差异（提交的修改、未提交的改动）还是全文 */
  const [mode, setMode] = useState<"diff" | "text">("text");
  const [text, setText] = useState<Load<FileText>>(idle);
  const [diff, setDiff] = useState<Load<FileDiff>>(idle);
  const host = useRef<HTMLDivElement>(null);
  // 从搜索结果打开时：全文和差异里都标出搜索词（换文件后清掉）
  const findRe = at?.find ? findRegExp(at.find.text, at.find.regex, at.find.caseSensitive) : null;
  /** 内容搜索结果指向的版本（分支名、标签都可以）和行；在修改链里点别的就清掉 */
  const [jump, setJump] = useState<{ line: number; rev: string | null } | null>(null);
  useEffect(() => {
    if (!at) return;
    setJump({ line: at.line, rev: at.rev });
    setSel([WORK]);
    setMode("text");
  }, [at]);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setHist({ ...idle, loading: true });
    setSel([WORK]);
    setMode("text");
    if (!at) setJump(null);
    api.fileHistory(path).then(
      (data) => live && setHist({ data, loading: false, error: null }),
      (e) => live && setHist({ data: null, loading: false, error: errOf(e).message }),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const versions = useMemo(() => hist.data?.versions ?? [], [hist.data]);
  /** 在列表里的位置：工作区是 -1（最新），提交从 0 开始 */
  const order = (k: string) => (k === WORK ? -1 : versions.findIndex((v) => v.commit.id === k));
  const byId = (k: string) => versions.find((v) => v.commit.id === k) ?? null;
  const head = versions[0] ?? null;

  // 右边要显示的东西
  type Req = { kind: "text"; rev: string | null; path: string } | { kind: "diff"; from: string | null; fromPath: string; to: string | null; toPath: string; label: string };
  const req: Req | null = useMemo(() => {
    if (jump?.rev) return { kind: "text", rev: jump.rev, path };
    if (sel.length === 2) {
      const [a, b] = [...sel].sort((x, y) => order(y) - order(x)); // 旧的在前
      const va = byId(a);
      const vb = b === WORK ? null : byId(b);
      if (!va) return null;
      return {
        kind: "diff",
        from: va.commit.id,
        fromPath: va.path,
        to: b === WORK ? null : b,
        toPath: vb?.path ?? path,
        label: t("比较 {0} → {1}", shortId(va.commit.id), b === WORK ? t("当前") : shortId(b)),
      };
    }
    const k = sel[0];
    if (k === WORK) {
      if (mode === "diff" && head) return { kind: "diff", from: head.commit.id, fromPath: head.path, to: null, toPath: path, label: t("未提交的改动") };
      return { kind: "text", rev: null, path };
    }
    const v = byId(k);
    if (!v) return null;
    if (mode === "text") return { kind: "text", rev: v.commit.id, path: v.path };
    return { kind: "diff", from: v.commit.parents[0] ?? null, fromPath: v.old_path ?? v.path, to: v.commit.id, toPath: v.path, label: t("提交 {0} 的修改", shortId(v.commit.id)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, mode, versions, path, head, jump]);

  const reqKey = JSON.stringify(req);
  useEffect(() => {
    if (!req) return;
    let live = true;
    if (req.kind === "text") {
      setText((x) => ({ ...x, loading: true, error: null }));
      api.fileText(req.path, req.rev).then(
        (data) => live && setText({ data, loading: false, error: null }),
        (e) => live && setText({ data: null, loading: false, error: errOf(e).message }),
      );
    } else {
      setDiff((x) => ({ ...x, loading: true, error: null }));
      // 删除文件的那个提交：新的一边没有这个文件，差异显示整个删除
      wholeFile((c) => api.fileDiffVersions(req.from, req.fromPath, req.to, req.toPath, c)).then(
        (data) => live && setDiff({ data, loading: false, error: null }),
        (e) => live && setDiff({ data: null, loading: false, error: errOf(e).message }),
      );
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  /** 单击选一个；⌘ / Shift 单击再选一个（比较），再点已选的取消 */
  const pick = (k: string, add: boolean) => {
    setJump(null);
    if (!add) {
      setSel([k]);
      setMode(k === WORK ? "text" : "diff");
      return;
    }
    setSel((s) => (s.includes(k) ? (s.length > 1 ? s.filter((x) => x !== k) : s) : [...s, k].slice(-2)));
  };

  // ↑ ↓ 在修改链里换版本
  const keys = [WORK, ...versions.map((v) => v.commit.id)];
  const move = (d: number) => {
    const i = keys.indexOf(sel[sel.length - 1]);
    const k = keys[Math.max(0, Math.min(keys.length - 1, i + d))];
    pick(k, false);
    list.current?.querySelector(`[data-k="${k}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const single = sel.length === 1 ? sel[0] : null;
  const singleV = single && single !== WORK ? byId(single) : null;

  return (
    <div className="fview" ref={host} style={sizeVars(settings(), ["paneHistory"])}>
      <div className="fv-bar">
        <span className="mono fv-path" title={path}>
          {path}
        </span>
        <span className="grow" />
        <button
          type="button"
          className={"btn sm fv-chain" + (chain ? " pressed" : "")}
          aria-pressed={chain}
          title={chain ? t("收起修改链") : t("显示修改链：改过这个文件的提交，可以看每次的修改、某个版本的内容，或比较两个版本")}
          onClick={() => {
            if (chain) {
              // 收起时回到现在的内容
              setSel([WORK]);
              setMode("text");
            }
            setChain((c) => !c);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 4v3.2l2 1.3" />
          </svg>
          {t("修改链")}
          {hist.data && <span className="dim">{versions.length + (hist.data.truncated ? "+" : "")}</span>}
        </button>
        <button type="button" className="ib" title={t("逐行追溯（看每一行是谁在哪个提交改的）")} aria-label={t("逐行追溯")} onClick={() => onBlame(path, null)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M2 3h3M2 7h3M2 11h3M7 3h5M7 7h5M7 11h5" />
          </svg>
        </button>
        <button type="button" className="ib" title={t("关闭文件")} aria-label={t("关闭文件")} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="fv-body">
        {chain && (
        <div
          className="fv-list"
          ref={list}
          role="listbox"
          aria-label={t("修改链")}
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <p className="fv-tip dim small">{t("单击看一个版本；⌘ 或 Shift 单击再选一个，比较两个版本")}</p>
          <VersionRow k={WORK} sel={jump?.rev ? [] : sel} onPick={pick} first last={!versions.length}>
            <div className="fv-title">{t("当前（工作区）")}</div>
            <div className="fv-meta dim small">{changed ? <span className="fv-tag warn">{t("有没提交的改动")}</span> : t("和最新提交相同")}</div>
          </VersionRow>
          {versions.map((v, i) => (
            <VersionRow key={v.commit.id} k={v.commit.id} sel={jump?.rev ? [] : sel} onPick={pick} last={i === versions.length - 1}>
              <div className="fv-title" title={v.commit.title}>
                {v.commit.title}
              </div>
              <div className="fv-meta dim small">
                <span className="mono">{shortId(v.commit.id)}</span> · {v.commit.author.name} · {relTime(v.commit.time)}
              </div>
              <div className="fv-meta small">
                <StatusBadge s={v.status} />
                {v.status === "A" && <span className="dim">{t("新增")}</span>}
                {v.status === "D" && <span className="dim">{t("删除")}</span>}
                {v.status === "R" && v.old_path && <span className="dim mono fv-ren" title={`${v.old_path} → ${v.path}`}>{t("从 {0} 改名", v.old_path.slice(v.old_path.lastIndexOf("/") + 1))}</span>}
                {v.binary ? <span className="dim">{t("二进制")}</span> : (
                  <>
                    <span className="mono plus">+{v.added}</span>
                    <span className="mono minus">−{v.deleted}</span>
                  </>
                )}
                <span className="grow" />
                <button
                  type="button"
                  className="ib sm frow-act"
                  title={t("在日志里定位这个提交")}
                  aria-label={t("在日志里定位 {0}", shortId(v.commit.id))}
                  onClick={(e) => {
                    e.stopPropagation();
                    onLocate(v.commit.id);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <circle cx="7" cy="7" r="3" />
                    <path d="M7 1v2.5M7 10.5V13M1 7h2.5M10.5 7H13" />
                  </svg>
                </button>
              </div>
            </VersionRow>
          ))}
          {hist.loading && <p className="dim pad small">{t("正在找出改过这个文件的提交…")}</p>}
          {hist.error && <p className="err pad">{tr(hist.error)}</p>}
          {hist.data && !versions.length && <p className="dim pad small">{t("这个文件还没有提交过（未跟踪的新文件）")}</p>}
        </div>
        )}
        {chain && (
        <Splitter
          name="paneHistory"
          host={host}
          grow="right"
          min={220}
          max={() => (host.current?.clientWidth ?? 900) - 360}
          size={() => list.current?.offsetWidth ?? 320}
          label={t("调整修改链的宽度")}
        />
        )}
        <div className="fv-main">
          {jump?.rev && (
            <div className="fv-mode">
              <span className="dim small">{t("{0} 时的内容（从搜索结果打开）", jump.rev)}</span>
            </div>
          )}
          {!jump?.rev && sel.length === 1 && (single === WORK ? changed && !!head : !!singleV) && (
            <div className="fv-mode">
              <span className="seg" role="radiogroup" aria-label={t("显示内容")}>
                <button type="button" role="radio" aria-checked={mode === "diff"} className={mode === "diff" ? "on" : ""} onClick={() => setMode("diff")}>
                  {single === WORK ? t("未提交的改动") : t("这次提交的修改")}
                </button>
                <button type="button" role="radio" aria-checked={mode === "text"} className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>
                  {single === WORK ? t("当前内容") : t("这个版本的内容")}
                </button>
              </span>
              {singleV && (
                <button type="button" className="btn sm" title={t("逐行追溯这个版本")} onClick={() => onBlame(singleV.path, singleV.commit.id)}>
                  {t("逐行追溯这个版本")}
                </button>
              )}
            </div>
          )}
          {req?.kind === "diff" ? (
            <DiffView diff={diff.data} loading={diff.loading} error={diff.error} source={req.label} find={findRe} readOnly={req.to !== null} blameSides={{ left: req.from ? { path: req.fromPath, rev: req.from } : null, right: { path: req.toPath, rev: req.to } }} onLocate={onLocate} onClose={() => (sel.length === 2 ? setSel([sel[1]]) : setMode("text"))} />
          ) : (
            <TextView load={text} focus={jump?.line ?? null} find={findRe} />
          )}
        </div>
      </div>
    </div>
  );
}

function VersionRow({ k, sel, onPick, first, last, children }: { k: string; sel: string[]; onPick: (k: string, add: boolean) => void; first?: boolean; last?: boolean; children: React.ReactNode }) {
  const on = sel.includes(k);
  const n = sel.indexOf(k);
  return (
    <div
      className={"fv-row" + (on ? " on" : "") + (first ? " first" : "") + (last ? " last" : "")}
      data-k={k}
      role="option"
      aria-selected={on}
      onClick={(e) => onPick(k, e.metaKey || e.ctrlKey || e.shiftKey)}
    >
      <span className="fv-dot" aria-hidden="true">
        {sel.length === 2 && on && <span className="fv-n">{n === 0 ? "A" : "B"}</span>}
      </span>
      <div className="fv-row-body">{children}</div>
    </div>
  );
}

/** 文件全文，带行号 */
function TextView({ load, focus, find }: { load: Load<FileText>; focus: number | null; find: RegExp | null }) {
  const f = load.data;
  const box = useRef<HTMLDivElement>(null);
  // 跳到指定的行
  useEffect(() => {
    if (!focus || load.loading) return;
    box.current?.querySelector(".tv-line.focus")?.scrollIntoView({ block: "center" });
  }, [focus, f, load.loading]);
  const lines = useMemo(() => {
    const all = f?.text?.split("\n") ?? [];
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
  }, [f]);
  // 语法高亮（在后台线程里着色，先显示没着色的）
  const syntax = useSettings().diffSyntax;
  const [toks, setToks] = useState<{ f: FileText; lines: Tok[][] } | null>(null);
  useEffect(() => {
    if (!f?.text || !syntax) return;
    let live = true;
    highlight(langOf(f.path), [f.text]).then(([t]) => live && t && setToks({ f, lines: t }));
    return () => {
      live = false;
    };
  }, [f, syntax]);
  const lineToks = syntax && toks?.f === f ? toks.lines : null;
  return (
    <div className="fv-text" ref={box}>
      {load.loading && !f && <p className="pad dim">{t("正在读取…")}</p>}
      {load.error && <p className="pad err">{tr(load.error)}</p>}
      {f?.missing && <p className="pad dim">{t("这个版本里没有这个文件（已删除或还没创建）")}</p>}
      {f?.binary && <p className="pad dim">{t("二进制文件，不显示内容（{0} 字节）", f.size)}</p>}
      {f?.text !== undefined && (
        <div className={"tv mono" + (load.loading ? " stale" : "")}>
          {lines.slice(0, MAX_LINES).map((l, i) => (
            <div key={i} className={"tv-line" + (focus === i + 1 ? " focus" : "")}>
              <span className="ln">{i + 1}</span>
              <span className="code">
                <Found t={l} find={find} toks={lineToks?.[i]} />
              </span>
            </div>
          ))}
          {(lines.length > MAX_LINES || f.truncated) && <p className="pad dim">{t("文件太大，只显示了前面一部分")}</p>}
        </div>
      )}
    </div>
  );
}
