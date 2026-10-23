/**
 * 显示店家收款码（用户提供的原图，字节未改动，离线可用）。
 * 只是给顾客扫码的入口：显示、扫描、关闭、等待都不等于到账，不改变订单付款状态。
 * 系统没有支付网关或 TNG 回调，到账由员工在顾客手机 / 收款端人工核对后，回到订单点「确认已收款」。
 */
import { formatRM, Sen } from '../../domain/money';
import { RECEIVING_QR } from '../../domain/payment';
import { useT } from '../../app/i18n';
import { Icon } from '../../ui/visual';

export function ReceivingQrDialog({ amountSen, label, onClose }: { amountSen: Sen; label: string; onClose: () => void }) {
  const tr = useT();
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#1d2420]/70 p-3" role="dialog" aria-modal="true"
      aria-label={tr('收款码', 'Payment QR')} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="flex max-h-[96dvh] w-full max-w-[920px] flex-col overflow-hidden rounded-3xl bg-card shadow-2xl md:landscape:flex-row">
        <div className="flex min-h-0 flex-1 items-center justify-center bg-white p-3">
          {/* 原图完整显示（object-contain，不裁切、不重绘），保证二维码可扫。 */}
          <img src={RECEIVING_QR.src} alt={tr(`收款码，图片标示收款人 ${RECEIVING_QR.payeeLabel}`, `Payment QR, payee shown as ${RECEIVING_QR.payeeLabel}`)}
            className="max-h-[52dvh] w-auto max-w-full object-contain md:landscape:max-h-[88dvh]" />
        </div>
        <div className="flex shrink-0 flex-col gap-3 p-5 md:landscape:w-[330px]">
          <p className="text-sm text-ink-2">{label}</p>
          <div>
            <span className="text-sm font-semibold text-ink-2">{tr('本单应收', 'Amount due')}</span>
            <div className="text-5xl font-black tabular-nums">{formatRM(amountSen)}</div>
          </div>
          <p className="text-sm">{tr('图片标示收款人：', 'Payee shown on image: ')}<b>{RECEIVING_QR.payeeLabel}</b></p>
          <div role="note" className="rounded-xl border border-warn/40 bg-warn-bg p-3 text-sm text-warn">
            <b className="block">{tr('请顾客核对金额后付款。', 'Ask the customer to check the amount before paying.')}</b>
            {tr('扫码、关闭或等待都不代表已到账。请看到付款成功和金额后，回到订单点「确认已收款」。', 'Scanning, closing or waiting does not mean the money arrived. After you see the payment succeed with the right amount, go back and tap “Confirm received”.')}
          </div>
          <button type="button" onClick={onClose} autoFocus className="mt-auto flex h-14 items-center justify-center gap-2 rounded-xl border border-line text-lg font-bold">
            <Icon name="close" size={22} />{tr('关闭（订单仍待收款）', 'Close (still unpaid)')}
          </button>
        </div>
      </div>
    </div>
  );
}
