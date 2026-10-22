/** 菜单 / BOM 发布规则。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBomChanges, applyMenuChanges, BOM_V1, defaultConfig, MENU_V1, normalizeConfig, unitCostUnits, unitPriceSen, validateConfig } from './index';

test('改价生成新版本：Kosong 自动半价；原版本不变；干捞面与汤面各自独立', () => {
  const r = applyMenuChanges(MENU_V1, { prices: { dry_noodle: { small: 800 } }, addOnPrices: { char_siew: 250 }, soldOut: [] }, 'menu-test-1');
  assert.ok(r.ok);
  const small = r.menu.products.dry_noodle.sizes.find((s) => s.id === 'small')!;
  assert.deepEqual([small.priceSen, small.kosongPriceSen], [800, 400]);
  assert.equal(r.menu.products.soup_noodle.sizes.find((s) => s.id === 'small')!.priceSen, 700, '未提交的汤面不变');
  assert.equal(r.menu.version, 'menu-test-1');
  assert.equal(unitPriceSen(r.menu, normalizeConfig(r.menu, { ...defaultConfig(r.menu, 'dry_noodle'), addOns: ['char_siew'] })), 1050);
  assert.equal(MENU_V1.products.dry_noodle.sizes[0].priceSen, 700, '历史版本不被改动');
});

test('改价校验：奇数价破坏 Kosong 半价、超范围、未知品类 / 规格、全部售罄 → 拒绝', () => {
  const prices = { dry_noodle: { small: 701, medium: 10 }, pizza: { x: 100 }, wanton_soup: { large: 900 } } as unknown as Parameters<typeof applyMenuChanges>[1]['prices'];
  const bad = applyMenuChanges(MENU_V1, { prices, addOnPrices: {}, soldOut: ['dry_noodle', 'soup_noodle', 'dry_wanton', 'wanton_soup'] }, 'v');
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.issues.length, 5);
  // 云吞类没有 Kosong，可以是奇数价
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
