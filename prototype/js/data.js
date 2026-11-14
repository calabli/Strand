/* Strand prototype · sample data: global state S and conflicted files */
var S = {
  view: 'history', selected: 'a41f9c2', merging: false, sheet: false, modal: null, rb: null, amend: false, hq: '', ha: '', hpath: '',
  branch: 'feature/commit-graph', cmp: '', pullMode: 'merge',
  left: true, ltab: 'commit', tab: 'log', dopen: false, hb: '', hd: '', tree: { open: true, local: true, remote: true, tags: true, wt: true },
  multi: [], dmode: 'unified', dws: false, dcur: 0, stash: [],
  tq: '', hre: false, hcase: false, hsort: false, lopt: { abs: true, merge: true, dim: true }, cgroup: false, clClosed: false, amendTo: '',
  copt: { fmt: false, check: true, sign: false }, worktrees: [],
  msgHist: ['图谱：泳道计算移到后台线程', '图谱：虚拟滚动支持 10 万条提交', '图谱：读取 commit-graph 文件加速首屏'],
  untracked: [{ path: 'notes/todo.md', lines: ['# 待办', '- 图谱：折叠线性分支', '- 差异：按词高亮'] }, { path: 'scratch/tmp.log', lines: ['layout: 12ms', 'paint: 4ms'] }],
  remotes: [{ name: 'origin/main', head: '3c9e7aa' }, { name: 'origin/feature/commit-graph', head: '7be0d15' }, { name: 'origin/release/0.4', head: 'b7702e1' }],
  tags: [{ name: 'v0.4.0', at: 'b7702e1', pushed: true }],
  branches: [
    { name: 'main', head: '3c9e7aa', lane: 0, ahead: 0, behind: 0 },
    { name: 'feature/commit-graph', head: 'a41f9c2', lane: 1, ahead: 1, behind: 2 },
    { name: 'fix/diff-ime', head: 'e52b014', lane: 2, ahead: 0, behind: 0 }
  ],
  shelf: [{ name: '调试输出', files: [{ path: 'src/debug.rs', st: 'M', hunks: [{ title: 'fn dump · 第 12 行起', lines: [[' ', 12, 12, 'pub fn dump(rows: &[Row]) {'], ['+', '', 13, '    eprintln!("rows = {}", rows.len());'], [' ', 13, 14, '}']] }] }] }],
  commits: [
    { id: 'a41f9c2', msg: '图谱：泳道计算移到后台线程', desc: '布局计算不再占用界面线程，切换分支时旧任务会被取消。', author: '林夏', time: '2 分钟前', lane: 1, parents: ['7be0d15'], unpushed: true, files: [F('src/graph/layout.rs', 'M', 9, 3), F('src/sync/log.rs', 'M', 12, 4)] },
    { id: '7be0d15', msg: '图谱：虚拟滚动支持 10 万条提交', desc: '只渲染可视区域的行，滚动时按页向核心层取数据。', author: '林夏', time: '40 分钟前', lane: 1, parents: ['91d4c6f'], files: [F('src/ui/graph_view.rs', 'M', 86, 32), F('src/ui/virtual_list.rs', 'A', 120, 0)] },
    { id: '3c9e7aa', msg: '合并分支 fix/diff-ime', desc: '合并输入法和行级暂存的两个修复。', author: '陈默', time: '1 小时前', lane: 0, parents: ['b7702e1', 'e52b014'], files: [F('src/ui/diff_view.rs', 'M', 18, 7), F('src/stage/lines.rs', 'M', 6, 2)] },
    { id: 'e52b014', msg: '修复：diff 视图中输入法候选框错位', desc: '候选框位置改为跟随光标所在行的屏幕坐标。', author: '周屿', time: '3 小时前', lane: 2, parents: ['0fa83d7'], files: [F('src/ui/diff_view.rs', 'M', 18, 7)] },
    { id: '91d4c6f', msg: '图谱：读取 commit-graph 文件加速首屏', desc: '仓库里有 commit-graph 文件时优先使用，没有时提示生成。', author: '林夏', time: '昨天', lane: 1, parents: ['b7702e1'], files: [F('src/graph/loader.rs', 'M', 54, 11), F('src/graph/mod.rs', 'M', 3, 1)] },
    { id: '0fa83d7', msg: '修复：行级暂存丢失换行符', desc: '生成补丁时保留文件原有的行尾。', author: '周屿', time: '昨天', lane: 2, parents: ['b7702e1'], files: [F('src/stage/lines.rs', 'M', 6, 2), F('tests/stage_lines.rs', 'A', 28, 0)] },
    { id: 'b7702e1', msg: '发布 0.4.0', desc: '更新版本号和更新日志。', author: '陈默', time: '3 天前', lane: 0, parents: ['5d1c9b8'], files: [F('Cargo.toml', 'M', 1, 1), F('CHANGELOG.md', 'M', 14, 0)] },
    { id: '5d1c9b8', msg: '侧边栏：仓库分组与搜索', desc: '多个仓库可以分组，支持按名称过滤。', author: '周屿', time: '4 天前', lane: 0, parents: ['c08e4f3'], files: [F('src/ui/sidebar.rs', 'M', 72, 19)] },
    { id: 'c08e4f3', msg: '状态监听改为增量刷新', desc: '文件变化时只重新计算受影响的路径。', author: '陈默', time: '5 天前', lane: 0, parents: ['2a6f7d0'], files: [F('src/watch/mod.rs', 'M', 47, 38)] },
    { id: '2a6f7d0', msg: '暂存架：支持命名和预览', desc: '搁置改动时可以起名字，展开后直接看 diff。', author: '林夏', time: '6 天前', lane: 0, parents: ['8e3b1c4'], files: [F('src/shelf/mod.rs', 'A', 133, 0)] },
    { id: '8e3b1c4', msg: '移除旧的同步日志实现', desc: '已被操作时间线取代。', author: '陈默', time: '上周', lane: 0, parents: ['f19a0b6'], files: [F('src/sync/old_log.rs', 'D', 0, 96)] },
    { id: 'f19a0b6', msg: 'diff：换用 imara-diff', desc: '大文件的差异计算明显变快。', author: '周屿', time: '上周', lane: 0, parents: [], files: [F('src/diff/engine.rs', 'M', 39, 61), F('Cargo.toml', 'M', 1, 1)] }
  ],
  timeline: [{ label: '提交 a41f9c2', time: '2 分钟前' }, { label: '提交 7be0d15', time: '40 分钟前' }, { label: '变基到 main', time: '昨天' }],
  changes: [
    { path: 'src/graph/layout.rs', st: 'M', hunks: [
      { title: 'impl LaneLayout · 第 41 行起', lines: [[' ', 41, 41, '    pub fn assign(&mut self, commits: &[Commit]) {'], ['-', 42, '', '        for c in commits {'], ['-', 43, '', '            self.place(c);'], ['-', 44, '', '        }'], ['+', '', 42, '        let batch = commits.to_vec();'], ['+', '', 43, '        let (tx, rx) = channel();'], ['+', '', 44, '        self.pool.spawn(move || {'], ['+', '', 45, '            tx.send(compute_lanes(&batch)).ok();'], ['+', '', 46, '        });'], ['+', '', 47, '        self.pending = Some(rx);'], [' ', 45, 48, '    }']] },
      { title: 'fn place · 第 88 行起', lines: [[' ', 88, 91, '    fn place(&mut self, c: &Commit) {'], [' ', 89, 92, '        let lane = self.free_lane(c);'], ['+', '', 93, '        if self.cancelled() {'], ['+', '', 94, '            return;'], ['+', '', 95, '        }'], [' ', 90, 96, '        self.rows.push(Row::new(c.id, lane));']] }
    ] },
    { path: 'src/graph/mod.rs', st: 'M', hunks: [
      { title: '模块导出 · 第 3 行起', lines: [[' ', 3, 3, 'pub mod loader;'], ['+', '', 4, 'pub mod worker;'], ['+', '', 5, 'pub use worker::compute_lanes;'], ['-', 4, '', 'pub mod  layout;'], ['+', '', 6, 'pub mod layout;']] }
    ] },
    { path: 'src/ui/graph_view.rs', st: 'M', hunks: [
      { title: 'fn poll · 第 70 行起', lines: [[' ', 70, 70, '    pub fn poll(&mut self) {'], ['-', 71, '', '        self.redraw();'], ['+', '', 71, '        if let Some(rx) = &self.layout.pending {'], ['+', '', 72, '            if let Ok(rows) = rx.try_recv() {'], ['+', '', 73, '                self.list.set_rows(rows);'], ['+', '', 74, '            }'], ['+', '', 75, '        }'], [' ', 72, 76, '    }']] }
    ] },
    { path: 'benches/graph_layout.rs', st: 'A', hunks: [
      { title: '新文件', lines: [['+', '', 1, 'use criterion::{criterion_group, criterion_main, Criterion};'], ['+', '', 2, ''], ['+', '', 3, 'fn bench_assign(c: &mut Criterion) {'], ['+', '', 4, '    c.bench_function("assign_100k", |b| b.iter(run));'], ['+', '', 5, '}']] }
    ] }
  ],
  cfile: 0, offLines: {}, offFiles: { 'benches/graph_layout.rs': true },
  msg: '图谱：后台计算完成后刷新列表\n\n轮询后台线程的结果，拿到新的行数据后再重绘。',
  cf: { file: 0, cur: 0, choice: {} }
};

var stack = [], redo = [];
var pendingScroll = null, pendingSel = null, toastTimer = null, dragName = null;

var mA = { mh: '7be0d15', mw: '林夏 · 40 分钟前', mm: '图谱：虚拟滚动支持 10 万条提交' };
var mB = { mh: 'a41f9c2', mw: '林夏 · 2 分钟前', mm: '图谱：泳道计算移到后台线程' };
var tA = { th: '6ab41c7', tw: '周屿 · 1 小时前', tm: '图谱：按范围取行' };
var tB = { th: '9d3e5b2', tw: '周屿 · 20 分钟前', tm: '图谱：调整行高和预加载行数' };
var mix = function (a, b, c) { var o = {}; [a, b, c].forEach(function (x) { for (var k in x) o[k] = x[k]; }); return o; };
var CF = [
  { path: 'src/ui/graph_view.rs', name: 'graph_view.rs', note: '2 处冲突，1 处无冲突修改', segs: [
    { ctx: ['use crate::graph::LaneLayout;', 'use crate::ui::virtual_list::VirtualList;', '', 'pub struct GraphView {', '    layout: LaneLayout,', '    list: VirtualList,', '    scroll_top: f32,', '}', '', 'impl GraphView {', '    pub fn visible_rows(&mut self, range: Range<usize>) {'] },
    mix({ id: 'c1', base: ['        let rows = self.layout.all();'], mine: ['        let rows = self.layout.visible(range);', '        self.prefetch(&rows);'], theirs: ['        let rows = self.layout.rows_in(range.clone());'] }, mA, tA),
    { ctx: ['        self.list.set_rows(rows);', '    }', '', '    pub fn on_scroll(&mut self, delta: f32) {', '        self.scroll_top = (self.scroll_top + delta).max(0.0);', '        let first = (self.scroll_top / ROW_HEIGHT) as usize;', '        let count = self.list.viewport_rows();', '        self.visible_rows(first..first + count);', '    }', '', '    pub fn select(&mut self, index: usize) {', '        self.list.set_selected(index);', '        self.ensure_visible(index);', '    }', '', '    fn ensure_visible(&mut self, index: usize) {', '        let top = index as f32 * ROW_HEIGHT;', '        if top < self.scroll_top {', '            self.scroll_top = top;', '        }', '    }', '}', ''] },
    mix({ id: 'c2', base: ['const ROW_HEIGHT: f32 = 28.0;'], mine: ['const ROW_HEIGHT: f32 = 36.0;', 'const ROW_GAP: f32 = 2.0;'], theirs: ['const ROW_HEIGHT: f32 = 32.0;', 'const OVERSCAN: usize = 8;', 'const PRELOAD_PAGES: usize = 2;'] }, mA, tB),
    { ctx: ['const LANE_WIDTH: f32 = 18.0;'] },
    mix({ id: 'n1', base: ['const DOT_RADIUS: f32 = 4.5;'], mine: null, theirs: ['const DOT_RADIUS: f32 = 5.0;'] }, mA, tB),
    { ctx: ['', 'fn lane_x(lane: usize) -> f32 {', '    12.0 + lane as f32 * LANE_WIDTH', '}'] }
  ] },
  { path: 'src/graph/layout.rs', name: 'layout.rs', note: '1 处冲突，1 处无冲突修改', segs: [
    { ctx: ['impl LaneLayout {', '    pub fn rows_in(&self, range: Range<usize>) -> Vec<Row> {'] },
    mix({ id: 'c3', base: ['        self.rows.clone()'], mine: ['        self.rows[range].to_vec()'], theirs: ['        let end = range.end.min(self.rows.len());', '        self.rows[range.start..end].to_vec()'] }, mB, tA),
    { ctx: ['    }', '', '    pub fn len(&self) -> usize {'] },
    mix({ id: 'n2', base: ['        self.rows.len()'], mine: ['        self.rows.iter().filter(|r| r.visible).count()'], theirs: null }, mB, tA),
    { ctx: ['    }', '}'] }
  ] },
  { path: 'src/sync/log.rs', name: 'sync/log.rs', note: '你修改了，对方删除了', card: { id: 'c4', title: '一边修改，一边删除', desc: '你修改了这个文件，对方把它删除了。两种结果只能选一个。', tip: '', md: '修改了 12 行，文件还在。', ml: '保留文件', td: '删除了整个文件。', tl: '删除文件', rm: '结果：保留 src/sync/log.rs，内容是你修改后的版本。', rt: '结果：删除 src/sync/log.rs。' } },
  { path: 'Cargo.lock', name: 'Cargo.lock', note: '锁文件，建议用对方的', card: { id: 'c5', title: '锁文件冲突', desc: '这个文件是自动生成的，逐行合并容易出错，所以按整个文件选择。', tip: '建议：用对方的，完成合并后重新生成。', md: '你本地生成的依赖版本。', ml: '整个文件用你的', td: '远程生成的依赖版本。', tl: '整个文件用对方的', rm: '结果：使用你本地的 Cargo.lock。', rt: '结果：使用远程的 Cargo.lock。' } }
];
var G = [];
CF.forEach(function (f, i) {
  f.ids = f.card ? [f.card.id] : f.segs.filter(function (g) { return g.id; }).map(function (g) { return g.id; });
  f.ids.forEach(function (id, j) { G.push({ file: i, idx: j, id: id }); });
});
var gIndex = function (id) { for (var i = 0; i < G.length; i++) if (G[i].id === id) return i; return -1; };

var SEG = {};
CF.forEach(function (f) { (f.segs || []).forEach(function (g) { if (g.id) SEG[g.id] = g; }); });
