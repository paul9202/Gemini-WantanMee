/**
 * createOrder：订单、支付、私有成本、餐牌占用、厨房投影、收银机序号、票号、operation、审计——同一事务。
 * 服务器按菜单版本重算价格与配置；前端传入的总价只用于比对，不是权威。
 */
import { Timestamp } from 'firebase-admin/firestore';
import { BOM_VERSIONS } from '../../../src/domain/bom';
import { businessDateOf } from '../../../src/domain/businessDay';
import { Cart, computeTotals } from '../../../src/domain/cart';
import { buildKitchenTicket } from '../../../src/domain/kitchen';
import { isValidQuantity, lineNameZh, linePhotoId, linePortions, parseLineConfig, LineConfig } from '../../../src/domain/lineItem';
import { MENU_VERSIONS, SERVICE_MODES } from '../../../src/domain/menu';
import { newAcceptedState } from '../../../src/domain/orderLifecycle';
import { checkPayment } from '../../../src/domain/payment';
import { linePictograms } from '../../../src/domain/pictograms';
import { holdToken, isTokenNumber, TokenBoard } from '../../../src/domain/tokens';
import { CommandContext, runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { bool, int, obj, oneOf, optInt, str, storeId, uuid, bad } from '../core/input';
import { loadStoreConfig, parseRegisterClaim, REGISTER_CLAIM_FIELDS, requireActiveRegister, requireDayOpen, requireNextSequence } from '../core/store';
import type { Firestore } from 'firebase-admin/firestore';

export const MAX_LINES = 30;

export interface CreateOrderResult {
  orderId: string;
  paymentId: string;
  receiptNumber: string;
  tokenNumber: number;
  totalSen: number;
  changeSen: number | null;
  businessDate: string;
  acceptedAtMs: number;
}

export function parseCreateOrder(raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', ...REGISTER_CLAIM_FIELDS, 'sequence', 'shiftId', 'order', 'payment']);
  const order = obj(o.order, ['clientOrderId', 'tokenNumber', 'serviceMode', 'menuVersion', 'lines', 'expectedTotalSen', 'deviceAcceptedAtMs'], 'order');
  const payment = obj(o.payment, ['method', 'tenderedSen', 'qrConfirmed'], 'payment');
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
    payment: {
      method: oneOf(payment, 'method', ['cash', 'qr_manual'] as const),
      tenderedSen: optInt(payment, 'tenderedSen', 0, 10_000_000),
      qrConfirmed: bool(payment, 'qrConfirmed'),
    },
  };
}

export type CreateOrderInput = ReturnType<typeof parseCreateOrder>;

function receiptNumberFor(businessDate: string, seq: number): string {
  return `${businessDate.replace(/-/g, '').slice(2)}-${String(seq).padStart(3, '0')}`;
}

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
  const menu = MENU_VERSIONS[o.menuVersion];
  const bom = BOM_VERSIONS[config.activeBomVersion];
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
  const pay = checkPayment(
    { method: input.payment.method, dueSen: totals.totalSen, tenderedSen: input.payment.tenderedSen, qrConfirmed: input.payment.qrConfirmed, qrExternalVerificationNote: null },
    { online: true, qrConfigured: config.qrConfigured },
  );
  if (!pay.ok) throw new CommandError('PAYMENT_NOT_CONFIRMED', pay.blocks.join(','), { blocks: pay.blocks });

  const tokenData = tokenSnap.data();
  if (!tokenSnap.exists || !tokenData || !isTokenNumber(o.tokenNumber)) throw new CommandError('STORE_NOT_CONFIGURED', '餐牌未初始化');
  const board: TokenBoard = { [o.tokenNumber]: { number: o.tokenNumber, state: tokenData.state, orderId: tokenData.orderId, version: tokenData.version } };
  const held = holdToken(board, o.tokenNumber, o.clientOrderId);
  if (!held.ok) {
    throw new CommandError('TOKEN_OCCUPIED', `${o.tokenNumber}号仍被占用`, { tokenNumber: o.tokenNumber, heldByOrderId: tokenData.orderId, state: tokenData.state });
  }

  // ---- 写入 ----
  const orderId = o.clientOrderId;
  const paymentId = `${orderId}-p1`;
  const receiptSeq = day.receiptSeq + 1;
  const receiptNumber = receiptNumberFor(businessDate, receiptSeq);
  const life = newAcceptedState(totals.totalSen);
  const acceptedAt = Timestamp.fromMillis(nowMs);
  const items = lines.map((l, i) => {
    const p = linePortions(menu, l.config);
    return {
      lineId: l.lineId, ...l.config, quantity: l.quantity,
      unitPriceSen: totals.lines[i].unitPriceSen, lineTotalSen: totals.lines[i].lineTotalSen,
      noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount,
      nameZh: lineNameZh(menu, l.config), photoId: linePhotoId(l.config),
      pictogramIds: linePictograms(menu, l.config, o.serviceMode).map((x) => x.id),
    };
  });

  tx.create(store.order(orderId), {
    schemaVersion: 2, storeId: ctx.storeId, id: orderId, receiptNumber, offlineReceiptNumber: null,
    tokenNumber: o.tokenNumber, serviceMode: o.serviceMode, source: 'online', kitchenRouting: 'digital',
    ...life,
    items, totalSen: totals.totalSen, portionCount: totals.portionCount,
    paymentMethod: input.payment.method, cashTenderedSen: input.payment.method === 'cash' ? input.payment.tenderedSen : null, changeSen: pay.changeSen,
    acceptedAtEffective: acceptedAt, acceptedAtEffectiveMs: nowMs, deviceAcceptedAtMs: o.deviceAcceptedAtMs, cloudReceivedAtMs: nowMs,
    kitchenAckAtMs: null, timeQuality: 'server', businessDate, menuVersion: menu.version,
    registerId: input.claim.registerId, registerEpoch: input.claim.registerEpoch, shiftId: input.shiftId, sequence: input.sequence,
    createdBy: actor.uid, updatedAtMs: nowMs,
  });
  tx.create(store.payment(paymentId), {
    id: paymentId, orderId, method: input.payment.method, amountSen: totals.totalSen,
    tenderedSen: input.payment.method === 'cash' ? input.payment.tenderedSen : null, changeSen: pay.changeSen,
    confirmedBy: actor.uid, businessDate, occurredAtMs: nowMs, registerId: input.claim.registerId, shiftId: input.shiftId,
  });
  tx.create(store.orderCost(orderId), {
    orderId, bomVersion: bom.version, businessDate,
    lines: totals.lines.map((l) => ({ lineId: l.lineId, unitCostUnits: l.unitCostUnits, lineCostUnits: l.lineCostUnits })),
    ingredientCostUnits: totals.ingredientCostUnits, packagingCostUnits: totals.packagingCostUnits, totalCostUnits: totals.totalCostUnits,
    allocatedCostUnits: totals.totalCostUnits,
    allocationEvents: [{ id: `${input.operationId}-alloc`, type: 'allocate', costUnits: totals.totalCostUnits, businessDate, atMs: nowMs }],
    pendingCalibration: bom.pendingCalibration,
  });
  tx.set(store.token(o.tokenNumber), { ...held.token, updatedAtMs: nowMs });
  tx.create(store.ticket(orderId), {
    ...buildKitchenTicket(menu, {
      orderId, tokenNumber: o.tokenNumber, serviceMode: o.serviceMode, kitchenRouting: 'digital', fulfillmentStatus: 'queued',
      kitchenCancelRequested: false, acceptedAtEffectiveMs: nowMs, startedAtMs: null, servedAtMs: null, timeQuality: 'server',
      businessDate, version: life.version, lines,
    }),
    kitchenAckAtMs: null,
    receiptNumber,
  });
  tx.update(store.register(input.claim.registerId), { lastAppliedSequence: input.sequence, lastSeenAtMs: nowMs });
  tx.set(store.businessDay(businessDate), { state: 'open', receiptSeq, updatedAtMs: nowMs }, { merge: true });

  const result: CreateOrderResult = {
    orderId, paymentId, receiptNumber, tokenNumber: o.tokenNumber, totalSen: totals.totalSen, changeSen: pay.changeSen, businessDate, acceptedAtMs: nowMs,
  };
  return { result, audit: { entityId: orderId, after: { totalSen: totals.totalSen, tokenNumber: o.tokenNumber, method: input.payment.method } } };
}
