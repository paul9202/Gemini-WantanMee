/**
 * createOrder：下单即送厨。订单、私有成本、餐牌占用、厨房投影（直接制作中）、收银机序号、票号、operation、审计——同一事务。
 * 不收款、不写付款流水：订单待收款（paidSen=0），收款由 recordPayment 另行确认。
 * 服务器按菜单版本重算价格与配置；前端传入的总价只用于比对，不是权威。
 * 旧客户端带 payment 字段（下单即收款）会被拒绝，避免把未付款新单当成已付。
 */
import { businessDateOf } from '../../../src/domain/businessDay';
import { Cart, computeTotals } from '../../../src/domain/cart';
import { isValidQuantity, parseLineConfig, LineConfig } from '../../../src/domain/lineItem';
import { SERVICE_MODES } from '../../../src/domain/menu';
import { loadBom, loadMenu } from '../core/catalog';
import { holdToken, isTokenNumber, TokenBoard } from '../../../src/domain/tokens';
import { CommandContext, runCommand } from '../core/command';
import { receiptNumberFor, writeAcceptedOrder } from '../core/orderWrites';
import { CommandError } from '../core/errors';
import { int, obj, oneOf, str, storeId, uuid, bad } from '../core/input';
import { loadStoreConfig, parseRegisterClaim, REGISTER_CLAIM_FIELDS, requireActiveRegister, requireDayOpen, requireNextSequence } from '../core/store';
import type { Firestore } from 'firebase-admin/firestore';

export const MAX_LINES = 30;

export interface CreateOrderResult {
  orderId: string;
  receiptNumber: string;
  tokenNumber: number;
  totalSen: number;
  paymentState: 'unpaid';
  fulfillmentStatus: 'preparing';
  businessDate: string;
  acceptedAtMs: number;
}

export function parseCreateOrder(raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', ...REGISTER_CLAIM_FIELDS, 'sequence', 'shiftId', 'order']);
  const order = obj(o.order, ['clientOrderId', 'tokenNumber', 'serviceMode', 'menuVersion', 'lines', 'expectedTotalSen', 'deviceAcceptedAtMs'], 'order');
  if (!Array.isArray(order.lines) || order.lines.length < 1 || order.lines.length > MAX_LINES) throw bad(`lines 需 1–${MAX_LINES} 行`);
  const lines = order.lines.map((l, i) => {
    const line = obj(l, ['lineId', 'config', 'quantity'], `lines[${i}]`);
    if (!isValidQuantity(line.quantity)) throw bad(`lines[${i}].quantity 非法`);
    return { lineId: str(line, 'lineId', 64), config: line.config as unknown, quantity: line.quantity as number };
  });
  if (new Set(lines.map((l) => l.lineId)).size !== lines.length) throw bad('lineId 重复');
  const tokenNumber = int(order, 'tokenNumber', 1, 50);
  return {
    storeId: storeId(o),
    operationId: uuid(o, 'operationId'),
    claim: parseRegisterClaim(o),
    sequence: int(o, 'sequence', 1, Number.MAX_SAFE_INTEGER),
    shiftId: str(o, 'shiftId', 80),
    order: {
      clientOrderId: uuid(order, 'clientOrderId'),
      tokenNumber,
      serviceMode: oneOf(order, 'serviceMode', SERVICE_MODES),
      menuVersion: str(order, 'menuVersion', 64),
      lines,
      expectedTotalSen: int(order, 'expectedTotalSen', 0, 10_000_000),
      deviceAcceptedAtMs: int(order, 'deviceAcceptedAtMs', 0, Number.MAX_SAFE_INTEGER),
    },
  };
}

export type CreateOrderInput = ReturnType<typeof parseCreateOrder>;


export async function createOrder(db: Firestore, uid: string | undefined, raw: unknown) {
  const input = parseCreateOrder(raw);
  return runCommand<CreateOrderResult>(db, {
    type: 'createOrder', storeId: input.storeId, operationId: input.operationId, uid, roles: ['cashier', 'owner'],
    payload: input,
    run: (ctx) => createOrderTx(ctx, input),
  });
}

async function createOrderTx(ctx: CommandContext, input: CreateOrderInput) {
  const { tx, store, nowMs, actor } = ctx;
  const { order: o } = input;

  // ---- 读取（全部在写入之前） ----
  const config = await loadStoreConfig(tx, store);
  const register = await requireActiveRegister(tx, store, config, input.claim);
  const shiftSnap = await tx.get(store.shift(input.shiftId));
  const shift = shiftSnap.data();
  const orderSnap = await tx.get(store.order(o.clientOrderId));
  const tokenSnap = await tx.get(store.token(o.tokenNumber));
  const businessDate = businessDateOf(nowMs, config.businessDay);
  const day = await requireDayOpen(tx, store, businessDate);

  // ---- 校验 ----
  if (register.shiftId !== input.shiftId || !shift || shift.status !== 'open' || shift.registerId !== input.claim.registerId) {
    throw new CommandError('SHIFT_NOT_OPEN');
  }
  requireNextSequence(register.lastAppliedSequence, input.sequence);
  if (orderSnap.exists) throw new CommandError('ORDER_ID_CONFLICT');
  if (o.menuVersion !== config.activeMenuVersion) {
    throw new CommandError('MENU_CHANGED', '菜单已更新，请重新确认价格', { activeMenuVersion: config.activeMenuVersion });
  }
  const menu = await loadMenu(tx, store, o.menuVersion);
  const bom = await loadBom(tx, store, config.activeBomVersion);
  if (!menu || !bom) throw new CommandError('STORE_NOT_CONFIGURED', '菜单或 BOM 版本不可用');

  const lines: { lineId: string; config: LineConfig; quantity: number }[] = [];
  for (const [i, l] of o.lines.entries()) {
    const parsed = parseLineConfig(menu, l.config);
    if (!parsed.ok) throw new CommandError('INVALID_MODIFIER', `第 ${i + 1} 行配置非法`, { line: i, issues: parsed.issues });
    lines.push({ lineId: l.lineId, config: parsed.value, quantity: l.quantity });
  }
  const cart: Cart = { serviceMode: o.serviceMode, lines };
  const totals = computeTotals(menu, bom, cart);
  if (totals.totalSen !== o.expectedTotalSen) {
    throw new CommandError('PRICE_MISMATCH', '金额与服务器计算不一致', { serverTotalSen: totals.totalSen });
  }

  const tokenData = tokenSnap.data();
  if (!tokenSnap.exists || !tokenData || !isTokenNumber(o.tokenNumber)) throw new CommandError('STORE_NOT_CONFIGURED', '餐牌未初始化');
  const board: TokenBoard = { [o.tokenNumber]: { number: o.tokenNumber, state: tokenData.state, orderId: tokenData.orderId, version: tokenData.version } };
  const held = holdToken(board, o.tokenNumber, o.clientOrderId);
  if (!held.ok) {
    throw new CommandError('TOKEN_OCCUPIED', `${o.tokenNumber}号仍被占用`, { tokenNumber: o.tokenNumber, heldByOrderId: tokenData.orderId, state: tokenData.state });
  }

  // ---- 写入 ----
  const orderId = o.clientOrderId;
  const receiptSeq = day.receiptSeq + 1;
  const receiptNumber = receiptNumberFor(businessDate, receiptSeq);
  writeAcceptedOrder(tx, store, {
    storeId: ctx.storeId, orderId, receiptNumber, offlineReceiptNumber: null, tokenNumber: o.tokenNumber, serviceMode: o.serviceMode,
    source: 'online', kitchenRouting: 'digital', menu, bom, lines, totals,
    legacyPayment: null,
    acceptedAtEffectiveMs: nowMs, deviceAcceptedAtMs: o.deviceAcceptedAtMs, cloudReceivedAtMs: nowMs, timeQuality: 'server', businessDate,
    registerId: input.claim.registerId, registerEpoch: input.claim.registerEpoch, shiftId: input.shiftId, sequence: input.sequence,
    createdBy: actor.uid, allocationEventId: `${input.operationId}-alloc`,
  });
  tx.set(store.token(o.tokenNumber), { ...held.token, updatedAtMs: nowMs });
  tx.update(store.register(input.claim.registerId), { lastAppliedSequence: input.sequence, lastSeenAtMs: nowMs });
  tx.set(store.businessDay(businessDate), { state: 'open', receiptSeq, updatedAtMs: nowMs }, { merge: true });

  const result: CreateOrderResult = {
    orderId, receiptNumber, tokenNumber: o.tokenNumber, totalSen: totals.totalSen, paymentState: 'unpaid', fulfillmentStatus: 'preparing', businessDate, acceptedAtMs: nowMs,
  };
  return { result, audit: { entityId: orderId, after: { totalSen: totals.totalSen, tokenNumber: o.tokenNumber, paymentState: 'unpaid' } } };
}
