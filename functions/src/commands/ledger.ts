/**
 * 老板账本命令：进货/支出、损耗、资金往来（10 章）。
 * - 交易不硬删除：错误记录「作废」并可关联一条更正记录。
 * - 损耗关联的订单若成本仍计入（已制作取消、已出餐），只记数量不再扣成本（F04）。
 * - 写入的营业日必须未关账；关账后的差错走更正版本（restateBusinessDay）。
 */
import { Firestore } from 'firebase-admin/firestore';
import { loadBom } from '../core/catalog';
import { businessDateOf, isDateString } from '../../../src/domain/businessDay';
import { wastageCostUnits } from '../../../src/domain/ledger';
import { runCommand, StoreRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, bool, int, obj, oneOf, optStr, str, storeId, uuid } from '../core/input';
import { loadStoreConfig, markDayActivity, requireDayOpen, StoreConfig } from '../core/store';
import type { Transaction } from 'firebase-admin/firestore';

/** 账本营业日：默认今天；可补记过去未关账的日期，不能写未来。 */
async function ledgerDay(tx: Transaction, store: StoreRefs, config: StoreConfig, requested: string | null, nowMs: number) {
  const today = businessDateOf(nowMs, config.businessDay);
  const date = requested ?? today;
  if (!isDateString(date) || date > today) throw bad('营业日非法');
  const day = await requireDayOpen(tx, store, date);
  return { date, day };
}

const optDate = (o: Record<string, unknown>, k: string) => {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (!isDateString(v)) throw bad(`${k} 非法`);
  return v;
};

export async function recordExpense(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'category', 'description', 'amountSen', 'paid', 'paymentSource', 'businessDate', 'accrualDate', 'correctionOf']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'),
    category: oneOf(o, 'category', ['purchase', 'fixed_payment', 'opex', 'capital'] as const),
    description: str(o, 'description', 120, 1), amountSen: int(o, 'amountSen', 1, 100_000_000), paid: bool(o, 'paid'),
    paymentSource: oneOf(o, 'paymentSource', ['drawer', 'bank', 'owner'] as const),
    businessDate: optDate(o, 'businessDate'), accrualDate: optDate(o, 'accrualDate'), correctionOf: optStr(o, 'correctionOf', 80),
  };
  return runCommand(db, {
    type: 'recordExpense', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const { date, day } = await ledgerDay(tx, store, config, input.businessDate, nowMs);
      if (input.correctionOf) {
        const orig = (await tx.get(store.expense(input.correctionOf))).data();
        if (!orig) throw new CommandError('NOT_FOUND', '被更正的记录不存在');
        if (orig.status !== 'voided') throw new CommandError('INVALID_TRANSITION', '请先作废原记录再登记更正');
      }
      const id = `exp-${input.operationId}`;
      tx.create(store.expense(id), {
        id, category: input.category, description: input.description, amountSen: input.amountSen, paidSen: input.paid ? input.amountSen : 0,
        paymentSource: input.paymentSource, businessDate: date, accrualDate: input.accrualDate ?? date, status: 'active',
        correctionOf: input.correctionOf, occurredAtMs: nowMs, recordedBy: actor.uid,
      });
      markDayActivity(tx, store, date, day, nowMs);
      return { result: { id, businessDate: date }, audit: { entityId: id, after: { category: input.category, amountSen: input.amountSen } } };
    },
  });
}

export async function voidLedgerEntry(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'kind', 'id', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), kind: oneOf(o, 'kind', ['expense', 'wastage'] as const), id: str(o, 'id', 80), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'voidLedgerEntry', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ref = input.kind === 'expense' ? store.expense(input.id) : store.wastage(input.id);
      const doc = (await tx.get(ref)).data();
      if (!doc) throw new CommandError('NOT_FOUND');
      if (doc.status === 'voided') return { result: { id: input.id, status: 'voided' }, audit: { entityId: input.id } };
      const day = await requireDayOpen(tx, store, doc.businessDate);
      tx.update(ref, { status: 'voided', voidReason: input.reason, voidedAtMs: nowMs, voidedBy: actor.uid });
      markDayActivity(tx, store, doc.businessDate, day, nowMs);
      return { result: { id: input.id, status: 'voided' }, audit: { entityId: input.id, before: { status: 'active' }, after: { status: 'voided', reason: input.reason } } };
    },
  });
}

export async function recordWastage(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'noodleHalfUnits', 'wantonCount', 'charSiewPortions', 'reason', 'note', 'linkedOrderId', 'businessDate']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'),
    noodleHalfUnits: int(o, 'noodleHalfUnits', 0, 1000), wantonCount: int(o, 'wantonCount', 0, 5000), charSiewPortions: int(o, 'charSiewPortions', 0, 500),
    reason: oneOf(o, 'reason', ['overcooked', 'dropped', 'leftover', 'other'] as const), note: optStr(o, 'note', 200) ?? '',
    linkedOrderId: o.linkedOrderId === undefined || o.linkedOrderId === null ? null : uuid(o, 'linkedOrderId'), businessDate: optDate(o, 'businessDate'),
  };
  if (input.noodleHalfUnits + input.wantonCount + input.charSiewPortions === 0) throw bad('损耗数量必须大于 0');
  return runCommand(db, {
    type: 'recordWastage', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const bom = await loadBom(tx, store, config.activeBomVersion);
      if (!bom) throw new CommandError('STORE_NOT_CONFIGURED');
      // 关联订单的理论成本仍计入（未反转）时，这份食材已扣过一次：只记数量，不重复扣款。
      let alreadyAllocated = false;
      if (input.linkedOrderId) {
        const cost = (await tx.get(store.orderCost(input.linkedOrderId))).data();
        if (!cost) throw new CommandError('NOT_FOUND', '关联订单不存在');
        alreadyAllocated = (cost.allocatedCostUnits as number) > 0;
      }
      const { date, day } = await ledgerDay(tx, store, config, input.businessDate, nowMs);
      const id = `wst-${input.operationId}`;
      const costUnits = wastageCostUnits(bom, input);
      tx.create(store.wastage(id), {
        id, businessDate: date, noodleHalfUnits: input.noodleHalfUnits, wantonCount: input.wantonCount, charSiewPortions: input.charSiewPortions,
        reason: input.reason, note: input.note, linkedOrderId: input.linkedOrderId, alreadyAllocated, costUnits, bomVersion: bom.version,
        status: 'active', occurredAtMs: nowMs, recordedBy: actor.uid,
      });
      markDayActivity(tx, store, date, day, nowMs);
      return { result: { id, businessDate: date, alreadyAllocated, costUnits }, audit: { entityId: id, after: { costUnits, alreadyAllocated } } };
    },
  });
}

export async function recordCashMovement(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'type', 'amountSen', 'reason', 'businessDate']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), type: oneOf(o, 'type', ['cash_in', 'cash_out', 'bank_deposit'] as const),
    amountSen: int(o, 'amountSen', 1, 100_000_000), reason: str(o, 'reason', 200, 2), businessDate: optDate(o, 'businessDate'),
  };
  return runCommand(db, {
    type: 'recordCashMovement', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const { date, day } = await ledgerDay(tx, store, config, input.businessDate, nowMs);
      const id = `cash-${input.operationId}`;
      tx.create(store.cashMovement(id), { id, type: input.type, amountSen: input.amountSen, reason: input.reason, businessDate: date, occurredAtMs: nowMs, recordedBy: actor.uid });
      markDayActivity(tx, store, date, day, nowMs);
      return { result: { id, businessDate: date }, audit: { entityId: id, after: { type: input.type, amountSen: input.amountSen } } };
    },
  });
}
