import test from 'node:test';
import assert from 'node:assert/strict';
import { amendBlock, amendSettlement, amendSummaryZh, AmendLine, diffAmend, MAX_AMENDS } from './amend';
import { defaultConfig } from './lineItem';
import { MENU_V1 } from './menu';

const red = (patch = {}) => ({ ...defaultConfig(MENU_V1, 'dry_noodle', 'red'), ...patch });
const soup = defaultConfig(MENU_V1, 'wanton_soup');
const line = (lineId: string, config = red(), quantity = 1): AmendLine => ({ lineId, config, quantity, serviceMode: 'dine_in' });
const base = { fulfillmentStatus: 'preparing' as const, kitchenRouting: 'digital', paymentState: 'unpaid' as const };

test('改单：还没出餐的电子单可以改，收过钱的也可以', () => {
  assert.equal(amendBlock(base), null);
  assert.equal(amendBlock({ ...base, paymentState: 'paid' }), null);
});

test('改单：出餐、取消、取消待确认、纸单、加料单、退过款、改太多次都不能改', () => {
  assert.equal(amendBlock({ ...base, fulfillmentStatus: 'served' }), 'served');
  assert.equal(amendBlock({ ...base, fulfillmentStatus: 'cancelled' }), 'cancelled');
  assert.equal(amendBlock({ ...base, kitchenCancelRequested: true }), 'cancel_pending');
  assert.equal(amendBlock({ ...base, kitchenRouting: 'manual' }), 'manual');
  assert.equal(amendBlock({ ...base, extraOnly: true }), 'extra');
  assert.equal(amendBlock({ ...base, paymentState: 'written_off' }), 'payment');
  assert.equal(amendBlock({ ...base, paymentState: 'paid', refundedSen: 100 }), 'payment');
  assert.equal(amendBlock({ ...base, amendCount: MAX_AMENDS }), 'too_many');
});

test('改单比较：少一碗、面薄换细面、新加一碗、删一碗', () => {
  const before = [line('a', red({ noodleType: 'mee_poh' }), 2), line('b', soup), line('c', red({ spice: 'none' }))];
  const after = [line('a', red({ noodleType: 'thin_egg' }), 1), line('b', soup), line('n', defaultConfig(MENU_V1, 'dry_wanton'))];
  const d = diffAmend(MENU_V1, before, after);
  assert.deepEqual(d.marks, { a: 'mod', n: 'add' });
  assert.deepEqual(d.changes.map((c) => c.kind), ['change', 'add', 'remove']);
  assert.equal(d.changes[0].fromQty, 2);
  assert.equal(d.changes[0].toQty, 1);
  assert.deepEqual(d.changes[0].details, ['面薄→细面']);
  assert.equal(amendSummaryZh(d.changes), '红酱面 · 小 2→1 碗 面薄→细面；加 干捞云吞 · 10粒；删 红酱面 · 小');
});

test('改单比较：没改就没有变化', () => {
  const lines = [line('a'), line('b', soup)];
  assert.deepEqual(diffAmend(MENU_V1, lines, lines.map((l) => ({ ...l }))).changes, []);
});

test('改单比较：换酱、改大小、辣度、加料、打包都写出来', () => {
  const d = diffAmend(MENU_V1, [line('a')], [{ ...line('a', red({ sauce: 'black', size: 'large', spice: 'none', addOns: ['char_siew'] })), serviceMode: 'takeaway' }]);
  assert.deepEqual(d.changes[0].details, ['红酱面→黑酱面', '小→大', '辣→不辣', '加叉烧', '堂食→打包']);
});

test('改单收钱：收过钱的改少了退，改多了补；没收过钱为 null', () => {
  assert.deepEqual(amendSettlement(2300, 2500), { collectSen: 0, refundSen: 200 });
  assert.deepEqual(amendSettlement(2700, 2500), { collectSen: 200, refundSen: 0 });
  assert.equal(amendSettlement(2300, null), null);
  assert.equal(amendSettlement(2300, 0), null);
});
