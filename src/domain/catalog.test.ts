/** 菜单 / BOM 发布规则。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBomChanges, applyMenuChanges, BOM_V1, defaultConfig, MENU_V1, normalizeConfig, unitCostUnits, unitPriceSen, validateConfig } from './index';

test('改价生成新版本：只改正价时净面价不变；原版本不变；干捞面与汤面各自独立', () => {
  const r = applyMenuChanges(MENU_V1, { prices: { dry_noodle: { small: 800 } }, addOnPrices: { char_siew: 250 }, soldOut: [] }, 'menu-test-1');
  assert.ok(r.ok);
  const small = r.menu.products.dry_noodle.sizes.find((s) => s.id === 'small')!;
  assert.deepEqual([small.priceSen, small.kosongPriceSen], [800, 350], '净面价不再自动半价');
  assert.equal(r.menu.products.soup_noodle.sizes.find((s) => s.id === 'small')!.priceSen, 700, '未提交的汤面不变');
  assert.equal(r.menu.version, 'menu-test-1');
  assert.equal(unitPriceSen(r.menu, normalizeConfig(r.menu, { ...defaultConfig(r.menu, 'dry_noodle'), addOns: ['char_siew'] })), 1050);
  assert.equal(MENU_V1.products.dry_noodle.sizes[0].priceSen, 700, '历史版本不被改动');
  // 正价可以是奇数 sen（不再要求能对半）
  assert.ok(applyMenuChanges(MENU_V1, { prices: { dry_noodle: { small: 750 } }, addOnPrices: {}, soldOut: [] }, 'v').ok);
});

test('净面价单独设定：小 4、中 5、大 6；下单按新净面价算；不能高于正价、没有净面的规格不能设', () => {
  const kp = { small: 400, medium: 500, large: 600 };
  const r = applyMenuChanges(MENU_V1, { prices: {}, addOnPrices: {}, soldOut: [], kosongPrices: { dry_noodle: kp, soup_noodle: kp } }, 'menu-k');
  assert.ok(r.ok);
  for (const k of ['dry_noodle', 'soup_noodle'] as const) {
    assert.deepEqual(r.menu.products[k].sizes.map((s) => [s.priceSen, s.kosongPriceSen]), [[700, 400], [900, 500], [1100, 600]]);
  }
  const kosong = (size: 'small' | 'medium' | 'large') => normalizeConfig(r.menu, { ...defaultConfig(r.menu, 'soup_noodle'), size, isKosong: true });
  assert.deepEqual([unitPriceSen(r.menu, kosong('small')), unitPriceSen(r.menu, kosong('medium')), unitPriceSen(r.menu, kosong('large'))], [400, 500, 600]);
  assert.equal(MENU_V1.products.dry_noodle.sizes[0].kosongPriceSen, 350, '历史版本不被改动');

  const tooHigh = applyMenuChanges(MENU_V1, { prices: {}, addOnPrices: {}, soldOut: [], kosongPrices: { dry_noodle: { small: 800 } } }, 'v');
  assert.equal(tooHigh.ok, false, '净面 RM8 高于小份正价 RM7');
  // 同时把正价降到净面价以下也拒绝（改完再查）
  assert.equal(applyMenuChanges(MENU_V1, { prices: { dry_noodle: { large: 500 } }, addOnPrices: {}, soldOut: [] }, 'v').ok, false);
  assert.ok(applyMenuChanges(MENU_V1, { prices: { dry_noodle: { large: 500 } }, addOnPrices: {}, soldOut: [], kosongPrices: { dry_noodle: { large: 500 } } }, 'v').ok, '净面等于正价可以');
  const noKosong = applyMenuChanges(MENU_V1, { prices: {}, addOnPrices: {}, soldOut: [], kosongPrices: { dry_wanton: { w10: 300 } } }, 'v');
  assert.ok(!noKosong.ok && noKosong.issues[0].message.includes('没有净面'));
  const badValue = applyMenuChanges(MENU_V1, { prices: {}, addOnPrices: {}, soldOut: [], kosongPrices: { dry_noodle: { small: 10, huge: 300 }, pizza: {} } as never }, 'v');
  assert.equal(!badValue.ok && badValue.issues.length, 3, '超范围、未知规格、未知餐品');
});

test('改价校验：超范围、未知品类 / 规格、全部售罄 → 拒绝', () => {
  const prices = { dry_noodle: { small: 10 }, pizza: { x: 100 }, wanton_soup: { large: 900 } } as unknown as Parameters<typeof applyMenuChanges>[1]['prices'];
  const bad = applyMenuChanges(MENU_V1, { prices, addOnPrices: {}, soldOut: ['dry_noodle', 'soup_noodle', 'dry_wanton', 'wanton_soup'] }, 'v');
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.issues.length, 4);
  assert.ok(applyMenuChanges(MENU_V1, { prices: { wanton_soup: { w10: 750 } }, addOnPrices: {}, soldOut: [] }, 'v').ok);
});

test('售罄：新版本里售罄品类不能下单', () => {
  const r = applyMenuChanges(MENU_V1, { prices: {}, addOnPrices: {}, soldOut: ['dry_wanton'] }, 'v');
  assert.ok(r.ok);
  assert.deepEqual(validateConfig(r.menu, defaultConfig(r.menu, 'dry_wanton')).map((i) => i.code), ['SOLD_OUT']);
});

test('BOM 发布：面薄单独定价、标注已校准；面球成本须为偶数', () => {
  const r = applyBomChanges(BOM_V1, { noodleBall: { mee_poh: 950 }, calibrated: ['noodleHalfBall.mee_poh'] }, 'bom-test-1');
  assert.ok(r.ok);
  assert.equal(r.bom.noodleHalfBall.mee_poh, 475);
  assert.equal(r.bom.noodleHalfBall.thin_egg, 425);
  assert.ok(!r.bom.pendingCalibration.includes('noodleHalfBall.mee_poh'));
  const poh = normalizeConfig(MENU_V1, { ...defaultConfig(MENU_V1, 'dry_noodle'), noodleType: 'mee_poh' });
  assert.equal(unitCostUnits(MENU_V1, r.bom, poh) - unitCostUnits(MENU_V1, BOM_V1, poh), 100, '小份 1 面球：成本多 100 单位');
  assert.equal(applyBomChanges(BOM_V1, { noodleBall: { mee_poh: 951 } }, 'v').ok, false);
  assert.equal(applyBomChanges(BOM_V1, { wanton: -1 }, 'v').ok, false);
});
