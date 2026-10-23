/**
 * 账本文档 → 财务事件（finance.LedgerEvent），以及日结汇总、报表与 CSV。
 * 前端老板页与服务端关账共用同一套口径，保证屏幕数字与冻结快照一致。
 */
import { addDays, DateRange, wallClock } from './businessDay';
import { ENTRY_TILES } from './menu';
import { CsvCell, toCsv } from './csv';
import { expectedCashDrawer, ExpenseCategory, FixedCostPolicy, LedgerEvent, PeriodSummary, summarizePeriod } from './finance';
import { costUnitsToSen, CostUnits, formatRM, Sen } from './money';
import type { PaymentMethod } from './payment';
import { ServiceSampleSource, serviceStats, ServiceStats } from './timing';
import type { BomVersion } from './bom';

export interface PaymentDoc { id: string; orderId: string; businessDate: string; method: PaymentMethod; amountSen: Sen; occurredAtMs: number }
export interface RefundDoc { id: string; orderId: string; businessDate: string; method: PaymentMethod; amountSen: Sen; occurredAtMs: number; reason: string }
export interface CostEventDoc { id: string; orderId: string; businessDate: string; costUnits: CostUnits; kind: 'allocate' | 'reverse' }
export interface WastageDoc {
  id: string; businessDate: string; costUnits: CostUnits; alreadyAllocated: boolean; noodleHalfUnits: number; wantonCount: number;
  charSiewPortions: number; reason: string; note: string; linkedOrderId: string | null; status: 'active' | 'voided'; occurredAtMs: number;
}
export interface ExpenseDoc {
  id: string; category: ExpenseCategory; description: string; amountSen: Sen; paidSen: Sen; paymentSource: 'drawer' | 'bank' | 'owner';
  businessDate: string; accrualDate: string; status: 'active' | 'voided'; occurredAtMs: number; correctionOf: string | null;
}
export interface CashMovementDoc { id: string; businessDate: string; type: 'opening_float' | 'cash_in' | 'cash_out' | 'bank_deposit'; amountSen: Sen; reason?: string; occurredAtMs: number }

export interface LedgerDocs {
  payments: PaymentDoc[];
  refunds: RefundDoc[];
  costEvents: CostEventDoc[];
  wastage: WastageDoc[];
  expenses: ExpenseDoc[];
  cashMovements: CashMovementDoc[];
}

export function ledgerEvents(d: LedgerDocs): LedgerEvent[] {
  return [
    ...d.payments.map((p): LedgerEvent => ({ kind: 'payment', id: p.id, orderId: p.orderId, businessDate: p.businessDate, method: p.method, amountSen: p.amountSen })),
    ...d.refunds.map((r): LedgerEvent => ({ kind: 'refund', id: r.id, orderId: r.orderId, businessDate: r.businessDate, method: r.method, amountSen: r.amountSen })),
    ...d.costEvents.map((c): LedgerEvent => ({ kind: 'cost_allocation', id: c.id, orderId: c.orderId, businessDate: c.businessDate, costUnits: c.costUnits })),
    ...d.wastage.filter((w) => w.status === 'active').map((w): LedgerEvent => ({
      kind: 'wastage', id: w.id, businessDate: w.businessDate, costUnits: w.costUnits, alreadyAllocated: w.alreadyAllocated,
      noodleHalfUnits: w.noodleHalfUnits, wantonCount: w.wantonCount,
    })),
    // 作废的支出不计入；更正记录本身是新的有效支出。
    ...d.expenses.filter((e) => e.status === 'active').map((e): LedgerEvent => ({
      kind: 'expense', id: e.id, category: e.category, businessDate: e.businessDate, accrualDate: e.accrualDate,
      amountSen: e.amountSen, paidSen: e.paidSen, paidFromDrawer: e.paymentSource === 'drawer',
    })),
    ...d.cashMovements.map((c): LedgerEvent => ({ kind: 'cash_movement', id: c.id, businessDate: c.businessDate, type: c.type, amountSen: c.amountSen })),
  ];
}

/** 损耗成本：按 BOM 单价（半面球、云吞、叉烧），不含底料。 */
export function wastageCostUnits(bom: BomVersion, q: { noodleHalfUnits: number; wantonCount: number; charSiewPortions: number }): CostUnits {
  return q.noodleHalfUnits * bom.noodleHalfBall.thin_egg + q.wantonCount * bom.wanton + q.charSiewPortions * bom.charSiewPortion;
}

export interface CloseInput {
  businessDate: string;
  countedCashSen: Sen;
  qrBankConfirmedSen: Sen;
}

export interface CloseFigures {
  summary: PeriodSummary;
  expectedCashSen: Sen;
  countedCashSen: Sen;
  cashDiffSen: Sen;
  qrLedgerNetSen: Sen;
  qrBankConfirmedSen: Sen;
  qrDiffSen: Sen;
}

/** 日结数字：钱箱应有 vs 实点；QR 账面净额 vs 银行端核对额。QR 不进钱箱。 */
export function closeFigures(docs: LedgerDocs, input: CloseInput, fixed: FixedCostPolicy): CloseFigures {
  const events = ledgerEvents(docs);
  const range: DateRange = { start: input.businessDate, endExclusive: nextDate(input.businessDate) };
  const summary = summarizePeriod(events, range, fixed);
  const expectedCashSen = expectedCashDrawer(events, input.businessDate);
  const qrLedgerNetSen = summary.receipts.qrSen - summary.refunds.qrSen;
  return {
    summary, expectedCashSen, countedCashSen: input.countedCashSen, cashDiffSen: input.countedCashSen - expectedCashSen,
    qrLedgerNetSen, qrBankConfirmedSen: input.qrBankConfirmedSen, qrDiffSen: input.qrBankConfirmedSen - qrLedgerNetSen,
  };
}

function nextDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
}

/** 差额文案：「实际比应有少 RM…」，不只给负号。 */
export function describeDiff(diffSen: Sen): string {
  if (diffSen === 0) return '一致';
  return diffSen < 0 ? `实际比应有少 ${formatRM(-diffSen)}` : `实际比应有多 ${formatRM(diffSen)}`;
}

// ---------- 报表 ----------

export interface OrderReportRow {
  id: string;
  receiptNumber: string;
  businessDate: string;
  tokenNumber: number;
  serviceMode: 'dine_in' | 'takeaway';
  source: 'online' | 'offline';
  fulfillmentStatus: 'queued' | 'preparing' | 'served' | 'cancelled';
  paymentState: 'paid' | 'refund_due' | 'refunded';
  paymentMethod: PaymentMethod;
  totalSen: Sen;
  acceptedAtEffectiveMs: number;
  servedAtMs: number | null;
  timeQuality: 'server' | 'device_estimated' | 'reviewed';
  items: { productKind: string; sauce: string | null; noodleType: string | null; isKosong: boolean; quantity: number; nameZh: string; note?: string }[];
}

export interface ProductMix {
  portionsServed: number;
  byProduct: { key: string; label: string; portions: number }[];
  bySauce: { key: string; label: string; portions: number }[];
  byNoodle: { key: string; label: string; portions: number }[];
}

const PRODUCT_LABEL: Record<string, string> = { dry_noodle: '干捞面', soup_noodle: '云吞汤面', dry_wanton: '干捞云吞', wanton_soup: '云吞汤' };
const SAUCE_LABEL: Record<string, string> = { black: '黑酱', white: '白酱', red: '红酱' };
const NOODLE_LABEL: Record<string, string> = { thin_egg: '细面', mee_poh: '面薄' };

/** 销量与餐品结构：只统计实际已出餐的份数（退款但已出餐的仍算出餐）。 */
export function productMix(orders: OrderReportRow[]): ProductMix {
  const served = orders.filter((o) => o.fulfillmentStatus === 'served');
  const count = (key: (i: OrderReportRow['items'][number]) => string | null, labels: Record<string, string>) => {
    const m = new Map<string, number>();
    for (const o of served) for (const i of o.items) {
      const k = key(i);
      if (k) m.set(k, (m.get(k) ?? 0) + i.quantity);
    }
    return [...m.entries()].map(([k, portions]) => ({ key: k, label: labels[k] ?? k, portions })).sort((a, b) => b.portions - a.portions);
  };
  return {
    portionsServed: served.reduce((s, o) => s + o.items.reduce((t, i) => t + i.quantity, 0), 0),
    byProduct: count((i) => i.productKind, PRODUCT_LABEL),
    bySauce: count((i) => i.sauce, SAUCE_LABEL),
    byNoodle: count((i) => i.noodleType, NOODLE_LABEL),
  };
}

/** 畅销品按 6 张餐品入口排行（干捞面按酱料分开），只统计实际已出餐的份数。净面计入原餐品。 */
export function dishRanking(orders: OrderReportRow[]): { key: string; label: string; photoId: string; portions: number }[] {
  const m = new Map<string, number>();
  for (const o of orders) {
    if (o.fulfillmentStatus !== 'served') continue;
    for (const i of o.items) {
      const tile = ENTRY_TILES.find((t) => t.productKind === i.productKind && (t.productKind !== 'dry_noodle' || t.sauce === i.sauce));
      if (tile) m.set(tile.id, (m.get(tile.id) ?? 0) + i.quantity);
    }
  }
  return [...m.entries()]
    .map(([id, portions]) => {
      const t = ENTRY_TILES.find((x) => x.id === id)!;
      return { key: id, label: t.nameZh, photoId: t.photoId, portions };
    })
    .sort((a, b) => b.portions - a.portions || a.key.localeCompare(b.key));
}

export interface TrendBucket { key: string; label: string; netSen: Sen }

/**
 * 收款走势（实际收款 − 实际退款）。单个营业日按门店时区的整点分组，只覆盖有记录的时段；
 * 多日按营业日分组，区间内没有记录的日子显示为 0。
 */
export function receiptsTrend(payments: PaymentDoc[], refunds: RefundDoc[], range: DateRange, timeZone: string): TrendBucket[] {
  const signed = [...payments.map((p) => ({ ms: p.occurredAtMs, date: p.businessDate, sen: p.amountSen })), ...refunds.map((r) => ({ ms: r.occurredAtMs, date: r.businessDate, sen: -r.amountSen }))]
    .filter((x) => x.date >= range.start && x.date < range.endExclusive);
  if (addDays(range.start, 1) === range.endExclusive) {
    if (!signed.length) return [];
    const byHour = new Map<number, number>();
    for (const x of signed) {
      const h = wallClock(x.ms, timeZone).hh;
      byHour.set(h, (byHour.get(h) ?? 0) + x.sen);
    }
    // 营业日跨零点（例如 04:00 切日）时，凌晨时段排在最后。
    const order = (h: number) => (h < 4 ? h + 24 : h);
    const hours = [...byHour.keys()].map(order);
    const out: TrendBucket[] = [];
    for (let k = Math.min(...hours); k <= Math.max(...hours); k++) {
      const h = k % 24;
      out.push({ key: String(h), label: `${String(h).padStart(2, '0')}:00`, netSen: byHour.get(h) ?? 0 });
    }
    return out;
  }
  const out: TrendBucket[] = [];
  for (let d = range.start; d < range.endExclusive; d = addDays(d, 1)) {
    out.push({ key: d, label: d.slice(5), netSen: signed.filter((x) => x.date === d).reduce((s, x) => s + x.sen, 0) });
  }
  return out;
}

export function orderServiceStats(orders: OrderReportRow[]): ServiceStats {
  return serviceStats(orders.map((o): ServiceSampleSource => ({
    orderId: o.id, serviceMode: o.serviceMode, fulfillmentStatus: o.fulfillmentStatus,
    acceptedAtEffectiveMs: o.acceptedAtEffectiveMs, servedAtMs: o.servedAtMs, timeQuality: o.timeQuality,
  })));
}

// ---------- CSV（UTF-8 BOM；货币列以 sen 为单位并在表头注明；时间带时区） ----------

const iso = (ms: number | null, timeZone: string) => (ms === null ? '' : new Intl.DateTimeFormat('sv-SE', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(ms)) + ' (' + timeZone + ')');

export function csvSummary(s: PeriodSummary): string {
  const rows: CsvCell[][] = [
    ['项目', '金额_sen'],
    ['现金收款', s.receipts.cashSen], ['QR 收款', s.receipts.qrSen], ['现金退款', s.refunds.cashSen], ['QR 退款', s.refunds.qrSen],
    ['净收款', s.netReceiptsSen],
    ['已分配理论成本（四舍五入）', costUnitsToSen(s.allocatedCostUnits)], ['未重复计算的损耗（四舍五入）', costUnitsToSen(s.wastageCostUnits)],
    ['固定费用摊销', s.fixedCostSen], ['其他营业费用', s.otherOpexSen], ['估算经营利润', s.estimatedProfitSen],
    ['已付进货', s.cash.purchasesPaidSen], ['已付营业费用（含固定费用付款）', s.cash.opexPaidSen], ['资本设备付款（另列）', s.cash.capitalPaidSen],
    ['经营现金净流入', s.cash.operatingNetInflowSen],
  ];
  return toCsv([[`区间 ${s.range.start} 至 ${s.range.endExclusive}（不含）`], ...rows]);
}

export function csvOrders(orders: OrderReportRow[], timeZone: string): string {
  return toCsv([
    ['营业日', '票号', '餐牌', '就餐', '来源', '制作状态', '付款状态', '付款方式', '金额_sen', '接单时间', '出餐时间', '时间质量', '餐品'],
    ...orders.map((o) => [
      o.businessDate, o.receiptNumber, o.tokenNumber, o.serviceMode === 'dine_in' ? '堂食' : '打包', o.source === 'offline' ? '离线' : '在线',
      o.fulfillmentStatus, o.paymentState, o.paymentMethod, o.totalSen, iso(o.acceptedAtEffectiveMs, timeZone), iso(o.servedAtMs, timeZone), o.timeQuality,
      o.items.map((i) => `${i.quantity}×${i.nameZh}${i.note ? `（${i.note}）` : ''}`).join('；'),
    ]),
  ]);
}

export function csvPayments(payments: PaymentDoc[], refunds: RefundDoc[], timeZone: string): string {
  return toCsv([
    ['类型', '营业日', '订单', '方式', '金额_sen', '时间', '原因'],
    ...payments.map((p) => ['收款', p.businessDate, p.orderId, p.method, p.amountSen, iso(p.occurredAtMs, timeZone), '']),
    ...refunds.map((r) => ['退款', r.businessDate, r.orderId, r.method, -r.amountSen, iso(r.occurredAtMs, timeZone), r.reason]),
  ]);
}

export function csvExpenses(expenses: ExpenseDoc[], timeZone: string): string {
  return toCsv([
    ['营业日（付款）', '归属日', '类别', '说明', '金额_sen', '已付_sen', '付款来源', '状态', '更正自', '时间'],
    ...expenses.map((e) => [e.businessDate, e.accrualDate, e.category, e.description, e.amountSen, e.paidSen, e.paymentSource, e.status, e.correctionOf ?? '', iso(e.occurredAtMs, timeZone)]),
  ]);
}

export function csvWastage(wastage: WastageDoc[], timeZone: string): string {
  return toCsv([
    ['营业日', '半面球', '云吞', '叉烧份', '原因', '说明', '关联订单', '已在订单成本中', '成本_sen（四舍五入）', '状态', '时间'],
    ...wastage.map((w) => [w.businessDate, w.noodleHalfUnits, w.wantonCount, w.charSiewPortions, w.reason, w.note, w.linkedOrderId ?? '', w.alreadyAllocated ? '是（不重复扣）' : '否', costUnitsToSen(w.costUnits), w.status, iso(w.occurredAtMs, timeZone)]),
  ]);
}

export function csvClose(f: CloseFigures, version: number, note: string): string {
  return toCsv([
    ['日结版本', version], ['营业日', f.summary.range.start],
    ['钱箱应有_sen', f.expectedCashSen], ['钱箱实点_sen', f.countedCashSen], ['现金差额_sen', f.cashDiffSen], ['现金差额说明', describeDiff(f.cashDiffSen)],
    ['QR 账面净额_sen', f.qrLedgerNetSen], ['QR 银行端核对_sen', f.qrBankConfirmedSen], ['QR 差额_sen', f.qrDiffSen],
    ['备注', note],
  ]);
}
