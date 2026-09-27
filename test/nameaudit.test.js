'use strict';

/**
 * analyzer.js 控件名称审计纯函数单元测试（Node 环境，无 DOM）。
 * 重点：
 *  - 审计目标集合（button / a[href] / input[type=text]，非法 type 归一化 text）；
 *  - 空白折叠；
 *  - 名称来源优先级（aria-labelledby → aria-label → label → 内容 → title）；
 *  - 多引用按声明顺序拼接；缺失 ID 给诊断但可由后续来源兜底；
 *  - 引用命中重复 ID → 整个名称无法判定（歧义），不回退后续来源；
 *  - 缺名原因按控件种类区分；汇总诊断计数。
 * 运行：npm test
 */

const assert = require('assert');
const {
  isNameAuditTarget,
  collapseWhitespace,
  refDiagnostic,
  missingNameReason,
  pickNameSource,
  buildNameAuditDiagnostics
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

function cand(source, name, opts) {
  return Object.assign({ source: source, name: name, ambiguous: false, refs: [] }, opts || {});
}

console.log('isNameAuditTarget');
test('button 始终在审计范围（大小写不敏感）', () => {
  assert.strictEqual(isNameAuditTarget('button'), true);
  assert.strictEqual(isNameAuditTarget('BUTTON'), true);
});
test('a 仅带 href 时在审计范围', () => {
  assert.strictEqual(isNameAuditTarget('a', undefined, true), true);
  assert.strictEqual(isNameAuditTarget('a', undefined, false), false);
});
test('input 文本类：缺省 / text（DOM 侧 el.type 已把非法值归一化为 text）', () => {
  assert.strictEqual(isNameAuditTarget('input', 'text'), true);
  assert.strictEqual(isNameAuditTarget('input', undefined), true);
  assert.strictEqual(isNameAuditTarget('input', ''), true);
  assert.strictEqual(isNameAuditTarget('input', 'TEXT'), true);
});
test('input 非文本类型不在审计范围', () => {
  ['checkbox', 'radio', 'hidden', 'submit', 'button', 'password', 'email', 'number'].forEach(t => {
    assert.strictEqual(isNameAuditTarget('input', t), false, t);
  });
});
test('其他标签不在审计范围', () => {
  assert.strictEqual(isNameAuditTarget('select'), false);
  assert.strictEqual(isNameAuditTarget('textarea'), false);
  assert.strictEqual(isNameAuditTarget('div'), false);
});

console.log('collapseWhitespace');
test('制表 / 换行 / 连续空白折叠为单空格并去首尾空白', () => {
  assert.strictEqual(collapseWhitespace('  你好\t\n 世界  '), '你好 世界');
  assert.strictEqual(collapseWhitespace('\n\t '), '');
});
test('null / undefined 安全处理', () => {
  assert.strictEqual(collapseWhitespace(null), '');
  assert.strictEqual(collapseWhitespace(undefined), '');
});

console.log('refDiagnostic');
test('ok 引用不产生诊断', () => {
  assert.strictEqual(refDiagnostic({ attr: 'aria-labelledby', id: 'x', state: 'ok' }), null);
});
test('missing / duplicate 产生带 ID 的诊断', () => {
  const m = refDiagnostic({ attr: 'aria-labelledby', id: 'gone', state: 'missing' });
  assert.strictEqual(m.code, 'name-missing-id');
  assert.ok(m.message.includes('gone'));
  const d = refDiagnostic({ attr: 'label[for]', id: 'dup', state: 'duplicate' });
  assert.strictEqual(d.code, 'name-duplicate-id');
  assert.ok(d.message.includes('dup') && d.message.includes('label[for]'));
});

console.log('missingNameReason');
test('文本框 / 按钮 / 链接缺名提示不同', () => {
  assert.ok(missingNameReason('input').message.includes('<label'));
  assert.ok(missingNameReason('button').message.includes('按钮'));
  assert.ok(missingNameReason('a').message.includes('链接'));
});

console.log('pickNameSource · 优先级');
test('首个非空来源胜出，附带其来源名', () => {
  const r = pickNameSource([
    cand('aria-label', ''),
    cand('content', '确定'),
    cand('title', 'T')
  ], 'button');
  assert.strictEqual(r.state, 'named');
  assert.strictEqual(r.name, '确定');
  assert.strictEqual(r.source, 'content');
});
test('aria-labelledby 优先于 aria-label', () => {
  const r = pickNameSource([
    cand('aria-labelledby', '被引用文本'),
    cand('aria-label', '备用')
  ], 'button');
  assert.strictEqual(r.name, '被引用文本');
  assert.strictEqual(r.source, 'aria-labelledby');
});
test('label 优先于 title（文本框）', () => {
  const r = pickNameSource([cand('label', '城市'), cand('title', 'T')], 'input');
  assert.strictEqual(r.source, 'label');
  assert.strictEqual(r.name, '城市');
});
test('全部为空 → missing 并给缺名原因', () => {
  // 候选 name 约定已由 DOM 侧折叠空白：空白串折叠后为 ''
  const r = pickNameSource([cand('aria-label', ''), cand('title', '')], 'a');
  assert.strictEqual(r.state, 'missing');
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.source, null);
  assert.ok(r.reasons.some(x => x.code === 'name-missing'));
});
test('无任何候选 → missing', () => {
  const r = pickNameSource([], 'button');
  assert.strictEqual(r.state, 'missing');
  assert.strictEqual(r.reasons.length, 1);
});

console.log('pickNameSource · 引用');
test('缺失 ID 引用被跳过并保留诊断，后续来源兜底', () => {
  const r = pickNameSource([
    cand('aria-labelledby', '', {
      refs: [{ attr: 'aria-labelledby', id: 'gone', state: 'missing' }]
    }),
    cand('aria-label', '备用名')
  ], 'input');
  assert.strictEqual(r.state, 'named');
  assert.strictEqual(r.name, '备用名');
  assert.ok(r.reasons.some(x => x.code === 'name-missing-id' && x.message.includes('gone')));
});
test('所有引用均缺失 → 名称为空，继续回退', () => {
  const r = pickNameSource([
    cand('aria-labelledby', '', {
      refs: [{ attr: 'aria-labelledby', id: 'a', state: 'missing' }]
    }),
    cand('title', '标题兜底')
  ], 'button');
  assert.strictEqual(r.name, '标题兜底');
  assert.strictEqual(r.source, 'title');
});
test('引用命中重复 ID → ambiguous，不回退后续来源', () => {
  const r = pickNameSource([
    cand('aria-labelledby', '', {
      ambiguous: true,
      refs: [{ attr: 'aria-labelledby', id: 'dup', state: 'duplicate' }]
    }),
    cand('aria-label', '不应被采用')
  ], 'input');
  assert.strictEqual(r.state, 'ambiguous');
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.source, 'aria-labelledby');
  assert.ok(r.reasons.some(x => x.code === 'name-duplicate-id'));
});
test('缺失 + 重复混合：仍为歧义，缺失诊断也保留', () => {
  const r = pickNameSource([
    cand('aria-labelledby', '', {
      ambiguous: true,
      refs: [
        { attr: 'aria-labelledby', id: 'gone', state: 'missing' },
        { attr: 'aria-labelledby', id: 'dup', state: 'duplicate' }
      ]
    })
  ], 'input');
  assert.strictEqual(r.state, 'ambiguous');
  assert.ok(r.reasons.some(x => x.code === 'name-missing-id'));
  assert.ok(r.reasons.some(x => x.code === 'name-duplicate-id'));
  assert.ok(!r.reasons.some(x => x.code === 'name-missing'));
});
test('多引用 ok 不产生原因', () => {
  const r = pickNameSource([
    cand('aria-labelledby', 'A B', {
      refs: [
        { attr: 'aria-labelledby', id: 'a', state: 'ok' },
        { attr: 'aria-labelledby', id: 'b', state: 'ok' }
      ]
    })
  ], 'button');
  assert.strictEqual(r.reasons.length, 0);
});
test('label[for] 重复 ID 歧义由候选标记携带', () => {
  const r = pickNameSource([
    cand('label', null, {
      ambiguous: true,
      refs: [{ attr: 'label[for]', id: 'x', state: 'duplicate' }]
    }),
    cand('title', 'T')
  ], 'input');
  assert.strictEqual(r.state, 'ambiguous');
});

console.log('buildNameAuditDiagnostics');
test('空列表无诊断', () => {
  assert.deepStrictEqual(buildNameAuditDiagnostics([]), []);
});
test('全部有名称 → 无诊断', () => {
  const diags = buildNameAuditDiagnostics([
    { state: 'named', refs: [], label: 'a' },
    { state: 'named', refs: [], label: 'b' }
  ]);
  assert.deepStrictEqual(diags, []);
});
test('缺名 / 歧义 / 缺失 ID / 重复 ID 分别计数告警', () => {
  const diags = buildNameAuditDiagnostics([
    { state: 'missing', refs: [], label: 'b1' },
    { state: 'missing', refs: [], label: 'a1' },
    { state: 'ambiguous', refs: [{ attr: 'aria-labelledby', id: 'd', state: 'duplicate' }], label: 'i1' },
    { state: 'named', refs: [{ attr: 'aria-labelledby', id: 'g', state: 'missing' }], label: 'i2' }
  ]);
  const codes = diags.map(d => d.code);
  assert.ok(codes.includes('name-missing-count'));
  assert.ok(codes.includes('name-ambiguous-count'));
  assert.ok(codes.includes('name-missing-id-count'));
  assert.ok(diags.every(d => d.level === 'warn' || d.level === 'info'));
});
test('诊断消息含数量', () => {
  const diags = buildNameAuditDiagnostics([
    { state: 'missing', refs: [], label: 'x' },
    { state: 'missing', refs: [], label: 'y' }
  ]);
  assert.ok(diags[0].message.includes('2'));
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
