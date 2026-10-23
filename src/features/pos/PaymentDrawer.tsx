/**
 * 收款弹窗：左侧核对本单（应收、餐牌、明细），右侧现金或 QR。
 * 现金：输入实收、显示找零，少收不能确认。QR：员工在收款端核对到账后勾选；断网时另需外部核实说明。
 * 确认前不产生任何支付记录；提交中按钮锁定防止重复收款。
 */
import { useState } from 'react';
import { Cart, OrderTotals } from '../../domain/cart';
import { linePhotoId } from '../../domain/lineItem';
import { MenuVersion } from '../../domain/menu';
import { formatRM, parseRMInput, Sen } from '../../domain/money';
import { checkPayment, PaymentMethod, quickTenderOptions } from '../../domain/payment';
import { Icon, Photo } from '../../ui/visual';
import { useT } from '../../app/i18n';
import { useLineText } from './CartPanel';

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
  CASH_INSUFFICIENT: '实收少于应收，不能确认',
  QR_NOT_CONFIRMED: '请先在收款端核对到账',
  QR_NOT_CONFIGURED: '二维码尚未配置，请改用现金',
  QR_OFFLINE_NEEDS_EXTERNAL_VERIFICATION: '断网时需另一台联网收款端核实',
  EMPTY_ORDER: '本单没有餐品',
};

export function PaymentDrawer({ menu, cart, totals, tokenNumber, qrPayee, online, busy, error, onConfirm, onClose }: {
  menu: MenuVersion;
  cart: Cart;
  totals: OrderTotals;
  tokenNumber: number;
  qrPayee: string | null;
  online: boolean;
  busy: boolean;
  /** 本机保存失败等需要留在弹窗里看到的问题。 */
  error: string | null;
  onConfirm: (p: PaymentInput) => void;
  onClose: () => void;
}) {
  const dueSen = totals.totalSen;
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [text, setText] = useState('');
  const [qrConfirmed, setQrConfirmed] = useState(false);
  const [qrNote, setQrNote] = useState('');
  const tr = useT();
  const lineText = useLineText(menu);
  const tenderedSen = text === '' ? null : parseRMInput(text);
  const invalidText = text !== '' && tenderedSen === null;
  const check = checkPayment(
    { method, dueSen, tenderedSen: method === 'cash' ? tenderedSen : null, qrConfirmed, qrExternalVerificationNote: online ? null : qrNote.trim() || null },
    { online, qrConfigured: Boolean(qrPayee) },
  );

  const press = (k: string) => {
    if (k === '⌫') setText((d) => d.slice(0, -1));
    else setText((d) => {
      const next = (d === '0' && k !== '.' ? '' : d) + k;
      return /^\d{0,4}(\.\d{0,2})?$/.test(next) ? next : d;
    });
  };
  // 触屏设备用弹窗里的数字键，不弹出系统键盘挡住找零和确认；接实体键盘时仍可直接输入。
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  // 软键盘弹出后（页面高度按 interactive-widget=resizes-content 缩小），把正在输入的框滚到可见处。
  const revealOnFocus = (e: React.FocusEvent<HTMLElement>) => {
    const el = e.currentTarget;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  };
  const service = cart.serviceMode === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#1d2420]/55 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={tr('收款', 'Payment')}
      onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
      <div className="flex max-h-[100dvh] w-full max-w-[940px] flex-col overflow-hidden bg-card shadow-2xl sm:max-h-[94dvh] sm:rounded-3xl">
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3 sm:px-7 sm:py-4">
          <div>
            <h2 className="text-xl font-bold sm:text-2xl">{tr('核对本单 · 收款', 'Check order · Payment')}</h2>
            <p className="text-[13px] text-ink-2">{online ? tr('确认到账后，订单才会发送到后厨。', 'The order goes to the kitchen only after payment is confirmed.') : tr('断网中：确认后只保存在本机，请把纸单递给厨师。', 'Offline: saved on this device only — hand the ticket to the cook.')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} autoFocus className="ml-auto flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-line disabled:opacity-40">
            <Icon name="close" size={22} /><span className="sr-only">{tr('返回', 'Back')}</span>
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-y-auto overscroll-contain md:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]">
          <section className="bg-canvas px-5 py-4 sm:px-7 sm:py-5" aria-label={tr('本单', 'Order')}>
            <div className="flex items-center">
              <span className="text-sm text-ink-2">{tr('应收金额', 'Amount due')}</span>
              <span className="ml-auto rounded-lg bg-subtle px-2.5 py-1 text-sm font-semibold">{service} · {tr('餐牌', 'Token')} {tokenNumber}</span>
            </div>
            <div className="mt-1 text-5xl font-black tabular-nums"><span className="mr-1 text-lg font-bold">RM</span>{formatRM(dueSen).replace('RM', '')}</div>
            <ul className="mt-4 divide-y divide-dashed divide-line">
              {cart.lines.map((l) => {
                const x = lineText(l.config, cart.serviceMode);
                const t = totals.lines.find((y) => y.lineId === l.lineId)!;
                return (
                  <li key={l.lineId} className="flex items-start gap-3 py-3">
                    <Photo id={linePhotoId(l.config)} size={44} rounded={22} />
                    <div className="min-w-0 flex-1">
                      <b>{x.name} × {l.quantity}</b>
                      {x.detail && <p className="text-[13px] text-ink-2">{x.detail}</p>}
                      {x.special && <p className="text-[13px] font-semibold text-brand">{x.special}</p>}
                    </div>
                    <b className="tabular-nums">{formatRM(t.lineTotalSen).replace('RM', '')}</b>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn-bg px-3 py-2.5 text-[13px] text-warn">
              <Icon name="help" size={18} />{tr('付款方式和制作状态分开记录：收款成功不代表后厨已收到。', 'Payment and kitchen status are tracked separately: paid does not mean the kitchen has it.')}
            </p>
          </section>

          <section className="flex flex-col px-5 py-4 sm:px-7 sm:py-5">
            <div className="grid grid-cols-2 gap-1 rounded-2xl bg-subtle p-1" role="group" aria-label={tr('付款方式', 'Payment method')}>
              {(['cash', 'qr_manual'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}
                  className={`flex h-14 items-center justify-center gap-2 rounded-xl text-lg font-bold ${method === m ? 'bg-card shadow' : 'text-ink-2'}`}>
                  <Icon name={m === 'cash' ? 'cash' : 'qr'} size={m === 'cash' ? 30 : 24} />{m === 'cash' ? tr('现金', 'Cash') : 'DuitNow QR'}
                </button>
              ))}
            </div>

            {method === 'cash' ? (
              <div className="mt-4">
                <label htmlFor="tendered" className="text-sm font-semibold">{tr('实收现金', 'Cash received')}</label>
                <div className={`mt-1.5 flex items-baseline gap-2 rounded-2xl border-2 px-4 py-2 ${invalidText ? 'border-danger' : 'border-ok'}`}>
                  <span className="text-ink-2">RM</span>
                  <input id="tendered" inputMode={coarse ? 'none' : 'decimal'} autoComplete="off" onFocus={revealOnFocus} value={text} placeholder="0.00"
                    onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, '').slice(0, 7))}
                    className="min-w-0 flex-1 bg-transparent text-4xl font-bold tabular-nums outline-none" aria-describedby="change-box" />
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {quickTenderOptions(dueSen).slice(0, 4).map((v, i) => (
                    <button key={v} type="button" onClick={() => setText((v / 100).toFixed(2))}
                      className="h-14 rounded-xl border border-line bg-canvas font-semibold">{i === 0 ? tr('刚好', 'Exact') : formatRM(v).replace('.00', '').replace('RM', 'RM ')}</button>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-6 gap-1.5 sm:grid-cols-6">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => (
                    <button key={k} type="button" onClick={() => press(k)} aria-label={k === '⌫' ? tr('删除', 'Delete') : k}
                      className="h-14 rounded-xl border border-line text-xl font-bold active:bg-subtle">{k}</button>
                  ))}
                </div>
                <div id="change-box" className={`mt-3 flex items-center justify-between rounded-2xl px-5 py-4 ${check.changeSen !== null ? 'bg-ok-bg text-ok' : 'bg-subtle text-ink-2'}`} aria-live="polite">
                  <span className="font-semibold">{tr('找零', 'Change')}</span>
                  <span className="text-3xl font-black tabular-nums">{check.changeSen !== null ? formatRM(check.changeSen) : '—'}</span>
                </div>
              </div>
            ) : (
              <div className="mt-4">
                {qrPayee ? (
                  <div className="flex items-center gap-4 rounded-2xl border border-line p-4">
                    <span className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-control text-ink-2"><Icon name="qr" size={44} /></span>
                    <div className="min-w-0">
                      <div className="text-sm text-ink-2">{tr('档口收款二维码', 'Stall QR code')}</div>
                      <div className="font-semibold">{qrPayee}</div>
                      <div className="text-2xl font-black tabular-nums">{formatRM(dueSen)}</div>
                    </div>
                  </div>
                ) : (
                  <p className="rounded-2xl bg-warn-bg p-4 text-warn">{tr('二维码尚未配置，请改用现金。', 'QR is not set up. Please take cash.')}</p>
                )}
                <p className="mt-2 text-sm text-warn">{tr('请在档口收款端核对到账。顾客截图不算到账。', 'Check the money arrived on the stall device. A customer screenshot is not proof.')}</p>
                <label className={`mt-3 flex min-h-16 items-center gap-3 rounded-2xl border-2 p-3 text-lg font-semibold ${qrConfirmed ? 'border-ok bg-ok-bg' : 'border-line'}`}>
                  <input type="checkbox" className="h-7 w-7 accent-[var(--color-ok)]" checked={qrConfirmed} disabled={!qrPayee} onChange={(e) => setQrConfirmed(e.target.checked)} />
                  {tr(`我已在收款端看到 ${formatRM(dueSen)} 到账`, `I saw ${formatRM(dueSen)} arrive on the stall device`)}
                </label>
                {!online && (
                  <div className="mt-3 rounded-2xl border-2 border-warn bg-warn-bg p-3">
                    <label htmlFor="qr-note" className="font-semibold text-warn">{tr('断网中：在哪台已联网的收款端核实到账？（必填）', 'Offline: which online device confirmed the payment? (required)')}</label>
                    <input id="qr-note" onFocus={revealOnFocus} value={qrNote} maxLength={200} onChange={(e) => setQrNote(e.target.value)} placeholder={tr('例如：老板手机银行 App 已看到', 'e.g. owner saw it in the bank app')}
                      className="mt-2 h-14 w-full rounded-lg border border-control bg-card px-3 text-base" />
                    <p className="mt-1 text-sm text-warn">{tr('没有另一台联网设备核实时，请改收现金。扫码本身不等于到账。', 'Without another online device to check, take cash. Scanning is not proof of payment.')}</p>
                  </div>
                )}
              </div>
            )}

          </section>
        </div>

        {/* 固定在弹窗底部：软键盘弹出或浏览器工具栏变化时，实收 / 找零 / 确认始终可见。 */}
        <div className="shrink-0 border-t border-line bg-card px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-7">
          {error && <p role="alert" className="mb-2 rounded-lg bg-danger-bg px-3 py-2 font-semibold text-danger">{error}</p>}
          <p className={`mb-2 text-sm ${check.ok ? 'text-ink-2' : 'text-warn'}`}>
            {check.ok ? (method === 'cash' ? tr('核对实收金额和找零，再确认收款。', 'Check cash and change, then confirm.') : tr('已核对到账，可以确认。', 'Payment checked — you can confirm.')) : check.blocks.map((b) => tr(BLOCK_ZH[b] ?? b, BLOCK_EN[b] ?? b)).join(tr('；', '; '))}
          </p>
          <div className="flex flex-wrap items-stretch gap-3">
            <div className="flex min-h-16 min-w-0 flex-1 basis-56 items-center justify-between gap-3 rounded-xl bg-subtle px-4" aria-live="polite" data-testid="pay-summary">
              <span className="text-sm text-ink-2">{tr('应收', 'Due')} <b className="block text-lg text-ink tabular-nums">{formatRM(dueSen)}</b></span>
              {method === 'cash' ? (
                <>
                  <span className="text-sm text-ink-2">{tr('实收', 'Received')} <b className="block text-lg text-ink tabular-nums">{tenderedSen !== null ? formatRM(tenderedSen) : '—'}</b></span>
                  <span className={`text-sm ${check.changeSen !== null ? 'text-ok' : 'text-ink-2'}`}>{tr('找零', 'Change')} <b className="block text-lg tabular-nums">{check.changeSen !== null ? formatRM(check.changeSen) : '—'}</b></span>
                </>
              ) : (
                <span className={`text-sm font-semibold ${qrConfirmed ? 'text-ok' : 'text-warn'}`}>{qrConfirmed ? tr('已核对到账', 'Payment checked') : tr('未核对到账', 'Not checked')}</span>
              )}
            </div>
            <button type="button" disabled={!check.ok || busy}
              onClick={() => onConfirm({ method, tenderedSen: method === 'cash' ? tenderedSen : null, qrConfirmed, qrExternalVerificationNote: !online && method === 'qr_manual' ? qrNote.trim() : null })}
              className="flex min-h-16 flex-1 basis-64 items-center justify-center gap-2 rounded-xl bg-ok px-4 text-xl font-bold text-white hover:bg-ok-pressed disabled:bg-control">
              <Icon name="check" size={24} />{busy ? tr('正在提交，请勿重复点击…', 'Submitting — do not tap again…') : online ? tr('确认收款并接单', 'Confirm payment & send') : tr('确认收款 · 本机接单', 'Confirm payment · save on this device')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
