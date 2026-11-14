/* Strand prototype · all actions (handlers for data-act) */
/* ---------- Actions ---------- */
function cfGoto(gi) {
  var g = G[gi]; S.cf.file = g.file; S.cf.cur = g.idx;
  if (S.cf.open != null && !CF[g.file].card) S.cf.open = g.file;
  var f = CF[g.file];
  pendingScroll = f.card ? null : Math.max(0, buildFile(f, g.file).tops[g.idx] - 90);
  render();
}
function cfAfterMark(id) {
  var here = gIndex(id);
  if (!cfUnmarked()) S.cf.checked = false;
  render();
  if (!isDone(id)) return;
  for (var j = 1; j < G.length; j++) {
    var t = (here + j) % G.length;
    if (G[t].file === G[here].file && !isDone(G[t].id)) {
      setTimeout((function (target, from) { return function () {
        if (S.merging && S.view === 'conflict' && !S.modal && gIndex(CF[S.cf.file].ids[S.cf.cur]) === from && isDone(G[from].id) && !isDone(G[target].id)) cfGoto(target);
      }; })(t, here), 650);
      break;
    }
  }
}
function validName(n) {
  n = (n || '').trim();
  if (!n) { toast('分支名不能为空'); return null; }
  if (/\s/.test(n)) { toast('分支名里不能有空格'); return null; }
  if (branchBy(n)) { toast('已经有一个叫 ' + n + ' 的分支'); return null; }
  return n;
}
function doPush(force) {
  var b = B(), n = b.ahead, A = anc(b.head), rn = 'origin/' + b.name, found = false;
  S.remotes.forEach(function (r) { if (r.name === rn) { r.head = b.head; found = true; } });
  if (!found) S.remotes.push({ name: rn, head: b.head });
  b.ahead = 0; git('$ git push ' + (force ? '--force-with-lease ' : '') + 'origin ' + b.name);
  S.commits.forEach(function (c) { if (A[c.id]) c.unpushed = false; });
  S.timeline.unshift({ label: '推送 ' + n + ' 个提交', time: '刚刚' });
  render(); toast((force ? '已强制推送 ' : '已推送 ') + n + ' 个提交到 origin');
}
function recount(b) { var A = anc(b.head); b.ahead = S.commits.filter(function (c) { return A[c.id] && c.unpushed; }).length; }
function srcOf(c) {
  return c.src ? JSON.parse(JSON.stringify(c.src)) : c.files.map(function (f) { return { path: f.path, st: f.st === 'D' ? 'M' : f.st, hunks: [{ title: '来自提交 ' + c.id, lines: [['+', '', 1, '// ' + c.msg]] }] }; });
}
function restoreFiles(c, unchecked) {
  srcOf(c).forEach(function (f) {
    S.changes = S.changes.filter(function (x) { return x.path !== f.path; }); S.changes.push(f);
    if (unchecked) S.offFiles[f.path] = true; else delete S.offFiles[f.path];
  });
}
function rowsFrom(id) {
  var ch = localChain(), i = ch.indexOf(id);
  return i < 0 ? null : ch.slice(i).map(function (x) { return { id: x, act: 'pick' }; });
}
function applyRows(rows, label, pre, msg) {
  var b = B(), ids = {}, out = [], hadPushed = false;
  var base = commitById(rows[0].id).parents[0];
  var d = snap(label);
  if (pre) pre();
  rows.forEach(function (r) {
    var c = commitById(r.id); ids[r.id] = 1;
    if (!c.unpushed) hadPushed = true;
    if (r.act === 'drop') return;
    if (r.act === 'squash' && out.length) {
      var last = out[out.length - 1];
      c.files.forEach(function (f) { if (!last.files.some(function (x) { return x.path === f.path; })) last.files.push(f); });
      last.desc = (last.desc ? last.desc + ' ' : '') + '并入：' + c.msg + '。';
      return;
    }
    out.push({ id: newId(), msg: r.msg || c.msg, desc: c.desc, author: c.author, time: c.time, lane: c.lane, unpushed: true, files: (r.files || c.files).slice(), src: c.src });
  });
  out.forEach(function (c, i) { c.parents = [i ? out[i - 1].id : base]; });
  var at = -1;
  S.commits.forEach(function (c, i) { if (ids[c.id] && at < 0) at = i; });
  S.commits = S.commits.filter(function (c) { return !ids[c.id]; });
  out.slice().reverse().forEach(function (c, i) { S.commits.splice(at + i, 0, c); });
  b.head = out.length ? out[out.length - 1].id : base; recount(b);
  if (hadPushed) { b.behind = 0; b.force = true; }
  S.selected = b.head; S.multi = [];
  S.timeline.unshift({ label: label, time: '刚刚', depth: d });
  render(); toast(msg || (rows.length + ' 个提交整理成了 ' + out.length + ' 个'), true);
}
var act = {
  view: function (v) {
    if (v === 'conflict') { if (!S.merging) return; S.view = 'conflict'; }
    else { S.view = 'main'; if (v === 'changes') { S.left = true; S.ltab = 'commit'; } else S.tab = 'log'; }
    render();
  },
  left: function () { S.left = !S.left; render(); },
  ltab: function (t) { S.ltab = t; render(); },
  tab: function (t) { S.tab = t; render(); },
  dclose: function () { S.dopen = false; S.tab = 'log'; render(); },
  ttoggle: function (k) { S.tree[k] = !S.tree[k]; render(); },
  hb: function (n) { S.hb = S.hb === n ? '' : n; S.tab = 'log'; render(); },
  cfBack: function () { S.cf.open = null; S.cf.checked = false; render(); },
  cfApply: function () {
    var fi = S.cf.open, f = CF[fi], left = cfUnmarkedIn(fi);
    if (left) {
      S.cf.checked = true;
      for (var k = 0; k < f.ids.length; k++) if (!isDone(f.ids[k])) { cfGoto(gIndex(f.ids[k])); break; }
      toast('这个文件还有 ' + left + ' 个修改块没有标记');
      return;
    }
    S.cf.open = null; S.cf.checked = false;
    if (!cfUnmarked()) act.cfFinish(); else { render(); toast(f.path + ' 已处理完'); }
  },
  cfAcceptFile: function (arg) {
    var a = arg.split('|'), i = +a[0], v = a[1];
    snap('整个文件接受' + (v === 'mine' ? '你的' : '对方的') + '：' + CF[i].name);
    CF[i].ids.forEach(function (id) {
      var sd = sidesOf(id), c = {};
      if (sd.m) c.m = v === 'mine' ? 'a' : 'x';
      if (sd.t) c.t = v === 'theirs' ? 'a' : 'x';
      S.cf.choice[id] = c;
    });
    if (!cfUnmarked()) { S.cf.checked = false; act.cfFinish(); } else render();
  },
  pick: function (id, e) {
    var m = (S.multi && S.multi.length ? S.multi : [S.selected]).slice();
    if (e && (e.metaKey || e.ctrlKey)) {
      var i = m.indexOf(id);
      if (i >= 0) m.splice(i, 1); else m.push(id);
      if (m.length <= 1) { S.multi = []; if (m.length) S.selected = m[0]; } else S.multi = m;
    } else if (e && e.shiftKey) {
      var order = S.commits.map(function (c) { return c.id; }), a = order.indexOf(S.selected), z = order.indexOf(id);
      S.multi = a < 0 || z < 0 || a === z ? [] : order.slice(Math.min(a, z), Math.max(a, z) + 1);
    } else { S.multi = []; S.selected = id; }
    render();
  },
  mclear: function () { S.multi = []; render(); },
  mpick: function () {
    var A = anc(B().head), todo = S.commits.filter(function (c) { return S.multi.indexOf(c.id) >= 0 && !A[c.id]; }).reverse();
    if (!todo.length) return;
    var d = snap('拣选 ' + todo.length + ' 个提交');
    todo.forEach(function (c) { addCommit({ msg: c.msg, desc: '拣选自 ' + c.id + '。' + (c.desc || ''), files: c.files.slice() }); });
    S.multi = []; S.timeline.unshift({ label: '拣选 ' + todo.length + ' 个提交', time: '刚刚', depth: d });
    render(); toast('已把 ' + todo.length + ' 个提交拣选到 ' + S.branch, true);
  },
  msquash: function () {
    var ch = localChain(), sel = S.multi.slice().sort(function (a, b) { return ch.indexOf(a) - ch.indexOf(b); }), rows = rowsFrom(sel[0]);
    if (!rows) return;
    rows.forEach(function (r) { if (sel.indexOf(r.id) > 0) r.act = 'squash'; });
    applyRows(rows, '压缩 ' + sel.length + ' 个提交', null, '已把 ' + sel.length + ' 个提交压缩成一个');
  },
  mdrop: function () {
    var ch = localChain(), sel = S.multi.slice().sort(function (a, b) { return ch.indexOf(a) - ch.indexOf(b); }), rows = rowsFrom(sel[0]);
    if (!rows) return;
    rows.forEach(function (r) { if (sel.indexOf(r.id) >= 0) r.act = 'drop'; });
    applyRows(rows, '丢弃 ' + sel.length + ' 个提交', null, '已丢弃 ' + sel.length + ' 个提交');
  },
  cundo: function (id) {
    var c = commitById(id); if (!c || id !== B().head || !c.unpushed || S.merging) return;
    applyRows([{ id: id, act: 'drop' }], '撤销提交 ' + id, function () { restoreFiles(c, false); }, '已撤销提交 ' + id + '，改动放回了工作区');
  },
  cdrop: function (id) {
    var rows = rowsFrom(id); if (!rows || S.merging) return;
    rows[0].act = 'drop';
    applyRows(rows, '丢弃提交 ' + id, null, '已丢弃提交 ' + id);
  },
  cfix: function (id) {
    var rows = rowsFrom(id), c = commitById(id); if (!rows || S.merging) return;
    if (S.pendingMsg) { rows[0].msg = S.pendingMsg; S.pendingMsg = ''; }
    var picked = S.changes.filter(function (f) { return !S.offFiles[f.path]; });
    if (!picked.length) { toast('先在提交面板里勾选要并入的改动'); return; }
    var files = c.files.slice();
    picked.forEach(function (f) { var st = fileStats(f); files = files.filter(function (x) { return x.path !== f.path; }); files.push(F(f.path, f.st, st.add, st.del)); });
    rows[0].files = files;
    applyRows(rows, '把改动并入 ' + id, function () { S.changes = S.changes.filter(function (f) { return S.offFiles[f.path]; }); S.offFiles = {}; S.cfile = 0; }, '已把 ' + picked.length + ' 个文件的改动并入 ' + id);
  },
  rbFrom: function (id) {
    var chain = rbChain(), i = chain.indexOf(id);
    if (i < 0 || S.merging) return;
    S.rb = chain.slice(i).map(function (x) { return { id: x, act: 'pick' }; });
    if (S.rb.length < 2) { S.rb = null; toast('从这里开始可以整理的提交不到 2 个'); return; }
    ask({ kind: 'rebase', title: '从 ' + id + ' 开始整理提交', run: 'rbApply' });
  },
  bfav: function (n) { var x = branchBy(n); if (x) { x.fav = !x.fav; render(); } },
  bremote: function (n) {
    var r = null; S.remotes.forEach(function (x) { if (x.name === n) r = x; });
    if (!r || S.merging) return;
    var local = n.replace(/^origin\//, '');
    if (branchBy(local)) { if (local !== S.branch) act.bswitch(local); else toast('已经在 ' + local + ' 上'); return; }
    snap('检出 ' + n);
    S.branches.push({ name: local, head: r.head, lane: commitById(r.head).lane, ahead: 0, behind: 0 });
    S.branch = local; S.selected = r.head; render(); toast('已把 ' + n + ' 检出为本地分支 ' + local, true);
  },
  brebase: function (n) {
    if (S.merging || n === S.branch || !branchBy(n)) return;
    ask({ kind: 'confirm', title: '把 ' + S.branch + ' 变基到 ' + n + ' 之上？', text: '当前分支独有的提交会被改写，接在 ' + n + ' 的最新提交后面。', run: 'brebaseDo', arg: n });
  },
  brebaseDo: function (n) {
    var b = B(), onto = branchBy(n), base = anc(onto.head), ids = [], c = commitById(b.head);
    while (c && !base[c.id]) {
      if (c.parents.length !== 1) { render(); toast('当前分支上有合并提交，原型里不支持这样变基'); return; }
      ids.push(c.id); c = commitById(c.parents[0]);
    }
    if (!ids.length) { render(); toast(S.branch + ' 已经在 ' + n + ' 之上，不需要变基'); return; }
    ids.reverse();
    var d = snap('变基到 ' + n), olds = ids.map(commitById), hadPushed = olds.some(function (o) { return !o.unpushed; }), keep = {};
    S.branches.forEach(function (x) { if (x.name !== b.name) { var o = anc(x.head); for (var k in o) keep[k] = 1; } });
    S.commits = S.commits.filter(function (cm) { return ids.indexOf(cm.id) < 0 || keep[cm.id]; });
    var parent = onto.head;
    olds.forEach(function (o) { var nc = { id: newId(), msg: o.msg, desc: o.desc, author: o.author, time: o.time, lane: b.lane, parents: [parent], unpushed: true, files: o.files, src: o.src }; S.commits.unshift(nc); parent = nc.id; });
    b.head = parent; recount(b);
    if (hadPushed) { b.behind = 0; b.force = true; }
    S.selected = parent; S.timeline.unshift({ label: '变基到 ' + n, time: '刚刚', depth: d });
    render(); toast('已把 ' + olds.length + ' 个提交变基到 ' + n + ' 之上', true);
  },
  dmode: function (m) { S.dmode = m; render(); },
  dws: function () { S.dws = !S.dws; render(); },
  dnav: function (d) {
    var n = S.changes[S.cfile] ? S.changes[S.cfile].hunks.length : 0; if (!n) return;
    S.dcur = (S.dcur + (+d) + n) % n; pendingSel = 'hk' + S.dcur; render();
  },
  stash: function () {
    if (!S.changes.length) { toast('没有可以贮藏的改动'); return; }
    var h = commitById(B().head), n = S.changes.length;
    snap('贮藏 ' + n + ' 个文件');
    S.stash.unshift({ name: 'WIP on ' + S.branch + '：' + h.id + ' ' + h.msg, files: S.changes });
    S.changes = []; S.offFiles = {}; S.dopen = false; S.ltab = 'stash'; render(); toast('已贮藏 ' + n + ' 个文件的改动', true);
  },
  stashPop: function (i) { act.stashTake(i, true); },
  stashApply: function (i) { act.stashTake(i, false); },
  stashTake: function (i, drop) {
    var e = S.stash[+i]; if (!e) return;
    snap((drop ? '取回贮藏' : '应用贮藏') + '：' + e.name);
    JSON.parse(JSON.stringify(e.files)).forEach(function (f) { S.changes = S.changes.filter(function (x) { return x.path !== f.path; }); S.changes.push(f); });
    if (drop) S.stash.splice(+i, 1);
    S.ltab = 'commit'; render(); toast(drop ? '已取回贮藏的改动' : '已取回改动，贮藏里还保留着一份', true);
  },
  stashDrop: function (i) { var e = S.stash[+i]; if (!e) return; snap('丢弃贮藏'); S.stash.splice(+i, 1); render(); toast('已丢弃这条贮藏', true); },
  uadd: function (p) {
    var u = null; S.untracked.forEach(function (x) { if (x.path === p) u = x; }); if (!u) return;
    snap('把 ' + p + ' 加入版本控制');
    S.untracked = S.untracked.filter(function (x) { return x.path !== p; });
    S.changes.push({ path: p, st: 'A', hunks: [{ title: '新文件', lines: u.lines.map(function (t, i) { return ['+', '', i + 1, t]; }) }] });
    render(); toast('已把 ' + p + ' 加入版本控制', true);
  },
  uignore: function (p) { snap('忽略 ' + p); S.untracked = S.untracked.filter(function (x) { return x.path !== p; }); render(); toast('已把 ' + p + ' 加入 .gitignore', true); },
  udel: function (p) { snap('删除 ' + p); S.untracked = S.untracked.filter(function (x) { return x.path !== p; }); render(); toast('已删除 ' + p, true); },
  commitPush: function () {
    if (!act.commit()) return;
    var b = B();
    if (b.behind || b.force) toast('已提交。' + (b.behind ? '远程有新提交，先拉取再推送' : '这些提交需要强制推送，请打开推送对话框'));
    else doPush();
  },
  copy: function (id) {
    try { navigator.clipboard.writeText(id).then(function () { toast('已复制 ' + id); }, function () { toast('复制没有成功，请手动选择哈希'); }); }
    catch (e) { toast('复制没有成功，请手动选择哈希'); }
  },
  pal: function () { palOpen(); },
  bpop: function () { palOpen('branch'); },
  bsub: function (n) { palOpen('branch'); pal.sub = n; palList(); },
  htog: function (k) { S[k] = !S[k]; render(); },
  refresh: function () { render(); toast('已刷新，没有新的变化'); },
  conClear: function () { consoleLog.length = 0; render(); },
  lopt: function (a, e) {
    var o = S.lopt, it = function (k, label) { return ['loptSet', k, o[k] ? IC.check : IC.blank, label]; };
    menuAt(e, [it('abs', '显示精确日期'), it('merge', '本地和远程在同一提交时合并标签'), it('dim', '合并提交显示为灰色')]);
  },
  loptSet: function (k) { S.lopt[k] = !S.lopt[k]; render(); },
  goto: function () { ask({ kind: 'prompt', title: '跳到提交', text: '输入哈希的前几位，或者分支名、标签名。', value: '', run: 'gotoDo' }); },
  gotoDo: function (arg, val) {
    var v = (val || '').trim(), id = '';
    if (!v) { render(); return; }
    S.branches.forEach(function (x) { if (x.name === v) id = x.head; });
    S.tags.forEach(function (t) { if (t.name === v) id = t.at; });
    if (!id) S.commits.forEach(function (c) { if (!id && c.id.indexOf(v.toLowerCase()) === 0) id = c.id; });
    if (!id) { render(); toast('没有找到“' + v + '”'); return; }
    S.hq = ''; S.ha = ''; S.hb = ''; S.hd = ''; S.hpath = ''; S.multi = []; S.selected = id; S.view = 'main'; S.tab = 'log'; render();
  },
  locate: function () { S.hq = ''; S.ha = ''; S.hb = ''; S.hd = ''; S.hpath = ''; S.multi = []; S.selected = B().head; render(); },
  tall: function (v) { var on = v === '1'; ['local', 'remote', 'tags', 'wt'].forEach(function (k) { S.tree[k] = on; }); render(); },
  wtnew: function () { ask({ kind: 'prompt', title: '新建工作目录', text: '在另一个文件夹里同时检出一个分支，输入文件夹路径。', value: '../strand-app-hotfix', run: 'wtnewDo' }); },
  wtnewDo: function (arg, val) {
    var v = (val || '').trim(); if (!v) { render(); toast('路径不能为空'); return; }
    snap('新建工作目录 ' + v); S.worktrees.push({ path: v, branch: S.branch }); S.tree.wt = true; render(); toast('已新建工作目录 ' + v, true);
  },
  wtdel: function (i) { var w = S.worktrees[+i]; if (!w) return; snap('移除工作目录 ' + w.path); S.worktrees.splice(+i, 1); render(); toast('已移除工作目录 ' + w.path, true); },
  checkoutRev: function () { ask({ kind: 'prompt', title: '检出标签或指定版本', text: '输入标签名或哈希的前几位。检出后不在任何分支上。', value: S.tags.length ? S.tags[0].name : '', run: 'checkoutRevDo' }); },
  checkoutRevDo: function (arg, val) {
    var v = (val || '').trim(), id = '';
    S.tags.forEach(function (t) { if (t.name === v) id = t.at; });
    if (!id && v) S.commits.forEach(function (c) { if (!id && c.id.indexOf(v.toLowerCase()) === 0) id = c.id; });
    if (!id) { render(); toast('没有找到“' + v + '”'); return; }
    act.cdetach(id);
  },
  cdetach: function (id) {
    var c = commitById(id); if (!c || S.merging) return;
    snap('检出 ' + id);
    S.branches = S.branches.filter(function (x) { return !x.detached; });
    var n = 'HEAD@' + id;
    S.branches.push({ name: n, head: id, lane: c.lane, ahead: 0, behind: 0, detached: true });
    S.branch = n; S.selected = id; S.multi = []; render(); toast('已检出 ' + id + '，现在不在任何分支上', true);
  },
  repoAt: function (id) {
    var A = anc(id), files = {};
    S.commits.slice().reverse().forEach(function (c) { if (A[c.id]) c.files.forEach(function (f) { if (f.st === 'D') delete files[f.path]; else files[f.path] = 1; }); });
    ask({ kind: 'tree', title: '仓库内容 · ' + id, text: '这个提交时仓库里的文件（只列出历史里出现过的）。', list: Object.keys(files).sort() });
  },
  cmpLocal: function (id) {
    var h = B().head;
    if (id === h) { toast('这就是本地当前的提交' + (S.changes.length ? '，工作区另有 ' + S.changes.length + ' 个文件的改动' : '')); return; }
    S.cmp = id; S.selected = h; S.multi = []; S.view = 'main'; S.tab = 'log'; render();
  },
  patch: function (id) {
    var c = commitById(id); if (!c) return;
    var text = 'From ' + c.id + '\nFrom: ' + c.author + '\nDate: ' + dateOf(c) + '\nSubject: [PATCH] ' + c.msg + '\n\n' + (c.desc ? c.desc + '\n' : '') + '---\n' +
      c.files.map(function (f) { return 'diff --git a/' + f.path + ' b/' + f.path + '\n--- a/' + f.path + '\n+++ b/' + f.path + '\n@@ +' + f.add + ' -' + f.del + ' 行 @@'; }).join('\n');
    ask({ kind: 'patch', title: '补丁 · ' + c.id, text: '点对勾复制到剪贴板。原型里历史提交的补丁只有文件和行数，没有具体内容。', value: text, run: 'patchCopy' });
  },
  patchChanges: function () {
    var picked = S.changes.filter(function (f) { return !S.offFiles[f.path]; });
    if (!picked.length) return;
    var text = picked.map(function (f) {
      return 'diff --git a/' + f.path + ' b/' + f.path + '\n--- a/' + f.path + '\n+++ b/' + f.path + '\n' + f.hunks.map(function (h) { return '@@ ' + h.title + ' @@\n' + h.lines.map(function (l) { return l[0] + l[3]; }).join('\n'); }).join('\n');
    }).join('\n');
    ask({ kind: 'patch', title: '补丁 · 勾选的 ' + picked.length + ' 个文件', text: '点对勾复制到剪贴板。', value: text, run: 'patchCopy' });
  },
  patchCopy: function (arg, val) {
    render();
    try { navigator.clipboard.writeText(val || '').then(function () { toast('补丁已复制到剪贴板'); }, function () { toast('复制没有成功，请手动选择文本'); }); }
    catch (e) { toast('复制没有成功，请手动选择文本'); }
  },
  pushTo: function (id) {
    var b = B(), ch = localChain(), i = ch.indexOf(id);
    if (i < 0 || S.merging) return;
    if (b.behind || b.force) { toast(b.behind ? '远程有新提交，先拉取再推送' : '这些提交需要强制推送，请用推送对话框'); return; }
    ch.slice(0, i + 1).forEach(function (x) { commitById(x).unpushed = false; });
    recount(b);
    var rm = remoteOf(b.name); if (rm) rm.head = id; else S.remotes.push({ name: 'origin/' + b.name, head: id });
    git('$ git push origin ' + id + ':' + b.name);
    S.timeline.unshift({ label: '推送到 ' + id, time: '刚刚' });
    render(); toast('已推送到 ' + id + ' 为止，共 ' + (i + 1) + ' 个提交');
  },
  goParent: function (id) { var c = commitById(id || S.selected); if (c && c.parents.length && commitById(c.parents[0])) { S.multi = []; S.selected = c.parents[0]; render(); } },
  goChild: function (id) { var k = childOf(id || S.selected); if (k) { S.multi = []; S.selected = k.id; render(); } },
  csquashInto: function (id) {
    var c = commitById(id); if (!c || !rowsFrom(id)) return;
    if (!S.changes.some(function (f) { return !S.offFiles[f.path]; })) { toast('先在提交面板里勾选要并入的改动'); return; }
    ask({ kind: 'prompt', title: '并入 ' + id + ' 并修改说明', value: c.msg, run: 'csquashIntoDo', arg: id });
  },
  csquashIntoDo: function (id, val) { S.pendingMsg = (val || '').trim(); act.cfix(id); },
  cgroup: function () { S.cgroup = !S.cgroup; render(); },
  cl: function (v) { S.clClosed = v === 't' ? !S.clClosed : v === '0'; render(); },
  clAll: function () {
    var all = S.changes.length && S.changes.every(function (f) { return !S.offFiles[f.path]; });
    S.offFiles = {}; if (all) S.changes.forEach(function (f) { S.offFiles[f.path] = true; });
    render();
  },
  crollback: function () {
    var n = S.changes.filter(function (f) { return !S.offFiles[f.path]; }).length; if (!n) return;
    ask({ kind: 'confirm', title: '丢弃 ' + n + ' 个文件的改动？', text: '勾选的文件会恢复成上一次提交时的样子。可以用撤销恢复。', danger: true, run: 'crollbackDo' });
  },
  crollbackDo: function () {
    var n = S.changes.filter(function (f) { return !S.offFiles[f.path]; }).length;
    snap('回滚 ' + n + ' 个文件'); git('$ git restore <' + n + ' 个文件>');
    S.changes = S.changes.filter(function (f) { return S.offFiles[f.path]; }); S.offFiles = {}; S.cfile = 0; render(); toast('已丢弃 ' + n + ' 个文件的改动', true);
  },
  cdiff: function () { if (!S.changes.length) return; var i = 0; S.changes.forEach(function (f, k) { if (!S.offFiles[f.path] && !i) i = k; }); act.cfile(S.dopen ? S.cfile : i); },
  cshelve: function () { act.shelveDo('', '改动 · ' + (S.shelf.length + 1)); },
  msgHist: function (a, e) {
    if (!S.msgHist.length) { toast('还没有提交说明历史'); return; }
    menuAt(e, S.msgHist.slice(0, 8).map(function (m, i) { return ['msgUse', i, IC.clock, m.split('\n')[0]]; }));
  },
  msgUse: function (i) { S.msg = S.msgHist[+i] || ''; render(); var m = $('msg'); if (m) m.focus(); },
  msgGen: function () {
    var picked = S.changes.filter(function (f) { return !S.offFiles[f.path]; });
    if (!picked.length) { toast('先勾选要提交的文件'); return; }
    var add = 0, del = 0, dirs = {}, names = picked.map(function (f) { var st = fileStats(f); add += st.add; del += st.del; dirs[f.path.split('/').slice(0, -1).join('/') || '根目录'] = 1; return f.path.split('/').pop(); });
    var area = Object.keys(dirs).length === 1 ? Object.keys(dirs)[0] : Object.keys(dirs).length + ' 个目录';
    S.msg = (picked.every(function (f) { return f.st === 'A'; }) ? '新增 ' : '修改 ') + names.slice(0, 2).join('、') + (names.length > 2 ? ' 等 ' + names.length + ' 个文件' : '') + '\n\n涉及 ' + area + '，共 +' + add + ' -' + del + ' 行。';
    render(); toast('已按勾选的文件生成说明，这是按规则拼出来的，请改成你自己的话');
  },
  copt: function (a, e) {
    var o = S.copt, it = function (k, label) { return ['coptSet', k, o[k] ? IC.check : IC.blank, label]; };
    menuAt(e, [it('fmt', '提交前格式化代码'), it('check', '提交前运行检查'), it('sign', '在说明末尾加签名行（Signed-off-by）')]);
  },
  coptSet: function (k) { S.copt[k] = !S.copt[k]; render(); },
  web: function () {},
  palRun: function (i) { var x = pal.list[+i]; palClose(); if (x) x.run(); },
  undo: function () { undoTo(stack.length - 1); },
  redo: function () { redoOne(); },
  undoTo: function (d) { undoTo(+d); },
  modalCancel: function () { S.modal = null; S.rb = null; render(); },
  modalOk: function () {
    var m = S.modal, el = $('modal-in'), val = el ? el.value : undefined;
    S.modal = null;
    if (m && act[m.run]) act[m.run](m.arg, val); else render();
  },

  /* Remotes */
  fetch: function () { var b = B(); git('$ git fetch origin'); toast(b.behind ? '已抓取：远程有 ' + b.behind + ' 个新提交，可以拉取' : '已抓取：远程没有新提交'); },
  pull: function () {
    var b = B();
    if (S.merging) return;
    if (!b.behind) { toast('远程没有新提交，不需要拉取'); return; }
    if (canConflictPull()) { S.sheet = true; render(); var g = $('sheet-go'); if (g) g.focus(); return; }
    var d = snap('拉取 ' + b.behind + ' 个提交'); var n = b.behind; b.behind = 0;
    S.timeline.unshift({ label: '拉取 ' + n + ' 个提交', time: '刚刚', depth: d });
    render(); toast('已拉取 ' + n + ' 个提交', true);
  },
  push: function () {
    var b = B();
    if (S.merging) return;
    if (!b.ahead && !S.tags.some(function (t) { return !t.pushed; })) { toast('没有需要推送的提交'); return; }
    ask({ kind: 'push', title: '推送到 origin/' + S.branch, run: 'pushDo' });
  },
  pushDo: function () {
    var b = B(), fe = $('push-force'), te = $('push-tags'), force = !!(fe && fe.checked), tags = !!(te && te.checked);
    if ((b.behind || b.force) && !force) { render(); toast(b.behind ? '推送被拒绝：远程有新提交。先拉取，或者勾选强制推送' : '推送被拒绝：这些提交改写了已推送的历史，需要勾选强制推送'); return; }
    if (force) { b.behind = 0; b.force = false; }
    if (tags) S.tags.forEach(function (t) { t.pushed = true; });
    doPush(force);
  },
  sync: function () { if (B().behind) act.pull(); else act.push(); },
  sheetAbort: function () { S.sheet = false; render(); toast('已中止拉取，什么都没有改变'); },
  sheetStart: function () {
    S.sheet = false;
    var rb = S.pullMode === 'rebase' && localChain().length > 0;
    var d0 = snap((rb ? '拉取并变基 origin/' : '拉取并合并 origin/') + S.branch);
    S.merging = true; S.view = 'conflict'; S.cf = { file: 0, cur: 0, choice: {}, depth: d0, rebase: rb };
    pendingScroll = 0; render();
  },

  /* History filters, compare, blame, tags */
  hpath: function (p) { S.hpath = p || ''; S.view = 'main'; S.tab = 'log'; render(); },
  pullMode: function (m) { S.pullMode = m; render(); },
  cmp: function (id) { S.cmp = id || ''; render(); if (id) toast('已设为比较起点，再点另一个提交'); },
  bcmp: function (n) { var x = branchBy(n); if (!x) return; S.cmp = B().head; S.selected = x.head; render(); },
  blame: function (p) { ask({ kind: 'blame', title: '逐行追溯 · ' + p, text: '左边是每一行最后一次被修改的提交，点一下跳到那个提交。', arg: p }); },
  blameGo: function (id) { S.modal = null; if (commitById(id)) { S.hq = ''; S.ha = ''; S.hpath = ''; S.cmp = ''; S.selected = id; S.view = 'main'; S.tab = 'log'; } render(); },
  tnew: function (id) { ask({ kind: 'prompt', title: '在 ' + id + ' 上打标签', value: 'v0.5.0', run: 'tnewDo', arg: id }); },
  tnewDo: function (id, val) {
    var n = (val || '').trim();
    if (!n || n.indexOf(' ') >= 0) { toast('标签名不能为空，也不能有空格'); render(); return; }
    if (S.tags.some(function (t) { return t.name === n; })) { toast('已经有一个叫 ' + n + ' 的标签'); render(); return; }
    snap('新建标签 ' + n); S.tags.push({ name: n, at: id, pushed: false }); render(); toast('已在 ' + id + ' 上打标签 ' + n, true);
  },
  tpush: function (n) { S.tags.forEach(function (t) { if (t.name === n) t.pushed = true; }); render(); toast('已推送标签 ' + n); },
  tdel: function (n) { snap('删除标签 ' + n); S.tags = S.tags.filter(function (t) { return t.name !== n; }); render(); toast('已删除标签 ' + n, true); },
  cfMode: function (m) { S.cf.mode = m; render(); },
  cfSkip: function () { S.cf.skip = true; act.cfFinish(); },

  /* Commit operations */
  cpick: function (id) {
    var c = commitById(id); if (!c || S.merging) return;
    var d = snap('拣选 ' + id);
    var o = addCommit({ msg: c.msg, desc: '拣选自 ' + id + '。' + (c.desc || ''), files: c.files.slice() });
    S.timeline.unshift({ label: '拣选 ' + id, time: '刚刚', depth: d });
    render(); toast('已把 ' + id + ' 拣选到 ' + S.branch + '，新提交是 ' + o.id, true);
  },
  crevert: function (id) {
    var c = commitById(id); if (!c || S.merging) return;
    var d = snap('还原 ' + id);
    addCommit({ msg: '还原“' + c.msg + '”', desc: '撤掉 ' + id + ' 的改动。', files: c.files.map(function (f) { return F(f.path, f.st === 'A' ? 'D' : f.st === 'D' ? 'A' : 'M', f.del, f.add); }) });
    S.timeline.unshift({ label: '还原 ' + id, time: '刚刚', depth: d });
    render(); toast('已新建一个提交来还原 ' + id, true);
  },
  creset: function (id) { ask({ kind: 'reset', title: '把 ' + S.branch + ' 退回到 ' + id + '？', text: '这之后还没推送的提交会从分支上移除。选择它们的改动怎么处理：', danger: true, run: 'cresetDo', arg: id }); },
  cresetDo: function (id) {
    var b = B(), A = anc(b.head), below = anc(id), keep = {}, hard = $('rm-hard'), soft = $('rm-soft');
    var mode = hard && hard.checked ? 'hard' : soft && soft.checked ? 'soft' : 'mixed';
    var d = snap('重置到 ' + id);
    S.branches.forEach(function (x) { if (x.name !== b.name) { var o = anc(x.head); for (var k in o) keep[k] = 1; } });
    var gone = S.commits.filter(function (c) { return A[c.id] && !below[c.id]; });
    if (mode !== 'hard') gone.slice().reverse().forEach(function (c) { restoreFiles(c, mode === 'mixed'); });
    S.commits = S.commits.filter(function (c) { return !(A[c.id] && !below[c.id] && !keep[c.id]); });
    b.head = id; recount(b); S.selected = id; S.multi = [];
    S.timeline.unshift({ label: '重置到 ' + id, time: '刚刚', depth: d });
    render(); toast('已退回到 ' + id + '，移除了 ' + gone.length + ' 个提交' + (mode === 'hard' ? '，改动已丢弃' : '，改动放回了工作区'), true);
  },
  cmsg: function (id) { var c = commitById(id); ask({ kind: 'prompt', title: '修改提交说明', value: c.msg, run: 'cmsgDo', arg: id }); },
  cmsgDo: function (id, val) {
    val = (val || '').trim(); if (!val) { toast('提交说明不能为空'); render(); return; }
    snap('修改提交说明'); commitById(id).msg = val; render(); toast('已修改提交说明', true);
  },

  /* Branches */
  bnew: function (at) { ask({ kind: 'prompt', title: at ? '从 ' + at + ' 新建分支' : '从当前位置新建分支', text: '新建后会切换到这个分支。', value: 'feature/', run: 'bnewDo', arg: at || '' }); },
  bnewDo: function (at, val) {
    var n = validName(val); if (!n) { render(); return; }
    var head = at || B().head;
    snap('新建分支 ' + n);
    S.branches.push({ name: n, head: head, lane: commitById(head).lane, ahead: 0, behind: 0 });
    S.branch = n; S.selected = head; render(); toast('已新建并切换到 ' + n, true);
  },
  bswitch: function (n) {
    if (S.merging) { toast('合并还没完成，不能切换分支'); return; }
    if (!branchBy(n)) return;
    snap('切换到 ' + n); S.branches = S.branches.filter(function (x) { return !x.detached || x.name === n; }); S.branch = n; S.selected = B().head; render(); toast('已切换到 ' + n, true);
  },
  brename: function (n) { ask({ kind: 'prompt', title: '重命名分支 ' + n, value: n, run: 'brenameDo', arg: n }); },
  brenameDo: function (old, val) {
    if ((val || '').trim() === old) { render(); return; }
    var n = validName(val); if (!n) { render(); return; }
    snap('重命名分支 ' + old); branchBy(old).name = n; if (S.branch === old) S.branch = n; render(); toast('已重命名为 ' + n, true);
  },
  bdelete: function (n) { ask({ kind: 'confirm', title: '删除分支 ' + n + '？', text: '只删除分支名，提交还在。可以用撤销恢复。', danger: true, run: 'bdeleteDo', arg: n }); },
  bdeleteDo: function (n) {
    snap('删除分支 ' + n); S.branches = S.branches.filter(function (x) { return x.name !== n; }); render(); toast('已删除分支 ' + n, true);
  },
  bmerge: function (n) { act.bdrop(n + '|' + S.branch); },
  bdrop: function (arg) {
    var a = arg.split('|'); if (a[0] === a[1] || !branchBy(a[0]) || !branchBy(a[1])) return;
    if (S.merging) { toast('合并还没完成，先处理完当前的冲突'); return; }
    ask({ kind: 'confirm', title: '把 ' + a[0] + ' 合并到 ' + a[1] + '？', text: a[1] === S.branch ? '' : '会先切换到 ' + a[1] + '。', run: 'bmergeDo', arg: arg });
  },
  bmergeDo: function (arg) {
    var a = arg.split('|'), src = branchBy(a[0]), dst = branchBy(a[1]);
    if (anc(dst.head)[src.head]) { render(); toast(a[1] + ' 已经包含 ' + a[0] + ' 的全部提交'); return; }
    var d = snap('合并 ' + a[0] + ' 到 ' + a[1]);
    S.branch = a[1];
    if (anc(src.head)[dst.head]) { dst.head = src.head; S.selected = dst.head; render(); toast('已快进：' + a[1] + ' 现在指向 ' + src.head, true); }
    else {
      addCommit({ msg: '合并分支 ' + a[0], desc: '把 ' + a[0] + ' 合并到 ' + a[1] + '，没有冲突。', parents: [dst.head, src.head], files: commitById(src.head).files.slice() });
      render(); toast('已把 ' + a[0] + ' 合并到 ' + a[1], true);
    }
    S.timeline.unshift({ label: '合并 ' + a[0], time: '刚刚', depth: d }); render();
  },

  /* Interactive rebase */
  rbOpen: function () {
    if (S.merging) { toast('合并还没完成，不能整理提交'); return; }
    var chain = rbChain();
    if (chain.length < 2) { toast('当前分支上可以整理的提交不到 2 个'); return; }
    S.rb = chain.map(function (id) { return { id: id, act: 'pick' }; });
    ask({ kind: 'rebase', title: '整理 ' + S.branch + ' 的提交', run: 'rbApply' });
  },
  rbSet: function (arg) { var a = arg.split('|'); S.rb[+a[0]].act = a[1]; render(); },
  rbMove: function (arg) {
    var a = arg.split('|'), i = +a[0], j = i + (+a[1]);
    if (j < 0 || j >= S.rb.length) return;
    var t = S.rb[i]; S.rb[i] = S.rb[j]; S.rb[j] = t; render();
  },
  rbApply: function () { var rows = S.rb; S.rb = null; applyRows(rows, '整理提交'); },

  /* Changes */
  cfile: function (i) { S.cfile = +i; S.dopen = true; S.tab = 'diff'; S.view = 'main'; render(); },
  tfile: function (p) { if (S.offFiles[p]) delete S.offFiles[p]; else S.offFiles[p] = true; render(); },
  tline: function (k) { if (S.offLines[k]) delete S.offLines[k]; else S.offLines[k] = true; render(); },
  tamend: function () { S.amend = !S.amend; render(); },
  thunk: function (hi) {
    var f = S.changes[S.cfile], h = f.hunks[+hi], keys = [];
    h.lines.forEach(function (l, li) { if (l[0] !== ' ') keys.push(lineKey(f.path, +hi, li)); });
    var allOn = keys.every(function (k) { return !S.offLines[k]; });
    keys.forEach(function (k) { if (allOn) S.offLines[k] = true; else delete S.offLines[k]; });
    render();
  },
  fdiscard: function (p) {
    snap('丢弃 ' + p + ' 的改动');
    S.changes = S.changes.filter(function (f) { return f.path !== p; }); delete S.offFiles[p];
    render(); toast('已丢弃 ' + p + ' 的改动', true);
  },
  shelve: function () {
    var picked = S.changes.filter(function (f) { return !S.offFiles[f.path]; });
    if (!picked.length) { toast('至少勾选一个文件'); return; }
    ask({ kind: 'prompt', title: '把 ' + picked.length + ' 个文件搁置到暂存架', text: '起个名字，方便以后找回。', value: '暂时搁置的改动', run: 'shelveDo' });
  },
  shelveDo: function (arg, val) {
    var picked = S.changes.filter(function (f) { return !S.offFiles[f.path]; });
    snap('搁置 ' + picked.length + ' 个文件');
    S.shelf.unshift({ name: (val || '').trim() || '未命名', files: picked }); S.ltab = 'shelf';
    S.changes = S.changes.filter(function (f) { return S.offFiles[f.path]; }); S.offFiles = {}; S.cfile = 0;
    render(); toast('已搁置 ' + picked.length + ' 个文件', true);
  },
  unshelve: function (i) {
    var e = S.shelf[+i]; if (!e) return;
    snap('取回“' + e.name + '”');
    e.files.forEach(function (f) { S.changes = S.changes.filter(function (x) { return x.path !== f.path; }); S.changes.push(f); });
    S.shelf.splice(+i, 1); S.ltab = 'commit'; render(); toast('已把“' + e.name + '”取回到工作区', true);
  },
  shelfDel: function (i) {
    var e = S.shelf[+i]; if (!e) return;
    snap('删除搁置的“' + e.name + '”'); S.shelf.splice(+i, 1); render(); toast('已删除搁置的“' + e.name + '”', true);
  },
  commit: function () {
    if (S.merging) { toast('合并还没完成，先解决冲突或中止拉取'); return; }
    var b = B(), title = S.msg.split('\n')[0].trim(), desc = S.msg.split('\n').slice(1).join(' ').trim();
    var picked = S.changes.filter(function (f) { return !S.offFiles[f.path]; });
    if (!picked.length) { toast('至少勾选一个文件'); return; }
    var files = picked.map(function (f) { var st = fileStats(f); return F(f.path, f.st, st.add, st.del); });
    var d, id;
    if (S.amend) {
      var tgt = S.amendTo && localChain().indexOf(S.amendTo) >= 0 ? S.amendTo : b.head;
      if (tgt !== b.head) { S.amend = false; S.amendTo = ''; act.cfix(tgt); return true; }
      var h = commitById(b.head);
      if (!h.unpushed) { toast('上一次提交已经推送，不能修订'); return; }
      d = snap('修订 ' + h.id);
      files.forEach(function (f) { h.files = h.files.filter(function (x) { return x.path !== f.path; }); h.files.push(f); });
      if (title) { h.msg = title; h.desc = desc; }
      id = h.id; S.selected = id;
      S.timeline.unshift({ label: '修订 ' + id, time: '刚刚', depth: d });
    } else {
      if (!title) { toast('先写一句提交说明'); var m = $('msg'); if (m) m.focus(); return; }
      if (S.copt.sign) desc = (desc ? desc + ' ' : '') + 'Signed-off-by: 林夏';
      if (S.copt.fmt) git('# 提交前：格式化代码');
      if (S.copt.check) git('# 提交前：运行检查，通过');
      S.msgHist = [S.msg].concat(S.msgHist.filter(function (x) { return x !== S.msg; })).slice(0, 10);
      d = snap('提交“' + title + '”');
      id = addCommit({ msg: title, desc: desc, files: files, src: JSON.parse(JSON.stringify(picked)) }).id;
      S.timeline.unshift({ label: '提交 ' + id, time: '刚刚', depth: d });
    }
    S.changes = S.changes.filter(function (f) { return S.offFiles[f.path]; });
    S.offFiles = {}; S.cfile = 0; S.msg = ''; S.amend = false;
    S.view = 'main'; S.tab = 'log'; render();
    toast((d !== undefined && S.timeline[0].label.indexOf('修订') === 0 ? '已修订上一次提交，加入 ' : '已提交 ') + picked.length + ' 个文件', true);
    return true;
  },

  /* Conflicts */
  cfOpen: function (i) { if (CF[+i].card) return; S.cf.open = +i; S.cf.file = +i; S.cf.cur = 0; S.cf.checked = false; pendingScroll = 0; render(); },
  cfGo: function (gi) { cfGoto(+gi); },
  cfStep: function (d) {
    var f = CF[S.cf.file], n = f.ids.length;
    cfGoto(gIndex(f.ids[(Math.min(S.cf.cur, n - 1) + (+d) + n) % n]));
  },
  cfPick: function (arg) {
    var a = arg.split('|'), id = a[0], here = gIndex(id);
    snap(a[1] === 'card' ? '第 ' + (here + 1) + ' 处的选择' : (a[2] === 'a' ? '接受' : '舍弃') + (a[1] === 'm' ? '你的' : '对方的') + '修改块（第 ' + (here + 1) + ' 处）');
    var c = S.cf.choice[id] || {};
    if (a[1] === 'card') c = a[2] === 'mine' ? { m: 'a', t: 'x' } : { m: 'x', t: 'a' };
    else c[a[1]] = a[2];
    S.cf.choice[id] = c; S.cf.file = G[here].file; S.cf.cur = G[here].idx;
    cfAfterMark(id);
  },
  cfWhole: function (v) {
    snap('整个文件都接受' + (v === 'mine' ? '你的' : '对方的'));
    CF[S.cf.file].ids.forEach(function (id) {
      var s = sidesOf(id), c = {};
      if (s.m) c.m = v === 'mine' ? 'a' : 'x';
      if (s.t) c.t = v === 'theirs' ? 'a' : 'x';
      S.cf.choice[id] = c;
    });
    if (!cfUnmarked()) S.cf.checked = false;
    render();
  },
  cfAuto: function () {
    var todo = G.filter(function (g) { var s = sidesOf(g.id); return s.m !== s.t && !isDone(g.id); });
    if (!todo.length) { toast('没有需要处理的无冲突修改块'); return; }
    snap('接受所有没有冲突的修改块');
    todo.forEach(function (g) { var s = sidesOf(g.id); S.cf.choice[g.id] = s.m ? { m: 'a' } : { t: 'a' }; });
    if (!cfUnmarked()) S.cf.checked = false;
    render(); toast('已接受 ' + todo.length + ' 个没有冲突的修改块', true);
  },
  cfEdit: function (id) {
    var g = SEG[id], v = S.cf.choice[id] || {}, cur = resultOf(g, v);
    if (!cur.length) cur = g.base;
    ask({ kind: 'edit', title: '手动编辑第 ' + (gIndex(id) + 1) + ' 处的结果', text: '保存后，这一处的修改块都算已处理，结果用你写的内容。', value: cur.join('\n'), run: 'cfEditDo', arg: id });
  },
  cfEditDo: function (id, val) {
    var here = gIndex(id), s = sidesOf(id), c = { custom: (val || '').replace(/\s+$/, '').split('\n') };
    snap('手动编辑第 ' + (here + 1) + ' 处');
    if (s.m) c.m = 'x'; if (s.t) c.t = 'x';
    S.cf.choice[id] = c; S.cf.file = G[here].file; S.cf.cur = G[here].idx;
    cfAfterMark(id);
  },
  cfAbort: function () { undoTo(S.cf.depth, '已中止拉取，回到了拉取之前'); },
  cfFinish: function () {
    var left = S.cf.skip ? 0 : cfUnmarked();
    if (left) {
      S.cf.checked = true;
      for (var u = 0; u < G.length; u++) if (!isDone(G[u].id)) { cfGoto(u); break; }
      toast('还有 ' + left + ' 个修改块没有标记，每个都要选接受或舍弃');
      return;
    }
    var b = B(), rb = !!S.cf.rebase, chain = rb ? localChain() : [], olds = chain.map(commitById), at = 0, n = 0, skipped = !!S.cf.skip;
    if (rb) S.commits = S.commits.filter(function (c) { return chain.indexOf(c.id) < 0; });
    for (var i = 0; i < S.commits.length; i++) if (S.commits[i].id === '7be0d15') at = i;
    var rl = rb ? b.lane : 3;
    S.commits.splice(at, 0,
      { id: '9d3e5b2', msg: '图谱：调整行高和预加载行数', desc: '行高改为 32，并在可视区域外多渲染 8 行。', author: '周屿', time: '20 分钟前', lane: rl, parents: ['6ab41c7'], files: [F('src/ui/graph_view.rs', 'M', 3, 1), F('src/sync/log.rs', 'D', 0, 96), F('Cargo.lock', 'M', 12, 9)] },
      { id: '6ab41c7', msg: '图谱：按范围取行', desc: '新增 rows_in，范围超出时自动截断。', author: '周屿', time: '1 小时前', lane: rl, parents: ['7be0d15'], files: [F('src/graph/layout.rs', 'M', 4, 1), F('src/ui/graph_view.rs', 'M', 1, 1)] });
    if (rb) {
      var parent = '9d3e5b2';
      olds.forEach(function (c, k) {
        if (skipped && k === 0) return;
        var o = { id: newId(), msg: c.msg, desc: c.desc, author: c.author, time: c.time, lane: b.lane, parents: [parent], unpushed: true, files: c.files };
        S.commits.unshift(o); parent = o.id; n++;
      });
      b.head = parent; b.ahead = n; S.selected = parent;
    } else {
      var head = b.head;
      addCommit({ msg: '合并 origin/' + S.branch, desc: '处理了 ' + G.length + ' 处修改，涉及 ' + CF.length + ' 个文件。', parents: [head, '9d3e5b2'], files: CF.map(function (f) { return F(f.path, 'M', f.ids.length, 0); }) });
    }
    var rmt = remoteOf(b.name); if (rmt) rmt.head = '9d3e5b2';
    b.behind = 0; S.merging = false;
    stack.length = S.cf.depth + 1;
    S.timeline.unshift({ label: rb ? '拉取并变基' : '拉取并合并', time: '刚刚', depth: S.cf.depth });
    S.view = 'main'; S.tab = 'log'; render();
    toast(rb ? '变基完成：拉取了 2 个提交，你的 ' + n + ' 个提交接在它们后面' + (skipped ? '，跳过了 1 个' : '') : '合并完成，拉取了 2 个提交', true);
  }
};
