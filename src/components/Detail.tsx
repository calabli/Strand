// 提交详情（说明书 5.5）：上半是改动文件，下半是提交信息和操作图标行（5.6）。
// 选中两个及以上提交时改为“已选 N 个提交”和批量操作（5.4）。
// 文件行悬停出现漏斗图标，点它把路径填进日志的路径过滤（说明书写的是单击文件，单击已经用来打开差异）。
// 待实现：按目录分组、和本地比较、创建补丁、查看这个版本时的仓库、逐行追溯。

import { useEffect, useState } from "react";
import { ApiError, api, openUrl } from "../api/commands";
import type { Cap, Commit, CommitCaps, FileChange } from "../api/types";
import { COMMIT_ICONS as ICON, type CommitOps } from "./commitOps";
import { FileRow } from "./FileRow";
import { formatTime, relTime, shortId } from "./format";
import { FILTER_ICONS } from "./LogFilterBar";
import { t, tr } from "../i18n";


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
  /** 当前分支名（重置对话框里显示） */
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
  /** 多选时的压缩、丢弃（说明书 9.3） */
  onSquashMany: () => void;
  onDropMany: () => void;
  /** 选中并滚动到某个提交（父提交、子提交） */
  onJump: (id: string) => void;
  /** 多选的提交（两个及以上时显示批量操作） */
  multi: string[];
  /** 多选的提交能不能全部拣选 */
  multiPick: Cap | null;
  onClearMulti: () => void;
  activePath: string | null;
  onOpenDiff: (commit: Commit, path: string) => void;
  /** 把路径填进日志的路径过滤 */
  onFilterPath: (path: string) => void;
  /** 逐行追溯这个提交里的文件 */
  onBlame: (path: string, rev: string) => void;
}

export function Detail({ commit, caps, ops, branch, extra, onJump, multi, multiPick, onClearMulti, onSquashMany, onDropMany, activePath, onOpenDiff, onFilterPath, onBlame }: Props) {
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!commit) return;
    let live = true;
    setFiles(null);
    setError(null);
    api
      .commitDetail(commit.id)
      .then((d) => live && setFiles(d.files))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [commit]);

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
  return (
    <aside className="detail">
      <div className="dfiles">
        <div className="dsub dim">
          {files ? t("{0} 个文件", files.length) : error ? "" : t("正在读取改动…")}
          {commit.parents.length > 1 && files && <span>{t("（相对第一个父提交）")}</span>}
        </div>
        {error && <p className="err">{tr(error)}</p>}
        {files?.map((f) => (
          <FileRow
            key={f.path}
            f={f}
            active={activePath === f.path}
            onOpen={() => onOpenDiff(commit, f.path)}
            trail={
              <span className="frow-acts">
              {f.status !== "D" && (
                <button type="button" className="ib sm frow-act" title={t("逐行追溯")} aria-label={t("逐行追溯 {0}", f.path)} onClick={() => onBlame(f.path, commit.id)}>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M2 3h3M2 7h3M2 11h3M7 3h5M7 7h5M7 11h5" />
                  </svg>
                </button>
              )}
              <button type="button" className="ib sm frow-act" title={t("只看改过这个文件的提交")} aria-label={t("按这个路径过滤日志")} onClick={() => onFilterPath(f.path)}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                  <path d={FILTER_ICONS.funnel} />
                </svg>
              </button>
              </span>
            }
          />
        ))}
      </div>
      <div className="dinfo">
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
        <h1>{commit.title}</h1>
        {commit.body && <p className="body">{commit.body}</p>}
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
 * 作者头像（说明书 5.5）：不联网取头像（离线可用，也不把邮箱发给第三方），中文名取最后两个字，其余取前两个单词的首字母，
 * 圈的颜色按邮箱算，同一个人每次一样。
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
