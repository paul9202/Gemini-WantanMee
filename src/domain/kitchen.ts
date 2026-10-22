/**
 * 厨房投影与合计。厨房文档不含售价、付款、成本字段（Firestore 读取是文档级，
 * 只能靠独立文档隔离）。合计只从投影纯计算，不每秒写库。
 */
import { LineConfig, lineNameZh, linePhotoId, linePortions } from './lineItem';
import type { MenuVersion, ServiceMode } from './menu';
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
  serviceMode: ServiceMode;
  kitchenRouting: KitchenRouting;
  fulfillmentStatus: Fulfillment;
  kitchenCancelRequested: boolean;
  acceptedAtEffectiveMs: number;
  startedAtMs: number | null;
  servedAtMs: number | null;
  timeQuality: TimeQuality;
  businessDate: string;
  lines: KitchenLine[];
  version: number;
}

export interface KitchenTicketSource {
  orderId: string;
  tokenNumber: number;
  serviceMode: ServiceMode;
  kitchenRouting: KitchenRouting;
  fulfillmentStatus: Fulfillment;
  kitchenCancelRequested: boolean;
  acceptedAtEffectiveMs: number;
  startedAtMs: number | null;
  servedAtMs: number | null;
  timeQuality: TimeQuality;
  businessDate: string;
  version: number;
  lines: { lineId: string; config: LineConfig; quantity: number }[];
}

/** 从订单构造厨房投影：显式白名单字段，杜绝金额/成本泄漏。 */
export function buildKitchenTicket(menu: MenuVersion, src: KitchenTicketSource): KitchenTicket {
  return {
    orderId: src.orderId,
    tokenNumber: src.tokenNumber,
    serviceMode: src.serviceMode,
    kitchenRouting: src.kitchenRouting,
    fulfillmentStatus: src.fulfillmentStatus,
    kitchenCancelRequested: src.kitchenCancelRequested,
    acceptedAtEffectiveMs: src.acceptedAtEffectiveMs,
    startedAtMs: src.startedAtMs,
    servedAtMs: src.servedAtMs,
    timeQuality: src.timeQuality,
    businessDate: src.businessDate,
    version: src.version,
    lines: src.lines.map(({ lineId, config: c, quantity }) => {
      const p = linePortions(menu, c);
      return {
        lineId, productKind: c.productKind, size: c.size, noodleType: c.noodleType, sauce: c.sauce, isKosong: c.isKosong,
        spice: c.spice, lard: c.lard, scallion: c.scallion, addOns: [...c.addOns], note: c.note, quantity,
        noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount,
        nameZh: lineNameZh(menu, c), photoId: linePhotoId(c), pictograms: linePictograms(menu, c, src.serviceMode),
      };
    }),
  };
}

/** FIFO：等得最久的在前；同时间按稳定 ID。 */
export function sortFifo<T extends { acceptedAtEffectiveMs: number; orderId: string }>(tickets: T[]): T[] {
  return [...tickets].sort((a, b) => a.acceptedAtEffectiveMs - b.acceptedAtEffectiveMs || a.orderId.localeCompare(b.orderId));
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
}

function emptyCounts(): BatchCounts {
  const z = () => ({ black: 0, white: 0, red: 0 });
  return {
    orders: 0, portions: 0, thinEggHalfUnits: 0, meePohHalfUnits: 0, noodleHalfUnits: 0, wantons: 0,
    sauce: z(), dryNoodleBySauce: z(), dryWantonBySauce: z(), soupNoodle: 0, wantonSoup: 0, kosong: 0,
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
  }
}

/**
 * 待下锅只统计 queued；制作中单独统计，避免同一份再抓一次。
 * 人工单（manual routing）不进入主队列合计。
 */
export function summarizeKitchen(tickets: KitchenTicket[]): { queued: BatchCounts; preparing: BatchCounts; manualPending: number } {
  const queued = emptyCounts();
  const preparing = emptyCounts();
  let manualPending = 0;
  for (const t of tickets) {
    if (t.kitchenRouting === 'manual') {
      if (t.fulfillmentStatus === 'queued' || t.fulfillmentStatus === 'preparing') manualPending++;
      continue;
    }
    if (t.fulfillmentStatus === 'queued') addTicket(queued, t);
    else if (t.fulfillmentStatus === 'preparing') addTicket(preparing, t);
  }
  return { queued, preparing, manualPending };
}

/** 半球单位 → 显示文字，例如 3 → "1.5"。 */
export function formatNoodleBalls(halfUnits: number): string {
  return halfUnits % 2 === 0 ? String(halfUnits / 2) : `${(halfUnits - 1) / 2}.5`;
}
