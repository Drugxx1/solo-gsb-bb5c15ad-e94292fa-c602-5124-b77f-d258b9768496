'use strict';

/**
 * analyzer.js 控件名称审计纯函数单元测试（Node 环境，无 DOM）。
 * 覆盖：空白折叠、aria-labelledby id 列表解析、名称来源优先级裁决。
 * 运行：npm test
 */

const assert = require('assert');
const {
  collapseWs,
  parseIdList,
  pickNameSource
} = require('../public/analyzer.js');

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

console.log('collapseWs（折叠空白）');
test('null / undefined / 非字符串安全', () => {
  assert.strictEqual(collapseWs(null), '');
  assert.strictEqual(collapseWs(undefined), '');
  assert.strictEqual(collapseWs(''), '');
  assert.strictEqual(collapseWs(0), '0');
});
test('连续空白（空格 / 制表 / 换行）压成单个空格并去首尾', () => {
  assert.strictEqual(collapseWs('  提交   订单  '), '提交 订单');
  assert.strictEqual(collapseWs('a\t\tb\n\nc  d'), 'a b c d');
  // \s 为 Unicode 空白：全角空格（U+3000）同样被折叠
  assert.strictEqual(collapseWs('　　全角空格　　'), '全角空格');
});

console.log('parseIdList（aria-labelledby id 列表）');
test('空值 / 纯空白 → 空数组', () => {
  assert.deepStrictEqual(parseIdList(null), []);
  assert.deepStrictEqual(parseIdList(''), []);
  assert.deepStrictEqual(parseIdList('   '), []);
});
test('多引用按声明顺序，空白折叠', () => {
  assert.deepStrictEqual(parseIdList('t1 t2'), ['t1', 't2']);
  assert.deepStrictEqual(parseIdList('  t1   t2\tt3\n'), ['t1', 't2', 't3']);
});
test('重复声明的 id 原样保留（是否重复由文档侧判定）', () => {
  assert.deepStrictEqual(parseIdList('a a'), ['a', 'a']);
});

console.log('pickNameSource（名称来源优先级裁决）');
test('取首个非空来源', () => {
  const r = pickNameSource([
    { source: 'aria-labelledby', text: '' },
    { source: 'aria-label', text: '关闭' },
    { source: 'content', text: 'x' }
  ]);
  assert.strictEqual(r.name, '关闭');
  assert.strictEqual(r.source, 'aria-label');
});
test('首个非空即停，不比较长短', () => {
  const r = pickNameSource([
    { source: 'content', text: 'x' },
    { source: 'title', text: '更长的标题文本' }
  ]);
  assert.strictEqual(r.source, 'content');
});
test('全部为空 → name/source 均为 null（缺名）', () => {
  const r = pickNameSource([
    { source: 'aria-labelledby', text: '' },
    { source: 'aria-label', text: '' },
    { source: 'title', text: '' }
  ]);
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.source, null);
});
test('空数组 / null / 含空项安全', () => {
  assert.deepStrictEqual(pickNameSource([]), { name: null, source: null });
  assert.deepStrictEqual(pickNameSource(null), { name: null, source: null });
  const r = pickNameSource([null, { source: 'title', text: 't' }]);
  assert.strictEqual(r.source, 'title');
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
