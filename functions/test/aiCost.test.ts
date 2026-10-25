/**
 * AI 记成本 Emulator 测试（模拟供应商传输，不联网、不计费）：
 * 分析不记账、改后金额正确、同草稿防重复入账、租约 / 迟到结果、旧账务规则、补用量不重复计费、私有收据与重复提醒、越权。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ref, uploadBytes } from 'firebase/storage';
import { admin, cleanupClients, countDocs, newClient, setupStore, StoreFixture, uuid } from './harness';
import { businessDateOf, EditedCostDraft, monthOf } from '../../src/domain';
import { commitCostDraft, completePurchaseUsage } from '../src/aiCost/posting';
import { cleanupExpiredDrafts, DRAFT_ATTACHMENT_TTL_MS } from '../src/aiCost/drafts';
import { clearAcceptance, setAcceptance } from '../src/aiCost/acceptance';

after(cleanupClients);

const today = () => businessDateOf(Date.now());
const doc = (f: StoreFixture, p: string) => admin().doc(`stores/${f.storeId}/${p}`).get().then((s) => s.data());
const draftOf = (f: StoreFixture, id: string) => doc(f, `costDrafts/${id}`) as Promise<{ status: string; revision: number; inputRevision: number; edited: EditedCostDraft; candidate: unknown; receipt: Record<string, unknown> | null; lastAttempt: { reason: string | null } | null }>;

async function enable(f: StoreFixture) {
  await f.owner.call('setAiCostEnabled', { storeId: f.storeId, operationId: uuid(), enabled: true });
}

async function textDraft(f: StoreFixture, text: string) {
  return f.owner.call<{ draftId: string; revision: number; inputRevision: number }>('createCostDraft', { storeId: f.storeId, operationId: uuid(), source: 'text', text });
}

async function analyze(f: StoreFixture, draftId: string, inputRevision: number, requestId = uuid()) {
  return f.owner.call<{ status: string; revision: number; ok?: boolean; reused: boolean; reason?: string; provider?: string; attemptId: string }>('analyzeCostDraft', { storeId: f.storeId, draftId, inputRevision, requestId });
}

async function edit(f: StoreFixture, draftId: string, expectedRevision: number, edited: EditedCostDraft) {
  return f.owner.call<{ revision: number; issues: { code: string }[] }>('updateCostDraft', { storeId: f.storeId, draftId, expectedRevision, edited });
}

const commit = (f: StoreFixture, draftId: string, expectedRevision: number, operationId = uuid(), extra: Record<string, unknown> = {}) =>
  ({ storeId: f.storeId, operationId, draftId, expectedRevision, ...extra });

async function aiExpenses(f: StoreFixture, draftId: string) {
  return (await admin().collection(`stores/${f.storeId}/expenses`).where('costDraftId', '==', draftId).get()).docs.map((d) => d.data());
}

test('文字：分析不记账；改金额后整单保存只按最终内容；收据凭证不是额外支出；缺数量只建待补用量', async () => {
  const f = await setupStore();
  const d = await textDraft(f, '今天买了葱10块、肉碎32块、煤气35块，都付了');
  assert.equal(await f.owner.code('analyzeCostDraft', { storeId: f.storeId, draftId: d.draftId, inputRevision: 1, requestId: uuid() }), 'AI_DISABLED');
  await enable(f);
  const r = await analyze(f, d.draftId, d.inputRevision);
  assert.deepEqual([r.status, r.ok, r.provider], ['review', true, 'claude']);
  const draft = await draftOf(f, d.draftId);
  assert.deepEqual(draft.edited.lines.map((l) => [l.name, l.category, l.grossSen]), [['葱', 'topping', 1000], ['肉碎', 'wonton', 3200], ['煤气', 'gas', 3500]]);
  assert.equal(draft.edited.payment, 'paid');
  assert.equal(draft.edited.lines[0].quantity, null, '没说数量就不填');
  assert.equal(await countDocs(f.storeId, 'expenses'), 0, '分析本身不入账');

  // 肉碎 32 → 30：先保存新版本，再确认这个版本。
  const changed = { ...draft.edited, lines: draft.edited.lines.map((l) => (l.name === '肉碎' ? { ...l, grossSen: 3000 } : l)) };
  const saved = await edit(f, d.draftId, draft.revision, changed);
  assert.deepEqual(saved.issues, []);
  assert.equal(await f.owner.code('commitCostDraft', commit(f, d.draftId, draft.revision)), 'STALE_VERSION', '旧版本不能确认');
  const receipt = await f.owner.call<{ totalSen: number; expenseIds: string[]; purchaseIds: string[]; batchIds: string[]; receiptId: string; pendingUsageCount: number }>('commitCostDraft', commit(f, d.draftId, saved.revision));
  assert.equal(receipt.totalSen, 7500);
  const exps = await aiExpenses(f, d.draftId);
  assert.equal(exps.length, 3);
  assert.equal(exps.reduce((s, e) => s + e.amountSen, 0), 7500);
  assert.equal(exps.reduce((s, e) => s + e.paidSen, 0), 7500);
  assert.deepEqual(exps.map((e) => e.paymentSource), ['unspecified', 'unspecified', 'unspecified'], '付款来源未说明，不伪造成钱箱');
  assert.deepEqual(exps.map((e) => e.category).sort(), ['opex', 'purchase', 'purchase']);
  assert.equal(await countDocs(f.storeId, 'expenses'), 3, '收据凭证没有变成第 4 笔');
  assert.equal(receipt.batchIds.length, 0, '没有数量不建批次');
  assert.equal(receipt.pendingUsageCount, 2);
  const pd = await doc(f, `purchaseDetails/${receipt.purchaseIds[0]}`);
  assert.deepEqual([pd!.usageState, pd!.quantity, pd!.unit], ['pending', null, null]);
  assert.equal((await doc(f, `costReceipts/${receipt.receiptId}`))!.totalSen, 7500);
  assert.equal((await draftOf(f, d.draftId)).status, 'committed');
  assert.equal(await f.owner.code('updateCostDraft', { storeId: f.storeId, draftId: d.draftId, expectedRevision: saved.revision, edited: changed }), 'DRAFT_STATE', '已入账草稿不能再改');
});

test('同一草稿：不同 operationId 并发确认只入账一次；成功后断线用原 operationId 或新 operationId 都返回原回执', async () => {
  const f = await setupStore();
  await enable(f);
  const d = await textDraft(f, '葱10块、肉碎32块，都付了');
  const r = await analyze(f, d.draftId, d.inputRevision);
  const results = await Promise.allSettled([1, 2, 3].map(() => f.owner.call<{ receiptId: string; alreadyCommitted: boolean }>('commitCostDraft', commit(f, d.draftId, r.revision))));
  const ok = results.filter((x): x is PromiseFulfilledResult<{ receiptId: string; alreadyCommitted: boolean }> => x.status === 'fulfilled').map((x) => x.value);
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok.map((x) => x.receiptId)).size, 1);
  assert.equal((await aiExpenses(f, d.draftId)).length, 2, '只有一组支出');
  // Callable 在 Emulator 里串行执行；这里在本进程直接跑同一段事务代码，制造真正的并发事务竞争。
  const d2 = await textDraft(f, '盐3块、糖4块，都付了');
  const r2 = await analyze(f, d2.draftId, d2.inputRevision);
  const racing = await Promise.allSettled(Array.from({ length: 5 }, () => commitCostDraft(admin(), f.owner.uid, { storeId: f.storeId, operationId: uuid(), draftId: d2.draftId, expectedRevision: r2.revision, duplicateAcknowledgement: null })));
  const won = racing.filter((x) => x.status === 'fulfilled').map((x) => (x as PromiseFulfilledResult<{ result: { receiptId: string; alreadyCommitted: boolean } }>).value.result);
  assert.equal(won.length, 5, '并发确认都拿到回执');
  assert.equal(new Set(won.map((x) => x.receiptId)).size, 1);
  assert.equal(won.filter((x) => !x.alreadyCommitted).length, 1, '只有一个事务真正写账');
  assert.equal((await aiExpenses(f, d2.draftId)).length, 2);

  const op = uuid();
  const first = await f.owner.call<{ receiptId: string; replayed: boolean }>('commitCostDraft', commit(f, d.draftId, r.revision, op));
  const again = await f.owner.call<{ receiptId: string; replayed: boolean }>('commitCostDraft', commit(f, d.draftId, r.revision, op));
  assert.equal(again.replayed, true);
  assert.equal(first.receiptId, again.receiptId);
  assert.equal((await aiExpenses(f, d.draftId)).length, 2);
});

test('识别租约：同 requestId 重试不再计费；并发识别只调用一次；改原话后旧版本不能识别', async () => {
  const f = await setupStore();
  await enable(f);
  const d = await textDraft(f, '葱10块');
  // Functions Emulator 对同一函数串行执行，无法真正并发；这里直接造一个「识别进行中」的有效租约。
  const draftRef = admin().doc(`stores/${f.storeId}/costDrafts/${d.draftId}`);
  await draftRef.update({ status: 'analyzing', activeAttemptId: 'att-in-flight', leaseUntilMs: Date.now() + 60_000 });
  const during = await analyze(f, d.draftId, 1);
  assert.deepEqual([during.reused, during.attemptId], [true, 'att-in-flight'], '租约有效时不再调用模型');
  assert.equal(await countDocs(f.storeId, `costDrafts/${d.draftId}/attempts`), 0);
  await draftRef.update({ status: 'created', activeAttemptId: null, leaseUntilMs: null });
  const req = uuid();
  const first = await analyze(f, d.draftId, 1, req);
  assert.equal(first.reused, false);
  const replay = await analyze(f, d.draftId, 1, req);
  assert.equal(replay.reused, true);
  const usage = await doc(f, `aiUsage/${today()}`);
  assert.equal(usage!.attempts, 1, '每日额度只扣一次');
  assert.equal(await countDocs(f.storeId, `costDrafts/${d.draftId}/attempts`), 1);
  const cur = await draftOf(f, d.draftId);
  await f.owner.call('updateCostDraft', { storeId: f.storeId, draftId: d.draftId, expectedRevision: cur.revision, text: '葱12块' });
  assert.equal(await f.owner.code('analyzeCostDraft', { storeId: f.storeId, draftId: d.draftId, inputRevision: 1, requestId: uuid() }), 'STALE_VERSION');
});

test('老板改过草稿后再识别：结果只成为候选，不覆盖；明确应用才替换。迟到的旧尝试不覆盖', async () => {
  const f = await setupStore();
  await enable(f);
  const d = await textDraft(f, '葱10块，都付了');
  const r1 = await analyze(f, d.draftId, 1);
  const cur = await draftOf(f, d.draftId);
  const mine = { ...cur.edited, lines: [{ ...cur.edited.lines[0], name: '青葱', grossSen: 1100 }] };
  const saved = await edit(f, d.draftId, r1.revision, mine);
  const cur2 = await draftOf(f, d.draftId);
  await f.owner.call('updateCostDraft', { storeId: f.storeId, draftId: d.draftId, expectedRevision: cur2.revision, text: '葱10块、煤气35块，都付了' });
  const r2 = await analyze(f, d.draftId, 2);
  const after2 = await draftOf(f, d.draftId) as unknown as { edited: EditedCostDraft; candidate: { attemptId: string; extraction: { lines: unknown[] } }; revision: number };
  assert.equal(after2.edited.lines[0].name, '青葱', '老板的修改保留');
  assert.equal(after2.candidate.extraction.lines.length, 2);
  assert.ok(saved.revision > 0);
  await f.owner.call('updateCostDraft', { storeId: f.storeId, draftId: d.draftId, expectedRevision: after2.revision, applyCandidate: { attemptId: r2.attemptId } });
  assert.equal((await draftOf(f, d.draftId)).edited.lines.length, 2);

  // 迟到：识别进行中，租约被另一次尝试接管（模拟租约过期后重试）；旧尝试回来时只记录，不覆盖。
  const d2 = await textDraft(f, '盐3块');
  const pending = analyze(f, d2.draftId, 1);
  await new Promise((res) => setTimeout(res, 120));
  await admin().doc(`stores/${f.storeId}/costDrafts/${d2.draftId}`).update({ activeAttemptId: 'att-someone-else', leaseUntilMs: Date.now() + 60_000 });
  const late = await pending;
  assert.equal(late.reason, 'superseded');
  const dd = await draftOf(f, d2.draftId);
  assert.equal(dd.edited, null, '迟到结果没有写进草稿');
});

test('两家都失败：保留原话、不入账，可手动填写后保存；Claude 失败时 DeepSeek 接手', async () => {
  const f = await setupStore();
  await enable(f);
  const d = await textDraft(f, '葱10块 #mock:all-down');
  const r = await analyze(f, d.draftId, 1);
  assert.deepEqual([r.status, r.ok, r.reason], ['failed', false, 'all_failed']);
  const failed = await draftOf(f, d.draftId) as unknown as { input: { text: string }; revision: number };
  assert.match(failed.input.text, /葱10块/);
  assert.equal(await countDocs(f.storeId, 'expenses'), 0);
  const manual: EditedCostDraft = {
    purchaseDate: today(), currency: 'MYR', payment: 'paid', paymentSource: 'drawer', supplier: null, receiptNumber: null, discountSen: 0, taxSen: 0, printedTotalSen: null, difference: null,
    lines: [{ lineId: 'l1', name: '葱', category: 'topping', grossSen: 1000, quantity: null, unit: null, note: '', ingredientId: null, payment: 'inherit', includeInBusiness: true, excludeReason: null, periodMonth: null, workDays: null }],
  };
  const s = await edit(f, d.draftId, failed.revision, manual);
  await f.owner.call('commitCostDraft', commit(f, d.draftId, s.revision));
  assert.equal((await aiExpenses(f, d.draftId))[0].paymentSource, 'drawer');

  const d2 = await textDraft(f, '葱10块 #mock:claude-down');
  const r2 = await analyze(f, d2.draftId, 1);
  assert.equal(r2.provider, 'deepseek');
  const attempts = (await admin().collection(`stores/${f.storeId}/costDrafts/${d2.draftId}/attempts`).get()).docs.map((x) => x.data());
  assert.deepEqual(attempts[0].calls.map((c: { provider: string; ok: boolean }) => [c.provider, c.ok]), [['claude', false], ['deepseek', true]]);
  assert.equal(JSON.stringify(attempts).includes('mock-key'), false, '尝试记录里没有密钥');
});

test('原规则：未知付款、已关账日期、重复月租、工资未启用 → 整单拒绝零写入；混合付款按行入账', async () => {
  const f = await setupStore();
  await enable(f);
  const base = (lines: EditedCostDraft['lines'], patch: Partial<EditedCostDraft> = {}): EditedCostDraft => ({
    purchaseDate: today(), currency: 'MYR', payment: 'unknown', paymentSource: 'unspecified', supplier: null, receiptNumber: null, discountSen: 0, taxSen: 0, printedTotalSen: null, difference: null, lines, ...patch,
  });
  const line = (lineId: string, name: string, category: EditedCostDraft['lines'][number]['category'], grossSen: number, patch: Partial<EditedCostDraft['lines'][number]> = {}) =>
    ({ lineId, name, category, grossSen, quantity: null, unit: null, note: '', ingredientId: null, payment: 'inherit' as const, includeInBusiness: true, excludeReason: null, periodMonth: null, workDays: null, ...patch });
  const manualDraft = async (edited: EditedCostDraft) => {
    const c = await f.owner.call<{ draftId: string; revision: number }>('createCostDraft', { storeId: f.storeId, operationId: uuid(), source: 'manual' });
    const s = await edit(f, c.draftId, c.revision, edited);
    return { draftId: c.draftId, revision: s.revision };
  };

  const unknown = await manualDraft(base([line('l1', '葱', 'topping', 1000)]));
  assert.equal(await f.owner.code('commitCostDraft', commit(f, unknown.draftId, unknown.revision)), 'DRAFT_INVALID');

  const mixed = await manualDraft(base([line('l1', '肉碎', 'wonton', 3200, { payment: 'unpaid' }), line('l2', '煤气', 'gas', 3500, { payment: 'paid' })]));
  await f.owner.call('commitCostDraft', commit(f, mixed.draftId, mixed.revision));
  const exps = await aiExpenses(f, mixed.draftId);
  assert.deepEqual(exps.map((e) => [e.description, e.paidSen]).sort(), [['煤气', 3500], ['肉碎', 0]]);

  const before = await countDocs(f.storeId, 'expenses');
  const yesterday = businessDateOf(Date.now() - 86_400_000);
  await admin().doc(`stores/${f.storeId}/businessDays/${yesterday}`).set({ state: 'closed', receiptSeq: 0 });
  const closed = await manualDraft(base([line('l1', '葱', 'topping', 1000), line('l2', '盐', 'seasoning', 300)], { purchaseDate: yesterday, payment: 'paid' }));
  assert.equal(await f.owner.code('commitCostDraft', commit(f, closed.draftId, closed.revision)), 'DAY_CLOSED');

  const m = monthOf(today());
  await f.owner.call('setExpensePlan', { storeId: f.storeId, operationId: uuid(), rentStartMonth: m, staffEnabled: false });
  await f.owner.call('recordRecurringPayment', { storeId: f.storeId, operationId: uuid(), item: 'rent', month: m, amountSen: 80_000, paymentSource: 'bank' });
  const rent = await manualDraft(base([line('l1', '葱', 'topping', 1000), line('l2', '房租', 'rent', 80_000, { periodMonth: m })], { payment: 'paid' }));
  assert.equal(await f.owner.code('commitCostDraft', commit(f, rent.draftId, rent.revision)), 'PERIOD_ALREADY_PAID');
  const wage = await manualDraft(base([line('l1', '工资', 'wage', 6000, { workDays: 1 })], { payment: 'paid' }));
  assert.equal(await f.owner.code('commitCostDraft', commit(f, wage.draftId, wage.revision)), 'STAFF_NOT_ENABLED');
  assert.equal(await countDocs(f.storeId, 'expenses'), before + 1, '只多了那笔手动登记的月租；被拒的草稿一笔都没写');
  // 电费月份未登记：AI 草稿可以按原槽位登记，之后原命令不能重复。
  const fridge = await manualDraft(base([line('l1', '冰箱电费', 'fridge_power', 10_000, { periodMonth: m })], { payment: 'paid' }));
  await f.owner.call('commitCostDraft', commit(f, fridge.draftId, fridge.revision));
  assert.equal(await f.owner.code('recordRecurringPayment', { storeId: f.storeId, operationId: uuid(), item: 'fridge_power', month: m, amountSen: 10_000, paymentSource: 'bank' }), 'PERIOD_ALREADY_PAID');
});

test('补用量：不新增支出、金额不变；并发补两次只有一个批次；作废的采购不能补；错误食材零写入', async () => {
  const f = await setupStore();
  await enable(f);
  const d = await textDraft(f, '葱10块、肉碎32块，都付了');
  const r = await analyze(f, d.draftId, 1);
  const rc = await f.owner.call<{ purchaseIds: string[]; expenseIds: string[] }>('commitCostDraft', commit(f, d.draftId, r.revision));
  const [scallion, pork] = rc.purchaseIds;
  const expensesBefore = await countDocs(f.storeId, 'expenses');
  assert.equal(await f.owner.code('completePurchaseUsage', { storeId: f.storeId, operationId: uuid(), purchaseId: scallion, expectedRevision: 1, ingredientId: 'ing-minced-pork', quantity: 1, unit: 'kg' }), 'INVALID_ARGUMENT', '葱不能补成肉碎');
  const both = await Promise.all([1, 2].map(() => f.owner.call<{ batchId: string }>('completePurchaseUsage', { storeId: f.storeId, operationId: uuid(), purchaseId: scallion, expectedRevision: 1, ingredientId: 'ing-scallion', quantity: 1, unit: 'kg' })));
  assert.equal(both[0].batchId, both[1].batchId);
  assert.equal(await countDocs(f.storeId, 'ingredientBatches'), 1);
  // 真正并发（本进程事务）：给肉碎补用量 4 次，只会有一个批次。
  const racing = await Promise.all(Array.from({ length: 4 }, () => completePurchaseUsage(admin(), f.owner.uid, { storeId: f.storeId, operationId: uuid(), purchaseId: pork, expectedRevision: 1, ingredientId: 'ing-minced-pork', quantity: 2, unit: 'kg', startUsingAtMs: null })));
  assert.equal(new Set(racing.map((x) => x.result.batchId)).size, 1);
  assert.equal(await countDocs(f.storeId, 'ingredientBatches'), 2);
  assert.equal(await countDocs(f.storeId, 'expenses'), expensesBefore, '补用量不产生支出');
  assert.equal(await countDocs(f.storeId, 'expenses'), expensesBefore, '补用量不产生支出');
  const batch = await doc(f, `ingredientBatches/${both[0].batchId}`);
  assert.deepEqual([batch!.status, batch!.costSen, batch!.quantity, batch!.startedAtMs], ['stocked', 1000, 1, null], '只放库存，不当作已开始使用');
  const exp = await doc(f, `expenses/${rc.expenseIds[0]}`);
  assert.deepEqual([exp!.amountSen, exp!.ingredientBatchId], [1000, both[0].batchId]);

  assert.equal(await f.owner.code('voidLedgerEntry', { storeId: f.storeId, operationId: uuid(), kind: 'expense', id: rc.expenseIds[1], reason: '录错' }), 'LINKED_TO_BATCH', '已建批次的采购要在批次上作废');
  const d3 = await textDraft(f, '盐3块，都付了');
  const r3 = await analyze(f, d3.draftId, 1);
  const rc3 = await f.owner.call<{ purchaseIds: string[]; expenseIds: string[] }>('commitCostDraft', commit(f, d3.draftId, r3.revision));
  await f.owner.call('voidLedgerEntry', { storeId: f.storeId, operationId: uuid(), kind: 'expense', id: rc3.expenseIds[0], reason: '录错' });
  assert.equal(await f.owner.code('completePurchaseUsage', { storeId: f.storeId, operationId: uuid(), purchaseId: rc3.purchaseIds[0], expectedRevision: 1, ingredientId: 'ing-salt', quantity: 1, unit: '包' }), 'BATCH_STATE');
  assert.equal(await countDocs(f.storeId, 'ingredientBatches'), 2);
});

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64), 0xff, 0xd9]);

async function receiptDraft(f: StoreFixture, bytes: Uint8Array, ext = 'jpg', contentType = 'image/jpeg') {
  const c = await f.owner.call<{ draftId: string; revision: number; uploadPrefix: string }>('createCostDraft', { storeId: f.storeId, operationId: uuid(), source: 'receipt' });
  const path = `${c.uploadPrefix}${uuid()}.${ext}`;
  await uploadBytes(ref(f.owner.storage!, path), bytes, { contentType });
  return { ...c, path };
}

test('收据：私有上传 → 识别（模拟）→ 差额需核对 → 改正后整单入账；折扣只记一次；同张收据再记要说明', { skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST }, async () => {
  const f = await setupStore();
  await enable(f);
  const bytes = jpeg();
  const c = await receiptDraft(f, bytes);
  const fin = await f.owner.call<{ revision: number; inputRevision: number }>('updateCostDraft', { storeId: f.storeId, draftId: c.draftId, expectedRevision: c.revision, attachments: [{ path: c.path }] });
  const r = await analyze(f, c.draftId, fin.inputRevision);
  assert.equal(r.status, 'review');
  const d = await draftOf(f, c.draftId);
  assert.deepEqual([d.edited.discountSen, d.edited.printedTotalSen, d.edited.lines.length], [200, 5200, 3]);
  assert.equal(await f.owner.code('commitCostDraft', commit(f, c.draftId, d.revision)), 'DRAFT_INVALID', '与收据差 RM3 未说明');
  const fixed = { ...d.edited, lines: d.edited.lines.map((l) => (l.name === '肉碎' ? { ...l, grossSen: 3200 } : l)) };
  const s = await edit(f, c.draftId, d.revision, fixed);
  const rc = await f.owner.call<{ totalSen: number; batchIds: string[]; receiptId: string }>('commitCostDraft', commit(f, c.draftId, s.revision));
  assert.equal(rc.totalSen, 5200, '折扣按明细分摊一次');
  assert.equal((await aiExpenses(f, c.draftId)).reduce((t, e) => t + e.amountSen, 0), 5200);
  assert.equal(rc.batchIds.length, 3, '数量与食材明确 → 库存待启用');
  assert.ok((await admin().collection(`stores/${f.storeId}/ingredientBatches`).get()).docs.every((x) => x.data().status === 'stocked'));
  const rec = await doc(f, `costReceipts/${rc.receiptId}`);
  assert.equal(rec!.printedTotalSen, 5200);
  assert.equal(rec!.attachments.length, 1);

  // 同一张图片再记：草稿阶段提示相似草稿；确认时要求说明。
  const c2 = await receiptDraft(f, bytes);
  const fin2 = await f.owner.call<{ similarDrafts: { draftId: string }[]; inputRevision: number }>('updateCostDraft', { storeId: f.storeId, draftId: c2.draftId, expectedRevision: c2.revision, attachments: [{ path: c2.path }] });
  assert.equal(fin2.similarDrafts[0].draftId, c.draftId);
  await analyze(f, c2.draftId, fin2.inputRevision);
  const d2 = await draftOf(f, c2.draftId);
  const s2 = await edit(f, c2.draftId, d2.revision, { ...d2.edited, lines: d2.edited.lines.map((l) => (l.name === '肉碎' ? { ...l, grossSen: 3200 } : l)) });
  assert.equal(await f.owner.code('commitCostDraft', commit(f, c2.draftId, s2.revision)), 'DUPLICATE_RECEIPT');
  await f.owner.call('commitCostDraft', commit(f, c2.draftId, s2.revision, uuid(), { duplicateAcknowledgement: { candidateId: rc.receiptId, reason: '同一摊位第二次买，单据相同' } }));
  assert.equal(await countDocs(f.storeId, 'costReceipts'), 2);
});

test('收据附件：伪造格式、他人目录、超过 5 张、重复页面都拒绝', { skip: !process.env.FIREBASE_STORAGE_EMULATOR_HOST }, async () => {
  const f = await setupStore();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...randomBytes(16)]);
  const fake = await receiptDraft(f, png, 'jpg', 'image/jpeg');
  assert.equal(await f.owner.code('updateCostDraft', { storeId: f.storeId, draftId: fake.draftId, expectedRevision: fake.revision, attachments: [{ path: fake.path }] }), 'ATTACHMENT_REJECTED', 'PNG 内容冒充 JPG');
  const other = await receiptDraft(f, jpeg());
  assert.equal(await f.owner.code('updateCostDraft', { storeId: f.storeId, draftId: fake.draftId, expectedRevision: fake.revision, attachments: [{ path: other.path }] }), 'ATTACHMENT_REJECTED', '别的草稿目录');
  assert.equal(await f.owner.code('updateCostDraft', { storeId: f.storeId, draftId: other.draftId, expectedRevision: other.revision, attachments: [{ path: 'https://evil.example/a.jpg' }] }), 'ATTACHMENT_REJECTED', '任意 URL');
  assert.equal(await f.owner.code('updateCostDraft', { storeId: f.storeId, draftId: other.draftId, expectedRevision: other.revision, attachments: Array.from({ length: 6 }, () => ({ path: other.path })) }), 'INVALID_ARGUMENT');
  assert.equal(await f.owner.code('updateCostDraft', { storeId: f.storeId, draftId: other.draftId, expectedRevision: other.revision, attachments: [{ path: other.path }, { path: other.path }] }), 'ATTACHMENT_REJECTED');
  const outsider = await setupStore();
  assert.equal(await outsider.owner.code('updateCostDraft', { storeId: f.storeId, draftId: other.draftId, expectedRevision: other.revision, attachments: [{ path: other.path }] }), 'NOT_A_MEMBER', '他店老板先被拒，拿不到图片是否存在的信息');
  assert.equal(await f.cashier.code('updateCostDraft', { storeId: f.storeId, draftId: other.draftId, expectedRevision: other.revision, attachments: [{ path: other.path }] }), 'FORBIDDEN');
});

test('越权：收银、他店老板、匿名都不能建 / 读 / 识别 / 确认草稿，也不能触发付费调用', async () => {
  const f = await setupStore();
  await enable(f);
  const d = await textDraft(f, '葱10块，都付了');
  const outsider = await setupStore();
  const anon = await newClient('anon', false);
  for (const c of [f.cashier, f.kitchen]) {
    assert.equal(await c.code('createCostDraft', { storeId: f.storeId, operationId: uuid(), source: 'text', text: '葱10块' }), 'FORBIDDEN');
    assert.equal(await c.code('analyzeCostDraft', { storeId: f.storeId, draftId: d.draftId, inputRevision: 1, requestId: uuid() }), 'FORBIDDEN');
    assert.equal(await c.code('commitCostDraft', commit(f, d.draftId, 1)), 'FORBIDDEN');
  }
  assert.equal(await outsider.owner.code('analyzeCostDraft', { storeId: f.storeId, draftId: d.draftId, inputRevision: 1, requestId: uuid() }), 'NOT_A_MEMBER');
  assert.equal(await outsider.owner.code('commitCostDraft', commit(f, d.draftId, 1)), 'NOT_A_MEMBER');
  assert.equal(await anon.code('analyzeCostDraft', { storeId: f.storeId, draftId: d.draftId, inputRevision: 1, requestId: uuid() }), 'UNAUTHENTICATED');
  assert.equal(await countDocs(f.storeId, `costDrafts/${d.draftId}/attempts`), 0, '没有任何付费尝试');
  assert.equal(await countDocs(f.storeId, 'expenses'), 0);
  assert.equal(await f.owner.code('createCostDraft', { storeId: f.storeId, operationId: uuid(), source: 'text', text: 'x'.repeat(6001) }), 'INVALID_ARGUMENT', '超过 6000 字不截断，直接请分开');
});

test('开销分析：统计与账本逐项一致、不重复加凭证与批次；解读按摘要缓存，付款变化后旧解读失效；引用都是真实记录', async () => {
  const f = await setupStore();
  await enable(f);
  const d = await textDraft(f, '葱10块、肉碎32块、煤气35块，都付了');
  const r = await analyze(f, d.draftId, 1);
  const cur = await draftOf(f, d.draftId);
  const s = await edit(f, d.draftId, r.revision, { ...cur.edited, payment: 'unknown', lines: cur.edited.lines.map((l) => ({ ...l, payment: l.name === '肉碎' ? 'unpaid' : 'paid' })) });
  const rc = await f.owner.call<{ expenseIds: string[]; purchaseIds: string[] }>('commitCostDraft', commit(f, d.draftId, s.revision));
  await f.owner.call('completePurchaseUsage', { storeId: f.storeId, operationId: uuid(), purchaseId: rc.purchaseIds[0], expectedRevision: 1, ingredientId: 'ing-scallion', quantity: 1, unit: 'kg' });
  const t = today();
  const range = { start: `${monthOf(t)}-01`, endExclusive: businessDateOf(Date.now() + 86_400_000) };
  type A = { stats: { current: { totalSen: number; paidSen: number; unpaidSen: number; byBucket: { bucket: string; sen: number }[] }; outstanding: { totalSen: number }; evidence: { id: string }[] }; dataDigest: string; explainStatus: string; explanation: { cached: boolean; findings: { evidenceIds: string[] }[] } | null; sourceIds: string[] };
  const plain = await f.owner.call<A>('getCostAnalysis', { storeId: f.storeId, range, explain: false });
  assert.deepEqual([plain.stats.current.totalSen, plain.stats.current.paidSen, plain.stats.current.unpaidSen], [7700, 4500, 3200], '补用量建的批次与收据凭证都没有再加一次');
  assert.equal(plain.stats.outstanding.totalSen, 3200);
  assert.equal(plain.explainStatus, 'not_requested');
  assert.equal(await countDocs(f.storeId, 'costAnalysis'), 0, '只看统计不调用模型');

  const before = (await doc(f, `aiUsage/${t}`))!.attempts;
  const a1 = await f.owner.call<A>('getCostAnalysis', { storeId: f.storeId, range, question: '这个月花在哪？', explain: true });
  assert.equal(a1.explainStatus, 'ok');
  const ids = new Set(a1.stats.evidence.map((x) => x.id));
  assert.ok(a1.sourceIds.length > 0 && a1.sourceIds.every((id) => ids.has(id) && rc.expenseIds.includes(id)), '引用都是本店真实支出');
  const a2 = await f.owner.call<A>('getCostAnalysis', { storeId: f.storeId, range, question: '这个月花在哪？', explain: true });
  assert.equal(a2.explanation!.cached, true);
  assert.equal((await doc(f, `aiUsage/${t}`))!.attempts, before + 1, '缓存命中不再计费');

  await f.owner.call('settleExpense', { storeId: f.storeId, operationId: uuid(), expenseId: rc.expenseIds[1], paymentSource: 'bank' });
  const a3 = await f.owner.call<A>('getCostAnalysis', { storeId: f.storeId, range, question: '这个月花在哪？', explain: true });
  assert.notEqual(a3.dataDigest, a1.dataDigest);
  assert.equal(a3.explanation!.cached, false, '付款变化后重新解读');
  assert.deepEqual([a3.stats.current.totalSen, a3.stats.current.unpaidSen], [7700, 0], '付清只改付款维度，不加开销');

  await f.owner.call('setAiCostEnabled', { storeId: f.storeId, operationId: uuid(), enabled: false });
  const off = await f.owner.call<A>('getCostAnalysis', { storeId: f.storeId, range, question: '有哪些待付款？', explain: true });
  assert.deepEqual([off.explainStatus, off.stats.current.totalSen], ['disabled', 7700], 'AI 关闭时统计照常');
  assert.equal(await f.cashier.code('getCostAnalysis', { storeId: f.storeId, range, explain: false }), 'FORBIDDEN');
});

test('清理：30 天未动的未入账草稿过期并删图；已入账的收据凭证保留', async () => {
  const f = await setupStore();
  await enable(f);
  const old = await textDraft(f, '葱10块');
  const kept = await textDraft(f, '盐3块，都付了');
  const r = await analyze(f, kept.draftId, 1);
  await f.owner.call('commitCostDraft', commit(f, kept.draftId, r.revision));
  const long = Date.now() - DRAFT_ATTACHMENT_TTL_MS - 1000;
  const fake = { path: `stores/${f.storeId}/ai-cost-drafts/${old.draftId}/x.jpg`, generation: '1', mime: 'image/jpeg', bytes: 1, sha256: 'x' };
  await admin().doc(`stores/${f.storeId}/costDrafts/${old.draftId}`).update({ updatedAtMs: long, 'input.attachments': [fake] });
  await admin().doc(`stores/${f.storeId}/costDrafts/${kept.draftId}`).update({ updatedAtMs: long });
  const deleted: string[] = [];
  const res = await cleanupExpiredDrafts(admin(), f.storeId, Date.now(), async (p) => { deleted.push(...p); });
  assert.equal(res.expired, 1);
  assert.deepEqual(deleted, [fake.path]);
  assert.equal((await draftOf(f, old.draftId)).status, 'expired');
  assert.equal((await draftOf(f, kept.draftId)).status, 'committed', '已入账的不清理');
  assert.equal(await f.owner.code('updateCostDraft', { storeId: f.storeId, draftId: old.draftId, expectedRevision: 1, text: '葱12块' }), 'DRAFT_STATE');
});

test('DeepSeek 备用验收模式：只影响名单内老板、只在本店、限时；Claude 密钥不动；清除或过期后恢复正常主备', async () => {
  const f = await setupStore();
  const other = await setupStore();
  await enable(f);
  await enable(other);
  await setAcceptance(admin(), { storeId: f.storeId, uids: [f.owner.uid], minutes: 10, reason: 'DeepSeek 备用验收', setBy: 'test', nowMs: Date.now() });
  const providerOf = async (s: StoreFixture, text: string) => {
    const d = await textDraft(s, text);
    const r = await analyze(s, d.draftId, 1);
    const att = (await admin().collection(`stores/${s.storeId}/costDrafts/${d.draftId}/attempts`).get()).docs[0].data();
    return { provider: r.provider, calls: att.calls.map((c: { provider: string }) => c.provider), acceptanceMode: att.acceptanceMode, primaryIssue: (await draftOf(s, d.draftId)).lastAttempt as unknown as { primaryIssue: string } };
  };
  const during = await providerOf(f, '葱10块，都付了');
  assert.deepEqual([during.provider, during.calls, during.acceptanceMode, during.primaryIssue.primaryIssue], ['deepseek', ['deepseek'], 'backup_only', 'acceptance_skip'], '名单内老板：跳过 Claude，只调用 DeepSeek');
  assert.deepEqual((await providerOf(other, '葱10块，都付了')).calls, ['claude'], '其他门店不受影响');

  // 开销解读同样走备用，且不复用之前 Claude 的缓存。
  const range = { start: `${monthOf(today())}-01`, endExclusive: businessDateOf(Date.now() + 86_400_000) };
  await admin().doc(`stores/${f.storeId}/config/aiCost`).update({ acceptance: null });
  const normal = await f.owner.call<{ explanation: { provider: string; cached: boolean } }>('getCostAnalysis', { storeId: f.storeId, range, question: '这个月花在哪？', explain: true });
  assert.equal(normal.explanation.provider, 'claude');
  await setAcceptance(admin(), { storeId: f.storeId, uids: [f.owner.uid], minutes: 10, reason: 'DeepSeek 备用验收', setBy: 'test', nowMs: Date.now() });
  const acc = await f.owner.call<{ explanation: { provider: string; cached: boolean } }>('getCostAnalysis', { storeId: f.storeId, range, question: '这个月花在哪？', explain: true });
  assert.deepEqual([acc.explanation.provider, acc.explanation.cached], ['deepseek', false], '验收模式不拿 Claude 的缓存充数');

  // 过期 → 恢复；清除 → 恢复；客户端不能写验收设置。
  await admin().doc(`stores/${f.storeId}/config/aiCost`).update({ 'acceptance.untilMs': Date.now() - 1000 });
  assert.deepEqual((await providerOf(f, '盐3块，都付了')).calls, ['claude'], '过期后恢复 Claude 默认');
  await setAcceptance(admin(), { storeId: f.storeId, uids: [f.owner.uid], minutes: 10, reason: 'DeepSeek 备用验收', setBy: 'test', nowMs: Date.now() });
  await clearAcceptance(admin(), f.storeId);
  assert.deepEqual((await providerOf(f, '糖4块，都付了')).calls, ['claude'], '清除后恢复 Claude 默认');
  await assert.rejects(setAcceptance(admin(), { storeId: f.storeId, uids: [f.cashier.uid], minutes: 10, reason: '验收', setBy: 'test', nowMs: Date.now() }), /有效老板/);
  await assert.rejects(setAcceptance(admin(), { storeId: f.storeId, uids: [f.owner.uid], minutes: 121, reason: '验收', setBy: 'test', nowMs: Date.now() }), /时长/);
  assert.equal((await doc(f, 'config/aiCost'))!.enabled, true, '开关不受影响');
});
