# Strand

跨平台 Git 桌面客户端（暂定名），目标平台 macOS 和 Windows，技术方案为 Tauri 2 + Rust（选型依据见说明书 2.3 节）。目前能打开本地仓库、克隆远程仓库，看带图谱的日志、提交详情和文件差异，勾选文件提交，切换、新建、重命名、删除、合并分支，管理标签，抓取、拉取、推送，把当前分支变基到另一个分支之上，解决合并和变基冲突，新建和移除工作目录（git worktree），仓库变化后自动刷新。其余功能按说明书逐步实现。

## 开发

需要：Rust 1.88 以上、Node.js 20 以上、pnpm、系统 Git 2.30 以上。Windows 还需要 WebView2（Windows 10/11 一般已自带）和 Visual Studio 生成工具。

```bash
pnpm install
```

```bash
pnpm tauri dev
```

启动桌面应用（开发模式，改代码会自动重新加载）。也可以带上仓库路径直接打开：`./target/debug/strand /path/to/repo`。只改界面时可以用下面这条，在浏览器里打开 http://localhost:1420 ，不经过 Tauri，数据来自 `src/api/mock.ts`：

```bash
pnpm dev
```

```bash
pnpm test
```

运行核心层测试。`pnpm build` 做前端类型检查和构建，`pnpm tauri build` 打安装包。

在真实仓库上测打开速度：

```bash
cargo run --release -p strand-core --example log -- /path/to/repo
```

## 代码结构

| 路径 | 内容 |
| --- | --- |
| `crates/strand-core/` | 核心层（Rust）：Git 读取、图谱布局、错误码、数据结构。不依赖 Tauri，单独测试 |
| `src-tauri/` | 桌面外壳：把核心层注册成命令，窗口和权限配置 |
| `src/api/` | 前端调用核心层的唯一入口：类型定义、命令封装、浏览器预览用的示例数据、日志分页 |
| `src/components/` | 界面组件：工具栏、提交面板、分支树、分支弹窗和命令面板（共用 `Palette.tsx`）、冲突列表和三栏合并窗口（`ConflictView.tsx`）、日志列表（虚拟滚动 + 图谱）、提交详情、差异、对话框、右键菜单；`branchOps.ts` 是分支操作的规则，三个入口共用 |
| `src/styles/` | 主题变量（取自原型）和外壳样式 |

新增一个后端命令的步骤：在 `strand-core` 里实现并写测试 → 在 `src-tauri/src/lib.rs` 加薄包装并注册 → 在 `src/api/types.ts`、`commands.ts` 加类型和函数。数据结构改动要同时改 `model.rs` 和 `types.ts`。

已实现的命令：

| 命令 | 说明 |
| --- | --- |
| `git_check`、`launch_path` | 启动时检测系统 Git；读取启动参数里的仓库路径 |
| `repo_open`、`repo_state`、`repo_reload`、`repo_refresh` | 打开仓库、读状态、重新读取；`repo_refresh` 给文件监听用，引用和 HEAD 没变时不重新读取（返回 `changed`） |
| `log_query`、`log_authors` | 日志分页，子提交总在父提交前面；可按说明和哈希搜索（正则、区分大小写）、分支、作者、日期、路径过滤，可按提交时间排序，有过滤时不返回图谱；作者过滤的选项 |
| `status_get`、`diff_worktree` | 工作区改动、未跟踪文件、单个文件的工作区差异 |
| `commit_create` | 按勾选的文件或行提交，会运行钩子和签名。整文件用 `git commit --only`；有部分行时在临时索引里搭好内容再提交，没勾的行留在工作区 |
| `blame_file` | 逐行追溯（某个版本或工作区里的文件），按行号分页；5000 行、300 个提交的文件首屏约 100 ms。`cargo run --release -p strand-core --example blame -- <仓库> <文件>` 可以测耗时 |
| `branch_merge_into` | 拖拽合并：把一个分支合并到另一个本地分支，目标不是当前分支时先切换过去，整个记成一步、可以撤销 |
| `branch_rebase_plan`、`branch_rebase` | 变基前的检查（独有提交数、已推送数、有没有合并提交）；把当前分支变基到另一个分支之上，工作区改动自动收起再放回，有冲突时进入冲突解决 |
| `worktree_add`、`worktree_remove`、`repo_clone` | 新建、移除工作目录（`refs_list` 里带工作目录列表，分支带“在哪个工作目录检出”）；克隆到指定文件夹，进度走 `task_progress`，可以用 `task_cancel` 停止，失败或停止时删掉克隆了一半的内容 |
| `checks_config_get`、`checks_config_set`、`checks_run` | 提交前格式化和检查：读写仓库 Git 配置里的命令和开关（附带按仓库文件推测的建议命令）；运行一次格式化或检查，返回输出、认出的问题和格式化改动了的文件，可以用 `task_cancel` 取消 |
| `compare`、`diff_compare`、`patch_commit`、`patch_worktree`、`commit_tree`、`file_save` | 比较两个提交（两边各自的提交、有差异的文件和文件差异）；提交补丁（format-patch）和工作区补丁；某个版本的文件列表；把补丁存成文件 |
| `commit_amend` | 修订上一次提交：并入勾选的文件或行，说明为空时保留原说明，也可以只改说明；已推送时拒绝。更早的提交走 `commit_fixup` |
| `changes_discard`、`untracked_add`、`untracked_ignore`、`untracked_delete` | 丢弃改动；未跟踪文件加入版本控制、加入 .gitignore、移到废纸篓。都可以撤销（未跟踪文件的三个操作额外记下涉及的文件） |
| `commit_detail`、`diff_commit` | 提交改动的文件列表、某个文件在该提交里的差异 |
| `refs_list`、`log_locate`、`prefs_set_favorite` | 分支（带跟踪分支、领先落后、是否已合并、是否需要强制推送 `needs_force`、不能变基到它之上的原因 `rebase_block`、是否收藏 `favorite`；收藏存在 `.git/strand/favorites`，工作目录之间共用）、远程分支、标签；分支、标签或提交在（过滤后的）日志里的行号 |
| `branch_create`、`branch_switch`、`branch_rename`、`branch_delete` | 切换时工作区改动会被覆盖返回 `WORKTREE_CONFLICT`，可选先贮藏再切换；删除未合并的分支需要确认 |
| `branch_merge`、`branch_squash_message`、`merge_abort` | 已包含、快进、合并提交、压缩合并四种结果；压缩合并先弹框改说明（`branch_squash_message` 给出预填的说明，`message` 传回来）；`mode`（`branch_merge_into` 也有） 可选能快进就快进、总是生成合并提交、压缩成一个提交（先不提交地合并，有冲突照常解决，完成时去掉 MERGE_HEAD 再提交）；有冲突时停在合并状态，界面进入冲突解决 |
| `branch_checkout_remote`、`checkout_detached`、`tag_create`、`tag_delete` | 检出远程分支、检出标签或版本、轻量标签 |
| `remote_fetch`、`remote_pull`、`remote_pull_preview`、`remote_push_preview`、`remote_push`、`tag_push`、`task_cancel`、`auth_reply` | 只处理 `origin`。需要输入凭据时发 `auth_required` 事件、等 `auth_reply`（取消时操作按取消处理）；`remote_fetch` 带 `quiet` 时不问。抓取结果的 `behind` 在本地改写了已推送的提交时为 0；`refs_changed` 为假（没抓到新东西）时界面不重新读取日志，核心层重新读取时提交和引用都没变也保留过滤缓存。抓取时顺便记下远程有哪些标签；`tag_push` 推送一个标签。推送预览和推送可以带 `to`（推送到某个提交为止）。网络操作不占用仓库锁，进行中仍可浏览；进度通过 `task_progress` 事件推送，可取消；60 秒没有输出算超时。拉取支持合并和变基两种方式：界面先抓取，再用 `remote_pull_preview` 在内存里预演一遍（不改仓库），会有冲突时弹出拉取摘要面板，用户点“开始解决”后才用 `remote_pull`（`fetched` 为真，不再抓取）真正拉取；有未提交改动时先自动搁置到暂存架；推送前给出预览，强制推送用 `--force-with-lease` |
| `merge_session`、`merge_apply_file`、`merge_take_file`、`merge_finish`、`merge_skip`、`merge_abort` | 冲突解决。核心层把冲突文件切成上下文和修改块（变基时“你的/对方的”已对调）；标记、撤销、重做、稍后继续都在前端，应用文件时一次传入全部标记；完成前检查残留的冲突标记 |
| `commit_caps`、`commit_cherry_pick`、`commit_revert`、`commit_reset`、`commit_undo`、`commit_reword`、`commit_drop` | 提交操作和可用条件（说明书 5.6、5.7）。可用条件随提交详情返回，前端置灰并显示原因；日志里的提交带“未推送”标记。拣选、还原、丢弃有冲突时进入冲突解决。都记入操作日志，可以撤销 |
| `rebase_range`、`rebase_apply`、`commit_fixup` | 整理提交（交互式变基）：调整顺序、并入上一个、丢弃；Fixup / Squash Into 把提交面板里勾选的改动并入某个提交。待办列表由核心层写好交给 git，不弹编辑器；有冲突时进入冲突解决；整个整理是一个撤销步骤 |
| `stash_list`、`stash_files`、`stash_push`、`stash_apply`、`stash_drop`、`shelf_list`、`shelf_files`、`shelf_diff`、`shelf_save`、`shelf_restore`、`shelf_delete`、`shelf_rename` | 贮藏（git stash）和暂存架（补丁存在 `.git/strand/shelf/`，按文件搁置、可命名）。取回时和工作区冲突，仓库进入“取回进行中”（`unstashing`），走冲突解决流程；取回并删除的条目等冲突解决完才删。都记入操作日志，撤销取回时条目会回来 |
| `oplog_list`、`oplog_undo`、`oplog_redo` | 撤销、重做和操作时间线。写操作前后各拍一张快照（HEAD、本地分支和标签、索引树、工作区已跟踪文件的树），新建、移除工作目录和未跟踪文件的操作用 `run_op_scoped` 额外记下工作目录列表或涉及的文件。读时间线时核对最近一步改过的东西有没有在别处被改，改过就把它和更早的步骤显示为不能撤销（带原因，不写进日志）。日志存在 `.git/strand/oplog.json`，快照对象用 `refs/strand/ops/<id>` 保留。写命令返回的 `op` 是写进日志的那一条。恢复时只改这一步改过的引用和文件，别处的改动保留；同一处被外部改过时返回 `STATE_DIVERGED`；越过推送要确认（`ALREADY_PUSHED`） |
| `console_tail`、`console_clear`、事件 `console_line` | 控制台：核心层执行的 git 命令（`$`，带输出、用时、是否失败）和客户端自己的操作（`#`，如“撤销：…”），只记会改动仓库或访问网络的命令，最近 300 行，凭据打码；同样的内容写进应用日志目录（macOS 上是 `~/Library/Logs/app.strand.desktop/`，每天一个文件，保留 7 天） |
| 事件 `repo_changed` | 文件监听，`refs` 时刷新日志，`status` 时刷新提交面板和正在看的工作区差异，`stash`、`shelf` 时只刷新贮藏、暂存架列表；忽略 `.gitignore` 里的文件 |

分工：日志用 gix；工作区状态、差异、分支列表用 git2；提交、分支写操作和所有网络操作调用系统 git。

### 已知问题

- 打开仓库时只读日志结构（编号、父提交、时间），说明和作者按页读取。8.6 万提交的 git 仓库（本机发布版）：有 commit-graph 文件时打开约 135 ms；没有时约 600 ms，并在后台生成 commit-graph，下次打开就快了。用 `cargo run --release -p strand-core --example log -- <仓库>` 可以看各阶段耗时。
- 图谱的长连线折叠：子提交到父提交跨过超过 30 行的线，画 4 行后用向下的箭头收住，泳道让给别的线；到父提交上方 4 行再从箭头接回来（`EdgeKind` 的 `cut_out`、`cut_in`）。上面那个 8.6 万提交的仓库从 189 条泳道降到最宽 17 条，97% 的行在 10 条以内，布局从约 70 ms 降到约 20 ms。图谱列宽按看得见的行里最宽的那一行算，滚动时会跟着变。点箭头跳到线的另一头并选中那一行（收住处跳到父提交，接回处跳到这条线出发的子提交，线段带 `target`）；只能用鼠标点，键盘可以用 → ← 跳父提交和子提交。
- 文件监听触发的刷新先比较引用和 HEAD，没变就不重新读取日志（Strand 自己的写操作已经读过），所以提交后不会再多读一遍；重新读取时旧的行留到新的第一页回来，列表不闪。
- 冲突解决：修改块的操作栏显示引入它的提交（在这一侧的提交上 blame，取这几行里最新的那个；只删了几行的块、取回时的工作区一侧、还原的对方一侧没有，显示所在一侧的提交）；两边重命名成不同名字时合成一行“重命名”冲突，只能选用哪一边的名字；已经解决的文件（包括 Strand 打开前在命令行里解决的，按 git 记在 MERGE_MSG 里的冲突列表算）也列在冲突列表里，记录在 `.git/strand/conflicts.json`，完成或中止时清掉。没有“只看两边对比”“只看结果”两种视图；二进制和图片没有预览。标记存在本机界面的本地存储里。
- 日志过滤：8.6 万提交的仓库上搜索约 100 ms；路径过滤要在全部历史上跑一次 `git rev-list`（约 4 秒），它在后台线程里边跑边给结果：第一次查询约 170 ms 带回首批，之后界面每 300 ms 重新查一次，直到找全（`LogPage.partial`）；说明文字按块扫描，每次查询最多 150 ms。路径按回车才生效。可以用 `cargo run --release -p strand-core --example log_stream -- <仓库> <路径> [文字]` 测每次查询的用时和结果数。提交详情里单击文件仍是打开差异，按路径过滤用文件行悬停时的漏斗图标。过滤栏右边有刷新、拣选、显示选项（精确日期、本地和远程同一提交时合并标签、合并提交变灰）、整理提交、跳到提交；显示选项按用户保存。
- 分支：拖拽合并只在分支树里（拖本地或远程分支到本地分支上），提交行和分支弹窗不能拖；未推送的标签按上次抓取时记下的远程标签判断（存在 `.git/strand/remote-tags`），从没抓取过时不标记，远程删掉的标签要下次抓取才知道；改写了已推送的提交（变基、修改说明等）后，分支树显示 `↑N!`、分支弹窗写“需要强制推送”、工具栏推送角标变色，落后数和拉取角标不显示；收藏存在本机浏览器存储里，不在应用数据目录。
- 提交操作：修改说明支持最近一串未推送、非合并的提交（更早的用变基换说明，之后的提交哈希会变），已推送的不能改；合并提交不能还原；“推送到这里为止”只推送到所选提交，远程有新提交时不能用、也不能强制推送；右键菜单按说明书 12.2 分组、带图标和分支子菜单，“在浏览器中查看”只认 GitHub、GitLab、Bitbucket、Gitee、Codeberg 和 Gitea 的地址；工作区补丁按整文件生成。
- 界面细节：提交面板最上面是工具图标行（刷新、回滚、查看差异、直接搁置、创建补丁、按目录分组、展开 / 折叠），按目录分组和提交详情共用、按用户保存，未跟踪的文件不分组；工具栏有提交面板开关（角标是改动文件数），隐藏状态记在本机；提交详情的作者头像只用名字生成（不联网取头像，也不把邮箱发给第三方）；提交行一行最多 3 个引用标签，其余收成“+N”。
- 整理提交：可整理范围只按本地分支判断分叉点；整理窗口里不能改说明；含合并提交的历史不能整理。
- 暂存架和贮藏：都不含未跟踪文件；暂存架按整文件搁置，条目展开后可以看每个文件的差异（从保存的补丁里读，只读、不能行级勾选），也可以只勾选部分文件取回（剩下的另存成同名条目）；拉取前把已跟踪文件的改动自动搁置到暂存架（“拉取前自动搁置”），拉取完成或冲突解决完成、中止后放回；放回时先整条放回；整条放不回就逐个文件放回，只把有冲突（或会覆盖拉取下来的文件）的文件留在暂存架并提示。
- 撤销：普通快照不含未跟踪文件（只有未跟踪文件的三个操作额外记下涉及的文件）。注解标签对象没有额外保留。合并或变基进行中时工具栏撤销置灰。强制移除的工作目录撤销后重新检出，但里面丢掉的改动回不来。每次写操作前后各拍一次快照（工作区树从索引副本出发，只加入 git status 报告改过的文件，和重新读取同时做）；1 万提交、5000 文件的仓库上写操作在 500 ms 内。
- 远程：需要输入用户名、密码或 SSH 密钥口令时弹出输入框（git 通过 `GIT_ASKPASS`/`SSH_ASKPASS` 回连客户端，回答只给这一次 git 进程、不保存）；后台自动抓取不弹框，需要输入时直接失败。推送对话框的“同时推送标签”只推送还没推送的标签，从没抓取过时推送全部。自动抓取可以在设置里关闭，也可以调最短间隔。
- 部分克隆（`--filter=blob:none`）：看提交详情、提交里的文件差异和比较时，先把缺的文件内容一次从远程下载下来（列文件时超过 1000 个不下载）；没联网时文件列表照常，行数显示“—”，打开那个文件的差异会提示联网后再打开。
- 工作目录和克隆：新建、移除工作目录可以撤销（撤销新建时里面有没提交的改动就不能撤销）；“在 Strand 中打开”就是切换仓库；克隆只用系统 git，认证靠 SSH 密钥和凭据助手，界面里不能输入账号密码。
- 提交前检查：格式化和检查命令存在仓库的 Git 配置里（`strand.formatCommand`、`strand.checkCommand`、`strand.formatOnCommit`、`strand.checkOnCommit`），用系统 shell 在仓库根目录运行，`{files}` 换成要提交的文件；从输出里认出问题只支持几种常见格式，认不出的只显示原始输出。还不支持提交到仓库里、全队共用的配置文件。差异的左右对比里长行自动换行、不横向滚动；忽略空白只影响显示，被当成没改的行照常按勾选提交。同一修改块里只选一部分行时，结果和 git add -p 一样。
- 控制台：查询类命令（rev-parse、cherry、diff、log 等）不显示；内容只在内存里，重启后清空（日志文件里还有）；用 git2、gix 直接读写的操作没有对应的 `$` 行，只有 `#` 一行说明；所有仓库共用一个控制台，换仓库时有一行“# 打开仓库 …”。
- 图谱每行一个 SVG，没有用说明书里写的 Canvas。
- 窗口标题栏还是系统默认样式，没有按平台定制。

### 命令面板和快捷键

⌘K（Windows 上 Ctrl+K）或工具栏的搜索样式入口打开命令面板，可以搜命令、分支和提交；每条命令前面有图标（和右键菜单、详情栏用同一套）。工具栏的分支按钮打开分支弹窗，和命令面板是同一个组件：常用操作、本地和远程分支，回车进入分支的子菜单，Esc 或退格回到上一级。命令面板里的“查看快捷键”列出全部快捷键，主要有：⌘F 搜索日志、↑ ↓ 选提交、→ ← 跳到父提交和子提交、F2 修改说明、⌘↵ 提交、⌘Z / ⇧⌘Z 撤销和重做。

### 仓库列表和设置

工具栏的仓库名打开最近打开的仓库列表（搜索、切换、固定、移除、打开其他文件夹）。工具栏的齿轮图标或 ⌘, 打开设置：语言、主题、精确日期或相对时间、自动抓取和间隔、提交时加签名行、启动时打开上次的仓库。设置和仓库列表存在本机界面的本地存储里（`src/settings.ts`）。

### 性能

说明书第 15 节的指标都实测过（数字见说明书）。自己复测：

```bash
mkdir /tmp/perf && cd /tmp/perf && git init -q -b main . && python3 <项目>/scripts/gen_perf_repo.py 10000 5000 | git fast-import --quiet && git checkout -q -f main && git config user.name 测试 && git config user.email t@example.com
cargo run --release -p strand-core --example perf -- /tmp/perf
```

`perf` 会改动工作区和分支，用临时仓库。大仓库上要快的几处：工作区状态先用 `git status` 找出变化的文件再细算；操作日志的快照只处理和索引不一样的文件，写操作后的快照、重新读取日志、工作区状态同时算；分支列表的合并、变基判断用内存里的提交图；后台生成带路径过滤器的 commit-graph。

### 无障碍

所有操作都能只用键盘完成：图标按钮都有读屏用的名字（和悬停提示一致）；分支树、日志、提交面板的行都能用 Tab 到达，Shift+F10 打开右键菜单；对话框打开时焦点进到对话框里，关闭后回到打开它的地方（`src/components/focus.ts` 的 `useReturnFocus`）；冲突列表和合并窗口里处理完一处，焦点自动放到下一处。浅色和深色主题下界面文字对比度都不低于 4.5:1；颜色变量在 `src/styles/tokens.css`，红色文字用 `--danger`、红色按钮底色用 `--danger-btn`，蓝色文字用 `--accent-ink`（`--accent` 只用作底色）。

### 多语言

界面支持中文和英文，在设置或命令面板里切换（默认跟随系统）。界面文字写成 `t("中文原文")`，英文译文在 `src/i18n/en.ts`，键就是中文原文，`{0}` `{1}` 是参数。核心层返回的错误说明、操作说明等仍是中文，界面显示时用 `tr()` 按模板翻译。新增界面文字时在 `en.ts` 里补上英文；开发模式下缺少译文会在控制台提示“[i18n] 缺英文”。

## 目录

| 路径 | 内容 |
| --- | --- |
| `docs/Strand 产品说明书.md` | 产品说明书，共 17 节：交互规则、可用条件、后端命令、数据模型、错误码、性能目标、验收要点 |
| `prototype/index.html` | 可交互原型的入口页，双击用浏览器打开即可，不需要联网或启动服务 |
| `prototype/css/app.css` | 原型的全部样式（含浅色和深色主题变量） |
| `prototype/js/` | 原型脚本，按职责拆成 9 个文件，见下 |
| `prototype/tests/smoke.js` | 原型的流程测试（172 项） |
| `design/` | 设计稿画布的源文件（7 块画板 + `canvas.json`） |

## 在线版本

- 产品说明书（可编辑、可批注）：https://claude.ai/artifact/XsPZrvpCeKpTm6X7xDuCEY
- 可交互原型：https://claude.ai/artifact/CrcYxYiQLe1Cvo9V3vVeak
- 设计稿画布：https://claude.ai/artifact/6xc6WhQEa8Ne8kqWjnUpYi

## 说明

- `docs` 里的说明书是在线文档导出的副本，在线文档改动后需要重新导出。
- `design/` 里的 `.dc.html` 依赖在线画布的运行环境，直接用浏览器打开不会正常显示，要看效果请用上面的画布链接。画板还是早期布局，没有跟随原型后来的重排更新，界面以原型为准。
- 原型里的数据全部是写死的示例数据，没有连接真实的 Git 仓库。

## 原型脚本

脚本是普通的 `<script>`，共用全局作用域，按 `index.html` 里的顺序加载，顺序不能调换。没有用 ES 模块，是为了双击本地文件就能打开。

| 文件 | 内容 |
| --- | --- |
| `icons.js` | 工具函数、图标表 `IC`、图标按钮 `ib()` |
| `data.js` | 示例数据：全局状态 `S`、冲突文件 `CF` |
| `store.js` | 控制台记录、撤销重做、提示、提交和冲突的查询函数 |
| `view-log.js` | 工具栏、Git 日志、比较、追溯 |
| `view-commit.js` | 提交面板、差异、控制台、主视图 |
| `view-conflict.js` | 冲突列表、合并窗口、拉取摘要 |
| `overlays.js` | 对话框、命令面板和分支弹窗、右键菜单 |
| `actions.js` | 所有动作，即 `data-act` 对应的处理函数 |
| `main.js` | `render()`、事件绑定、启动 |

## 运行原型的流程测试

需要 Node.js。测试会按 `index.html` 里的脚本顺序加载 `js/` 下的文件：

```bash
node prototype/tests/smoke.js
```

最后一行输出 `ALL PASSED` 表示通过。
