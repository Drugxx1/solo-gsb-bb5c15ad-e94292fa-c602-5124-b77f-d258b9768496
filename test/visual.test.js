'use strict';

/**
 * analyzer.js 视觉顺序审计（auditVisualOrder）纯函数单元测试（Node 环境，无 DOM）。
 * 重点：LTR/RTL 行内逆向、跨行逆向、行聚类、零尺寸 / 矩形重叠 /
 * 行归属不唯一 / 跨滚动容器四类「无法判定」，以及无法判定节点不计作无偏差。
 * 运行：npm test
 */

const assert = require('assert');
const { auditVisualOrder } = require('../public/analyzer.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

/** 构造节点（数组顺序即 Tab 顺序；step 为 1 基 Tab 序号） */
function node(step, rect, container) {
  return {
    step,
    selector: '#n' + step,
    label: 'node' + step,
    text: '',
    rect,
    container: container || 'document'
  };
}
function rect(left, top, width, height) {
  return { left, top, width, height };
}

console.log('auditVisualOrder · LTR 基本判定');
test('LTR 同行左→右与 Tab 一致：无偏差、无无法判定', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 10, 80, 20)),
    node(2, rect(200, 10, 80, 20))
  ], { direction: 'ltr' });
  assert.deepStrictEqual(r.deviations, []);
  assert.deepStrictEqual(r.undetermined, []);
  assert.strictEqual(r.stats.comparablePairs, 1);
});

test('LTR 同行逆向 → inline-backward', () => {
  const r = auditVisualOrder([
    node(1, rect(200, 10, 80, 20)),
    node(2, rect(100, 10, 80, 20))
  ], { direction: 'ltr' });
  assert.strictEqual(r.deviations.length, 1);
  const dv = r.deviations[0];
  assert.strictEqual(dv.type, 'inline-backward');
  assert.strictEqual(dv.fromStep, 1);
  assert.strictEqual(dv.toStep, 2);
  assert.strictEqual(dv.fromRow, 1);
  assert.strictEqual(dv.toRow, 1);
  assert.strictEqual(dv.container, 'document');
  assert.ok(typeof dv.message === 'string' && dv.message.length > 0);
});

test('跳回更靠上的行 → row-backward（含行号）', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 100, 80, 20)),
    node(2, rect(100, 10, 80, 20))
  ], { direction: 'ltr' });
  assert.strictEqual(r.deviations.length, 1);
  assert.strictEqual(r.deviations[0].type, 'row-backward');
  assert.strictEqual(r.deviations[0].fromRow, 2);
  assert.strictEqual(r.deviations[0].toRow, 1);
});

test('向下跳行（前进方向）不算偏差', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 10, 80, 20)),
    node(2, rect(100, 100, 80, 20))
  ], { direction: 'ltr' });
  assert.deepStrictEqual(r.deviations, []);
});

console.log('auditVisualOrder · RTL');
test('RTL 行内视觉顺序为右→左', () => {
  // Tab 先到左侧节点：RTL 下视觉顺序相反 → 偏差
  const r = auditVisualOrder([
    node(1, rect(100, 10, 80, 20)),
    node(2, rect(200, 10, 80, 20))
  ], { direction: 'rtl' });
  assert.strictEqual(r.deviations.length, 1);
  assert.strictEqual(r.deviations[0].type, 'inline-backward');

  // Tab 先到右侧节点：与 RTL 视觉顺序一致 → 无偏差
  const ok = auditVisualOrder([
    node(1, rect(200, 10, 80, 20)),
    node(2, rect(100, 10, 80, 20))
  ], { direction: 'rtl' });
  assert.deepStrictEqual(ok.deviations, []);
});

test('RTL 不改变行轴方向（行仍为自上而下）', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 100, 80, 20)),
    node(2, rect(100, 10, 80, 20))
  ], { direction: 'rtl' });
  assert.strictEqual(r.deviations.length, 1);
  assert.strictEqual(r.deviations[0].type, 'row-backward');
});

test('未传方向时默认 LTR', () => {
  const r = auditVisualOrder([
    node(1, rect(200, 10, 80, 20)),
    node(2, rect(100, 10, 80, 20))
  ]);
  assert.strictEqual(r.direction, 'ltr');
  assert.strictEqual(r.deviations.length, 1);
});

console.log('auditVisualOrder · 行聚类');
test('垂直错位但充分重叠的节点仍属同一行', () => {
  const r = auditVisualOrder([
    node(1, rect(300, 12, 80, 20)),
    node(2, rect(100, 10, 80, 20)),
    node(3, rect(200, 14, 80, 20))
  ], { direction: 'ltr' });
  // 视觉顺序为 2 → 3 → 1：对 (1,2) 行内逆向；对 (2,3) 一致
  assert.strictEqual(r.deviations.length, 1);
  assert.strictEqual(r.deviations[0].type, 'inline-backward');
  assert.strictEqual(r.deviations[0].fromStep, 1);
  assert.strictEqual(r.deviations[0].toStep, 2);
  assert.deepStrictEqual(r.undetermined, []);
});

console.log('auditVisualOrder · 无法判定');
test('零尺寸节点 → zero-size，相关相邻对不评判（不计作无偏差）', () => {
  const r = auditVisualOrder([
    node(1, rect(300, 10, 80, 20)),
    node(2, rect(0, 0, 0, 0)),
    node(3, rect(100, 10, 80, 20))
  ], { direction: 'ltr' });
  const u = r.undetermined.find(x => x.step === 2);
  assert.ok(u && u.reason === 'zero-size');
  assert.ok(typeof u.message === 'string' && u.message.length > 0);
  // 1 与 3 视觉相反但不相邻（中间隔了 2）：不得判为偏差
  assert.strictEqual(r.stats.comparablePairs, 0);
  assert.deepStrictEqual(r.deviations, []);
});

test('矩形正面积重叠 → rect-overlap（两个节点都标记）；仅共边不算重叠', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 10, 100, 30)),
    node(2, rect(150, 15, 100, 30))
  ], { direction: 'ltr' });
  assert.strictEqual(r.undetermined.length, 2);
  assert.ok(r.undetermined.every(x => x.reason === 'rect-overlap'));
  assert.strictEqual(r.stats.comparablePairs, 0);

  const touch = auditVisualOrder([
    node(1, rect(100, 10, 50, 20)),
    node(2, rect(150, 10, 50, 20))
  ], { direction: 'ltr' });
  assert.deepStrictEqual(touch.undetermined, []);
  assert.strictEqual(touch.stats.comparablePairs, 1);
});

test('垂直区间跨越多行的节点 → row-ambiguous，其余节点不受影响', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 0, 80, 20)),
    node(2, rect(100, 40, 80, 20)),
    node(3, rect(300, 10, 40, 60)) // 高节点跨越两行
  ], { direction: 'ltr' });
  const u = r.undetermined.find(x => x.step === 3);
  assert.ok(u && u.reason === 'row-ambiguous');
  assert.ok(!r.undetermined.some(x => x.step === 1 || x.step === 2));
  // 对 (1,2) 仍可判定：从上到下前进，无偏差；对 (2,3) 不评判
  assert.strictEqual(r.stats.comparablePairs, 1);
  assert.deepStrictEqual(r.deviations, []);
});

test('跨滚动容器的相邻对 → cross-scroll-container，对不评判', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 10, 80, 20), 'document'),
    node(2, rect(100, 20, 80, 20), 'c1'),
    node(3, rect(300, 20, 80, 20), 'c1')
  ], { direction: 'ltr' });
  const u1 = r.undetermined.find(x => x.step === 1);
  const u2 = r.undetermined.find(x => x.step === 2);
  assert.ok(u1 && u1.reason === 'cross-scroll-container');
  assert.ok(u2 && u2.reason === 'cross-scroll-container');
  assert.ok(typeof u1.message === 'string' && u1.message.indexOf('第 2 步') >= 0);
  // 第 3 个节点与第 2 个同容器：跨容器标记不妨碍同容器对 (2,3) 评判
  assert.ok(!r.undetermined.some(x => x.step === 3));
  assert.strictEqual(r.stats.comparablePairs, 1);
  // 跨容器对不计入可判定对数，也不产生偏差
  assert.deepStrictEqual(r.deviations, []);
});

console.log('auditVisualOrder · 统计与输出形状');
test('stats 汇总正确', () => {
  const r = auditVisualOrder([
    node(1, rect(200, 10, 80, 20)),  // 与 2 同行逆向
    node(2, rect(100, 10, 80, 20)),
    node(3, rect(0, 0, 0, 0)),       // 零尺寸
    node(4, rect(100, 100, 80, 20))
  ], { direction: 'ltr' });
  assert.strictEqual(r.stats.nodes, 4);
  assert.strictEqual(r.stats.pairs, 3);
  assert.strictEqual(r.stats.comparablePairs, 1); // 仅 (1,2)
  assert.strictEqual(r.stats.deviationCount, 1);
  assert.strictEqual(r.stats.undeterminedCount, 1);
});

test('无法判定条目按 Tab 序号排序', () => {
  const r = auditVisualOrder([
    node(1, rect(100, 10, 80, 20), 'document'),
    node(2, rect(100, 20, 80, 20), 'c1'), // 与 1 跨容器
    node(3, rect(0, 0, 0, 0))
  ], { direction: 'ltr' });
  const steps = r.undetermined.map(x => x.step);
  assert.deepStrictEqual(steps, [1, 2, 3]);
});

test('偏差与无法判定条目包含联动高亮与导出所需字段', () => {
  const r = auditVisualOrder([
    node(1, rect(200, 10, 80, 20)),
    node(2, rect(100, 10, 80, 20)),
    node(3, rect(0, 0, 0, 0))
  ], { direction: 'ltr' });
  const dv = r.deviations[0];
  assert.ok(dv.fromSelector && dv.toSelector);
  assert.ok(dv.fromLabel && dv.toLabel);
  assert.strictEqual(dv.fromVisual, 2);
  assert.strictEqual(dv.toVisual, 1);
  const u = r.undetermined[0];
  assert.ok(u.selector && u.label && u.reason && typeof u.message === 'string');
  assert.strictEqual(u.container, 'document');
});

test('空输入 → 空结果、零统计', () => {
  const r = auditVisualOrder([], { direction: 'ltr' });
  assert.strictEqual(r.direction, 'ltr');
  assert.deepStrictEqual(r.deviations, []);
  assert.deepStrictEqual(r.undetermined, []);
  assert.strictEqual(r.stats.nodes, 0);
  assert.strictEqual(r.stats.pairs, 0);
  assert.strictEqual(r.stats.comparablePairs, 0);
});

test('null / undefined 输入安全', () => {
  assert.strictEqual(auditVisualOrder(null).stats.nodes, 0);
  assert.strictEqual(auditVisualOrder(undefined, null).direction, 'ltr');
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
