/**
 * 收据内容（02 §6）。纯函数生成行文本，UI 只负责排版与打印。
 * - 只显示已发生的出餐时间；未出餐显示当前状态。
 * - 离线收据标「本机接单 / 人工传单」，补同步后仍保留原临时号。
 * - 重印加「副本」，不是新交易。不显示成本与经营利润。
 */
import { lineNameZh, LineConfig } from './lineItem';
import { MenuVersion, NOODLE_TYPE_NAMES } from './menu';
import { formatRM } from './money';
import { linePictograms, PICTOGRAMS } from './pictograms';

export interface ReceiptSource {
  storeName: string;
  receiptNumber: string | null;
  offlineReceiptNumber: string | null;
  tokenNumber: number;
  serviceMode: 'dine_in' | 'takeaway';
  source: 'online' | 'offline';
  acceptedAtMs: number;
  timeQuality: 'server' | 'device_estimated' | 'reviewed';
  fulfillmentStatus: 'queued' | 'preparing' | 'served' | 'cancelled';
  servedAtMs: number | null;
  paymentState: 'paid' | 'refund_due' | 'refunded';
  lines: { config: LineConfig; quantity: number; unitPriceSen: number }[];
  totalSen: number;
  paymentMethod: 'cash' | 'qr_manual';
  tenderedSen: number | null;
  changeSen: number | null;
  /** 云端是否已接纳（离线单补同步前为 false）。 */
  synced: boolean;
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
const PAY_ZH = { paid: '已收款', refund_due: '应退款待处理', refunded: '已退款' } as const;

function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

export function buildReceipt(menu: MenuVersion, r: ReceiptSource, opts: { printIndex: number; timeZone: string }): ReceiptDoc {
  const badges: string[] = [];
  if (r.source === 'offline') badges.push('本机接单 / 人工传单');
  if (r.source === 'offline' && !r.synced) badges.push('尚未同步云端');
  const rows: ReceiptRow[] = [];
  rows.push({ left: `餐牌 ${r.tokenNumber}`, right: r.serviceMode === 'dine_in' ? '堂食' : '打包', strong: true });
  if (r.receiptNumber) rows.push({ left: '票号', right: r.receiptNumber });
  if (r.offlineReceiptNumber) rows.push({ left: '临时号', right: r.offlineReceiptNumber });
  rows.push({ left: r.timeQuality === 'device_estimated' ? '接单时间（本机）' : '接单时间', right: clock(r.acceptedAtMs, opts.timeZone), small: true });
  for (const l of r.lines) {
    rows.push({ left: `${l.quantity} × ${lineNameZh(menu, l.config)}`, right: formatRM(l.unitPriceSen * l.quantity) });
    const detail = [
      l.config.noodleType ? NOODLE_TYPE_NAMES[l.config.noodleType].zh : null,
      ...linePictograms(menu, l.config, r.serviceMode).filter((p) => p.emphasized && !p.id.startsWith('noodle:') && p.id !== 'kosong:on').map((p) => PICTOGRAMS[p.id].zh),
    ].filter(Boolean);
    if (detail.length) rows.push({ left: `  ${detail.join(' · ')}`, small: true });
  }
  rows.push({ left: '合计', right: formatRM(r.totalSen), strong: true });
  rows.push({ left: r.paymentMethod === 'cash' ? '现金' : 'DuitNow QR', right: PAY_ZH[r.paymentState] });
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
