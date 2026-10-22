/**
 * 收款抽屉：现金输入实收、显示找零，少收不能确认；QR 需员工在收款端核对后勾选。
 * 确认前不产生任何支付记录。
 */
import { useState } from 'react';
import { formatRM, Sen } from '../../domain/money';
import { checkPayment, PaymentMethod, quickTenderOptions } from '../../domain/payment';
import { Icon } from '../../ui/visual';
import { useT } from '../../app/i18n';

export interface PaymentInput {
  method: PaymentMethod;
  tenderedSen: Sen | null;
  qrConfirmed: boolean;
  /** 断网时 QR 的外部核实说明（另一台已联网的收款端）。 */
  qrExternalVerificationNote: string | null;
}

const BLOCK_EN: Record<string, string> = {
  CASH_NOT_ENTERED: 'Enter the cash received',
  CASH_INSUFFICIENT: 'Cash received is less than the total',
  QR_NOT_CONFIRMED: 'Check the payment arrived on the stall device first',
  QR_NOT_CONFIGURED: 'QR is not set up — take cash',
  QR_OFFLINE_NEEDS_EXTERNAL_VERIFICATION: 'Offline: verify on another online device',
  EMPTY_ORDER: 'No items in this order',
};

const BLOCK_ZH: Record<string, string> = {
  CASH_NOT_ENTERED: '请输入实收金额',
  CASH_INSUFFICIENT: '实收少于应收',
  QR_NOT_CONFIRMED: '请先在收款端核对到账',
  QR_NOT_CONFIGURED: '二维码尚未配置，请改用现金',
  QR_OFFLINE_NEEDS_EXTERNAL_VERIFICATION: '断网时需另一台联网收款端核实',
  EMPTY_ORDER: '本单没有餐品',
};

export function PaymentDrawer({ dueSen, tokenNumber, portions, serviceMode, qrPayee, online, busy, onConfirm, onClose }: {
  dueSen: Sen;
  tokenNumber: number;
  portions: number;
  serviceMode: 'dine_in' | 'takeaway';
  qrPayee: string | null;
  online: boolean;
  busy: boolean;
  onConfirm: (p: PaymentInput) => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>('cash');
  // 键盘按整令吉输入；快捷键可直接设定精确金额（如刚好 RM3.50）。
  const [digits, setDigits] = useState('');
  const [presetSen, setPresetSen] = useState<Sen | null>(null);
  const [qrConfirmed, setQrConfirmed] = useState(false);
  const [qrNote, setQrNote] = useState('');
  const tr = useT();
  const tenderedSen = presetSen ?? (digits === '' ? null : Number(digits) * 100);
  const check = checkPayment(
    { method, dueSen, tenderedSen: method === 'cash' ? tenderedSen : null, qrConfirmed, qrExternalVerificationNote: online ? null : qrNote.trim() || null },
    { online, qrConfigured: Boolean(qrPayee) },
  );

  const press = (k: string) => {
    setPresetSen(null);
    if (k === '⌫') setDigits((d) => d.slice(0, -1));
    else if (k === 'C') setDigits('');
    else setDigits((d) => (d.length >= 4 ? d : (d + k).replace(/^0+/, '')));
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label={tr('收款', 'Payment')} onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
      <div className="flex h-full w-full max-w-[480px] flex-col overflow-y-auto bg-card shadow-2xl">
        <div className="border-b border-line p-4">
          <div className="flex items-center">
            <h2 className="text-2xl font-bold">{tr('收款', 'Payment')}</h2>
            <button type="button" onClick={onClose} disabled={busy} className="ml-auto h-12 rounded-lg border border-line px-4 font-semibold">{tr('返回', 'Back')}</button>
          </div>
          <div className="mt-2 flex items-center gap-3 text-lg">
            <span className="rounded-lg bg-ink px-3 py-1 text-2xl font-black text-white tabular-nums">{tokenNumber}</span>
            <span>{serviceMode === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway')} · {tr(`${portions} 份`, `${portions} portion(s)`)}</span>
          </div>
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-lg">{tr('应收', 'Total')}</span>
            <span className="text-5xl font-black tabular-nums">{formatRM(dueSen)}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 p-4">
          {(['cash', 'qr_manual'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}
              className={`flex h-16 items-center justify-center gap-2 rounded-xl border-2 text-lg font-bold ${method === m ? 'border-ink bg-ok-bg' : 'border-line'}`}>
              <Icon name={m === 'cash' ? 'cash' : 'register'} size={32} />{m === 'cash' ? tr('现金', 'Cash') : 'DuitNow QR'}
            </button>
          ))}
        </div>

        {method === 'cash' ? (
          <div className="px-4">
            <div className="mb-2 grid grid-cols-4 gap-2">
              {quickTenderOptions(dueSen).map((v, i) => (
                <button key={v} type="button" onClick={() => { setDigits(''); setPresetSen(v); }}
                  className="h-12 rounded-lg border border-control font-semibold">{i === 0 ? tr('刚好', 'Exact') : formatRM(v).replace('.00', '')}</button>
              ))}
            </div>
            <div className="mb-2 flex items-baseline justify-between rounded-xl bg-subtle px-4 py-3">
              <span className="text-lg">{tr('实收', 'Received')}</span>
              <span className="text-4xl font-black tabular-nums" aria-live="polite">{tenderedSen === null ? 'RM —' : formatRM(tenderedSen)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
                <button key={k} type="button" onClick={() => press(k)} aria-label={k === '⌫' ? tr('删除', 'Delete') : k === 'C' ? tr('清空', 'Clear') : k}
                  className="h-14 rounded-xl border border-line text-2xl font-bold active:bg-subtle">{k}</button>
              ))}
            </div>
            <div className={`mt-3 flex items-baseline justify-between rounded-xl px-4 py-3 ${check.changeSen !== null ? 'bg-ok-bg text-ok' : 'bg-subtle text-ink-2'}`}>
              <span className="text-lg font-semibold">{tr('找零', 'Change')}</span>
              <span className="text-4xl font-black tabular-nums">{check.changeSen !== null ? formatRM(check.changeSen) : '—'}</span>
            </div>
          </div>
        ) : (
          <div className="px-4">
            {qrPayee ? (
              <div className="rounded-xl border-2 border-line p-4 text-center">
                <div className="mx-auto mb-3 flex h-40 w-40 items-center justify-center rounded-lg border-2 border-dashed border-control text-sm text-ink-2">
                  {tr('档口收款二维码', 'Stall QR code')}<br />{tr('（图片待老板上传）', '(image to be uploaded)')}
                </div>
                <div className="font-semibold">{qrPayee}</div>
                <div className="my-2 text-3xl font-black tabular-nums">{formatRM(dueSen)}</div>
                <p className="text-sm text-warn">{tr('请在档口收款端核对到账。顾客截图不算到账。', 'Check the money arrived on the stall device. A customer screenshot is not proof.')}</p>
              </div>
            ) : (
              <p className="rounded-xl bg-warn-bg p-4 text-warn">{tr('二维码尚未配置，请改用现金。', 'QR is not set up. Please take cash.')}</p>
            )}
            <label className={`mt-3 flex min-h-16 items-center gap-3 rounded-xl border-2 p-3 text-lg font-semibold ${qrConfirmed ? 'border-ok bg-ok-bg' : 'border-control'}`}>
              <input type="checkbox" className="h-7 w-7" checked={qrConfirmed} disabled={!qrPayee} onChange={(e) => setQrConfirmed(e.target.checked)} />
              {tr(`我已在收款端看到 ${formatRM(dueSen)} 到账`, `I saw ${formatRM(dueSen)} arrive on the stall device`)}
            </label>
            {!online && (
              <div className="mt-3 rounded-xl border-2 border-warn bg-warn-bg p-3">
                <label htmlFor="qr-note" className="font-semibold text-warn">{tr('断网中：在哪台已联网的收款端核实到账？（必填）', 'Offline: which online device confirmed the payment? (required)')}</label>
                <input id="qr-note" value={qrNote} maxLength={200} onChange={(e) => setQrNote(e.target.value)} placeholder={tr('例如：老板手机银行 App 已看到', 'e.g. owner saw it in the bank app')}
                  className="mt-2 h-12 w-full rounded-lg border border-control bg-card px-3" />
                <p className="mt-1 text-sm text-warn">{tr('没有另一台联网设备核实时，请改收现金。扫码本身不等于到账。', 'Without another online device to check, take cash. Scanning is not proof of payment.')}</p>
              </div>
            )}
          </div>
        )}

        <div className="mt-auto p-4">
          {!check.ok && <p className="mb-2 text-warn">{check.blocks.map((b) => tr(BLOCK_ZH[b] ?? b, BLOCK_EN[b] ?? b)).join(tr('；', '; '))}</p>}
          <button type="button" disabled={!check.ok || busy}
            onClick={() => onConfirm({ method, tenderedSen: method === 'cash' ? tenderedSen : null, qrConfirmed, qrExternalVerificationNote: !online && method === 'qr_manual' ? qrNote.trim() : null })}
            className="flex h-16 w-full items-center justify-center gap-2 rounded-xl bg-brand text-xl font-bold text-white disabled:bg-control">
            <Icon name="check" size={28} />{busy ? tr('正在提交，请勿重复点击…', 'Submitting — do not tap again…') : online ? tr('确认收款并接单', 'Confirm payment & send') : tr('确认收款 · 本机接单', 'Confirm payment · save on this device')}
          </button>
        </div>
      </div>
    </div>
  );
}
