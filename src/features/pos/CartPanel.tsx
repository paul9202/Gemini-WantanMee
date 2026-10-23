/** 第三栏：本单明细。每行可改数量、编辑、删除（删除可短暂撤销），底部应收合计与「下单送厨」（不收款，收款另行登记）。 */
import { ReactNode } from 'react';
import { Cart, OrderTotals } from '../../domain/cart';
import { LineConfig, lineName, linePhotoId } from '../../domain/lineItem';
import { useLang, useT } from '../../app/i18n';
import { MenuVersion, NOODLE_TYPE_NAMES, SAUCE_NAMES } from '../../domain/menu';
import { formatRM } from '../../domain/money';
import { linePictograms, PICTOGRAMS } from '../../domain/pictograms';
import { Icon, Photo } from '../../ui/visual';
import { Eyebrow, Stepper } from './parts';

/** 「面薄 · 中 · 少辣」这类细节行，以及偏离默认的特别要求。 */
export function useLineText(menu: MenuVersion) {
  const tr = useT();
  const lang = useLang();
  return (cfg: LineConfig, serviceMode: Cart['serviceMode']) => {
    const size = menu.products[cfg.productKind].sizes.find((s) => s.id === cfg.size);
    const sz = size ? tr(size.nameZh, size.nameEn) : '';
    const full = lineName(menu, cfg, lang);
    const name = sz && full.endsWith(` · ${sz}`) ? full.slice(0, -(sz.length + 3)) : full;
    const sauce = cfg.productKind === 'dry_wanton' && cfg.sauce ? tr(SAUCE_NAMES[cfg.sauce].zh, SAUCE_NAMES[cfg.sauce].en) : null;
    const detail = [cfg.noodleType ? tr(NOODLE_TYPE_NAMES[cfg.noodleType].zh, NOODLE_TYPE_NAMES[cfg.noodleType].en) : null, sauce, sz || null].filter(Boolean).join(' · ');
    const special = linePictograms(menu, cfg, serviceMode)
      .filter((p) => p.emphasized && !p.id.startsWith('noodle:') && p.id !== 'takeaway:no_side_soup')
      .map((p) => (lang === 'en' ? PICTOGRAMS[p.id].en : PICTOGRAMS[p.id].zh));
    return { name, detail, special: special.join(' · ') };
  };
}

export function CartPanel({ menu, cart, totals, tokenNumber, editingLineId, onEdit, onQuantity, onClear, onPay, payDisabledReason, children }: {
  menu: MenuVersion;
  cart: Cart;
  totals: OrderTotals;
  tokenNumber: number | null;
  editingLineId: string | null;
  onEdit: (lineId: string) => void;
  onQuantity: (lineId: string, q: number) => void;
  onClear: () => void;
  onPay: () => void;
  payDisabledReason: string | null;
  children?: ReactNode;
}) {
  const tr = useT();
  const text = useLineText(menu);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 px-4 pt-4 pb-2 xl:px-5 xl:pt-5 xl:pb-3">
        <div>
          <Eyebrow>03 / CHECKOUT</Eyebrow>
          <h2 className="mt-1 text-xl font-bold">{tr('本单明细', 'This order')}</h2>
        </div>
        <span className="ml-auto rounded-xl border border-line px-3 py-1.5 text-sm font-semibold" aria-label={tr(`餐牌 ${tokenNumber ?? '—'}`, `Token ${tokenNumber ?? '—'}`)}>
          {tr('餐牌', 'Token')} <b className="text-base tabular-nums">{tokenNumber ?? '—'}</b>
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 xl:px-5" aria-label={tr('本单餐品', 'Order items')}>
        {cart.lines.length === 0 && (
          <li className="flex flex-col items-center gap-2 py-12 text-center text-ink-2">
            <Icon name="bowl" size={40} />{tr('还没有餐品。选好后点「加入本单」。', 'No items yet. Choose a dish, then “Add to order”.')}
          </li>
        )}
        {cart.lines.map((l) => {
          const t = totals.lines.find((x) => x.lineId === l.lineId)!;
          const x = text(l.config, cart.serviceMode);
          const editing = editingLineId === l.lineId;
          return (
            <li key={l.lineId} className={`border-b border-dashed border-line py-4 ${editing ? '-mx-2 rounded-xl border-transparent bg-brand-soft px-2' : ''}`}>
              <div className="flex items-start gap-3">
                <Photo id={linePhotoId(l.config)} size={48} rounded={24} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <b className="leading-tight">{x.name}</b>
                    <b className="ml-auto tabular-nums">{formatRM(t.lineTotalSen).replace('RM', '')}</b>
                  </div>
                  {x.detail && <p className="text-[13px] text-ink-2">{x.detail}</p>}
                  {x.special && <p className="mt-0.5 text-[13px] font-semibold text-brand">{x.special}</p>}
                </div>
              </div>
              {/* 操作行占满整行宽度：窄本单栏（平板约 300px）里数量、编辑、删除也排在同一行。 */}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Stepper size="sm" min={0} value={l.quantity} onChange={(q) => onQuantity(l.lineId, q)} labelLess={tr('减一份', 'One less')} labelMore={tr('加一份', 'One more')} />
                {editing
                  ? <span className="px-1 text-sm font-semibold text-brand">{tr('正在修改…', 'Editing…')}</span>
                  : <button type="button" onClick={() => onEdit(l.lineId)} className="min-h-14 rounded-xl border border-line bg-card px-3 text-sm font-semibold">{tr('编辑', 'Edit')}</button>}
                <button type="button" onClick={() => onQuantity(l.lineId, 0)} className="min-h-14 rounded-xl px-2 text-sm text-ink-2 underline underline-offset-4">{tr('删除', 'Remove')}</button>
                {l.quantity > 1 && <span className="ml-auto text-xs text-ink-2">{tr(`单价 ${formatRM(t.unitPriceSen)}`, `${formatRM(t.unitPriceSen)} each`)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line px-4 py-3 xl:px-5 xl:py-4">
        <div className="flex items-center text-sm text-ink-2">
          <span>{cart.serviceMode === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway')} · {tr(`${totals.portionCount} 份餐品`, `${totals.portionCount} item(s)`)}</span>
          {cart.lines.length > 0 && <button type="button" onClick={onClear} className="ml-auto min-h-14 px-2 underline underline-offset-4">{tr('清空本单', 'Clear order')}</button>}
        </div>
        <div className="my-2 flex items-baseline justify-between xl:my-3">
          <span className="font-semibold">{tr('应收合计', 'Total')}</span>
          <span className="text-4xl font-black tabular-nums"><span className="mr-1 text-base font-bold">RM</span>{formatRM(totals.totalSen).replace('RM', '')}</span>
        </div>
        <button type="button" onClick={onPay} disabled={Boolean(payDisabledReason)}
          className="flex h-16 w-full items-center justify-center gap-3 rounded-xl bg-ok text-xl font-bold text-white hover:bg-ok-pressed disabled:bg-control">
          <Icon name="cook" size={30} />{tr('下单送厨', 'Send to kitchen')} · {formatRM(totals.totalSen)}<Icon name="arrow" size={22} />
        </button>
        {payDisabledReason
          ? <p className="mt-2 text-sm text-warn">{payDisabledReason}</p>
          : <p className="mt-2 text-center text-xs text-ink-2">{tr('下单即送厨，不需先收款；收到钱后在「待登记收款」确认。', 'Goes straight to the kitchen; record the payment under “To record” once collected.')}</p>}
        {children}
      </div>
    </div>
  );
}
