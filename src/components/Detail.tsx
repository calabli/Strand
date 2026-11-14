// Commit details (spec §5.5): changed files on top, commit info and the operation icon row below (§5.6).
// With two or more commits selected it becomes "N commits selected" with batch operations (§5.4).
// Hovering a file row shows a funnel icon that puts the path into the log's path filter (the spec says click the file, but click already opens the diff).
// The file list header has a "show as directory tree" toggle shared with the commit panel (spec §4.7, §5.5);
// clicking a file shows its diff in a box below the list (scrollable); double-click or the icon on the box opens it in the diff tab;
// compare with local, create patch and browse this revision are in the operation icon row below; hovering a file row offers blame.

import { useEffect, useRef, useState } from "react";
import { Splitter, sizeVars } from "./Splitter";
import { ApiError, api, openUrl, wholeFile } from "../api/commands";
import type { Cap, ChangeMatch, Commit, CommitCaps, FileChange, FileDiff, Signature, SigStatus } from "../api/types";
import { DiffView } from "./DiffView";
import { COMMIT_ICONS as ICON, type CommitOps } from "./commitOps";
import { FileRow, FileTree } from "./FileRow";
import { Found } from "./inlineDiff";
import { setSettings, settings, useSettings } from "../settings";
import { findRegExp, formatTime, relTime, shortId } from "./format";
import { FILTER_ICONS } from "./LogFilterBar";
import { lazy, t, tr } from "../i18n";

/** Descriptions of signature statuses */
const SIG_TEXT = lazy<Record<SigStatus, string>>(() => ({
  good: t("✓ 签名有效"),
  untrusted: t("✓ 签名有效（密钥未受信任）"),
  bad: t("✕ 签名无效"),
  expired: t("签名已过期"),
  expired_key: t("密钥已过期"),
  revoked: t("密钥已吊销"),
  unknown: t("已签名（本机无法验证）"),
  none: "",
}));


function Act({ icon, label, cap, danger, onClick }: { icon: string; label: string; cap?: Cap | null; danger?: boolean; onClick: () => void }) {
  const off = cap ? !cap.ok : cap === null;
  return (
    <button
      type="button"
      className={"ib dact" + (danger ? " x" : "")}
      title={off ? `${label}：${tr(cap?.why) || t("正在读取…")}` : label}
      aria-label={label}
      disabled={off}
      onClick={onClick}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={icon} />
      </svg>
    </button>
  );
}

interface Props {
  commit: Commit | null;
  caps: CommitCaps | null;
  ops: CommitOps;
  /** Current branch name (shown in the reset dialog) */
  branch: string | null;
  extra: {
    checkout: (c: Commit) => void;
    newBranch: (c: Commit) => void;
    newTag: (c: Commit) => void;
    rebaseFrom: (c: Commit) => void;
    patch: (c: Commit) => void;
    tree: (c: Commit) => void;
    compareLocal: (c: Commit) => void;
    setBase: (c: Commit) => void;
    pushTo: (c: Commit) => void;
  };
  /** Squash and drop with multi-select (spec §9.3) */
  onSquashMany: () => void;
  onDropMany: () => void;
  /** Select and scroll to a commit (parent, child) */
  onJump: (id: string) => void;
  /** Multi-selected commits (batch operations shown for two or more) */
  multi: string[];
  /** Whether all multi-selected commits can be cherry-picked */
  multiPick: Cap | null;
  onClearMulti: () => void;
  activePath: string | null;
  onOpenDiff: (commit: Commit, path: string) => void;
  /** Put a path into the log's path filter */
  onFilterPath: (path: string) => void;
  /** Blame a file in this commit */
  onBlame: (path: string, rev: string) => void;
  /** Open the file view (content and change chain) */
  onFileHistory: (path: string) => void;
  /** The log is searching by changes: list only files whose changed lines match, and mark matching lines in the diff */
  find?: { text: string; regex: boolean; caseSensitive: boolean } | null;
  /** Repository name: the root node in tree view */
  repoName?: string;
  /** The log is searching messages: mark the search term in the title and body */
  highlight?: { text: string; regex: boolean; caseSensitive: boolean } | null;
  /** Context menu for changed files: cherry-pick or revert some files, get this revision */
  onFileMenu?: (commit: Commit, file: FileChange, files: FileChange[], x: number, y: number) => void;
}

export function Detail({ commit, caps, ops, branch, extra, onJump, multi, multiPick, onClearMulti, onSquashMany, onDropMany, activePath, onOpenDiff, onFilterPath, onBlame, onFileHistory, find, highlight, repoName, onFileMenu }: Props) {
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const groupDir = useSettings().groupByDir;
  const [error, setError] = useState<string | null>(null);
  /** Splitters dragged up and down write heights here */
  const host = useRef<HTMLElement>(null);
  const filesBox = useRef<HTMLDivElement>(null);
  const infoBox = useRef<HTMLDivElement>(null);
  /** The file shown in the diff box below; keeps showing it after switching commits if it still exists */
  const [shown, setShown] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ data: FileDiff | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });

  // Signature status: queried separately (git takes a moment to verify signatures) so the file list isn't held up
  const [sig, setSig] = useState<{ id: string; s: Signature } | null>(null);
  useEffect(() => {
    if (!commit) return;
    let live = true;
    api.commitSignature(commit.id).then(
      (s) => live && setSig({ id: commit.id, s }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [commit]);
  const signature = sig && commit && sig.id === commit.id && sig.s.status !== "none" ? sig.s : null;

  useEffect(() => {
    if (!commit) return;
    let live = true;
    setFiles(null);
    setError(null);
    api
      .commitDetail(commit.id)
      .then((d) => {
        if (!live) return;
        setFiles(d.files);
        setShown((p) => (p && d.files.some((f) => f.path === p) ? p : null));
      })
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [commit]);

  const commitId = commit?.id;
  // When searching by changes: which files in this commit have matching changed lines
  const [matches, setMatches] = useState<ChangeMatch[] | null>(null);
  const [allFiles, setAllFiles] = useState(false);
  const findKey = find ? JSON.stringify(find) : "";
  useEffect(() => {
    setMatches(null);
    if (!commitId || !find) return;
    let live = true;
    api.commitChangeMatches(commitId, find.text, find.regex, find.caseSensitive).then(
      (m) => {
        if (!live) return;
        setMatches(m);
        // Automatically open the first matching file in the box below
        if (m.length) setShown((p) => (p && m.some((x) => x.path === p) ? p : m[0].path));
      },
      () => live && setMatches([]),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitId, findKey]);
  const findRe = find ? findRegExp(find.text, find.regex, find.caseSensitive) : null;
  const msgRe = highlight ? findRegExp(highlight.text, highlight.regex, highlight.caseSensitive) : null;
  const hitCount = new Map((matches ?? []).map((m) => [m.path, m.lines] as const));
  useEffect(() => {
    if (!commitId || !shown) return;
    let live = true;
    setDiff((d) => ({ ...d, loading: true, error: null }));
    wholeFile((c) => api.diffCommit(commitId, shown, c)).then(
      (data) => live && setDiff({ data, loading: false, error: null }),
      (e) => live && setDiff({ data: null, loading: false, error: e instanceof ApiError ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [commitId, shown]);

  if (multi.length >= 2) {
    return (
      <aside className="detail multi">
        <div className="multi-box">
          <h1>{t("已选 {0} 个提交", multi.length)}</h1>
          <p className="dim">{t("⌘ 单击加选或取消，Shift 单击选一段。")}</p>
          <div className="multi-btns">
            <button
              type="button"
              className="btn primary"
              disabled={!multiPick?.ok}
              title={multiPick?.ok ? t("按从旧到新的顺序拣选到当前分支") : multiPick?.why ?? t("正在读取…")}
              onClick={() => ops.cherryPick(multi)}
            >
              {t("全部拣选")}
            </button>
            <button type="button" className="btn" onClick={onSquashMany} title={t("除最早的一个外都并入上一个")}>
              {t("压缩成一个")}
            </button>
            <button type="button" className="btn danger" onClick={onDropMany}>
              {t("丢弃")}
            </button>
            <button type="button" className="btn" onClick={onClearMulti}>
              {t("取消多选")}
            </button>
          </div>
          {!multiPick?.ok && multiPick?.why && <p className="dim small">{tr(multiPick.why)}</p>}
        </div>
      </aside>
    );
  }

  if (!commit) return <aside className="detail empty">{t("选择一个提交查看详情")}</aside>;
  // When searching changes, list only matching files by default
  const listed = files && find && matches && !allFiles ? files.filter((f) => hitCount.has(f.path) || (f.old_path ? hitCount.has(f.old_path) : false)) : files;
  /** One changed-file row; depth is the level in tree view (only the file name is shown) */
  const fileRow = (f: FileChange, depth?: number) => (
          <div
            key={f.path}
            onContextMenu={(e) => {
              if (!onFileMenu || !files) return;
              e.preventDefault();
              onFileMenu(commit, f, files, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => {
              if (onFileMenu && files && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                onFileMenu(commit, f, files, r.left + 40, r.bottom);
              }
            }}
          >
          <FileRow
            key={f.path}
            depth={depth}
            f={f}
            active={shown ? shown === f.path : activePath === f.path}
            onOpen={() => setShown(f.path)}
            onDouble={() => onOpenDiff(commit, f.path)}
            trail={
              <span className="frow-acts">
              {hitCount.has(f.path) && (
                <span className="find-n" title={t("{0} 行改动有匹配", hitCount.get(f.path))}>
                  {hitCount.get(f.path)}
                </span>
              )}
              {f.status !== "D" && (
                <button type="button" className="ib sm frow-act" title={t("逐行追溯")} aria-label={t("逐行追溯 {0}", f.path)} onClick={() => onBlame(f.path, commit.id)}>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M2 3h3M2 7h3M2 11h3M7 3h5M7 7h5M7 11h5" />
                  </svg>
                </button>
              )}
              <button type="button" className="ib sm frow-act" title={t("文件历史：这个文件的修改链和版本对比")} aria-label={t("文件历史 {0}", f.path)} onClick={() => onFileHistory(f.path)}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="7" cy="7" r="5.5" />
                  <path d="M7 4v3.2l2 1.3" />
                </svg>
              </button>
              <button type="button" className="ib sm frow-act" title={t("只看改过这个文件的提交")} aria-label={t("按这个路径过滤日志")} onClick={() => onFilterPath(f.path)}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                  <path d={FILTER_ICONS.funnel} />
                </svg>
              </button>
              </span>
            }
          />
          </div>
  );

  return (
    <aside ref={host} style={sizeVars(settings(), ["detailFiles", "detailInfo"])} className={"detail" + (shown ? " with-diff" : "")}>
      <div className="dfiles" ref={filesBox}>
        <div className="dsub dim">
          {files ? t("{0} 个文件", files.length) : error ? "" : t("正在读取改动…")}
          {commit.parents.length > 1 && files && <span>{t("（相对第一个父提交）")}</span>}
          {find && matches && files && (
            <button
              type="button"
              className={"linklike find-toggle" + (allFiles ? "" : " on")}
              title={allFiles ? t("只看改动里有“{0}”的文件", find.text) : t("显示这个提交的全部文件")}
              onClick={() => setAllFiles((a) => !a)}
            >
              {allFiles ? t("只看匹配的 {0} 个", matches.length) : t("{0} 个有匹配 · 显示全部", matches.length)}
            </button>
          )}
          <span className="grow" />
          <button
            type="button"
            className={"ib sm" + (groupDir ? " pressed" : "")}
            aria-pressed={groupDir}
            title={t("按目录树显示（提交面板里的文件列表也一样）")}
            aria-label={t("按目录树显示")}
            onClick={() => setSettings({ groupByDir: !groupDir })}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
              <path d="M1.5 3h4l1 1.5h6V12h-11zM4 7.5h6M4 9.5h4" />
            </svg>
          </button>
        </div>
        {error && <p className="err">{tr(error)}</p>}
        {listed && (groupDir ? <FileTree items={listed} pathOf={(f) => f.path} leaf={(f, d) => fileRow(f, d)} root={repoName} /> : listed.map((f) => fileRow(f)))}
        {find && matches && matches.length === 0 && !allFiles && <p className="dim small pad">{t("这个提交的改动里没有找到“{0}”（可能是合并带进来的，或跨了多行）", find.text)}</p>}
      </div>
      {/* Vertical splitters: the file list's height; with the diff box shown, also the commit info's height, the diff box takes the rest */}
      <Splitter
        name="detailFiles"
        host={host}
        grow="down"
        min={60}
        max={() => (host.current?.clientHeight ?? 800) - (shown ? (infoBox.current?.offsetHeight ?? 0) + 160 : 120)}
        size={() => filesBox.current?.offsetHeight ?? 200}
        label={t("调整文件列表的高度")}
      />
      {shown && (
        <div className="ddiff">
          <DiffView
            compact
            diff={diff.data?.path === shown ? diff.data : null}
            loading={diff.loading}
            error={diff.error}
            source={shortId(commit.id)}
            imageSides={(() => {
              const f = files?.find((x) => x.path === shown);
              return { left: f?.status === "A" ? null : { path: f?.old_path ?? shown, rev: `${commit.id}^` }, right: f?.status === "D" ? null : { path: shown, rev: commit.id } };
            })()}
            onExpand={() => onOpenDiff(commit, shown)}
            find={findRe}
            onClose={() => setShown(null)}
          />
        </div>
      )}
      {shown && (
        <Splitter
          name="detailInfo"
          host={host}
          grow="up"
          min={80}
          max={() => (host.current?.clientHeight ?? 800) - (filesBox.current?.offsetHeight ?? 0) - 160}
          size={() => infoBox.current?.offsetHeight ?? 200}
          label={t("调整提交信息的高度")}
        />
      )}
      <div className="dinfo" ref={infoBox}>
        <div className="dacts" role="toolbar" aria-label={t("提交操作")}>
          <Act icon={ICON.copy} label={t("复制版本号")} onClick={() => ops.copy(commit)} />
          <Act icon={ICON.cherry} label={t("拣选到当前分支")} cap={caps?.cherry_pick ?? null} onClick={() => ops.cherryPick([commit.id])} />
          <Act icon={ICON.checkout} label={t("检出这个版本")} cap={caps?.checkout ?? null} onClick={() => extra.checkout(commit)} />
          <Act icon={ICON.reset} label={t("重置当前分支到这里")} cap={caps?.reset ?? null} onClick={() => ops.reset(commit, branch)} />
          <Act icon={ICON.revert} label={t("还原提交")} cap={caps?.revert ?? null} onClick={() => ops.revert(commit)} />
          <Act icon={ICON.undo} label={t("撤销提交")} cap={caps?.undo ?? null} onClick={ops.undo} />
          <Act icon={ICON.reword} label={t("修改提交说明（F2）")} cap={caps?.reword ?? null} onClick={() => ops.reword(commit)} />
          <Act icon={ICON.drop} label={t("丢弃提交")} cap={caps?.drop ?? null} danger onClick={() => ops.drop(commit)} />
          <Act icon={ICON.rebase} label={t("从这里开始整理")} cap={caps?.rebase_from ?? null} onClick={() => extra.rebaseFrom(commit)} />
          <span className="dact-gap" />
          <Act icon={ICON.patch} label={t("创建补丁")} onClick={() => extra.patch(commit)} />
          <Act icon={ICON.tree} label={t("查看这个版本时的仓库")} onClick={() => extra.tree(commit)} />
          <Act icon={ICON.compare} label={t("和本地比较")} cap={caps?.compare_local ?? null} onClick={() => extra.compareLocal(commit)} />
          <Act icon={ICON.base} label={t("设为比较起点")} onClick={() => extra.setBase(commit)} />
          <Act icon={ICON.branch} label={t("从这里新建分支")} onClick={() => extra.newBranch(commit)} />
          <Act icon={ICON.tag} label={t("在这里新建标签")} onClick={() => extra.newTag(commit)} />
          <Act icon={ICON.push} label={t("推送到这里为止")} cap={caps?.push_to ?? null} onClick={() => extra.pushTo(commit)} />
          <Act icon={ICON.parent} label={t("跳到父提交（→）")} cap={caps ? { ok: !!caps.parent, why: t("没有父提交") } : null} onClick={() => caps?.parent && onJump(caps.parent)} />
          <Act icon={ICON.child} label={t("跳到子提交（←）")} cap={caps ? { ok: !!caps.child, why: t("没有子提交") } : null} onClick={() => caps?.child && onJump(caps.child)} />
          {caps?.web_url && <Act icon={ICON.web} label={t("在浏览器中查看")} onClick={() => openUrl(caps.web_url!)} />}
        </div>
        <h1>
          <Found t={commit.title} find={msgRe} />
        </h1>
        {commit.body && (
          <p className="body">
            <Found t={commit.body} find={msgRe} />
          </p>
        )}
        <dl>
          <dt>{t("作者")}</dt>
          <dd className="who-line">
            <Avatar name={commit.author.name} email={commit.author.email} />
            <span>
              {commit.author.name} <span className="dim">&lt;{commit.author.email}&gt;</span>
            </span>
          </dd>
          <dt>{t("时间")}</dt>
          <dd>
            {formatTime(commit.time)} <span className="dim">· {relTime(commit.time)}</span>
          </dd>
          <dt>{t("版本号")}</dt>
          <dd className="mono">
            <button type="button" className="linklike mono" title={t("点击复制")} onClick={() => ops.copy(commit)}>
              {commit.id}
            </button>
          </dd>
          {signature && (
            <>
              <dt>{t("签名")}</dt>
              <dd>
                <span className={"sig sig-" + signature.status} title={[signature.signer, signature.key].filter(Boolean).join("\n")}>
                  {SIG_TEXT[signature.status]}
                </span>
                {signature.signer && <span className="dim small"> {signature.signer}</span>}
              </dd>
            </>
          )}
          <dt>{t("父提交")}</dt>
          <dd className="mono">
            {commit.parents.length
              ? commit.parents.map((p) => (
                  <button key={p} type="button" className="linklike mono" title={t("跳到这个提交")} onClick={() => onJump(p)}>
                    {shortId(p)}
                  </button>
                ))
              : t("无（根提交）")}
          </dd>
          {commit.unpushed && (
            <>
              <dt>{t("状态")}</dt>
              <dd>{t("未推送")}</dd>
            </>
          )}
          {commit.refs.length > 0 && (
            <>
              <dt>{t("引用")}</dt>
              <dd>{commit.refs.map((r) => r.name).join("、")}</dd>
            </>
          )}
        </dl>
      </div>
    </aside>
  );
}

/**
 * Author avatars (spec §5.5): no network fetch (works offline and doesn't send emails to third parties); Chinese names use the last two characters, others the initials of the first two words,
 * and the circle color is derived from the email so the same person always looks the same.
 */
function Avatar({ name, email }: { name: string; email: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const text = /[\u3400-\u9fff]/.test(name) ? [...name.trim()].slice(-2).join("") || "?" : words.slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? "").join("") || "?";
  let h = 0;
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ borderColor: `var(--l${h % 4})` }} aria-hidden="true">
      {text}
    </span>
  );
}
