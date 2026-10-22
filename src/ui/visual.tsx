/**
 * 图片与图卡：Photo（餐品/原料照片，带稳定 SVG 回退）、Icon（设计稿符号）、Picto（06 §4 语义图卡）。
 * 图片失败时用 SVG + 中文代替，界面不能变空白。斜杠只表示「移除该食材」，不表示禁用。
 */
import { CSSProperties, ReactNode, useState } from 'react';
import { PICTOGRAMS, PictogramId } from '../domain/pictograms';
import { ICON_SYMBOLS, IconName } from './iconSymbols';
import manifest from './photoManifest.json';
import { useLang } from '../app/i18n';

const PHOTO_PATHS: Record<string, { path: string; alt: string }> = Object.fromEntries(
  manifest.photos.map((p) => [p.photoId, { path: p.path, alt: p.altZh }]),
);

export const PHOTO_CATALOG_VERSION = manifest.catalogVersion;

/** 应用根部渲染一次，提供 <use href="#id"> 引用的符号。 */
export function IconSprite() {
  return <svg aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: `<defs>${ICON_SYMBOLS}</defs>` }} />;
}

export function Icon({ name, size = 24, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      aria-hidden="true" width={size} height={size} className={className} style={style}
      fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
    >
      <use href={`#${name}`} />
    </svg>
  );
}

/** 斜杠覆盖层：表示移除该食材。 */
export function Strike({ children, size }: { children: ReactNode; size: number }) {
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      {children}
      <svg aria-hidden="true" viewBox="0 0 48 48" className="absolute inset-0" width={size} height={size}>
        <line x1="8" y1="40" x2="40" y2="8" stroke="#ffffff" strokeWidth="9" strokeLinecap="round" />
        <line x1="8" y1="40" x2="40" y2="8" stroke="#b42318" strokeWidth="5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const FALLBACK_ICON: Record<string, IconName> = {
  'dish.soup_noodle': 'soup',
  'dish.wanton_soup': 'soup',
  'dish.dry_wanton': 'dumpling',
  'noodle.thin_egg': 'noodle-nest',
  'noodle.mee_poh': 'noodle-nest',
  'ingredient.char_siew': 'bowl',
};

/**
 * 餐品/原料照片。Kosong 熟净面没有实拍资产（交接图谱缺），用净面图形 + 肉类划除，
 * 不继续使用带肉的照片。
 */
export function Photo({ id, size = 80, rounded = 12, className = '', fluid = false }: { id: string; size?: number; rounded?: number; className?: string; fluid?: boolean }) {
  const [failed, setFailed] = useState(false);
  const entry = PHOTO_PATHS[id];
  // fluid：最大 size，窄格子里按比例缩小，不撑破布局。
  const box: CSSProperties = fluid
    ? { width: '100%', maxWidth: size, height: 'auto', aspectRatio: '1 / 1', borderRadius: rounded }
    : { width: size, height: size, borderRadius: rounded };
  if (id === 'dish.kosong_noodle') {
    return (
      <span role="img" aria-label="净面（无叉烧无云吞）" className={`relative inline-flex shrink-0 items-center justify-center bg-[#fffaf1] ${className}`} style={box}>
        <Icon name="plain" size={size * 0.72} />
        <span className="absolute right-0 bottom-0 flex gap-0.5 rounded-md bg-white/90 p-0.5">
          <Strike size={size * 0.3}><Icon name="dumpling" size={size * 0.3} /></Strike>
        </span>
      </span>
    );
  }
  if (!entry || failed) {
    return (
      <span role="img" aria-label={entry?.alt ?? id} className={`inline-flex shrink-0 items-center justify-center bg-subtle text-ink-2 ${className}`} style={box}>
        <Icon name={FALLBACK_ICON[id] ?? 'bowl'} size={size * 0.6} />
      </span>
    );
  }
  return (
    <img
      src={entry.path} alt={entry.alt} width={size} height={size} draggable={false} onError={() => setFailed(true)}
      className={`shrink-0 object-cover bg-[#fffaf1] ${className}`} style={box}
    />
  );
}

function Repeat({ name, n, size }: { name: IconName; n: number; size: number }) {
  return (
    <span className="inline-flex -space-x-1">
      {Array.from({ length: n }, (_, i) => <Icon key={i} name={name} size={size} />)}
    </span>
  );
}

function Plus({ size }: { size: number }) {
  return <span className="font-black leading-none text-ok" style={{ fontSize: size * 0.7 }}>＋</span>;
}

/** 06 §4 语义图卡的图形部分（不含文字）。 */
export function PictoArt({ id, size = 32 }: { id: PictogramId; size?: number }) {
  switch (id) {
    case 'spice:none': return <Strike size={size}><Icon name="pepper" size={size} /></Strike>;
    case 'spice:less': return <Repeat name="pepper" n={1} size={size} />;
    case 'spice:normal': return <Repeat name="pepper" n={2} size={size} />;
    case 'spice:extra': return <Repeat name="pepper" n={3} size={size} />;
    case 'scallion:normal': return <Icon name="scallion" size={size} />;
    case 'scallion:extra': return <span className="inline-flex items-center"><Icon name="scallion" size={size} /><Plus size={size} /></span>;
    case 'scallion:none': return <Strike size={size}><Icon name="scallion" size={size} /></Strike>;
    case 'lard:normal': return <Icon name="lard" size={size} />;
    case 'lard:extra': return <span className="inline-flex items-center"><Icon name="lard" size={size} /><Plus size={size} /></span>;
    case 'lard:none': return <Strike size={size}><Icon name="lard" size={size} /></Strike>;
    case 'addon:char_siew': return <span className="inline-flex items-center"><Plus size={size} /><Photo id="ingredient.char_siew" size={size} rounded={6} /></span>;
    case 'addon:wanton_3': return <span className="inline-flex items-center"><Plus size={size} /><Repeat name="dumpling" n={3} size={size * 0.8} /></span>;
    case 'kosong:on': return (
      <span className="inline-flex items-center gap-0.5">
        <Icon name="plain" size={size} />
        <Strike size={size * 0.8}><Photo id="ingredient.char_siew" size={size * 0.8} rounded={4} /></Strike>
        <Strike size={size * 0.8}><Icon name="dumpling" size={size * 0.8} /></Strike>
      </span>
    );
    case 'service:dine_in': return <Icon name="table" size={size} />;
    case 'service:takeaway': return <Icon name="bag" size={size} />;
    case 'noodle:thin_egg': return <Photo id="noodle.thin_egg" size={size} rounded={6} />;
    case 'noodle:mee_poh': return <Photo id="noodle.mee_poh" size={size} rounded={6} />;
    case 'soup:base': return <Icon name="soup" size={size} />;
    case 'takeaway:no_side_soup': return <Strike size={size}><Icon name="soup" size={size} /></Strike>;
    case 'action:start': return <Icon name="cook" size={size} />;
    case 'action:serve': return <Icon name="serve" size={size} />;
    case 'action:undo': return <span style={{ fontSize: size * 0.8 }}>↶</span>;
    case 'token:return': return <Icon name="handoff" size={size} />;
  }
}

/** 图卡 = 图形 + 短中文。tone 用于 KDS 深色主题。 */
export function Picto({ id, size = 28, tone = 'light', emphasized = true }: { id: PictogramId; size?: number; tone?: 'light' | 'dark'; emphasized?: boolean }) {
  const def = PICTOGRAMS[id];
  const lang = useLang();
  const base = tone === 'dark'
    ? emphasized ? 'bg-[#2d3d34] text-kds-text border-[#4b5f52]' : 'bg-transparent text-kds-muted border-[#33443a]'
    : emphasized ? 'bg-white text-ink border-line' : 'bg-subtle text-ink-2 border-transparent';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 font-semibold ${base}`} style={{ fontSize: Math.max(13, size * 0.55) }}>
      <PictoArt id={id} size={size} />
      <span>{lang === 'en' ? def.en : def.zh}</span>
    </span>
  );
}
