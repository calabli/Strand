/* Strand prototype · utilities, icons and icon buttons */
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
var F = function (path, st, add, del) { return { path: path, st: st, add: add, del: del }; };
var AV = { '林夏': 'var(--l1)', '周屿': 'var(--l2)', '陈默': 'var(--l0)' };
var LX = [14, 32, 50, 68], RH = 36;
var I = function (d) { return '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; };
var IC = {
  up: I('<path d="M7 11.5v-9M3 6l4-3.5L11 6"/>'),
  down: I('<path d="M7 2.5v9M3 8l4 3.5L11 8"/>'),
  undo: I('<path d="M5 2.5L2.5 5 5 7.5"/><path d="M2.5 5h5.5a3.5 3.5 0 010 7H6"/>'),
  redo: I('<path d="M9 2.5L11.5 5 9 7.5"/><path d="M11.5 5H6a3.5 3.5 0 000 7h2"/>'),
  find: I('<circle cx="6" cy="6" r="4"/><path d="M9 9l3.5 3.5"/>'),
  check: I('<path d="M2.5 7.5l3 3 6-7"/>'),
  accR: I('<path d="M3 3l4 4-4 4M8 3l4 4-4 4"/>'),
  accL: I('<path d="M11 3L7 7l4 4M6 3L2 7l4 4"/>'),
  x: I('<path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/>'),
  allR: I('<path d="M2 3l4 4-4 4M6.5 3l4 4-4 4M12.5 2.5v9"/>'),
  allL: I('<path d="M12 3L8 7l4 4M7.5 3l-4 4 4 4M1.5 2.5v9"/>'),
  sync: I('<path d="M12 5.5A5 5 0 003 4.5L2 5.5M2 2.5v3h3M2 8.5a5 5 0 009 1l1-1M12 11.5v-3H9"/>'),
  pause: I('<path d="M5 3v8M9 3v8"/>'),
  stop: I('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/>'),
  pencil: I('<path d="M2.5 11.5l.6-2.6 6.5-6.5 2 2-6.5 6.5z"/>'),
  wand: I('<path d="M2.5 11.5l6-6M10 2v2.4M8.8 3.2h2.4M11.5 6.5v1.6M10.7 7.3h1.6M5 2.5v1.4M4.3 3.2h1.4"/>'),
  trash: I('<path d="M2.5 4h9M5.5 4V2.5h3V4M3.8 4l.6 7.5h5.2l.6-7.5"/>'),
  plus: I('<path d="M7 2.5v9M2.5 7h9"/>'),
  go: I('<path d="M2.5 7h8M7.5 4l3 3-3 3"/>'),
  merge: I('<circle cx="3.5" cy="3" r="1.5"/><circle cx="3.5" cy="11" r="1.5"/><circle cx="10.5" cy="7" r="1.5"/><path d="M3.5 4.5v5M3.5 5c0 2 3 2 5.5 2"/>'),
  pick: I('<circle cx="4.5" cy="10" r="2"/><circle cx="10" cy="10.5" r="2"/><path d="M4.5 8C5 5 7 3 10.5 2.5M10 8.5C9.5 6 8.5 4 7.5 3.3"/>'),
  revert: I('<path d="M2.5 3v3.5H6"/><path d="M2.8 6.5A4.8 4.8 0 1 1 4 10.6"/>'),
  reset: I('<path d="M7 2.5v6M4.5 6L7 8.5 9.5 6M2.5 11.5h9"/>'),
  list: I('<path d="M5.5 3.5h6M5.5 7h6M5.5 10.5h6M2.5 3.5h.01M2.5 7h.01M2.5 10.5h.01"/>'),
  box: I('<path d="M2 4.5h10v2H2zM3 6.5v5h8v-5M5.5 8.5h3"/>'),
  unbox: I('<path d="M3 7v4.5h8V7M7 8.5v-6M4.5 5L7 2.5 9.5 5"/>'),
  squash: I('<path d="M7 11.5V6M4.5 8L7 5.5 9.5 8M2.5 3h9"/>'),
  branch: I('<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="11" r="1.5"/><circle cx="10" cy="5" r="1.5"/><path d="M4 4.5v5M10 6.5c0 2-6 1-6 3"/>'),
  file: I('<path d="M3.5 2h5l2.5 2.5V12h-7.5zM8.5 2v2.5H11"/>'),
  tag: I('<path d="M2.5 2.5H7l5 5L7.5 12l-5-5z"/><path d="M5 5h.01"/>'),
  blame: I('<circle cx="4" cy="4.5" r="1.8"/><path d="M1.5 11c.3-2 1.2-3 2.5-3s2.2 1 2.5 3M8.5 4h4M8.5 7h4M8.5 10h4"/>'),
  compare: I('<path d="M4.5 2.5v9M2.5 9.5l2 2 2-2M9.5 11.5v-9M7.5 4.5l2-2 2 2"/>'),
  col3: I('<rect x="2" y="2.5" width="10" height="9" rx="1"/><path d="M5.3 2.5v9M8.7 2.5v9"/>'),
  col2: I('<rect x="2" y="2.5" width="10" height="9" rx="1"/><path d="M7 2.5v9"/>'),
  col1: I('<rect x="2" y="2.5" width="10" height="9" rx="1"/><path d="M4.5 5.5h5M4.5 8.5h5"/>'),
  skip: I('<path d="M3 3l5 4-5 4zM11 3v8"/>'),
  chev: I('<path d="M5 3.5L8.5 7 5 10.5"/>'),
  panel: I('<rect x="2" y="2.5" width="10" height="9" rx="1"/><path d="M5.5 2.5v9"/>'),
  copy: I('<rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M2.5 9.5v-7h7"/>'),
  eye: I('<path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4S1.5 7 1.5 7z"/><circle cx="7" cy="7" r="1.6"/>'),
  eyeoff: I('<path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4S1.5 7 1.5 7z"/><path d="M2.5 2.5l9 9"/>'),
  star: I('<path d="M7 2l1.5 3.2 3.5.4-2.6 2.4.7 3.5L7 9.8l-3.1 1.7.7-3.5L2 5.6l3.5-.4z"/>'),
  cpush: I('<path d="M1.5 8.5L4 11l4-5M11 9.5v-7M9 4.5l2-2 2 2"/>'),
  layers: I('<path d="M7 2.5l5 2.5-5 2.5L2 5zM2 8.5L7 11l5-2.5"/>'),
  ws: I('<path d="M3 8.5v2h8v-2"/><path d="M5 4h4"/>'),
  sort: I('<path d="M4 2.5v9M2 9.5l2 2 2-2M8 4h4.5M8 7h3M8 10h1.5"/>'),
  target: I('<circle cx="7" cy="7" r="3.5"/><path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2"/>'),
  clock: I('<circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1.5"/>'),
  gear: I('<circle cx="7" cy="7" r="2"/><path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2M3.1 3.1l1.4 1.4M9.5 9.5l1.4 1.4M3.1 10.9l1.4-1.4M9.5 4.5l1.4-1.4"/>'),
  patch: I('<path d="M7 2.5v6M4 5.5h6M3 11.5h8"/>'),
  folder: I('<path d="M2 4h3.5l1 1.5H12V11H2z"/>'),
  expand: I('<path d="M4 5l3-3 3 3M4 9l3 3 3-3"/>'),
  collapse: I('<path d="M4 2.5l3 3 3-3M4 11.5l3-3 3 3"/>'),
  blank: '<span style="display:inline-block;width:14px"></span>'
};
var ib = function (a, arg, icon, tip, cls, dis) {
  return '<button type="button" class="btn sm ib ' + (cls || '') + '" data-act="' + a + '" data-arg="' + esc(arg) + '" aria-label="' + tip + '" title="' + tip + '"' + (dis ? ' disabled' : '') + '>' + icon + '</button>';
};
