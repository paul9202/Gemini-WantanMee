/**
 * 菜单版本（依据用户 2026-10-22 提供的餐牌）。
 * 四个稳定 productKind；POS 的 6 张图片入口只是入口，不新增业务品类。
 * 菜单版本不可变：改价发布新版本，历史订单按原版本校验。
 */
import type { Sen } from './money';

export type ProductKind = 'dry_noodle' | 'soup_noodle' | 'dry_wanton' | 'wanton_soup';
export type NoodleSize = 'small' | 'medium' | 'large';
export type WantonSize = 'w10' | 'w15';
export type SizeId = NoodleSize | WantonSize;
export type NoodleType = 'thin_egg' | 'mee_poh';
export type Sauce = 'black' | 'white' | 'red';
export type Spice = 'none' | 'less' | 'normal' | 'extra';
export type Level = 'normal' | 'extra' | 'none';
export type ServiceMode = 'dine_in' | 'takeaway';
export type AddOnId = 'char_siew' | 'wanton_3';

export const PRODUCT_KINDS: readonly ProductKind[] = ['dry_noodle', 'soup_noodle', 'dry_wanton', 'wanton_soup'];
export const NOODLE_TYPES: readonly NoodleType[] = ['thin_egg', 'mee_poh'];
export const SAUCES: readonly Sauce[] = ['black', 'white', 'red'];
export const SPICES: readonly Spice[] = ['none', 'less', 'normal', 'extra'];
export const LEVELS: readonly Level[] = ['normal', 'extra', 'none'];
export const SERVICE_MODES: readonly ServiceMode[] = ['dine_in', 'takeaway'];
export const ADD_ON_IDS: readonly AddOnId[] = ['char_siew', 'wanton_3'];

export interface SizeDef {
  id: SizeId;
  nameZh: string;
  nameEn: string;
  /** 份量图卡显示，例如 "1"、"1½"、"10"。 */
  badge: string;
  priceSen: Sen;
  /** Kosong 价；不允许 Kosong 的规格为 null。 */
  kosongPriceSen: Sen | null;
  /** 1 面球 = 2 半球单位。 */
  noodleHalfUnits: number;
  wantonCount: number;
  charSiewPortions: number;
}

export interface ProductDef {
  kind: ProductKind;
  nameZh: string;
  nameEn: string;
  sizes: SizeDef[];
  defaultSize: SizeId;
  /** 空数组表示不显示酱料（汤品）。 */
  sauces: Sauce[];
  hasNoodle: boolean;
  /** 辣度与油渣仅干捞类有效。 */
  allowsSpiceAndLard: boolean;
  addOns: AddOnId[];
  allowsKosong: boolean;
  /** 打包时是否附送清汤（干捞类为否：汤品本体始终保留）。 */
  isSoup: boolean;
}

export interface AddOnDef {
  id: AddOnId;
  nameZh: string;
  nameEn: string;
  priceSen: Sen;
  wantonCount: number;
  charSiewPortions: number;
  isMeat: true;
}

export interface MenuVersion {
  version: string;
  currency: 'MYR';
  products: Record<ProductKind, ProductDef>;
  addOns: Record<AddOnId, AddOnDef>;
  /** 老板配置的售罄；离线时为缓存值。 */
  soldOut: ProductKind[];
}

const NOODLE_SIZES: SizeDef[] = [
  { id: 'small', nameZh: '小', nameEn: 'Small', badge: '1', priceSen: 700, kosongPriceSen: 350, noodleHalfUnits: 2, wantonCount: 3, charSiewPortions: 1 },
  { id: 'medium', nameZh: '中', nameEn: 'Medium', badge: '1½', priceSen: 900, kosongPriceSen: 450, noodleHalfUnits: 3, wantonCount: 3, charSiewPortions: 1 },
  { id: 'large', nameZh: '大', nameEn: 'Large', badge: '2', priceSen: 1100, kosongPriceSen: 550, noodleHalfUnits: 4, wantonCount: 4, charSiewPortions: 1 },
];

const WANTON_SIZES: SizeDef[] = [
  { id: 'w10', nameZh: '10粒', nameEn: '10 pcs', badge: '10', priceSen: 700, kosongPriceSen: null, noodleHalfUnits: 0, wantonCount: 10, charSiewPortions: 0 },
  { id: 'w15', nameZh: '15粒', nameEn: '15 pcs', badge: '15', priceSen: 1000, kosongPriceSen: null, noodleHalfUnits: 0, wantonCount: 15, charSiewPortions: 0 },
];

export const MENU_V1: MenuVersion = {
  version: 'menu-2026-10-v1',
  currency: 'MYR',
  products: {
    dry_noodle: {
      kind: 'dry_noodle', nameZh: '干捞面', nameEn: 'Dry Wantan Mee',
      sizes: NOODLE_SIZES, defaultSize: 'small', sauces: ['black', 'white', 'red'],
      hasNoodle: true, allowsSpiceAndLard: true, addOns: ['char_siew', 'wanton_3'], allowsKosong: true, isSoup: false,
    },
    soup_noodle: {
      kind: 'soup_noodle', nameZh: '云吞汤面', nameEn: 'Wantan Noodle Soup',
      sizes: NOODLE_SIZES, defaultSize: 'small', sauces: [],
      hasNoodle: true, allowsSpiceAndLard: false, addOns: ['char_siew', 'wanton_3'], allowsKosong: true, isSoup: true,
    },
    dry_wanton: {
      // 餐牌：干捞云吞「可选红 / 黑酱」，不提供白酱。
      kind: 'dry_wanton', nameZh: '干捞云吞', nameEn: 'Dry Wantan',
      sizes: WANTON_SIZES, defaultSize: 'w10', sauces: ['black', 'red'],
      hasNoodle: false, allowsSpiceAndLard: true, addOns: ['wanton_3'], allowsKosong: false, isSoup: false,
    },
    wanton_soup: {
      kind: 'wanton_soup', nameZh: '云吞汤', nameEn: 'Wantan Soup',
      sizes: WANTON_SIZES, defaultSize: 'w10', sauces: [],
      hasNoodle: false, allowsSpiceAndLard: false, addOns: ['wanton_3'], allowsKosong: false, isSoup: true,
    },
  },
  addOns: {
    char_siew: { id: 'char_siew', nameZh: '加叉烧', nameEn: 'Extra Char Siew', priceSen: 200, wantonCount: 0, charSiewPortions: 1, isMeat: true },
    wanton_3: { id: 'wanton_3', nameZh: '加云吞3粒', nameEn: 'Extra 3 Wantan', priceSen: 200, wantonCount: 3, charSiewPortions: 0, isMeat: true },
  },
  soldOut: [],
};

/** 已发布、可用于校验历史订单的菜单版本。 */
export const MENU_VERSIONS: Record<string, MenuVersion> = { [MENU_V1.version]: MENU_V1 };

export function getSize(menu: MenuVersion, kind: ProductKind, size: SizeId): SizeDef | undefined {
  return menu.products[kind].sizes.find((s) => s.id === size);
}

/** POS 6 张图片入口 → 4 个 productKind（前三张是干捞面的酱料快捷入口）。 */
export interface EntryTile {
  id: 'red_noodle' | 'black_noodle' | 'white_noodle' | 'soup_noodle' | 'wanton_soup' | 'dry_wanton';
  productKind: ProductKind;
  sauce: Sauce | null;
  nameZh: string;
  nameEn: string;
  photoId: string;
}

export const ENTRY_TILES: readonly EntryTile[] = [
  { id: 'red_noodle', productKind: 'dry_noodle', sauce: 'red', nameZh: '红酱面', nameEn: 'Red Sauce', photoId: 'dish.dry_noodle.red' },
  { id: 'black_noodle', productKind: 'dry_noodle', sauce: 'black', nameZh: '黑酱面', nameEn: 'Black Sauce', photoId: 'dish.dry_noodle.black' },
  { id: 'white_noodle', productKind: 'dry_noodle', sauce: 'white', nameZh: '白酱面', nameEn: 'White Sauce', photoId: 'dish.dry_noodle.white' },
  { id: 'soup_noodle', productKind: 'soup_noodle', sauce: null, nameZh: '云吞汤面', nameEn: 'Noodle Soup', photoId: 'dish.soup_noodle' },
  { id: 'wanton_soup', productKind: 'wanton_soup', sauce: null, nameZh: '云吞汤', nameEn: 'Wantan Soup', photoId: 'dish.wanton_soup' },
  { id: 'dry_wanton', productKind: 'dry_wanton', sauce: 'black', nameZh: '干捞云吞', nameEn: 'Dry Wantan', photoId: 'dish.dry_wanton' },
];

export const SAUCE_NAMES: Record<Sauce, { zh: string; en: string }> = {
  black: { zh: '黑酱', en: 'Black' },
  white: { zh: '白酱', en: 'White' },
  red: { zh: '红酱', en: 'Red' },
};

export const NOODLE_TYPE_NAMES: Record<NoodleType, { zh: string; en: string; photoId: string }> = {
  thin_egg: { zh: '细面', en: 'Thin noodles', photoId: 'noodle.thin_egg' },
  mee_poh: { zh: '面薄', en: 'Mee Poh', photoId: 'noodle.mee_poh' },
};
