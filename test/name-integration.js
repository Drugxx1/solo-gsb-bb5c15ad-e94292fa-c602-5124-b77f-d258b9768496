'use strict';

/**
 * 控件名称审计集成验证（依赖可选的 jsdom，仅本地/CI 可用时运行）：
 * 在真实 Shadow DOM / slot API 下验证 analyzer.js 的名称计算——
 * 来源优先级（aria-labelledby → aria-label → 原生 label → 内容 → title）、
 * 根内 id / label 解析、缺失与重复引用、组合树文本读取与隐藏子树规则。
 * 声明式 shadowrootmode 的解析由浏览器负责（jsdom 不支持 DSD），
 * 这里用 attachShadow 等价构造运行时结构。
 * 运行：npm install --no-save jsdom && node test/name-integration.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = `<!DOCTYPE html><html><body>
  <button id="b-content">保存</button>
  <button id="b-aria" aria-label="关闭">x</button>
  <span id="t1">订单</span><span id="t2"> 详情 </span>
  <button id="b-lb" aria-label="被覆盖" aria-labelledby="t1 t2">x</button>
  <a id="a-title" href="#" title="首页"></a>
  <input id="in-none" type="text">
  <label for="in-for" id="l-for">用户名</label>
  <input id="in-for" type="text">
  <label id="l-wrap">密码 <input id="in-wrap" type="text"></label>
  <label for="in-aria" id="l-aria">被 aria-label 覆盖</label>
  <input id="in-aria" type="text" aria-label="真实名称">
  <button id="b-miss" aria-labelledby="nope" aria-label="回退名称">x</button>
  <span id="dup">甲</span><span id="dup">乙</span>
  <button id="b-dup" aria-labelledby="dup">x</button>
  <span id="h-ref" hidden>隐藏 <span hidden>全部</span> 文字</span>
  <button id="b-hidden-ref" aria-labelledby="h-ref">x</button>
  <button id="b-hidden-content">可见<span hidden>不可见</span><span style="display:none">也不可见</span><span style="visibility:hidden">还是不可见</span></button>
  <span id="r-self" aria-labelledby="r-other">直接文本</span><span id="r-other">间接文本</span>
  <button id="b-norec" aria-labelledby="r-self">x</button>
  <button id="b-nested">前缀<x-in id="x-in-host"><span id="x-in-light">轻文本</span></x-in></button>
  <input id="in-cb" type="checkbox">
  <input id="in-notype">
  <a id="a-nohref">无 href 不审计</a>
  <x-host id="host"><span id="assigned">已分配</span><span slot="nowhere" id="unassigned">未分配</span><button id="b-unassigned" slot="nowhere">未分配按钮</button></x-host>
  <button id="b-host-ref" aria-labelledby="host">x</button>
  <label for="sh-in">文档侧 label（不应关联到 shadow 内）</label>
  <x-ctrl id="xctrl"><span id="doc-only">文档侧文本</span></x-ctrl>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// 分析器内 parent.postMessage（sandbox iframe 形态）：让 parent 指向自身窗口
try { Object.defineProperty(window, 'parent', { value: window, configurable: true }); } catch (e) {}

// postMessage 采集（analyzer 经 setTimeout(0) 发消息，必须在 eval 前注册）
let routePayload = null;
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'route') routePayload = ev.data.payload;
  if (ev.data && ev.data.type === 'error') console.error('analyzer error:', ev.data.message);
});

// ---- 嵌套宿主（按钮内容内的组合文本）----
document.getElementById('x-in-host').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';

// ---- 引用目标宿主：shadow 静态文本 + 默认槽（已分配计入，未分配忽略）----
document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
  '<span>影内</span><slot></slot>';

// ---- 控件位于 shadow 根内：id / label 仅在所属 ShadowRoot 内解析 ----
const xctrl = document.getElementById('xctrl');
const xsr = xctrl.attachShadow({ mode: 'open' });
xsr.innerHTML =
  '<button id="sh-btn" aria-labelledby="doc-only">x</button>' +
  '<span id="sh-t">影内文本</span>' +
  '<button id="sh-btn2" aria-labelledby="sh-t">y</button>' +
  '<input id="sh-in" type="text">' +
  '<label for="sh-in2">影内标签</label>' +
  '<input id="sh-in2" type="text">';

const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analyzer.js'), 'utf8');
window.eval(analyzerSrc);

setTimeout(() => {
  let failures = 0;
  function check(name, cond, extra) {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
  }

  if (!routePayload) {
    console.error('未收到 route 消息');
    process.exit(1);
  }
  const audit = routePayload.nameAudit;
  if (!audit) {
    console.error('路线负载缺少 nameAudit');
    process.exit(1);
  }
  const items = audit.items || [];
  const byId = id => items.find(it => it.label.indexOf('#' + id) >= 0);

  console.log('名称来源优先级');
  const bContent = byId('b-content');
  check('按钮内容作为名称（source=content）',
    bContent && bContent.status === 'named' && bContent.source === 'content' && bContent.name === '保存',
    bContent && bContent.name + '/' + bContent.source);
  check('Tab 顺序中的控件带 1 基序号', bContent && typeof bContent.step === 'number' && bContent.step >= 1);
  const bAria = byId('b-aria');
  check('aria-label 优先于内容',
    bAria && bAria.source === 'aria-label' && bAria.name === '关闭', bAria && bAria.name);
  const bLb = byId('b-lb');
  check('aria-labelledby 优先于 aria-label，多引用按声明顺序拼接',
    bLb && bLb.source === 'aria-labelledby' && bLb.name === '订单 详情', bLb && bLb.name);
  const aTitle = byId('a-title');
  check('空内容链接回退到 title',
    aTitle && aTitle.source === 'title' && aTitle.name === '首页', aTitle && aTitle.name);
  const inFor = byId('in-for');
  check('文本框使用原生 label（for 关联）',
    inFor && inFor.source === 'label' && inFor.name === '用户名', inFor && inFor.name + '/' + inFor.source);
  const inWrap = byId('in-wrap');
  check('文本框使用包裹它的祖先 label',
    inWrap && inWrap.source === 'label' && inWrap.name === '密码', inWrap && inWrap.name);
  const inAria = byId('in-aria');
  check('aria-label 优先于原生 label',
    inAria && inAria.source === 'aria-label' && inAria.name === '真实名称', inAria && inAria.name);
  const inNone = byId('in-none');
  check('全部来源为空 → 缺名（placeholder 不算来源）',
    inNone && inNone.status === 'missing' && inNone.reason === 'no-accessible-name' &&
    inNone.name === null && inNone.message.indexOf('原生 label') >= 0, inNone && inNone.message);

  console.log('id 引用解析（缺失 / 重复 / 根作用域）');
  const bMiss = byId('b-miss');
  check('缺失 id 记诊断并回退到后续来源',
    bMiss && bMiss.status === 'named' && bMiss.source === 'aria-label' && bMiss.name === '回退名称' &&
    bMiss.diagnostics.some(d => d.code === 'missing-reference' && d.message.indexOf('nope') >= 0),
    bMiss && JSON.stringify(bMiss.diagnostics));
  const bDup = byId('b-dup');
  check('引用重复 id → 无法判定（不臆测名称）',
    bDup && bDup.status === 'undetermined' && bDup.reason === 'duplicate-reference' &&
    bDup.name === null && bDup.message.indexOf('2 个匹配') >= 0, bDup && bDup.message);
  const shBtn = byId('sh-btn');
  check('shadow 内控件引用文档侧 id → 根内不存在（记诊断，不跨根解析）',
    shBtn && shBtn.diagnostics.some(d => d.code === 'missing-reference' && d.message.indexOf('ShadowRoot') >= 0) &&
    shBtn.source === 'content' && shBtn.name === 'x',
    shBtn && JSON.stringify(shBtn.diagnostics));
  const shBtn2 = byId('sh-btn2');
  check('shadow 内控件引用同根 id → 正常解析',
    shBtn2 && shBtn2.source === 'aria-labelledby' && shBtn2.name === '影内文本', shBtn2 && shBtn2.name);
  const shIn = byId('sh-in');
  check('文档侧 label[for] 不关联 shadow 内文本框 → 缺名',
    shIn && shIn.status === 'missing', shIn && shIn.status + '/' + shIn.name);
  const shIn2 = byId('sh-in2');
  check('同根 label[for] 正常关联 shadow 内文本框',
    shIn2 && shIn2.source === 'label' && shIn2.name === '影内标签', shIn2 && shIn2.name);

  console.log('组合树文本与隐藏子树规则');
  const bHiddenRef = byId('b-hidden-ref');
  check('直接引用的隐藏节点取整棵子树文字（含隐藏后代）',
    bHiddenRef && bHiddenRef.name === '隐藏 全部 文字' && bHiddenRef.source === 'aria-labelledby',
    bHiddenRef && bHiddenRef.name);
  const bHiddenContent = byId('b-hidden-content');
  check('普通内容跳过 hidden / display:none / visibility:hidden 子树',
    bHiddenContent && bHiddenContent.name === '可见', bHiddenContent && bHiddenContent.name);
  const bNorec = byId('b-norec');
  check('引用目标不再追随其自身的 aria-labelledby',
    bNorec && bNorec.name === '直接文本', bNorec && bNorec.name);
  const bNested = byId('b-nested');
  check('控件内容沿 open Shadow DOM 与 slot 组合树读取',
    bNested && bNested.name === '前缀轻文本', bNested && bNested.name);
  const bHostRef = byId('b-host-ref');
  check('引用宿主节点：shadow 树与已分配轻 DOM 计入，未分配轻 DOM 忽略',
    bHostRef && bHostRef.name === '影内已分配', bHostRef && bHostRef.name);

  console.log('审计范围与统计');
  check('input[type=checkbox] / 无 type 的 input / 无 href 的 a 不参与审计',
    !byId('in-cb') && !byId('in-notype') && !byId('a-nohref'));
  check('未分配轻 DOM 中的控件不参与审计', !byId('b-unassigned'));
  check('审计范围标注正确', audit.scope === 'button, a[href], input[type=text]', audit.scope);
  const st = audit.stats || {};
  check('stats 计数与条目一致',
    st.total === items.length &&
    st.named === items.filter(i => i.status === 'named').length &&
    st.missing === items.filter(i => i.status === 'missing').length &&
    st.undetermined === items.filter(i => i.status === 'undetermined').length,
    JSON.stringify(st));
  check('缺名与无法判定计数符合预期（in-none + sh-in 缺名，b-dup 无法判定）',
    st.missing === 2 && st.undetermined === 1, JSON.stringify(st));
  check('条目带分段选择器与 shadow 信息（可联动高亮 / 导出）',
    items.every(i => typeof i.selector === 'string' && i.selector.length > 0 && i.shadow));

  if (failures) { console.error('\n集成验证存在 ' + failures + ' 个失败'); process.exit(1); }
  console.log('\n集成验证全部通过');
}, 400);
