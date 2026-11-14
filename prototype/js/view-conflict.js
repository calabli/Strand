/* Strand prototype · conflict list, merge window, pull summary */
/* ---------- Conflicts ---------- */
function splitDiff(x, y) {
  if (y === undefined) return ['', x, ''];
  var p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  var q = 0; while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return [x.slice(0, p), x.slice(p, x.length - q), x.slice(x.length - q)];
}
function codeCell(parts) { return esc(parts[0]) + (parts[1] ? '<mark>' + esc(parts[1]) + '</mark>' : '') + esc(parts[2]); }
function resultOf(g, v) {
  if (v.custom) return v.custom.slice();
  var res = [];
  if (g.mine && v.m === 'a') res = res.concat(g.mine);
  if (g.theirs && v.t === 'a') res = res.concat(g.theirs);
  return res;
}
function buildFile(f, fi) {
  var html = '', tops = [], y = 0, a = 0, b = 0, c = 0, k = 0, ch = S.cf.choice;
  f.segs.forEach(function (g) {
    if (g.ctx) {
      g.ctx.forEach(function (t) {
        a++; b++; c++; y += 24;
        html += '<div class="ln"><span class="n">' + a + '</span><span>' + esc(t) + '</span><span class="n bl">' + c + '</span><span>' + esc(t) + '</span><span class="n bl">' + b + '</span><span>' + esc(t) + '</span></div>';
      });
      return;
    }
    var idx = k++, v = ch[g.id] || {}, isCur = fi === S.cf.file && idx === S.cf.cur, need = !!S.cf.checked;
    var hasM = !!g.mine, hasT = !!g.theirs, vm = hasM ? v.m : 'n', vt = hasT ? v.t : 'n', done = !!(vm && vt);
    var mine = g.mine || g.base, theirs = g.theirs || g.base, no = gIndex(g.id) + 1;
    tops.push(y);
    var bt = function (side, val, icon, tip, cls) { return '<button type="button" class="btn sm ' + cls + '" data-act="cfPick" data-arg="' + g.id + '|' + side + '|' + val + '" aria-label="' + tip + '" title="' + tip + '">' + icon + '</button>'; };
    if (!done) {
      var left = (vm ? 0 : 1) + (vt ? 0 : 1);
      y += 39;
      html += '<div class="tri chead' + (isCur ? ' cur' : '') + '">' +
        (vm ? '<div class="o"></div>' : '<div class="m' + (need ? ' need' : '') + '"><span class="grow ell"><b>修改块 · ' + mine.length + ' 行</b> · <span class="mono">' + g.mh + '</span> · ' + g.mw + ' · ' + esc(g.mm) + '</span>' + bt('m', 'a', IC.accR, '接受你的这个修改块', 'ib acc') + bt('m', 'x', IC.x, '舍弃你的这个修改块', 'ib x') + '</div>') +
        '<div class="c"><b>' + (hasM && hasT ? '冲突' : '修改') + ' ' + no + '</b><span class="tag2">' + (hasM && hasT ? '还有 ' + left + ' 块没标记' : '没有冲突，还没标记') + '</span><span class="grow"></span>' + ib('cfEdit', g.id, IC.pencil, '手动编辑这一处的结果') + '</div>' +
        (vt ? '<div class="o bl"></div>' : '<div class="t' + (need ? ' need' : '') + '">' + bt('t', 'x', IC.x, '舍弃对方的这个修改块', 'ib x') + bt('t', 'a', IC.accL, '接受对方的这个修改块', 'ib acc') + '<span class="grow ell"><b>修改块 · ' + theirs.length + ' 行</b> · <span class="mono">' + g.th + '</span> · ' + g.tw + ' · ' + esc(g.tm) + '</span></div>') + '</div>';
    }
    var res = resultOf(g, v);
    if (done && !res.length && !v.custom) res = g.base.slice();
    var note = done ? '' : (!vm && !vt ? '  待处理：两边的修改块都要接受或舍弃' : !vm ? '  左边的修改块还没标记' : '  右边的修改块还没标记');
    var n = Math.max(mine.length, theirs.length, res.length + (note ? 1 : 0));
    var pair = hasM && hasT && mine.length === theirs.length && !v.m && !v.t;
    for (var i = 0; i < n; i++) {
      var mt = mine[i], tt = theirs[i], r = res[i];
      if (mt !== undefined) a++; if (tt !== undefined) b++; if (r !== undefined) c++;
      var ac = vm ? '' : (mt === undefined ? 'a-gap' : 'a-on blk' + (i === mine.length - 1 ? ' last' : ''));
      var bc = vt ? '' : (tt === undefined ? 'b-gap' : 'b-on blk' + (i === theirs.length - 1 ? ' last' : ''));
      var cc = r !== undefined ? '' : (note && i === res.length ? 'c-pend' : (done ? '' : 'c-gap'));
      html += '<div class="ln"><span class="n ' + ac + '">' + (mt === undefined ? '' : a) + '</span><span class="' + ac + '">' + (mt === undefined ? '' : (pair ? codeCell(splitDiff(mt, tt)) : esc(mt))) + '</span>' +
        '<span class="n bl ' + cc + '">' + (r !== undefined ? c : '') + '</span><span class="' + cc + '">' + (r !== undefined ? esc(r) : (note && i === res.length ? note : '')) + '</span>' +
        '<span class="n bl ' + bc + '">' + (tt === undefined ? '' : b) + '</span><span class="' + bc + '">' + (tt === undefined ? '' : (pair ? codeCell(splitDiff(tt, mt)) : esc(tt))) + '</span></div>';
      y += 24;
    }
  });
  return { html: html, tops: tops, total: y };
}
function fileDone(i) { return CF[i].ids.every(isDone); }
function cfUnmarkedIn(i) { var n = 0; CF[i].ids.forEach(function (id) { var c = S.cf.choice[id] || {}, s = sidesOf(id); n += (s.m && !c.m ? 1 : 0) + (s.t && !c.t ? 1 : 0); }); return n; }
function rbPill() {
  return S.cf.rebase ? '<span class="pill" style="background:var(--pend-bg);color:var(--pend-ink);border-color:transparent">变基 · 第 1 / ' + localChain().length + ' 个提交 · <span class="mono">' + localChain()[0] + '</span></span>' : '';
}
function conflictView() { return S.cf.open == null ? conflictList() : mergeWindow(); }
function conflictList() {
  var left = cfUnmarked(), doneFiles = 0;
  var rows = CF.map(function (f, i) {
    var d = fileDone(i), k = f.card, n = f.ids.filter(function (id) { return !isDone(id); }).length;
    if (d) doneFiles++;
    return '<div class="cfrow' + (d ? ' done' : '') + '"><span class="mono grow ell" style="font-weight:600">' + f.path + '</span><span class="cfc">已修改</span><span class="cfc">' + (k && k.id === 'c4' ? '已删除' : '已修改') + '</span>' +
      '<span class="cfs">' + (d ? '<span class="tag2 ok">已解决</span>' : '<span class="tag2">' + (k ? '待选择' : n + ' 处待处理') + '</span>') + '</span><span class="cfa">' +
      ib('cfAcceptFile', i + '|mine', IC.allR, k ? k.ml : '整个文件接受你的', 'acc') + ib('cfAcceptFile', i + '|theirs', IC.allL, k ? k.tl : '整个文件接受对方的', 'acc') +
      (k ? '<span style="width:30px"></span>' : ib('cfOpen', i, IC.merge, '打开合并窗口，逐块处理')) + '</span>' + (k && k.tip && !d ? '<span class="cfn">' + k.tip + '</span>' : '') + '</div>';
  }).join('');
  return '<div class="body"><div class="main" style="background:var(--soft)"><div class="scroll"><div class="cfbox">' +
    '<div class="pad"><h1>冲突</h1><span class="muted">从 <span class="mono">origin/' + esc(S.branch) + '</span> ' + (S.cf.rebase ? '变基拉取' : '拉取') + '时，有 ' + CF.length + ' 个文件两边都改了。可以整个文件接受一边，或者打开合并窗口逐块处理。</span>' + (S.cf.rebase ? '<div style="margin-top:10px">' + rbPill() + '</div>' : '') + '</div>' +
    '<div class="cfrow cfhead"><span class="grow">文件</span><span class="cfc">你的</span><span class="cfc">对方的</span><span class="cfs">状态</span><span class="cfa"></span></div>' + rows +
    '<div class="foot" style="align-items:center">' + (S.cf.checked && left ? '<span class="grow" style="color:var(--danger);font-weight:600">还有 ' + left + ' 个修改块没有标记，不能完成合并。每个修改块都要选接受或舍弃。</span>' : '<span class="muted grow">' + (left ? '已解决 ' + doneFiles + ' / ' + CF.length + ' 个文件 · 已标记 ' + (cfTotal() - left) + ' / ' + cfTotal() + ' 个修改块' : '所有修改块都已标记，可以完成合并。') + '</span>') +
    (S.cf.rebase ? ib('cfSkip', '', IC.skip, '跳过这个提交：不把它带到新的历史里', 'lg x') : '') + ib('view', 'history', IC.pause, '稍后继续：先离开，已标记的结果会保留', 'lg') + ib('cfAbort', '', IC.stop, '中止拉取，回到拉取之前', 'lg x') +
    '<button type="button" class="btn primary ib lg" data-act="cfFinish" aria-label="完成合并" title="完成合并">' + IC.check + '</button></div></div></div></div></div>';
}
function mergeWindow() {
  var cf = S.cf, fi = cf.open, f = CF[fi], n = f.ids.length, lay = buildFile(f, fi), mode = cf.mode || 'three', leftF = cfUnmarkedIn(fi), totalF = 0;
  f.ids.forEach(function (id) { var sd = sidesOf(id); totalF += (sd.m ? 1 : 0) + (sd.t ? 1 : 0); });
  var marks = f.ids.map(function (id, i) {
    return '<button type="button" class="' + (isDone(id) ? 'ok' : '') + (i === cf.cur ? ' cur' : '') + '" style="top:' + (lay.tops[i] / Math.max(lay.total, 600) * 100).toFixed(1) + '%" aria-label="跳到第 ' + (i + 1) + ' 处" title="跳到第 ' + (i + 1) + ' 处" data-act="cfGo" data-arg="' + gIndex(id) + '"></button>';
  }).join('');
  return '<div class="body"><div class="main"><div class="bar2">' + rbPill() + '<span class="mono" style="font-weight:600;font-size:13px">' + f.path + '</span>' +
    ib('cfWhole', 'mine', IC.allR, '整个文件都接受你的，舍弃对方的', 'acc') + ib('cfWhole', 'theirs', IC.allL, '整个文件都接受对方的，舍弃你的', 'acc') + ib('cfAuto', '', IC.wand, '接受所有没有冲突的修改块', 'acc') +
    '<span class="seg" style="margin-left:0" role="group" aria-label="视图">' + [['three', IC.col3, '三栏：你的、结果、对方的'], ['two', IC.col2, '只看两边对比'], ['result', IC.col1, '只看结果']].map(function (x) {
      return '<button type="button" style="padding:0 9px" data-act="cfMode" data-arg="' + x[0] + '" aria-pressed="' + (mode === x[0]) + '" aria-label="' + x[2] + '" title="' + x[2] + '">' + x[1] + '</button>'; }).join('') + '</span>' +
    '<span style="margin-left:auto;display:flex;align-items:center;gap:6px">' + ib('undo', '', IC.undo, '撤销上一次标记', 'lg', !stack.length) + ib('redo', '', IC.redo, '重做', 'lg', !redo.length) +
    ib('cfStep', '-1', IC.up, '上一处', 'lg') + '<b class="num" style="min-width:84px;text-align:center">第 ' + (Math.min(cf.cur, n - 1) + 1) + ' / ' + n + ' 处</b>' + ib('cfStep', '1', IC.down, '下一处', 'lg') + '</span>' +
    '<span class="legend"><span><i style="background:var(--mine-strong)"></i>你改的</span><span><i style="background:var(--theirs-strong)"></i>对方改的</span><span><i style="background:var(--pend-bg);border:1px dashed var(--pend-ink);box-sizing:border-box"></i>没标记</span><span style="display:inline-flex;align-items:center;gap:4px;color:var(--ok-ink)">' + IC.accR + '接受</span><span style="display:inline-flex;align-items:center;gap:4px;color:var(--danger)">' + IC.x + '舍弃</span></span></div>' +
    '<div style="flex:1 1 0;min-height:0;display:flex"><div id="cf-scroll" class="scroll" style="flex:1 1 0;min-width:0"><div class="mode-' + mode + '" style="min-width:' + (mode === 'three' ? 780 : mode === 'two' ? 560 : 320) + 'px">' +
    '<div class="tri colhead"><div class="m"><b style="color:var(--mine-ink)">你的</b><span class="mono ell">' + esc(S.branch) + '</span><span class="muted ell" style="font-size:12px">a41f9c2 · 林夏</span></div><div><b>结果预览</b><span class="muted ell" style="font-size:12px">应用后写入这个文件</span></div><div class="t"><b style="color:var(--theirs-ink)">对方的</b><span class="mono ell">origin/' + esc(S.branch) + '</span><span class="muted ell" style="font-size:12px">9d3e5b2 · 周屿</span></div></div>' +
    lay.html + '</div></div><div class="rail" aria-label="修改块位置">' + marks + '</div></div>' +
    '<div class="strip">' + (cf.checked && leftF ? '<span style="color:var(--danger);font-weight:600">这个文件还有 ' + leftF + ' 个修改块没有标记，不能应用。每个修改块都要选接受或舍弃。</span>' : '<span class="muted">这个文件已标记 ' + (totalF - leftF) + ' / ' + totalF + ' 个修改块</span>') +
    '<span style="margin-left:auto;display:flex;gap:8px">' + ib('cfBack', '', IC.x, '返回冲突列表，已标记的结果会保留', 'lg') +
    '<button type="button" class="btn primary ib lg" data-act="cfApply" aria-label="应用：这个文件处理完了" title="应用：这个文件处理完了">' + IC.check + '</button></span></div></div></div>';
}

/* ---------- Overlays ---------- */
function sheetView() {
  return '<div class="sheet" role="dialog" aria-modal="true" aria-label="拉取遇到冲突"><div class="pad"><h1>拉取完成了一部分，还有冲突要你决定</h1><span class="muted">从 <span class="mono">origin/' + esc(S.branch) + '</span> 拉取</span></div>' +
    '<div class="pad" style="padding-top:0"><div class="seg" style="margin:0;display:inline-flex" role="group" aria-label="拉取方式">' + [['merge', '合并'], ['rebase', '变基']].map(function (x) { return '<button type="button" data-act="pullMode" data-arg="' + x[0] + '" aria-pressed="' + (S.pullMode === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
    '<div class="muted" style="margin-top:6px">' + (S.pullMode === 'rebase' ? '变基：把你本地的 ' + localChain().length + ' 个提交挪到远程提交之后，历史保持一条直线。冲突按提交逐个出现。' : '合并：保留两条线，生成一个合并提交。') + '</div></div>' +
    '<div class="stats"><div><b>2</b>个新提交</div><div class="ok"><b>9</b>个文件已自动合并</div><div class="pend"><b>' + CF.length + '</b>个文件有冲突</div></div>' +
    '<div class="rows">' + CF.map(function (f) { return '<div><span class="mono grow ell">' + f.path + '</span><span class="muted">' + f.note + '</span></div>'; }).join('') + '</div>' +
    (S.changes.length ? '<div class="pad muted" style="padding-bottom:0">你还没提交的 ' + S.changes.length + ' 个文件改动会先放到暂存架，解决完自动放回。</div>' : '') +
    '<div class="foot"><button type="button" class="btn danger" data-act="sheetAbort">中止，回到拉取之前</button><button type="button" class="btn primary" data-act="sheetStart" id="sheet-go">开始解决</button></div></div>';
}
function rbChain() {
  var b = B(), out = [], c = commitById(b.head), others = {};
  S.branches.forEach(function (x) { if (x.name !== b.name) others[x.head] = 1; });
  while (c && c.lane === b.lane && c.parents.length === 1 && !others[c.id]) { out.push(c.id); c = commitById(c.parents[0]); }
  return out.reverse();
}
