import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsInText, moneyToSen, parseExplanation, parseExtraction, SchemaError } from './schema';

const base = {
  purchase_date: '2026-10-25', currency: 'MYR', payment: 'unknown', payment_source: null, supplier: null, receipt_number: null,
  discount: null, tax: null, printed_total: null, paid_amount: null, change: null, warnings: [],
  lines: [{ name: '葱', category: 'topping', amount: '10.5', quantity: null, unit: null, payment: null, evidence: null, personal_suggested: false, period_month: null }],
};

test('金额字符串转整数 sen；负数、三位小数、千分位、数字类型都拒绝', () => {
  assert.equal(moneyToSen('10.5', 'x'), 1050);
  assert.equal(moneyToSen('0.05', 'x'), 5);
  assert.equal(moneyToSen(null, 'x'), null);
  for (const bad of ['-5', '12.345', '1,000', 12, '', 'abc']) assert.throws(() => moneyToSen(bad, 'x'), SchemaError, String(bad));
});

test('结构严格：未知字段、缺字段、错误枚举、坏日期、数量 0、超过 50 行都拒绝', () => {
  assert.equal(parseExtraction(base).lines[0].amountSen, 1050);
  assert.throws(() => parseExtraction({ ...base, extra: 1 }), SchemaError);
  const { warnings: _w, ...missing } = base;
  assert.throws(() => parseExtraction(missing), SchemaError);
  assert.throws(() => parseExtraction({ ...base, payment: 'maybe' }), SchemaError);
  assert.throws(() => parseExtraction({ ...base, purchase_date: '2026-13-01' }), SchemaError);
  assert.throws(() => parseExtraction({ ...base, lines: [{ ...base.lines[0], category: 'drinks' }] }), SchemaError);
  assert.throws(() => parseExtraction({ ...base, lines: [{ ...base.lines[0], quantity: '0' }] }), SchemaError);
  assert.throws(() => parseExtraction({ ...base, lines: [{ ...base.lines[0], quantity: 1 }] }), SchemaError);
  assert.throws(() => parseExtraction({ ...base, lines: Array.from({ length: 51 }, () => base.lines[0]) }), SchemaError);
  assert.throws(() => parseExtraction({ ...base, lines: [{ ...base.lines[0], name: 'x'.repeat(61) }] }), SchemaError);
});

test('解释：只能引用后端给的记录 ID 与金额', () => {
  const ids = new Set(['exp-1', 'exp-2']);
  const amounts = new Set([1000, 3200]);
  const ok = parseExplanation({ summary: '本月最大一笔是肉碎 RM32.00。', findings: [{ text: '葱 RM10.00', evidence_ids: ['exp-1'] }], limitations: [] }, ids, amounts);
  assert.equal(ok.findings[0].evidenceIds[0], 'exp-1');
  assert.throws(() => parseExplanation({ summary: 's', findings: [{ text: 't', evidence_ids: ['exp-9'] }], limitations: [] }, ids, amounts), /不存在的记录/);
  assert.throws(() => parseExplanation({ summary: '比上月贵了 RM5.00', findings: [], limitations: [] }, ids, amounts), /账本以外的金额/);
  assert.deepEqual(amountsInText('RM1,234.5 与 RM 7'), [123450, 700]);
});
