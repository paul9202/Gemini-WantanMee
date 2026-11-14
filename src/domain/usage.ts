/**
 * 每天用了多少料（2026-11-14 经营模块改版）：全部由订单算出，不要老板另外录入。
 *
 * 口径：
 * - 只算有效订单（未取消）。与「经营目标」的面团粒数同一口径：下了单就会煮。
 * - 面团粒数用订单行写入时的 noodleHalfUnits（半粒为整数单位，小 1 粒、中 1½、大 2）；云吞粒数用 wantonCount。
 *   旧订单行缺这两个字段时，按菜单结构（linePortions）补算。叉烧份数订单行没有存，按菜单结构算（净面、不要叉烧不放）。
 *   已发布的菜单版本只改价钱和售罄、不改份量，所以份量结构固定用 MENU_V1。
 * - 下单后加料（productKind = extra）不是一碗：不算碗数、面团、底料和打包，只算它带的云吞 / 叉烧。
 * - 材料成本按「用量 × 当前单位成本（BOM）」算，是给老板看的估算；日结 / 利润仍以下单时写入的成本记录为准。
 */
import { BomVersion, unitCostUnits } from './bom';
import { defaultConfig, hasNoCharSiew, LineConfig, linePortions, normalizeConfig } from './lineItem';
import { ENTRY_TILES, MENU_V1, MenuVersion, NOODLE_TYPES, NoodleSize, NoodleType, PRODUCT_KINDS, ProductKind, Sauce, SizeId } from './menu';
import type { CostUnits, Sen } from './money';

export interface UsageItem {
  productKind: string;
  size?: string;
  sauce: string | null;
  noodleType: string | null;
  isKosong: boolean;
  addOns?: string[];
  note?: string | null;
  quantity: number;
  serviceMode?: string;
  /** 单份的半粒数 / 云吞粒数（下单时写入）。 */
  noodleHalfUnits?: number;
  wantonCount?: number;
  lineTotalSen?: number;
}

export interface UsageOrder {
  fulfillmentStatus: string;
  serviceMode?: string;
  items: UsageItem[];
}

const NOODLE_SIZES: NoodleSize[] = ['small', 'medium', 'large'];
type Cell = { bowls: number; half: number };
const emptyGrid = (): Record<NoodleType, Record<NoodleSize, Cell>> =>
  Object.fromEntries(NOODLE_TYPES.map((t) => [t, Object.fromEntries(NOODLE_SIZES.map((s) => [s, { bowls: 0, half: 0 }]))])) as Record<NoodleType, Record<NoodleSize, Cell>>;

export interface DishUsage { key: string; label: string; photoId: string; bowls: number; sen: Sen }

export interface MaterialUsage {
  orders: number;
  /** 碗数（不含下单后加料）。 */
  bowls: number;
  /** 面团：面种 × 大小，每格碗数与半粒数。 */
  noodle: Record<NoodleType, Record<NoodleSize, Cell>>;
  noodleHalfByType: Record<NoodleType, number>;
  noodleHalf: number;
  noodleBowls: number;
  wanton: { total: number; fromNoodle: number; noodleBowls: number; fromWanton10: number; wanton10Bowls: number; fromWanton15: number; wanton15Bowls: number; extraPacks: number; extraCount: number };
  charSiew: { total: number; fromNoodle: number; noodleBowls: number; extra: number };
  kosongBowls: number;
  noCharSiewBowls: number;
  /** 每种餐品的碗数（底料按餐品算）。 */
  byKind: Record<ProductKind, number>;
  takeawayBowls: number;
  bySauce: Record<Sauce, number>;
  /** 按 6 张餐品入口（干捞面按酱料分开）。 */
  byDish: DishUsage[];
}

function portionsOf(it: UsageItem): { half: number; wanton: number; baseWanton: number; extraPacks: number; charSiew: number; baseCharSiew: number; extraCharSiew: number } {
  const addOns = (it.addOns ?? []).filter((a) => a === 'char_siew' || a === 'wanton_3') as LineConfig['addOns'];
  let p: ReturnType<typeof linePortions> | null = null;
  try {
    p = linePortions(MENU_V1, { productKind: it.productKind as LineConfig['productKind'], size: (it.size ?? 'one') as SizeId, isKosong: it.isKosong, addOns, note: it.note ?? '' } as LineConfig);
  } catch {
    p = null;
  }
  const extraPacks = addOns.includes('wanton_3') ? 1 : 0;
  const extraCharSiew = addOns.includes('char_siew') ? 1 : 0;
  const wanton = it.wantonCount ?? p?.wantonCount ?? extraPacks * MENU_V1.addOns.wanton_3.wantonCount;
  const baseCharSiew = p?.baseCharSiewPortions ?? 0;
  return {
    half: it.noodleHalfUnits ?? p?.noodleHalfUnits ?? 0,
    wanton,
    baseWanton: Math.max(0, wanton - extraPacks * MENU_V1.addOns.wanton_3.wantonCount),
    extraPacks,
    baseCharSiew,
    extraCharSiew,
    charSiew: baseCharSiew + extraCharSiew * MENU_V1.addOns.char_siew.charSiewPortions,
  };
}

const isNoodleType = (t: string | null): t is NoodleType => (NOODLE_TYPES as readonly string[]).includes(t ?? '');
const isNoodleSize = (s: string | undefined): s is NoodleSize => (NOODLE_SIZES as string[]).includes(s ?? '');
const isKind = (k: string): k is ProductKind => (PRODUCT_KINDS as readonly string[]).includes(k);

export function materialUsage(orders: UsageOrder[]): MaterialUsage {
  const u: MaterialUsage = {
    orders: 0, bowls: 0, noodle: emptyGrid(), noodleHalfByType: { thin_egg: 0, mee_poh: 0 }, noodleHalf: 0, noodleBowls: 0,
    wanton: { total: 0, fromNoodle: 0, noodleBowls: 0, fromWanton10: 0, wanton10Bowls: 0, fromWanton15: 0, wanton15Bowls: 0, extraPacks: 0, extraCount: 0 },
    charSiew: { total: 0, fromNoodle: 0, noodleBowls: 0, extra: 0 },
    kosongBowls: 0, noCharSiewBowls: 0, byKind: { dry_noodle: 0, soup_noodle: 0, dry_wanton: 0, wanton_soup: 0 }, takeawayBowls: 0,
    bySauce: { black: 0, white: 0, red: 0 }, byDish: [],
  };
  const dish = new Map<string, DishUsage>();
  for (const o of orders) {
    if (o.fulfillmentStatus === 'cancelled') continue;
    u.orders++;
    for (const it of o.items ?? []) {
      const q = it.quantity;
      const p = portionsOf(it);
      const extraPacksCount = p.extraPacks * q;
      u.wanton.total += p.wanton * q;
      u.wanton.extraPacks += extraPacksCount;
      u.wanton.extraCount += extraPacksCount * MENU_V1.addOns.wanton_3.wantonCount;
      u.charSiew.total += p.charSiew * q;
      u.charSiew.extra += p.extraCharSiew * q;
      if (!isKind(it.productKind)) continue; // 下单后加料：只算它带的云吞 / 叉烧
      u.bowls += q;
      u.byKind[it.productKind] += q;
      if ((it.serviceMode ?? o.serviceMode) === 'takeaway') u.takeawayBowls += q;
      if (it.isKosong) u.kosongBowls += q;
      if (hasNoCharSiew({ note: it.note ?? '' })) u.noCharSiewBowls += q;
      if (it.sauce === 'black' || it.sauce === 'white' || it.sauce === 'red') u.bySauce[it.sauce] += q;
      if (p.half > 0) {
        u.noodleHalf += p.half * q;
        u.noodleBowls += q;
        if (isNoodleType(it.noodleType)) {
          u.noodleHalfByType[it.noodleType] += p.half * q;
          if (isNoodleSize(it.size)) { u.noodle[it.noodleType][it.size].bowls += q; u.noodle[it.noodleType][it.size].half += p.half * q; }
        }
      }
      if (it.productKind === 'dry_noodle' || it.productKind === 'soup_noodle') {
        u.wanton.fromNoodle += p.baseWanton * q;
        if (p.baseWanton > 0) u.wanton.noodleBowls += q;
        u.charSiew.fromNoodle += p.baseCharSiew * q;
        if (p.baseCharSiew > 0) u.charSiew.noodleBowls += q;
      } else if (it.size === 'w15') { u.wanton.fromWanton15 += p.baseWanton * q; u.wanton.wanton15Bowls += q; }
      else { u.wanton.fromWanton10 += p.baseWanton * q; u.wanton.wanton10Bowls += q; }
      const tile = ENTRY_TILES.find((t) => t.productKind === it.productKind && (t.productKind !== 'dry_noodle' || t.sauce === it.sauce));
      if (tile) {
        const d = dish.get(tile.id) ?? { key: tile.id, label: tile.nameZh, photoId: tile.photoId, bowls: 0, sen: 0 };
        d.bowls += q;
        d.sen += it.lineTotalSen ?? 0;
        dish.set(tile.id, d);
      }
    }
  }
  u.byDish = [...dish.values()].sort((a, b) => b.bowls - a.bowls || b.sen - a.sen || a.key.localeCompare(b.key));
  return u;
}

export type MaterialKey = 'thin_egg' | 'mee_poh' | 'wanton' | 'char_siew' | 'dry_base' | 'soup_base' | 'packaging';

export interface MaterialCostLine {
  key: MaterialKey;
  label: string;
  /** 用量（面团为半粒数）与单位。 */
  qty: number;
  unit: '粒' | '份' | '碗' | '套';
  /** 每单位成本（面团为每整粒）。 */
  unitCostUnits: CostUnits;
  costUnits: CostUnits;
}

/**
 * 用量 × 当前单位成本。干捞底料（酱、葱、油渣）按干捞面 + 干捞云吞的碗数，汤底按汤面 + 云吞汤；
 * 每种餐品可能有不同底料成本，所以用每种的碗数分别乘，单价显示加权平均。
 */
export function materialCost(u: MaterialUsage, bom: BomVersion): { lines: MaterialCostLine[]; totalUnits: CostUnits } {
  const dryBowls = u.byKind.dry_noodle + u.byKind.dry_wanton;
  const soupBowls = u.byKind.soup_noodle + u.byKind.wanton_soup;
  const dryCost = u.byKind.dry_noodle * bom.base.dry_noodle + u.byKind.dry_wanton * bom.base.dry_wanton;
  const soupCost = u.byKind.soup_noodle * bom.base.soup_noodle + u.byKind.wanton_soup * bom.base.wanton_soup;
  const avg = (cost: number, n: number, fallback: number) => (n ? Math.round(cost / n) : fallback);
  const lines: MaterialCostLine[] = [
    { key: 'thin_egg', label: '细面面团', qty: u.noodleHalfByType.thin_egg, unit: '粒', unitCostUnits: bom.noodleHalfBall.thin_egg * 2, costUnits: u.noodleHalfByType.thin_egg * bom.noodleHalfBall.thin_egg },
    { key: 'mee_poh', label: '面薄面团', qty: u.noodleHalfByType.mee_poh, unit: '粒', unitCostUnits: bom.noodleHalfBall.mee_poh * 2, costUnits: u.noodleHalfByType.mee_poh * bom.noodleHalfBall.mee_poh },
    { key: 'wanton', label: '云吞', qty: u.wanton.total, unit: '粒', unitCostUnits: bom.wanton, costUnits: u.wanton.total * bom.wanton },
    { key: 'char_siew', label: '叉烧', qty: u.charSiew.total, unit: '份', unitCostUnits: bom.charSiewPortion, costUnits: u.charSiew.total * bom.charSiewPortion },
    { key: 'dry_base', label: '干捞酱料 + 葱 + 油渣', qty: dryBowls, unit: '碗', unitCostUnits: avg(dryCost, dryBowls, bom.base.dry_noodle), costUnits: dryCost },
    { key: 'soup_base', label: '汤底', qty: soupBowls, unit: '碗', unitCostUnits: avg(soupCost, soupBowls, bom.base.wanton_soup), costUnits: soupCost },
    { key: 'packaging', label: '打包盒 + 袋', qty: u.takeawayBowls, unit: '套', unitCostUnits: bom.packagingPerPortion, costUnits: u.takeawayBowls * bom.packagingPerPortion },
  ];
  return { lines, totalUnits: lines.reduce((s, l) => s + l.costUnits, 0) };
}

export interface BowlMarginRow {
  group: 'dry_noodle' | 'soup_noodle' | 'wanton' | 'kosong' | 'add_on';
  label: string;
  priceSen: Sen;
  costUnits: CostUnits;
}

/** 每碗赚多少：当前菜单价 − 当前单位成本（不含打包盒；打包另计）。 */
export function bowlMargins(menu: MenuVersion, bom: BomVersion): BowlMarginRow[] {
  const rows: BowlMarginRow[] = [];
  const cfg = (kind: ProductKind, size: SizeId, kosong = false): LineConfig => normalizeConfig(menu, { ...defaultConfig(menu, kind), size, isKosong: kosong });
  for (const kind of ['dry_noodle', 'soup_noodle'] as const) {
    for (const s of menu.products[kind].sizes) rows.push({ group: kind, label: s.nameZh, priceSen: s.priceSen, costUnits: unitCostUnits(menu, bom, cfg(kind, s.id)) });
  }
  for (const kind of ['wanton_soup', 'dry_wanton'] as const) {
    for (const s of menu.products[kind].sizes) rows.push({ group: 'wanton', label: `${menu.products[kind].nameZh} ${s.nameZh}`, priceSen: s.priceSen, costUnits: unitCostUnits(menu, bom, cfg(kind, s.id)) });
  }
  for (const s of menu.products.dry_noodle.sizes) {
    if (s.kosongPriceSen !== null) rows.push({ group: 'kosong', label: `净面 ${s.nameZh}`, priceSen: s.kosongPriceSen, costUnits: unitCostUnits(menu, bom, cfg('dry_noodle', s.id, true)) });
  }
  for (const a of Object.values(menu.addOns)) rows.push({ group: 'add_on', label: a.nameZh, priceSen: a.priceSen, costUnits: a.wantonCount * bom.wanton + a.charSiewPortions * bom.charSiewPortion });
  return rows;
}
