// 控制台（说明书 5.8）：按时间顺序显示核心层执行过的 Git 命令。
// - `$` 一条是命令，下面是它的输出；`#` 一条是客户端自己的操作（如搁置、撤销）。
// - 失败的命令变红；右边是用时。查询类命令核心层不记。
// - 停在底部时新内容自动滚进来；往上翻着看时不打扰。
// - 顶部右边：复制全部、清空。内容在核心层里，切走再回来还在；不随撤销回退。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, onConsoleLine } from "../api/commands";
import type { ConsoleEntry } from "../api/types";
import { t, tr } from "../i18n";
import { COMMIT_ICONS as I } from "./commitOps";
import { MenuIcon } from "./Menu";

const KEEP = 300;

const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/** 一条换成纯文本（复制用） */
const asText = (e: ConsoleEntry) =>
  [`${clock(e.time)} ${e.kind === "command" ? "$" : "#"} ${e.kind === "note" ? tr(e.text, true) : e.text}`, ...e.output.map((l) => "    " + l), ...(e.more ? ["    " + t("…还有 {0} 行", e.more)] : [])].join("\n");

export function ConsoleView({ onToast }: { onToast: (text: string) => void }) {
  const [list, setList] = useState<ConsoleEntry[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let alive = true;
    let ready = false;
    const pending: ConsoleEntry[] = [];
    // 先订阅再取：取的过程中到的新条目先存着，取回后按 seq 去重接上
    const off = onConsoleLine((e) => {
      if (!alive) return;
      if (!ready) pending.push(e);
      else setList((l) => [...(l ?? []), e].slice(-KEEP));
    });
    const done = (tail: ConsoleEntry[]) => {
      if (!alive) return;
      ready = true;
      const last = tail[tail.length - 1]?.seq ?? 0;
      setList([...tail, ...pending.filter((e) => e.seq > last)].slice(-KEEP));
    };
    api.consoleTail().then(done, () => done([]));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 停在底部时跟着滚
  useLayoutEffect(() => {
    const b = box.current;
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [list]);

  const copy = () => {
    if (!list?.length) return;
    navigator.clipboard.writeText(list.map(asText).join("\n")).then(
      () => onToast(t("已复制控制台内容")),
      () => onToast(t("复制失败")),
    );
  };
  const clear = () => api.consoleClear().then(() => setList([]));

  return (
    <div className="tabpanel console">
      <div className="console-bar">
        <span className="dim small">{t("Strand 执行过的 Git 命令（查询类命令不显示）")}</span>
        <span className="grow" />
        <button type="button" className="ib" title={t("复制全部")} aria-label={t("复制全部")} onClick={copy} disabled={!list?.length}>
          <MenuIcon d={I.copy} />
        </button>
        <button type="button" className="ib" title={t("清空控制台")} aria-label={t("清空控制台")} onClick={clear} disabled={!list?.length}>
          <MenuIcon d={I.drop} />
        </button>
      </div>
      <div
        className="console-list mono"
        ref={box}
        role="log"
        aria-label={t("控制台")}
        tabIndex={0}
        onScroll={(e) => {
          const b = e.currentTarget;
          stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
        }}
      >
        {list?.length === 0 && <p className="dim console-empty">{t("还没有执行过 Git 命令")}</p>}
        {list?.map((e) => (
          <div key={e.seq} className={"con-entry" + (e.ok ? "" : " failed") + (e.kind === "note" ? " note" : "")}>
            <div className="con-head">
              <span className="dim con-time">{clock(e.time)}</span>
              <span className="con-sigil">{e.kind === "command" ? "$" : "#"}</span>
              {/* 客户端自己的操作是核心层的中文说明（和时间线一样），按界面语言翻译；命令和输出保持原样 */}
              <span className="con-text">{e.kind === "note" ? tr(e.text, true) : e.text}</span>
              {!e.ok && <span className="con-bad">{t("失败")}</span>}
              {e.ms !== undefined && <span className="dim con-ms">{e.ms} ms</span>}
            </div>
            {e.output.map((l, i) => (
              <div key={i} className="con-out">
                {l}
              </div>
            ))}
            {!!e.more && <div className="con-out dim">{t("…还有 {0} 行", e.more)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
