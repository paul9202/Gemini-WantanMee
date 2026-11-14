/** 菜单 / BOM 发布、D09 旧价离线单、售罄、成员邀请与停用（Emulator）。 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { admin, cleanupClients, newClient, noodle, orderPayload, placeOrder, setupStore, StoreFixture, uuid } from './harness';
import { defaultConfig, MENU_V1 } from '../../src/domain';

after(cleanupClients);

const cfg = (f: StoreFixture) => admin().doc(`stores/${f.storeId}/config/public`).get().then((s) => s.data()!);
const noodlePrices = (small: number) => ({ dry_noodle: { small }, soup_noodle: { small } });

function offline(f: StoreFixture, menuVersion: string, totalSen: number, config: unknown = noodle(), tokenNumber = 30) {
  return {
    eventId: uuid(), registerId: f.claim.registerId, deviceId: f.claim.deviceId, registerEpoch: f.claim.registerEpoch, sequence: f.seq.value + 1,
    shiftId: f.shiftId, type: 'offline_order_created', occurredAtDeviceMs: Date.now(), lastServerOffsetMs: 0,
    payload: {
      clientOrderId: uuid(), offlineReceiptNumber: `O-F01-${tokenNumber}`, tokenNumber, serviceMode: 'dine_in', menuVersion,
      lines: [{ lineId: uuid(), config, quantity: 1 }], totalSen, payment: { method: 'cash', tenderedSen: totalSen, qrExternalVerificationNote: null },
    },
  };
}

test('发布菜单：新价生效；旧版本在线单 MENU_CHANGED；越权、过期版本、净面高于正价被拒绝', async () => {
  const f = await setupStore();
  const pub = (extra: Record<string, unknown>, who = f.owner) => who.code('publishMenu', { storeId: f.storeId, operationId: uuid(), baseVersion: MENU_V1.version, addOnPrices: {}, soldOut: [], ...extra });
  assert.equal(await pub({ prices: noodlePrices(800) }, f.cashier), 'FORBIDDEN');
  assert.equal(await pub({ prices: {}, kosongPrices: { dry_noodle: { small: 800 } } }), 'INVALID_ARGUMENT', '净面 RM8 高于正价 RM7');
  assert.equal(await pub({ prices: {}, kosongPrices: 'cheap' }), 'INVALID_ARGUMENT');
  const r = await f.owner.call<{ version: string; basedOn: string }>('publishMenu', { storeId: f.storeId, operationId: uuid(), baseVersion: MENU_V1.version, prices: noodlePrices(800), addOnPrices: { char_siew: 250 }, soldOut: [] });
  assert.equal(r.basedOn, MENU_V1.version);
  assert.match(r.version, /^menu-\d{8}-01$/);
  assert.equal((await cfg(f)).activeMenuVersion, r.version);
  assert.equal(await pub({ prices: noodlePrices(900) }), 'STALE_VERSION', '必须基于当前启用版本修改');
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 1 })), 'MENU_CHANGED');
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 1, menuVersion: r.version })), 'PRICE_MISMATCH', '旧价 700 被拒');
  const ok = await placeOrder(f, { tokenNumber: 1, menuVersion: r.version, expectedTotalSen: 800 });
  assert.equal(ok.result.totalSen, 800);
  const order = (await admin().doc(`stores/${f.storeId}/orders/${ok.result.orderId}`).get()).data()!;
  assert.equal(order.menuVersion, r.version);
  // 收银可以读取启用的菜单版本（离线时也要用）；后厨不能读售价
  const menuDoc = await getDoc(doc(f.cashier.db, `stores/${f.storeId}/menuVersions/${r.version}`));
  assert.equal(menuDoc.data()!.menu.addOns.char_siew.priceSen, 250);
  await assert.rejects(getDoc(doc(f.kitchen.db, `stores/${f.storeId}/menuVersions/${r.version}`)), /permission/i);
});

test('净面价单独设定：发布小 4 / 中 5 / 大 6 后，净面单按新净面价收；只改正价不动净面价', async () => {
  const f = await setupStore();
  const kp = { small: 400, medium: 500, large: 600 };
  const r = await f.owner.call<{ version: string }>('publishMenu', { storeId: f.storeId, operationId: uuid(), baseVersion: MENU_V1.version, prices: {}, kosongPrices: { dry_noodle: kp, soup_noodle: kp }, addOnPrices: {}, soldOut: [] });
  const menu = (await admin().doc(`stores/${f.storeId}/menuVersions/${r.version}`).get()).data()!.menu;
  for (const k of ['dry_noodle', 'soup_noodle']) {
    assert.deepEqual(menu.products[k].sizes.map((s: { priceSen: number; kosongPriceSen: number }) => [s.priceSen, s.kosongPriceSen]), [[700, 400], [900, 500], [1100, 600]]);
  }
  const k = await placeOrder(f, { tokenNumber: 1, menuVersion: r.version, lines: [{ config: noodle({ isKosong: true, size: 'medium' }), quantity: 1 }], expectedTotalSen: 500 });
  assert.equal(k.result.totalSen, 500);
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 2, menuVersion: r.version, lines: [{ config: noodle({ isKosong: true, size: 'medium' }), quantity: 1 }], expectedTotalSen: 450 })), 'PRICE_MISMATCH', '旧净面价 4.50 被拒');
  // 之后只改正价（旧版设置页不传净面价）：净面价保持 4 / 5 / 6
  const r2 = await f.owner.call<{ version: string }>('publishMenu', { storeId: f.storeId, operationId: uuid(), baseVersion: r.version, prices: noodlePrices(800), addOnPrices: {}, soldOut: [] });
  const m2 = (await admin().doc(`stores/${f.storeId}/menuVersions/${r2.version}`).get()).data()!.menu;
  assert.deepEqual(m2.products.dry_noodle.sizes[0], { ...m2.products.dry_noodle.sizes[0], priceSen: 800, kosongPriceSen: 400 });
});

test('D09 离线期间改价/售罄：按成交时的历史版本入账，不追收差额；未知版本隔离', async () => {
  const f = await setupStore();
  const r = await f.owner.call<{ version: string }>('publishMenu', { storeId: f.storeId, operationId: uuid(), baseVersion: MENU_V1.version, prices: noodlePrices(800), addOnPrices: {}, soldOut: ['dry_wanton'] });
  const sync = async (e: ReturnType<typeof offline>) => {
    const res = await f.cashier.call<{ results: { status: string; reasonCode?: string; orderId?: string }[] }>('syncOfflineEvents', { storeId: f.storeId, events: [e] });
    f.seq.value = e.sequence;
    return res.results[0];
  };
  const oldPrice = await sync(offline(f, MENU_V1.version, 700, noodle(), 31));
  assert.equal(oldPrice.status, 'accepted', '旧版本旧价成交被接纳');
  const o = (await admin().doc(`stores/${f.storeId}/orders/${oldPrice.orderId}`).get()).data()!;
  assert.deepEqual([o.totalSen, o.menuVersion, o.menuVersionCurrent], [700, MENU_V1.version, r.version], '记录版本差异');
  // 新版本里售罄的干捞云吞：离线时用旧版本成交，仍入账
  const soldOutOffline = await sync(offline(f, MENU_V1.version, 700, defaultConfig(MENU_V1, 'dry_wanton'), 32));
  assert.equal(soldOutOffline.status, 'accepted');
  assert.equal((await sync(offline(f, r.version, 800, noodle(), 33))).status, 'accepted');
  assert.equal((await sync(offline(f, 'menu-19990101-99', 700, noodle(), 34))).reasonCode, 'MENU_UNKNOWN');
  // 在线：售罄的品类不能下单
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 2, menuVersion: r.version, lines: [{ config: defaultConfig(MENU_V1, 'dry_wanton'), quantity: 1 }] })), 'INVALID_MODIFIER');
});

test('发布 BOM：面薄单独成本只影响之后的订单；收银不能发布', async () => {
  const f = await setupStore();
  const poh = noodle({ noodleType: 'mee_poh' });
  const before = await placeOrder(f, { tokenNumber: 1, lines: [{ config: poh, quantity: 1 }] });
  assert.equal(await f.cashier.code('publishBom', { storeId: f.storeId, operationId: uuid(), baseVersion: 'bom-2026-10-v1', noodleBall: { mee_poh: 950 } }), 'FORBIDDEN');
  assert.equal(await f.owner.code('publishBom', { storeId: f.storeId, operationId: uuid(), baseVersion: 'bom-2026-10-v1', noodleBall: { mee_poh: 951 } }), 'INVALID_ARGUMENT');
  const r = await f.owner.call<{ version: string }>('publishBom', { storeId: f.storeId, operationId: uuid(), baseVersion: 'bom-2026-10-v1', noodleBall: { mee_poh: 950 }, calibrated: ['noodleHalfBall.mee_poh'] });
  assert.equal((await cfg(f)).activeBomVersion, r.version);
  const after = await placeOrder(f, { tokenNumber: 2, lines: [{ config: poh, quantity: 1 }] });
  const cost = (id: string) => admin().doc(`stores/${f.storeId}/orderCosts/${id}`).get().then((s) => s.data()!);
  assert.equal((await cost(before.result.orderId)).totalCostUnits, 3430, '旧单成本不变');
  assert.equal((await cost(after.result.orderId)).totalCostUnits, 3530);
  assert.equal((await cost(after.result.orderId)).bomVersion, r.version);
  const bomDoc = (await admin().doc(`stores/${f.storeId}/bomVersions/${r.version}`).get()).data()!;
  assert.ok(!bomDoc.bom.pendingCalibration.includes('noodleHalfBall.mee_poh'));
});

test('邀请成员：创建账号并返回设置密码链接；员工设密码后按岗位工作；停用后立即失效；收银不能邀请', async () => {
  const f = await setupStore();
  const email = `staff-${uuid().slice(0, 6)}@hao.test`;
  assert.equal(await f.cashier.code('inviteMember', { storeId: f.storeId, operationId: uuid(), email, role: 'kitchen', displayName: '二厨' }), 'FORBIDDEN');
  assert.equal(await f.owner.code('inviteMember', { storeId: f.storeId, operationId: uuid(), email: 'not-an-email', role: 'kitchen', displayName: '二厨' }), 'INVALID_ARGUMENT');
  const inv = await f.owner.call<{ memberUid: string; created: boolean; setupLink: string }>('inviteMember', { storeId: f.storeId, operationId: uuid(), email, role: 'kitchen', displayName: '二厨' });
  assert.equal(inv.created, true);
  const oobCode = new URL(inv.setupLink).searchParams.get('oobCode');
  assert.ok(oobCode, inv.setupLink);
  // 员工用链接设置密码（Auth Emulator 的同一接口）
  const pw = `pw-${uuid()}`;
  const reset = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode, newPassword: pw }),
  });
  assert.equal(reset.status, 200);
  const member = (await admin().doc(`stores/${f.storeId}/members/${inv.memberUid}`).get()).data()!;
  assert.deepEqual([member.role, member.active, member.email], ['kitchen', true, email]);
  // 员工用自己设定的密码登录
  const staff = await newClient('staff-check', false);
  await signInWithEmailAndPassword(getAuth(staff.app), email, pw);
  assert.equal(await staff.code('heartbeatDevice', { storeId: f.storeId, deviceId: 'kds-2' }), 'OK');
  assert.equal(await staff.code('createOrder', orderPayload(f, { tokenNumber: 3 })), 'FORBIDDEN', '后厨岗位不能下单');
  // 重复邀请同一邮箱：不重复创建账号
  const again = await f.owner.call<{ created: boolean; memberUid: string }>('inviteMember', { storeId: f.storeId, operationId: uuid(), email, role: 'cashier', displayName: '二厨' });
  assert.deepEqual([again.created, again.memberUid], [false, inv.memberUid]);
  await f.owner.call('manageMember', { storeId: f.storeId, operationId: uuid(), memberUid: inv.memberUid, role: 'cashier', active: false, displayName: '二厨', reason: '离职' });
  const after = (await admin().doc(`stores/${f.storeId}/members/${inv.memberUid}`).get()).data()!;
  assert.deepEqual([after.active, after.email], [false, email], '停用后保留邮箱');
  assert.equal(await staff.code('heartbeatDevice', { storeId: f.storeId, deviceId: 'kds-2' }), 'NOT_A_MEMBER');
});

// ───────── 经营改版：确认单价、换算、收档点数、小结（Emulator） ─────────

test('确认单价：发布新 BOM、记下来源并清掉 AI 建议；收银不能确认；过期版本被拒；跟现在一样只记来源', async () => {
  const f = await setupStore();
  const src = () => admin().doc(`stores/${f.storeId}/config/costSources`);
  await src().set({ suggestions: { wanton: { kind: 'ai', unitCostUnits: 240, lowUnits: 200, highUnits: 300, basis: '估', atMs: 1, provider: 'claude', model: 'm' } } });
  const accept = (items: unknown[], baseVersion = 'bom-2026-10-v1', who = f.owner) => who.code('acceptUnitCosts', { storeId: f.storeId, operationId: uuid(), baseVersion, items });
  assert.equal(await accept([{ key: 'wanton', unitCostUnits: 240, kind: 'ai', basis: '估' }], undefined, f.cashier), 'FORBIDDEN');
  assert.equal(await accept([{ key: 'wanton', unitCostUnits: 0, kind: 'ai', basis: '估' }]), 'INVALID_ARGUMENT');
  const r = await f.owner.call<{ version: string; published: boolean }>('acceptUnitCosts', {
    storeId: f.storeId, operationId: uuid(), baseVersion: 'bom-2026-10-v1',
    items: [{ key: 'wanton', unitCostUnits: 240, kind: 'ai', basis: 'AI 估 · 肉碎 RM19/kg' }, { key: 'mee_poh', unitCostUnits: 899, kind: 'receipt', basis: '11/10 进货 60 粒 RM54.00', ref: 'b1' }],
  });
  assert.ok(r.published);
  assert.equal((await cfg(f)).activeBomVersion, r.version);
  const bom = (await admin().doc(`stores/${f.storeId}/bomVersions/${r.version}`).get()).data()!.bom;
  assert.equal(bom.wanton, 240);
  assert.equal(bom.noodleHalfBall.mee_poh, 450, '面团单价取偶数后平分成半粒');
  assert.ok(!bom.pendingCalibration.includes('noodleHalfBall.mee_poh'));
  const s = (await src().get()).data()!;
  assert.equal(s.prices.wanton.kind, 'ai');
  assert.equal(s.prices.mee_poh.ref, 'b1');
  assert.equal(s.suggestions.wanton, undefined);
  assert.equal(await accept([{ key: 'wanton', unitCostUnits: 250, kind: 'owner', basis: '改' }]), 'STALE_VERSION');
  const same = await f.owner.call<{ version: string; published: boolean }>('acceptUnitCosts', { storeId: f.storeId, operationId: uuid(), baseVersion: r.version, items: [{ key: 'packaging', unitCostUnits: 200, kind: 'owner', basis: '对' }] });
  assert.equal(same.published, false);
  assert.equal((await src().get()).data()!.prices.packaging.kind, 'owner');
});

test('换算与收档点数：范围检查；点数写入营业日；小结在没有 AI 时给白话', async () => {
  const f = await setupStore();
  assert.equal(await f.owner.code('setCostConversions', { storeId: f.storeId, operationId: uuid(), values: { wantonsPerKgPork: 5 } }), 'INVALID_ARGUMENT');
  await f.owner.call('setCostConversions', { storeId: f.storeId, operationId: uuid(), values: { wantonsPerKgPork: 90 } });
  assert.equal((await admin().doc(`stores/${f.storeId}/config/costSources`).get()).data()!.conversions.wantonsPerKgPork.value, 90);
  assert.equal(await f.owner.code('recordStockCount', { storeId: f.storeId, operationId: uuid(), counts: [{ ingredientId: 'ing-salt', quantity: 1 }] }), 'INVALID_ARGUMENT');
  assert.equal(await f.cashier.code('recordStockCount', { storeId: f.storeId, operationId: uuid(), counts: [{ ingredientId: 'ing-mee-poh', quantity: 8 }] }), 'FORBIDDEN');
  const sc = await f.owner.call<{ ids: string[]; businessDate: string }>('recordStockCount', { storeId: f.storeId, operationId: uuid(), counts: [{ ingredientId: 'ing-mee-poh', quantity: 8 }, { ingredientId: 'ing-minced-pork', quantity: 1.5 }] });
  const doc0 = (await admin().doc(`stores/${f.storeId}/stockCounts/${sc.ids[1]}`).get()).data()!;
  assert.equal(doc0.unit, 'kg');
  assert.equal(doc0.businessDate, sc.businessDate);
  await placeOrder(f, { tokenNumber: 3 });
  const sum = await f.owner.call<{ status: string; plain: string[]; facts: { bowls: number } }>('getDailySummary', { storeId: f.storeId, date: sc.businessDate, generate: true });
  assert.equal(sum.facts.bowls, 1);
  assert.equal(sum.plain.length, 3);
  assert.equal(sum.status, 'disabled', 'AI 记成本没开时不调用模型，只给白话');
});

test('离线资格续期：主收银机有网时把班次资格延到现在 + 24 小时；不是主收银机被拒', async () => {
  const f = await setupStore();
  const shiftRef = admin().doc(`stores/${f.storeId}/shifts/${f.shiftId}`);
  await shiftRef.update({ offlineCapabilityExpiresAtMs: Date.now() - 60_000 });
  assert.equal(await f.cashier.code('renewOfflineCapability', { storeId: f.storeId, operationId: uuid(), ...f.claim, deviceId: 'dev-other' }), 'REGISTER_REVOKED');
  const before = Date.now();
  const r = await f.cashier.call<{ offlineCapabilityExpiresAtMs: number }>('renewOfflineCapability', { storeId: f.storeId, operationId: uuid(), ...f.claim });
  assert.ok(r.offlineCapabilityExpiresAtMs >= before + 24 * 3600_000 - 5_000);
  assert.equal((await shiftRef.get()).data()!.offlineCapabilityExpiresAtMs, r.offlineCapabilityExpiresAtMs);
});
