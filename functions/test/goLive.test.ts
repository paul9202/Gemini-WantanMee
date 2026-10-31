/**
 * 清空测试数据（Emulator，可多次使用）。清空命令在进程内调用，以注入确认码哈希、固定时钟和收据图片删除；
 * 清空后的开班、下单与操作结果查询仍走真实 Callable。确认码只用虚构号码。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { GO_LIVE_RESET_COLLECTIONS } from '../../src/domain/goLive';
import { GoLiveDeps, previewStoreReset, resetStoreForOpening } from '../src/commands/goLive';
import { hashResetCode } from '../src/core/resetCode';
import { admin, cleanupClients, countDocs, pay, placeOrder, setupStore, StoreFixture, uuid } from './harness';

const CODE = '000101-01-0001';
const HASH = hashResetCode(CODE);

after(cleanupClients);

function deps(clock = { ms: Date.now() }, prefixes: string[] = []): GoLiveDeps {
  return { codeHash: HASH, deleteStoragePrefix: async (p) => { prefixes.push(p); }, now: () => clock.ms };
}

async function reason(p: Promise<unknown>): Promise<{ code: string; extra?: Record<string, unknown> }> {
  try {
    await p;
    return { code: 'OK' };
  } catch (e: any) {
    return { code: e?.reasonCode ?? String(e), extra: e?.extra };
  }
}

const reset = (f: StoreFixture, uid: string | undefined, code: string, d: GoLiveDeps, operationId = uuid()) =>
  resetStoreForOpening(admin(), uid, { storeId: f.storeId, operationId, confirmCode: code }, d);

const doc = (f: StoreFixture, path: string) => admin().doc(`stores/${f.storeId}/${path}`);

/** 交易以外的测试数据（含子集合、无父文档的子集合），以及应当保留的设置类数据。 */
async function seed(f: StoreFixture) {
  const del: Record<string, Record<string, unknown>> = {
    'expenses/exp-1': { amountSen: 1000, status: 'active' }, 'expenseLinks/exp-1': { kind: 'startup' }, 'recurringSlots/rent-2026-10': { paid: true },
    'ingredientBatches/bat-1': { status: 'in_use' }, 'purchaseDetails/pd-1': { usageState: 'pending' },
    'costDrafts/cd-1': { status: 'review' }, 'costDrafts/cd-1/attempts/att-1': { ok: true }, 'costDrafts/cd-orphan/attempts/att-2': { ok: false },
    'costReceipts/rcp-1': { totalSen: 1000 }, 'costAnalysis/k-1': { provider: 'claude' }, 'aiUsage/2026-10-25': { attempts: 3 },
    'dailyReports/2026-10-24': { version: 1 }, 'dailyReports/2026-10-24/versions/1': { totalSen: 700 },
    'wastage/w-1': { amountSen: 100 }, 'refunds/rf-1': { amountSen: 700 }, 'paymentWriteOffs/wo-1': { amountSen: 700 },
    'cashMovements/cm-1': { amountSen: 500 }, 'offlineInbox/e-1': { type: 'offline_order_created' },
  };
  const keep: Record<string, Record<string, unknown>> = {
    'startupCosts/su-1': { name: '招牌', amountSen: 50_000, paymentStatus: 'paid', linkedExpenses: [{ expenseId: 'exp-1', amountSen: 1000 }] },
    'goals/g-1': { status: 'active', targetSen: 100_000 }, 'config/goals': { sales: { dailySen: 30_000 } },
    'ingredients/ing-1': { name: '测试食材', unit: 'kg' }, 'menuVersions/m-1': { version: 'm-1' }, 'visualCatalogs/v-1': { version: 'v-1' },
    'bomVersions/b-1': { version: 'b-1' }, 'devices/d-1': { role: 'pos' },
  };
  await Promise.all(Object.entries({ ...del, ...keep }).map(([p, d]) => doc(f, p).set(d)));
  return { keep };
}

test('只限老板：收银、后厨、未登录都不能预览或清空；没设置确认码时拒绝，什么都不删', async () => {
  const f = await setupStore();
  await placeOrder(f);
  assert.equal((await reason(previewStoreReset(admin(), f.cashier.uid, { storeId: f.storeId }))).code, 'FORBIDDEN');
  assert.equal((await reason(reset(f, f.cashier.uid, CODE, deps()))).code, 'FORBIDDEN');
  assert.equal((await reason(reset(f, f.kitchen.uid, CODE, deps()))).code, 'FORBIDDEN');
  assert.equal((await reason(reset(f, undefined, CODE, deps()))).code, 'UNAUTHENTICATED');
  assert.equal((await reason(reset(f, f.owner.uid, CODE, { ...deps(), codeHash: '' }))).code, 'RESET_NOT_CONFIGURED');
  assert.equal((await reason(reset(f, f.owner.uid, CODE, { ...deps(), codeHash: 'scrypt$bad' }))).code, 'RESET_NOT_CONFIGURED');
  assert.equal(await countDocs(f.storeId, 'orders'), 1, '被拒绝时不删任何东西');
});

test('清空：删交易与收支（含子集合和收据图片），保留设置；餐牌、收银机、开档成本自洽；之后能正常开班下单，也能再清空', async () => {
  const f = await setupStore();
  const first = await placeOrder(f, { tokenNumber: 1 });
  const second = await placeOrder(f, { tokenNumber: 2 });
  await pay(f, second.result.orderId, second.result.totalSen);
  const { keep } = await seed(f);
  const before = {
    configPublic: (await doc(f, 'config/public').get()).data(),
    configFinance: (await doc(f, 'config/finance').get()).data(),
    register: (await doc(f, 'registers/front-01').get()).data()!,
    token1: (await doc(f, 'tokens/01').get()).data()!,
    members: await countDocs(f.storeId, 'members'),
  };
  assert.equal(before.token1.state === 'available', false, '测试单占着 1 号餐牌');
  assert.ok(before.register.shiftId, '收银机挂着测试班次');

  const preview = await previewStoreReset(admin(), f.owner.uid, { storeId: f.storeId });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.lastResetAtMs, null);
  assert.equal(preview.counts.orders, 2);
  assert.ok(preview.counts.payments >= 1 && preview.counts.expenses === 1 && preview.counts.costDrafts === 1);

  const wrong = await reason(reset(f, f.owner.uid, '000101010002', deps()));
  assert.equal(wrong.code, 'WRONG_CONFIRM_CODE');
  assert.equal(wrong.extra?.remainingAttempts, 4);
  assert.equal(await countDocs(f.storeId, 'orders'), 2, '输错不删');

  const prefixes: string[] = [];
  const opId = uuid();
  const r = await reset(f, f.owner.uid, '000101 01 0001', deps(undefined, prefixes), opId);
  assert.equal(typeof r.lastResetAtMs, 'number');
  assert.equal(r.deleted.orders, 2);
  assert.equal(r.deletedTotal, Object.values(r.deleted).reduce((a, b) => a + b, 0));
  assert.deepEqual(prefixes, [`stores/${f.storeId}/ai-cost-drafts/`], '收据图片按门店前缀删除');

  for (const c of GO_LIVE_RESET_COLLECTIONS) {
    assert.equal(await countDocs(f.storeId, c), c === 'operations' || c === 'auditEvents' ? 1 : 0, `${c} 应清空（只留下这一次清空的记录）`);
  }
  assert.equal(await countDocs(f.storeId, 'costDrafts/cd-1/attempts'), 0, '草稿的识别尝试一并删除');
  assert.equal(await countDocs(f.storeId, 'costDrafts/cd-orphan/attempts'), 0, '没有父文档的子集合也删除');
  assert.equal(await countDocs(f.storeId, 'dailyReports/2026-10-24/versions'), 0, '日结历史版本一并删除');

  // 保留的设置原样不动（开档成本只解除与已删支出的关联）。
  for (const [p, d] of Object.entries(keep)) {
    const now = (await doc(f, p).get()).data();
    assert.deepEqual(now, p === 'startupCosts/su-1' ? { ...d, linkedExpenses: [] } : d, `${p} 应保留`);
  }
  assert.deepEqual((await doc(f, 'config/public').get()).data(), before.configPublic);
  assert.deepEqual((await doc(f, 'config/finance').get()).data(), before.configFinance);
  assert.equal(await countDocs(f.storeId, 'members'), before.members);
  const tokens = (await admin().collection(`stores/${f.storeId}/tokens`).get()).docs.map((d) => d.data());
  assert.equal(tokens.length, 50);
  assert.ok(tokens.every((t) => t.state === 'available' && t.orderId === null), '餐牌全部可用');
  assert.equal(tokens.find((t) => t.number === 1)!.version, (before.token1.version as number) + 1);
  const reg = (await doc(f, 'registers/front-01').get()).data()!;
  assert.equal(reg.shiftId, null, '收银机解除旧班次');
  assert.equal(reg.lastAppliedSequence, before.register.lastAppliedSequence, '序号不归零');
  const g = (await doc(f, 'config/goLive').get()).data()!;
  assert.equal(g.status, 'ready', '清空后不锁定');
  assert.equal(g.lastResetAtMs, r.lastResetAtMs);

  // 结果不明时可按操作 ID 查回结果。
  const op = await f.owner.call<{ status: string; result: { deletedTotal: number } }>('getOperationResult', { storeId: f.storeId, operationId: opId });
  assert.equal(op.status, 'committed');
  assert.equal(op.result.deletedTotal, r.deletedTotal);

  // 清空后：收银员重新开班，下单编号从头开始。
  const shift = await f.cashier.call<{ shiftId: string; lastAppliedSequence: number }>('openShift', { storeId: f.storeId, operationId: uuid(), ...f.claim });
  assert.equal(shift.lastAppliedSequence, before.register.lastAppliedSequence);
  f.shiftId = shift.shiftId;
  const fresh = await placeOrder(f, { tokenNumber: 1 });
  assert.equal(fresh.result.receiptNumber, first.result.receiptNumber, '小票编号重新从第一号开始');
  assert.equal(await countDocs(f.storeId, 'orders'), 1);

  // 可以多次使用：预览显示上次清空时间，再输入 IC 就能再清空一次。
  const again = await previewStoreReset(admin(), f.owner.uid, { storeId: f.storeId });
  assert.equal(again.status, 'ready');
  assert.equal(again.lastResetAtMs, r.lastResetAtMs);
  assert.equal(again.counts.orders, 1);
  const r2 = await reset(f, f.owner.uid, CODE, deps());
  assert.equal(r2.deleted.orders, 1);
  assert.ok(r2.lastResetAtMs >= r.lastResetAtMs);
  assert.equal(await countDocs(f.storeId, 'orders'), 0);
  assert.equal((await doc(f, 'registers/front-01').get()).data()!.shiftId, null, '收银机再次解除班次');
});

test('旧版本留下的「已锁定」（status = live）不再挡住清空，完成时间当作上次清空时间', async () => {
  const f = await setupStore();
  await placeOrder(f);
  const liveAtMs = Date.UTC(2026, 9, 28, 2);
  await doc(f, 'config/goLive').set({ status: 'live', liveAtMs });
  const p = await previewStoreReset(admin(), f.owner.uid, { storeId: f.storeId });
  assert.equal(p.status, 'ready');
  assert.equal(p.lastResetAtMs, liveAtMs);
  assert.equal(p.counts.orders, 1);
  const r = await reset(f, f.owner.uid, CODE, deps());
  assert.equal(r.deleted.orders, 1);
  assert.equal((await doc(f, 'config/goLive').get()).data()!.status, 'ready');
});

test('输错 5 次锁 30 分钟（期间输对也不行）；清空中途失败可继续，进行中不能重复发起', async () => {
  const f = await setupStore();
  await placeOrder(f);
  const clock = { ms: Date.UTC(2026, 9, 26, 2) };
  for (let i = 1; i <= 4; i++) {
    const w = await reason(reset(f, f.owner.uid, '999999999999', deps(clock)));
    assert.equal(w.code, 'WRONG_CONFIRM_CODE');
    assert.equal(w.extra?.remainingAttempts, 5 - i);
  }
  const fifth = await reason(reset(f, f.owner.uid, '999999999999', deps(clock)));
  assert.equal(fifth.code, 'RESET_LOCKED_OUT');
  assert.equal(fifth.extra?.lockedUntilMs, clock.ms + 30 * 60_000);
  clock.ms += 29 * 60_000;
  assert.equal((await reason(reset(f, f.owner.uid, CODE, deps(clock)))).code, 'RESET_LOCKED_OUT', '锁定期间输对也不行');
  assert.equal(await countDocs(f.storeId, 'orders'), 1);

  clock.ms += 2 * 60_000;
  await doc(f, 'config/goLive').set({ status: 'resetting', startedAtMs: clock.ms - 60_000 }, { merge: true });
  assert.equal((await reason(reset(f, f.owner.uid, CODE, deps(clock)))).code, 'RESET_IN_PROGRESS', '另一个清空还在进行');
  await doc(f, 'config/goLive').set({ startedAtMs: clock.ms - 11 * 60_000 }, { merge: true });
  const r = await reset(f, f.owner.uid, CODE, deps(clock));
  assert.equal(r.lastResetAtMs, clock.ms, '上次中途失败可以继续完成');
  assert.equal(await countDocs(f.storeId, 'orders'), 0);
});
