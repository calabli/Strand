/* Strand 原型 · 对话框、命令面板和分支弹窗、右键菜单 */
function modalView() {
  var m = S.modal, body = '';
  if (m.kind === 'prompt') body = '<input id="modal-in" type="text" aria-label="' + esc(m.title) + '" value="' + esc(m.value || '') + '" autocomplete="off">';
  else if (m.kind === 'edit') body = '<textarea id="modal-in" rows="6" aria-label="' + esc(m.title) + '" spellcheck="false">' + esc(m.value || '') + '</textarea>';
  else if (m.kind === 'patch') body = '<textarea id="modal-in" rows="14" readonly aria-label="补丁内容" spellcheck="false">' + esc(m.value || '') + '</textarea>';
  else if (m.kind === 'tree') body = '<div class="blame" style="padding:6px 0">' + m.list.map(function (pth) { return '<div class="frow" style="padding:0 12px"><span style="color:var(--fg2);display:flex">' + IC.file + '</span><span class="mono grow ell">' + esc(pth) + '</span></div>'; }).join('') + '</div>';
  else if (m.kind === 'push') {
    var pb = B(), pA = anc(pb.head), plist = S.commits.filter(function (c) { return pA[c.id] && c.unpushed; }), ptags = S.tags.filter(function (t) { return !t.pushed; });
    body = '<div class="flist" style="max-height:30vh;overflow:auto"><div class="fhead"><span>要推送的提交</span><span>' + plist.length + ' 个</span></div>' +
      (plist.map(function (c) { return '<div class="frow"><span class="mono muted">' + c.id + '</span><span class="grow ell">' + esc(c.msg) + '</span></div>'; }).join('') || '<div class="muted" style="padding:4px">没有新的提交</div>') + '</div>' +
      '<label class="ck"><input type="checkbox" id="push-tags"' + (ptags.length ? '' : ' disabled') + '>同时推送标签（' + ptags.length + ' 个还没推送）</label>' +
      '<label class="ck"><input type="checkbox" id="push-force">强制推送（会覆盖远程上的提交）</label>' +
      (pb.behind ? '<div class="warnbox">远程有 ' + pb.behind + ' 个你本地没有的提交。不勾选强制推送会被拒绝，建议先拉取。</div>' : pb.force ? '<div class="warnbox">这些提交改写了已经推送过的历史，需要勾选强制推送。</div>' : '');
  }
  else if (m.kind === 'reset') {
    body = [['soft', '软重置', '提交去掉，改动放回工作区并保持勾选，可以直接重新提交。'], ['mixed', '混合重置', '提交去掉，改动放回工作区但不勾选。'], ['hard', '硬重置', '提交和改动都丢弃。']].map(function (x) {
      return '<label class="ck" style="align-items:flex-start"><input type="radio" name="rmode" id="rm-' + x[0] + '"' + (x[0] === 'mixed' ? ' checked' : '') + '><span><b>' + x[1] + '</b><br><span class="muted">' + x[2] + '</span></span></label>'; }).join('');
  }
  else if (m.kind === 'blame') {
    var prev = null;
    body = '<div class="blame">' + blameSrc(m.arg).map(function (t, i) {
      var id = blameId(i), c = commitById(id), first = id !== prev; prev = id;
      return '<div class="bl2"><button type="button" class="bg" style="border-left-color:' + (c ? AV[c.author] : 'var(--line2)') + '" data-act="blameGo" data-arg="' + id + '" aria-label="第 ' + (i + 1) + ' 行来自 ' + id + '，跳到这个提交" title="' + (c ? esc(c.msg) : '这个提交已经不在历史里') + '">' + (first ? '<span class="mono">' + id + '</span> ' + (c ? c.author + ' · ' + c.time : '') : '') + '</button><span class="n">' + (i + 1) + '</span><span class="code">' + esc(t) + '</span></div>';
    }).join('') + '</div>';
  }
  else if (m.kind === 'rebase') {
    var kept = 0;
    body = S.rb.map(function (r, i) {
      var c = commitById(r.id), sq = r.act === 'squash' && kept > 0;
      if (r.act === 'pick' || (r.act === 'squash' && !sq)) kept++;
      var tb = function (a, icon, tip, cls) { return '<button type="button" class="btn sm ib ' + cls + (r.act === a ? ' on' : '') + '" data-act="rbSet" data-arg="' + i + '|' + a + '" aria-label="' + tip + '" title="' + tip + '" aria-pressed="' + (r.act === a) + '">' + icon + '</button>'; };
      return '<div class="rbrow' + (r.act === 'drop' ? ' drop' : '') + (sq ? ' sq' : '') + '">' + ib('rbMove', i + '|-1', IC.up, '上移', '', i === 0) + ib('rbMove', i + '|1', IC.down, '下移', '', i === S.rb.length - 1) +
        tb('pick', IC.check, '保留这个提交', 'acc') + tb('squash', IC.squash, '并入上一个提交', '') + tb('drop', IC.x, '丢弃这个提交', 'x') +
        '<span class="mono muted">' + c.id + '</span><span class="grow ell">' + esc(c.msg) + '</span>' + (c.unpushed ? '' : '<span class="tag2">已推送</span>') + '</div>';
    }).join('') + '<div class="muted" style="padding-top:10px">从上到下依次应用，最上面是最早的提交。' + S.rb.length + ' 个提交整理后变成 ' + kept + ' 个。' +
      (S.rb.some(function (r) { return !commitById(r.id).unpushed; }) ? '其中有已经推送的提交，整理后需要强制推送。' : '') + '</div>';
  }
  return '<div class="sheet modal" role="dialog" aria-modal="true" aria-label="' + esc(m.title) + '"' + (m.kind === 'rebase' || m.kind === 'blame' || m.kind === 'patch' ? ' style="max-width:760px"' : '') + '><div class="pad"><h1>' + esc(m.title) + '</h1>' + (m.text ? '<span class="muted">' + esc(m.text) + '</span>' : '') + '</div>' +
    (body ? '<div style="padding:0 20px">' + body + '</div>' : '') +
    '<div class="foot" style="justify-content:flex-end">' + ib('modalCancel', '', IC.x, '取消', 'lg') + '<button type="button" id="modal-ok" class="btn ib lg ' + (m.danger ? 'x on' : 'primary') + '" data-act="modalOk" aria-label="确定" title="确定">' + IC.check + '</button></div></div>';
}
function ask(m) { S.modal = m; render(); var el = $('modal-in') || $('modal-ok'); if (el) { el.focus(); if (el.select && m.kind === 'prompt') el.select(); } }
var pal = { open: false, q: '', i: 0, list: [] };
function subOpen(name) { return function () { palOpen('branch'); pal.sub = name; palList(); }; }
function branchSubItems(name) {
  var x = branchBy(name), cur = name === S.branch, items = [{ t: '← 返回', k: name, run: function () { palOpen('branch'); } }];
  if (!x) return items;
  if (!cur) {
    items.push({ t: '检出', k: '切换到 ' + name, run: function () { act.bswitch(name); } });
    items.push({ t: '合并到当前分支', k: name + ' → ' + S.branch, run: function () { act.bmerge(name); } });
    items.push({ t: '把当前分支变基到它之上', k: '变基', run: function () { act.brebase(name); } });
    items.push({ t: '和当前分支比较', k: '比较', run: function () { act.bcmp(name); } });
  } else {
    items.push({ t: '更新（拉取）', k: '↓' + x.behind, run: function () { act.pull(); } });
    items.push({ t: '推送…', k: '↑' + x.ahead, run: function () { act.push(); } });
  }
  items.push({ t: '从它新建分支…', k: '分支', run: function () { act.bnew(x.head); } });
  items.push({ t: '只看它的提交', k: '日志', run: function () { S.hb = name; S.view = 'main'; S.tab = 'log'; render(); } });
  items.push({ t: x.fav ? '取消收藏' : '收藏', k: '★', run: function () { act.bfav(name); } });
  items.push({ t: '重命名…', k: '分支', run: function () { act.brename(name); } });
  if (!cur) items.push({ t: '删除', k: '分支', run: function () { act.bdelete(name); } });
  return items;
}
function branchItems() {
  var q = pal.q.trim().toLowerCase(), items;
  if (pal.sub) items = branchSubItems(pal.sub);
  else {
    var b = B();
    items = [
      { t: '更新项目（拉取）…', k: '↓' + b.behind, run: function () { act.pull(); } },
      { t: '提交…', k: S.changes.length + ' 个文件', run: function () { act.view('changes'); var m = $('msg'); if (m) m.focus(); } },
      { t: '推送…', k: '↑' + b.ahead, run: function () { act.push(); } },
      { t: '抓取', k: '远程', run: function () { act.fetch(); } },
      { t: '新建分支…', k: '操作', run: function () { act.bnew(''); } },
      { t: '新建工作目录…', k: '操作', run: function () { act.wtnew(); } },
      { t: '检出标签或指定版本…', k: '操作', run: function () { act.checkoutRev(); } }
    ];
    var bs = S.branches.slice().sort(function (a, c) { return (c.fav ? 1 : 0) - (a.fav ? 1 : 0); });
    bs.forEach(function (x) {
      var rm = remoteOf(x.name);
      items.push({ t: (x.fav ? '★ ' : '') + x.name + (x.name === S.branch ? '（当前）' : ''), k: (rm ? rm.name : '本地') + '  ›', run: subOpen(x.name) });
    });
    S.remotes.forEach(function (r) { items.push({ t: r.name, k: '检出为本地分支', run: function () { act.bremote(r.name); } }); });
    if (q) bs.forEach(function (x) {
      if (x.name === S.branch) return;
      items.push({ t: '把 ' + x.name + ' 合并到当前分支', k: '合并', run: function () { act.bmerge(x.name); } });
      items.push({ t: '把当前分支变基到 ' + x.name + ' 之上', k: '变基', run: function () { act.brebase(x.name); } });
      items.push({ t: '和 ' + x.name + ' 比较', k: '比较', run: function () { act.bcmp(x.name); } });
    });
  }
  return q ? items.filter(function (x) { return (x.t + ' ' + x.k).toLowerCase().indexOf(q) >= 0; }) : items;
}
function palItems() {
  if (pal.mode === 'branch') return branchItems();
  var b = B(), items = [
    { t: '转到：历史', k: '视图', run: function () { act.view('history'); } },
    { t: '转到：改动', k: '视图', run: function () { act.view('changes'); } },
    { t: S.merging ? '继续解决冲突' : '拉取 ' + b.behind + ' 个提交', k: '操作', run: function () { if (S.merging) act.view('conflict'); else act.pull(); } },
    { t: '推送 ' + b.ahead + ' 个提交', k: '操作', run: function () { act.push(); } },
    { t: '撤销上一步', k: '操作', run: function () { act.undo(); } },
    { t: '重做', k: '操作', run: function () { act.redo(); } },
    { t: '新建分支', k: '分支', run: function () { act.bnew(''); } },
    { t: '整理当前分支的提交', k: '变基', run: function () { act.rbOpen(); } }
  ];
  S.branches.forEach(function (x) { if (x.name !== S.branch) items.push({ t: '切换到 ' + x.name, k: '分支', run: function () { act.bswitch(x.name); } }); });
  if (S.merging) {
    items.push({ t: '打开冲突列表', k: '冲突', run: function () { act.view('conflict'); } });
    items.push({ t: '接受所有没有冲突的修改块', k: '冲突', run: function () { S.view = 'conflict'; act.cfAuto(); } });
  }
  S.commits.forEach(function (c) { items.push({ t: c.msg, k: c.id, mono: true, run: function () { S.view = 'main'; S.tab = 'log'; S.hq = ''; S.ha = ''; S.hpath = ''; S.selected = c.id; render(); } }); });
  var q = pal.q.trim().toLowerCase();
  return q ? items.filter(function (x) { return (x.t + ' ' + x.k).toLowerCase().indexOf(q) >= 0; }) : items.slice(0, 10);
}
function palList() {
  pal.list = palItems();
  if (pal.i >= pal.list.length) pal.i = Math.max(0, pal.list.length - 1);
  $('pal-list').innerHTML = pal.list.length ? pal.list.map(function (x, i) {
    return '<li><button type="button" class="' + (i === pal.i ? 'cur' : '') + '" data-act="palRun" data-arg="' + i + '"><span class="grow ell">' + esc(x.t) + '</span><span class="muted' + (x.mono ? ' mono' : '') + '">' + x.k + '</span></button></li>';
  }).join('') : '<li class="muted" style="padding:12px 10px">没有匹配的命令或提交</li>';
}
function palOpen(mode) {
  pal.open = true; pal.mode = mode || ''; pal.sub = ''; pal.q = ''; pal.i = 0;
  $('pal').innerHTML = '<div class="palbox" role="dialog" aria-modal="true" aria-label="命令面板"><input id="pal-in" type="text" placeholder="' + (pal.mode === 'branch' ? '搜索分支，或输入“合并”“变基”“比较”' : '输入命令，或搜索提交说明和哈希') + '" autocomplete="off" aria-label="搜索或输入命令"><ul id="pal-list"></ul><div class="hint"><span>↑↓ 选择</span><span>↵ 执行</span><span>esc 关闭</span></div></div>';
  palList(); $('pal-in').focus();
}
function palClose() { pal.open = false; $('pal').innerHTML = ''; }

/* ---------- 右键菜单 ---------- */
var ctxOpen = false;
function ctxClose() { var el = $('ctx'); if (el) el.innerHTML = ''; ctxOpen = false; }
function ctxShow(x, y, items) {
  var el = $('ctx'); if (!el) return;
  var h = items.length * 30 + 16, vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  el.innerHTML = '<div class="menu" role="menu" style="left:' + Math.max(8, Math.min(x, vw - 240)) + 'px;top:' + Math.max(8, Math.min(y, vh - h)) + 'px">' + items.map(function (it) {
    return it === '-' ? '<hr>' : '<button type="button" role="menuitem" data-act="' + it[0] + '" data-arg="' + esc(it[1]) + '"' + (it[4] ? ' disabled' : '') + '>' + it[2] + '<span class="grow">' + it[3] + '</span>' + (it[5] ? '<span class="kbd">' + it[5] + '</span>' : '') + '</button>';
  }).join('') + '</div>';
  ctxOpen = true;
}
function menuAt(e, items) {
  var x = 320, y = 160;
  try { var r = e.target.closest('[data-act]').getBoundingClientRect(); x = r.left; y = r.bottom + 4; } catch (err) {}
  ctxShow(x, y, items);
}
function childOf(id) { var k = null; S.commits.forEach(function (c) { if (c.parents.indexOf(id) >= 0 && (!k || c.parents[0] === id)) k = c; }); return k; }
function ctxItems(kind, id) {
  if (kind === 'commit') {
    var c = caps(id), cm = commitById(id), bName = S.branch, multi = S.multi && S.multi.length > 1;
    S.branches.forEach(function (x) { if (x.head === id) bName = x.name; });
    return [['copy', id, IC.copy, '复制版本号'], ['patch', id, IC.patch, '创建补丁…'], ['cpick', id, IC.pick, '拣选到当前分支', c.inCur], '-',
      ['cdetach', id, IC.go, '检出这个版本'], ['repoAt', id, IC.eye, '查看这个版本时的仓库'], ['cmpLocal', id, IC.compare, '和本地比较'], '-',
      ['creset', id, IC.reset, '把当前分支重置到这里…', !c.canReset], ['crevert', id, IC.revert, '还原这个提交', !c.inCur], ['cundo', id, IC.undo, '撤销提交…', !c.canMsg], '-',
      ['cmsg', id, IC.pencil, '修改提交说明…', !c.canMsg, 'F2'], ['cfix', id, IC.squash, 'Fixup：并入勾选的改动', !c.inChain], ['csquashInto', id, IC.squash, 'Squash Into：并入并改说明…', !c.inChain],
      ['cdrop', id, IC.trash, '丢弃提交', !c.inChain], ['msquash', '', IC.squash, '压缩选中的提交…', !multi], ['rbFrom', id, IC.list, '从这里开始交互式变基…', !c.canRb], ['pushTo', id, IC.up, '推送到这里为止…', !c.inChain], '-',
      ['bsub', bName, IC.branch, '分支 ' + bName + '  ›'], ['bnew', id, IC.plus, '新建分支…'], ['tnew', id, IC.tag, '新建标签…'], '-',
      ['goChild', id, IC.up, '跳到子提交', !childOf(id), '←'], ['goParent', id, IC.down, '跳到父提交', !cm || !cm.parents.length, '→'], '-',
      ['web', id, IC.blank, '在浏览器中查看（没有关联托管平台）', true]];
  }
  if (kind === 'branch') {
    var cur = id === S.branch;
    return [['bswitch', id, IC.go, '切换到这个分支', cur], ['bmerge', id, IC.merge, '合并到当前分支', cur], ['brebase', id, IC.list, '把当前分支变基到它之上', cur], ['bcmp', id, IC.compare, '和当前分支比较', cur], ['bfav', id, IC.star, branchBy(id).fav ? '取消收藏' : '收藏'], ['hb', id, IC.eye, S.hb === id ? '取消只看这个分支' : '只看这个分支的提交'], '-',
      ['bnew', branchBy(id).head, IC.branch, '从这里新建分支'], ['brename', id, IC.pencil, '重命名'], ['bdelete', id, IC.trash, '删除', cur]];
  }
  if (kind === 'file') {
    var idx = 0; S.changes.forEach(function (f, i) { if (f.path === id) idx = i; });
    return [['cfile', idx, IC.eye, '查看差异'], ['hpath', id, IC.list, '查看这个文件的历史'], ['blame', id, IC.blame, '逐行追溯', !blameSrc(id)], '-', ['fdiscard', id, IC.revert, '丢弃改动']];
  }
  return [];
}
