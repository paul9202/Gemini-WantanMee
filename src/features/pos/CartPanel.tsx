/** 右侧本单：行项目照片 + 偏离默认的图卡 + 数量；点行可修改。 */
import { Cart, OrderTotals } from '../../domain/cart';
import { lineName, linePhotoId } from '../../domain/lineItem';
import { useLang, useT } from '../../app/i18n';
import { MenuVersion } from '../../domain/menu';
import { formatRM } from '../../domain/money';
import { linePictograms } from '../../domain/pictograms';
import { Icon, Photo, Picto } from '../../ui/visual';

export function CartPanel({ menu, cart, totals, tokenNumber, editingLineId, onEdit, onQuantity, onPay, payDisabledReason, children }: {
  menu: MenuVersion;
  cart: Cart;
  totals: OrderTotals;
  tokenNumber: number | null;
  editingLineId: string | null;
  onEdit: (lineId: string) => void;
  onQuantity: (lineId: string, q: number) => void;
  onPay: () => void;
  payDisabledReason: string | null;
  children?: React.ReactNode;
}) {
  const tr = useT();
  const lang = useLang();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-2xl font-bold">{tr('本单', 'Order')} · <span className="text-3xl tabular-nums">{tokenNumber ?? '—'}</span></h2>
        <span className="ml-auto inline-flex items-center gap-1 rounded-lg bg-subtle px-2 py-1 font-semibold">
          <Icon name={cart.serviceMode === 'dine_in' ? 'table' : 'bag'} size={22} />{cart.serviceMode === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway')}
        </span>
      </div>
      <ul className="flex-1 space-y-2 overflow-y-auto p-3" aria-label={tr('本单餐品', 'Order items')}>
        {cart.lines.length === 0 && <li className="py-10 text-center text-ink-2">{tr('还没有餐品。点左边的照片加入。', 'No items yet. Tap a photo to add.')}</li>}
        {cart.lines.map((l) => {
          const t = totals.lines.find((x) => x.lineId === l.lineId)!;
          const pics = linePictograms(menu, l.config, cart.serviceMode).filter((p) => p.emphasized || p.id.startsWith('noodle:') || p.id === 'soup:base');
          return (
            <li key={l.lineId} className={`rounded-xl border-2 bg-card p-2 ${editingLineId === l.lineId ? 'border-brand' : 'border-line'}`}>
              <button type="button" onClick={() => onEdit(l.lineId)} className="flex w-full items-start gap-3 text-left" aria-label={`${tr('修改', 'Edit')} ${lineName(menu, l.config, lang)}`}>
                <Photo id={linePhotoId(l.config)} size={72} rounded={10} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <b className="text-lg leading-tight">{lineName(menu, l.config, lang)}</b>
                    <b className="ml-auto text-lg tabular-nums">{formatRM(t.lineTotalSen)}</b>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {pics.map((p) => <Picto key={p.id} id={p.id} size={20} />)}
                  </div>
                </div>
              </button>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-ink-2">{editingLineId === l.lineId ? tr('正在修改…', 'Editing…') : tr(`单价 ${formatRM(t.unitPriceSen)} · 点图片可修改`, `${formatRM(t.unitPriceSen)} each · tap photo to edit`)}</span>
                <div className="ml-auto flex items-center rounded-lg border border-control">
                  <button type="button" aria-label={tr('减一份', 'One less')} onClick={() => onQuantity(l.lineId, l.quantity - 1)} className="h-12 w-12 text-2xl">−</button>
                  <span className="w-8 text-center text-xl font-bold tabular-nums" aria-live="polite">{l.quantity}</span>
                  <button type="button" aria-label={tr('加一份', 'One more')} onClick={() => onQuantity(l.lineId, l.quantity + 1)} className="h-12 w-12 text-2xl">＋</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line bg-card p-4 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
        <div className="flex justify-between text-ink-2"><span>{tr(`共 ${totals.portionCount} 份`, `${totals.portionCount} portion(s)`)}</span>{cart.serviceMode === 'takeaway' && <span>{tr('打包不另收包装费', 'No packaging charge')}</span>}</div>
        <div className="my-2 flex items-baseline justify-between">
          <span className="text-lg font-semibold">{tr('应收', 'Total')}</span>
          <span className="text-4xl font-black tabular-nums">{formatRM(totals.totalSen)}</span>
        </div>
        <button type="button" onClick={onPay} disabled={Boolean(payDisabledReason)}
          className="flex h-16 w-full items-center justify-center gap-2 rounded-xl bg-brand text-xl font-bold text-white hover:bg-brand-pressed disabled:bg-control">
          <Icon name="cash" size={28} />{tr('收款', 'Pay')} {formatRM(totals.totalSen)} →
        </button>
        {payDisabledReason && <p className="mt-2 text-sm text-warn">{payDisabledReason}</p>}
        {children}
      </div>
    </div>
  );
}
