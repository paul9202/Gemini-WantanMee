/**
 * 厨房投影与合计。厨房文档不含售价、付款、成本字段（Firestore 读取是文档级，
 * 只能靠独立文档隔离）。合计只从投影纯计算，不每秒写库。
 */
import { hasNoTomato, LineConfig, lineNameZh, linePhotoId, linePortions } from './lineItem';
import type { OrderLineInput } from './cart';
import { MenuVersion, OrderServiceMode, orderServiceMode, ServiceMode } from './menu';
import { linePictograms, PictogramId } from './pictograms';
import type { Fulfillment } from './orderLifecycle';

export type KitchenRouting = 'digital' | 'manual';
export type TimeQuality = 'server' | 'device_estimated' | 'reviewed';

export interface KitchenLine {
  lineId: string;
  productKind: LineConfig['productKind'];
  size: LineConfig['size'];
  noodleType: LineConfig['noodleType'];
  sauce: LineConfig['sauce'];
  isKosong: boolean;
  spice: LineConfig['spice'];
  lard: LineConfig['lard'];
  scallion: LineConfig['scallion'];
  addOns: LineConfig['addOns'];
  note: string;
  quantity: number;
  /** 这一行堂食还是打包。旧厨单没有此字段，按整单的 serviceMode。 */
  serviceMode?: ServiceMode;
  /** 每份数量。 */
  noodleHalfUnits: number;
  wantonCount: number;
  nameZh: string;
  photoId: string;
  pictograms: { id: PictogramId; emphasized: boolean }[];
}

export interface KitchenTicket {
  orderId: string;
  tokenNumber: number;
  /** 整单：堂食 / 打包 / 堂食+打包（逐行看 KitchenLine.serviceMode）。 */
  serviceMode: OrderServiceMode;
  kitchenRouting: KitchenRouting;
  fulfillmentStatus: Fulfillment;
  kitchenCancelRequested: boolean;
  acceptedAtEffectiveMs: number;
  startedAtMs: number | null;
  /** auto：下单时自动进入制作中，不是厨师实际开工的测量值。 */
  startedSource?: 'auto' | 'manual' | null;
  servedAtMs: number | null;
  timeQuality: TimeQuality;
  businessDate: string;
  lines: KitchenLine[];
  version: number;
  /** 加单（客人吃完再加，多为打包）：原单的餐牌号。普通单为 null / 缺省。 */
  addOnTo?: { tokenNumber: number } | null;
  /** 同牌加单：这桌客人拿着同一张牌又加的单（和前面同号的一起送）。旧单缺省。 */
  sharedToken?: boolean;
  /** 排队位置：同牌加单继承同桌最早未完成单的时间，不重新排队。缺省用接单时间。计时与统计仍按接单时间。 */
  queueAtMs?: number;
  /** 后厨同一个框的分组键（同桌第一张单的 ID）。缺省自成一组。 */
  queueGroupId?: string;
}

export interface KitchenTicketSource {
  orderId: string;
  tokenNumber: number;
  /** 行没有单独标明时的默认就餐方式。 */
  serviceMode: ServiceMode;
  kitchenRouting: KitchenRouting;
  fulfillmentStatus: Fulfillment;
  kitchenCancelRequested: boolean;
  acceptedAtEffectiveMs: number;
  startedAtMs: number | null;
  startedSource: 'auto' | 'manual' | null;
  servedAtMs: number | null;
  timeQuality: TimeQuality;
  businessDate: string;
  version: number;
  lines: OrderLineInput[];
}

/** 某行实际的就餐方式（兼容没有行级字段的旧厨单）。 */
export function kitchenLineMode(t: Pick<KitchenTicket, 'serviceMode'>, l: Pick<KitchenLine, 'serviceMode'>): ServiceMode {
  return l.serviceMode ?? (t.serviceMode === 'mixed' ? 'dine_in' : t.serviceMode);
}

/** 从订单构造厨房投影：显式白名单字段，杜绝金额/成本泄漏。 */
export function buildKitchenTicket(menu: MenuVersion, src: KitchenTicketSource): KitchenTicket {
  const lines = src.lines.map((l) => ({ ...l, serviceMode: l.serviceMode ?? src.serviceMode }));
  return {
    orderId: src.orderId,
    tokenNumber: src.tokenNumber,
    serviceMode: orderServiceMode(lines.map((l) => l.serviceMode), src.serviceMode),
    kitchenRouting: src.kitchenRouting,
    fulfillmentStatus: src.fulfillmentStatus,
    kitchenCancelRequested: src.kitchenCancelRequested,
    acceptedAtEffectiveMs: src.acceptedAtEffectiveMs,
    startedAtMs: src.startedAtMs,
    startedSource: src.startedSource,
    servedAtMs: src.servedAtMs,
    timeQuality: src.timeQuality,
    businessDate: src.businessDate,
    version: src.version,
    lines: lines.map(({ lineId, config: c, quantity, serviceMode }) => {
      const p = linePortions(menu, c);
      return {
        lineId, productKind: c.productKind, size: c.size, noodleType: c.noodleType, sauce: c.sauce, isKosong: c.isKosong,
        spice: c.spice, lard: c.lard, scallion: c.scallion, addOns: [...c.addOns], note: c.note, quantity, serviceMode,
        noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount,
        nameZh: lineNameZh(menu, c), photoId: linePhotoId(c), pictograms: linePictograms(menu, c, serviceMode),
      };
    }),
  };
}

/** FIFO：等得最久的在前；同时间按稳定 ID。 */
export function sortFifo<T extends { acceptedAtEffectiveMs: number; orderId: string }>(tickets: T[]): T[] {
  return [...tickets].sort((a, b) => a.acceptedAtEffectiveMs - b.acceptedAtEffectiveMs || a.orderId.localeCompare(b.orderId));
}

type QueueTicket = { acceptedAtEffectiveMs: number; orderId: string; queueAtMs?: number; queueGroupId?: string };

export interface KitchenGroup<T> {
  key: string;
  /** 组内按接单先后。 */
  tickets: T[];
  queueAtMs: number;
}

/** 后厨队列：同桌的单放进一组，按组内最早的排队位置排；原单先出餐后，加单仍留在原位。 */
export function arrangeKitchen<T extends QueueTicket>(tickets: T[]): KitchenGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const t of sortFifo(tickets)) {
    const key = t.queueGroupId ?? t.orderId;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, tickets: list, queueAtMs: Math.min(...list.map((t) => t.queueAtMs ?? t.acceptedAtEffectiveMs)) }))
    .sort((a, b) => a.queueAtMs - b.queueAtMs || a.key.localeCompare(b.key));
}

export interface BatchCounts {
  orders: number;
  portions: number;
  thinEggHalfUnits: number;
  meePohHalfUnits: number;
  noodleHalfUnits: number;
  wantons: number;
  sauce: { black: number; white: number; red: number };
  dryNoodleBySauce: { black: number; white: number; red: number };
  dryWantonBySauce: { black: number; white: number; red: number };
  soupNoodle: number;
  wantonSoup: number;
  /** 额外标记：已经计入上面的份数，不再重复加总。 */
  kosong: number;
  /** 红酱不要番茄酱的份数（包含在酱料份数里）。 */
  noTomato: number;
}

function emptyCounts(): BatchCounts {
  const z = () => ({ black: 0, white: 0, red: 0 });
  return {
    orders: 0, portions: 0, thinEggHalfUnits: 0, meePohHalfUnits: 0, noodleHalfUnits: 0, wantons: 0,
    sauce: z(), dryNoodleBySauce: z(), dryWantonBySauce: z(), soupNoodle: 0, wantonSoup: 0, kosong: 0, noTomato: 0,
  };
}

function addTicket(c: BatchCounts, t: KitchenTicket) {
  c.orders++;
  for (const l of t.lines) {
    const q = l.quantity;
    c.portions += q;
    const half = l.noodleHalfUnits * q;
    if (l.noodleType === 'thin_egg') c.thinEggHalfUnits += half;
    if (l.noodleType === 'mee_poh') c.meePohHalfUnits += half;
    c.noodleHalfUnits += half;
    c.wantons += l.wantonCount * q;
    if (l.sauce) c.sauce[l.sauce] += q;
    if (l.productKind === 'dry_noodle' && l.sauce) c.dryNoodleBySauce[l.sauce] += q;
    if (l.productKind === 'dry_wanton' && l.sauce) c.dryWantonBySauce[l.sauce] += q;
    if (l.productKind === 'soup_noodle') c.soupNoodle += q;
    if (l.productKind === 'wanton_soup') c.wantonSoup += q;
    if (l.isKosong) c.kosong += q;
    if (hasNoTomato(l)) c.noTomato += q;
  }
}

export interface KitchenSummary {
  /** 全部有效、未出餐、未取消、无取消申请的电子厨单（新单直接制作中，必须一起合计）。 */
  active: BatchCounts;
  /** 取消待后厨确认：冻结，不计入合计、不能正常出餐。 */
  cancelPending: number;
  /** 人工单（manual routing）单独核对，不混入电子合计。 */
  manualPending: number;
}

export function summarizeKitchen(tickets: KitchenTicket[]): KitchenSummary {
  const active = emptyCounts();
  let manualPending = 0;
  let cancelPending = 0;
  for (const t of tickets) {
    const open = t.fulfillmentStatus === 'queued' || t.fulfillmentStatus === 'preparing';
    if (!open) continue;
    if (t.kitchenRouting === 'manual') {
      manualPending++;
      continue;
    }
    if (t.kitchenCancelRequested) {
      cancelPending++;
      continue;
    }
    addTicket(active, t);
  }
  return { active, cancelPending, manualPending };
}

/** 半球单位 → 显示文字，例如 3 → "1.5"。 */
export function formatNoodleBalls(halfUnits: number): string {
  return halfUnits % 2 === 0 ? String(halfUnits / 2) : `${(halfUnits - 1) / 2}.5`;
}
