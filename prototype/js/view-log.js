/* Strand prototype · toolbar, Git log, compare, blame */
/* ---------- Toolbar ---------- */
function toolbar() {
  var b = B();
  var sync = S.merging
    ? '<button type="button" class="warn" data-act="view" data-arg="conflict">' + (S.cf.rebase ? '变基' : '合并') + '进行中 · 还有 ' + cfUnmarked() + ' 块没标记</button>'
    : '<button type="button" data-act="fetch" aria-label="抓取：只检查远程有没有新提交" title="抓取：只检查远程有没有新提交">' + IC.sync + '</button>' +
      '<button type="button" data-act="pull" aria-label="拉取 ' + b.behind + ' 个提交" title="拉取 ' + b.behind + ' 个提交">' + IC.down + '<span class="num">' + b.behind + '</span></button>' +
      '<button type="button" data-act="push" aria-label="推送 ' + b.ahead + ' 个提交" title="推送 ' + b.ahead + ' 个提交">' + IC.up + '<span class="num">' + b.ahead + '</span></button>';
  var seg = function (v, label, extra) { return '<button type="button" data-act="view" data-arg="' + v + '" aria-pressed="' + (S.view === v) + '">' + label + (extra || '') + '</button>'; };
  return '<div class="tb">' +
    '<div class="lights" aria-hidden="true"><span style="background:#FF5F57"></span><span style="background:#FEBC2E"></span><span style="background:#28C840"></span></div>' +
    '<span class="repo">strand-app</span>' +
    '<div class="capsule"><button type="button" class="bbtn mono" data-act="bpop" aria-label="分支：搜索、切换、新建" title="分支：搜索、切换、新建">' + esc(S.branch) + '<span class="chev open">' + IC.chev + '</span></button>' + sync + '</div>' +
    '<button type="button" class="btn' + (S.left ? ' on' : '') + '" style="margin-left:auto" data-act="left" aria-pressed="' + !!S.left + '" aria-label="显示或隐藏提交面板" title="显示或隐藏提交面板（' + S.changes.length + ' 个文件有改动）">' + IC.panel + '<span class="num">' + S.changes.length + '</span></button>' +
    ib('undo', '', IC.undo, '撤销上一步', 'lg', !stack.length) + ib('redo', '', IC.redo, '重做', 'lg', !redo.length) +
    '<button type="button" class="btn search" data-act="pal">' + IC.find + '<span>搜索或输入命令</span><span>⌘K</span></button>' +
    '</div>';
}

/* ---------- History ---------- */
function remoteOf(name) { for (var i = 0; i < S.remotes.length; i++) if (S.remotes[i].name === 'origin/' + name) return S.remotes[i]; return null; }
function refsOf(c) {
  var r = '', used = {};
  S.branches.forEach(function (x) {
    if (x.head !== c.id) return;
    var rm = remoteOf(x.name), both = S.lopt.merge && rm && rm.head === c.id;
    if (both) used[rm.name] = 1;
    r += '<span class="ref ' + (x.name === S.branch ? 'head' : 'loc') + '">' + (both ? 'origin & ' : '') + esc(x.name) + '</span>';
  });
  S.remotes.forEach(function (rm) { if (rm.head === c.id && !used[rm.name]) r += '<span class="ref">' + esc(rm.name) + '</span>'; });
  S.tags.forEach(function (t) { if (t.at === c.id) r += '<span class="ref tag">' + esc(t.name) + '</span>'; });
  return r;
}
function tsOf(c) {
  var t = c.time, m, j = parseInt(c.id.slice(0, 3), 16) || 0;
  if (t === '刚刚') return 0;
  if ((m = /(\d+) 分钟前/.exec(t))) return +m[1];
  if ((m = /(\d+) 小时前/.exec(t))) return m[1] * 60;
  if (t === '昨天') return 1440 + j % 300;
  if ((m = /(\d+) 天前/.exec(t))) return m[1] * 1440 + j % 300;
  return 10080 + j % 2000;
}
function dateOf(c) {
  var d = new Date(Date.UTC(2026, 10, 12, 10, 0) - tsOf(c) * 60000), z = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + z(d.getUTCHours()) + ':' + z(d.getUTCMinutes());
}
function matchQ(c) {
  var raw = S.hq.trim(); if (!raw) return true;
  var text = c.msg + ' ' + c.id + ' ' + (c.desc || '');
  if (S.hre) { try { return new RegExp(raw, S.hcase ? '' : 'i').test(text); } catch (e) { return false; } }
  return S.hcase ? text.indexOf(raw) >= 0 : text.toLowerCase().indexOf(raw.toLowerCase()) >= 0;
}
function groupRows(paths, rows) {
  if (!S.cgroup) return rows.join('');
  var order = [], by = {};
  paths.forEach(function (pth, i) { var d = pth.indexOf('/') >= 0 ? pth.slice(0, pth.lastIndexOf('/')) : '（根目录）'; if (!by[d]) { by[d] = []; order.push(d); } by[d].push(rows[i]); });
  return order.map(function (d) { return '<div class="dirh mono">' + IC.folder + esc(d) + '</div>' + by[d].join(''); }).join('');
}
function graphSvg() {
  var row = {}, p = '', d = '', head = B().head;
  S.commits.forEach(function (c, i) { row[c.id] = i; });
  var y = function (i) { return i * RH + RH / 2; };
  S.commits.forEach(function (c, i) {
    var x1 = LX[c.lane], y1 = y(i);
    if (!c.parents.length) p += '<path d="M' + x1 + ' ' + y1 + 'V' + (S.commits.length * RH) + '" stroke="var(--l' + c.lane + ')" stroke-width="2" fill="none"/>';
    c.parents.forEach(function (pid, k) {
      if (row[pid] === undefined) return;
      var pc = S.commits[row[pid]], x2 = LX[pc.lane], y2 = y(row[pid]), path, col;
      if (x1 === x2) { path = 'M' + x1 + ' ' + y1 + 'V' + y2; col = c.lane; }
      else if (k === 0) { path = 'M' + x1 + ' ' + y1 + 'V' + (y2 - RH) + 'C' + x1 + ' ' + (y2 - 10) + ' ' + x2 + ' ' + (y2 - 26) + ' ' + x2 + ' ' + y2; col = c.lane; }
      else { path = 'M' + x1 + ' ' + y1 + 'C' + x1 + ' ' + (y1 + 26) + ' ' + x2 + ' ' + (y1 + 10) + ' ' + x2 + ' ' + (y1 + RH) + 'V' + y2; col = pc.lane; }
      p += '<path d="' + path + '" stroke="var(--l' + col + ')" stroke-width="2" fill="none"/>';
    });
    d += c.id === head
      ? '<circle cx="' + x1 + '" cy="' + y1 + '" r="5.5" fill="var(--win)" stroke="var(--l' + c.lane + ')" stroke-width="3"/>'
      : '<circle cx="' + x1 + '" cy="' + y1 + '" r="4.5" fill="var(--l' + c.lane + ')" stroke="var(--win)" stroke-width="2"/>';
  });
  return '<svg aria-hidden="true" width="84" height="' + S.commits.length * RH + '">' + p + d + '</svg>';
}
function ageOf(t) { if (/分钟|小时|刚刚/.test(t)) return 0; if (t === '昨天') return 1; var m = /(\d+) 天前/.exec(t); return m ? +m[1] : 7; }
function caps(id) {
  var b = B(), A = anc(b.head), below = anc(id), c = commitById(id), isHead = id === b.head, inCur = !!A[id];
  return { inChain: localChain().indexOf(id) >= 0, canRb: !isHead && rbChain().indexOf(id) >= 0, inCur: inCur, canReset: inCur && !isHead && Object.keys(A).every(function (x) { return below[x] || commitById(x).unpushed; }), canMsg: isHead && !!(c && c.unpushed) };
}
function multiView() {
  var ch = localChain(), A = anc(B().head), sel = S.multi.slice();
  var idx = sel.map(function (id) { return ch.indexOf(id); }).sort(function (a, b) { return a - b; });
  var inChain = idx[0] >= 0, contiguous = inChain && idx[idx.length - 1] - idx[0] === idx.length - 1, anyNew = sel.some(function (id) { return !A[id]; });
  return '<aside class="detail" aria-label="多选的提交"><div style="display:flex;align-items:flex-start;gap:8px"><div class="grow"><h1>已选 ' + sel.length + ' 个提交</h1><p>按住 ⌘ 或 Ctrl 点提交可以加选，按住 Shift 可以选一段。</p></div>' + ib('mclear', '', IC.x, '取消多选') + '</div>' +
    '<div class="acts2">' + ib('mpick', '', IC.pick, anyNew ? '把选中的提交都拣选到当前分支' : '拣选：当前分支已经包含这些提交', '', !anyNew) +
    ib('msquash', '', IC.squash, contiguous ? '把选中的提交压缩成一个' : '压缩：需要是当前分支上相邻且还没推送的提交', '', !contiguous) +
    ib('mdrop', '', IC.trash, inChain ? '丢弃选中的提交' : '丢弃：只能丢弃当前分支上还没推送的提交', 'x', !inChain) + '</div>' +
    '<div class="flist"><div class="fhead"><span>选中的提交</span><span>' + sel.length + ' 个</span></div>' + S.commits.filter(function (c) { return sel.indexOf(c.id) >= 0; }).map(function (c) {
      return '<div class="frow"><span class="mono muted">' + c.id + '</span><span class="grow ell">' + esc(c.msg) + '</span>' + (c.unpushed ? '<span class="muted" style="font-size:11px">未推送</span>' : '') + '</div>'; }).join('') + '</div></aside>';
}
function logPane() {
  var q = S.hq.trim().toLowerCase(), hp = S.hpath.trim().toLowerCase(), hbB = S.hb ? branchBy(S.hb) : null, reach = hbB ? anc(hbB.head) : null;
  var filtered = !!(q || S.ha || hp || reach || S.hd || S.hsort), T = S.tree;
  var list = S.commits.filter(function (c) {
    return matchQ(c) && (!S.ha || c.author === S.ha) &&
      (!hp || c.files.some(function (f) { return f.path.toLowerCase().indexOf(hp) >= 0; })) && (!reach || reach[c.id]) && (!S.hd || ageOf(c.time) <= +S.hd);
  });
  if (S.hsort) list = list.slice().sort(function (a, b) { return tsOf(a) - tsOf(b); });
  var sel = commitById(S.selected) || S.commits[0], multiOn = S.multi && S.multi.length > 1;
  var rows = list.map(function (c) {
    return '<button type="button" class="crow' + (filtered ? ' flat' : '') + (S.lopt.abs ? ' abs' : '') + (S.lopt.dim && c.parents.length > 1 ? ' mrg' : '') + (multiOn ? (S.multi.indexOf(c.id) >= 0 ? ' msel' : '') : (c.id === sel.id ? ' sel' : '')) + '" data-act="pick" data-arg="' + c.id + '" data-ctx="commit" data-id="' + c.id + '">' +
      '<span class="msg">' + refsOf(c) + '<span class="ell">' + esc(c.msg) + '</span>' + (c.unpushed ? '<span class="sub" style="font-size:11px">未推送</span>' : '') + '</span>' +
      '<span class="sub au">' + c.author + '</span><span class="sub num" style="text-align:right">' + (S.lopt.abs ? dateOf(c) : c.time) + '</span></button>';
  }).join('') || '<div class="empty">没有符合条件的提交</div>';
  var tl = S.timeline.slice(0, 5).map(function (t) {
    return t.depth === undefined || t.depth >= stack.length
      ? '<span class="pill">' + esc(t.label) + ' · ' + t.time + '</span>'
      : '<button type="button" class="pill" data-act="undoTo" data-arg="' + t.depth + '" title="回到这一步之前">' + IC.undo + esc(t.label) + ' <span class="muted">· ' + t.time + '</span></button>';
  }).join('');
  var grp = function (key, label, extra) {
    return '<div class="tgrp"><button type="button" class="thead grow" data-act="ttoggle" data-arg="' + key + '" aria-expanded="' + !!T[key] + '"><span class="chev' + (T[key] ? ' open' : '') + '">' + IC.chev + '</span>' + label + '</button>' + (extra || '') + '</div>';
  };
  var tq = (S.tq || '').trim().toLowerCase(), hit = function (n) { return !tq || n.toLowerCase().indexOf(tq) >= 0; };
  var selB = S.hb && S.hb !== S.branch && branchBy(S.hb) ? S.hb : '';
  var branches = S.branches.filter(function (x) { return hit(x.name); }).map(function (x) {
    var cur = x.name === S.branch;
    return '<div class="item mono brow' + (S.hb === x.name ? ' cur' : '') + '" draggable="true" data-branch="' + esc(x.name) + '" data-ctx="branch" data-id="' + esc(x.name) + '" title="点一下只看这个分支，双击切换，拖到另一个分支上合并，右键有更多操作">' +
      '<button type="button" class="tgo grow ell"' + (cur ? ' style="font-weight:700"' : '') + ' data-act="hb" data-arg="' + esc(x.name) + '"><span class="dot" style="display:inline-block;margin-right:8px;background:var(--l' + x.lane % 4 + ')"></span>' + (x.fav ? '★ ' : '') + esc(x.name) + '</button>' +
      (cur ? '<span class="tag2 ok">当前</span>' : '') +
      '<span class="acts">' + (cur ? '' : ib('bswitch', x.name, IC.go, '切换到这个分支') + ib('bmerge', x.name, IC.merge, '把它合并到当前分支') + ib('bcmp', x.name, IC.compare, '和当前分支比较')) + ib('bfav', x.name, IC.star, x.fav ? '取消收藏' : '收藏这个分支', x.fav ? 'on' : '') + '</span></div>';
  }).join('');
  var tags = S.tags.filter(function (t) { return hit(t.name); }).map(function (t) {
    return '<div class="item mono tagrow"><button type="button" class="tgo grow ell" data-act="pick" data-arg="' + t.at + '" title="跳到这个标签所在的提交">' + esc(t.name) + '</button><span class="acts">' + (t.pushed ? '' : ib('tpush', t.name, IC.up, '推送这个标签')) + ib('tdel', t.name, IC.trash, '删除这个标签', 'x') + '</span></div>';
  }).join('') || '<div class="item muted" style="padding-left:24px">还没有标签</div>';
  var c = caps(sel.id);
  var acts = ib('cpick', sel.id, IC.pick, c.inCur ? '拣选：当前分支已经包含这个提交' : '拣选：把这个提交复制到当前分支', '', c.inCur) +
    ib('crevert', sel.id, IC.revert, c.inCur ? '还原：新建一个提交，撤掉它的改动' : '还原：只能还原当前分支上的提交', '', !c.inCur) +
    ib('creset', sel.id, IC.reset, c.canReset ? '重置：把当前分支退回到这个提交' : '重置：只能退回到还没推送的提交之前', 'x', !c.canReset) +
    ib('cmsg', sel.id, IC.pencil, c.canMsg ? '修改这个提交的说明' : '修改说明：只能改最新且还没推送的提交', '', !c.canMsg) +
    ib('bnew', sel.id, IC.branch, '从这个提交新建分支') + ib('tnew', sel.id, IC.tag, '在这个提交上打标签') +
    ib('cmp', sel.id, IC.compare, '设为比较的起点，然后点另一个提交') +
    ib('cundo', sel.id, IC.undo, c.canMsg ? '撤销提交：去掉这个提交，改动放回工作区' : '撤销提交：只能撤销最新且还没推送的提交', '', !c.canMsg) +
    ib('cdrop', sel.id, IC.trash, c.inChain ? '丢弃这个提交和它的改动' : '丢弃提交：只能丢弃当前分支上还没推送的提交', 'x', !c.inChain) +
    ib('cfix', sel.id, IC.squash, c.inChain ? '把提交面板里勾选的改动并入这个提交' : '并入改动：只能并入当前分支上还没推送的提交', '', !c.inChain) +
    ib('rbFrom', sel.id, IC.list, c.canRb ? '从这个提交开始整理（交互式变基）' : '从这里整理：这个提交不在当前分支可整理的范围内', '', !c.canRb);
  var cmpOn = S.cmp && S.cmp !== sel.id && commitById(S.cmp);
  var opt = function (v, label, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(label) + '</option>'; };
  var fileRow = function (f) {
    return '<div style="display:flex;align-items:center;gap:4px"><button type="button" class="frow grow" data-act="hpath" data-arg="' + esc(f.path) + '" title="只看改过这个文件的提交"><span class="st ' + f.st + '">' + f.st + '</span><span class="mono grow ell">' + esc(S.cgroup ? f.path.split('/').pop() : f.path) + '</span><span class="mono plus">+' + f.add + '</span><span class="mono minus">-' + f.del + '</span></button>' + (blameSrc(f.path) ? ib('blame', f.path, IC.blame, '逐行追溯：每一行最后是谁改的') : '') + '</div>';
  };
  var detail = multiOn ? multiView() : cmpOn ? cmpView(S.cmp, sel.id) : '<aside class="detail split" aria-label="提交详情">' +
    '<div class="dtop"><div class="fhead" style="align-items:center"><span>改动文件 · ' + sel.files.length + ' 个</span><span style="display:flex;gap:4px">' + ib('cgroup', '', IC.folder, S.cgroup ? '取消按目录分组' : '按目录分组', S.cgroup ? 'on' : '') +
    ib('cmpLocal', sel.id, IC.compare, '和本地当前版本比较') + ib('patch', sel.id, IC.patch, '创建补丁') + ib('repoAt', sel.id, IC.eye, '查看这个版本时的整个仓库') + '</span></div>' +
    groupRows(sel.files.map(function (f) { return f.path; }), sel.files.map(fileRow)) + '</div>' +
    '<div class="dbot"><div><h1>' + esc(sel.msg) + '</h1><p>' + esc(sel.desc || '') + '</p></div>' +
    '<div class="who"><span class="av" aria-hidden="true" style="background:' + (AV[sel.author] || 'var(--l3)') + '">' + sel.author.charAt(0) + '</span><div class="grow"><div style="font-weight:600">' + sel.author + '</div><div class="muted num" style="font-size:12px">' + dateOf(sel) + ' · ' + sel.time + '</div></div>' +
    '<button type="button" class="btn sm mono" data-act="copy" data-arg="' + sel.id + '" aria-label="复制提交哈希" title="复制提交哈希">' + sel.id + '</button></div>' +
    '<div class="acts2">' + acts + '</div></div></aside>';
  return '<div class="log">' +
    (T.open ? '<aside class="tree"><div class="tbar">' + ib('bnew', '', IC.plus, '新建分支') + ib('pull', '', IC.down, '更新当前分支（拉取）') + ib('bdelete', selB, IC.trash, selB ? '删除选中的分支 ' + selB : '删除：先在右边点选一个不是当前分支的分支', 'x', !selB) +
      ib('bcmp', selB, IC.compare, selB ? '把 ' + selB + ' 和当前分支比较' : '比较：先在右边点选一个分支', '', !selB) + ib('fetch', '', IC.sync, '抓取所有远程') + ib('bfav', S.hb || S.branch, IC.star, '收藏或取消收藏选中的分支') +
      ib('locate', '', IC.target, '定位到当前分支的最新提交') + ib('tall', '1', IC.expand, '全部展开') + ib('tall', '0', IC.collapse, '全部折叠') + '</div><div class="tcol">' +
      '<label class="fld" style="height:26px">' + IC.find + '<input id="tq" type="text" style="width:100%" placeholder="分支或标签" aria-label="搜索分支或标签" value="' + esc(S.tq) + '"></label>' +
      '<div class="item mono brow' + (S.hb === S.branch ? ' cur' : '') + '"><button type="button" class="tgo grow ell" style="padding-left:6px;font-weight:700" data-act="hb" data-arg="' + esc(S.branch) + '" title="只看当前分支的提交">HEAD（当前分支）</button></div>' +
      grp('local', '本地', ib('bnew', '', IC.plus, '从当前位置新建分支')) + (T.local ? branches : '') +
      grp('remote', '远程') + (T.remote ? S.remotes.filter(function (r) { return hit(r.name); }).map(function (r) { return '<div class="item mono tagrow"><span class="grow ell" style="padding-left:16px">' + esc(r.name) + '</span><span class="acts">' + ib('bremote', r.name, IC.go, '检出为本地分支') + '</span></div>'; }).join('') : '') +
      grp('tags', '标签', ib('tnew', sel.id, IC.plus, '在选中的提交上打标签')) + (T.tags ? tags : '') +
      grp('wt', '工作目录', ib('wtnew', '', IC.plus, '新建工作目录')) + (T.wt ? (S.worktrees.map(function (w, i) { return '<div class="item mono tagrow"><span class="grow ell" style="padding-left:16px" title="' + esc(w.path) + '">' + esc(w.path) + ' <span class="muted">· ' + esc(w.branch) + '</span></span><span class="acts">' + ib('wtdel', i, IC.trash, '移除这个工作目录', 'x') + '</span></div>'; }).join('') || '<div class="item muted" style="padding-left:24px">只有主工作目录</div>') : '') +
      '</div></aside>' : '') +
    '<div class="lmid"><div class="bar2">' + ib('ttoggle', 'open', IC.branch, '显示或隐藏分支树', 'lg' + (T.open ? ' on' : '')) +
      '<label class="fld">' + IC.find + '<input id="hq" type="text" placeholder="说明或哈希" aria-label="搜索提交说明或哈希" value="' + esc(S.hq) + '"><button type="button" class="tgl' + (S.hre ? ' on' : '') + '" data-act="htog" data-arg="hre" aria-pressed="' + !!S.hre + '" aria-label="按正则表达式搜索" title="按正则表达式搜索">.*</button><button type="button" class="tgl' + (S.hcase ? ' on' : '') + '" data-act="htog" data-arg="hcase" aria-pressed="' + !!S.hcase + '" aria-label="区分大小写" title="区分大小写">Cc</button></label>' +
      '<select id="hb" aria-label="按分支过滤">' + opt('', '所有分支', S.hb) + S.branches.map(function (x) { return opt(x.name, x.name, S.hb); }).join('') + '</select>' +
      '<select id="ha" aria-label="按作者过滤">' + opt('', '所有作者', S.ha) + ['林夏', '周屿', '陈默'].map(function (a) { return opt(a, a, S.ha); }).join('') + '</select>' +
      '<select id="hd" aria-label="按日期过滤">' + opt('', '所有日期', S.hd) + opt('0', '今天', S.hd) + opt('3', '最近 3 天', S.hd) + opt('6', '最近 6 天', S.hd) + '</select>' +
      '<label class="fld">' + IC.file + '<input id="hp" type="text" style="width:110px" placeholder="路径" aria-label="按文件路径过滤" value="' + esc(S.hpath) + '"></label>' +
      (S.cmp ? '<span class="pill">' + IC.compare + '比较起点 <span class="mono">' + S.cmp + '</span>' + ib('cmp', '', IC.x, '结束比较') + '</span>' : '') +
      '<span class="grow"></span>' + ib('htog', 'hsort', IC.sort, S.hsort ? '正在按时间排序，点一下恢复按图谱顺序' : '按提交时间排序', S.hsort ? 'on' : '') + ib('refresh', '', IC.sync, '刷新日志') +
      ib('cpick', sel.id, IC.pick, c.inCur ? '拣选：当前分支已经包含选中的提交' : '把选中的提交拣选到当前分支', '', c.inCur) + ib('lopt', '', IC.eye, '显示选项') + ib('goto', '', IC.find, '跳到指定的哈希、分支或标签') +
      ib('rbOpen', '', IC.list, '整理当前分支的提交（交互式变基）') + '</div>' +
      '<div class="scroll"><div class="graph">' + (filtered ? '' : graphSvg()) + rows + '</div></div>' +
      '<div class="strip"><h2>操作时间线</h2>' + tl + '</div></div>' + detail + '</div>';
}
function cmpView(aId, bId) {
  var A = anc(aId), Bn = anc(bId), files = {}, names = [];
  var onlyB = S.commits.filter(function (c) { return Bn[c.id] && !A[c.id]; }), onlyA = S.commits.filter(function (c) { return A[c.id] && !Bn[c.id]; });
  onlyA.concat(onlyB).forEach(function (c) { c.files.forEach(function (f) { if (!files[f.path]) names.push(f.path); files[f.path] = f; }); });
  var li = function (list) {
    return list.map(function (c) { return '<button type="button" class="frow" data-act="pick" data-arg="' + c.id + '"><span class="mono muted">' + c.id + '</span><span class="grow ell">' + esc(c.msg) + '</span></button>'; }).join('') || '<div class="muted" style="padding:4px">没有</div>';
  };
  return '<aside class="detail" aria-label="比较结果"><div style="display:flex;align-items:flex-start;gap:8px"><div class="grow"><h1>比较两个提交</h1><p><span class="mono">' + aId + '</span>（起点）和 <span class="mono">' + bId + '</span>（选中）</p></div>' + ib('cmp', '', IC.x, '结束比较') + '</div>' +
    '<div class="flist"><div class="fhead"><span>只在选中这边</span><span>' + onlyB.length + ' 个提交</span></div>' + li(onlyB) + '</div>' +
    '<div class="flist"><div class="fhead"><span>只在起点这边</span><span>' + onlyA.length + ' 个提交</span></div>' + li(onlyA) + '</div>' +
    '<div class="flist"><div class="fhead"><span>有差异的文件</span><span>' + names.length + ' 个</span></div>' +
    (names.map(function (n) { var f = files[n]; return '<div class="frow"><span class="st ' + f.st + '">' + f.st + '</span><span class="mono grow ell">' + esc(n) + '</span></div>'; }).join('') || '<div class="muted" style="padding:4px">两边内容相同</div>') + '</div></aside>';
}
function blameSrc(path) {
  for (var i = 0; i < CF.length; i++) {
    if (CF[i].path === path && CF[i].segs) {
      var out = [];
      CF[i].segs.forEach(function (g) { out = out.concat(g.ctx || g.mine || g.base); });
      return out;
    }
  }
  return null;
}
function blameId(i) { return i < 9 ? '5d1c9b8' : i < 14 ? '7be0d15' : i < 23 ? 'c08e4f3' : i < 36 ? '7be0d15' : '2a6f7d0'; }
function localChain() {
  var out = [], c = commitById(B().head);
  while (c && c.unpushed && c.parents.length === 1) { out.push(c.id); c = commitById(c.parents[0]); }
  return out.reverse();
}
