/**
 * 成本来源与材料剩余（2026-11-14 经营改版第二阶段）。前端、Functions 与测试共用。
 *
 * 单价：
 * - 真正用来算成本的仍是 BOM（单位成本表）。这里只记「每个单价是从哪来的」（收据 / AI 估 / 老板改 / 旧设定），
 *   以及还没确认的建议。建议要老板按「对」才会发布成新的 BOM 版本（只影响之后的新订单），AI 不会自己改账。
 * - 收据价从进货批次（拍进货单或手动记进货都会产生）推算：面团按「粒」，叉烧按 kg × 每份克数，云吞按肉碎 kg ÷ 每公斤粒数 + 云吞皮。
 *
 * 剩余：
 * - 剩余 = 起点数量 + 之后进货 − 之后卖掉的用量（用量由订单算，见 usage.ts）。起点优先用老板收档时点过的数；
 *   没点过就从近 30 天第一次进货算起（之前剩的不知道，所以页面要写明）。
 * - 「明天要」= 前几个同一天（星期几）的平均用量；不够三周资料就用近 7 天营业日的平均。
 * - 单位对不上（例如面团按 kg 记）就不估，提示老板。
 */
import type { BomChanges } from './catalog';
import type { BomVersion } from './bom';
import { addDays } from './businessDay';
import type { CostUnits, Sen } from './money';
import type { MaterialKey, MaterialUsage } from './usage';

export const MATERIAL_KEYS: MaterialKey[] = ['thin_egg', 'mee_poh', 'wanton', 'char_siew', 'dry_base', 'soup_base', 'packaging'];
export const MATERIAL_ZH: Record<MaterialKey, { name: string; unit: string }> = {
  thin_egg: { name: '细面面团', unit: '粒' }, mee_poh: { name: '面薄面团', unit: '粒' }, wanton: { name: '云吞', unit: '粒' }, char_siew: { name: '叉烧', unit: '份' },
  dry_base: { name: '干捞酱料 + 葱 + 油渣', unit: '碗' }, soup_base: { name: '汤底', unit: '碗' }, packaging: { name: '打包盒 + 袋', unit: '套' },
};

/** 每个材料对应的「待校准」标记：确认价钱后一并去掉。 */
const CALIBRATION_OF: Partial<Record<MaterialKey, string>> = { mee_poh: 'noodleHalfBall.mee_poh', soup_base: 'base.soup_noodle', dry_base: 'scallion_lard_extra' };

/** BOM 里这个材料现在的单价（面团为每整粒；底料按干捞面 / 云吞汤）。 */
export function bomValueOf(bom: BomVersion, key: MaterialKey): CostUnits {
  switch (key) {
    case 'thin_egg': return bom.noodleHalfBall.thin_egg * 2;
    case 'mee_poh': return bom.noodleHalfBall.mee_poh * 2;
    case 'wanton': return bom.wanton;
    case 'char_siew': return bom.charSiewPortion;
    case 'dry_base': return bom.base.dry_noodle;
    case 'soup_base': return bom.base.wanton_soup;
    case 'packaging': return bom.packagingPerPortion;
  }
}

/** 面团单价要能平分成半粒（偶数成本单位）。 */
export const normalizeUnitCost = (key: MaterialKey, units: number): CostUnits => {
  const u = Math.max(0, Math.round(units));
  return key === 'thin_egg' || key === 'mee_poh' ? u + (u % 2) : u;
};

/** 把确认的单价换成 BOM 修改（底料一样的价钱同时套用到两种餐品）。 */
export function bomChangesFor(items: { key: MaterialKey; unitCostUnits: CostUnits }[]): BomChanges {
  const c: BomChanges & { noodleBall: NonNullable<BomChanges['noodleBall']>; base: NonNullable<BomChanges['base']> } = { noodleBall: {}, base: {}, calibrated: [] };
  for (const { key, unitCostUnits } of items) {
    const v = normalizeUnitCost(key, unitCostUnits);
    if (key === 'thin_egg' || key === 'mee_poh') c.noodleBall[key] = v;
    else if (key === 'wanton') c.wanton = v;
    else if (key === 'char_siew') c.charSiewPortion = v;
    else if (key === 'dry_base') { c.base.dry_noodle = v; c.base.dry_wanton = v; }
    else if (key === 'soup_base') { c.base.soup_noodle = v; c.base.wanton_soup = v; }
    else c.packagingPerPortion = v;
    const cal = CALIBRATION_OF[key];
    if (cal) c.calibrated!.push(cal);
  }
  return c;
}

export type PriceKind = 'receipt' | 'ai' | 'owner';
export const PRICE_KIND_ZH: Record<PriceKind | 'setting', string> = { receipt: '收据', ai: 'AI 估', owner: '你改的', setting: '旧设定' };

export interface PriceSource {
  kind: PriceKind;
  unitCostUnits: CostUnits;
  /** 白话根据，例如「面家 11/12 · 220 粒 RM187.00」。 */
  basis: string;
  atMs: number;
  /** 确认时 AI 的建议是否被老板改过。 */
  edited?: boolean;
  ref?: string | null;
}

export interface PriceSuggestion {
  kind: 'ai';
  unitCostUnits: CostUnits;
  lowUnits: CostUnits | null;
  highUnits: CostUnits | null;
  basis: string;
  atMs: number;
  provider: string;
  model: string;
}

export type ConversionKey = 'wantonsPerKgPork' | 'sheetsPerKgSkin' | 'charSiewGramsPerPortion';
export const CONVERSION_ZH: Record<ConversionKey, { label: string; unit: string; min: number; max: number }> = {
  wantonsPerKgPork: { label: '1 kg 肉碎 ≈ 多少粒云吞', unit: '粒', min: 20, max: 400 },
  sheetsPerKgSkin: { label: '1 kg 云吞皮 ≈ 多少张', unit: '张', min: 50, max: 1000 },
  charSiewGramsPerPortion: { label: '1 份叉烧 ≈ 多少克', unit: 'g', min: 5, max: 200 },
};
/** 没有资料时的默认换算（页面标为「AI 估 · 待确认」，老板按「对」或改）。 */
export const DEFAULT_CONVERSIONS: Record<ConversionKey, number> = { wantonsPerKgPork: 100, sheetsPerKgSkin: 300, charSiewGramsPerPortion: 27 };

export interface ConversionValue { value: number; kind: 'default' | 'ai' | 'owner'; basis: string; atMs: number }

export interface CostSourcesDoc {
  prices: Partial<Record<MaterialKey, PriceSource>>;
  suggestions: Partial<Record<MaterialKey, PriceSuggestion>>;
  conversions: Partial<Record<ConversionKey, ConversionValue>>;
  /** 上次请 AI 估价的时间与模型（给页面显示）。 */
  lastEstimate?: { atMs: number; provider: string; model: string; notes: string[] } | null;
}

export const EMPTY_COST_SOURCES: CostSourcesDoc = { prices: {}, suggestions: {}, conversions: {}, lastEstimate: null };

export const conversionOf = (doc: CostSourcesDoc | null | undefined, k: ConversionKey): number => doc?.conversions?.[k]?.value ?? DEFAULT_CONVERSIONS[k];
export const isValidConversion = (k: ConversionKey, v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= CONVERSION_ZH[k].min && v <= CONVERSION_ZH[k].max;
/** 单价合理范围：大于 0、低于 RM20（成本单位 0.1 sen）。 */
export const isValidUnitCost = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 20_000;

// ───────────────────────── 收据价 ─────────────────────────

export interface StockBatch {
  id: string;
  ingredientId: string;
  ingredientName?: string;
  quantity: number;
  unit: string;
  costSen: Sen | null;
  purchasedDate: string | null;
  status: string;
  origin?: string;
  createdAtMs: number;
}

const KG = new Set(['kg', 'KG', 'Kg', '公斤', '千克']);
const G = new Set(['g', '克']);
const isKg = (u: string) => KG.has(u.trim());
const kgOf = (q: number, u: string) => (isKg(u) ? q : G.has(u.trim()) ? q / 1000 : null);
const isPiece = (u: string, words: string[]) => words.includes(u.trim());

const latest = (batches: StockBatch[], id: string, ok: (b: StockBatch) => boolean) =>
  batches.filter((b) => b.ingredientId === id && b.status !== 'voided' && b.costSen !== null && b.costSen > 0 && b.quantity > 0 && ok(b))
    .sort((a, b) => (b.purchasedDate ?? '').localeCompare(a.purchasedDate ?? '') || b.createdAtMs - a.createdAtMs)[0] ?? null;

const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : '');
const rm = (sen: number) => `RM${(sen / 100).toFixed(2)}`;
const qtyText = (q: number) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000));

export interface ReceiptPrice { key: MaterialKey; unitCostUnits: CostUnits; basis: string; batchId: string; date: string | null }

/** 从最近的进货批次推算单价（只在单位对得上时）。 */
export function receiptPrices(batches: StockBatch[], sources: CostSourcesDoc | null | undefined): ReceiptPrice[] {
  const out: ReceiptPrice[] = [];
  const balls = (key: 'thin_egg' | 'mee_poh', id: string) => {
    const b = latest(batches, id, (x) => isPiece(x.unit, ['粒', '个', '球', 'pcs']));
    if (b) out.push({ key, unitCostUnits: normalizeUnitCost(key, (b.costSen! * 10) / b.quantity), basis: `${md(b.purchasedDate)} 进货 ${qtyText(b.quantity)} ${b.unit} ${rm(b.costSen!)}`, batchId: b.id, date: b.purchasedDate });
  };
  balls('thin_egg', 'ing-thin-noodle');
  balls('mee_poh', 'ing-mee-poh');
  const cs = latest(batches, 'ing-char-siew', (x) => kgOf(1, x.unit) !== null);
  if (cs) {
    const grams = conversionOf(sources, 'charSiewGramsPerPortion');
    const perKg = (cs.costSen! * 10) / kgOf(cs.quantity, cs.unit)!;
    out.push({ key: 'char_siew', unitCostUnits: normalizeUnitCost('char_siew', (perKg * grams) / 1000), basis: `${md(cs.purchasedDate)} 叉烧 ${rm(Math.round(perKg / 10))}/kg × 每份 ${grams} g`, batchId: cs.id, date: cs.purchasedDate });
  }
  const pork = latest(batches, 'ing-minced-pork', (x) => kgOf(1, x.unit) !== null);
  if (pork) {
    const perKg = (pork.costSen! * 10) / kgOf(pork.quantity, pork.unit)!;
    const perWanton = perKg / conversionOf(sources, 'wantonsPerKgPork');
    const skin = latest(batches, 'ing-wanton-skin', (x) => kgOf(1, x.unit) !== null || isPiece(x.unit, ['张', '片', 'pcs']));
    const skinEach = skin ? (kgOf(1, skin.unit) !== null ? (skin.costSen! * 10) / kgOf(skin.quantity, skin.unit)! / conversionOf(sources, 'sheetsPerKgSkin') : (skin.costSen! * 10) / skin.quantity) : null;
    out.push({
      key: 'wanton', unitCostUnits: normalizeUnitCost('wanton', perWanton + (skinEach ?? 0)), batchId: pork.id, date: pork.purchasedDate,
      basis: `肉碎 ${rm(Math.round(perKg / 10))}/kg ÷ ${conversionOf(sources, 'wantonsPerKgPork')} 粒${skinEach !== null ? ` + 云吞皮约 ${rm(Math.round(skinEach / 10))}` : '（云吞皮还没有收据，没算）'}`,
    });
  }
  return out;
}

// ───────────────────────── 剩余与明天要多少 ─────────────────────────

export interface StockCountDoc { id: string; ingredientId: string; quantity: number; unit: string; businessDate: string; atMs: number }

export type StockStatus = 'short' | 'low' | 'ok';

export interface StockEstimate {
  ingredientId: string;
  name: string;
  unit: string;
  remaining: number;
  /** 起点说明：「11/12 进货算起（之前剩的没算）」或「11/13 收档点过 8 粒」。 */
  anchorText: string;
  purchasedSince: number;
  usedSince: number;
  tomorrowNeed: number | null;
  avgDaily: number | null;
  status: StockStatus | null;
  daysLeft: number | null;
  /** 进货单位和用量单位对不上时的提示。 */
  unitIssue: string | null;
}

interface Tracked { id: string; name: string; unit: string; units: string[]; per: (u: MaterialUsage, sources: CostSourcesDoc | null | undefined) => number; toUnit?: (q: number, unit: string, sources: CostSourcesDoc | null | undefined) => number | null }

const TRACKED: Tracked[] = [
  { id: 'ing-thin-noodle', name: '细面面团', unit: '粒', units: ['粒', '个', '球', 'pcs'], per: (u) => u.noodleHalfByType.thin_egg / 2 },
  { id: 'ing-mee-poh', name: '面薄面团', unit: '粒', units: ['粒', '个', '球', 'pcs'], per: (u) => u.noodleHalfByType.mee_poh / 2 },
  { id: 'ing-minced-pork', name: '肉碎（包云吞）', unit: 'kg', units: [], per: (u, s) => u.wanton.total / conversionOf(s, 'wantonsPerKgPork'), toUnit: (q, unit) => kgOf(q, unit) },
  {
    id: 'ing-wanton-skin', name: '云吞皮', unit: '张', units: ['张', '片', 'pcs'], per: (u) => u.wanton.total,
    toUnit: (q, unit, s) => (kgOf(q, unit) !== null ? kgOf(q, unit)! * conversionOf(s, 'sheetsPerKgSkin') : null),
  },
];

export interface DayUsage { date: string; usage: MaterialUsage }

const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** 某天（通常是明天）预计要多少：前三周同一天的平均；不够两天资料就用近 7 天营业日平均。 */
export function expectedUsage(days: DayUsage[], forDate: string, per: (u: MaterialUsage) => number): number | null {
  const same = [7, 14, 21].map((n) => days.find((d) => d.date === addDays(forDate, -n))).filter((d): d is DayUsage => Boolean(d && d.usage.bowls > 0));
  const pool = same.length >= 2 ? same : days.filter((d) => d.date < forDate && d.date >= addDays(forDate, -7) && d.usage.bowls > 0);
  if (!pool.length) return null;
  return pool.reduce((s, d) => s + per(d.usage), 0) / pool.length;
}

/**
 * 估算剩余。days 要涵盖起点之后的每一天（今天也算，用量到现在为止）。counts 是收档点数，batches 是进货批次。
 * 只估有进货或点数记录的材料。
 */
export function stockEstimates(input: { batches: StockBatch[]; counts: StockCountDoc[]; days: DayUsage[]; today: string; sources: CostSourcesDoc | null | undefined }): StockEstimate[] {
  const { batches, counts, days, today, sources } = input;
  const out: StockEstimate[] = [];
  const tomorrow = addDays(today, 1);
  for (const t of TRACKED) {
    const live = batches.filter((b) => b.ingredientId === t.id && b.status !== 'voided');
    const qtyIn = (b: StockBatch) => (t.units.includes(b.unit.trim()) ? b.quantity : t.toUnit ? t.toUnit(b.quantity, b.unit, sources) : null);
    const bad = live.filter((b) => qtyIn(b) === null);
    const ok = live.filter((b) => qtyIn(b) !== null);
    const count = counts.filter((c) => c.ingredientId === t.id).sort((a, b) => b.atMs - a.atMs)[0] ?? null;
    if (!ok.length && !count) {
      if (bad.length) out.push({ ingredientId: t.id, name: t.name, unit: t.unit, remaining: 0, anchorText: '', purchasedSince: 0, usedSince: 0, tomorrowNeed: null, avgDaily: null, status: null, daysLeft: null, unitIssue: `进货记成「${bad[0].unit}」，要按${t.unit}记才能算剩余` });
      continue;
    }
    const per = (u: MaterialUsage) => t.per(u, sources);
    let start: number, anchorText: string, purchased: number, used: number;
    if (count) {
      start = count.quantity;
      purchased = ok.filter((b) => b.createdAtMs > count.atMs).reduce((s, b) => s + qtyIn(b)!, 0);
      used = days.filter((d) => d.date > count.businessDate && d.date <= today).reduce((s, d) => s + per(d.usage), 0);
      anchorText = `${md(count.businessDate)} 收档点过 ${qtyText(count.quantity)} ${t.unit}`;
    } else {
      const since = addDays(today, -30);
      const recent = ok.filter((b) => (b.purchasedDate ?? today) >= since);
      const first = [...(recent.length ? recent : ok)].sort((a, b) => (a.purchasedDate ?? '').localeCompare(b.purchasedDate ?? ''))[0];
      const from = first.purchasedDate ?? today;
      start = 0;
      purchased = ok.filter((b) => (b.purchasedDate ?? today) >= from).reduce((s, b) => s + qtyIn(b)!, 0);
      used = days.filter((d) => d.date >= from && d.date <= today).reduce((s, d) => s + per(d.usage), 0);
      anchorText = `${md(from)} 进货算起（之前剩的没算）`;
    }
    const remaining = round(start + purchased - used, t.unit === 'kg' ? 1 : 0);
    const need = expectedUsage(days, tomorrow, per);
    const open = days.filter((d) => d.date <= today && d.date > addDays(today, -7) && d.usage.bowls > 0);
    const avgDaily = open.length ? open.reduce((s, d) => s + per(d.usage), 0) / open.length : null;
    const status: StockStatus | null = need === null ? null : remaining < need ? 'short' : remaining < need * 2 ? 'low' : 'ok';
    out.push({
      ingredientId: t.id, name: t.name, unit: t.unit, remaining, anchorText, purchasedSince: round(purchased, 1), usedSince: round(used, 1),
      tomorrowNeed: need === null ? null : round(need, t.unit === 'kg' ? 1 : 0), avgDaily: avgDaily === null ? null : round(avgDaily, 1), status,
      daysLeft: avgDaily ? round(Math.max(0, remaining) / avgDaily, 1) : null, unitIssue: bad.length ? `另有 ${bad.length} 批单位是「${bad[0].unit}」，没算进去` : null,
    });
  }
  return out;
}

// ───────────────────────── 收档小结要用的数字 ─────────────────────────

export interface SummaryFacts {
  date: string;
  weekday: string;
  orders: number;
  bowls: number;
  balls: string;
  ballsTarget: number;
  revenueSen: Sen;
  lastWeekRevenueSen: Sen | null;
  lastWeekBowls: number | null;
  topDishes: { label: string; bowls: number }[];
  peakHour: { hour: number; sen: Sen } | null;
  wanton: number;
  charSiew: number;
  tomorrow: { date: string; weekday: string; thinBalls: number | null; meePohBalls: number | null; wanton: number | null; charSiew: number | null };
  shortages: { name: string; remaining: string; need: string }[];
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const weekdayZh = (d: string) => WEEKDAY_ZH[weekday(d)];

/** 小结里允许出现的数字（模型写的数字必须都在这里面，否则不用它的话）。 */
export function summaryNumbers(f: SummaryFacts): Set<string> {
  const s = new Set<string>();
  const add = (v: number | string | null | undefined) => { if (v !== null && v !== undefined) s.add(String(v)); };
  const addRm = (sen: number | null) => { if (sen !== null) { add((sen / 100).toFixed(2)); add(String(Math.round(sen / 100))); } };
  [f.orders, f.bowls, f.balls, f.ballsTarget, f.wanton, f.charSiew, f.lastWeekBowls].forEach(add);
  addRm(f.revenueSen); addRm(f.lastWeekRevenueSen);
  if (f.lastWeekRevenueSen !== null) addRm(Math.abs(f.revenueSen - f.lastWeekRevenueSen));
  if (f.lastWeekBowls !== null) add(Math.abs(f.bowls - f.lastWeekBowls));
  for (const d of f.topDishes) add(d.bowls);
  if (f.topDishes.length >= 2) add(f.topDishes[0].bowls + f.topDishes[1].bowls);
  if (f.peakHour) { add(f.peakHour.hour); add(f.peakHour.hour > 12 ? f.peakHour.hour - 12 : f.peakHour.hour); add(f.peakHour.hour + 1); add((f.peakHour.hour % 12) + 1); addRm(f.peakHour.sen); }
  const t = f.tomorrow;
  [t.thinBalls, t.meePohBalls, t.wanton, t.charSiew].forEach(add);
  for (const x of f.shortages) { add(x.remaining); add(x.need); }
  [f.date.slice(5, 7), Number(f.date.slice(5, 7)), Number(f.date.slice(8)), Number(t.date.slice(5, 7)), Number(t.date.slice(8))].forEach(add);
  return s;
}

/** 文字里的数字（含 ½ 与小数）。 */
export function numbersIn(text: string): string[] {
  return [...text.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?½?/g)].map((m) => m[0]);
}

/** 没有 AI 时的白话小结（同样只用算好的数字）。 */
export function plainSummary(f: SummaryFacts): string[] {
  const rmText = (sen: number) => `RM${(sen / 100).toFixed(2)}`;
  const vs = f.lastWeekRevenueSen !== null ? `，比上${f.weekday}${f.revenueSen >= f.lastWeekRevenueSen ? '多' : '少'} ${rmText(Math.abs(f.revenueSen - f.lastWeekRevenueSen))}` : '';
  const top = f.topDishes.slice(0, 2).map((d) => `${d.label} ${d.bowls} 碗`).join('、');
  const t = f.tomorrow;
  const prep = [t.thinBalls !== null && `细面约 ${t.thinBalls} 粒`, t.meePohBalls !== null && `面薄约 ${t.meePohBalls} 粒`, t.wanton !== null && `云吞约 ${t.wanton} 粒`, t.charSiew !== null && `叉烧约 ${t.charSiew} 份`].filter(Boolean).join('、');
  return [
    `卖了 ${f.bowls} 碗、${f.balls} 粒面，收入 ${rmText(f.revenueSen)}${vs}。${f.peakHour ? `${f.peakHour.hour} 点那一小时最旺。` : ''}`,
    top ? `卖得最好的是 ${top}。` : '这天还没有卖出。',
    prep ? `明天（${t.weekday}）建议备：${prep}。${f.shortages.length ? `${f.shortages.map((s) => s.name).join('、')}可能不够，记得补货。` : ''}` : '资料还不够，暂时给不出明天的备料建议。',
  ];
}

/** 由当天用量、上周同一天、每小时金额、近几周用量与剩余，算出小结要用的数字（收入按有效订单金额）。 */
export function buildSummaryFacts(i: {
  date: string; usage: MaterialUsage; revenueSen: Sen; lastWeek: { usage: MaterialUsage; revenueSen: Sen } | null;
  hourly: { hour: number; sen: Sen }[]; days: DayUsage[]; stock: StockEstimate[]; ballsTarget: number;
}): SummaryFacts {
  const tomorrow = addDays(i.date, 1);
  const exp = (f: (u: MaterialUsage) => number, step = 1) => {
    const v = expectedUsage(i.days, tomorrow, f);
    return v === null ? null : Math.ceil(v / step) * step;
  };
  const peak = i.hourly.filter((h) => h.sen > 0).sort((a, b) => b.sen - a.sen)[0] ?? null;
  const half = i.usage.noodleHalf;
  return {
    date: i.date, weekday: weekdayZh(i.date), orders: i.usage.orders, bowls: i.usage.bowls,
    balls: half % 2 === 0 ? String(half / 2) : `${(half - 1) / 2}½`, ballsTarget: i.ballsTarget, revenueSen: i.revenueSen,
    lastWeekRevenueSen: i.lastWeek && i.lastWeek.usage.bowls > 0 ? i.lastWeek.revenueSen : null, lastWeekBowls: i.lastWeek && i.lastWeek.usage.bowls > 0 ? i.lastWeek.usage.bowls : null,
    topDishes: i.usage.byDish.slice(0, 3).map((d) => ({ label: d.label, bowls: d.bowls })), peakHour: peak,
    wanton: i.usage.wanton.total, charSiew: i.usage.charSiew.total,
    tomorrow: {
      date: tomorrow, weekday: weekdayZh(tomorrow),
      thinBalls: exp((u) => u.noodleHalfByType.thin_egg / 2), meePohBalls: exp((u) => u.noodleHalfByType.mee_poh / 2),
      wanton: exp((u) => u.wanton.total, 10), charSiew: exp((u) => u.charSiew.total),
    },
    shortages: i.stock.filter((x) => x.status === 'short' && x.tomorrowNeed !== null).map((x) => ({ name: x.name, remaining: `${qtyText(x.remaining)}`, need: `${qtyText(x.tomorrowNeed!)}` })),
  };
}
