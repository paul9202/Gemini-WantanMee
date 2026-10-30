/** 04 §2 领域规则验收 M01–M13。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLine, BOM_V1, computeTotals, defaultConfig, emptyCart, ENTRY_TILES, formatCostRM, formatCostRMPrecise,
  LineConfig, linePhotoId, linePictograms, linePortions, MENU_V1, NoodleSize, normalizeConfig, parseLineConfig,
  setLineQuantity, setServiceMode, unitCostUnits, unitPriceSen, updateLineConfig, validateConfig,
} from './index';

const menu = MENU_V1;
const noodle = (size: NoodleSize, patch: Partial<LineConfig> = {}): LineConfig =>
  normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'black'), size, ...patch });

test('M01 小/中/大普通面，两种面种：700/900/1100 sen；面球1/1.5/2；云吞3/3/4', () => {
  const expected = { small: [700, 2, 3], medium: [900, 3, 3], large: [1100, 4, 4] } as const;
  for (const noodleType of ['thin_egg', 'mee_poh'] as const) {
    for (const kind of ['dry_noodle', 'soup_noodle'] as const) {
      for (const [size, [price, half, wantons]] of Object.entries(expected)) {
        const cfg = normalizeConfig(menu, { ...defaultConfig(menu, kind), size: size as NoodleSize, noodleType });
        assert.equal(unitPriceSen(menu, cfg), price, `${kind}/${noodleType}/${size}`);
        const p = linePortions(menu, cfg);
        assert.equal(p.noodleHalfUnits, half);
        assert.equal(p.wantonCount, wantons);
        assert.equal(p.charSiewPortions, 1);
      }
    }
  }
});

test('M02 Kosong 严格半价 350/450/550；云吞0、叉烧0；拒绝肉加料', () => {
  for (const [size, price] of [['small', 350], ['medium', 450], ['large', 550]] as const) {
    for (const noodleType of ['thin_egg', 'mee_poh'] as const) {
      const cfg = noodle(size, { isKosong: true, noodleType });
      assert.equal(unitPriceSen(menu, cfg), price);
      assert.equal(unitPriceSen(menu, cfg) * 2, unitPriceSen(menu, noodle(size)));
      const p = linePortions(menu, cfg);
      assert.equal(p.wantonCount, 0);
      assert.equal(p.charSiewPortions, 0);
      assert.equal(p.noodleHalfUnits, linePortions(menu, noodle(size)).noodleHalfUnits);
    }
  }
  const bad = { ...noodle('small'), isKosong: true, addOns: ['char_siew', 'wanton_3'] } as LineConfig;
  const issues = validateConfig(menu, bad).map((i) => i.code);
  assert.deepEqual(issues, ['KOSONG_MEAT_ADDON', 'KOSONG_MEAT_ADDON']);
  // 汤面也允许 Kosong；云吞类不允许
  assert.equal(unitPriceSen(menu, normalizeConfig(menu, { ...defaultConfig(menu, 'soup_noodle'), isKosong: true })), 350);
  assert.deepEqual(
    validateConfig(menu, { ...defaultConfig(menu, 'wanton_soup'), isKosong: true }).map((i) => i.code),
    ['KOSONG_NOT_ALLOWED'],
  );
});

test('M03 开启 Kosong 清除叉烧与云吞加料；关闭不暗中恢复；金额同步', () => {
  const withMeat = noodle('small', { addOns: ['char_siew', 'wanton_3'] });
  assert.equal(unitPriceSen(menu, withMeat), 1100);
  const kosong = normalizeConfig(menu, { ...withMeat, isKosong: true });
  assert.deepEqual(kosong.addOns, []);
  assert.equal(unitPriceSen(menu, kosong), 350);
  assert.equal(linePhotoId(kosong), 'dish.kosong_noodle', 'Kosong 必须换熟净面图');
  const off = normalizeConfig(menu, { ...kosong, isKosong: false });
  assert.deepEqual(off.addOns, []);
  assert.equal(unitPriceSen(menu, off), 700);
});

test('M04 汤面/云吞汤：酱、辣、油渣均为 null，旧字段不串味', () => {
  const dry = noodle('small', { sauce: 'red', spice: 'extra', lard: 'none' });
  for (const kind of ['soup_noodle', 'wanton_soup'] as const) {
    const soup = normalizeConfig(menu, { ...dry, productKind: kind });
    assert.equal(soup.sauce, null);
    assert.equal(soup.spice, null);
    assert.equal(soup.lard, null);
    assert.deepEqual(validateConfig(menu, soup), []);
    const ids = linePictograms(menu, soup, 'dine_in').map((p) => p.id);
    assert.ok(ids.includes('soup:base'));
    assert.ok(!ids.some((id) => id.startsWith('spice:') || id.startsWith('lard:')), '汤品不出现不辣/无油渣');
    // 服务器拒绝残留字段
    assert.deepEqual(
      validateConfig(menu, { ...soup, sauce: 'red', spice: 'none' }).map((i) => i.field),
      ['sauce', 'spice'],
    );
  }
  assert.equal(normalizeConfig(menu, { ...dry, productKind: 'wanton_soup' }).noodleType, null);
});

test('M05 10/15 粒干捞云吞或云吞汤：700/1000；加云吞后 13/18 粒 +200', () => {
  for (const kind of ['dry_wanton', 'wanton_soup'] as const) {
    for (const [size, price, count] of [['w10', 700, 10], ['w15', 1000, 15]] as const) {
      const cfg = normalizeConfig(menu, { ...defaultConfig(menu, kind), size });
      assert.equal(unitPriceSen(menu, cfg), price);
      assert.equal(linePortions(menu, cfg).wantonCount, count);
      const extra = normalizeConfig(menu, { ...cfg, addOns: ['wanton_3'] });
      assert.equal(unitPriceSen(menu, extra), price + 200);
      assert.equal(linePortions(menu, extra).wantonCount, count + 3);
    }
  }
  // 云吞类不可加叉烧
  const dw = { ...defaultConfig(menu, 'dry_wanton'), addOns: ['char_siew'] } as LineConfig;
  assert.deepEqual(validateConfig(menu, dw).map((i) => i.code), ['INVALID_ADDON']);
});

test('M06 小面加叉烧/加云吞/二者：900/900/1100；BOM 各加一次', () => {
  const base = noodle('small');
  const baseCost = unitCostUnits(menu, BOM_V1, base);
  const cs = noodle('small', { addOns: ['char_siew'] });
  const wt = noodle('small', { addOns: ['wanton_3'] });
  const both = noodle('small', { addOns: ['wanton_3', 'char_siew'] });
  assert.deepEqual([cs, wt, both].map((c) => unitPriceSen(menu, c)), [900, 900, 1100]);
  assert.equal(unitCostUnits(menu, BOM_V1, cs) - baseCost, 1200);
  assert.equal(unitCostUnits(menu, BOM_V1, wt) - baseCost, 660);
  assert.equal(unitCostUnits(menu, BOM_V1, both) - baseCost, 1860);
  // 重复加料被拒绝而不是加两次
  assert.ok(validateConfig(menu, { ...base, addOns: ['char_siew', 'char_siew'] }).some((i) => i.code === 'DUPLICATE_ADDON'));
});

test('M07 中面 BOM = 1.5×850+3×220+1200+500 = 3635 单位 = RM3.635', () => {
  const cost = unitCostUnits(menu, BOM_V1, noodle('medium'));
  assert.equal(cost, 3635);
  assert.equal(formatCostRMPrecise(cost), 'RM3.635');
  assert.equal(formatCostRM(cost), 'RM3.64');
});

test('M08 2 份中面打包：包装 400 单位；售价不加包装费；总成本 7670 = RM7.67', () => {
  let cart = setServiceMode(emptyCart(), 'takeaway');
  cart = addLine(menu, cart, noodle('medium'), 'l1', 2);
  const t = computeTotals(menu, BOM_V1, cart);
  assert.equal(t.packagingCostUnits, 400);
  assert.equal(t.totalSen, 1800);
  assert.equal(t.totalCostUnits, 7670);
  assert.equal(formatCostRM(t.totalCostUnits), 'RM7.67');
  // 切回堂食：包装归零，整单重算
  assert.equal(computeTotals(menu, BOM_V1, setServiceMode(cart, 'dine_in')).totalCostUnits, 7270);
});

test('M09 汤品打包保留汤本体；只有干捞餐显示不附送清汤', () => {
  const ids = (c: LineConfig) => linePictograms(menu, c, 'takeaway').map((p) => p.id);
  for (const kind of ['soup_noodle', 'wanton_soup'] as const) {
    const i = ids(defaultConfig(menu, kind));
    assert.ok(i.includes('soup:base'));
    assert.ok(!i.includes('takeaway:no_side_soup'));
  }
  for (const kind of ['dry_noodle', 'dry_wanton'] as const) assert.ok(ids(defaultConfig(menu, kind)).includes('takeaway:no_side_soup'));
  assert.ok(!linePictograms(menu, defaultConfig(menu, 'dry_noodle'), 'dine_in').some((p) => p.id === 'takeaway:no_side_soup'));
});

test('M10 相同配置合并，备注不同不合并；编辑一行不改另一行', () => {
  let cart = emptyCart();
  cart = addLine(menu, cart, noodle('small'), 'a');
  cart = addLine(menu, cart, noodle('small'), 'b');
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0].quantity, 2);
  cart = addLine(menu, cart, noodle('small', { note: '分开装' }), 'c');
  assert.equal(cart.lines.length, 2);
  const edited = updateLineConfig(menu, cart, 'c', noodle('large', { note: '分开装' }));
  assert.equal(edited.lines.find((l) => l.lineId === 'a')!.config.size, 'small');
  assert.equal(edited.lines.find((l) => l.lineId === 'c')!.config.size, 'large');
  // 编辑后与另一行完全相同则并入，不丢数量
  const merged = updateLineConfig(menu, cart, 'c', noodle('small'));
  assert.equal(merged.lines.length, 1);
  assert.equal(merged.lines[0].quantity, 3);
  // 数量减到 0 移除
  assert.equal(setLineQuantity(cart, 'c', 0).lines.length, 1);
});

test('M11 数量 0/负/小数、未知字段、任意单价、未知枚举：拒绝', () => {
  assert.throws(() => addLine(menu, emptyCart(), noodle('small'), 'x', 0));
  assert.throws(() => addLine(menu, emptyCart(), noodle('small'), 'x', -1));
  assert.throws(() => addLine(menu, emptyCart(), noodle('small'), 'x', 1.5));
  assert.throws(() => setLineQuantity(emptyCart(), 'x', 2.5));
  const good = noodle('small');
  assert.equal(parseLineConfig(menu, good).ok, true);
  const withPrice = parseLineConfig(menu, { ...good, unitPriceSen: 1 });
  assert.equal(withPrice.ok, false);
  assert.deepEqual(!withPrice.ok && withPrice.issues, [{ code: 'UNKNOWN_FIELD', field: 'unitPriceSen' }]);
  const badEnum = parseLineConfig(menu, { ...good, spice: 'nuclear' });
  assert.equal(badEnum.ok, false);
  assert.equal(parseLineConfig(menu, { ...good, productKind: 'pizza' }).ok, false);
  assert.equal(parseLineConfig(menu, { ...good, isKosong: 'yes' }).ok, false);
  assert.equal(parseLineConfig(menu, { ...good, note: 'x'.repeat(81) }).ok, false);
  assert.equal(parseLineConfig(menu, null).ok, false);
});

test('M12 细面换面薄：售价/数量相同、面种改变；无面餐 noodleType=null', () => {
  const thin = noodle('large');
  const poh = noodle('large', { noodleType: 'mee_poh' });
  assert.equal(unitPriceSen(menu, thin), unitPriceSen(menu, poh));
  assert.deepEqual(linePortions(menu, thin), linePortions(menu, poh));
  assert.ok(linePictograms(menu, poh, 'dine_in').some((p) => p.id === 'noodle:mee_poh' && p.emphasized));
  for (const kind of ['dry_wanton', 'wanton_soup'] as const) {
    assert.equal(normalizeConfig(menu, { ...poh, productKind: kind, size: 'w10' }).noodleType, null);
    assert.ok(validateConfig(menu, { ...defaultConfig(menu, kind), noodleType: 'mee_poh' }).some((i) => i.code === 'INVALID_NOODLE_TYPE'));
  }
});

test('M13 6 张图片入口映射 4 类；干捞云吞仅红/黑，白酱前后端均拒绝', () => {
  assert.equal(ENTRY_TILES.length, 6);
  assert.deepEqual([...new Set(ENTRY_TILES.map((t) => t.productKind))].sort(), ['dry_noodle', 'dry_wanton', 'soup_noodle', 'wanton_soup']);
  const dryNoodleTiles = ENTRY_TILES.filter((t) => t.productKind === 'dry_noodle');
  assert.deepEqual(dryNoodleTiles.map((t) => t.sauce), ['red', 'black', 'white']);
  for (const t of ENTRY_TILES) {
    const cfg = defaultConfig(menu, t.productKind, t.sauce);
    assert.deepEqual(validateConfig(menu, cfg), [], t.id);
    if (t.sauce && t.productKind === 'dry_noodle') assert.equal(cfg.sauce, t.sauce);
  }
  assert.deepEqual(menu.products.dry_wanton.sauces, ['black', 'red']);
  const white = { ...defaultConfig(menu, 'dry_wanton'), sauce: 'white' } as LineConfig;
  assert.deepEqual(validateConfig(menu, white).map((i) => i.code), ['INVALID_SAUCE']);
  assert.equal(normalizeConfig(menu, white).sauce, 'black', 'UI 规范化不会保留白酱');
});

test('默认配置：小份细面、黑酱、辣、正常油渣、正常葱、无加料', () => {
  const d = defaultConfig(menu, 'dry_noodle');
  assert.deepEqual(d, {
    productKind: 'dry_noodle', size: 'small', noodleType: 'thin_egg', sauce: 'black', spice: 'normal',
    lard: 'normal', scallion: 'normal', isKosong: false, addOns: [], note: '',
  });
});
