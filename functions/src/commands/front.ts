/**
 * 前台命令：开班、旧版待回收餐牌处理、后厨收单确认。
 * 开班不再要求备用金：新收款不分渠道，无法推算钱箱，不创建虚构的备用金流水；
 * 开班仍是主设备、营业日与 24 小时离线资格的唯一入口，校验不变。
 */
import { Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import { releaseToken as releaseTokenRule, TokenBoard } from '../../../src/domain/tokens';
import { runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { int, obj, optInt, storeId, uuid } from '../core/input';
import {
  loadStoreConfig, parseRegisterClaim, REGISTER_CLAIM_FIELDS, requireActiveRegister, requireDayOpen, requireNextSequence,
} from '../core/store';

export const OFFLINE_CAPABILITY_MS = 24 * 60 * 60 * 1000;

export async function openShift(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', ...REGISTER_CLAIM_FIELDS, 'openingFloatSen']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), claim: parseRegisterClaim(o),
    // 旧客户端仍可能传实点备用金：照实记录；新客户端不传，即不记录钱箱。
    openingFloatSen: optInt(o, 'openingFloatSen', 0, 10_000_000),
  };
  return runCommand(db, {
    type: 'openShift', storeId: input.storeId, operationId: input.operationId, uid, roles: ['cashier', 'owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const reg = await requireActiveRegister(tx, store, config, input.claim);
      if (reg.shiftId) {
        const cur = (await tx.get(store.shift(reg.shiftId))).data();
        if (cur?.status === 'open') throw new CommandError('SHIFT_ALREADY_OPEN', '已有营业中的班次', { shiftId: reg.shiftId });
      }
      const businessDate = businessDateOf(nowMs, config.businessDay);
      await requireDayOpen(tx, store, businessDate);
      const shiftId = `shift-${input.operationId}`;
      const offlineCapabilityExpiresAtMs = nowMs + OFFLINE_CAPABILITY_MS;
      tx.create(store.shift(shiftId), {
        id: shiftId, registerId: input.claim.registerId, deviceId: input.claim.deviceId, registerEpoch: input.claim.registerEpoch,
        status: 'open', openedAtMs: nowMs, openedBy: actor.uid, openingFloatSen: input.openingFloatSen, cashDrawerTracked: input.openingFloatSen !== null,
        businessDate, offlineCapabilityExpiresAtMs,
      });
      if (input.openingFloatSen !== null) {
        tx.create(store.cashMovement(`${shiftId}-float`), {
          shiftId, type: 'opening_float', amountSen: input.openingFloatSen, source: 'drawer', occurredAtMs: nowMs, businessDate, recordedBy: actor.uid,
        });
      }
      tx.update(store.register(input.claim.registerId), { shiftId, lastSeenAtMs: nowMs });
      tx.set(store.businessDay(businessDate), { state: 'open', updatedAtMs: nowMs }, { merge: true });
      const result = {
        shiftId, businessDate, menuVersion: config.activeMenuVersion, lastAppliedSequence: reg.lastAppliedSequence, offlineCapabilityExpiresAtMs,
      };
      return { result, audit: { entityId: shiftId, after: { openingFloatSen: input.openingFloatSen } } };
    },
  });
}

/**
 * 旧版待回收牌（awaiting_return，改版前出餐的单）：前台确认实体牌已收回后逐张释放，留审计。
 * 新流程出餐 / 取消即自动释放，不会再产生待回收牌。
 */
export async function releaseToken(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', ...REGISTER_CLAIM_FIELDS, 'sequence', 'tokenNumber', 'orderId', 'expectedVersion']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), claim: parseRegisterClaim(o),
    sequence: int(o, 'sequence', 1, Number.MAX_SAFE_INTEGER), tokenNumber: int(o, 'tokenNumber', 1, 50),
    orderId: uuid(o, 'orderId'), expectedVersion: optInt(o, 'expectedVersion', 0, 1_000_000),
  };
  return runCommand(db, {
    type: 'releaseToken', storeId: input.storeId, operationId: input.operationId, uid, roles: ['cashier', 'owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      const config = await loadStoreConfig(tx, store);
      const reg = await requireActiveRegister(tx, store, config, input.claim);
      const tokenRef = store.token(input.tokenNumber);
      const t = (await tx.get(tokenRef)).data();
      if (!t) throw new CommandError('STORE_NOT_CONFIGURED', '餐牌未初始化');
      requireNextSequence(reg.lastAppliedSequence, input.sequence);
      const board: TokenBoard = { [input.tokenNumber]: { number: input.tokenNumber, state: t.state, orderId: t.orderId, version: t.version } };
      const r = releaseTokenRule(board, input.tokenNumber, input.orderId, input.expectedVersion ?? undefined);
      if (!r.ok) throw new CommandError(r.error === 'TOKEN_OUT_OF_RANGE' ? 'INVALID_ARGUMENT' : r.error, r.error, { state: t.state, heldByOrderId: t.orderId });
      tx.set(tokenRef, { ...r.token, updatedAtMs: nowMs, lastReleasedOrderId: input.orderId });
      tx.update(store.order(input.orderId), { tokenReturnedAtMs: nowMs });
      tx.update(store.register(input.claim.registerId), { lastAppliedSequence: input.sequence, lastSeenAtMs: nowMs });
      return {
        result: { tokenNumber: input.tokenNumber, state: 'available', version: r.token.version },
        audit: { entityId: `token-${input.tokenNumber}`, before: { state: t.state, orderId: t.orderId }, after: { state: 'available' } },
      };
    },
  });
}

/** 后厨设备收到非缓存厨单后确认；只记录首次收到时间，不代表开始制作。 */
export async function ackKitchenTicket(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'deviceId']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), deviceId: typeof o.deviceId === 'string' ? o.deviceId.slice(0, 64) : null };
  return runCommand(db, {
    type: 'ackKitchenTicket', storeId: input.storeId, operationId: input.operationId, uid, roles: ['kitchen', 'owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ticket = (await tx.get(store.ticket(input.orderId))).data();
      if (!ticket) throw new CommandError('NOT_FOUND', '厨单不存在');
      const first = ticket.kitchenAckAtMs == null;
      const ackAt = first ? nowMs : (ticket.kitchenAckAtMs as number);
      if (first) {
        tx.update(store.ticket(input.orderId), { kitchenAckAtMs: nowMs });
        tx.update(store.order(input.orderId), { kitchenAckAtMs: nowMs, kitchenAckBy: actor.uid });
      }
      tx.set(store.status, { kitchenLastSeenAtMs: nowMs, kitchenLastDeviceId: input.deviceId }, { merge: true });
      return { result: { orderId: input.orderId, kitchenAckAtMs: ackAt, first }, audit: { entityId: input.orderId } };
    },
  });
}
