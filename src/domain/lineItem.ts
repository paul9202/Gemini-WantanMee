/**
 * 单行餐品配置：默认值、规范化（UI 用）、严格校验（服务端用）、定价与份量。
 * 规范化与校验共用同一套规则：服务端拒绝任何「规范化后会改变」的输入，
 * 保证 POS、服务器、成本、厨单看到的是同一份有效配置。
 */
import {
  ADD_ON_IDS, AddOnId, LEVELS, Level, MenuVersion, NOODLE_TYPES, NoodleType, PRODUCT_KINDS,
  ProductKind, SAUCES, SAUCE_NAMES, SPICES, Sauce, SizeId, Spice, getSize,
} from './menu';
import type { Sen } from './money';

export const NOTE_MAX_LENGTH = 80;
export const MAX_LINE_QUANTITY = 50;

export interface LineConfig {
  productKind: ProductKind;
  size: SizeId;
  noodleType: NoodleType | null;
  sauce: Sauce | null;
  spice: Spice | null;
  lard: Level | null;
  scallion: Level;
  isKosong: boolean;
  addOns: AddOnId[];
  note: string;
}

export type ReasonCode =
  | 'UNKNOWN_FIELD' | 'INVALID_TYPE' | 'UNKNOWN_PRODUCT' | 'INVALID_SIZE' | 'INVALID_NOODLE_TYPE'
  | 'INVALID_SAUCE' | 'INVALID_MODIFIER' | 'KOSONG_NOT_ALLOWED' | 'KOSONG_MEAT_ADDON'
  | 'INVALID_ADDON' | 'DUPLICATE_ADDON' | 'NOTE_TOO_LONG' | 'INVALID_QUANTITY' | 'SOLD_OUT';

export interface ValidationIssue {
  code: ReasonCode;
  field: string;
}

export function defaultConfig(menu: MenuVersion, productKind: ProductKind, sauce: Sauce | null = null): LineConfig {
  const product = menu.products[productKind];
  return normalizeConfig(menu, {
    productKind,
    size: product.defaultSize,
    noodleType: product.hasNoodle ? 'thin_egg' : null,
    sauce: sauce ?? product.sauces[0] ?? null,
    spice: 'normal',
    lard: 'normal',
    scallion: 'normal',
    isKosong: false,
    addOns: [],
    note: '',
  });
}

/**
 * 把任意（可能残留旧字段的）配置收敛为有效配置。
 * - 汤品：sauce/spice/lard 为 null；无面餐品：noodleType 为 null。
 * - Kosong：仅允许的品类；开启时清除全部肉类加料（关闭不自动恢复）。
 */
export function normalizeConfig(menu: MenuVersion, cfg: LineConfig): LineConfig {
  const product = menu.products[cfg.productKind];
  const size = getSize(menu, cfg.productKind, cfg.size) ? cfg.size : product.defaultSize;
  const noodleType = product.hasNoodle ? (cfg.noodleType && NOODLE_TYPES.includes(cfg.noodleType) ? cfg.noodleType : 'thin_egg') : null;
  const sauce = product.sauces.length === 0 ? null : cfg.sauce && product.sauces.includes(cfg.sauce) ? cfg.sauce : product.sauces[0];
  const spice = product.allowsSpiceAndLard ? (cfg.spice && SPICES.includes(cfg.spice) ? cfg.spice : 'normal') : null;
  const lard = product.allowsSpiceAndLard ? (cfg.lard && LEVELS.includes(cfg.lard) ? cfg.lard : 'normal') : null;
  const scallion = LEVELS.includes(cfg.scallion) ? cfg.scallion : 'normal';
  const isKosong = product.allowsKosong && cfg.isKosong === true;
  const addOns = ADD_ON_IDS.filter(
    (id) => cfg.addOns.includes(id) && product.addOns.includes(id) && !(isKosong && menu.addOns[id].isMeat),
  );
  const note = cfg.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NOTE_MAX_LENGTH);
  return { productKind: cfg.productKind, size, noodleType, sauce, spice, lard, scallion, isKosong, addOns, note };
}

const CONFIG_KEYS: (keyof LineConfig)[] = [
  'productKind', 'size', 'noodleType', 'sauce', 'spice', 'lard', 'scallion', 'isKosong', 'addOns', 'note',
];

/** 严格解析不可信输入（服务端/补同步）。不做任何纠正，只报告问题。 */
export function parseLineConfig(menu: MenuVersion, raw: unknown): { ok: true; value: LineConfig } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [{ code: 'INVALID_TYPE', field: 'config' }] };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!CONFIG_KEYS.includes(key as keyof LineConfig)) issues.push({ code: 'UNKNOWN_FIELD', field: key });
  }
  if (typeof obj.productKind !== 'string' || !PRODUCT_KINDS.includes(obj.productKind as ProductKind)) {
    issues.push({ code: 'UNKNOWN_PRODUCT', field: 'productKind' });
    return { ok: false, issues };
  }
  const nullableString = (k: string) => obj[k] === null || typeof obj[k] === 'string';
  if (typeof obj.size !== 'string') issues.push({ code: 'INVALID_TYPE', field: 'size' });
  for (const k of ['noodleType', 'sauce', 'spice', 'lard']) if (!nullableString(k)) issues.push({ code: 'INVALID_TYPE', field: k });
  if (typeof obj.scallion !== 'string') issues.push({ code: 'INVALID_TYPE', field: 'scallion' });
  if (typeof obj.isKosong !== 'boolean') issues.push({ code: 'INVALID_TYPE', field: 'isKosong' });
  if (!Array.isArray(obj.addOns) || !obj.addOns.every((a) => typeof a === 'string')) issues.push({ code: 'INVALID_TYPE', field: 'addOns' });
  if (typeof obj.note !== 'string') issues.push({ code: 'INVALID_TYPE', field: 'note' });
  if (issues.length) return { ok: false, issues };

  const cfg = obj as unknown as LineConfig;
  const ruleIssues = validateConfig(menu, cfg);
  return ruleIssues.length ? { ok: false, issues: ruleIssues } : { ok: true, value: cfg };
}

/** 对已具备正确类型的配置做业务规则校验。 */
export function validateConfig(menu: MenuVersion, cfg: LineConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const product = menu.products[cfg.productKind];
  if (!product) return [{ code: 'UNKNOWN_PRODUCT', field: 'productKind' }];
  if (!getSize(menu, cfg.productKind, cfg.size)) issues.push({ code: 'INVALID_SIZE', field: 'size' });

  if (product.hasNoodle) {
    if (!cfg.noodleType || !NOODLE_TYPES.includes(cfg.noodleType)) issues.push({ code: 'INVALID_NOODLE_TYPE', field: 'noodleType' });
  } else if (cfg.noodleType !== null) issues.push({ code: 'INVALID_NOODLE_TYPE', field: 'noodleType' });

  if (product.sauces.length === 0) {
    if (cfg.sauce !== null) issues.push({ code: 'INVALID_SAUCE', field: 'sauce' });
  } else if (!cfg.sauce || !SAUCES.includes(cfg.sauce) || !product.sauces.includes(cfg.sauce)) {
    issues.push({ code: 'INVALID_SAUCE', field: 'sauce' });
  }

  if (product.allowsSpiceAndLard) {
    if (!cfg.spice || !SPICES.includes(cfg.spice)) issues.push({ code: 'INVALID_MODIFIER', field: 'spice' });
    if (!cfg.lard || !LEVELS.includes(cfg.lard)) issues.push({ code: 'INVALID_MODIFIER', field: 'lard' });
  } else {
    if (cfg.spice !== null) issues.push({ code: 'INVALID_MODIFIER', field: 'spice' });
    if (cfg.lard !== null) issues.push({ code: 'INVALID_MODIFIER', field: 'lard' });
  }
  if (!LEVELS.includes(cfg.scallion)) issues.push({ code: 'INVALID_MODIFIER', field: 'scallion' });

  if (cfg.isKosong && !product.allowsKosong) issues.push({ code: 'KOSONG_NOT_ALLOWED', field: 'isKosong' });

  const seen = new Set<string>();
  for (const id of cfg.addOns) {
    if (seen.has(id)) issues.push({ code: 'DUPLICATE_ADDON', field: 'addOns' });
    seen.add(id);
    if (!ADD_ON_IDS.includes(id) || !product.addOns.includes(id)) issues.push({ code: 'INVALID_ADDON', field: 'addOns' });
    else if (cfg.isKosong && menu.addOns[id].isMeat) issues.push({ code: 'KOSONG_MEAT_ADDON', field: 'addOns' });
  }
  if (cfg.note.length > NOTE_MAX_LENGTH) issues.push({ code: 'NOTE_TOO_LONG', field: 'note' });
  if (/[\u0000-\u001f\u007f]/.test(cfg.note) || cfg.note !== cfg.note.trim()) issues.push({ code: 'INVALID_TYPE', field: 'note' });
  if (menu.soldOut.includes(cfg.productKind)) issues.push({ code: 'SOLD_OUT', field: 'productKind' });
  return issues;
}

export function isValidQuantity(q: unknown): q is number {
  return typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= MAX_LINE_QUANTITY;
}

/** 单份售价（sen）。调用方需先保证配置有效。 */
export function unitPriceSen(menu: MenuVersion, cfg: LineConfig): Sen {
  const size = getSize(menu, cfg.productKind, cfg.size);
  if (!size) throw new RangeError(`未知规格 ${cfg.productKind}/${cfg.size}`);
  let price: Sen;
  if (cfg.isKosong) {
    if (size.kosongPriceSen === null) throw new RangeError('该规格不可 Kosong');
    price = size.kosongPriceSen;
  } else {
    price = size.priceSen;
  }
  for (const id of cfg.addOns) price += menu.addOns[id].priceSen;
  return price;
}

export interface LinePortions {
  noodleHalfUnits: number;
  wantonCount: number;
  charSiewPortions: number;
  baseWantonCount: number;
  baseCharSiewPortions: number;
  extraCharSiew: number;
  extraWantonPacks: number;
}

/** 单份的面球（半球单位）、云吞与叉烧数量。Kosong：云吞 0、叉烧 0，面球不变。 */
export function linePortions(menu: MenuVersion, cfg: LineConfig): LinePortions {
  const size = getSize(menu, cfg.productKind, cfg.size);
  if (!size) throw new RangeError(`未知规格 ${cfg.productKind}/${cfg.size}`);
  const baseWantonCount = cfg.isKosong ? 0 : size.wantonCount;
  const baseCharSiewPortions = cfg.isKosong ? 0 : size.charSiewPortions;
  const extraCharSiew = cfg.addOns.includes('char_siew') ? 1 : 0;
  const extraWantonPacks = cfg.addOns.includes('wanton_3') ? 1 : 0;
  return {
    noodleHalfUnits: size.noodleHalfUnits,
    baseWantonCount,
    baseCharSiewPortions,
    extraCharSiew,
    extraWantonPacks,
    wantonCount: baseWantonCount + extraWantonPacks * menu.addOns.wanton_3.wantonCount,
    charSiewPortions: baseCharSiewPortions + extraCharSiew * menu.addOns.char_siew.charSiewPortions,
  };
}

/** 合并键：完全相同的有效配置与备注才合并。 */
export function lineMergeKey(cfg: LineConfig): string {
  return JSON.stringify([
    cfg.productKind, cfg.size, cfg.noodleType, cfg.sauce, cfg.spice, cfg.lard, cfg.scallion, cfg.isKosong,
    [...cfg.addOns].sort(), cfg.note,
  ]);
}

/** 行项目照片：Kosong 必须换成熟净面图，不能继续用带肉图。 */
export function linePhotoId(cfg: LineConfig): string {
  if (cfg.isKosong) return 'dish.kosong_noodle';
  if (cfg.productKind === 'dry_noodle') return `dish.dry_noodle.${cfg.sauce ?? 'black'}`;
  return `dish.${cfg.productKind}`;
}

export function lineNameZh(menu: MenuVersion, cfg: LineConfig): string {
  const sauceName = cfg.sauce ? { black: '黑酱', white: '白酱', red: '红酱' }[cfg.sauce] : '';
  const size = getSize(menu, cfg.productKind, cfg.size);
  const base = cfg.productKind === 'dry_noodle' ? `${sauceName}面` : menu.products[cfg.productKind].nameZh;
  return `${cfg.isKosong ? '净面 · ' : ''}${base} · ${size?.nameZh ?? cfg.size}`;
}

export function lineNameEn(menu: MenuVersion, cfg: LineConfig): string {
  const size = getSize(menu, cfg.productKind, cfg.size);
  const base = cfg.productKind === 'dry_noodle' ? `${SAUCE_NAMES[cfg.sauce ?? 'black'].en} Sauce Noodles` : menu.products[cfg.productKind].nameEn;
  return `${cfg.isKosong ? 'Kosong · ' : ''}${base} · ${size?.nameEn ?? cfg.size}`;
}

export function lineName(menu: MenuVersion, cfg: LineConfig, lang: 'zh' | 'en'): string {
  return lang === 'en' ? lineNameEn(menu, cfg) : lineNameZh(menu, cfg);
}
