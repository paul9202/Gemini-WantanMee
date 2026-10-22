/** O11 后厨回执/心跳告警判定；O13 收据内容。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ackState, buildReceipt, defaultConfig, kitchenHealth, MENU_V1, normalizeConfig, ReceiptSource } from './index';

test('O11 后厨回执：<5 秒发送中，5–15 秒等待确认，≥15 秒且心跳过期才醒目告警；有回执即已收到', () => {
  const base = { acceptedAtMs: 0, kitchenAckAtMs: null, kitchenLastSeenMs: 0 };
  assert.equal(ackState({ ...base, nowServerMs: 4_999 }), 'sending');
  assert.equal(ackState({ ...base, nowServerMs: 5_000 }), 'waiting');
  // 15 秒仍未回执，但后厨心跳正常：仍是等待，不夸大为故障
  assert.equal(ackState({ ...base, nowServerMs: 15_000, kitchenLastSeenMs: 10_000 }), 'waiting');
  // 心跳过期（>45 秒）或从未有心跳：告警
  assert.equal(ackState({ ...base, nowServerMs: 60_000, kitchenLastSeenMs: 10_000 }), 'alarm');
  assert.equal(ackState({ ...base, nowServerMs: 15_000, kitchenLastSeenMs: null }), 'alarm');
  assert.equal(ackState({ ...base, nowServerMs: 99_000, kitchenAckAtMs: 1_000, kitchenLastSeenMs: null }), 'acked');
  assert.equal(kitchenHealth(null, 0), 'unknown');
  assert.equal(kitchenHealth(0, 45_000), 'online');
  assert.equal(kitchenHealth(0, 45_001), 'stale');
});

const menu = MENU_V1;
const src = (patch: Partial<ReceiptSource> = {}): ReceiptSource => ({
  storeName: '豪云吞面', receiptNumber: '261022-007', offlineReceiptNumber: null, tokenNumber: 18, serviceMode: 'takeaway',
  source: 'online', acceptedAtMs: Date.UTC(2026, 9, 22, 4, 30), timeQuality: 'server', fulfillmentStatus: 'queued', servedAtMs: null,
  paymentState: 'paid',
  lines: [
    { config: normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'red'), size: 'medium', noodleType: 'mee_poh', scallion: 'none' }), quantity: 2, unitPriceSen: 900 },
    { config: normalizeConfig(menu, { ...defaultConfig(menu, 'soup_noodle'), isKosong: true }), quantity: 1, unitPriceSen: 350 },
  ],
  totalSen: 2150, paymentMethod: 'cash', tenderedSen: 5000, changeSen: 2850, synced: true, ...patch,
});
const text = (d: ReturnType<typeof buildReceipt>) => d.rows.map((r) => `${r.left}|${r.right ?? ''}`).join('\n');

test('O13 未出餐收据：显示当前状态、不编造出餐时间；金额、实收、找零、配置', () => {
  const d = buildReceipt(menu, src(), { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' });
  const t = text(d);
  assert.equal(d.copyLabel, null);
  assert.ok(t.includes('餐牌 18|打包'));
  assert.ok(t.includes('票号|261022-007'));
  assert.ok(t.includes('接单时间|2026/10/22 12:30'));
  assert.ok(t.includes('2 × 红酱面 · 中|RM18.00'));
  assert.ok(t.includes('面薄 · 走青 · 不附送清汤'));
  assert.ok(t.includes('1 × 净面 · 云吞汤面 · 小|RM3.50'));
  assert.ok(!/净面 · 净面/.test(t));
  assert.ok(t.includes('合计|RM21.50'));
  assert.ok(t.includes('实收|RM50.00') && t.includes('找零|RM28.50'));
  assert.ok(t.includes('状态|待制作'));
  assert.ok(!t.includes('出餐时间'));
  assert.ok(!/成本|利润|cost/i.test(t));
});

test('O13 已出餐、重印副本、离线单标识与本机时间', () => {
  const served = buildReceipt(menu, src({ fulfillmentStatus: 'served', servedAtMs: Date.UTC(2026, 9, 22, 4, 38) }), { printIndex: 1, timeZone: 'Asia/Kuala_Lumpur' });
  assert.equal(served.copyLabel, '副本');
  assert.ok(text(served).includes('出餐时间|2026/10/22 12:38'));
  const off = buildReceipt(menu, src({ source: 'offline', receiptNumber: null, offlineReceiptNumber: 'O-F01-0004', timeQuality: 'device_estimated', synced: false, paymentMethod: 'qr_manual', tenderedSen: null, changeSen: null }), { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' });
  assert.deepEqual(off.badges, ['本机接单 / 人工传单', '尚未同步云端']);
  const t = text(off);
  assert.ok(t.includes('临时号|O-F01-0004'));
  assert.ok(!t.includes('票号|'));
  assert.ok(t.includes('接单时间（本机）'));
  assert.ok(t.includes('DuitNow QR|已收款'));
  assert.ok(!t.includes('找零'));
});
