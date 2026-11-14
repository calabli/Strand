// 仓库列表和设置。
// - 仓库列表：工具栏的仓库名打开，列出最近打开的仓库（固定的在前），可以搜索、切换、固定、从列表移除、打开其他文件夹。
// - 设置：工具栏的齿轮图标或 ⌘, 打开，改动立即生效（语言也是就地切换，不重新加载窗口）。

import { useReturnFocus } from "./focus";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GitInfo } from "../api/types";
import { lang, langSetting, setLang, t, type LangSetting } from "../i18n";
import { forgetRepo, setSettings, togglePin, useRecentRepos, useSettings, type RecentRepo, type Settings } from "../settings";
import { formatTime } from "./format";

/** 最近打开的仓库列表（工具栏弹出和“打开一个仓库”页共用） */
export function RepoList({ current, onOpen, onClose, autoFocus = true }: { current: string | null; onOpen: (path: string) => void; onClose?: () => void; autoFocus?: boolean }) {
  const repos = useRecentRepos();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    return repos.filter((r) => !f || r.name.toLowerCase().includes(f) || r.path.toLowerCase().includes(f));
  }, [repos, q]);
  useEffect(() => setHi(0), [q]);

  const open = (r: RecentRepo | undefined) => {
    if (!r) return;
    onClose?.();
    if (r.path !== current) onOpen(r.path);
  };

  return (
    <div
      className="repo-list"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHi((h) => Math.min(shown.length - 1, h + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setHi((h) => Math.max(0, h - 1));
        } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          open(shown[hi]);
        }
      }}
    >
      {repos.length > 0 && <input className="pk-q" placeholder={t("搜索仓库")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} spellCheck={false} />}
      <div className="repo-rows">
        {shown.map((r, i) => (
          <div key={r.path} className={"repo-row" + (i === hi ? " hi" : "") + (r.path === current ? " cur" : "")} onMouseEnter={() => setHi(i)}>
            <button type="button" className="repo-main" onClick={() => open(r)} title={r.path}>
              <span className="repo-name">
                {r.pinned && <span className="star">★ </span>}
                {r.name}
                {r.path === current && <span className="cur-tag">{t("当前")}</span>}
              </span>
              <span className="repo-path dim">{r.path}</span>
            </button>
            <span className="repo-acts">
              <span className="dim small repo-time">{formatTime(r.opened).slice(0, 10)}</span>
              <button type="button" className="ib sm" title={r.pinned ? t("取消固定") : t("固定在上面")} aria-label={r.pinned ? t("取消固定") : t("固定在上面")} onClick={() => togglePin(r.path)}>
                {r.pinned ? "★" : "☆"}
              </button>
              <button type="button" className="ib sm" title={t("从列表里移除（不删除文件）")} aria-label={t("从列表里移除")} onClick={() => forgetRepo(r.path)}>
                ×
              </button>
            </span>
          </div>
        ))}
        {repos.length > 0 && shown.length === 0 && <p className="dim pad">{t("没有匹配的仓库")}</p>}
      </div>
    </div>
  );
}

/** 工具栏仓库名下面弹出的仓库列表 */
export function RepoPopup({ x, y, current, onOpen, onBrowse, onClone, onClose }: { x: number; y: number; current: string | null; onOpen: (path: string) => void; onBrowse: () => void; onClone: () => void; onClose: () => void }) {
  useReturnFocus();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: y });
  }, [x, y]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [onClose]);
  return (
    <div className="picker repo-pop" ref={box} style={pos} role="dialog" aria-label={t("仓库")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <RepoList current={current} onOpen={onOpen} onClose={onClose} />
      <button
        type="button"
        className="repo-browse"
        onClick={() => {
          onClose();
          onBrowse();
        }}
      >
        {t("打开其他文件夹…")}
      </button>
      <button
        type="button"
        className="repo-browse"
        onClick={() => {
          onClose();
          onClone();
        }}
      >
        {t("克隆仓库…")}
      </button>
    </div>
  );
}

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <span className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/** 设置窗口 */
export function SettingsWindow({ git, onClose }: { git: GitInfo | null; onClose: () => void }) {
  useReturnFocus();
  const s = useSettings();
  const set = (p: Partial<Settings>) => setSettings(p);
  const [langV, setLangV] = useState<LangSetting>(langSetting());
  const row = (label: string, control: React.ReactNode, hint?: string) => (
    <div className="set-row">
      <div>
        <div>{label}</div>
        {hint && <div className="dim small">{hint}</div>}
      </div>
      {control}
    </div>
  );
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label={t("设置")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{t("设置")}</h2>
        <div className="set-sec dim">{t("外观")}</div>
        {row(
          t("语言"),
          <Choice<LangSetting>
            value={langV}
            options={[
              ["auto", t("跟随系统")],
              ["zh", "中文"],
              ["en", "English"],
            ]}
            onChange={(v) => {
              setLangV(v);
              if (v !== langSetting()) setLang(v);
            }}
          />,
          t("当前是{0}", lang === "zh" ? "中文" : "English"),
        )}
        {row(
          t("主题"),
          <Choice
            value={s.theme}
            options={[
              ["auto", t("跟随系统")],
              ["light", t("浅色")],
              ["dark", t("深色")],
            ]}
            onChange={(v) => set({ theme: v })}
          />,
        )}
        {row(t("显示精确日期"), <Toggle on={s.exactDates} label={t("显示精确日期")} onChange={(v) => set({ exactDates: v })} />, t("关闭后日志里显示“3 小时前”这样的相对时间"))}
        <div className="set-sec dim">{t("远程")}</div>
        {row(t("自动抓取"), <Toggle on={s.autoFetch} label={t("自动抓取")} onChange={(v) => set({ autoFetch: v })} />, t("打开仓库时和窗口重新获得焦点时抓取，更新领先落后数"))}
        {s.autoFetch &&
          row(
            t("最短间隔"),
            <Choice
              value={s.fetchMinutes}
              options={[
                [5, t("{0} 分钟", 5)],
                [15, t("{0} 分钟", 15)],
                [30, t("{0} 分钟", 30)],
              ]}
              onChange={(v) => set({ fetchMinutes: v })}
            />,
          )}
        <div className="set-sec dim">{t("提交")}</div>
        {row(t("加签名行"), <Toggle on={s.signOff} label={t("加签名行")} onChange={(v) => set({ signOff: v })} />, t("在提交说明末尾加 Signed-off-by"))}
        <div className="set-sec dim">{t("启动")}</div>
        {row(t("启动时打开上次的仓库"), <Toggle on={s.reopenLast} label={t("启动时打开上次的仓库")} onChange={(v) => set({ reopenLast: v })} />)}
        <div className="set-sec dim">Git</div>
        {row(t("系统 Git"), <span className="mono dim">{git?.version ?? t("没有找到")}</span>, t("Strand 使用系统里安装的 Git，最低版本 {0}", git?.min_version ?? "2.30"))}
        <div className="modal-btns">
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            {t("完成")}
          </button>
        </div>
      </div>
    </div>
  );
}
