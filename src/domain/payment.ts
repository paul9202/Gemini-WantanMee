/**
 * 收款核对。QR 首版没有银行网关：只能由员工在收款端核对后人工确认，
 * 断网时还需另一台已联网收款端核实并写明说明。
 */
import type { Sen } from './money';

export type PaymentMethod = 'cash' | 'qr_manual';

export interface PaymentDraft {
  method: PaymentMethod;
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

/** 现金快捷键：刚好 + 不少于应收的 RM10/20/50/100。 */
export function quickTenderOptions(dueSen: Sen): Sen[] {
  const notes = [1000, 2000, 5000, 10000].filter((n) => n > dueSen);
  return [dueSen, ...notes];
}
