/**
 * createOrder：下单即送厨。订单、私有成本、餐牌占用、厨房投影（直接制作中）、收银机序号、票号、operation、审计——同一事务。
 * 不收款、不写付款流水：订单待收款（paidSen=0），收款由 recordPayment 另行确认。
 * 服务器按菜单版本重算价格与配置；前端传入的总价只用于比对，不是权威。
 * 旧客户端带 payment 字段（下单即收款）会被拒绝，避免把未付款新单当成已付。
 * 加单（addOnToOrderId）：客人吃完再加（多为打包），照常是一张新单、新厨单、新票号，
 * 但挂到原单上，收款时一次结清（recordGroupPayment，只收还没收的单）。原单须待收款或已收款、未取消、没有取消待确认。
 * 同牌加单（joinTokenOrderId）：客人拿着 N 号牌还要加一碗、或朋友来了再点，新单挂到仍被这桌占着的 N 号上，
 * 不另发牌；N 号上的单全部出餐 / 取消后牌才释放。没指定 addOnToOrderId 时自动并入这一轮占用的同桌账单（组长可以已收款，
 * 账单只收还没收的单）。厨单继承同桌未完成单里最早的排队位置，不重新排队。牌已给了别的客人时拒绝（TOKEN_OCCUPIED），绝不挂到别人的牌上。
 * 下单后加料（extraForOrderId）：只卖叉烧 / 云吞的小单，每行说明给原单的哪一碗（forLineId）。原单金额不变，小单有自己的票号，
 * 并进原单的账单（原单已收款也可以），厨单排在那碗的位置。给哪一碗的文字由服务器写，不信任客户端。
 */
import { businessDateOf } from '../../../src/domain/businessDay';
import { Cart, CartLine, computeTotals } from '../../../src/domain/cart';
import { isValidQuantity, LineConfig, parseLineConfig } from '../../../src/domain/lineItem';
import { SERVICE_MODES, ServiceMode } from '../../../src/domain/menu';
import { loadBom, loadMenu } from '../core/catalog';
import { extraBlockReason, extraNote } from '../../../src/domain/extras';
import { holdForExtra, holdToken, isTokenNumber, joinToken, TokenBoard, tokenFromDoc, tokenHolders, tokenSession } from '../../../src/domain/tokens';
import { CommandContext, runCommand } from '../core/command';
import { AddOnLink, receiptNumberFor, writeAcceptedOrder } from '../core/orderWrites';
import { MAX_GROUP_ORDERS } from './payment';
import { CommandError } from '../core/errors';
import { int, obj, oneOf, optOneOf, str, storeId, uuid, bad } from '../core/input';
import { loadStoreConfig, parseRegisterClaim, REGISTER_CLAIM_FIELDS, requireActiveRegister, requireDayOpen, requireNextSequence } from '../core/store';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

export const MAX_LINES = 30;
/** 一次事务里最多读这么多张同牌的单（牌上挂满时只看最早的几张）。 */
const READ_LIMIT = 10;
const ticketQueueAt = (d: DocumentData) => (d.queueAtMs as number | undefined) ?? (d.acceptedAtEffectiveMs as number);

export interface CreateOrderResult {
  orderId: string;
  receiptNumber: string;
  tokenNumber: number;
  /** 挂到了这桌客人已拿着的牌上（不用再给牌）。 */
  sharedToken: boolean;
  /** 厨单确实继承了同桌的排队位置（牌上只有人工单时不继承）。 */
  queueInherited: boolean;
  /** 并入了哪一张账单（组长单，可能已收款）；单独结账为 null。 */
  addOnToOrderId: string | null;
  totalSen: number;
  paymentState: 'unpaid';
  fulfillmentStatus: 'preparing';
  businessDate: string;
  acceptedAtMs: number;
}

export function parseCreateOrder(raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', ...REGISTER_CLAIM_FIELDS, 'sequence', 'shiftId', 'order']);
  const order = obj(o.order, ['clientOrderId', 'tokenNumber', 'serviceMode', 'menuVersion', 'lines', 'expectedTotalSen', 'deviceAcceptedAtMs', 'addOnToOrderId', 'joinTokenOrderId', 'extraForOrderId'], 'order');
  if (!Array.isArray(order.lines) || order.lines.length < 1 || order.lines.length > MAX_LINES) throw bad(`lines 需 1–${MAX_LINES} 行`);
  const lines = order.lines.map((l, i) => {
    const line = obj(l, ['lineId', 'config', 'quantity', 'serviceMode', 'forLineId'], `lines[${i}]`);
    if (!isValidQuantity(line.quantity)) throw bad(`lines[${i}].quantity 非法`);
    return {
      lineId: str(line, 'lineId', 64), config: line.config as unknown, quantity: line.quantity as number,
      // 行级堂食/打包（同一单可混合）；旧客户端不传，按整单 serviceMode。
      serviceMode: optOneOf(line, 'serviceMode', SERVICE_MODES),
      forLineId: line.forLineId === undefined || line.forLineId === null ? null : str(line, 'forLineId', 64),
    };
  });
  if (new Set(lines.map((l) => l.lineId)).size !== lines.length) throw bad('lineId 重复');
  const tokenNumber = int(order, 'tokenNumber', 1, 50);
  if (order.extraForOrderId !== undefined && order.extraForOrderId !== null && (order.addOnToOrderId || order.joinTokenOrderId)) throw bad('加料不能同时指定加单或同牌加单');
  if ((order.extraForOrderId === undefined || order.extraForOrderId === null) && lines.some((l) => l.forLineId !== null)) throw bad('不是加料不能指定 forLineId');
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
      addOnToOrderId: order.addOnToOrderId === undefined || order.addOnToOrderId === null ? null : uuid(order, 'addOnToOrderId'),
      joinTokenOrderId: order.joinTokenOrderId === undefined || order.joinTokenOrderId === null ? null : uuid(order, 'joinTokenOrderId'),
      extraForOrderId: order.extraForOrderId === undefined || order.extraForOrderId === null ? null : uuid(order, 'extraForOrderId'),
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
  const parent = o.addOnToOrderId ? (await tx.get(store.order(o.addOnToOrderId))).data() : null;
  const tokenNow = tokenFromDoc(o.tokenNumber, tokenSnap.data());
  // 下单后加料：读原单和它的厨单（排队位置从那碗来，不读别的客人的单）。
  const bowlOrder = o.extraForOrderId ? (await tx.get(store.order(o.extraForOrderId))).data() : null;
  const bowlTicket = o.extraForOrderId ? (await tx.get(store.ticket(o.extraForOrderId))).data() : null;
  // 同牌加单且没指定原单：账单组长取这一轮占用里最早的有效单（可以已收款）。指向的单不在本轮占用里就不并账，防止并到上一桌。
  const session = o.joinTokenOrderId && !o.addOnToOrderId && tokenSession(tokenNow).includes(o.joinTokenOrderId) ? tokenSession(tokenNow).slice(0, READ_LIMIT) : [];
  const tablemates = (await Promise.all(session.map((id) => tx.get(store.order(id))))).map((s) => s.data()).filter((d): d is DocumentData => d !== undefined);
  const canLead = (d: DocumentData) => !d.extraOnly && d.fulfillmentStatus !== 'cancelled' && (d.paymentState === 'unpaid' || d.paymentState === 'paid');
  // 牌仍被这桌占着：已收款的单也能当组长。牌已空闲（这桌都出餐了）：只有还欠钱才并账，都收完就是普通新单。
  const billLeader = tokenNow.state === 'held'
    ? tablemates.find(canLead)
    : tablemates.find((d) => canLead(d) && d.paymentState === 'unpaid' && !d.kitchenCancelRequested);
  const billRoot = bowlOrder
    ? ((bowlOrder.addOnTo as AddOnLink | null | undefined)?.orderId ?? o.extraForOrderId)
    : billLeader ? ((billLeader.addOnTo as AddOnLink | null | undefined)?.orderId ?? (billLeader.id as string)) : null;
  // 自动并单前数一下这组还没收款的单：一次结账最多 MAX_GROUP_ORDERS 张，满了就让新单单独收款。
  const groupUnpaid = billRoot
    ? (await tx.get(store.root.collection('orders').where('addOnTo.orderId', '==', billRoot).where('paymentState', '==', 'unpaid'))).size + 1
    : 0;
  // 同牌加单继承同桌未完成电子单里最早的排队位置；只有人工单或都已完成时照常排队尾。
  const queueSources = o.joinTokenOrderId && tokenNow.state === 'held'
    ? (await Promise.all(tokenHolders(tokenNow).slice(0, READ_LIMIT).map((id) => tx.get(store.ticket(id))))).map((s) => s.data())
      .filter((d): d is DocumentData => Boolean(d) && !d!.extraOnly && d!.kitchenRouting === 'digital' && (d!.fulfillmentStatus === 'queued' || d!.fulfillmentStatus === 'preparing'))
    : [];
  const queueFrom = queueSources.reduce<DocumentData | undefined>((best, d) => (!best || ticketQueueAt(d) < ticketQueueAt(best) ? d : best), undefined);
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
  let addOnTo: AddOnLink | null = null;
  if (o.addOnToOrderId) {
    if (!parent) throw new CommandError('NOT_FOUND', '原单不存在');
    if (o.joinTokenOrderId && parent.tokenNumber !== o.tokenNumber) throw new CommandError('ADD_ON_NOT_ALLOWED', '原单不在这张餐牌上');
    // 原单已收款也可以挂（开了出餐即记收款后，吃完再加时原单多半已自动记了收款）；账单只收还没收的单，原单不会再收一次。
    if ((parent.paymentState !== 'unpaid' && parent.paymentState !== 'paid') || parent.fulfillmentStatus === 'cancelled' || parent.kitchenCancelRequested) {
      throw new CommandError('ADD_ON_NOT_ALLOWED', '原单已取消、取消待确认或不能再收款', { paymentState: parent.paymentState, fulfillmentStatus: parent.fulfillmentStatus });
    }
    // 加单的加单仍挂到最早那张原单，一组只有一个根。
    addOnTo = (parent.addOnTo as AddOnLink | null | undefined)
      ?? { orderId: o.addOnToOrderId, tokenNumber: parent.tokenNumber as number, receiptNumber: (parent.receiptNumber as string | null) ?? null };
  } else if (o.extraForOrderId) {
    if (!bowlOrder) throw new CommandError('NOT_FOUND', '原单不存在');
    if (bowlOrder.extraOnly || bowlOrder.fulfillmentStatus === 'cancelled' || bowlOrder.kitchenCancelRequested
      || (bowlOrder.paymentState !== 'unpaid' && bowlOrder.paymentState !== 'paid') || bowlOrder.businessDate !== businessDate) {
      throw new CommandError('EXTRA_NOT_ALLOWED', '这张单不能加料', { fulfillmentStatus: bowlOrder.fulfillmentStatus, paymentState: bowlOrder.paymentState });
    }
    if (groupUnpaid < MAX_GROUP_ORDERS) {
      addOnTo = (bowlOrder.addOnTo as AddOnLink | null | undefined)
        ?? { orderId: o.extraForOrderId, tokenNumber: bowlOrder.tokenNumber as number, receiptNumber: (bowlOrder.receiptNumber as string | null) ?? null };
    }
  } else if (billLeader && groupUnpaid < MAX_GROUP_ORDERS) {
    addOnTo = (billLeader.addOnTo as AddOnLink | null | undefined)
      ?? { orderId: billLeader.id as string, tokenNumber: billLeader.tokenNumber as number, receiptNumber: (billLeader.receiptNumber as string | null) ?? null };
  }
  const menu = await loadMenu(tx, store, o.menuVersion);
  const bom = await loadBom(tx, store, config.activeBomVersion);
  if (!menu || !bom) throw new CommandError('STORE_NOT_CONFIGURED', '菜单或 BOM 版本不可用');

  const lines: CartLine[] = [];
  for (const [i, l] of o.lines.entries()) {
    const parsed = parseLineConfig(menu, l.config, { allowExtra: Boolean(o.extraForOrderId) });
    if (!parsed.ok) throw new CommandError('INVALID_MODIFIER', `第 ${i + 1} 行配置非法`, { line: i, issues: parsed.issues });
    if (!o.extraForOrderId) {
      lines.push({ lineId: l.lineId, config: parsed.value, quantity: l.quantity, serviceMode: l.serviceMode ?? o.serviceMode });
      continue;
    }
    // 加料：每行都只能是加料，并且那一碗确实能加这种料；堂食 / 打包跟那一碗走。
    const bowl = ((bowlOrder?.items ?? []) as (LineConfig & { lineId: string; serviceMode?: ServiceMode })[]).find((it) => it.lineId === l.forLineId);
    if (parsed.value.productKind !== 'extra' || !bowl || extraBlockReason(menu, bowl, parsed.value.addOns[0]) !== null) {
      throw new CommandError('EXTRA_NOT_ALLOWED', `第 ${i + 1} 行不能加这种料`, { line: i });
    }
    lines.push({ lineId: l.lineId, config: { ...parsed.value, note: extraNote(menu, bowl) }, quantity: l.quantity, serviceMode: bowl.serviceMode ?? o.serviceMode });
  }
  const cart: Cart = { serviceMode: o.serviceMode, lines };
  const totals = computeTotals(menu, bom, cart);
  if (totals.totalSen !== o.expectedTotalSen) {
    throw new CommandError('PRICE_MISMATCH', '金额与服务器计算不一致', { serverTotalSen: totals.totalSen });
  }

  const tokenData = tokenSnap.data();
  if (!tokenSnap.exists || !tokenData || !isTokenNumber(o.tokenNumber)) throw new CommandError('STORE_NOT_CONFIGURED', '餐牌未初始化');
  const board: TokenBoard = { [o.tokenNumber]: tokenFromDoc(o.tokenNumber, tokenData) };
  // 同牌加单时牌若已空闲（这桌的单都出餐了、牌没给别人），就按新客人正常占牌，号码不变。
  const sharedToken = Boolean(o.joinTokenOrderId || o.extraForOrderId) && board[o.tokenNumber].state !== 'available';
  const held = o.extraForOrderId ? holdForExtra(board, o.tokenNumber, o.clientOrderId, o.extraForOrderId)
    : o.joinTokenOrderId ? joinToken(board, o.tokenNumber, o.clientOrderId, o.joinTokenOrderId) : holdToken(board, o.tokenNumber, o.clientOrderId);
  if (!held.ok) {
    throw new CommandError('TOKEN_OCCUPIED', o.joinTokenOrderId || o.extraForOrderId ? `${o.tokenNumber}号已给了别的客人` : `${o.tokenNumber}号仍被占用`, { tokenNumber: o.tokenNumber, heldByOrderId: tokenData.orderId, state: tokenData.state });
  }

  // 加料排在那一碗的位置，那碗出餐了也一样，否则等送到时客人已经吃完。人工单没有电子排队，照常排队尾。
  const extraQueue = bowlTicket && bowlTicket.kitchenRouting === 'digital'
    ? { queueAtMs: ticketQueueAt(bowlTicket), queueGroupId: (bowlTicket.queueGroupId as string | undefined) ?? o.extraForOrderId! }
    : null;

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
    createdBy: actor.uid, allocationEventId: `${input.operationId}-alloc`, addOnTo, sharedToken,
    queue: extraQueue ?? (sharedToken && queueFrom ? { queueAtMs: ticketQueueAt(queueFrom), queueGroupId: (queueFrom.queueGroupId as string | undefined) ?? (queueFrom.orderId as string) } : null),
    extraForOrderId: o.extraForOrderId,
  });
  tx.set(store.token(o.tokenNumber), { ...held.token, updatedAtMs: nowMs });
  tx.update(store.register(input.claim.registerId), { lastAppliedSequence: input.sequence, lastSeenAtMs: nowMs });
  tx.set(store.businessDay(businessDate), { state: 'open', receiptSeq, updatedAtMs: nowMs }, { merge: true });

  const result: CreateOrderResult = {
    orderId, receiptNumber, tokenNumber: o.tokenNumber, sharedToken, queueInherited: Boolean(extraQueue) || (sharedToken && Boolean(queueFrom)), addOnToOrderId: addOnTo?.orderId ?? null, totalSen: totals.totalSen, paymentState: 'unpaid', fulfillmentStatus: 'preparing', businessDate, acceptedAtMs: nowMs,
  };
  return { result, audit: { entityId: orderId, after: { totalSen: totals.totalSen, tokenNumber: o.tokenNumber, paymentState: 'unpaid', addOnToOrderId: addOnTo?.orderId ?? null, sharedToken } } };
}
