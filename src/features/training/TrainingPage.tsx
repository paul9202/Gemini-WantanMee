/**
 * 员工培训图卡（06 §4）：上半张认餐品与面条，下半张认口味/加料/打包/出餐动作。
 * 与 POS、KDS 共用同一套照片和图卡组件；价格取当前生效菜单。可打印 A4 / A3。
 */
import { useState } from 'react';
import { ENTRY_TILES, MENU_V1, NOODLE_TYPE_NAMES, NoodleType } from '../../domain/menu';
import { formatRM } from '../../domain/money';
import { PICTOGRAMS, PictogramId } from '../../domain/pictograms';
import { useMenu } from '../../data/menu';
import { useSession } from '../../app/session';
import { useLang, useT } from '../../app/i18n';
import { Photo, PictoArt } from '../../ui/visual';

const GROUPS: { zh: string; en: string; ids: PictogramId[] }[] = [
  { zh: '辣度', en: 'Chili', ids: ['spice:none', 'spice:less', 'spice:normal', 'spice:extra'] },
  { zh: '葱', en: 'Scallion', ids: ['scallion:normal', 'scallion:extra', 'scallion:none'] },
  { zh: '油渣', en: 'Lard crisps', ids: ['lard:normal', 'lard:extra', 'lard:none'] },
  { zh: '净面与加料', en: 'Kosong & add-ons', ids: ['kosong:on', 'addon:char_siew', 'addon:wanton_3'] },
  { zh: '堂食 / 打包', en: 'Dine in / Takeaway', ids: ['service:dine_in', 'service:takeaway', 'takeaway:no_side_soup', 'soup:base'] },
  { zh: '后厨动作与餐牌', en: 'Kitchen actions & tokens', ids: ['action:start', 'action:serve', 'action:undo', 'token:return'] },
];

const NOTES: Record<string, { zh: string; en: string }> = {
  'kosong:on': { zh: '半价 · 不能加肉', en: 'Half price · no meat add-ons' },
  'addon:char_siew': { zh: '每份 +RM2', en: '+RM2 each' },
  'addon:wanton_3': { zh: '每份 +RM2', en: '+RM2 each' },
  'takeaway:no_side_soup': { zh: '打包干捞不附汤', en: 'Dry takeaway: no side soup' },
  'soup:base': { zh: '汤类没有酱/辣/油渣选项', en: 'Soups: no sauce/chili/lard options' },
  'action:undo': { zh: '出餐后 30 秒内', en: 'Within 30 s of serving' },
  'token:return': { zh: '拿回实体牌才确认', en: 'Confirm only with token in hand' },
};

export function TrainingPage() {
  const { config } = useSession();
  const menu = useMenu(config?.activeMenuVersion) ?? MENU_V1;
  const tr = useT();
  const lang = useLang();
  const [paper, setPaper] = useState<'A4' | 'A3'>('A4');

  return (
    <div className="mx-auto max-w-5xl p-4 print:max-w-none print:p-0">
      <style>{`@media print { @page { size: ${paper} portrait; margin: 10mm; } }`}</style>
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <h1 className="text-2xl font-bold">{tr('员工培训图卡', 'Staff picture cards')}</h1>
        <div role="radiogroup" aria-label={tr('纸张', 'Paper')} className="ml-auto flex gap-2">
          {(['A4', 'A3'] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={paper === p} onClick={() => setPaper(p)}
              className={`h-12 rounded-lg border-2 px-4 font-semibold ${paper === p ? 'border-brand bg-brand text-white' : 'border-line bg-card'}`}>{p}</button>
          ))}
        </div>
        <button type="button" onClick={() => window.print()} className="h-12 rounded-lg bg-ink px-5 font-bold text-white">{tr('打印', 'Print')}</button>
      </div>

      <article className="training-sheet rounded-2xl border border-line bg-card p-5 print:rounded-none print:border-0 print:p-0" aria-label={tr('图卡', 'Cards')}>
        <header className="mb-4 flex items-baseline gap-3 border-b-2 border-ink pb-2">
          <b className="text-3xl">{config?.name ?? '豪云吞面'}</b>
          <span className="text-lg text-ink-2">{tr('认图卡 · 点单与出餐', 'Picture cards · ordering & serving')}</span>
          <span className="ml-auto text-xs text-ink-2">{menu.version}</span>
        </header>

        <h2 className="mb-2 text-xl font-bold">{tr('① 六种餐品', '① Six dishes')}</h2>
        <ul className="grid grid-cols-3 gap-3 print:grid-cols-6 print:gap-2">
          {ENTRY_TILES.map((t) => {
            const sizes = menu.products[t.productKind].sizes;
            return (
              <li key={t.id} className="flex flex-col items-center rounded-xl border-2 border-line p-2 text-center print:break-inside-avoid">
                <div className="w-full max-w-[150px] print:max-w-[92px]"><Photo id={t.photoId} size={150} fluid rounded={12} /></div>
                <b className="mt-1 text-xl print:mt-0 print:text-lg">{tr(t.nameZh, t.nameEn)}</b>
                <span className="text-sm text-ink-2 tabular-nums print:text-xs">
                  {sizes.map((s) => `${tr(s.nameZh, s.nameEn)} ${formatRM(s.priceSen)}`).join(' · ')}
                </span>
              </li>
            );
          })}
        </ul>

        <h2 className="mt-4 mb-2 text-xl font-bold print:mt-2 print:mb-1">{tr('② 两种面条', '② Two noodles')}</h2>
        <ul className="grid grid-cols-2 gap-3">
          {(Object.keys(NOODLE_TYPE_NAMES) as NoodleType[]).map((n) => (
            <li key={n} className="flex items-center gap-3 rounded-xl border-2 border-line p-2 print:break-inside-avoid">
              <div className="w-[96px] print:w-[64px]"><Photo id={NOODLE_TYPE_NAMES[n].photoId} size={96} fluid rounded={10} /></div>
              <div>
                <b className="text-2xl">{tr(NOODLE_TYPE_NAMES[n].zh, NOODLE_TYPE_NAMES[n].en)}</b>
                <p className="text-sm text-ink-2">{n === 'thin_egg' ? tr('细身蛋面', 'Thin egg noodles') : tr('扁宽面', 'Flat wide noodles')}</p>
              </div>
            </li>
          ))}
        </ul>

        <h2 className="mt-5 mb-2 border-t-2 border-dashed border-line pt-3 text-xl font-bold print:mt-3 print:mb-1 print:pt-2">{tr('③ 图卡含义', '③ What the cards mean')}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2 print:gap-2">
          {GROUPS.map((g) => (
            <section key={g.zh} className="rounded-xl border border-line p-2 print:break-inside-avoid" aria-label={tr(g.zh, g.en)}>
              <h3 className="mb-1 font-bold text-ink-2">{tr(g.zh, g.en)}</h3>
              <ul className="grid grid-cols-2 gap-2">
                {g.ids.map((id) => (
                  <li key={id} className="flex items-center gap-2 rounded-lg bg-subtle px-2 py-1.5 print:py-1">
                    <span className="flex min-w-14 justify-center"><PictoArt id={id} size={36} /></span>
                    <div className="min-w-0 leading-tight">
                      <b className="text-lg">{lang === 'en' ? PICTOGRAMS[id].en : PICTOGRAMS[id].zh}</b>
                      {NOTES[id] && <div className="text-xs text-ink-2">{tr(NOTES[id].zh, NOTES[id].en)}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-2">{tr('斜线 = 不要 / 移除。照片为演示生成图，未经实店审核。', 'A slash means "none / remove". Photos are generated demo images, not shop-approved.')}</p>
      </article>
    </div>
  );
}
