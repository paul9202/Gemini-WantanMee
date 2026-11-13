/**
 * 收据内容（02 §6）。纯函数生成行文本，UI 只负责排版与打印。
 * - 只显示已发生的出餐时间；未出餐显示当前状态。
 * - 离线收据标「本机接单 / 人工传单」，补同步后仍保留原临时号。
 * - 重印加「副本」，不是新交易。不显示成本与经营利润。
 * - 付款：旧订单保留真实渠道（现金 / QR、实收找零）；新订单不打印虚构渠道，
 *   未登记时醒目标「未收款」，账单不得表现为付款凭证。
 * - 整桌收据（buildBillReceipt）：同桌账单的几张单打在一张纸上，已取消的单只列票号。
 */
import { summarizeBill } from './bill';
import { lineNameZh, LineConfig } from './lineItem';
import { MenuVersion, NOODLE_TYPE_NAMES, OrderServiceMode, SERVICE_MODE_NAMES, ServiceMode } from './menu';
import { formatRM } from './money';
import type { PaymentState } from './orderLifecycle';
import type { PaymentMethod } from './payment';
import { modifierNamesZh } from './pictograms';

export interface ReceiptSource {
  storeName: string;
  receiptNumber: string | null;
  offlineReceiptNumber: string | null;
  tokenNumber: number;
  /** 整单；mixed 时逐行标出堂食 / 打包。 */
  serviceMode: OrderServiceMode;
  source: 'online' | 'offline';
  acceptedAtMs: number;
  timeQuality: 'server' | 'device_estimated' | 'reviewed';
  fulfillmentStatus: 'queued' | 'preparing' | 'served' | 'cancelled';
  servedAtMs: number | null;
  paymentState: PaymentState;
  /** serviceMode：旧订单的行没有，按整单。 */
  lines: { config: LineConfig; quantity: number; unitPriceSen: number; serviceMode?: ServiceMode }[];
  totalSen: number;
  /** 旧订单为真实渠道；新订单未登记时为 null，登记后为 unspecified。 */
  paymentMethod: PaymentMethod | null;
  tenderedSen: number | null;
  changeSen: number | null;
  /** 云端是否已接纳（离线单补同步前为 false）。 */
  synced: boolean;
  /** 取消待后厨确认：整桌收据不计入要收的钱（和账单汇总一致）。 */
  kitchenCancelRequested?: boolean;
}

export interface ReceiptRow {
  left: string;
  right?: string;
  strong?: boolean;
  small?: boolean;
}

export interface ReceiptDoc {
  title: string;
  copyLabel: string | null;
  badges: string[];
  rows: ReceiptRow[];
}

const STATUS_ZH = { queued: '待制作', preparing: '制作中', served: '已出餐', cancelled: '已取消' } as const;
const PAY_ZH: Record<PaymentState, string> = { unpaid: '未收款', paid: '已收款', refund_due: '应退款待处理', refunded: '已退款', not_due: '已取消 · 无需收款', written_off: '未收款（已放弃追收）' };

function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

/** 餐品行：每行一条品名金额，有配置再加一条小字。 */
function lineRows(menu: MenuVersion, r: ReceiptSource): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  for (const l of r.lines) {
    const mode: ServiceMode = l.serviceMode ?? (r.serviceMode === 'mixed' ? 'dine_in' : r.serviceMode);
    rows.push({ left: `${l.quantity} × ${lineNameZh(menu, l.config)}`, right: formatRM(l.unitPriceSen * l.quantity) });
    // 加料只写给哪一碗，名字已经说明是什么料。
    if (l.config.productKind === 'extra') {
      if (l.config.note) rows.push({ left: `  ${l.config.note}`, small: true });
      continue;
    }
    const detail = [
      r.serviceMode === 'mixed' ? SERVICE_MODE_NAMES[mode].zh : null,
      l.config.noodleType ? NOODLE_TYPE_NAMES[l.config.noodleType].zh : null,
      ...modifierNamesZh(menu, l.config, mode),
    ].filter(Boolean);
    if (detail.length) rows.push({ left: `  ${detail.join(' · ')}`, small: true });
  }
  return rows;
}

export function buildReceipt(menu: MenuVersion, r: ReceiptSource, opts: { printIndex: number; timeZone: string }): ReceiptDoc {
  const badges: string[] = [];
  if (r.source === 'offline') badges.push('本机接单 / 人工传单');
  if (r.source === 'offline' && !r.synced) badges.push('尚未同步云端');
  if (r.paymentState === 'unpaid' || r.paymentState === 'written_off') badges.push('未收款 · 不是付款凭证');
  const rows: ReceiptRow[] = [];
  rows.push({ left: `餐牌 ${r.tokenNumber}`, right: SERVICE_MODE_NAMES[r.serviceMode].zh, strong: true });
  if (r.receiptNumber) rows.push({ left: '票号', right: r.receiptNumber });
  if (r.offlineReceiptNumber) rows.push({ left: '临时号', right: r.offlineReceiptNumber });
  rows.push({ left: r.timeQuality === 'device_estimated' ? '接单时间（本机）' : '接单时间', right: clock(r.acceptedAtMs, opts.timeZone), small: true });
  rows.push(...lineRows(menu, r));
  rows.push({ left: '合计', right: formatRM(r.totalSen), strong: true });
  if (r.paymentMethod === 'cash' || r.paymentMethod === 'qr_manual') {
    rows.push({ left: r.paymentMethod === 'cash' ? '现金' : 'DuitNow QR', right: PAY_ZH[r.paymentState] });
  } else {
    rows.push({ left: '付款', right: PAY_ZH[r.paymentState], strong: r.paymentState === 'unpaid' });
  }
  if (r.paymentMethod === 'cash' && r.tenderedSen !== null) {
    rows.push({ left: '实收', right: formatRM(r.tenderedSen) });
    rows.push({ left: '找零', right: formatRM(r.changeSen ?? 0) });
  }
  // 只显示已发生的出餐时间。
  rows.push(r.fulfillmentStatus === 'served' && r.servedAtMs !== null
    ? { left: '出餐时间', right: clock(r.servedAtMs, opts.timeZone), small: true }
    : { left: '状态', right: STATUS_ZH[r.fulfillmentStatus], small: true });
  return { title: r.storeName, copyLabel: opts.printIndex > 0 ? '副本' : null, badges, rows };
}

/**
 * 整桌收据：按接单先后每张单一段；已取消的只列票号和「已取消」。
 * 合计 / 已收 / 还要收只算没取消的单；取消待后厨确认的单还没定，不计。
 */
export function buildBillReceipt(menu: MenuVersion, sources: ReceiptSource[], opts: { printIndex: number; timeZone: string }): ReceiptDoc {
  const list = [...sources].sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);
  const first = list[0];
  if (!first) throw new Error('这桌没有订单');
  const live = list.filter((r) => r.fulfillmentStatus !== 'cancelled');
  const pendingCancel = (r: ReceiptSource) => Boolean(r.kitchenCancelRequested) && r.paymentState === 'unpaid';
  const money = summarizeBill(live.map((r, i) => ({ id: String(i), totalSen: r.totalSen, paymentState: r.paymentState, fulfillmentStatus: r.fulfillmentStatus, kitchenCancelRequested: r.kitchenCancelRequested })));
  const totalSen = live.filter((r) => !pendingCancel(r)).reduce((s, r) => s + r.totalSen, 0);

  const badges: string[] = [];
  if (list.some((r) => r.source === 'offline')) badges.push('本机接单 / 人工传单');
  if (list.some((r) => r.source === 'offline' && !r.synced)) badges.push('尚未同步云端');
  if (live.some((r) => r.paymentState === 'unpaid' || r.paymentState === 'written_off')) badges.push('未收款 · 不是付款凭证');

  const rows: ReceiptRow[] = [];
  // 旧式加单可能发过另一张牌，几张牌都列出来。
  rows.push({ left: `餐牌 ${[...new Set(list.map((r) => r.tokenNumber))].join(' / ')}`, strong: true });
  rows.push({ left: first.timeQuality === 'device_estimated' ? '接单时间（本机）' : '接单时间', right: clock(first.acceptedAtMs, opts.timeZone), small: true });
  for (const r of list) {
    const number = r.receiptNumber
      ? `票号 ${r.receiptNumber}${r.offlineReceiptNumber ? `（${r.offlineReceiptNumber}）` : ''}`
      : `临时号 ${r.offlineReceiptNumber ?? ''}`;
    if (r.fulfillmentStatus === 'cancelled') {
      rows.push({ left: number, right: STATUS_ZH.cancelled });
      continue;
    }
    rows.push({ left: number, right: SERVICE_MODE_NAMES[r.serviceMode].zh, strong: true });
    rows.push(...lineRows(menu, r));
    rows.push({ left: pendingCancel(r) ? '取消待后厨确认，不计' : PAY_ZH[r.paymentState], right: formatRM(r.totalSen), small: true });
  }
  rows.push({ left: '合计', right: formatRM(totalSen), strong: true });
  rows.push({ left: '已收', right: formatRM(money.paidSen) });
  rows.push({ left: '还要收', right: formatRM(money.dueSen), strong: money.dueSen > 0 });
  return { title: first.storeName, copyLabel: opts.printIndex > 0 ? '副本' : null, badges, rows };
}
