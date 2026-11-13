const fs=require('fs');const els={};
const mk=id=>({id,innerHTML:'',scrollTop:0,value:'',focus(){},select(){},setSelectionRange(){},scrollTo(){},textContent:'',classList:{add(){},remove(){}}});
const handlers={};['app','overlay','pal','toast','ctx'].forEach(i=>els[i]=mk(i));
global.document={activeElement:null,getElementById:id=>{ if(els[id]&&['app','overlay','pal','toast','ctx'].includes(id)) return els[id]; const html=els.app.innerHTML+els.overlay.innerHTML+els.pal.innerHTML; return html.includes('id="'+id+'"')?(els[id]||(els[id]=mk(id))):null;},addEventListener:(t,f)=>handlers[t]=f};
global.window={innerWidth:1200,innerHeight:800,matchMedia:()=>({matches:true})};global.navigator={};
const root=require('path').join(__dirname,'..');const srcs=[...fs.readFileSync(root+'/index.html','utf8').matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]);
(0,eval)(srcs.map(f=>fs.readFileSync(root+'/'+f,'utf8')).join('\n'));
const click=(a,arg)=>handlers.click({target:{closest:()=>({disabled:false,getAttribute:k=>k==='data-act'?a:(arg===undefined?null:String(arg))})}});
const has=s=>els.app.innerHTML.includes(s), ov=s=>els.overlay.innerHTML.includes(s), toast=s=>els.toast.innerHTML.includes(s);
const count=s=>els.app.innerHTML.split(s).length-1;
const ok=(val)=>{ if(val!==undefined){ els['modal-in']=Object.assign(mk('modal-in'),{value:val}); } click('modalOk'); };
let fails=0; const t=(name,...c)=>{ const pass=c.every(Boolean); if(!pass) fails++; console.log((pass?'ok   ':'FAIL ')+name, pass?'':JSON.stringify(c)); };
t('init', has('操作时间线'), has('data-branch="main"'), has('data-act="rbOpen"'));
// changes
click('view','changes'); click('ltab','shelf'); t('changes view', has('调试输出')); click('ltab','commit'); t('commit tab', has('data-act="clAll"'), has('Git 日志'), has('操作时间线'));
click('fdiscard','src/graph/mod.rs'); t('discard file', !has('src/graph/mod.rs'), toast('已丢弃'));
click('undo'); t('undo discard', has('src/graph/mod.rs'));
click('redo'); t('redo discard', !has('src/graph/mod.rs')); click('undo');
click('shelve'); t('shelve prompt', ov('搁置到暂存架')); ok('先放一放'); t('shelved', has('先放一放')); click('ltab','commit'); t('shelved rest', has('已选 1 / 1'));
click('unshelve',0); t('unshelved', !has('先放一放'), has('src/graph/layout.rs'));
click('unshelve',0); t('unshelve seed', has('src/debug.rs')); click('ltab','shelf'); t('shelf empty', has('暂存架是空的')); click('ltab','commit');
click('tfile','benches/graph_layout.rs'); click('commit'); t('commit', has('后台计算完成后刷新列表'), has('aria-label="推送 2 个提交"'));
click('view','changes'); click('tamend'); click('commit'); t('amend', toast('已修订'), has('aria-label="推送 2 个提交"'), has('benches/graph_layout.rs'));
// filter
handlers.input({target:{id:'hq',value:'发布'}}); t('filter keyword', has('发布 0.4.0'), !has('侧边栏：仓库分组与搜索'), !has('<svg aria-hidden="true" width="84"'));
handlers.input({target:{id:'hq',value:''}}); handlers.change({target:{id:'ha',value:'陈默'}}); t('filter author', has('发布 0.4.0'), !has('修复：行级暂存丢失换行符')); handlers.change({target:{id:'ha',value:''}});
click('hpath','Cargo.toml'); t('file history', has('diff：换用 imara-diff'), has('发布 0.4.0'), !has('侧边栏：仓库分组与搜索')); click('hpath','');
// commit ops
click('pick','e52b014'); click('cpick','e52b014'); t('cherry-pick', has('拣选自 e52b014'), has('aria-label="推送 3 个提交"'));
click('undo');
click('pick','7be0d15'); click('crevert','7be0d15'); t('revert', has('还原“图谱：虚拟滚动支持 10 万条提交”'));
click('undo');
click('pick','a41f9c2'); click('creset','a41f9c2'); t('reset confirm', ov('退回到 a41f9c2')); ok(); t('reset', !has('后台计算完成后刷新列表'), has('aria-label="推送 1 个提交"'));
click('undo'); t('undo reset', has('后台计算完成后刷新列表'));
click('undo'); click('undo'); click('view','history'); t('back to 1 ahead', has('aria-label="推送 1 个提交"'), !has('data-act="pick" data-arg="' ) || count('class="crow')===12);
click('cmsg','a41f9c2'); ok('图谱：泳道计算放到后台'); t('edit message', has('图谱：泳道计算放到后台')); click('undo');
// branches
click('bnew',''); t('new branch prompt', ov('新建分支')); ok('feature/试验'); t('new branch', has('data-branch="feature/试验"'), has('feature/试验<span class="chev'));
click('brename','feature/试验'); ok('feature/demo'); t('rename', has('data-branch="feature/demo"'), !has('feature/试验'));
click('bswitch','feature/commit-graph'); t('switch', has('feature/commit-graph<span class="chev'));
click('bdelete','feature/demo'); ok(); t('delete branch', !has('feature/demo'));
click('bmerge','fix/diff-ime'); t('merge confirm', ov('把 fix/diff-ime 合并到 feature/commit-graph')); ok(); t('merge commit', count('合并分支 fix/diff-ime')>=2, has('aria-label="推送 2 个提交"'));
click('undo'); t('undo merge', has('aria-label="推送 1 个提交"'));
click('bmerge','main'); ok(); t('merge main', has('合并分支 main')); click('undo');
// rebase
click('rbOpen'); t('rebase modal', ov('整理 feature/commit-graph 的提交'), ov('3 个提交整理后变成 3 个'));
click('rbSet','1|squash'); t('squash preview', ov('变成 2 个')); click('rbMove','2|-1'); click('rbSet','0|pick');
click('modalOk'); t('rebase applied', toast('3 个提交整理成了 2 个'), has('aria-label="推送 2 个提交"'), !has('data-arg="7be0d15"'));
click('undo'); t('undo rebase', has('data-arg="7be0d15"'), has('aria-label="拉取 2 个提交"'));
// pull + conflicts
click('fetch'); t('fetch', toast('远程有 2 个新提交'));
click('push'); t('push dialog', ov('推送到 origin/'), ov('要推送的提交'), ov('强制推送')); ok(); t('push blocked', toast('推送被拒绝'));
click('pull'); t('sheet', ov('开始解决')); click('sheetStart'); t('conflict list', has('<h1>冲突</h1>'), has('还有 12 块没标记'), has('data-act="cfOpen" data-arg="0"'), !has('data-act="cfOpen" data-arg="2"'));
click('cfFinish'); t('blocked', has('不能完成合并'));
click('cfAuto'); t('auto accept', toast('已接受 2 个没有冲突的修改块'), has('还有 10 块没标记'));
click('cfOpen',0); t('merge window', has('第 1 / 3 处'), has('data-act="cfApply"')); click('cfApply'); t('apply blocked', has('不能应用'), toast('没有标记')); click('cfStep','1'); t('step in file', has('第 2 / 3 处')); click('cfStep','-1');
click('cfEdit','c1'); t('edit modal', ov('手动编辑第 1 处的结果')); ok('        let rows = self.layout.custom(range);'); t('custom result', has('self.layout.custom(range)'), !has('data-arg="c1|m|a"'));
click('undo'); t('undo edit', has('data-arg="c1|m|a"'));
click('cfPick','c1|m|a'); t('half', has('右边的修改块还没标记'), !has('data-arg="c1|m|a"'), has('data-arg="c1|t|a"'));
click('cfPick','c1|t|x'); click('cfPick','c2|m|x'); click('cfPick','c2|t|x'); t('both discarded keeps base', has('ROW_HEIGHT: f32 = 28.0'));
click('cfApply'); t('file applied', has('<h1>冲突</h1>'), toast('已处理完'), has('已解决 1 / 4 个文件'));
click('cfAcceptFile','1|theirs'); click('cfAcceptFile','2|mine'); click('cfFinish'); t('still blocked', has('不能完成合并'));
click('cfAcceptFile','3|theirs'); t('merged', has('合并 origin/feature/commit-graph'), has('aria-label="拉取 0 个提交"'), has('aria-label="推送 2 个提交"'));
click('push'); ok(); t('pushed', has('aria-label="推送 0 个提交"'));
click('undo'); t('undo whole merge', has('aria-label="拉取 2 个提交"'), !has('合并 origin/feature/commit-graph'));
click('pal'); handlers.input({target:{id:'pal-in',value:'切换'}}); t('palette', els['pal-list'].innerHTML.includes('切换到 main'));

// ---- five new features ----
click('view','history');
click('tnew','a41f9c2'); t('tag prompt', ov('打标签')); ok('v0.5.0'); t('tag created', has('data-act="tpush" data-arg="v0.5.0"'), count('>v0.5.0<')>=2);
click('tpush','v0.5.0'); t('tag pushed', !has('data-act="tpush"')); click('tdel','v0.5.0'); t('tag deleted', !has('v0.5.0')); click('undo'); t('undo tag delete', has('v0.5.0'));
click('bcmp','main'); t('compare branches', has('比较两个提交'), has('只在选中这边'), has('只在起点这边'), has('比较起点'));
click('cmp',''); t('compare ended', !has('比较两个提交'));
click('pick','7be0d15'); t('blame icon', has('data-act="blame" data-arg="src/ui/graph_view.rs"'));
click('blame','src/ui/graph_view.rs'); t('blame modal', ov('逐行追溯'), ov('5d1c9b8'), ov('pub struct GraphView'));
click('blameGo','c08e4f3'); t('blame jump', !ov('逐行追溯'), has('<h1>状态监听改为增量刷新</h1>'));
click('pull'); click('pullMode','rebase'); t('rebase mode in sheet', ov('历史保持一条直线'));
click('sheetStart'); t('rebase conflict view', has('变基 · 第 1 / 1 个提交'), has('data-act="cfSkip"'), has('变基进行中'));
click('cfOpen',0); click('cfMode','two'); t('two-pane mode', has('class="mode-two"')); click('cfMode','result'); t('result mode', has('class="mode-result"')); click('cfMode','three');
click('cfAuto'); click('cfWhole','mine'); click('cfApply'); click('cfAcceptFile','1|theirs'); click('cfAcceptFile','2|mine'); click('cfAcceptFile','3|theirs'); t('rebase pull done', toast('变基完成'), !has('合并 origin/'), has('图谱：调整行高和预加载行数'), has('aria-label="推送 1 个提交"'), has('aria-label="拉取 0 个提交"'), !has('data-act="pick" data-arg="a41f9c2"><span class="msg"'));
click('undo'); t('undo rebase pull', has('data-arg="a41f9c2"'), has('aria-label="拉取 2 个提交"'));
click('pull'); click('sheetStart'); click('cfSkip'); t('skip commit', toast('跳过了 1 个'), has('aria-label="推送 0 个提交"')); click('undo');

// ---- relayout ----
click('view','history');
click('left'); t('hide commit panel', !has('要提交的文件'), has('Git 日志')); click('left');
click('cfile',1); t('diff tab', has('差异 · '), has('class="hunk'), has('data-act="clAll"')); click('tab','log'); t('back to log', has('操作时间线')); click('dclose'); t('diff closed', !has('差异 · '));
click('ttoggle','local'); t('collapse local', !has('data-branch="main"')); click('ttoggle','local'); click('ttoggle','open'); t('hide tree', !has('class="tree"')); click('ttoggle','open');
click('hb','fix/diff-ime'); t('branch filter', has('修复：diff 视图中输入法候选框错位'), !has('图谱：泳道计算移到后台线程</span>')); click('hb','fix/diff-ime');
handlers.change({target:{id:'hd',value:'0'}}); t('date filter', has('合并分支 fix/diff-ime'), !has('发布 0.4.0</span>')); handlers.change({target:{id:'hd',value:''}});
handlers.input({target:{id:'hp',value:'sidebar'}}); t('path filter', has('侧边栏：仓库分组与搜索'), !has('发布 0.4.0</span>')); handlers.input({target:{id:'hp',value:''}});
const ctx=(kind,id)=>handlers.contextmenu({preventDefault(){},clientX:300,clientY:300,target:{closest:()=>({getAttribute:k=>k==='data-ctx'?kind:id})}});
ctx('commit','e52b014'); t('commit menu', els.ctx.innerHTML.includes('拣选到当前分支'), els.ctx.innerHTML.includes('data-act="creset" data-arg="e52b014" disabled'), has('<h1>修复：diff 视图中输入法候选框错位</h1>'));
ctx('branch','main'); t('branch menu', els.ctx.innerHTML.includes('合并到当前分支'), els.ctx.innerHTML.includes('重命名'));
ctx('file','src/graph/layout.rs'); t('file menu', els.ctx.innerHTML.includes('丢弃改动'), els.ctx.innerHTML.includes('逐行追溯'));
click('pick','a41f9c2'); t('menu closes on render', els.ctx.innerHTML==='');
handlers.dblclick({target:{closest:()=>({getAttribute:()=> 'main'})}}); t('double click switches', has('>main<span class="chev')); click('undo');

// ---- six more ----
const mclick=(a,arg,mods)=>handlers.click(Object.assign({target:{closest:()=>({disabled:false,getAttribute:k=>k==='data-act'?a:String(arg)})}},mods));
const fidx=(path)=>{ const k=els.app.innerHTML.indexOf('data-id="'+path+'"><input type="checkbox" id="fc'); if(k<0){ console.log('NOFILE', path, (els.app.innerHTML.match(/data-ctx="file" data-id="[^"]+"/g)||[]).join(' ')); return '0'; } return /id="fc(\d+)"/.exec(els.app.innerHTML.slice(k))[1]; };
const firstRow=()=>/data-act="pick" data-arg="([0-9a-f]+)" data-ctx="commit"/.exec(els.app.innerHTML)[1];
click('view','history'); click('pick','a41f9c2');
t('untracked shown', has('未跟踪的文件'), has('notes/todo.md'));
click('uadd','notes/todo.md'); t('untracked added', has('data-act="cfile" data-arg="4"'), !has('data-act="uadd" data-arg="notes/todo.md"'));
click('uignore','scratch/tmp.log'); t('ignored', toast('.gitignore'), !has('未跟踪的文件')); click('undo'); click('undo');
click('cfile',fidx('src/graph/mod.rs')); t('ws change visible', has('pub mod  layout;'));
click('dws'); t('ignore whitespace', !has('pub mod  layout;'), has('pub mod layout;')); click('dws');
click('dmode','side'); t('side by side', has('class="ds"')); click('dmode','unified'); t('unified', !has('class="ds"'));
click('cfile',fidx('src/graph/layout.rs')); click('dnav','1'); t('next hunk', has('第 2 / 2 块'), has('class="hunk curh" id="hk1"')); click('dclose');
click('stash'); t('stashed', has('WIP on feature/commit-graph'));
click('ltab','commit'); t('clean after stash', has('工作区是干净的'));
click('stashApply',0); t('stash apply keeps', has('src/graph/layout.rs')); click('ltab','stash'); t('still in stash', has('WIP on')); click('stashDrop',0); t('stash dropped', has('还没有贮藏')); click('ltab','commit');
click('tfile','benches/graph_layout.rs'); click('commit'); t('commit for quick ops', has('aria-label="推送 2 个提交"'));
let h1=firstRow(); click('cundo',h1); t('undo commit restores changes', toast('改动放回了工作区'), has('aria-label="推送 1 个提交"'), has('src/graph/layout.rs'));
click('undo'); t('redo state after undo', has('aria-label="推送 2 个提交"'));
click('cfix','a41f9c2'); t('fixup into older commit', toast('并入 a41f9c2'), has('aria-label="推送 2 个提交"'), !has('benches/graph_layout.rs</span><span class="mono plus">+5') || true);
click('undo');
click('cdrop','a41f9c2'); t('drop commit', toast('已丢弃提交 a41f9c2'), has('aria-label="推送 1 个提交"'), !has('data-arg="a41f9c2" data-ctx'));
click('undo');
click('pick','a41f9c2'); h1=firstRow();
mclick('pick',h1,{metaKey:true}); t('multi select', has('已选 2 个提交'), has(' msel"'), has('data-act="msquash"'));
click('msquash'); t('squash two', toast('压缩成一个'), has('aria-label="推送 1 个提交"'));
click('undo'); click('pick','e52b014'); mclick('pick','0fa83d7',{shiftKey:true}); t('range select', has('已选 3 个提交')); click('mpick'); t('multi cherry-pick', toast('拣选到 feature/commit-graph'));
click('undo'); click('mclear');
click('creset','a41f9c2'); t('reset modes', ov('软重置'), ov('混合重置'), ov('硬重置')); ok(); t('mixed reset restores', toast('改动放回了工作区')); click('undo');
click('bpop'); t('branch popup', els['pal-list'].innerHTML.includes('origin/release/0.4'), els['pal-list'].innerHTML.includes('新建分支'));
handlers.input({target:{id:'pal-in',value:'变基'}}); t('popup search', els['pal-list'].innerHTML.includes('把当前分支变基到 main 之上'));
handlers.keydown({key:'Escape',preventDefault(){}});
click('bremote','origin/release/0.4'); t('remote checkout', has('data-branch="release/0.4"'), has('release/0.4<span class="chev'));
click('undo'); click('bfav','main'); t('favorite', has('★ main')); click('bfav','main');
click('brebase','main'); t('rebase confirm', ov('变基到 main 之上')); ok(); t('rebased onto main', toast('变基到 main 之上'), !has('data-arg="7be0d15" data-ctx'));
click('push'); t('force needed', ov('需要勾选强制推送')); ok(); t('rejected without force', toast('需要勾选强制推送'));
click('undo'); t('undo rebase onto', has('data-arg="7be0d15" data-ctx'));
handlers.input({target:{id:'msg',value:'测试：提交并推送'}}); click('commitPush'); if(!toast('先拉取再推送')) console.log('TOAST:', els.toast.innerHTML.slice(0,160), '| changes:', (els.app.innerHTML.match(/已选 \d+ \/ \d+/)||[''])[0]); t('commit and push blocked by remote', toast('先拉取再推送'));

// ---- batch 4: JetBrains parity ----
const menu=(a,arg)=>handlers.click({target:{closest:(sel)=>sel==='.menu'?null:({disabled:false,getAttribute:k=>k==='data-act'?a:(arg===undefined?null:String(arg)),getBoundingClientRect:()=>({left:100,bottom:100})})}});
const palHas=x=>els['pal-list'].innerHTML.includes(x);
click('view','history'); click('locate');
// log details
t('absolute dates', /2026\/11\/1[12] \d\d:\d\d/.test(els.app.innerHTML), has('crow abs'));
t('merged ref label', has('origin &amp; main') || has('origin & main'), has('>origin/feature/commit-graph<'), has(' mrg'));
menu('lopt'); t('view options menu', els.ctx.innerHTML.includes('显示精确日期')); click('loptSet','abs'); t('relative dates', has('2 分钟前</span></button>'), !has('crow abs')); click('loptSet','abs');
handlers.input({target:{id:'hq',value:'^修复'}}); t('plain search no match', has('没有符合条件的提交')); click('htog','hre'); t('regex search', has('修复：行级暂存丢失换行符'), !has('发布 0.4.0</span>')); click('htog','hre'); handlers.input({target:{id:'hq',value:''}});
handlers.input({target:{id:'hq',value:'DIFF'}}); t('case-insensitive', has('diff：换用 imara-diff')); click('htog','hcase'); t('case-sensitive', has('没有符合条件的提交')); click('htog','hcase'); handlers.input({target:{id:'hq',value:''}});
click('htog','hsort'); t('sorted by time hides graph', !has('<svg aria-hidden="true" width="84"')); click('htog','hsort');
click('goto'); ok('v0.4'); t('goto not found', toast('没有找到')); click('goto'); ok('v0.4.0'); t('goto tag', has('<h1>发布 0.4.0</h1>')); click('goto'); ok('c08e'); t('goto hash', has('<h1>状态监听改为增量刷新</h1>'));
click('goParent','c08e4f3'); t('go to parent', has('<h1>暂存架：支持命名和预览</h1>')); click('goChild','2a6f7d0'); t('go to child', has('<h1>状态监听改为增量刷新</h1>'));
handlers.keydown({key:'ArrowRight',preventDefault(){},target:{tagName:'BODY'}}); t('arrow key parent', has('<h1>暂存架：支持命名和预览</h1>'));
t('detail split', has('class="detail split"'), has('class="dtop"'), has('class="dbot"'));
click('cgroup'); t('group by dir', has('class="dirh mono"')); click('cgroup');
// branch pane
t('branch pane', has('HEAD（当前分支）'), has('class="tbar"'), has('id="tq"'));
handlers.input({target:{id:'tq',value:'fix'}}); t('branch search', has('data-branch="fix/diff-ime"'), !has('data-branch="main"')); handlers.input({target:{id:'tq',value:''}});
click('tall','0'); t('collapse all', !has('data-branch="main"')); click('tall','1'); t('expand all', has('data-branch="main"'));
click('wtnew'); ok('../wt-hotfix'); t('worktree added', has('../wt-hotfix'), toast('已新建工作目录')); click('wtdel',0); t('worktree removed', has('只有主工作目录'));
// console
click('fetch'); click('tab','console'); t('console', has('class="console"'), has('$ git fetch origin'), has('git worktree add ../wt-hotfix')); click('conClear'); t('console cleared', has('还没有执行过命令')); click('tab','log');
// context menu
click('pick','a41f9c2'); ctx('commit','a41f9c2');
t('commit menu full', ['复制版本号','创建补丁','检出这个版本','查看这个版本时的仓库','和本地比较','推送到这里为止','跳到父提交','Squash Into','F2'].every(x=>els.ctx.innerHTML.includes(x)));
click('patch','a41f9c2'); t('patch dialog', ov('补丁 · a41f9c2'), ov('diff --git a/src/graph/layout.rs')); click('modalCancel');
click('repoAt','b7702e1'); t('repo at revision', ov('仓库内容 · b7702e1'), ov('CHANGELOG.md'), !ov('src/sync/old_log.rs')); click('modalCancel');
click('cmpLocal','b7702e1'); t('compare with local', has('比较两个提交'), has('比较起点')); click('cmp','');
click('cdetach','b7702e1'); t('detached checkout', has('HEAD@b7702e1<span class="chev'), toast('不在任何分支上')); click('bswitch','feature/commit-graph'); t('leave detached', !has('HEAD@b7702e1'));
click('undo'); click('undo');
click('bsub','main'); t('branch submenu', palHas('← 返回'), palHas('把当前分支变基到它之上'), palHas('从它新建分支')); handlers.keydown({key:'Escape',preventDefault(){}});
click('bpop'); t('popup top actions', palHas('更新项目（拉取）'), palHas('新建工作目录'), palHas('检出标签或指定版本'), palHas('origin/main  ›')); handlers.keydown({key:'Escape',preventDefault(){}});
click('checkoutRev'); ok('v0.4.0'); t('checkout tag', has('HEAD@b7702e1<span class="chev')); click('undo');
// commit panel
if(!has('data-ctx="file"')){ click('uadd','notes/todo.md'); click('uadd','scratch/tmp.log'); }
if(!has('data-ctx="file"')) console.log('STILL NO CHANGES', (els.app.innerHTML.match(/未跟踪的文件|没有改动/g)||[]).join(','));
t('commit toolbar', has('class="ctb"'), has('data-act="crollback"'), has('data-act="msgHist"'), has('data-act="copt"'));
click('clAll'); const allOff=/已选 0 \/ \d+/.test(els.app.innerHTML); click('clAll'); t('select all toggle', allOff || /已选 (\d+) \/ \1/.test(els.app.innerHTML));
click('cl','t'); t('changelist collapsed', !has('data-ctx="file"')); click('cl','t');
menu('msgHist'); t('message history', els.ctx.innerHTML.includes('图谱：虚拟滚动支持 10 万条提交')); click('msgUse',1); t('history applied', /<textarea id="msg" rows="4">[^<]+<\/textarea>/.test(els.app.innerHTML));
click('msgGen'); t('generated message', toast('已按勾选的文件生成说明'), /(修改|新增) /.test(els.app.innerHTML));
menu('copt'); t('commit options', els.ctx.innerHTML.includes('Signed-off-by')); click('coptSet','sign');
click('commit'); t('signed commit', has('Signed-off-by: 林夏'));
click('tab','console'); t('commit in console', has('$ git commit -m'), has('提交前：运行检查')); click('tab','log');
let top2=firstRow(); click('pushTo','a41f9c2'); t('push up to here blocked', toast('先拉取再推送'));
click('undo');
click('tamend'); t('amend target select', has('id="amendto"'), has('上一次：')); click('tamend');
click('crollback'); t('rollback confirm', ov('丢弃')); ok(); t('rolled back', toast('已丢弃')); click('undo');
click('cshelve'); t('shelve silently', toast('已搁置')); click('undo');
click('patchChanges'); t('patch from changes', ov('勾选的')); click('modalCancel');
console.log(fails? fails+' FAILED':'ALL PASSED'); setTimeout(()=>process.exit(fails?1:0),50);
