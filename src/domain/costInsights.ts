/**
 * 开销分析的确定性统计（AI 只负责解释这些数字，不自己合计）。前端卡片与服务端解读用同一份结果。
 *
 * 口径：
 * - 以有效支出为准（作废的不算）；收据凭证、库存批次只补充分类与数量，不再加一次钱。
 * - 补付款记录（settlesExpenseId）只改变「已付 / 未付」，不是新的开销。
 * - 按购买 / 发生日（businessDate）统计「采购与开支发生额」；已付金额按同一批记录的付款状态，不等于该区间的真实现金流。
 * - 资本支出、已确认属于开档项目或后续资本投入的部分不算日常开销，单独列出；月租 / 电费的归属仍算租金 / 电费。
 * - 对比区间：从月初开始的区间对比上个月同样天数（短月取到月底）；其他区间对比前面等长天数。
 * - 单价只在同一种食材、可换算单位（kg/g、L/ml）两期都有数量时才比较；没有数量就只谈采购金额。
 */
import { addDays, DateRange, daysInMonth, inRange, rangeLength } from './businessDay';
import { BUILT_IN_BY_ID, ExpenseLinkDoc, IngredientCategory, PLAN_ITEM_ZH, PlanItem } from './costing';
import { canonicalJson, sha256Hex } from './idempotency';
import { type CostCategory, costCategoryOfIngredient } from './aiCost';
import type { Sen } from './money';

export const INSIGHTS_POLICY_VERSION = 'cost-insights-v1';

export type SpendBucket = CostCategory | 'fixed_other';
export const BUCKET_ZH: Record<SpendBucket, string> = {
  noodle: '面和面薄', wonton: '云吞', topping: '配料', seasoning: '调味料', other_food: '其他食材',
  gas: PLAN_ITEM_ZH.gas, misc: PLAN_ITEM_ZH.misc, wage: PLAN_ITEM_ZH.wage, rent: PLAN_ITEM_ZH.rent, fridge_power: PLAN_ITEM_ZH.fridge_power, fixed_other: '其他固定费用',
};
export const FOOD_BUCKETS: SpendBucket[] = ['noodle', 'wonton', 'topping', 'seasoning', 'other_food'];

export interface StatsExpense {
  id: string;
  category: 'purchase' | 'fixed_payment' | 'opex' | 'capital';
  description: string;
  amountSen: Sen;
  paidSen: Sen;
  businessDate: string;
  status: 'active' | 'voided';
  planItem?: PlanItem | null;
  ingredientBatchId?: string | null;
  settlesExpenseId?: string | null;
  costCategory?: CostCategory | null;
  purchaseDetailId?: string | null;
}

export interface StatsBatch { id: string; ingredientId: string; ingredientName: string; category: IngredientCategory; quantity: number; unit: string; purchaseExpenseId: string | null; status: string }
export interface StatsPurchaseDetail { id: string; expenseId: string; ingredientId: string | null; name: string; quantity: number | null; unit: string | null; usageState: 'pending' | 'stocked' }

export interface PeriodSpend {
  range: DateRange;
  days: number;
  totalSen: Sen;
  paidSen: Sen;
  unpaidSen: Sen;
  foodSen: Sen;
  dailySen: Sen;
  recordCount: number;
  byBucket: { bucket: SpendBucket; label: string; sen: Sen; count: number }[];
}

export interface UnitPriceCompare { ingredientId: string; name: string; unit: string; currentPerUnitSen: Sen; previousPerUnitSen: Sen; currentSamples: number; previousSamples: number }

export interface CostEvidence { id: string; date: string; label: string; bucket: string; amountSen: Sen; paid: boolean }

export interface CostStats {
  policyVersion: string;
  current: PeriodSpend;
  previous: PeriodSpend;
  /** 截至现在仍未付清的支出（不限区间）。 */
  outstanding: { totalSen: Sen; count: number; items: { id: string; label: string; date: string; outstandingSen: Sen }[] };
  /** 资料完整性：采购有无数量、对比区间天数是否相同。 */
  coverage: { foodRecords: number; foodWithQuantity: number; pendingUsage: number; sameLength: boolean; notes: string[] };
  /** 不算日常开销、单独列出的金额。 */
  excluded: { capitalSen: Sen; startupLinkedSen: Sen; laterCapitalSen: Sen };
  unitPrices: UnitPriceCompare[];
  evidence: CostEvidence[];
}

export function compareRangeOf(r: DateRange): DateRange {
  const len = rangeLength(r);
  if (r.start.endsWith('-01')) {
    const [y, m] = r.start.split('-').map(Number);
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const start = `${py}-${String(pm).padStart(2, '0')}-01`;
    return { start, endExclusive: addDays(start, Math.min(len, daysInMonth(py, pm))) };
  }
  return { start: addDays(r.start, -len), endExclusive: r.start };
}

const UNIT_BASE: Record<string, { base: string; factor: number }> = {
  kg: { base: 'kg', factor: 1 }, '公斤': { base: 'kg', factor: 1 }, g: { base: 'kg', factor: 0.001 }, '克': { base: 'kg', factor: 0.001 },
  l: { base: 'L', factor: 1 }, '升': { base: 'L', factor: 1 }, ml: { base: 'L', factor: 0.001 }, '毫升': { base: 'L', factor: 0.001 },
};
/** 把数量换算到基本单位；不能换算的单位只和自己比（瓶只和瓶比）。 */
export function normalizeQuantity(quantity: number, unit: string): { base: string; quantity: number } {
  const u = UNIT_BASE[unit.trim().toLowerCase()];
  return u ? { base: u.base, quantity: quantity * u.factor } : { base: unit.trim(), quantity };
}

interface Counted { e: StatsExpense; sen: Sen; paid: Sen; bucket: SpendBucket }

function bucketOf(e: StatsExpense, batches: Map<string, StatsBatch>): SpendBucket {
  if (e.costCategory) return e.costCategory;
  if (e.category === 'purchase') {
    const b = e.ingredientBatchId ? batches.get(e.ingredientBatchId) : undefined;
    return b ? costCategoryOfIngredient(b.category) : 'other_food';
  }
  if (e.category === 'fixed_payment') return e.planItem === 'rent' || e.planItem === 'fridge_power' ? e.planItem : 'fixed_other';
  return e.planItem === 'gas' || e.planItem === 'wage' || e.planItem === 'misc' ? e.planItem : 'misc';
}

export function buildCostStats(input: { expenses: StatsExpense[]; links: ExpenseLinkDoc[]; batches: StatsBatch[]; purchaseDetails: StatsPurchaseDetail[]; range: DateRange }): CostStats {
  const active = input.expenses.filter((e) => e.status === 'active');
  const settled = new Map<string, Sen>();
  for (const s of active) if (s.settlesExpenseId) settled.set(s.settlesExpenseId, (settled.get(s.settlesExpenseId) ?? 0) + s.paidSen);
  const batches = new Map(input.batches.filter((b) => b.status !== 'voided').map((b) => [b.id, b]));
  const linkSum = (id: string, kinds: string[]) => input.links.filter((l) => l.expenseId === id).flatMap((l) => l.links).filter((l) => l.status === 'active' && kinds.includes(l.kind)).reduce((s, l) => s + l.amountSen, 0);
  const excluded = { capitalSen: 0, startupLinkedSen: 0, laterCapitalSen: 0 };
  const compare = compareRangeOf(input.range);

  const counted = (range: DateRange, track: boolean): Counted[] => {
    const out: Counted[] = [];
    for (const e of active) {
      if (e.settlesExpenseId || !inRange(e.businessDate, range)) continue;
      const startup = linkSum(e.id, ['startup']), later = linkSum(e.id, ['later_capital']);
      if (track) { excluded.startupLinkedSen += startup; excluded.laterCapitalSen += later; }
      if (e.category === 'capital') { if (track) excluded.capitalSen += Math.max(0, e.amountSen - startup - later); continue; }
      const sen = Math.max(0, e.amountSen - startup - later);
      if (sen === 0) continue;
      const paid = Math.min(sen, e.paidSen + (settled.get(e.id) ?? 0));
      out.push({ e, sen, paid, bucket: bucketOf(e, batches) });
    }
    return out;
  };

  const period = (range: DateRange, rows: Counted[]): PeriodSpend => {
    const by = new Map<SpendBucket, { sen: Sen; count: number }>();
    for (const r of rows) {
      const x = by.get(r.bucket) ?? { sen: 0, count: 0 };
      by.set(r.bucket, { sen: x.sen + r.sen, count: x.count + 1 });
    }
    const total = rows.reduce((s, r) => s + r.sen, 0);
    const paid = rows.reduce((s, r) => s + r.paid, 0);
    const food = rows.filter((r) => FOOD_BUCKETS.includes(r.bucket)).reduce((s, r) => s + r.sen, 0);
    return {
      range, days: rangeLength(range), totalSen: total, paidSen: paid, unpaidSen: total - paid, foodSen: food, dailySen: total - food, recordCount: rows.length,
      byBucket: [...by.entries()].map(([bucket, v]) => ({ bucket, label: BUCKET_ZH[bucket], ...v })).sort((a, b) => b.sen - a.sen || a.bucket.localeCompare(b.bucket)),
    };
  };

  const cur = counted(input.range, true);
  const prev = counted(compare, false);
  const current = period(input.range, cur);
  const previous = period(compare, prev);

  // 未付清（不限区间）：原支出 − 已付 − 补付款。
  const outstandingItems = active.filter((e) => !e.settlesExpenseId && e.category !== 'capital')
    .map((e) => ({ id: e.id, label: e.description, date: e.businessDate, outstandingSen: e.amountSen - e.paidSen - (settled.get(e.id) ?? 0) }))
    .filter((x) => x.outstandingSen > 0).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // 数量：库存批次或采购明细（补过用量的会两者都有，只取一次）。
  const details = new Map(input.purchaseDetails.map((p) => [p.expenseId, p]));
  const qtyOf = (e: StatsExpense): { ingredientId: string; name: string; quantity: number; unit: string } | null => {
    const b = e.ingredientBatchId ? batches.get(e.ingredientBatchId) : undefined;
    if (b) return { ingredientId: b.ingredientId, name: b.ingredientName, quantity: b.quantity, unit: b.unit };
    const p = details.get(e.id);
    if (p && p.ingredientId && p.quantity !== null && p.unit) return { ingredientId: p.ingredientId, name: BUILT_IN_BY_ID.get(p.ingredientId)?.name ?? p.name, quantity: p.quantity, unit: p.unit };
    return null;
  };
  const food = cur.filter((r) => r.e.category === 'purchase');
  const withQty = food.filter((r) => qtyOf(r.e));
  const pendingUsage = input.purchaseDetails.filter((p) => p.usageState === 'pending' && food.some((r) => r.e.id === p.expenseId)).length;

  const priceMap = (rows: Counted[]) => {
    const m = new Map<string, { name: string; unit: string; sen: Sen; qty: number; n: number }>();
    for (const r of rows) {
      const q = r.e.category === 'purchase' ? qtyOf(r.e) : null;
      if (!q) continue;
      const n = normalizeQuantity(q.quantity, q.unit);
      const k = `${q.ingredientId}|${n.base}`;
      const x = m.get(k) ?? { name: q.name, unit: n.base, sen: 0, qty: 0, n: 0 };
      m.set(k, { ...x, sen: x.sen + r.sen, qty: x.qty + n.quantity, n: x.n + 1 });
    }
    return m;
  };
  const pc = priceMap(cur), pp = priceMap(prev);
  const unitPrices: UnitPriceCompare[] = [...pc.entries()].filter(([k]) => pp.has(k)).map(([k, c]) => {
    const p = pp.get(k)!;
    return { ingredientId: k.split('|')[0], name: c.name, unit: c.unit, currentPerUnitSen: Math.round(c.sen / c.qty), previousPerUnitSen: Math.round(p.sen / p.qty), currentSamples: c.n, previousSamples: p.n };
  }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));

  const notes: string[] = [];
  if (food.length && withQty.length < food.length) notes.push(`本期 ${food.length} 笔食材采购中有 ${food.length - withQty.length} 笔没有数量，只能比较采购金额，不能判断单价变化`);
  if (current.days !== previous.days) notes.push(`对比区间天数不同（本期 ${current.days} 天，对比 ${previous.days} 天）`);
  notes.push('采购金额不等于实际消耗；没有用量与销售资料时不推断浪费、剩余或单碗成本');

  const evidence: CostEvidence[] = [
    ...[...cur].sort((a, b) => b.sen - a.sen || a.e.id.localeCompare(b.e.id)).slice(0, 40).map((r) => ({ id: r.e.id, date: r.e.businessDate, label: r.e.description, bucket: BUCKET_ZH[r.bucket], amountSen: r.sen, paid: r.paid >= r.sen })),
    ...[...prev].sort((a, b) => b.sen - a.sen || a.e.id.localeCompare(b.e.id)).slice(0, 20).map((r) => ({ id: r.e.id, date: r.e.businessDate, label: r.e.description, bucket: BUCKET_ZH[r.bucket], amountSen: r.sen, paid: r.paid >= r.sen })),
  ];
  for (const o of outstandingItems.slice(0, 20)) if (!evidence.some((x) => x.id === o.id)) evidence.push({ id: o.id, date: o.date, label: o.label, bucket: '待付款', amountSen: o.outstandingSen, paid: false });

  return {
    policyVersion: INSIGHTS_POLICY_VERSION, current, previous,
    outstanding: { totalSen: outstandingItems.reduce((s, x) => s + x.outstandingSen, 0), count: outstandingItems.length, items: outstandingItems.slice(0, 50) },
    coverage: { foodRecords: food.length, foodWithQuantity: withQty.length, pendingUsage, sameLength: current.days === previous.days, notes },
    excluded, unitPrices, evidence,
  };
}

/** 解读可以引用的金额：统计里出现的每个数，以及本期 / 对比的差额。 */
export function allowedAmounts(s: CostStats): Set<number> {
  const out = new Set<number>();
  const add = (n: number) => out.add(Math.abs(n));
  for (const p of [s.current, s.previous]) {
    [p.totalSen, p.paidSen, p.unpaidSen, p.foodSen, p.dailySen].forEach(add);
    p.byBucket.forEach((b) => add(b.sen));
  }
  [s.current.totalSen - s.previous.totalSen, s.current.foodSen - s.previous.foodSen, s.current.dailySen - s.previous.dailySen, s.current.paidSen - s.previous.paidSen].forEach(add);
  for (const b of s.current.byBucket) add(b.sen - (s.previous.byBucket.find((x) => x.bucket === b.bucket)?.sen ?? 0));
  for (const b of s.previous.byBucket) if (!s.current.byBucket.some((x) => x.bucket === b.bucket)) add(b.sen);
  add(s.outstanding.totalSen);
  s.outstanding.items.forEach((i) => add(i.outstandingSen));
  s.unitPrices.forEach((u) => { add(u.currentPerUnitSen); add(u.previousPerUnitSen); add(u.currentPerUnitSen - u.previousPerUnitSen); });
  s.evidence.forEach((e) => add(e.amountSen));
  [s.excluded.capitalSen, s.excluded.startupLinkedSen, s.excluded.laterCapitalSen].forEach(add);
  return out;
}

/** 账本摘要：统计结果（含付款、作废、归属、证据记录与口径版本）的哈希；任何会改变统计的账目变化都会改变它。 */
export async function statsDigest(s: CostStats): Promise<string> {
  return `sha256-${await sha256Hex(canonicalJson(s))}`;
}
