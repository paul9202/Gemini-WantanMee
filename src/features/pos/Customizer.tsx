/**
 * 第二栏：当前餐品配置。常用要求（走青、无油渣、加料）直接可见；葱/油渣多少与净面渐进展开。
 * 所有组合由领域 normalizeConfig 收敛：汤品不显示辣度与油渣，干捞云吞只显示有效酱料，净面清除并锁定肉类加料。
 */
import { ReactNode, useState } from 'react';
import { LineConfig, linePhotoId, normalizeConfig, unitPriceSen } from '../../domain/lineItem';
import { AddOnId, Level, MenuVersion, NOODLE_TYPE_NAMES, Sauce, SAUCE_NAMES, SizeDef, Spice } from '../../domain/menu';
import { formatRM } from '../../domain/money';
import { PictogramId, PICTOGRAMS } from '../../domain/pictograms';
import { Icon, PictoArt, Photo } from '../../ui/visual';
import { useLang, useT } from '../../app/i18n';
import { Choice, Eyebrow, Group, Stepper } from './parts';

const SPICE_ZH: Record<Spice, string> = { none: '不辣', less: '少辣', normal: '普通', extra: '加辣' };
const SPICE_EN: Record<Spice, string> = { none: 'No chili', less: 'Less', normal: 'Normal', extra: 'Extra' };

export function Customizer({ menu, config, onChange, quantity, onQuantity, editing, onSubmit, onCancelEdit }: {
  menu: MenuVersion;
  config: LineConfig;
  onChange: (c: LineConfig) => void;
  quantity: number;
  onQuantity: (n: number) => void;
  editing: boolean;
  onSubmit: () => void;
  onCancelEdit: () => void;
}) {
  const tr = useT();
  const lang = useLang();
  const product = menu.products[config.productKind];
  const set = (patch: Partial<LineConfig>) => onChange(normalizeConfig(menu, { ...config, ...patch }));
  const deep = config.scallion === 'extra' || config.lard === 'extra' || config.isKosong;
  const [showMore, setShowMore] = useState(false);
  const moreOpen = showMore || deep;
  const price = unitPriceSen(menu, config);
  const size = product.sizes.find((s) => s.id === config.size);
  const pic = (id: PictogramId) => (lang === 'en' ? PICTOGRAMS[id].en : PICTOGRAMS[id].zh);

  const name = config.productKind === 'dry_noodle' ? tr(`${SAUCE_NAMES[config.sauce!].zh}面`, `${SAUCE_NAMES[config.sauce!].en} Sauce`) : tr(product.nameZh, product.nameEn);
  const summary = [
    config.isKosong ? tr('净面', 'Kosong') : null,
    config.noodleType ? tr(NOODLE_TYPE_NAMES[config.noodleType].zh, NOODLE_TYPE_NAMES[config.noodleType].en) : null,
    config.productKind === 'dry_wanton' && config.sauce ? tr(SAUCE_NAMES[config.sauce].zh, SAUCE_NAMES[config.sauce].en) : null,
    size ? tr(size.nameZh, size.nameEn) : null,
    config.spice ? (config.spice === 'normal' ? tr('普通辣', 'Normal chili') : tr(SPICE_ZH[config.spice], SPICE_EN[config.spice])) : null,
  ].filter(Boolean).join(' · ');

  const toggleAddOn = (id: AddOnId) => set({ addOns: config.addOns.includes(id) ? config.addOns.filter((a) => a !== id) : [...config.addOns, id] });
  const addOnPrice = (id: AddOnId) => formatRM(menu.addOns[id].priceSen).replace('.00', '');

  const quick = (key: string, selected: boolean, onClick: () => void, art: ReactNode, label: string, extra?: string, disabled?: boolean) => (
    <Choice key={key} selected={selected} disabled={disabled} onClick={onClick} className="flex items-center gap-2.5 px-3 py-2 pr-7 text-left">
      <span className="flex h-9 w-11 shrink-0 items-center justify-center">{art}</span>
      <span className="min-w-0 flex-1 font-semibold leading-tight">{label}{disabled && config.isKosong && <span className="block text-xs font-normal text-ink-2">{tr('净面不可加', 'Not with Kosong')}</span>}</span>
      {extra && <span className="text-xs text-ink-2">{extra}</span>}
    </Choice>
  );

  const levelRow = (kind: 'scallion' | 'lard', value: Level) => (
    <div className="grid grid-cols-3 gap-2">
      {(['normal', 'extra', 'none'] as Level[]).map((lv) => {
        const id = `${kind}:${lv}` as PictogramId;
        return (
          <Choice key={lv} selected={value === lv} onClick={() => set({ [kind]: lv })} className="flex flex-col items-center justify-center gap-1 px-1 py-2">
            <PictoArt id={id} size={26} /><span className="text-sm font-semibold">{pic(id)}</span>
          </Choice>
        );
      })}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 px-4 pt-4 xl:px-6 xl:pt-5">
        <div className="flex items-start gap-3 border-b border-line pb-4">
          <div className="min-w-0 flex-1">
            <Eyebrow>02 / CUSTOMIZE</Eyebrow>
            <h2 className="mt-1 text-2xl font-bold">{name}{editing && <span className="ml-2 rounded-md bg-brand-soft px-2 py-0.5 align-middle text-sm text-brand">{tr('正在修改', 'Editing')}</span>}</h2>
            <p className="mt-0.5 text-[13px] text-ink-2">{summary}</p>
          </div>
          <Photo id={linePhotoId(config)} size={72} rounded={36} />
        </div>

        {product.hasNoodle && (
          <Group title={tr('面条种类', 'Noodles')} hint={tr('两种面，同样好吃', 'Two kinds')}>
            <div className="grid grid-cols-2 gap-2.5">
              {(['thin_egg', 'mee_poh'] as const).map((nt) => (
                <Choice key={nt} selected={config.noodleType === nt} onClick={() => set({ noodleType: nt })} className="flex items-center gap-3 px-3 py-2 pr-8">
                  <Photo id={NOODLE_TYPE_NAMES[nt].photoId} size={52} rounded={10} />
                  <b className="text-lg">{tr(NOODLE_TYPE_NAMES[nt].zh, NOODLE_TYPE_NAMES[nt].en)}</b>
                </Choice>
              ))}
            </div>
          </Group>
        )}

        {product.sauces.length > 0 && config.productKind === 'dry_wanton' && (
          <Group title={tr('酱料', 'Sauce')} hint={tr('干捞云吞只有红 / 黑酱', 'Red or black only')}>
            <div className="grid grid-cols-2 gap-2.5">
              {product.sauces.map((s: Sauce) => (
                <Choice key={s} selected={config.sauce === s} onClick={() => set({ sauce: s })} className="flex items-center gap-3 px-4 py-2">
                  <span className={`h-8 w-8 rounded-full border-2 border-white shadow ${s === 'red' ? 'bg-[#c7482c]' : 'bg-[#2b211c]'}`} />
                  <b className="text-lg">{tr(SAUCE_NAMES[s].zh, SAUCE_NAMES[s].en)}</b>
                </Choice>
              ))}
            </div>
          </Group>
        )}

        <Group title={tr('份量', 'Size')} hint={product.hasNoodle ? tr('用面团数量核对', 'Check by noodle balls') : tr('云吞粒数', 'Wantan count')}>
          <div className={`grid gap-2.5 ${product.sizes.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
            {product.sizes.map((s: SizeDef) => {
              const p = config.isKosong && s.kosongPriceSen !== null ? s.kosongPriceSen : s.priceSen;
              return (
                <Choice key={s.id} selected={config.size === s.id} onClick={() => set({ size: s.id })} className="flex flex-col items-center justify-center px-1 py-2">
                  <span className="flex items-center gap-1">
                    <Icon name={product.hasNoodle ? 'noodle-nest' : 'dumpling'} size={22} />
                    <b className="text-xl">{s.badge}</b>
                  </span>
                  <span className="text-xs text-ink-2">{tr(s.nameZh, s.nameEn)} · {formatRM(p).replace('RM', 'RM ')}</span>
                </Choice>
              );
            })}
          </div>
        </Group>

        {product.allowsSpiceAndLard && config.spice && (
          <Group title={tr('辣度', 'Chili')} hint={tr(`已选：${SPICE_ZH[config.spice]}`, `Selected: ${SPICE_EN[config.spice]}`)}>
            <div className="grid grid-cols-4 gap-2">
              {(['none', 'less', 'normal', 'extra'] as Spice[]).map((sp) => (
                <Choice key={sp} selected={config.spice === sp} onClick={() => set({ spice: sp })} className="flex flex-col items-center justify-center gap-1 py-2">
                  <PictoArt id={`spice:${sp}`} size={24} />
                  <span className="text-sm font-semibold">{tr(SPICE_ZH[sp], SPICE_EN[sp])}</span>
                </Choice>
              ))}
            </div>
          </Group>
        )}

        <Group title={tr('特别要求', 'Special requests')} hint={tr('点击切换 · 图示与后厨一致', 'Tap to toggle · same pictures as kitchen')}>
          <div className="grid grid-cols-2 gap-2.5">
            {quick('scallion', config.scallion === 'none', () => set({ scallion: config.scallion === 'none' ? 'normal' : 'none' }), <PictoArt id="scallion:none" size={30} />, pic('scallion:none'))}
            {config.lard !== null && quick('lard', config.lard === 'none', () => set({ lard: config.lard === 'none' ? 'normal' : 'none' }), <PictoArt id="lard:none" size={30} />, pic('lard:none'))}
            {product.addOns.includes('wanton_3') && quick('w3', config.addOns.includes('wanton_3'), () => toggleAddOn('wanton_3'), <Icon name="dumpling" size={30} />, tr('加 3 粒', '+3 wantan'), `+${addOnPrice('wanton_3')}`, config.isKosong)}
            {product.addOns.includes('char_siew') && quick('cs', config.addOns.includes('char_siew'), () => toggleAddOn('char_siew'), <Photo id="ingredient.char_siew" size={30} rounded={6} />, tr('加叉烧', '+Char siew'), `+${addOnPrice('char_siew')}`, config.isKosong)}
          </div>
          <button type="button" onClick={() => setShowMore(!moreOpen)} aria-expanded={moreOpen} disabled={deep && moreOpen}
            className="mt-2 inline-flex min-h-14 items-center gap-1.5 text-sm text-ink-2 underline underline-offset-4 hover:text-ink disabled:no-underline disabled:opacity-100">
            <Icon name="sliders" size={16} />{product.allowsKosong ? tr('更多配料 / 净面', 'More options / Kosong') : tr('更多配料', 'More options')}
          </button>
          {moreOpen && (
            <div className="mt-2 space-y-3 rounded-2xl border border-line bg-canvas p-3">
              <div><div className="mb-1.5 text-sm font-semibold text-ink-2">{tr('葱花', 'Scallion')}</div>{levelRow('scallion', config.scallion)}</div>
              {config.lard !== null && <div><div className="mb-1.5 text-sm font-semibold text-ink-2">{tr('油渣', 'Lard crisps')}</div>{levelRow('lard', config.lard)}</div>}
              {product.allowsKosong && (
                <Choice selected={config.isKosong} onClick={() => set({ isKosong: !config.isKosong })} className="flex w-full items-center gap-3 px-3 py-2 pr-8 text-left">
                  <PictoArt id="kosong:on" size={30} />
                  <span className="font-semibold leading-tight">{tr('净面 · 半价', 'Kosong · half price')}<br /><span className="text-xs font-normal text-ink-2">{tr('无叉烧、无云吞，已选的肉类加料会清除', 'No char siew or wantan; meat add-ons are removed')}</span></span>
                </Choice>
              )}
            </div>
          )}
        </Group>
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-card px-4 py-3 xl:px-6">
        {!editing && (
          <div className="flex w-full items-center justify-between md:w-auto md:shrink-0">
            <span className="font-bold md:sr-only">{tr('数量', 'Quantity')}</span>
            <Stepper size="sm" value={quantity} onChange={onQuantity} labelLess={tr('减一份', 'One less')} labelMore={tr('加一份', 'One more')} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 gap-2">
          {editing && <button type="button" onClick={onCancelEdit} className="h-14 shrink-0 rounded-xl border border-control px-4 font-semibold">{tr('取消修改', 'Cancel edit')}</button>}
          <button type="button" onClick={onSubmit} className="flex h-14 min-w-0 flex-1 items-center gap-2 rounded-xl bg-brand px-4 text-lg font-bold text-white hover:bg-brand-pressed xl:px-5">
            <Icon name={editing ? 'check' : 'plus'} size={22} className="hidden shrink-0 xl:block" />
            <span className="whitespace-nowrap">{editing ? tr('保存修改', 'Save') : tr('加入本单', 'Add')}<span className="hidden xl:inline">{editing ? tr('', ' change') : tr('', ' to order')}</span></span>
            <span className="ml-auto tabular-nums">{formatRM(price * (editing ? 1 : quantity))}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
