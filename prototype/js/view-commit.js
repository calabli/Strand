/* Strand 原型 · 提交面板、差异、控制台、主视图 */
/* ---------- 提交面板和差异 ---------- */
function commitPane() {
  if (S.cfile >= S.changes.length) S.cfile = 0;
  var onCount = S.changes.filter(function (f) { return !S.offFiles[f.path]; }).length;
  var tb = function (v, label, n) { return '<button type="button" style="padding:0 10px" data-act="ltab" data-arg="' + v + '" aria-pressed="' + (S.ltab === v) + '">' + label + ' <span class="badge">' + n + '</span></button>'; };
  var tabs = '<div class="seg" style="margin:10px 10px 0;align-self:flex-start" role="group" aria-label="提交面板">' + tb('commit', '提交', S.changes.length) + tb('shelf', '暂存架', S.shelf.length) + tb('stash', '贮藏', S.stash.length) + '</div>';
  if (S.ltab === 'shelf') {
    var shelf = S.shelf.map(function (e, i) {
      return '<div class="frow2"><span class="grow ell">' + esc(e.name) + ' <span class="muted">· ' + e.files.length + ' 个文件</span></span>' + ib('unshelve', i, IC.unbox, '取回到工作区') + ib('shelfDel', i, IC.trash, '删除这组搁置的改动', 'x') + '</div>';
    }).join('') || '<div class="muted" style="padding:6px">暂存架是空的</div>';
    return '<aside class="left">' + tabs + '<div class="files">' + shelf + '</div></aside>';
  }
  if (S.ltab === 'stash') {
    var stash = S.stash.map(function (e, i) {
      return '<div class="frow2"><span class="grow ell" title="' + esc(e.name) + '">' + esc(e.name) + ' <span class="muted">· ' + e.files.length + ' 个文件</span></span>' + ib('stashPop', i, IC.unbox, '取回，并从贮藏里删除') + ib('stashApply', i, IC.copy, '取回，但保留在贮藏里') + ib('stashDrop', i, IC.trash, '丢弃这条贮藏', 'x') + '</div>';
    }).join('') || '<div class="muted" style="padding:6px">还没有贮藏。在“提交”里点贮藏图标，可以把全部改动先收起来。</div>';
    return '<aside class="left">' + tabs + '<div class="files">' + stash + '</div></aside>';
  }
  var frows = S.changes.map(function (f, i) {
    var st = fileStats(f);
    return '<div class="frow2' + (S.dopen && S.tab === 'diff' && i === S.cfile ? ' cur' : '') + '" data-ctx="file" data-id="' + esc(f.path) + '"><input type="checkbox" id="fc' + i + '" aria-label="把 ' + esc(f.path) + ' 放进这次提交"' + (S.offFiles[f.path] ? '' : ' checked') + ' data-act="tfile" data-arg="' + esc(f.path) + '">' +
      '<button type="button" class="fopen" data-act="cfile" data-arg="' + i + '" title="查看差异"><span class="st ' + f.st + '">' + f.st + '</span><span class="mono grow ell">' + esc(f.path) + '</span><span class="mono plus">+' + st.add + '</span><span class="mono minus">-' + st.del + '</span></button>' +
      ib('fdiscard', f.path, IC.revert, '丢弃这个文件的改动', 'x') + '</div>';
  });
  var files = groupRows(S.changes.map(function (f) { return f.path; }), frows) || '<div class="muted" style="padding:6px">没有改动，工作区是干净的。</div>';
  var untracked = S.untracked.map(function (u) {
    return '<div class="frow2"><span class="st U">?</span><span class="mono grow ell">' + esc(u.path) + '</span>' + ib('uadd', u.path, IC.plus, '加入版本控制') + ib('uignore', u.path, IC.eyeoff, '加入忽略规则（.gitignore）') + ib('udel', u.path, IC.trash, '删除这个文件', 'x') + '</div>';
  }).join('');
  var any = onCount > 0, chain = localChain().slice().reverse();
  var ctb = '<div class="ctb">' + ib('refresh', '', IC.sync, '刷新') + ib('crollback', '', IC.revert, any ? '回滚：丢弃勾选文件的改动' : '回滚：先勾选文件', 'x', !any) + ib('cdiff', '', IC.eye, '查看差异', '', !S.changes.length) +
    ib('cshelve', '', IC.box, any ? '直接搁置勾选的文件（不询问名字）' : '搁置：先勾选文件', '', !any) + ib('patchChanges', '', IC.patch, any ? '用勾选的改动创建补丁' : '创建补丁：先勾选文件', '', !any) +
    ib('cgroup', '', IC.folder, S.cgroup ? '取消按目录分组' : '按目录分组', S.cgroup ? 'on' : '') + ib('cl', '1', IC.expand, '展开') + ib('cl', '0', IC.collapse, '折叠') + '</div>';
  return '<aside class="left">' + tabs + ctb + '<div class="files"><div class="frow2 clh"><input type="checkbox" aria-label="全选或全不选" title="全选或全不选"' + (S.changes.length && onCount === S.changes.length ? ' checked' : '') + ' data-act="clAll">' +
    '<button type="button" class="fopen" data-act="cl" data-arg="t" aria-expanded="' + !S.clClosed + '"><span class="chev' + (S.clClosed ? '' : ' open') + '">' + IC.chev + '</span><b>改动</b><span class="grow"></span><span class="muted">已选 ' + onCount + ' / ' + S.changes.length + '</span></button></div>' + (S.clClosed ? '' : files) +
    (S.untracked.length ? '<div class="lab" style="padding:14px 6px 6px"><span>未跟踪的文件</span><span>' + S.untracked.length + ' 个</span></div>' + untracked : '') + '</div>' +
    (S.changes.length ? '<div class="composer"><label class="lab" for="msg"><span>提交说明</span><span id="msg-count">标题 ' + S.msg.split('\n')[0].length + ' / 50</span></label>' +
      '<textarea id="msg" rows="4">' + esc(S.msg) + '</textarea>' +
      '<div style="display:flex;align-items:center;gap:6px"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="amend" style="margin:0;width:15px;height:15px"' + (S.amend ? ' checked' : '') + ' data-act="tamend">修订' + (S.amend && chain.length ? '' : '上一次提交') + '</label>' +
      (S.amend && chain.length ? '<select id="amendto" class="grow" style="min-width:0" aria-label="修订哪一个提交">' + chain.map(function (id, i) { return '<option value="' + id + '"' + ((S.amendTo || chain[0]) === id ? ' selected' : '') + '>' + (i ? '' : '上一次：') + id + ' ' + esc(commitById(id).msg) + '</option>'; }).join('') + '</select>' : '<span class="grow"></span>') +
      ib('msgHist', '', IC.clock, '提交说明历史') + ib('msgGen', '', IC.wand, '根据勾选的文件生成提交说明') + ib('copt', '', IC.gear, '提交选项') + '</div>' +
      '<div style="display:flex;gap:6px"><button type="button" class="btn primary grow" style="height:34px;justify-content:center;padding:0 8px" data-act="commit">' + IC.check + (S.amend ? '修订' : '提交') + ' ' + onCount + ' 个</button>' +
      ib('commitPush', '', IC.cpush, '提交并推送', 'lg') + ib('shelve', '', IC.box, '把勾选的文件搁置到暂存架', 'lg') + ib('stash', '', IC.layers, '贮藏全部改动（git stash）', 'lg') + '</div></div>' : '') + '</aside>';
}
function normWs(t) { return t.replace(/\s+/g, ' ').replace(/^ | $/g, ''); }
function hunkLines(cur, h, hi) {
  var ls = h.lines.map(function (l, li) { return { k: l[0], a: l[1], b: l[2], t: l[3], key: lineKey(cur.path, hi, li) }; });
  if (S.dws) {
    for (var i = 0; i < ls.length; i++) {
      if (ls[i].k !== '-') continue;
      for (var j = i + 1; j < ls.length && ls[j].k !== ' '; j++) {
        if (ls[j].k === '+' && !ls[j].skip && normWs(ls[j].t) === normWs(ls[i].t)) { ls[i].k = ' '; ls[i].b = ls[j].b; ls[i].t = ls[j].t; ls[j].skip = true; break; }
      }
    }
    ls = ls.filter(function (l) { return !l.skip; });
  }
  return ls;
}
function diffPane() {
  var cur = S.changes[S.cfile], total = 0, on = 0, n = cur.hunks.length, side = S.dmode === 'side';
  if (S.dcur >= n) S.dcur = 0;
  cur.hunks.forEach(function (h, hi) { h.lines.forEach(function (l, li) { if (l[0] !== ' ') { total++; if (!S.offLines[lineKey(cur.path, hi, li)]) on++; } }); });
  var cb = function (l) {
    var isOn = !S.offLines[l.key];
    return '<input type="checkbox" aria-label="' + (l.k === '+' ? '新增行 ' + l.b : '删除行 ' + l.a) + '"' + (isOn ? ' checked' : '') + ' data-act="tline" data-arg="' + esc(l.key) + '">';
  };
  var hunks = cur.hunks.map(function (h, hi) {
    var ls = hunkLines(cur, h, hi), all = true, body = '';
    h.lines.forEach(function (l, li) { if (l[0] !== ' ' && S.offLines[lineKey(cur.path, hi, li)]) all = false; });
    if (side) {
      var rows = [], dels = [], adds = [];
      var flush = function () { for (var k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k], adds[k]]); dels = []; adds = []; };
      ls.forEach(function (l) { if (l.k === '-') { if (adds.length) flush(); dels.push(l); } else if (l.k === '+') adds.push(l); else { flush(); rows.push([l, l]); } });
      flush();
      var cell = function (l, kind) {
        if (!l) return '<span class="e"></span><span class="n e"></span><span class="code e"></span>';
        var ch = l.k !== ' ', cls = ch ? (kind === 'L' ? ' del' : ' add') + (S.offLines[l.key] ? ' off' : '') : '';
        return '<span class="c' + cls + '">' + (ch ? cb(l) : '') + '</span><span class="n' + cls + '">' + (kind === 'L' ? l.a : l.b) + '</span><span class="code' + cls + '">' + esc(l.t) + '</span>';
      };
      body = rows.map(function (r) { return '<div class="ds">' + cell(r[0], 'L') + cell(r[1], 'R') + '</div>'; }).join('');
    } else {
      body = ls.map(function (l) {
        var ch = l.k !== ' ';
        return '<div class="dl' + (l.k === '+' ? ' add' : l.k === '-' ? ' del' : '') + (ch && S.offLines[l.key] ? ' off' : '') + '">' + (ch ? cb(l) : '<span></span>') +
          '<span class="n">' + l.a + '</span><span class="n">' + l.b + '</span><span class="' + (l.k === '+' ? 'plus' : 'minus') + '" style="font-weight:700">' + l.k + '</span><span class="code">' + esc(l.t) + '</span></div>';
      }).join('');
    }
    return '<div class="hunk' + (hi === S.dcur ? ' curh' : '') + '" id="hk' + hi + '"><header><input type="checkbox" style="margin:0 2px;width:15px;height:15px" aria-label="选择这一整块" title="选择这一整块"' + (all ? ' checked' : '') + ' data-act="thunk" data-arg="' + hi + '"><span class="mono muted">' + esc(h.title) + '</span></header>' + body + '</div>';
  }).join('');
  var mb = function (v, icon, tip) { return '<button type="button" style="padding:0 9px" data-act="dmode" data-arg="' + v + '" aria-pressed="' + (S.dmode === v) + '" aria-label="' + tip + '" title="' + tip + '">' + icon + '</button>'; };
  return '<div class="bar2"><span class="mono" style="font-weight:600;font-size:13px">' + esc(cur.path) + '</span><span class="muted">已选 ' + on + ' / ' + total + ' 行</span>' +
    '<span class="grow"></span><span class="seg" style="margin-left:0" role="group" aria-label="差异视图">' + mb('unified', IC.col1, '合并视图：新旧内容上下排列') + mb('side', IC.col2, '左右对比：左边旧内容，右边新内容') + '</span>' +
    ib('dws', '', IC.ws, S.dws ? '正在忽略空白差异，点一下恢复' : '忽略只有空白不同的改动', 'lg' + (S.dws ? ' on' : '')) +
    ib('dnav', '-1', IC.up, '上一块改动', 'lg') + '<b class="num">第 ' + (S.dcur + 1) + ' / ' + n + ' 块</b>' + ib('dnav', '1', IC.down, '下一块改动', 'lg') + '</div><div class="scroll">' + hunks + '</div>';
}
function consolePane() {
  return '<div class="bar2"><span class="muted">每次操作对应的 Git 命令都记在这里。# 开头的是没有直接对应命令的操作。</span><span class="grow"></span>' + ib('conClear', '', IC.trash, '清空控制台') + '</div>' +
    '<div class="scroll"><pre class="console">' + (consoleLog.map(function (l) { return esc(l); }).join('\n') || '还没有执行过命令。') + '</pre></div>';
}
function mainView() {
  var hasDiff = S.dopen && S.changes.length > 0, showDiff = hasDiff && S.tab === 'diff', showCon = !showDiff && S.tab === 'console';
  if (hasDiff && S.cfile >= S.changes.length) S.cfile = 0;
  var tabs = '<div class="tabs" role="tablist"><button type="button" role="tab" data-act="tab" data-arg="log" aria-selected="' + (!showDiff && !showCon) + '">Git 日志</button>' +
    '<button type="button" role="tab" data-act="tab" data-arg="console" aria-selected="' + showCon + '">控制台</button>' +
    (hasDiff ? '<span class="tabwrap"><button type="button" role="tab" data-act="tab" data-arg="diff" aria-selected="' + !!showDiff + '">差异 · ' + esc(S.changes[S.cfile].path.split('/').pop()) + '</button>' + ib('dclose', '', IC.x, '关闭这个标签页') + '</span>' : '') + '</div>';
  return '<div class="body">' + (S.left ? commitPane() : '') + '<div class="main">' + tabs + (showDiff ? diffPane() : showCon ? consolePane() : logPane()) + '</div></div>';
}
