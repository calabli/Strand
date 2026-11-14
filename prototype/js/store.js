/* Strand prototype · shared: console records, undo/redo, toasts, commit and conflict queries */
/* ---------- Shared ---------- */
function B() { for (var i = 0; i < S.branches.length; i++) if (S.branches[i].name === S.branch) return S.branches[i]; return S.branches[0]; }
function branchBy(n) { for (var i = 0; i < S.branches.length; i++) if (S.branches[i].name === n) return S.branches[i]; return null; }
var consoleLog = [];
function git(line) { consoleLog.push(line); if (consoleLog.length > 300) consoleLog.shift(); }
function logCmd(label) {
  var m, T = [
    [/^提交“(.*)”$/, function (m) { return 'git commit -m "' + m[1] + '"'; }], [/^修订 /, function () { return 'git commit --amend'; }],
    [/^拣选 (\w+)$/, function (m) { return 'git cherry-pick ' + m[1]; }], [/^拣选 (\d+) 个提交$/, function (m) { return 'git cherry-pick <' + m[1] + ' 个提交>'; }],
    [/^还原 (\w+)$/, function (m) { return 'git revert ' + m[1]; }], [/^重置到 (\w+)$/, function (m) { return 'git reset ' + m[1]; }],
    [/^切换到 (.+)$/, function (m) { return 'git switch ' + m[1]; }], [/^新建分支 (.+)$/, function (m) { return 'git switch -c ' + m[1]; }],
    [/^删除分支 (.+)$/, function (m) { return 'git branch -d ' + m[1]; }], [/^重命名分支 (.+)$/, function (m) { return 'git branch -m ' + m[1] + ' <新名字>'; }],
    [/^合并 (.+) 到 (.+)$/, function (m) { return 'git merge ' + m[1]; }], [/^变基到 (.+)$/, function (m) { return 'git rebase ' + m[1]; }],
    [/^(整理提交|压缩|丢弃 \d+ 个提交|丢弃提交|撤销提交|把改动并入)/, function () { return 'git rebase -i'; }],
    [/^拉取并合并 (.+)$/, function (m) { return 'git pull --no-rebase origin'; }], [/^拉取并变基 (.+)$/, function (m) { return 'git pull --rebase origin'; }], [/^拉取 /, function () { return 'git pull origin'; }],
    [/^贮藏 /, function () { return 'git stash push'; }], [/^取回贮藏/, function () { return 'git stash pop'; }], [/^应用贮藏/, function () { return 'git stash apply'; }], [/^丢弃贮藏/, function () { return 'git stash drop'; }],
    [/^新建标签 (.+)$/, function (m) { return 'git tag ' + m[1]; }], [/^删除标签 (.+)$/, function (m) { return 'git tag -d ' + m[1]; }],
    [/^丢弃 (.+) 的改动$/, function (m) { return 'git restore ' + m[1]; }], [/^把 (.+) 加入版本控制$/, function (m) { return 'git add ' + m[1]; }],
    [/^检出 (.+)$/, function (m) { return 'git checkout ' + m[1]; }], [/^新建工作目录 (.+)$/, function (m) { return 'git worktree add ' + m[1]; }]
  ];
  for (var i = 0; i < T.length; i++) if ((m = T[i][0].exec(label))) { git('$ ' + T[i][1](m)); return; }
  git('# ' + label);
}
function snap(label) { stack.push({ label: label, s: JSON.stringify(S) }); redo = []; logCmd(label); return stack.length - 1; }
function undoTo(depth, text) {
  if (depth < 0 || depth >= stack.length) return;
  var popped = stack.splice(depth), last = popped[popped.length - 1];
  redo.push({ s: JSON.stringify(S), popped: popped, label: last.label });
  S = JSON.parse(popped[0].s); S.sheet = false; S.modal = null; git('# 撤销：' + last.label);
  render(); toast(text || (popped.length > 1 ? '已退回到“' + popped[0].label + '”之前' : '已撤销：' + last.label));
}
function redoOne() {
  var r = redo.pop(); if (!r) return;
  r.popped.forEach(function (p) { stack.push(p); });
  S = JSON.parse(r.s); render(); toast('已重做：' + r.label);
}
function toast(text, undoable) {
  var t = $('toast');
  t.innerHTML = '<span>' + esc(text) + '</span>' + (undoable ? '<button type="button" data-act="undo" aria-label="撤销" title="撤销" style="display:flex;align-items:center">' + IC.undo + '</button>' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.innerHTML = ''; }, 6000);
}
function commitById(id) { for (var i = 0; i < S.commits.length; i++) if (S.commits[i].id === id) return S.commits[i]; return null; }
function newId() { var s = ''; for (var i = 0; i < 7; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]; return s; }
function anc(id) {
  var seen = {}, q = [id];
  while (q.length) { var x = q.pop(); if (seen[x]) continue; var c = commitById(x); if (!c) continue; seen[x] = 1; c.parents.forEach(function (p) { q.push(p); }); }
  return seen;
}
function addCommit(o) {
  var b = B();
  o.id = newId(); o.author = '林夏'; o.time = '刚刚'; o.lane = b.lane; o.unpushed = true;
  if (!o.parents) o.parents = [b.head];
  S.commits.unshift(o); b.head = o.id; b.ahead += 1; S.selected = o.id;
  return o;
}
function lineKey(p, h, i) { return p + '|' + h + '|' + i; }
function fileStats(f) {
  var add = 0, del = 0;
  f.hunks.forEach(function (h) { h.lines.forEach(function (l) { if (l[0] === '+') add++; if (l[0] === '-') del++; }); });
  return { add: add, del: del };
}
function sidesOf(id) { var g = SEG[id]; return g ? { m: !!g.mine, t: !!g.theirs } : { m: true, t: true }; }
function isDone(id) { var c = S.cf.choice[id] || {}, s = sidesOf(id); return (!s.m || !!c.m) && (!s.t || !!c.t); }
function cfDone() { return G.filter(function (g) { return isDone(g.id); }).length; }
function cfTotal() { var n = 0; G.forEach(function (g) { var s = sidesOf(g.id); n += (s.m ? 1 : 0) + (s.t ? 1 : 0); }); return n; }
function cfUnmarked() { var n = 0; G.forEach(function (g) { var c = S.cf.choice[g.id] || {}, s = sidesOf(g.id); n += (s.m && !c.m ? 1 : 0) + (s.t && !c.t ? 1 : 0); }); return n; }
function canConflictPull() { return S.branch === 'feature/commit-graph' && !!commitById('7be0d15') && !commitById('9d3e5b2'); }
