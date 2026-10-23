/**
 * 收款。新流程只记录「员工确认已全额收到」，不区分现金 / TNG / QR，不要求实收与找零：
 * method = 'unspecified'，confirmationMode = 'manual'。系统没有支付网关或到账回调，
 * 显示、扫描、关闭收款码都不等于到账。
 * 旧订单的真实 cash / qr_manual 记录保留可读，不改写；checkPayment 只用于导入旧格式离线日志。
 */
import type { Sen } from './money';

/** 旧版（下单即收款）记录的真实渠道。 */
export type LegacyPaymentMethod = 'cash' | 'qr_manual';
export type PaymentMethod = LegacyPaymentMethod | 'unspecified';
export type ConfirmationMode = 'manual';

export const PAYMENT_METHOD_ZH: Record<PaymentMethod, string> = { cash: '现金', qr_manual: 'DuitNow QR', unspecified: '已确认收款' };

export interface PaymentDraft {
  method: LegacyPaymentMethod;
  dueSen: Sen;
  /** 现金实收；QR 为 null。 */
  tenderedSen: Sen | null;
  /** QR：员工已在收款端核对到账。 */
  qrConfirmed: boolean;
  /** 断网时 QR 的外部核实说明（另一台联网收款端）。 */
  qrExternalVerificationNote: string | null;
}

export type PaymentBlock =
  | 'CASH_NOT_ENTERED' | 'CASH_INSUFFICIENT' | 'QR_NOT_CONFIRMED' | 'QR_OFFLINE_NEEDS_EXTERNAL_VERIFICATION'
  | 'QR_NOT_CONFIGURED' | 'EMPTY_ORDER';

export interface PaymentCheck {
  ok: boolean;
  blocks: PaymentBlock[];
  changeSen: Sen | null;
}

/** 旧格式（下单即收款）离线日志的收款核对。新流程不再调用。 */
export function checkPayment(draft: PaymentDraft, ctx: { online: boolean; qrConfigured: boolean }): PaymentCheck {
  const blocks: PaymentBlock[] = [];
  if (draft.dueSen <= 0) blocks.push('EMPTY_ORDER');
  let changeSen: Sen | null = null;
  if (draft.method === 'cash') {
    if (draft.tenderedSen === null) blocks.push('CASH_NOT_ENTERED');
    else if (draft.tenderedSen < draft.dueSen) blocks.push('CASH_INSUFFICIENT');
    else changeSen = draft.tenderedSen - draft.dueSen;
  } else {
    if (!ctx.qrConfigured) blocks.push('QR_NOT_CONFIGURED');
    if (!draft.qrConfirmed) blocks.push('QR_NOT_CONFIRMED');
    if (!ctx.online && !(draft.qrExternalVerificationNote && draft.qrExternalVerificationNote.trim().length >= 2)) {
      blocks.push('QR_OFFLINE_NEEDS_EXTERNAL_VERIFICATION');
    }
  }
  return { ok: blocks.length === 0, blocks, changeSen };
}

/** 收款流水 ID：同一订单第 n 次登记（更正后可再次登记）。确定性 ID 保证并发时只能生成一笔。 */
export function paymentIdFor(orderId: string, seq: number): string {
  return `${orderId}-p${seq}`;
}

/** 店家收款码（用户提供的原图，字节未改动）。图片标示的收款人；二维码 payload 未解码核实。 */
export const RECEIVING_QR = {
  src: '/payment/tng-receiving-original.jpg',
  payeeLabel: 'TAN CHUN HAO',
  sha256: '08223503ac18f4345632311d6bd2ad8b02a155e8545329c16721c8034e7567fc',
} as const;
