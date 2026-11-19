# Strand preview plugins

Copy a plugin's folder into the directory opened by **Preview plugins → Open plugins folder**, then select **Refresh**. Open a matching file. Its file tab offers the plugin in the preview menu, and a format-specific plugin opens automatically when there is no built-in preview or remembered preference for that type.

To try a format with no built-in preview, use the [JSON Lines example](../examples/preview-plugins/json-lines/). Copy the entire `json-lines` folder, then open a `.jsonl` or `.ndjson` file containing one JSON value per line.

## Manifest

Each plugin is a directory with a `manifest.json` and a local HTML entry page. The directory name identifies the plugin and may contain ASCII letters, digits, hyphens, underscores and dots. It must start with a character other than a dot.

```json
{
  "name": "JSON Lines",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Preview newline-delimited JSON",
  "extensions": ["jsonl", "ndjson"],
  "entry": "index.html"
}
```

- Set at least one of `extensions` or `filenames`. Matching is case-insensitive. Extensions can include an initial dot or multiple parts such as `data.gz`. Use `filenames` for exact names such as `Dockerfile`. Use `"*"` as an extension for a general-purpose viewer offered in the menu.
- `entry` defaults to `index.html`. Resolve scripts, styles and other bundled assets relative to the entry page.
- `apiVersion` is the preview protocol version and defaults to `1` for existing manifests. `version` is your plugin's own version. The management window reports invalid manifests, missing entry pages and unsupported protocol versions.

## API version 1

Register a `message` listener, then send `parent.postMessage({ type: "strand:ready" }, "*")`. For incoming messages, check `event.source === parent`.

| Message | Fields |
| --- | --- |
| `strand:file` | `apiVersion`, `name`, repository-relative `path`, lowercase `ext`, `rev` (`null` for the worktree), `size` in bytes, `bytes` as an `ArrayBuffer`, `theme` (`light` or `dark`) and `lang` (`zh` or `en`). The host may send fresh file data while the preview is open. |
| `strand:theme` | `theme` when the app theme changes. |

Plugins render in a sandboxed iframe. Bundle dependencies locally. The iframe receives the selected file and its metadata, with no Strand API for repository access or writing files. Treat file content as data. Use `textContent` or another safe rendering path when showing user-supplied strings.

Built-in viewers register a `PreviewProvider` with a file matcher and a view component. The provider can also expose live editing tools where appropriate. The same file-tab host discovers installed manifests, chooses a viewer and passes it the active file and revision.
