/**
 * 菜单与 BOM 发布：在已发布版本上修改价格、售罄、单位成本，生成新的不可变版本。
 * - 只改数值与售罄，不增删品类和规格（结构变化需要同时改规格与测试）。
 * - Kosong 严格半价：有 Kosong 的规格价格必须是偶数 sen，Kosong 价自动 = 一半。
 * - 历史版本保留，旧订单与离线单按成交时的版本校验，不随改价漂移。
 */
import type { BomVersion } from './bom';
import { ADD_ON_IDS, AddOnId, MenuVersion, NOODLE_TYPES, NoodleType, PRODUCT_KINDS, ProductKind, SizeId } from './menu';
import type { CostUnits, Sen } from './money';

export const MIN_PRICE_SEN = 50;
export const MAX_PRICE_SEN = 100_000;

export interface MenuChanges {
  prices: Partial<Record<ProductKind, Partial<Record<SizeId, Sen>>>>;
  addOnPrices: Partial<Record<AddOnId, Sen>>;
  soldOut: ProductKind[];
}

export type CatalogIssue = { field: string; message: string };

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_PRICE_SEN && v <= MAX_PRICE_SEN;

export function applyMenuChanges(base: MenuVersion, changes: MenuChanges, version: string): { ok: true; menu: MenuVersion } | { ok: false; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  // JSON 复制：断开代码常量里干捞面与汤面共用的规格数组，各品类独立修改（界面按餐牌统一售价同时提交两者）。
  const products: MenuVersion['products'] = JSON.parse(JSON.stringify(base.products));
  for (const [kind, sizes] of Object.entries(changes.prices ?? {})) {
    if (!PRODUCT_KINDS.includes(kind as ProductKind)) { issues.push({ field: `prices.${kind}`, message: '未知餐品' }); continue; }
    const p = products[kind as ProductKind];
    for (const [sizeId, price] of Object.entries(sizes ?? {})) {
      const size = p.sizes.find((s) => s.id === sizeId);
      if (!size) { issues.push({ field: `prices.${kind}.${sizeId}`, message: '未知规格' }); continue; }
      if (!isPrice(price)) { issues.push({ field: `prices.${kind}.${sizeId}`, message: `价格须为 ${MIN_PRICE_SEN}–${MAX_PRICE_SEN} sen 的整数` }); continue; }
      if (size.kosongPriceSen !== null && price % 2 !== 0) { issues.push({ field: `prices.${kind}.${sizeId}`, message: 'Kosong 严格半价：价格须为偶数 sen' }); continue; }
      size.priceSen = price;
      if (size.kosongPriceSen !== null) size.kosongPriceSen = price / 2;
    }
  }
  const addOns: MenuVersion['addOns'] = JSON.parse(JSON.stringify(base.addOns));
  for (const [id, price] of Object.entries(changes.addOnPrices ?? {})) {
    if (!ADD_ON_IDS.includes(id as AddOnId)) { issues.push({ field: `addOnPrices.${id}`, message: '未知加料' }); continue; }
    if (!isPrice(price)) { issues.push({ field: `addOnPrices.${id}`, message: `价格须为 ${MIN_PRICE_SEN}–${MAX_PRICE_SEN} sen 的整数` }); continue; }
    addOns[id as AddOnId].priceSen = price;
  }
  const soldOut = [...new Set(changes.soldOut ?? [])];
  for (const k of soldOut) if (!PRODUCT_KINDS.includes(k)) issues.push({ field: 'soldOut', message: `未知餐品 ${k}` });
  if (soldOut.length === PRODUCT_KINDS.length) issues.push({ field: 'soldOut', message: '不能把全部餐品设为售罄' });
  if (issues.length) return { ok: false, issues };
  return { ok: true, menu: { ...base, version, products, addOns, soldOut } };
}

export interface BomChanges {
  /** 每「整个」面球的成本单位（须为偶数，便于半球计算）。 */
  noodleBall?: Partial<Record<NoodleType, CostUnits>>;
  wanton?: CostUnits;
  charSiewPortion?: CostUnits;
  base?: Partial<Record<ProductKind, CostUnits>>;
  packagingPerPortion?: CostUnits;
  /** 已实店校准、可以去掉「待校准」标注的项目。 */
  calibrated?: string[];
}

const isCost = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

export function applyBomChanges(base: BomVersion, c: BomChanges, version: string): { ok: true; bom: BomVersion } | { ok: false; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  const bom: BomVersion = JSON.parse(JSON.stringify({ ...base, version }));
  for (const [t, v] of Object.entries(c.noodleBall ?? {})) {
    if (!NOODLE_TYPES.includes(t as NoodleType)) { issues.push({ field: `noodleBall.${t}`, message: '未知面种' }); continue; }
    if (!isCost(v) || v % 2 !== 0) { issues.push({ field: `noodleBall.${t}`, message: '面球成本须为偶数成本单位（0.1 sen）' }); continue; }
    bom.noodleHalfBall[t as NoodleType] = v / 2;
  }
  const scalar = (field: 'wanton' | 'charSiewPortion' | 'packagingPerPortion') => {
    const v = c[field];
    if (v === undefined) return;
    if (!isCost(v)) issues.push({ field, message: '成本须为非负整数成本单位' });
    else bom[field] = v;
  };
  scalar('wanton');
  scalar('charSiewPortion');
  scalar('packagingPerPortion');
  for (const [k, v] of Object.entries(c.base ?? {})) {
    if (!PRODUCT_KINDS.includes(k as ProductKind)) { issues.push({ field: `base.${k}`, message: '未知餐品' }); continue; }
    if (!isCost(v)) { issues.push({ field: `base.${k}`, message: '成本须为非负整数成本单位' }); continue; }
    bom.base[k as ProductKind] = v;
  }
  bom.pendingCalibration = base.pendingCalibration.filter((k) => !(c.calibrated ?? []).includes(k));
  if (issues.length) return { ok: false, issues };
  return { ok: true, bom };
}
