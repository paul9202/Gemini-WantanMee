/**
 * 左侧选餐画布：6 张餐品照片 → 面种原料图 → 份量图卡 → 辣度 → 其他要求。
 * 所有组合由领域 normalizeConfig 收敛，汤品不显示酱/辣/油渣，Kosong 锁定肉类加料。
 */
import { ReactNode, useState } from 'react';
import { LineConfig, normalizeConfig, unitPriceSen } from '../../domain/lineItem';
import { ENTRY_TILES, EntryTile, Level, MenuVersion, NOODLE_TYPE_NAMES, Sauce, SAUCE_NAMES, SizeDef, Spice } from '../../domain/menu';
import { formatRM } from '../../domain/money';
import { PictogramId } from '../../domain/pictograms';
import { Icon, PictoArt, Photo } from '../../ui/visual';

function Step({ n, title, hint, children }: { n: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-sm font-bold text-white">{n}</span>
        <h2 className="text-lg font-bold">{title}</h2>
        {hint && <span className="ml-auto text-sm text-ink-2">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Choice({ selected, disabled, onClick, children, className = '', label }: {
  selected: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; className?: string; label?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-pressed={selected} aria-label={label}
      className={`relative min-h-14 rounded-xl border-2 bg-card transition-colors active:scale-[0.98] ${
        selected ? 'border-ink bg-ok-bg' : 'border-line hover:border-control'
      } ${disabled ? 'opacity-45' : ''} ${className}`}
    >
      {children}
      {selected && <span className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-white"><Icon name="check" size={16} /></span>}
    </button>
  );
}

function tileSelected(t: EntryTile, c: LineConfig): boolean {
  if (t.productKind !== c.productKind) return false;
  return t.productKind !== 'dry_noodle' || t.sauce === c.sauce;
}

export function ProductPanel({ menu, config, onChange, editing, onSubmit, onCancelEdit }: {
  menu: MenuVersion;
  config: LineConfig;
  onChange: (c: LineConfig) => void;
  editing: boolean;
  onSubmit: () => void;
  onCancelEdit: () => void;
}) {
  const product = menu.products[config.productKind];
  const set = (patch: Partial<LineConfig>) => onChange(normalizeConfig(menu, { ...config, ...patch }));
  const hasSpecial = config.scallion !== 'normal' || (config.lard ?? 'normal') !== 'normal' || config.addOns.length > 0 || config.isKosong;
  const [showMore, setShowMore] = useState(false);
  const moreOpen = showMore || hasSpecial;
  const price = unitPriceSen(menu, config);

  const toggleAddOn = (id: 'char_siew' | 'wanton_3') =>
    set({ addOns: config.addOns.includes(id) ? config.addOns.filter((a) => a !== id) : [...config.addOns, id] });

  const levelRow = (kind: 'scallion' | 'lard', value: Level) => (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {(['normal', 'extra', 'none'] as Level[]).map((lv) => {
        const id = `${kind}:${lv}` as PictogramId;
        const zh = { scallion: { normal: '正常葱', extra: '多葱', none: '走青' }, lard: { normal: '正常油渣', extra: '多油渣', none: '无油渣' } }[kind][lv];
        return (
          <Choice key={lv} selected={value === lv} onClick={() => set({ [kind]: lv })} className="flex items-center justify-center gap-2 px-2 py-2">
            <PictoArt id={id} size={30} /><span className="font-semibold">{zh}</span>
          </Choice>
        );
      })}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4 pb-2">
        <Step n="1" title="看图选餐" hint="6张入口 · 4类餐品">
          <div className="grid grid-cols-3 gap-2 sm:gap-3 xl:grid-cols-6">
            {ENTRY_TILES.map((t) => {
              const sel = tileSelected(t, config);
              const from = Math.min(...menu.products[t.productKind].sizes.map((s) => s.priceSen));
              const soldOut = menu.soldOut.includes(t.productKind);
              return (
                <Choice key={t.id} selected={sel} disabled={soldOut} label={t.nameZh}
                  onClick={() => set({ productKind: t.productKind, sauce: t.productKind === 'dry_noodle' ? t.sauce : config.sauce })}
                  className="flex min-w-0 flex-col items-center gap-1 p-1.5 pb-2 sm:p-2 sm:pb-3">
                  <Photo id={t.photoId} size={104} rounded={10} fluid />
                  <b className="text-base sm:text-lg">{t.nameZh}</b>
                  <span className="text-sm text-ink-2">{soldOut ? '已售罄' : `${formatRM(from).replace('.00', '')} 起`}</span>
                </Choice>
              );
            })}
          </div>
        </Step>

        {product.hasNoodle && (
          <Step n="2" title="面条种类">
            <div className="grid grid-cols-2 gap-3">
              {(['thin_egg', 'mee_poh'] as const).map((nt) => (
                <Choice key={nt} selected={config.noodleType === nt} onClick={() => set({ noodleType: nt })} className="flex items-center gap-4 p-2 pr-10">
                  <Photo id={NOODLE_TYPE_NAMES[nt].photoId} size={80} rounded={10} />
                  <b className="text-xl">{NOODLE_TYPE_NAMES[nt].zh}</b>
                </Choice>
              ))}
            </div>
          </Step>
        )}

        {config.productKind === 'dry_wanton' && (
          <Step n="2" title="酱料" hint="干捞云吞依餐牌只有红 / 黑酱">
            <div className="grid grid-cols-2 gap-3">
              {product.sauces.map((s: Sauce) => (
                <Choice key={s} selected={config.sauce === s} onClick={() => set({ sauce: s })} className="flex items-center gap-3 px-4 py-3">
                  <span className={`h-9 w-9 rounded-full border-2 border-white shadow ${s === 'red' ? 'bg-[#c7482c]' : 'bg-[#2b211c]'}`} />
                  <b className="text-xl">{SAUCE_NAMES[s].zh}</b>
                </Choice>
              ))}
            </div>
          </Step>
        )}

        <Step n="3" title="份量" hint={product.hasNoodle ? '用面团图分清 1／1½／2' : '云吞粒数'}>
          <div className={`grid gap-3 ${product.sizes.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'}`}>
            {product.sizes.map((s: SizeDef) => {
              const p = config.isKosong && s.kosongPriceSen !== null ? s.kosongPriceSen : s.priceSen;
              return (
                <Choice key={s.id} selected={config.size === s.id} onClick={() => set({ size: s.id })} className="flex items-center gap-2 px-3 py-2 pr-9">
                  <span className="flex items-center text-[#d1a23e]">
                    {product.hasNoodle
                      ? Array.from({ length: Math.ceil(s.noodleHalfUnits / 2) }, (_, i) => (
                          <span key={i} style={i * 2 + 1 === s.noodleHalfUnits ? { clipPath: 'inset(0 50% 0 0)', width: 18, overflow: 'hidden' } : undefined}>
                            <Icon name="noodle-nest" size={36} />
                          </span>
                        ))
                      : <Icon name="dumpling" size={36} />}
                  </span>
                  <b className="text-2xl">{s.badge}</b>
                  <span className="ml-auto text-right leading-tight">
                    <span className="block text-sm text-ink-2">{s.nameZh}</span>
                    <b className="text-base">{formatRM(p)}</b>
                  </span>
                </Choice>
              );
            })}
          </div>
        </Step>

        {product.allowsSpiceAndLard && (
          <Step n="4" title="辣度">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(['none', 'less', 'normal', 'extra'] as Spice[]).map((sp) => (
                <Choice key={sp} selected={config.spice === sp} onClick={() => set({ spice: sp })} className="flex flex-col items-center justify-center gap-1 py-2">
                  <PictoArt id={`spice:${sp}`} size={26} />
                  <span className="font-semibold">{{ none: '不辣', less: '少辣', normal: '普通', extra: '加辣' }[sp]}</span>
                </Choice>
              ))}
            </div>
          </Step>
        )}

        <section className="mb-4">
          <button type="button" onClick={() => setShowMore(!moreOpen)} aria-expanded={moreOpen}
            className="mb-2 flex w-full items-center gap-2 text-left">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-sm font-bold text-white">＋</span>
            <h2 className="text-lg font-bold">其他要求</h2>
            <span className="ml-auto text-sm text-ink-2">{moreOpen ? '收起' : '有需要再点'}</span>
          </button>
          {moreOpen && (
            <div className="space-y-3 rounded-xl border border-line bg-card p-3">
              <div><div className="mb-1 text-sm font-semibold text-ink-2">葱花</div>{levelRow('scallion', config.scallion)}</div>
              {config.lard !== null && <div><div className="mb-1 text-sm font-semibold text-ink-2">油渣</div>{levelRow('lard', config.lard)}</div>}
              <div>
                <div className="mb-1 text-sm font-semibold text-ink-2">加料 · 每项 RM2</div>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                  {product.addOns.includes('char_siew') && (
                    <Choice selected={config.addOns.includes('char_siew')} disabled={config.isKosong} onClick={() => toggleAddOn('char_siew')} className="flex items-center gap-2 px-3 py-2">
                      <PictoArt id="addon:char_siew" size={34} /><span className="font-semibold">加叉烧 +RM2</span>
                      {config.isKosong && <span className="text-xs text-ink-2">🔒 净面不可加</span>}
                    </Choice>
                  )}
                  <Choice selected={config.addOns.includes('wanton_3')} disabled={config.isKosong} onClick={() => toggleAddOn('wanton_3')} className="flex items-center gap-2 px-3 py-2">
                    <PictoArt id="addon:wanton_3" size={30} /><span className="font-semibold">加3粒 +RM2</span>
                    {config.isKosong && <span className="text-xs text-ink-2">🔒 净面不可加</span>}
                  </Choice>
                  {product.allowsKosong && (
                    <Choice selected={config.isKosong} onClick={() => set({ isKosong: !config.isKosong })} className="flex items-center gap-2 px-3 py-2">
                      <PictoArt id="kosong:on" size={30} />
                      <span className="text-left font-semibold leading-tight">净面 · 半价<br /><span className="text-xs font-normal text-ink-2">无叉烧、无云吞</span></span>
                    </Choice>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold">
            {config.isKosong ? '净面 · ' : ''}{config.productKind === 'dry_noodle' ? `${SAUCE_NAMES[config.sauce!].zh}面` : product.nameZh}
            {config.noodleType ? ` · ${NOODLE_TYPE_NAMES[config.noodleType].zh}` : ''} · {product.sizes.find((s) => s.id === config.size)?.badge}
          </div>
          <div className="truncate text-sm text-ink-2">{hasSpecial ? '含特殊要求' : '标准配料'}</div>
        </div>
        {editing && (
          <button type="button" onClick={onCancelEdit} className="h-14 rounded-xl border border-control px-4 font-semibold">取消修改</button>
        )}
        <button type="button" onClick={onSubmit} className="flex h-14 items-center gap-2 rounded-xl bg-brand px-5 text-lg font-bold text-white hover:bg-brand-pressed">
          <Icon name="bowl" size={24} />
          {editing ? '保存修改' : '＋ 加入本单'}
          <span className="ml-2 tabular-nums">{formatRM(price)}</span>
        </button>
      </div>
    </div>
  );
}

