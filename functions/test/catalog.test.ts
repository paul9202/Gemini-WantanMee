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

test('发布菜单：新价生效；旧版本在线单 MENU_CHANGED；越权、过期版本、奇数价被拒绝', async () => {
  const f = await setupStore();
  const pub = (extra: Record<string, unknown>, who = f.owner) => who.code('publishMenu', { storeId: f.storeId, operationId: uuid(), baseVersion: MENU_V1.version, addOnPrices: {}, soldOut: [], ...extra });
  assert.equal(await pub({ prices: noodlePrices(800) }, f.cashier), 'FORBIDDEN');
  assert.equal(await pub({ prices: noodlePrices(801) }), 'INVALID_ARGUMENT');
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
  assert.equal((await cost(before.result.orderId)).totalCostUnits, 3210, '旧单成本不变');
  assert.equal((await cost(after.result.orderId)).totalCostUnits, 3310);
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
