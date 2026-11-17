# Strand

A cross-platform desktop Git client for macOS and Windows, built with Tauri 2 and a Rust core. Its features and layout follow the Git integration in JetBrains IDEs, so you can commit, browse history and resolve conflicts the same way without opening an IDE. The UI is available in English and Chinese.

Strand is a working name. The current version is 0.1.0.

Website: https://calabli.github.io/Strand/ (source in `site/`, deployed to GitHub Pages by `.github/workflows/pages.yml`).

## Features

**History**
- Log with a commit graph; long edges are collapsed so even large repositories stay narrow. Opens an 86k-commit repository in about 135 ms (with a commit-graph file).
- Filter by text (regex, case sensitivity), branch, author (multi-select or rules), date range and path; search inside historical changes (`git log -S` / `-G`).
- Sort by time or graph order, first-parent only, hide merges, collapse linear branches.
- Blame, file history that follows renames, comparing any two versions of a file.
- Files open in tabs, one per file: close, close others, close left/right, close all, pin, ⌘W, ⇧⌘T to reopen and ⌘E for recent files. The file view can show who last changed each line on the left and follow a line back to the version before the change.
- Clean up merged branches: list the local branches already merged into main (or any branch), delete them in one undoable step.
- Remote cleanup: fetch prunes branches deleted on the remote; delete remote branches and tags; set or change a branch's upstream.
- Find (⌘F) and go to line (⌘L) in diffs and file views; several diff tabs; double-click a commit to open its changes; multi-select files in the commit panel; drag file tabs to reorder.
- Stash to a new branch, move all untracked files to the trash (undoable), system notifications when long network operations finish in the background; the window remembers its size and shows the repository and branch in its title.
- Reveal files in the file manager, open them with the default app, open the repository in a terminal; copy a commit's full hash, short hash or message.
- Pull requests (GitHub) and merge requests (GitLab): list the open ones with their CI checks, check out their branch, open them in the browser, and create one from the current branch. The access token comes from Git's credential helper; Strand never stores it.
- Edit files right in their tab with a code editor: syntax colors, find and replace, go to line, undo; unsaved changes are marked and kept from being lost. Open repositories in new windows; change keyboard shortcuts in Settings.
- Contribution statistics for the current branch: commits and changed lines per author and per month, and a weekday × hour activity map.
- Submodules in the branch tree with their state; update (initializing when needed) or open one in Strand.
- Git LFS: diffs, file views and image comparisons show the downloaded content instead of pointer files; files not downloaded yet can be fetched with `git lfs pull` (needs git-lfs installed).
- Bisect with a progress bar above the log, and a reflog window to recover lost commits.

**Committing**
- Commit whole files or individual lines; hooks, signing and line-ending conversion run as usual.
- Changelists, message history, `commit.template` support, committing as another author, `Co-authored-by` lines.
- Format and check commands before committing, with recognized issues listed by file and line.
- Amend, fixup and squash into earlier commits; interactive rebase in a window (reorder, keep, fold, drop, edit messages).
- Shelf (per-file, named, partial restore) and stash, both optionally including untracked files.

**Undo**
- An operation timeline records every write. ⌘Z undoes commits, resets, rebases, branch deletions, discards, cherry-picks and more, and redo brings them back.
- Steps that cross already-pushed commits ask first; steps affected by changes made elsewhere are marked as not undoable.

**Branches and remotes**
- Branch tree with favorites, worktrees, tags and multiple remotes.
- Drag a branch onto another to merge or rebase; merge modes include no-fast-forward and squash.
- Fetch, pull (merge or rebase, with a dry-run summary when conflicts are expected) and push with a preview, `--force-with-lease`, "push up to here" and tag pushing.
- Credential prompts for usernames, passwords and SSH passphrases; answers go only to that git process and are never stored.
- In-app updates: on startup (can be turned off in Settings) Strand checks GitHub Releases for a new version; you can download and install it from a card in the corner, and the app restarts. Packages are signed, and a package whose signature doesn't match is not installed.
- Git settings in the app: user name, email, proxy (with an on/off switch that keeps the address), line endings and the default branch name, globally or per repository. Strand's network operations go through system Git, so they use the proxy too.

**Conflicts**
- Conflict list and a three-pane merge window: mark each change block, preview the result, undo and redo, continue later.
- Image conflicts can be previewed side by side, with a swipe, or as an onion skin.
- Aborting a merge, rebase or pull can itself be undone.

**Diffs and files**
- Unified or side-by-side diffs of whole files with unchanged parts folded, connecting ribbons, a change position strip, syntax highlighting, indent guides, breadcrumbs and blame.
- Edit worktree files directly in the diff.
- Image diffs, comparing any two files, comparing with the clipboard.
- Cherry-pick or revert only some files of a commit; get a file from any revision.
- Apply patches (including `git format-patch` mailboxes) by pasting, choosing a file or dropping it on the window.

## Download

Builds come from GitHub Actions. Tagged versions (`v*`) are attached to [Releases](https://github.com/calabli/Strand/releases); every push to `main` also produces downloadable artifacts on the [Actions](https://github.com/calabli/Strand/actions) page.

| Platform | Files |
| --- | --- |
| macOS (Apple silicon) | `Strand_<version>_aarch64.dmg` |
| Windows (x64) | `Strand_<version>_x64-setup.exe` (installer), `Strand_<version>_x64_en-US.msi`, `Strand_<version>_x64_portable.exe` (no install) |

Strand calls the Git installed on your system, so you need Git 2.30 or later. On Windows, the portable exe needs the WebView2 runtime, which Windows 10 and 11 normally include; the installers set it up when missing.

The macOS build is ad-hoc signed and not notarized. The first time you open it, macOS blocks it: right-click the app and choose Open, or allow it under System Settings › Privacy & Security. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine /Applications/Strand.app`. The Windows builds are unsigned, so SmartScreen may ask you to confirm.

A user manual with screenshots (in Chinese) is in [docs/Strand 使用说明书.md](docs/Strand%20使用说明书.md).

## Development

Requirements: Rust 1.88+, Node.js 20+, pnpm, and system Git 2.30+. On Windows you also need WebView2 and the Visual Studio Build Tools.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

This starts the desktop app in development mode with live reload. You can also open a repository directly: `./target/debug/strand /path/to/repo`.

To work on the UI only, run the frontend in a browser at http://localhost:1420 without Tauri; data comes from `src/api/mock.ts`:

```bash
pnpm dev
```

Run the core tests (they create temporary repositories with system Git):

```bash
pnpm test
```

`pnpm build` type-checks and builds the frontend.

### Packaging

macOS:

```bash
pnpm tauri build --bundles app,dmg
```

Windows:

```bash
pnpm tauri build --bundles nsis,msi
```

Output goes to `target/release/bundle/`; the plain executable is `target/release/strand(.exe)`.

- Local macOS builds target the host architecture. For Intel Macs, `rustup target add x86_64-apple-darwin` and build with `--target universal-apple-darwin`.
- The minimum macOS version is 12 (`bundle.macOS.minimumSystemVersion` in `tauri.conf.json`).
- When launched from Finder or the Dock, Strand reads the login shell's `PATH` once so it uses the same `git` as your terminal (otherwise the system `/usr/bin/git` reads keychain credentials and macOS prompts for your password). Set `STRAND_KEEP_PATH=1` to turn this off.
- The app icon's source is `src-tauri/icons/icon.svg`. After editing it, run `rsvg-convert -w 1024 -h 1024 src-tauri/icons/icon.svg -o /tmp/strand-icon.png`, then `pnpm tauri icon /tmp/strand-icon.png`, and delete the `android/`, `ios/` and `64x64.png` it also generates.

### Continuous integration

`.github/workflows/build.yml` runs on pushes, pull requests, tags and manual dispatch:

- **Test**: core tests and a frontend type check on macOS.
- **Build (macOS arm64)**: builds the Apple silicon `.app` and `.dmg` on `macos-latest` (Apple silicon).
- **Build (Windows x64)**: builds the NSIS installer, the MSI and the portable exe on `windows-latest`.

Artifacts are uploaded for every run. Pushing a tag such as `v0.1.0` also creates a GitHub Release with all the files; its notes list the commit titles since the previous tag.

### Releasing a new version

1. Bump `version` in `src-tauri/tauri.conf.json`, `package.json` and `Cargo.toml` (they should match).
2. Commit, then tag and push: `git tag -a v0.2.0 -m "Strand 0.2.0" && git push origin main v0.2.0`.

The release job then also uploads the in-app update packages and `latest.json`, which installed copies read from `https://github.com/calabli/Strand/releases/latest/download/latest.json`.

Update packages are signed with the updater key; its public half is `plugins.updater.pubkey` in `tauri.conf.json`. CI signs with the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the key has no password). Without that secret, builds still succeed but contain no update packages, so installed copies won't see the release. Keep the private key safe: if it's lost, releases signed with a new key can't update copies that shipped with the old public key.

To test an update locally, point a debug build at your own `latest.json` with `STRAND_UPDATE_ENDPOINT=http://127.0.0.1:8765/latest.json` (plain http only works in debug builds).

### Performance

The targets in section 15 of the spec have been measured. To measure yourself:

```bash
mkdir /tmp/perf && cd /tmp/perf && git init -q -b main . && python3 <project>/scripts/gen_perf_repo.py 10000 5000 | git fast-import --quiet && git checkout -q -f main && git config user.name test && git config user.email t@example.com
cargo run --release -p strand-core --example perf -- /tmp/perf
```

`perf` changes the worktree and branches, so use a throwaway repository. Other examples: `--example log` (opening and reading the log), `--example log_stream` (incremental filter results), `--example blame`.

## Architecture

| Path | Contents |
| --- | --- |
| `crates/strand-core/` | The Rust core: Git reading and writing, graph layout, op log, error codes, data model. Doesn't depend on Tauri and is tested on its own |
| `src-tauri/` | The desktop shell: registers the core as Tauri commands, window and permission config |
| `src/api/` | The frontend's only way into the core: types, command wrappers, mock data for the browser preview, log paging |
| `src/components/` | UI components: toolbar, commit panel, branch tree, command palette, log view, commit details, diffs, conflict view and merge window, dialogs, menus |
| `src/i18n/` | Translations. UI text is written as `t("<Chinese source>")`; English is in `en.ts`, keyed by the Chinese text |
| `src/styles/` | Theme tokens and app styles |
| `docs/` | The user manual with screenshots and the product spec (both in Chinese; the spec has 17 sections: interaction rules, availability conditions, backend commands, data model, error codes, performance targets, acceptance criteria) |
| `prototype/` | The interactive HTML prototype (open `prototype/index.html` directly), with a smoke test: `node prototype/tests/smoke.js` |
| `design/` | Source files of the early design canvas |

Division of work: the log is read with gix; worktree status, diffs and branch lists use git2; commits, branch writes and all network operations call system git, so hooks, config and behavior match the command line. The frontend doesn't infer Git state; everything is computed by the core and returned.

Strand keeps its own data inside the repository's `.git/strand/`: the op log (`oplog.json`, with snapshot objects kept under `refs/strand/ops/`), shelf patches, changelists, favorites, conflict records and remote tag records.

To add a backend command: implement and test it in `strand-core`, add a thin wrapper in `src-tauri/src/lib.rs` and register it, then add the types and function in `src/api/types.ts` and `src/api/commands.ts`. Data model changes go into both `model.rs` and `types.ts`.

## Keyboard and accessibility

⌘K (Ctrl+K on Windows) opens the command palette to search commands, branches and commits. Other shortcuts include ⌘F to search the log, ↑ ↓ to move between commits, → ← to jump to parent and child, F2 to reword, ⌘↵ to commit, and ⌘Z / ⇧⌘Z to undo and redo; "Show shortcuts" in the palette lists them all, and the global ones can be changed under Settings › Keyboard shortcuts.

Everything can be done with the keyboard: icon buttons have accessible names matching their tooltips, rows are reachable with Tab, Shift+F10 opens context menus, and focus returns to where a dialog was opened from. Text contrast is at least 4.5:1 in both the light and dark themes.

## Known limitations

- Macs with Intel chips aren't built by CI; the macOS build is not notarized and the Windows builds are not signed.
- The shelf works on whole files.
- Undo snapshots don't include untracked files, except for the operations on untracked files themselves. Changes inside a worktree that was force-removed can't be brought back.
- Rebasing in the rebase window stops at merge commits.
- Cloning uses system Git only; authentication relies on SSH keys and credential helpers.
- Pull and merge requests can be listed and created, but not reviewed, commented on or merged inside Strand. Hosts are recognized by having "github" or "gitlab" in their name.
- Pre-commit check settings live in each repository's Git config and can't be shared through the repository.
- The graph is drawn as one SVG per row.
- The core layer's messages are in Chinese and are translated for display by template matching.
