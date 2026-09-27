'use strict';

/**
 * 非 npm 套件的集成验证（依赖可选的 jsdom，仅本地/CI 可用时运行）：
 * 在真实 Shadow DOM API 下验证 analyzer.js 的控件名称审计——
 * 名称来源优先级、多引用拼接、缺失 ID 诊断、重复 ID 歧义、
 * 隐藏节点直接引用取整棵子树、普通内容跳过隐藏子树、
 * 沿 open Shadow DOM / slot 组合树读取文本、ID 引用不跨 shadow 边界、
 * 未分配轻 DOM 不参与审计。
 * 运行：npm install --no-save jsdom && node test/nameaudit-integration.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = `<!DOCTYPE html><html><head><style>
  .gone { display: none; }
  .invisible { visibility: hidden; }
</style></head><body>
  <button id="b-content">确定</button>
  <a id="a-title" href="#" title="标题链接"></a>
  <a id="a-nohref">无 href 锚点（不审计）</a>
  <input type="checkbox" id="cb">
  <input type="hidden" id="hid">

  <label for="inp-for">用户名：</label><input type="text" id="inp-for">
  <label id="wrap-lab"><input type="text" id="inp-wrap">昵称</label>
  <input type="text" id="inp-aria" aria-label="直接命名">
  <span id="city-lbl">城市</span><input type="text" id="inp-ref" aria-labelledby="city-lbl">
  <span id="m-a">账单</span><span id="m-b" hidden>隐藏后缀</span>
  <input type="text" id="inp-multi" aria-labelledby="m-a m-b">
  <input type="text" id="inp-missing" aria-labelledby="no-such" title="title 兜底">
  <span id="dup">第一个</span><span id="dup">第二个</span>
  <input type="text" id="inp-dup" aria-labelledby="dup">
  <button id="b-empty"></button>
  <button id="b-hidden-child">可见<span hidden>不可见文字</span></button>
  <button id="b-display-child">可见<span class="gone">display:none 文字</span></button>
  <button id="b-vis-child">可见<span class="invisible">visibility 文字</span></button>
  <button id="b-direct-hidden"><span hidden><span>直接引用我时整棵照读</span></span></button>
  <input type="text" id="inp-direct" aria-labelledby="b-direct-hidden">
  <input type="text" id="inp-cross" aria-labelledby="shadow-target">

  <x-slot id="xslot">
    <span slot="t">插槽文字</span>
  </x-slot>
  <x-unassigned id="xun">
    <button id="unassigned-b">未分配宿主轻按钮</button>
  </x-unassigned>
  <div id="shadow-host"></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
try { Object.defineProperty(window, 'parent', { value: window, configurable: true }); } catch (e) {}

let routePayload = null;
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'route') routePayload = ev.data.payload;
  if (ev.data && ev.data.type === 'error') console.error('analyzer error:', ev.data.message);
});

// <x-slot>：open 根内按钮的文本由 slot 分配的轻 DOM 组合而成
const xs = document.getElementById('xslot');
const sr = xs.attachShadow({ mode: 'open' });
sr.innerHTML = '<button id="slot-b"><slot name="t">fallback</slot></button>';

// <x-unassigned>：open 根无任何 slot → 宿主轻按钮未分配，不参与名称审计
document.getElementById('xun').attachShadow({ mode: 'open' });

// shadow 内部控件引用同根 ID 可解析；轻树控件引用 shadow 内部 ID 不跨边界
const sh = document.getElementById('shadow-host');
const shr = sh.attachShadow({ mode: 'open' });
shr.innerHTML = '<span id="shadow-target">影子标签</span><input type="text" id="shadow-input" aria-labelledby="shadow-target">';

const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analyzer.js'), 'utf8');
window.eval(analyzerSrc);

setTimeout(() => {
  let failures = 0;
  function check(name, cond, extra) {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
  }

  if (!routePayload) { console.error('未收到 route 消息'); process.exit(1); }
  const audit = routePayload.nameAudit;
  check('payload 含 nameAudit', !!audit);
  const byId = {};
  audit.items.forEach(it => { const m = it.selector.match(/#([\w-]+)/g) || []; m.forEach(x => { byId[x.slice(1)] = it; }); });
  // 简化：用 label 含 id 的优先映射（shadow 内部 id 可能撞车，单独处理）
  function item(id) {
    return audit.items.find(it => it.selector.split('#').pop() === id ||
      it.selector.endsWith('#' + id) || new RegExp('#' + id + '(?![\\w-])').test(it.selector));
  }

  console.log('审计范围');
  check('无 href 的 <a> 不审计', !item('a-nohref'));
  check('checkbox 不审计', !item('cb'));
  check('input[type=hidden] 不审计', !item('hid'));
  check('普通按钮在审计范围', !!item('b-content'));

  console.log('来源优先级');
  check('按钮内容命名', item('b-content').name === '确定' && item('b-content').nameSource === 'content',
    JSON.stringify(item('b-content')));
  check('空内容链接回退 title', item('a-title').name === '标题链接' && item('a-title').nameSource === 'title');
  check('label[for] 关联命名', item('inp-for').name === '用户名：' && item('inp-for').nameSource === 'label',
    JSON.stringify(item('inp-for')));
  check('包裹型 label 命名', item('inp-wrap').name === '昵称' && item('inp-wrap').nameSource === 'label',
    JSON.stringify(item('inp-wrap')));
  check('aria-label 命名', item('inp-aria').name === '直接命名' && item('inp-aria').nameSource === 'aria-label');
  check('aria-labelledby 单引用', item('inp-ref').name === '城市' &&
    item('inp-ref').nameSource === 'aria-labelledby');

  console.log('多引用 / 缺失 / 歧义');
  check('多引用按声明顺序拼接（含隐藏目标）', item('inp-multi').name === '账单 隐藏后缀',
    JSON.stringify(item('inp-multi')));
  const miss = item('inp-missing');
  check('缺失 ID 引用给出诊断', miss.refs.some(r => r.state === 'missing' && r.id === 'no-such'),
    JSON.stringify(miss.refs));
  check('缺失 ID 后回退 title', miss.name === 'title 兜底' && miss.nameSource === 'title');
  const dup = item('inp-dup');
  check('引用重复 ID → 歧义', dup.nameState === 'ambiguous' && dup.name === null,
    JSON.stringify(dup));
  check('歧义原因含重复 ID', dup.refs.some(r => r.state === 'duplicate'));

  console.log('隐藏与组合树文本');
  check('缺名按钮', item('b-empty').nameState === 'missing');
  check('普通内容跳过 [hidden] 子树', item('b-hidden-child').name === '可见',
    JSON.stringify(item('b-hidden-child')));
  check('普通内容跳过 display:none 子树', item('b-display-child').name === '可见',
    JSON.stringify(item('b-display-child')));
  check('普通内容跳过 visibility:hidden 子树', item('b-vis-child').name === '可见',
    JSON.stringify(item('b-vis-child')));
  check('直接引用隐藏节点取整棵子树文字', item('inp-direct').name === '直接引用我时整棵照读',
    JSON.stringify(item('inp-direct')));

  console.log('Shadow DOM');
  const cross = item('inp-cross');
  check('轻树控件不跨 shadow 边界解析 ID（缺失诊断 + 无名称来源）',
    cross.refs.some(r => r.state === 'missing') && cross.nameState === 'missing',
    JSON.stringify(cross));
  const shadowItem = audit.items.find(it => /shadow-input/.test(it.selector));
  check('shadow 内部控件引用同根 ID 可解析', shadowItem && shadowItem.name === '影子标签',
    JSON.stringify(shadowItem));
  const slotItem = audit.items.find(it => /slot-b/.test(it.selector));
  check('按钮文本沿 slot 组合树读取（slotted 轻 DOM）', slotItem && slotItem.name === '插槽文字',
    JSON.stringify(slotItem));
  check('未分配宿主轻按钮不参与名称审计', !audit.items.some(it => /unassigned-b/.test(it.selector)));

  console.log('汇总诊断');
  check('stats 计数存在', audit.stats.controls > 0 && audit.stats.missing >= 1 && audit.stats.ambiguous >= 1,
    JSON.stringify(audit.stats));
  check('汇总诊断含缺名 / 歧义 / 缺失 ID',
    audit.diagnostics.some(d => d.code === 'name-missing-count') &&
    audit.diagnostics.some(d => d.code === 'name-ambiguous-count') &&
    audit.diagnostics.some(d => d.code === 'name-missing-id-count'));

  console.log(failures ? '\n集成验证存在 ' + failures + ' 处失败' : '\n集成验证全部通过');
  process.exit(failures ? 1 : 0);
}, 400);
