/**
 * amendOrder（2026-11-16）：还没出餐的电子单直接改（后厨屏为主，收银机、老板也能用；老板定了不用密码，每次留记录）。
 * 改的是原单：单号、餐牌、排队位置、接单时间都不变，后厨卡片留在原位；同一事务更新订单、厨单、私有成本。
 * - 价格：按当前菜单重算整张单（和下单一样不信任前端金额，只比对）。原单里没改的行，就算现在售罄也照样能留着。
 * - 成本：按改前改后的理论成本差额补一笔或冲一笔（costEvent，记今天）。删掉的碗按「还没做」处理。
 * - 钱：没收钱只改应收金额。收过钱且金额变了：冲掉原收款（cause=amend，和原收款成对抵消），订单回到待收款，
 *   记下客人已付多少（amendPriorPaidSen），收银机据此提示补收 / 退给客人多少，再按新金额登记一次。金额没变就不动钱。
 * - 删光不是改单，走取消。撤回改单就是客户端带着改前的内容再改一次（undo=true 只用来在记录里写「撤回」）。
 */
import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import { amendBlock, AmendLine, amendSummaryZh, diffAmend, MAX_AMENDS } from '../../../src/domain/amend';
import { CartLine, computeTotals } from '../../../src/domain/cart';
import { buildKitchenTicket } from '../../../src/domain/kitchen';
import { isValidQuantity, LineConfig, lineMergeKey, parseLineConfig } from '../../../src/domain/lineItem';
import { orderServiceMode, SERVICE_MODES, ServiceMode } from '../../../src/domain/menu';
import { loadBom, loadMenu } from '../core/catalog';
import { runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, int, obj, oneOf, str, storeId, uuid } from '../core/input';
import { orderItems, paymentReversalWrites, TicketPeek } from '../core/orderWrites';
import { loadStoreConfig, markDayActivity, requireDayOpen } from '../core/store';
import { MAX_LINES } from './createOrder';
import { paymentSeqOf } from './payment';

const CONFIG_KEYS: (keyof LineConfig)[] = ['productKind', 'size', 'noodleType', 'sauce', 'spice', 'lard', 'scallion', 'isKosong', 'addOns', 'note'];

function parse(raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'expectedVersion', 'menuVersion', 'lines', 'expectedTotalSen', 'undo']);
  if (!Array.isArray(o.lines) || o.lines.length < 1 || o.lines.length > MAX_LINES) throw bad(`lines 需 1–${MAX_LINES} 行（删光请用取消）`);
  const lines = o.lines.map((l, i) => {
    const line = obj(l, ['lineId', 'config', 'quantity', 'serviceMode'], `lines[${i}]`);
    if (!isValidQuantity(line.quantity)) throw bad(`lines[${i}].quantity 非法`);
    return { lineId: str(line, 'lineId', 64), config: line.config as unknown, quantity: line.quantity as number, serviceMode: oneOf(line, 'serviceMode', SERVICE_MODES) };
  });
  if (new Set(lines.map((l) => l.lineId)).size !== lines.length) throw bad('lineId 重复');
  if (o.undo !== undefined && typeof o.undo !== 'boolean') throw bad('undo 须为布尔值');
  return {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'),
    expectedVersion: int(o, 'expectedVersion', 1, 1_000_000), menuVersion: str(o, 'menuVersion', 64),
    lines, expectedTotalSen: int(o, 'expectedTotalSen', 0, 10_000_000), undo: o.undo === true,
  };
}

export interface AmendOrderResult {
  orderId: string;
  version: number;
  fromTotalSen: number;
  totalSen: number;
  /** 收过钱且金额变了：冲掉的原收款金额；否则 0。 */
  paymentReversedSen: number;
  /** 收银机要按这个提示补收 / 退：客人改单前已付多少（没付过为 null）。 */
  priorPaidSen: number | null;
  summary: string;
}

type ItemDoc = LineConfig & { lineId: string; quantity: number; serviceMode?: ServiceMode };

export async function amendOrder(db: Firestore, uid: string | undefined, raw: unknown) {
  const input = parse(raw);
  return runCommand<AmendOrderResult>(db, {
    type: 'amendOrder', storeId: input.storeId, operationId: input.operationId, uid, roles: ['kitchen', 'cashier', 'owner'], payload: input,
    run: async ({ tx, store, nowMs, actor, operationId }) => {
      // ---- 读取 ----
      const config = await loadStoreConfig(tx, store);
      const orderSnap = await tx.get(store.order(input.orderId));
      const order = orderSnap.data();
      if (!orderSnap.exists || !order) throw new CommandError('NOT_FOUND', '订单不存在');
      const ticketSnap = await tx.get(store.ticket(input.orderId));
      const ticket = ticketSnap.data();
      const ticketPeek: TicketPeek = { exists: ticketSnap.exists, fulfillmentStatus: (ticket?.fulfillmentStatus as string | undefined) ?? null };
      const costSnap = await tx.get(store.orderCost(input.orderId));
      const cost = costSnap.data();
      const today = businessDateOf(nowMs, config.businessDay);
      const day = await requireDayOpen(tx, store, today);
      if (input.menuVersion !== config.activeMenuVersion) {
        throw new CommandError('MENU_CHANGED', '菜单已更新，请重新打开改单', { activeMenuVersion: config.activeMenuVersion });
      }
      const menu = await loadMenu(tx, store, config.activeMenuVersion);
      const bom = await loadBom(tx, store, config.activeBomVersion);
      if (!menu || !bom) throw new CommandError('STORE_NOT_CONFIGURED', '菜单或 BOM 版本不可用');

      // ---- 校验 ----
      const block = amendBlock({
        fulfillmentStatus: order.fulfillmentStatus, kitchenCancelRequested: Boolean(order.kitchenCancelRequested), kitchenRouting: order.kitchenRouting,
        extraOnly: Boolean(order.extraOnly), paymentState: order.paymentState, refundedSen: (order.refundedSen as number | undefined) ?? 0, amendCount: order.amendCount as number | undefined,
      });
      if (block) throw new CommandError('AMEND_NOT_ALLOWED', block === 'too_many' ? `一张单最多改 ${MAX_AMENDS} 次` : block, { block, fulfillmentStatus: order.fulfillmentStatus });
      if (order.version !== input.expectedVersion) throw new CommandError('STALE_VERSION', 'STALE_VERSION', { currentVersion: order.version });
      if (!ticket) throw new CommandError('NOT_FOUND', '厨单不存在');

      const items = ((order.items ?? []) as ItemDoc[]);
      const before: AmendLine[] = items.map((it) => ({
        lineId: it.lineId, quantity: it.quantity, serviceMode: it.serviceMode ?? (order.serviceMode === 'takeaway' ? 'takeaway' : 'dine_in'),
        config: Object.fromEntries(CONFIG_KEYS.map((k) => [k, it[k]])) as unknown as LineConfig,
      }));
      const beforeKey = new Map(before.map((l) => [l.lineId, lineMergeKey(l.config)]));
      const lines: CartLine[] = input.lines.map((l, i) => {
        const parsed = parseLineConfig(menu, l.config);
        if (parsed.ok) return { lineId: l.lineId, config: parsed.value, quantity: l.quantity, serviceMode: l.serviceMode };
        // 原单里没改的行：后来售罄了也能留着（只有售罄这一个问题，而且配置和原来完全一样）。
        const keepSoldOut = parsed.issues.every((x) => x.code === 'SOLD_OUT') && beforeKey.get(l.lineId) === lineMergeKey(l.config as LineConfig);
        if (keepSoldOut) return { lineId: l.lineId, config: l.config as LineConfig, quantity: l.quantity, serviceMode: l.serviceMode };
        throw new CommandError('INVALID_MODIFIER', `第 ${i + 1} 行配置非法`, { line: i, issues: parsed.issues });
      });
      const fallbackMode: ServiceMode = lines[0].serviceMode;
      const totals = computeTotals(menu, bom, { serviceMode: fallbackMode, lines });
      if (totals.totalSen !== input.expectedTotalSen) throw new CommandError('PRICE_MISMATCH', '金额与服务器计算不一致', { serverTotalSen: totals.totalSen });
      const diff = diffAmend(menu, before, lines);
      if (diff.changes.length === 0) throw new CommandError('NOTHING_CHANGED', '这张单没有改动');
      const summary = amendSummaryZh(diff.changes);

      // ---- 写入 ----
      const fromTotalSen = order.totalSen as number;
      const version = (order.version as number) + 1;
      const amendCount = ((order.amendCount as number | undefined) ?? 0) + 1;
      const patch: Record<string, unknown> = {
        items: orderItems(menu, lines, totals), totalSen: totals.totalSen, portionCount: totals.portionCount,
        serviceMode: orderServiceMode(lines.map((l) => l.serviceMode), fallbackMode), version, amendCount, updatedAtMs: nowMs,
      };
      // 钱：收过钱且金额变了 → 冲掉原收款，回到待收款，记下客人已付多少。
      let paymentReversedSen = 0;
      let priorPaidSen: number | null = order.paymentState === 'unpaid' ? ((order.amendPriorPaidSen as number | null | undefined) ?? null) : null;
      if (order.paymentState === 'paid' && totals.totalSen !== fromTotalSen) {
        const rev = paymentReversalWrites(tx, store, {
          orderId: input.orderId, order, seq: paymentSeqOf(order), cause: 'amend', reason: `改单 ${summary}`.slice(0, 200), actorUid: actor.uid,
          businessDate: today, nowMs, operationId, ticket: ticketPeek,
        });
        Object.assign(patch, rev.orderPatch, { paymentState: 'unpaid' });
        paymentReversedSen = order.paidSen as number;
        priorPaidSen = paymentReversedSen;
      }
      patch.amendPriorPaidSen = priorPaidSen;
      const entry = {
        atMs: nowMs, by: actor.uid, role: actor.role, undo: input.undo, fromTotalSen, toTotalSen: totals.totalSen, summary,
        changes: diff.changes, paymentReversedSen,
      };
      patch.lastAmend = entry;
      patch.amendHistory = FieldValue.arrayUnion(entry);
      tx.update(store.order(input.orderId), patch);

      // 厨单：原位不动，只换内容、金额和改单标记。
      const rebuilt = buildKitchenTicket(menu, {
        orderId: input.orderId, tokenNumber: order.tokenNumber, serviceMode: fallbackMode, kitchenRouting: 'digital', fulfillmentStatus: order.fulfillmentStatus,
        kitchenCancelRequested: false, acceptedAtEffectiveMs: order.acceptedAtEffectiveMs, startedAtMs: order.startedAtMs ?? null,
        startedSource: order.startedSource ?? null, servedAtMs: null, timeQuality: order.timeQuality, businessDate: order.businessDate, version, lines,
      });
      tx.update(store.ticket(input.orderId), {
        lines: rebuilt.lines, serviceMode: rebuilt.serviceMode, version, totalSen: totals.totalSen,
        ...(paymentReversedSen > 0 ? { paidBeforeServe: false } : {}),
        priorPaidSen, amendCount, amendedAtMs: nowMs, amendedByRole: actor.role, amendMarks: diff.marks, amendSummary: summary, amendUndo: input.undo,
      });

      // 成本：按差额补一笔或冲一笔（已取消、成本已冲掉的单不会走到这里）。
      if (cost && order.costAllocated !== false) {
        const delta = totals.totalCostUnits - ((cost.allocatedCostUnits as number | undefined) ?? 0);
        const evId = `${operationId}-amend`;
        tx.update(store.orderCost(input.orderId), {
          lines: totals.lines.map((l) => ({ lineId: l.lineId, unitCostUnits: l.unitCostUnits, lineCostUnits: l.lineCostUnits })),
          ingredientCostUnits: totals.ingredientCostUnits, packagingCostUnits: totals.packagingCostUnits, totalCostUnits: totals.totalCostUnits,
          allocatedCostUnits: totals.totalCostUnits,
          ...(delta !== 0 ? { allocationEvents: FieldValue.arrayUnion({ id: evId, type: delta > 0 ? 'allocate' : 'reverse', costUnits: delta, businessDate: today, atMs: nowMs }) } : {}),
        });
        if (delta !== 0) {
          tx.create(store.costEvent(evId), { id: evId, orderId: input.orderId, businessDate: today, costUnits: delta, kind: delta > 0 ? 'allocate' : 'reverse', atMs: nowMs });
        }
      }
      markDayActivity(tx, store, today, day, nowMs);

      const result: AmendOrderResult = { orderId: input.orderId, version, fromTotalSen, totalSen: totals.totalSen, paymentReversedSen, priorPaidSen, summary };
      return {
        result,
        audit: {
          entityId: input.orderId,
          before: { totalSen: fromTotalSen, version: order.version, paymentState: order.paymentState },
          after: { totalSen: totals.totalSen, version, paymentState: patch.paymentState ?? order.paymentState, summary, undo: input.undo, paymentReversedSen },
        },
      };
    },
  });
}
