/**
 * 送餐单打印总开关 setSlipPrinting：只有老板能开关；写在 config/public，缺省关；有审计记录；不动其它配置。
 * 需要 Emulator（npm run test:emulator）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, cleanupClients, setupStore, StoreFixture, uuid } from './harness';

after(cleanupClients);

const docOf = async (f: StoreFixture, p: string) => (await admin().doc(`stores/${f.storeId}/${p}`).get()).data();

test('送餐单打印总开关：只有老板能开关；写在 config/public，缺省关；有审计；不动其它配置', async () => {
  const f = await setupStore();
  assert.equal((await docOf(f, 'config/public'))!.slipPrinting, undefined, '缺省没有这个字段 = 关');

  const args = { storeId: f.storeId, operationId: uuid(), enabled: true };
  assert.equal(await f.cashier.code('setSlipPrinting', args), 'FORBIDDEN');
  assert.equal(await f.kitchen.code('setSlipPrinting', args), 'FORBIDDEN');
  assert.equal(await f.owner.code('setSlipPrinting', { ...args, operationId: uuid(), enabled: 'yes' }), 'INVALID_ARGUMENT');

  const r = await f.owner.call<{ enabled: boolean }>('setSlipPrinting', { ...args, reason: '打印机到了' });
  assert.equal(r.enabled, true);
  const cfg = (await docOf(f, 'config/public'))!;
  assert.deepEqual([cfg.slipPrinting, cfg.slipPrintingUpdatedBy, typeof cfg.slipPrintingUpdatedAtMs], [true, f.owner.uid, 'number']);
  assert.equal(cfg.name, '豪云吞面', 'merge：不动其它配置');
  assert.notEqual(cfg.payOnServe, true, '不碰出餐即记收款');
  const audit = (await docOf(f, `auditEvents/${args.operationId}`))!;
  assert.deepEqual([audit.entityId, audit.before.slipPrinting, audit.after.slipPrinting, audit.after.reason], ['config/public', false, true, '打印机到了']);

  await f.owner.call('setSlipPrinting', { storeId: f.storeId, operationId: uuid(), enabled: false });
  assert.equal((await docOf(f, 'config/public'))!.slipPrinting, false);
});
