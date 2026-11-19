import { useEffect, useRef, useState } from "react";
import { openUrl } from "../api/commands";
import { highlight, langOf, type Tok } from "../highlight";
import { lang, t } from "../i18n";
import { jump } from "../nav";
import { matchesExtensions, type EditorFormatAction, type PreviewInput, type PreviewProvider } from "../preview";
import { decodeMarkdownRef, embeddedImage, MarkdownImageCache, resolveMarkdownPath, webImage } from "./markdownAssets";

const HEADINGS = "h1,h2,h3,h4,h5,h6";
const EXTERNAL = /^(https?:|mailto:)/i;
const aliases = new Map(Object.entries({ shell: "bash", sh: "bash", zsh: "bash", console: "bash", "c#": "csharp", "c++": "cpp", plaintext: "", text: "" }));

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s+/g, "-");

let parser: Promise<(text: string) => string> | undefined;
function loadParser() {
  parser ??= Promise.all([import("marked"), import("dompurify")]).then(([{ Marked }, { default: createPurifier }]) => {
    const purify = createPurifier(window);
    purify.addHook("uponSanitizeAttribute", (node, data) => {
      // Keep raw HTML images useful without letting a document insert a live src or srcset.
      if (node.nodeName === "IMG" && data.attrName === "src") node.setAttribute("data-md-src", data.attrValue);
      if (data.attrName === "class" && (node.nodeName !== "CODE" || !/^language-[\w+#-]+$/i.test(data.attrValue))) data.keepAttr = false;
    });
    const md = new Marked({
      gfm: true,
      renderer: {
        // Images have no src until the host resolves the repository asset.
        image: ({ href, text, title }) => `<img data-md-src="${escape(href)}" alt="${escape(text)}"${title ? ` title="${escape(title)}"` : ""}>`,
        checkbox: ({ checked }) => `<span role="img" aria-label="${escape(checked ? t("已完成") : t("未完成"))}">${checked ? "☑" : "☐"}</span>`,
      },
    });
    return (source: string) => {
      const fragment = purify.sanitize(md.parse(source, { async: false }), {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: ["a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd", "li", "mark", "ol", "p", "pre", "s", "samp", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var"],
        ALLOWED_ATTR: ["align", "alt", "class", "colspan", "data-md-src", "height", "href", "open", "role", "rowspan", "start", "title", "width"],
        ALLOW_DATA_ATTR: false,
      });
      const ids = new Set<string>();
      for (const h of Array.from(fragment.querySelectorAll(HEADINGS))) {
        const base = slug(h.textContent ?? "") || "section";
        let id = base;
        for (let n = 1; ids.has(id); n++) id = `${base}-${n}`;
        ids.add(id);
        // Use a data attribute so a document heading can't shadow global DOM properties.
        h.setAttribute("data-md-anchor", id);
      }
      const container = document.createElement("div");
      container.append(fragment);
      return container.innerHTML;
    };
  }).catch((error) => {
    parser = undefined;
    throw error;
  });
  return parser;
}

function paintCode(code: HTMLElement, text: string, tokens: Tok[][]) {
  const out = document.createDocumentFragment();
  text.split("\n").forEach((line, i) => {
    if (i) out.append("\n");
    let offset = 0;
    for (const [from, to, kind] of tokens[i] ?? []) {
      if (from > offset) out.append(line.slice(offset, from));
      const span = document.createElement("span");
      span.className = `tok-${kind}`;
      span.textContent = line.slice(from, to);
      out.append(span);
      offset = to;
    }
    out.append(line.slice(offset));
  });
  code.replaceChildren(out);
}

export function MarkdownView({ path, rev, text, reloadKey, anchor, live }: Omit<PreviewInput, "file"> & { text: string; live?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const assets = useRef<MarkdownImageCache | null>(null);
  const codeCache = useRef(new Map<string, Promise<(Tok[][] | null)[]>>());

  useEffect(() => {
    let active = true;
    const parse = () => {
      void loadParser().then((render) => {
        if (!active) return;
        setHtml(render(text));
        setError(false);
      }).catch(() => active && setError(true));
    };
    if (!live) parse();
    const timer = live ? window.setTimeout(parse, html === null ? 0 : 120) : undefined;
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // Existing output stays visible while a draft is being rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, live, lang]);

  useEffect(() => {
    const cache = new MarkdownImageCache();
    assets.current = cache;
    return () => cache.clear();
  }, [path, rev, reloadKey]);

  useEffect(() => {
    const el = box.current;
    const cache = assets.current;
    if (!el || html === null || !cache) return;
    let active = true;
    for (const img of Array.from(el.querySelectorAll<HTMLImageElement>("img[data-md-src]"))) {
      const src = img.dataset.mdSrc ?? "";
      if (webImage.test(src)) {
        const placeholder = document.createElement("span");
        placeholder.className = "md-ext-img";
        placeholder.textContent = img.alt ? t("[网上的图片：{0}]", img.alt) : t("[网上的图片]");
        placeholder.title = src;
        img.replaceWith(placeholder);
        continue;
      }
      if (embeddedImage.test(src)) {
        img.src = src;
        continue;
      }
      const target = resolveMarkdownPath(path, src);
      if (!target) {
        img.classList.add("md-missing");
        continue;
      }
      void cache.load(target, rev).then((u) => {
        if (active) { img.classList.remove("md-missing"); img.src = u; }
      }, () => {
        if (active) img.classList.add("md-missing");
      });
    }
    return () => { active = false; };
  }, [html, path, rev, reloadKey]);

  useEffect(() => {
    let active = true;
    const cache = codeCache.current;
    for (const code of Array.from(box.current?.querySelectorAll<HTMLElement>("pre > code[class^='language-']") ?? []).slice(0, 24)) {
      const fence = code.className.slice("language-".length).toLowerCase();
      const fileLanguage = langOf(`a.${fence}`);
      const language = aliases.get(fence) ?? (typeof fileLanguage === "string" ? fileLanguage : fence);
      const source = code.textContent ?? "";
      if (!language || !source || source.length > 80_000) continue;
      const key = `${language}\0${source}`;
      let result = cache.get(key);
      if (!result) {
        result = highlight(language, [source]);
        cache.set(key, result);
        if (cache.size > 32) cache.delete(cache.keys().next().value!);
      }
      void result.then(([tokens]) => { if (active && tokens) paintCode(code, source, tokens); });
    }
    return () => { active = false; };
  }, [html]);

  const scrollTo = (id: string) => {
    const heading = Array.from(box.current?.querySelectorAll<HTMLElement>("[data-md-anchor]") ?? []).find((h) => h.dataset.mdAnchor === id);
    heading?.scrollIntoView({ block: "start" });
  };
  const appliedAnchor = useRef<number | null>(null);
  useEffect(() => {
    if (html !== null && anchor && appliedAnchor.current !== anchor.n) {
      appliedAnchor.current = anchor.n;
      scrollTo(anchor.id);
    }
  }, [html, anchor]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href")?.trim() ?? "";
    e.preventDefault();
    if (EXTERNAL.test(href)) return void openUrl(href);
    if (href.startsWith("//")) return void openUrl(`https:${href}`);
    if (href.startsWith("#")) return scrollTo(decodeMarkdownRef(href.slice(1)));
    const target = resolveMarkdownPath(path, href);
    const hash = href.indexOf("#");
    if (target) jump({ path: target, line: 1, rev, anchor: hash >= 0 ? decodeMarkdownRef(href.slice(hash + 1)) : undefined }, { path, line: 1, rev });
  };

  if (error) return <p className="pad err">{t("无法渲染 Markdown")}</p>;
  if (html === null) return <p className="pad dim">{t("正在读取…")}</p>;
  if (!html) return <p className="pad dim">{t("空文件")}</p>;
  return <div className="md-body" ref={box} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

export const markdownProvider: PreviewProvider = {
  id: "markdown",
  label: () => t("Markdown 预览"),
  matches: matchesExtensions(["md", "markdown", "mdown", "mkd"]),
  View: ({ path, rev, file, reloadKey, anchor }) => <>
    <MarkdownView path={path} rev={rev} text={file?.text ?? ""} reloadKey={reloadKey} anchor={anchor} />
    {file?.truncated && <p className="pad dim small">{t("文件太大，只显示了前面一部分")}</p>}
  </>,
  editor: {
    markdown: true,
    wrap: true,
    View: ({ path, text }) => <MarkdownView path={path} rev={null} text={text} live />,
    actions: [
      heading(2, () => t("二级标题")),
      { ...wrap("bold", () => t("粗体"), "B", "**", "**"), shortcut: "Mod+B" },
      { ...wrap("italic", () => t("斜体"), "I", "*", "*"), shortcut: "Mod+I" },
      wrap("code", () => t("行内代码"), "` `", "`", "`"),
      { id: "link", label: () => t("插入链接"), icon: "↗", shortcut: "Mod+K", apply: (text) => {
        const label = text || t("链接文字");
        const start = label.length + 3;
        return { text: `[${label}](https://)`, from: start, to: start + 8 };
      } },
      list("list", () => t("项目列表"), "•", "- "),
      list("task", () => t("任务列表"), "☑", "- [ ] "),
      { ...heading(1, () => t("一级标题")), insertMenu: true },
      { ...heading(3, () => t("三级标题")), insertMenu: true },
      { ...wrap("strike", () => t("删除线"), "", "~~", "~~"), insertMenu: true, shortcut: "Mod+Shift+X" },
      { ...list("quote", () => t("引用块"), "", "> "), insertMenu: true },
      { id: "ordered", label: () => t("有序列表"), icon: "", wholeLines: true, insertMenu: true, apply: (text) => {
        if (!text) return { text: "1. ", from: 3, to: 3 };
        return { text: text.split("\n").map((line, i) => `${i + 1}. ${line.replace(/^\d+[.)]\s+/, "")}`).join("\n") };
      } },
      { id: "fence", label: () => t("插入代码块"), icon: "", wholeLines: true, insertMenu: true, apply: (text, cursorOnly) => {
        const code = cursorOnly ? "" : text;
        const longest = (code.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 2);
        const fence = "`".repeat(longest + 1);
        const prefix = cursorOnly && text ? `${text}\n\n${fence}\n` : `${fence}\n`;
        return { text: `${prefix}${code}\n${fence}`, from: prefix.length, to: prefix.length + code.length };
      } },
      { id: "table", label: () => t("插入表格"), icon: "", insertMenu: true, wholeLines: true, apply: (text, cursorOnly) => {
        const first = !cursorOnly && text ? text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|") : t("列名");
        const prefix = cursorOnly && text ? `${text}\n\n| ` : "\n| ";
        return { text: `${prefix}${first} | ${t("列名")} |\n| --- | --- |\n|  |  |\n`, from: prefix.length, to: prefix.length + first.length };
      } },
      { id: "image", label: () => t("插入图片"), icon: "", insertMenu: true, apply: (text) => {
        const label = text || t("图片描述");
        const path = "images/example.png";
        return { text: `![${label}](${path})`, from: label.length + 4, to: label.length + 4 + path.length };
      } },
      { id: "rule", label: () => t("分隔线"), icon: "", wholeLines: true, insertMenu: true, apply: (text) => {
        const result = text ? `${text}\n\n---\n\n` : "\n---\n\n";
        return { text: result, from: result.length, to: result.length };
      } },
    ],
  },
};

function heading(level: number, label: () => string): EditorFormatAction {
  return { id: `heading-${level}`, label, icon: `H${level}`, wholeLines: true, apply: (text) => {
    const title = text.replace(/^#{1,6}[ \t]+/, "") || t("标题");
    const prefix = "#".repeat(level) + " ";
    return { text: prefix + title, from: prefix.length, to: prefix.length + title.length };
  } };
}

function wrap(id: string, label: () => string, icon: string, left: string, right: string): EditorFormatAction {
  return { id, label, icon, delimiters: [left, right], apply: (selected) => {
    if (selected.startsWith(left) && selected.endsWith(right) && selected.length >= left.length + right.length) {
      return { text: selected.slice(left.length, selected.length - right.length) };
    }
    const text = selected || label();
    return { text: left + text + right, from: left.length, to: left.length + text.length };
  } };
}

function list(id: string, label: () => string, icon: string, prefix: string): EditorFormatAction {
  return { id, label, icon, wholeLines: true, apply: (selected) => {
    const lines = selected.split("\n");
    if (lines.every((line) => line.startsWith(prefix))) return { text: lines.map((line) => line.slice(prefix.length)).join("\n") };
    if (!selected) return { text: prefix, from: prefix.length, to: prefix.length };
    return { text: lines.map((line) => (line && !line.startsWith(prefix) ? prefix + line : line)).join("\n") };
  } };
}
