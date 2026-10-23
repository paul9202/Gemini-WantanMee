/** 第一栏：6 张餐品照片入口（价格来自当前生效菜单，售罄不可点）。 */
import { LineConfig } from '../../domain/lineItem';
import { ENTRY_TILES, EntryTile, MenuVersion } from '../../domain/menu';
import { formatRM } from '../../domain/money';
import { Icon, Photo } from '../../ui/visual';
import { useT } from '../../app/i18n';

function tileSelected(t: EntryTile, c: LineConfig): boolean {
  if (t.productKind !== c.productKind) return false;
  return t.productKind !== 'dry_noodle' || t.sauce === c.sauce;
}

export function ProductGrid({ menu, config, onPick }: { menu: MenuVersion; config: LineConfig; onPick: (t: EntryTile) => void }) {
  const tr = useT();
  return (
    <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
      {ENTRY_TILES.map((t) => {
        const sel = tileSelected(t, config);
        const from = Math.min(...menu.products[t.productKind].sizes.map((s) => s.priceSen));
        const soldOut = menu.soldOut.includes(t.productKind);
        return (
          <button key={t.id} type="button" disabled={soldOut} aria-pressed={sel} aria-label={tr(t.nameZh, t.nameEn)} onClick={() => onPick(t)}
            className={`relative flex min-w-0 flex-col items-center gap-1 rounded-2xl border-2 p-2 pb-3 transition-colors active:translate-y-px disabled:opacity-45 ${
              sel ? 'border-ok bg-ok-bg' : 'border-line bg-card hover:border-control'
            }`}>
            <Photo id={t.photoId} size={136} rounded={14} fluid />
            <b className="mt-1 text-[15px] sm:text-[17px]">{tr(t.nameZh, t.nameEn)}</b>
            <span className="text-[13px] font-semibold sm:text-sm">
              {soldOut ? tr('已售罄', 'Sold out') : <>{formatRM(from).replace('RM', 'RM ')} <span className="font-normal text-ink-2">{tr('起', 'from')}</span></>}
            </span>
            {sel && <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-ok text-white"><Icon name="check" size={15} /></span>}
          </button>
        );
      })}
    </div>
  );
}
