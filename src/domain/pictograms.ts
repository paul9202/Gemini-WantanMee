/**
 * 图卡语义表（06 §4）。POS、购物车、KDS、培训卡共用同一语义 ID，
 * UI 只负责把 ID 渲染成同一张图，不允许各页面自行解释含义。
 */
import type { LineConfig } from './lineItem';
import type { MenuVersion, ServiceMode } from './menu';

export type PictogramId =
  | 'spice:none' | 'spice:less' | 'spice:normal' | 'spice:extra'
  | 'scallion:normal' | 'scallion:extra' | 'scallion:none'
  | 'lard:normal' | 'lard:extra' | 'lard:none'
  | 'addon:char_siew' | 'addon:wanton_3' | 'kosong:on'
  | 'service:dine_in' | 'service:takeaway'
  | 'noodle:thin_egg' | 'noodle:mee_poh'
  | 'soup:base' | 'takeaway:no_side_soup'
  | 'action:start' | 'action:serve' | 'action:undo' | 'token:return';

export interface PictogramDef {
  id: PictogramId;
  zh: string;
  en: string;
  /** 是否为「移除」语义：统一用斜杠表示，不与禁用状态混用。 */
  strike: boolean;
}

export const PICTOGRAMS: Record<PictogramId, PictogramDef> = {
  'spice:none': { id: 'spice:none', zh: '不辣', en: 'No chili', strike: true },
  'spice:less': { id: 'spice:less', zh: '少辣', en: 'Less spicy', strike: false },
  'spice:normal': { id: 'spice:normal', zh: '辣', en: 'Spicy', strike: false },
  'spice:extra': { id: 'spice:extra', zh: '加辣', en: 'Extra spicy', strike: false },
  'scallion:normal': { id: 'scallion:normal', zh: '正常葱', en: 'Scallion', strike: false },
  'scallion:extra': { id: 'scallion:extra', zh: '多葱', en: 'Extra scallion', strike: false },
  'scallion:none': { id: 'scallion:none', zh: '走青', en: 'No scallion', strike: true },
  'lard:normal': { id: 'lard:normal', zh: '正常油渣', en: 'Lard crisps', strike: false },
  'lard:extra': { id: 'lard:extra', zh: '多油渣', en: 'Extra lard crisps', strike: false },
  'lard:none': { id: 'lard:none', zh: '无油渣', en: 'No lard crisps', strike: true },
  'addon:char_siew': { id: 'addon:char_siew', zh: '加叉烧', en: '+Char siew', strike: false },
  'addon:wanton_3': { id: 'addon:wanton_3', zh: '加3粒', en: '+3 wantan', strike: false },
  'kosong:on': { id: 'kosong:on', zh: '净面', en: 'Kosong', strike: true },
  'service:dine_in': { id: 'service:dine_in', zh: '堂食', en: 'Dine in', strike: false },
  'service:takeaway': { id: 'service:takeaway', zh: '打包', en: 'Takeaway', strike: false },
  'noodle:thin_egg': { id: 'noodle:thin_egg', zh: '细面', en: 'Thin', strike: false },
  'noodle:mee_poh': { id: 'noodle:mee_poh', zh: '面薄', en: 'Mee Poh', strike: false },
  'soup:base': { id: 'soup:base', zh: '原汁汤底', en: 'Soup', strike: false },
  'takeaway:no_side_soup': { id: 'takeaway:no_side_soup', zh: '不附送清汤', en: 'No side soup', strike: true },
  'action:start': { id: 'action:start', zh: '开始制作', en: 'Start', strike: false },
  'action:serve': { id: 'action:serve', zh: '完成出餐', en: 'Served', strike: false },
  'action:undo': { id: 'action:undo', zh: '撤回', en: 'Undo', strike: false },
  'token:return': { id: 'token:return', zh: '餐牌回收', en: 'Token returned', strike: false },
};

export interface LinePictogram {
  id: PictogramId;
  /** 偏离默认的要求才在 KDS 强调；默认项保留但弱化，不完全丢失。 */
  emphasized: boolean;
}

/** 某行在 POS/KDS/收据上显示的图卡序列（顺序固定）。 */
export function linePictograms(menu: MenuVersion, cfg: LineConfig, serviceMode: ServiceMode): LinePictogram[] {
  const product = menu.products[cfg.productKind];
  const out: LinePictogram[] = [];
  if (cfg.noodleType) out.push({ id: `noodle:${cfg.noodleType}`, emphasized: cfg.noodleType !== 'thin_egg' });
  if (cfg.isKosong) out.push({ id: 'kosong:on', emphasized: true });
  if (product.isSoup) out.push({ id: 'soup:base', emphasized: false });
  if (cfg.spice) out.push({ id: `spice:${cfg.spice}`, emphasized: cfg.spice !== 'normal' });
  out.push({ id: `scallion:${cfg.scallion}`, emphasized: cfg.scallion !== 'normal' });
  if (cfg.lard) out.push({ id: `lard:${cfg.lard}`, emphasized: cfg.lard !== 'normal' });
  for (const a of cfg.addOns) out.push({ id: `addon:${a}`, emphasized: true });
  if (serviceMode === 'takeaway' && !product.isSoup) out.push({ id: 'takeaway:no_side_soup', emphasized: true });
  return out;
}
