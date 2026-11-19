import { api } from "../api/commands";
import { extOf } from "../preview";

const imageMime: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml",
};

export const webImage = /^(https?:)?\/\//i;
export const embeddedImage = /^data:image\/(?:png|gif|jpeg|webp|avif|bmp|x-icon|svg\+xml)[;,]/i;

export function decodeMarkdownRef(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Resolve an authored Markdown URL to a repository-relative path. */
export function resolveMarkdownPath(from: string, raw: string): string | null {
  const rel = decodeMarkdownRef(raw.split(/[?#]/, 1)[0]);
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith("//") || /[\\\x00-\x1f]/.test(rel)) return null;
  const parts = rel.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/") || null;
}

export class MarkdownImageCache {
  private urls = new Map<string, Promise<string>>();

  load(path: string, rev: string | null) {
    let url = this.urls.get(path);
    if (!url) {
      const type = imageMime[extOf(path)];
      url = api.fileBytes(path, rev).then((buf) => URL.createObjectURL(new Blob([buf], { type: typeof type === "string" ? type : "application/octet-stream" })));
      this.urls.set(path, url);
    }
    return url;
  }

  clear() {
    for (const url of this.urls.values()) void url.then((value) => URL.revokeObjectURL(value), () => {});
    this.urls.clear();
  }
}
