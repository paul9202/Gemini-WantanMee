/**
 * 经营改版的 AI 用途：估单价与收档小结的结构校验。数字不合理、范围不含估价、小结里出现没给的数字，都算结构错误（交给备用 / 退回白话）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOM_V1 } from '../../../src/domain/bom';
import { buildSummaryFacts, EMPTY_COST_SOURCES, summaryNumbers } from '../../../src/domain/costSources';
import { defaultConfig, linePortions, normalizeConfig } from '../../../src/domain/lineItem';
import { MENU_V1 } from '../../../src/domain/menu';
import { materialUsage } from '../../../src/domain/usage';
import { claudeProvider } from './providers/claude';
import { createMockFetch } from './mockTransport';
import { ESTIMATE_SCHEMA, ESTIMATE_SYSTEM, estimateUserText, parseEstimate, parseSummary, SUMMARY_SCHEMA, SUMMARY_SYSTEM, summaryUserText } from './ownerAi';
import { SchemaError } from './schema';

const price = (key: string, cost: string, low = cost, high = cost) => ({ key, cost_rm: cost, low_rm: low, high_rm: high, basis: '按柔佛一般批发价估' });
const conv = { wantons_per_kg_pork: 100, sheets_per_kg_skin: 300, char_siew_grams_per_portion: 27 };

test('估单价：令吉小数换成 0.1 sen；面团取偶数；范围必须包含估价；换算要合理', () => {
  const r = parseEstimate({ prices: [price('thin_egg', '0.851', '0.7', '1'), price('wanton', '0.24', '0.2', '0.3')], conversions: conv, notes: ['最好拍收据'] });
  assert.deepEqual(r.prices.map((p) => [p.key, p.unitCostUnits]), [['thin_egg', 852], ['wanton', 240]]);
  assert.equal(r.conversions.wantonsPerKgPork, 100);
  assert.throws(() => parseEstimate({ prices: [price('wanton', '0.24', '0.3', '0.4')], conversions: conv, notes: [] }), SchemaError);
  assert.throws(() => parseEstimate({ prices: [price('wanton', '25', '20', '30')], conversions: conv, notes: [] }), SchemaError);
  assert.throws(() => parseEstimate({ prices: [price('wanton', '0.24'), price('wanton', '0.25')], conversions: conv, notes: [] }), SchemaError);
  assert.throws(() => parseEstimate({ prices: [price('beer', '1')], conversions: conv, notes: [] }), SchemaError);
  assert.throws(() => parseEstimate({ prices: [], conversions: { ...conv, wantons_per_kg_pork: 5000 }, notes: [] }), SchemaError);
});

const facts = () => {
  const c = normalizeConfig(MENU_V1, { ...defaultConfig(MENU_V1, 'dry_noodle', 'red'), size: 'medium' });
  const p = linePortions(MENU_V1, c);
  const usage = materialUsage([{ fulfillmentStatus: 'served', items: [{ ...c, quantity: 4, noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount, lineTotalSen: 3600 }] }]);
  return buildSummaryFacts({ date: '2026-11-14', usage, revenueSen: 3600, lastWeek: null, hourly: [{ hour: 8, sen: 3600 }], days: [], stock: [], ballsTarget: 50 });
};

test('小结：三段、标题固定；出现没给的数字就拒绝', () => {
  const f = facts();
  const allowed = summaryNumbers(f);
  const ok = parseSummary({ paragraphs: [{ title: '今天', text: '卖了 4 碗、6 粒面，收入 RM36.00，8 点最旺。' }, { title: '卖得好的', text: '红酱面 4 碗。' }, { title: '明天备料', text: '资料还不够。' }] }, allowed);
  assert.equal(ok.length, 3);
  assert.throws(() => parseSummary({ paragraphs: [{ title: '今天', text: '比上周多了 25%。' }, { title: '卖得好的', text: '红酱面。' }, { title: '明天备料', text: '照旧。' }] }, allowed), /没给的数字/);
  assert.throws(() => parseSummary({ paragraphs: [{ title: '今天', text: 'a' }] }, allowed), SchemaError);
});

test('Emulator 模拟：经真实 Claude 适配器跑估单价与小结，结构都合格', async () => {
  const p = claudeProvider({ apiKey: 'mock-key', model: 'claude-opus-5-5', effort: 'medium', serverFallback: false, fetch: createMockFetch() });
  const ctrl = new AbortController();
  const est = await p.structured({ system: ESTIMATE_SYSTEM, user: estimateUserText({ today: '2026-11-14', bom: BOM_V1, receipt: [], purchases: [], sources: EMPTY_COST_SOURCES }), schema: ESTIMATE_SCHEMA as unknown as Record<string, unknown>, parse: parseEstimate }, ctrl.signal);
  assert.equal(est.value.prices.length, 7);
  const f = facts();
  const sum = await p.structured({ system: SUMMARY_SYSTEM, user: summaryUserText(f), schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>, parse: (raw) => parseSummary(raw, summaryNumbers(f)) }, ctrl.signal);
  assert.equal(sum.value[0].title, '今天');
});
