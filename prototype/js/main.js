/* Strand 原型 · 渲染和事件绑定，最后启动 */
/* ---------- 渲染和事件 ---------- */
function render() {
  var old = $('cf-scroll'), keep = old ? old.scrollTop : null;
  var ae = document.activeElement, fid = ae && (ae.id === 'hq' || ae.id === 'hp' || ae.id === 'tq') ? ae.id : null;
  ctxClose();
  $('app').innerHTML = toolbar() + (S.view === 'conflict' && S.merging ? conflictView() : mainView());
  $('overlay').innerHTML = S.sheet ? sheetView() : S.modal ? modalView() : '';
  var sc = $('cf-scroll');
  if (sc) {
    if (keep !== null) sc.scrollTop = keep;
    if (pendingScroll !== null) {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (sc.scrollTo && !reduce) sc.scrollTo({ top: pendingScroll, behavior: 'smooth' }); else sc.scrollTop = pendingScroll;
    }
  }
  pendingScroll = null;
  if (pendingSel) { var ps = $(pendingSel); if (ps && ps.scrollIntoView) ps.scrollIntoView({ block: 'nearest' }); pendingSel = null; }
  if (fid) { var el = $(fid); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } }
}
document.addEventListener('click', function (e) {
  if (ctxOpen && !(e.target.closest && e.target.closest('.menu'))) { ctxClose(); }
  var el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (el) { if (el.disabled) return; var fn = act[el.getAttribute('data-act')]; if (fn) fn(el.getAttribute('data-arg'), e); return; }
  if (e.target.id === 'pal') palClose();
});
document.addEventListener('input', function (e) {
  if (e.target.id === 'msg') { S.msg = e.target.value; var c = $('msg-count'); if (c) c.textContent = '标题 ' + S.msg.split('\n')[0].length + ' / 50'; }
  if (e.target.id === 'pal-in') { pal.q = e.target.value; pal.i = 0; palList(); }
  if (e.target.id === 'hq') { S.hq = e.target.value; render(); }
  if (e.target.id === 'hp') { S.hpath = e.target.value; render(); }
  if (e.target.id === 'tq') { S.tq = e.target.value; render(); }
});
document.addEventListener('change', function (e) {
  var id = e.target.id;
  if (id === 'ha' || id === 'hb' || id === 'hd') { S[id] = e.target.value; render(); }
  if (id === 'amendto') { S.amendTo = e.target.value; }
});
document.addEventListener('contextmenu', function (e) {
  var el = e.target.closest ? e.target.closest('[data-ctx]') : null;
  if (!el) { ctxClose(); return; }
  e.preventDefault();
  var kind = el.getAttribute('data-ctx'), id = el.getAttribute('data-id');
  if (kind === 'commit' && S.selected !== id) { S.selected = id; render(); }
  ctxShow(e.clientX, e.clientY, ctxItems(kind, id));
});
document.addEventListener('dblclick', function (e) {
  var el = e.target.closest ? e.target.closest('[data-branch]') : null;
  if (el && el.getAttribute('data-branch') !== S.branch) act.bswitch(el.getAttribute('data-branch'));
});
document.addEventListener('dragstart', function (e) {
  var el = e.target.closest ? e.target.closest('[data-branch]') : null;
  if (!el) return;
  dragName = el.getAttribute('data-branch');
  try { e.dataTransfer.setData('text/plain', dragName); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
});
document.addEventListener('dragover', function (e) {
  var el = e.target.closest ? e.target.closest('[data-branch]') : null;
  if (el && dragName && el.getAttribute('data-branch') !== dragName) { e.preventDefault(); el.classList.add('over'); }
});
document.addEventListener('dragleave', function (e) {
  var el = e.target.closest ? e.target.closest('[data-branch]') : null;
  if (el) el.classList.remove('over');
});
document.addEventListener('drop', function (e) {
  var el = e.target.closest ? e.target.closest('[data-branch]') : null;
  if (el && dragName) { e.preventDefault(); var src = dragName; dragName = null; act.bdrop(src + '|' + el.getAttribute('data-branch')); }
});
document.addEventListener('dragend', function () { dragName = null; });
document.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (pal.open) palClose(); else palOpen(); return; }
  if (ctxOpen && e.key === 'Escape') { ctxClose(); return; }
  if (pal.open) {
    if (e.key === 'Escape') { palClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); pal.i = Math.min(pal.i + 1, pal.list.length - 1); palList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pal.i = Math.max(pal.i - 1, 0); palList(); }
    else if (e.key === 'Enter') { e.preventDefault(); act.palRun(pal.i); }
    return;
  }
  if (S.modal) {
    if (e.key === 'Escape') { act.modalCancel(); }
    else if (e.key === 'Enter' && (S.modal.kind === 'prompt' || S.modal.kind === 'confirm' || e.metaKey || e.ctrlKey)) { e.preventDefault(); act.modalOk(); }
    return;
  }
  if (S.sheet && e.key === 'Escape') { act.sheetAbort(); return; }
  if (S.view === 'conflict' && S.merging && S.cf.open != null && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); act.cfStep(e.key === 'ArrowDown' ? '1' : '-1'); return; }
  if (S.view !== 'conflict' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); act.commit(); return; }
  var tn = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
  if (S.view === 'conflict' || S.sheet || tn === 'input' || tn === 'textarea' || tn === 'select' || S.tab !== 'log') return;
  if (e.key === 'F2') { var cp = caps(S.selected); if (cp.canMsg) { e.preventDefault(); act.cmsg(S.selected); } }
  else if (e.key === 'ArrowRight') { e.preventDefault(); act.goParent(S.selected); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); act.goChild(S.selected); }
});
render();
