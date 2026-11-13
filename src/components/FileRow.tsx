// 文件行：状态字母、路径、新增和删除行数（说明书 4.2）。提交面板和提交详情共用。

import type { ReactNode } from "react";
import type { FileChange } from "../api/types";
import { t } from "../i18n";

const STATUS_LABEL: Record<FileChange["status"], string> = {
  M: t("已修改"),
  A: t("新增"),
  D: t("已删除"),
  R: t("已重命名"),
  T: t("类型变化"),
};

export function StatusBadge({ s }: { s: FileChange["status"] | "?" }) {
  const letter = s === "T" ? "M" : s;
  return (
    <span className={`st st-${letter}`} title={s === "?" ? t("未跟踪") : STATUS_LABEL[s]}>
      {letter}
    </span>
  );
}

interface Props {
  f: FileChange;
  active?: boolean;
  onOpen: () => void;
  /** 行首的控件，如勾选框 */
  lead?: ReactNode;
  /** 行尾悬停时出现的图标 */
  trail?: ReactNode;
}

export function FileRow({ f, active, onOpen, lead, trail }: Props) {
  const name = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
  return (
    <div className={"frow" + (active ? " active" : "")}>
      {lead}
      <button type="button" className="frow-main" onClick={onOpen} title={name}>
        <StatusBadge s={f.status} />
        <span className="fpath mono">{name}</span>
        {f.binary ? (
          <span className="dim">{t("二进制")}</span>
        ) : f.no_stats ? (
          <span className="dim mono" title={t("这个仓库是部分克隆，文件内容还没下载，暂时算不出行数")}>
            —
          </span>
        ) : (
          <>
            <span className="mono plus">+{f.added}</span>
            <span className="mono minus">−{f.deleted}</span>
          </>
        )}
      </button>
      {trail}
    </div>
  );
}
