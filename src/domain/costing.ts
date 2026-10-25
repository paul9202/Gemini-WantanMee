/**
 * 收支、食材批次、日常开支、开档成本与经营目标（2026-10-25 收支改版）。前端与 Functions 共用同一套口径。
 *
 * 口径（避免重复扣）：
 * - 实际收款：已登记收款 − 已登记退款（人工登记，不是钱包或银行自动核对）。
 * - 已付支出：按付款日的现金流出（食材进货、日常开支），不含开档投入。
 * - 收支结余 = 实际收款 − 已付支出，不代表利润。
 * - 食材消耗成本：只来自「已用完、成本已知」的批次，按批次实际起止时间平均摊到每天；
 *   仍在使用或成本待补的批次只计「待核算」，不估算剩余量或逐日用量。进货付款不再计入经营利润。
 * - 经营利润 = 实际收款 − 食材消耗成本 − 固定费用（租金 + 冰箱电费，按月份分摊）− 其他营业费用（煤气、杂费、工资）。
 *   食材消耗未核算完整时，利润显示「待核算」，只给出按理论用量（BOM）的暂估。
 * - 固定费用付款（租金、电费）只进现金视角；经营视角只按月份分摊，不重复扣整笔。
 * - 回本：累计实际收款 − 累计已付经营支出 − 已到期未付的经营支出（不含开档投入与押金），对比开档总投入。
 */
import { addDays, BusinessDayPolicy, DateRange, daysInMonth, wallClock } from './businessDay';
import { formatRM, type Sen } from './money';

export const DAY_MS = 86_400_000;

// ───────────────────────── 时间 ─────────────────────────

/** 'YYYY-MM-DDTHH:mm'（门店时区的本地时间）→ epoch ms。非法返回 null。 */
export function zonedLocalToMs(local: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, hh, mm] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || hh > 23 || mm > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  // 用该时刻在门店时区的墙上时间反推偏移（马来西亚无夏令时，两次即收敛）。
  let ms = guess;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(ms, timeZone);
    ms += guess - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  }
  return ms;
}

/** epoch ms → 门店时区 'YYYY-MM-DDTHH:mm'（用于 datetime-local 输入框）。 */
export function msToZonedLocal(ms: number, timeZone: string): string {
  const w = wallClock(ms, timeZone);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.m)}-${p(w.d)}T${p(w.hh)}:${p(w.mm)}`;
}

/** 营业日区间 → 毫秒区间（每个营业日从切点开始）。 */
export function businessRangeMs(range: DateRange, policy: BusinessDayPolicy): { startMs: number; endMs: number } {
  const at = (date: string) => {
    const h = Math.floor(policy.cutoverMinutes / 60), mi = policy.cutoverMinutes % 60;
    return zonedLocalToMs(`${date}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, policy.timeZone)!;
  };
  return { startMs: at(range.start), endMs: at(range.endExclusive) };
}

export const isMonthString = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const monthOf = (date: string) => date.slice(0, 7);

/** 两个月份之间的月数差（b − a）。 */
export function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function monthRange(month: string): DateRange {
  return { start: `${month}-01`, endExclusive: addDays(`${month}-01`, daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))) };
}

// ───────────────────────── 食材 ─────────────────────────

export type IngredientCategory = 'noodle' | 'wonton' | 'topping' | 'seasoning' | 'other';

export const INGREDIENT_CATEGORIES: { id: IngredientCategory; nameZh: string; desc: string }[] = [
  { id: 'noodle', nameZh: '面和面薄', desc: '细面 · 面薄' },
  { id: 'wonton', nameZh: '云吞', desc: '肉碎 · 云吞皮' },
  { id: 'topping', nameZh: '配料', desc: '青辣椒 · 叉烧 · 油渣 · 葱' },
  { id: 'seasoning', nameZh: '调味料', desc: '酱料 · 汤底原料' },
  { id: 'other', nameZh: '其他食材', desc: '可自定义扩充' },
];
export const INGREDIENT_CATEGORY_IDS = INGREDIENT_CATEGORIES.map((c) => c.id);

export interface Ingredient {
  id: string;
  category: IngredientCategory;
  name: string;
  /** 默认单位，录入批次时可改。 */
  unit: string;
  builtIn: boolean;
}

const builtIn = (id: string, category: IngredientCategory, name: string, unit: string): Ingredient => ({ id, category, name, unit, builtIn: true });

/** 预置食材只在代码里，不写数据库；自定义食材写入 ingredients 集合。 */
export const BUILT_IN_INGREDIENTS: Ingredient[] = [
  builtIn('ing-thin-noodle', 'noodle', '细面', '粒'),
  builtIn('ing-mee-poh', 'noodle', '面薄', '粒'),
  builtIn('ing-minced-pork', 'wonton', '肉碎', 'kg'),
  builtIn('ing-wanton-skin', 'wonton', '云吞皮', '张'),
  builtIn('ing-green-chili', 'topping', '青辣椒', 'kg'),
  builtIn('ing-char-siew', 'topping', '叉烧', 'kg'),
  builtIn('ing-lard-crisp', 'topping', '猪油渣', 'kg'),
  builtIn('ing-scallion', 'topping', '葱', 'kg'),
  builtIn('ing-tomato-sauce', 'seasoning', '番茄酱', '瓶'),
  builtIn('ing-oyster-sauce', 'seasoning', '蚝油', '瓶'),
  builtIn('ing-sesame-oil', 'seasoning', '麻油', '瓶'),
  builtIn('ing-light-soy', 'seasoning', '生抽', '瓶'),
  builtIn('ing-salt', 'seasoning', '盐', '包'),
  builtIn('ing-dried-flounder', 'seasoning', '鳊鱼', 'kg'),
  builtIn('ing-anchovy', 'seasoning', '江鱼仔', 'kg'),
  builtIn('ing-soybean', 'seasoning', '黄豆', 'kg'),
  builtIn('ing-rock-sugar', 'seasoning', '冰糖', 'kg'),
  builtIn('ing-msg', 'seasoning', '味精', '包'),
  builtIn('ing-chicken-powder', 'seasoning', '鸡精', '包'),
  builtIn('ing-pork-bone', 'seasoning', '猪骨', 'kg'),
];

export const BUILT_IN_BY_ID = new Map(BUILT_IN_INGREDIENTS.map((i) => [i.id, i]));

/** 数量：正数，最多 3 位小数。 */
export function isQuantity(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1_000_000 && Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6;
}

export type BatchStatus = 'stocked' | 'in_use' | 'finished' | 'voided';

export interface BatchDoc {
  id: string;
  ingredientId: string;
  ingredientName: string;
  category: IngredientCategory;
  quantity: number;
  unit: string;
  /** null = 成本待补（只允许首次录入的现有食材）。 */
  costSen: Sen | null;
  /** existing：首次录入的现有食材，不产生支出；purchase：新进货，已生成一笔进货支出。 */
  origin: 'existing' | 'purchase';
  purchaseExpenseId: string | null;
  purchasedDate: string | null;
  paid: boolean | null;
  status: BatchStatus;
  startedAtMs: number | null;
  endedAtMs: number | null;
  wastageQuantity: number | null;
  endNote: string;
  note: string;
  createdAtMs: number;
  updatedAtMs: number;
  voidReason?: string;
}

export const BATCH_STATUS_ZH: Record<BatchStatus, string> = { stocked: '库存待启用', in_use: '使用中', finished: '已用完', voided: '已作废' };

export interface BatchPeriod {
  state: 'not_started' | 'running' | 'complete';
  /** 实际使用天数（起止时间差，可带小数）。 */
  days: number | null;
  /** 周期平均每日成本：只在已用完且成本已知时给出。 */
  avgDailySen: Sen | null;
  costPending: boolean;
}

/** 批次周期：只能得出周期平均值；正在使用的批次不提前给最终日成本。 */
export function batchPeriod(b: Pick<BatchDoc, 'status' | 'startedAtMs' | 'endedAtMs' | 'costSen'>, nowMs?: number): BatchPeriod {
  const costPending = b.costSen === null;
  if (b.startedAtMs === null || b.status === 'stocked') return { state: 'not_started', days: null, avgDailySen: null, costPending };
  if (b.status !== 'finished' || b.endedAtMs === null) {
    return { state: 'running', days: nowMs === undefined ? null : Math.max(0, (nowMs - b.startedAtMs) / DAY_MS), avgDailySen: null, costPending };
  }
  const span = Math.max(1, b.endedAtMs - b.startedAtMs);
  return { state: 'complete', days: span / DAY_MS, avgDailySen: costPending ? null : Math.round((b.costSen! * DAY_MS) / span), costPending };
}

export const formatDays = (d: number | null) => (d === null ? '—' : `${d >= 10 ? Math.round(d) : Math.round(d * 10) / 10} 天`);

export interface ConsumptionInRange {
  /** 已核算的消耗成本（已用完、成本已知的批次，按时间重叠比例平均摊入）。 */
  costSen: Sen;
  completeBatches: number;
  /** 与区间重叠但尚不能核算的批次（仍在用 / 成本待补）。 */
  pendingBatches: number;
}

/** 区间内的食材消耗成本。只用批次起止时间做平均，不推算逐日实际用量。 */
export function consumptionInRange(batches: BatchDoc[], startMs: number, endMs: number, nowMs: number): ConsumptionInRange {
  let cost = 0, complete = 0, pending = 0;
  for (const b of batches) {
    if (b.status === 'voided' || b.status === 'stocked' || b.startedAtMs === null) continue;
    const bEnd = b.status === 'finished' && b.endedAtMs !== null ? b.endedAtMs : nowMs;
    if (b.startedAtMs >= endMs || bEnd <= startMs) continue;
    if (b.status !== 'finished' || b.endedAtMs === null || b.costSen === null) { pending++; continue; }
    const span = Math.max(1, b.endedAtMs - b.startedAtMs);
    const overlap = Math.min(endMs, b.endedAtMs) - Math.max(startMs, b.startedAtMs);
    cost += (b.costSen * overlap) / span;
    complete++;
  }
  return { costSen: Math.round(cost), completeBatches: complete, pendingBatches: pending };
}

/**
 * 成本核算范围：老板确认哪些食材必须有批次记录，经营利润才算「核算完整」。
 * 实际启用过（有批次）的食材自动纳入；预置但从未使用的食材不强制录入，但未确认范围前不能宣称完整。
 */
export interface CostCoverage {
  requiredIngredientIds: string[];
  /** null = 老板尚未确认范围。 */
  confirmedAtMs: number | null;
}

/** 建议的必需食材（按现有菜单配方的主料与配料，只是建议，需老板确认）。 */
export const RECIPE_SUGGESTED_INGREDIENTS = ['ing-thin-noodle', 'ing-mee-poh', 'ing-minced-pork', 'ing-wanton-skin', 'ing-char-siew', 'ing-scallion', 'ing-lard-crisp'];
export const DEFAULT_COST_COVERAGE: CostCoverage = { requiredIngredientIds: RECIPE_SUGGESTED_INGREDIENTS, confirmedAtMs: null };

export type IngredientCoverageState = 'covered' | 'missing' | 'gap' | 'running' | 'cost_unknown';
export const COVERAGE_STATE_ZH: Record<IngredientCoverageState, string> = {
  covered: '已覆盖', missing: '没有批次记录', gap: '区间内有记录缺口', running: '批次仍在使用', cost_unknown: '成本待补',
};

export interface CoverageResult extends ConsumptionInRange {
  /** complete：范围已确认且每种必需食材在整个区间都由已用完、成本已知的批次连续覆盖。 */
  state: 'complete' | 'incomplete' | 'unconfirmed';
  required: { ingredientId: string; name: string; state: IngredientCoverageState }[];
  reasons: string[];
}

/** 区间的成本覆盖。即使 complete，得到的也只是批次周期平均分摊，不是逐日真实用量。 */
export function coverageInRange(batches: BatchDoc[], coverage: CostCoverage, startMs: number, endMs: number, nowMs: number): CoverageResult {
  const consumption = consumptionInRange(batches, startMs, endMs, nowMs);
  const live = batches.filter((b) => b.status !== 'voided' && b.status !== 'stocked' && b.startedAtMs !== null);
  const enabled = new Set(live.filter((b) => b.startedAtMs! < endMs).map((b) => b.ingredientId));
  const ids = [...new Set([...coverage.requiredIngredientIds, ...enabled])];
  const nameOf = (id: string) => live.find((b) => b.ingredientId === id)?.ingredientName ?? BUILT_IN_BY_ID.get(id)?.name ?? id;
  const required = ids.map((id) => {
    const own = live.filter((b) => b.ingredientId === id);
    const spans = own.map((b) => ({ b, s: b.startedAtMs!, e: b.status === 'finished' && b.endedAtMs !== null ? b.endedAtMs : Infinity }))
      .filter((x) => x.s < endMs && x.e > startMs).sort((a, b) => a.s - b.s);
    let state: IngredientCoverageState;
    if (!spans.length) state = 'missing';
    else {
      let cursor = startMs;
      for (const x of spans) if (x.s <= cursor) cursor = Math.max(cursor, x.e);
      if (cursor < endMs) state = 'gap';
      else if (spans.some((x) => x.e === Infinity)) state = 'running';
      else if (spans.some((x) => x.b.costSen === null)) state = 'cost_unknown';
      else state = 'covered';
    }
    return { ingredientId: id, name: nameOf(id), state };
  });
  const bad = required.filter((r) => r.state !== 'covered');
  const reasons = [
    ...(coverage.confirmedAtMs === null ? ['成本核算范围尚未确认'] : []),
    ...bad.map((r) => `${r.name}：${COVERAGE_STATE_ZH[r.state]}`),
  ];
  const state = coverage.confirmedAtMs === null ? 'unconfirmed' : bad.length || !required.length ? 'incomplete' : 'complete';
  return { ...consumption, state, required, reasons };
}

/** 换批：被启用的必须是库存批次；旧批只能是在用批次，结束时间不得早于其开始时间。 */
export function validateStartBatch(next: Pick<BatchDoc, 'status' | 'ingredientId'>, startedAtMs: number, previous: { batch: Pick<BatchDoc, 'status' | 'ingredientId' | 'startedAtMs'>; action: 'finished' | 'continue'; endedAtMs: number | null }[]): string | null {
  if (next.status !== 'stocked') return '只有库存中的批次可以启用';
  for (const p of previous) {
    if (p.batch.ingredientId !== next.ingredientId) return '旧批与新批不是同一种食材';
    if (p.batch.status !== 'in_use') return '旧批不在使用中';
    if (p.action === 'finished') {
      const end = p.endedAtMs ?? startedAtMs;
      if (p.batch.startedAtMs !== null && end <= p.batch.startedAtMs) return '旧批结束时间必须晚于它的开始使用时间';
    }
  }
  return null;
}

// ───────────────────────── 日常开支 ─────────────────────────

export type PlanItem = 'rent' | 'fridge_power' | 'wage' | 'gas' | 'misc';
export const PLAN_ITEM_ZH: Record<PlanItem, string> = { rent: '档口租金', fridge_power: '冰箱额外电费', wage: '员工工资', gas: '煤气', misc: '杂费' };
/** 每月固定、每月只能登记一笔的项目。 */
export const RECURRING_ITEMS = ['rent', 'fridge_power'] as const;
export type RecurringItem = (typeof RECURRING_ITEMS)[number];

export interface ExpensePlan {
  /** 起租月份 'YYYY-MM'；未设置时租金应付无法计算（显示待设置）。 */
  rentStartMonth: string | null;
  /** 第 fromMonthIndex 个月（含）起的月租。 */
  rentPhases: { fromMonthIndex: number; monthlySen: Sen }[];
  fridgeMonthlySen: Sen;
  staff: { enabled: boolean; dailyBudgetSen: Sen };
}

export const DEFAULT_EXPENSE_PLAN: ExpensePlan = {
  rentStartMonth: null,
  rentPhases: [{ fromMonthIndex: 1, monthlySen: 80_000 }, { fromMonthIndex: 4, monthlySen: 100_000 }],
  fridgeMonthlySen: 10_000,
  staff: { enabled: false, dailyBudgetSen: 6_000 },
};

/** 起租后的第几个月（起租月 = 1）；起租前或未设置返回 null。 */
export function rentMonthIndex(plan: Pick<ExpensePlan, 'rentStartMonth'>, month: string): number | null {
  if (!plan.rentStartMonth) return null;
  const i = monthDiff(plan.rentStartMonth, month) + 1;
  return i >= 1 ? i : null;
}

/** 该月租金：未设置起租月 → null；起租前 → 0。 */
export function rentForMonth(plan: Pick<ExpensePlan, 'rentStartMonth' | 'rentPhases'>, month: string): Sen | null {
  if (!plan.rentStartMonth) return null;
  const i = rentMonthIndex(plan, month);
  if (i === null) return 0;
  let sen = 0;
  for (const p of [...plan.rentPhases].sort((a, b) => a.fromMonthIndex - b.fromMonthIndex)) if (i >= p.fromMonthIndex) sen = p.monthlySen;
  return sen;
}

/** 该月固定费用（租金 + 冰箱电费）；起租前为 0，未设置起租月为 null。 */
export function fixedMonthlyForMonth(plan: ExpensePlan, month: string): Sen | null {
  const rent = rentForMonth(plan, month);
  if (rent === null) return null;
  return rentMonthIndex(plan, month) === null ? 0 : rent + plan.fridgeMonthlySen;
}

/** 日结与经营视角的固定费用摊销计划（写入 config/finance.fixedCostPolicy.schedule）。 */
export function scheduleFromPlan(plan: ExpensePlan) {
  return plan.rentStartMonth ? { rentStartMonth: plan.rentStartMonth, rentPhases: plan.rentPhases, extraMonthlySen: plan.fridgeMonthlySen } : null;
}

/** 账本支出（与 ledger.ExpenseDoc 同形，含本次新增的可选字段）。 */
export interface PlanExpense {
  id: string;
  category: 'purchase' | 'fixed_payment' | 'opex' | 'capital';
  description: string;
  amountSen: Sen;
  paidSen: Sen;
  businessDate: string;
  accrualDate: string;
  status: 'active' | 'voided';
  planItem?: PlanItem | null;
  periodMonth?: string | null;
  ingredientBatchId?: string | null;
  /** 补付款记录：amountSen=0、paidSen=本次付款，关联原支出。 */
  settlesExpenseId?: string | null;
  workDays?: number | null;
}

export interface MonthlyPlanRow {
  item: PlanItem;
  /** 预算：租金按阶段、电费固定、工资按日薪 × 天数（只是参考）。 */
  budgetSen: Sen | null;
  /** 开档成本里已付的同月租金（避免重复计费）。 */
  coveredByStartupSen: Sen;
  /** 应付 = 预算 − 开档已覆盖；工资、煤气、杂费按实际，不产生应付。 */
  dueSen: Sen | null;
  paidSen: Sen;
  /** 实际发生（煤气、杂费、工资按归属月）。 */
  actualSen: Sen;
  outstandingSen: Sen;
  /** 其中由旧付款确认归属抵扣的金额。 */
  linkedSen: Sen;
  state: 'unset' | 'not_started' | 'due' | 'paid' | 'covered' | 'actual' | 'disabled';
  payments: PlanExpense[];
}

export const isSettlement = (e: PlanExpense) => Boolean(e.settlesExpenseId);

/**
 * 老板对已有支出的归属确认（不改原支出、不产生新现金流，原付款日、金额、来源与已关账快照都不变）：
 * - recurring：旧版未分类的房租 / 电费付款归入某月的月租或冰箱电费（可部分抵扣）。
 * - startup：这笔付款就是某个开档项目的付款（已在回本目标内，不再按经营支出扣）。
 * - later_capital：开档之后的资本投入（不算经营支出，单独列示）。
 * 取消关联只把状态改为 cancelled，保留记录。
 */
export type ExpenseLink =
  | { linkId: string; kind: 'recurring'; item: RecurringItem; month: string; amountSen: Sen; status: 'active' | 'cancelled' }
  | { linkId: string; kind: 'startup'; startupId: string; amountSen: Sen; status: 'active' | 'cancelled' }
  | { linkId: string; kind: 'later_capital'; amountSen: Sen; status: 'active' | 'cancelled' };
export type NewExpenseLink = ExpenseLink extends infer L ? (L extends ExpenseLink ? Omit<L, 'linkId' | 'status'> : never) : never;

export interface ExpenseLinkDoc {
  expenseId: string;
  links: ExpenseLink[];
}

export const LINK_KIND_ZH: Record<ExpenseLink['kind'], string> = { recurring: '月租 / 电费', startup: '开档项目', later_capital: '后续资本投入' };

const activeLinksFor = (links: ExpenseLinkDoc[], expenseId: string) => links.filter((d) => d.expenseId === expenseId).flatMap((d) => d.links).filter((l) => l.status === 'active');

/** 已归属为月租 / 电费或开档项目的金额：这部分不再是营业费用（原现金付款照旧）。 */
export function reattributedSen(expenseId: string, links: ExpenseLinkDoc[]): Sen {
  return activeLinksFor(links, expenseId).filter((l) => l.kind === 'recurring' || l.kind === 'startup').reduce((s, l) => s + l.amountSen, 0);
}

/** 营业费用（opex）计入经营成本的金额：扣除已归属到月租 / 电费 / 开档项目的部分（全部、部分或取消关联都按当前有效关联计算）。 */
export function opexAccrualSen(e: { id: string; amountSen: Sen }, links: ExpenseLinkDoc[]): Sen {
  return Math.max(0, e.amountSen - reattributedSen(e.id, links));
}

/** 关联前校验（前端提示与服务端命令共用）。 */
export function validateExpenseLink(c: {
  expense: PlanExpense; settledSen: Sen; existing: ExpenseLink[]; link: NewExpenseLink; monthOutstandingSen?: Sen; startupRemainingSen?: Sen;
}): string | null {
  const e = c.expense;
  if (e.status !== 'active' || e.settlesExpenseId) return '只有有效的原支出可以关联';
  if (e.ingredientBatchId) return '食材进货的支出不能关联到其他项目';
  if (e.planItem) return '这笔支出已经属于新版日常开支项目，不需要再关联';
  if (c.link.amountSen <= 0) return '关联金额必须大于 0';
  const active = c.existing.filter((l) => l.status === 'active');
  if (c.link.kind === 'later_capital' && e.category !== 'capital') return '只有资本支出可以标为后续资本投入';
  if (c.link.kind === 'recurring') {
    if (e.category !== 'fixed_payment' && e.category !== 'opex') return '只有固定费用或营业费用付款可以归入月租 / 电费';
    const l = c.link;
    if (active.some((x) => x.kind === 'recurring' && x.item === l.item && x.month === l.month)) return '这笔付款已关联到同一项目和月份';
  }
  const cap = e.category === 'capital' ? e.amountSen : e.paidSen + c.settledSen;
  const left = cap - active.reduce((s, x) => s + x.amountSen, 0);
  if (c.link.amountSen > left) return `超过这笔支出可关联的金额（剩余 ${formatRM(Math.max(0, left))}）`;
  if (c.link.kind === 'recurring') {
    if (c.monthOutstandingSen === undefined) return '无法计算该月应付';
    if (c.link.amountSen > c.monthOutstandingSen) return `超过该月剩余应付（${formatRM(c.monthOutstandingSen)}），不能重复抵扣`;
  }
  if (c.link.kind === 'startup' && (c.startupRemainingSen === undefined || c.link.amountSen > c.startupRemainingSen)) {
    return `超过开档项目剩余可关联金额（${formatRM(Math.max(0, c.startupRemainingSen ?? 0))}）`;
  }
  return null;
}

export interface ExpenseClassification {
  /** 真实现金支出合计（含资本、开档关联），不因分类而消失。 */
  totalPaidSen: Sen;
  operatingPaidSen: Sen;
  operatingOutstandingSen: Sen;
  startupLinkedSen: Sen;
  laterCapitalSen: Sen;
  unclassifiedCapital: { expense: PlanExpense; sen: Sen }[];
  /** 旧版固定费用付款中尚未确认归属的部分。 */
  legacyUnlinked: { expense: PlanExpense; sen: Sen }[];
}

/** 把支出分为经营支出、开档投入（关联）、后续资本投入；资本支出与开档关联的部分不进经营支出。 */
export function classifyExpenses(expenses: PlanExpense[], links: ExpenseLinkDoc[] = []): ExpenseClassification {
  const active = expenses.filter((e) => e.status === 'active');
  const r: ExpenseClassification = { totalPaidSen: 0, operatingPaidSen: 0, operatingOutstandingSen: 0, startupLinkedSen: 0, laterCapitalSen: 0, unclassifiedCapital: [], legacyUnlinked: [] };
  for (const e of active.filter((x) => !isSettlement(x))) {
    const paid = e.paidSen + settledFor(e.id, active);
    const outstanding = Math.max(0, e.amountSen - paid);
    const ls = activeLinksFor(links, e.id);
    const sum = (k: ExpenseLink['kind']) => ls.filter((l) => l.kind === k).reduce((s, l) => s + l.amountSen, 0);
    const startup = sum('startup'), later = sum('later_capital'), recurring = sum('recurring');
    r.totalPaidSen += paid;
    r.startupLinkedSen += startup;
    r.laterCapitalSen += later;
    if (e.category === 'capital') {
      const left = e.amountSen - startup - later;
      if (left > 0) r.unclassifiedCapital.push({ expense: e, sen: left });
      continue;
    }
    const excluded = startup + later;
    r.operatingPaidSen += paid - Math.min(paid, excluded);
    r.operatingOutstandingSen += Math.max(0, outstanding - Math.max(0, excluded - paid));
    if (e.category === 'fixed_payment' && !e.planItem) {
      const left = paid - recurring - excluded;
      if (left > 0) r.legacyUnlinked.push({ expense: e, sen: left });
    }
  }
  return r;
}

/** 某月五项日常开支的预算、应付、已付。links：老板确认归属到该月的旧付款（只算有效支出上的有效关联）。 */
export function monthlyPlanRows(plan: ExpensePlan, month: string, expenses: PlanExpense[], startupRentByMonth: Record<string, Sen>, links: ExpenseLinkDoc[] = []): MonthlyPlanRow[] {
  const active = expenses.filter((e) => e.status === 'active');
  const activeIds = new Set(active.map((e) => e.id));
  const rows: MonthlyPlanRow[] = [];
  for (const item of RECURRING_ITEMS) {
    const payments = active.filter((e) => e.planItem === item && e.periodMonth === month && !isSettlement(e));
    const linkedSen = links.filter((d) => activeIds.has(d.expenseId)).flatMap((d) => d.links)
      .filter((l) => l.status === 'active' && l.kind === 'recurring' && l.item === item && l.month === month).reduce((s, l) => s + l.amountSen, 0);
    const paidSen = payments.reduce((s, e) => s + e.paidSen, 0) + linkedSen;
    const started = rentMonthIndex(plan, month) !== null;
    const budget = !plan.rentStartMonth ? null : !started ? 0 : item === 'rent' ? rentForMonth(plan, month)! : plan.fridgeMonthlySen;
    const covered = item === 'rent' ? Math.min(budget ?? 0, startupRentByMonth[month] ?? 0) : 0;
    const due = budget === null ? null : Math.max(0, budget - covered);
    const outstanding = due === null ? 0 : Math.max(0, due - paidSen);
    const state: MonthlyPlanRow['state'] = budget === null ? 'unset' : !started ? 'not_started' : due === 0 && covered > 0 ? 'covered' : outstanding === 0 ? 'paid' : 'due';
    rows.push({ item, budgetSen: budget, coveredByStartupSen: covered, dueSen: due, paidSen, linkedSen, actualSen: paidSen + covered, outstandingSen: outstanding, state, payments });
  }
  const range = monthRange(month);
  for (const item of ['wage', 'gas', 'misc'] as const) {
    // 旧版未分类的营业费用归入杂费。
    const match = (e: PlanExpense) => (item === 'misc' ? e.planItem === 'misc' || (!e.planItem && e.category === 'opex') : e.planItem === item);
    // 已归属到月租 / 电费 / 开档项目的部分不再算作这一项（例如旧版把房租记成营业费用）。
    const remaining = (e: PlanExpense) => opexAccrualSen(e, links);
    const payments = active.filter((e) => match(e) && !isSettlement(e) && e.accrualDate >= range.start && e.accrualDate < range.endExclusive && remaining(e) > 0);
    const actual = payments.reduce((s, e) => s + remaining(e), 0);
    const paid = payments.reduce((s, e) => s + Math.min(remaining(e), Math.max(0, e.paidSen + settledFor(e.id, active) - reattributedSen(e.id, links))), 0);
    const budget = item === 'wage' ? (plan.staff.enabled ? plan.staff.dailyBudgetSen : null) : null;
    rows.push({
      item, budgetSen: budget, coveredByStartupSen: 0, dueSen: null, paidSen: paid, linkedSen: 0, actualSen: actual, outstandingSen: Math.max(0, actual - paid),
      state: item === 'wage' && !plan.staff.enabled && actual === 0 ? 'disabled' : 'actual', payments,
    });
  }
  return rows;
}

function settledFor(id: string, active: PlanExpense[]): Sen {
  return active.filter((s) => s.settlesExpenseId === id).reduce((t, s) => t + s.paidSen, 0);
}

/** 未付清的支出（含补付款后剩余）：用于回本口径扣除与「待付」提醒。 */
export function unpaidExpenses(expenses: PlanExpense[]): { expense: PlanExpense; outstandingSen: Sen }[] {
  const active = expenses.filter((e) => e.status === 'active');
  return active
    .filter((e) => !isSettlement(e))
    .map((e) => ({ expense: e, outstandingSen: e.amountSen - e.paidSen - settledFor(e.id, active) }))
    .filter((x) => x.outstandingSen > 0);
}

// ───────────────────────── 开档成本 ─────────────────────────

export type StartupGroup = 'rent_deposit' | 'vaccine' | 'kitchenware' | 'training' | 'supplier_debt' | 'signboard' | 'other';
export const STARTUP_GROUP_ZH: Record<StartupGroup, string> = {
  rent_deposit: '租金与押金', vaccine: '疫苗', kitchenware: '厨具与杂货', training: '培训', supplier_debt: '供应商欠账', signboard: '广告牌', other: '其他',
};
export type StartupPayment = 'paid' | 'unpaid' | 'unverified';
export const STARTUP_PAYMENT_ZH: Record<StartupPayment, string> = { paid: '已付', unpaid: '待付', unverified: '付款待核实' };

export interface StartupCostDoc {
  id: string;
  group: StartupGroup;
  title: string;
  amountSen: Sen;
  /** 明细（可空）；有明细时合计必须等于金额。 */
  details: { label: string; amountSen: Sen }[];
  paymentStatus: StartupPayment;
  paidDate: string | null;
  /** 供应商欠账：已计入总投入，清还时只改状态。 */
  isDebt: boolean;
  /** 租金与押金拆分（仅 rent_deposit）；null = 尚未拆分。 */
  rentSen: Sen | null;
  depositSen: Sen | null;
  /** 开档租金覆盖的月份：该月月租应付相应扣减，避免重复计费。 */
  rentMonth: string | null;
  note: string;
  status: 'active' | 'voided';
  correctionOf: string | null;
  seedKey: string | null;
  createdAtMs: number;
  voidReason?: string;
  /** 老板确认属于这一项的付款（expenseLinks 的镜像，用于防止超额关联）。 */
  linkedExpenses?: { linkId: string; expenseId: string; amountSen: Sen; status: 'active' | 'cancelled' | 'migrated'; migratedTo?: string; migratedFrom?: string }[];
}

/** 老板提供的开档清单（2026-10-25）。除供应商欠账外付款状态未核实，不假设已付。 */
export const STARTUP_SEED: Omit<StartupCostDoc, 'id' | 'createdAtMs' | 'status' | 'correctionOf' | 'paidDate'>[] = [
  { seedKey: 'rent-deposit', group: 'rent_deposit', title: '档口租金和押金', amountSen: 110_000, details: [], paymentStatus: 'unverified', isDebt: false, rentSen: null, depositSen: null, rentMonth: null, note: '租金与押金尚待拆分' },
  { seedKey: 'vaccine', group: 'vaccine', title: '疫苗', amountSen: 10_000, details: [], paymentStatus: 'unverified', isDebt: false, rentSen: null, depositSen: null, rentMonth: null, note: '' },
  {
    seedKey: 'kitchenware', group: 'kitchenware', title: '厨具和杂货', amountSen: 304_440,
    details: [56_740, 209_400, 28_780, 2_930, 1_775, 1_315, 3_500].map((amountSen, i) => ({ label: `第 ${i + 1} 笔`, amountSen })),
    paymentStatus: 'unverified', isDebt: false, rentSen: null, depositSen: null, rentMonth: null, note: '',
  },
  { seedKey: 'training', group: 'training', title: '培训', amountSen: 5_000, details: [], paymentStatus: 'unverified', isDebt: false, rentSen: null, depositSen: null, rentMonth: null, note: '' },
  { seedKey: 'supplier-debt', group: 'supplier_debt', title: '供应商欠账', amountSen: 33_652, details: [], paymentStatus: 'unpaid', isDebt: true, rentSen: null, depositSen: null, rentMonth: null, note: '已计入总投入，清还时只更新状态' },
  { seedKey: 'signboard', group: 'signboard', title: '广告牌', amountSen: 46_000, details: [], paymentStatus: 'unverified', isDebt: false, rentSen: null, depositSen: null, rentMonth: null, note: '' },
];

export const startupSeedId = (seedKey: string) => `startup-seed-${seedKey}`;

export interface StartupSummary {
  totalSen: Sen;
  paidSen: Sen;
  unpaidSen: Sen;
  unverifiedSen: Sen;
  count: number;
  depositSen: Sen;
  unsplitRentDepositSen: Sen;
  byGroup: { group: StartupGroup; sen: Sen }[];
  rentByMonth: Record<string, Sen>;
}

export function startupSummary(items: StartupCostDoc[]): StartupSummary {
  const active = items.filter((i) => i.status === 'active');
  const sum = (f: (i: StartupCostDoc) => boolean) => active.filter(f).reduce((s, i) => s + i.amountSen, 0);
  const byGroup = new Map<StartupGroup, Sen>();
  const rentByMonth: Record<string, Sen> = {};
  for (const i of active) {
    byGroup.set(i.group, (byGroup.get(i.group) ?? 0) + i.amountSen);
    // 只有已付的开档租金才能抵扣同月月租。
    if (i.rentMonth && i.rentSen && i.paymentStatus === 'paid') rentByMonth[i.rentMonth] = (rentByMonth[i.rentMonth] ?? 0) + i.rentSen;
  }
  return {
    totalSen: sum(() => true), paidSen: sum((i) => i.paymentStatus === 'paid'), unpaidSen: sum((i) => i.paymentStatus === 'unpaid'),
    unverifiedSen: sum((i) => i.paymentStatus === 'unverified'), count: active.length,
    depositSen: active.reduce((s, i) => s + (i.depositSen ?? 0), 0),
    unsplitRentDepositSen: sum((i) => i.group === 'rent_deposit' && i.rentSen === null),
    byGroup: [...byGroup].map(([group, sen]) => ({ group, sen })).sort((a, b) => b.sen - a.sen), rentByMonth,
  };
}

export function validateStartupDetails(amountSen: Sen, details: { amountSen: Sen }[]): string | null {
  if (!details.length) return null;
  const s = details.reduce((t, d) => t + d.amountSen, 0);
  return s === amountSen ? null : `明细合计 ${s} 与金额 ${amountSen} 不一致`;
}

// ───────────────────────── 回本 ─────────────────────────

export interface PaybackInput {
  startupTotalSen: Sen;
  /** 累计已登记收款（含误登记更正）。 */
  receiptsSen: Sen;
  refundsSen: Sen;
  expenses: PlanExpense[];
  plan: ExpensePlan;
  startupRentByMonth: Record<string, Sen>;
  /** 今天所在月份：起租月到本月的租金、电费视为已到期。 */
  currentMonth: string;
  links?: ExpenseLinkDoc[];
}

export interface PaybackResult {
  targetSen: Sen;
  receiptsNetSen: Sen;
  paidOperatingSen: Sen;
  /** 已到期未付：未付进货 / 营业费用 + 到期未付的租金、电费。 */
  unpaidOperatingSen: Sen;
  recoveredSen: Sen;
  ratio: number | null;
  barRatio: number;
  remainingSen: Sen;
  state: 'pending' | 'in_progress' | 'achieved';
  /** 待核算原因（空 = 资料足够）。 */
  pendingReasons: string[];
  /** 真实现金支出合计（含资本与开档关联）。 */
  totalPaidSen: Sen;
  /** 关联到开档项目的付款（已在目标内，不扣经营）。 */
  startupLinkedSen: Sen;
  /** 后续资本投入（不算经营支出，未计入回本目标）。 */
  laterCapitalSen: Sen;
}

/** 回本进度：只用真实账目；资料不足（开档成本未录入、未设起租月）时标为待核算。 */
export function paybackStatus(i: PaybackInput): PaybackResult {
  const active = i.expenses.filter((e) => e.status === 'active');
  const links = i.links ?? [];
  const c = classifyExpenses(active, links);
  const paidOperatingSen = c.operatingPaidSen;
  let unpaid = c.operatingOutstandingSen;
  const reasons: string[] = [];
  if (i.startupTotalSen <= 0) reasons.push('开档成本尚未录入');
  if (c.legacyUnlinked.length) reasons.push(`有 ${c.legacyUnlinked.length} 笔旧版固定费用付款（${formatRM(c.legacyUnlinked.reduce((s, x) => s + x.sen, 0))}）未确认归属月份`);
  if (c.unclassifiedCapital.length) reasons.push(`有 ${c.unclassifiedCapital.length} 笔资本支出（${formatRM(c.unclassifiedCapital.reduce((s, x) => s + x.sen, 0))}）未确认是开档投入还是后续资本投入`);
  if (!i.plan.rentStartMonth) reasons.push('未设置起租月份，租金应付无法计算');
  else {
    for (let m = i.plan.rentStartMonth; m <= i.currentMonth; m = addMonths(m, 1)) {
      for (const row of monthlyPlanRows(i.plan, m, active, i.startupRentByMonth, links).filter((r) => r.item === 'rent' || r.item === 'fridge_power')) unpaid += row.outstandingSen;
    }
  }
  const receiptsNetSen = i.receiptsSen - i.refundsSen;
  const recovered = receiptsNetSen - paidOperatingSen - unpaid;
  const target = i.startupTotalSen;
  const ratio = target > 0 ? recovered / target : null;
  const state = reasons.length ? 'pending' : recovered >= target ? 'achieved' : 'in_progress';
  return {
    targetSen: target, receiptsNetSen, paidOperatingSen, unpaidOperatingSen: unpaid, recoveredSen: recovered, ratio,
    barRatio: ratio === null ? 0 : Math.min(1, Math.max(0, ratio)), remainingSen: Math.max(0, target - recovered), state, pendingReasons: reasons,
    totalPaidSen: c.totalPaidSen, startupLinkedSen: c.startupLinkedSen, laterCapitalSen: c.laterCapitalSen,
  };
}

// ───────────────────────── 销量目标 ─────────────────────────

/** 销量暂按「面团粒数」：小 1 粒、中 1½ 粒、大 2 粒，云吞汤不计。以半粒为整数单位，避免小数误差。 */
export type SalesUnit = 'dough_ball';
export const SALES_UNIT_ZH: Record<SalesUnit, string> = { dough_ball: '粒面团' };

export interface SalesTargets {
  unit: SalesUnit;
  dailyBalls: number;
  /** 月目标只保存老板确认过的月份；没有就不显示进度，只给建议值。 */
  monthly: Record<string, number>;
  dailyHistory: { balls: number; atMs: number }[];
}

export const DEFAULT_SALES_TARGETS: SalesTargets = { unit: 'dough_ball', dailyBalls: 50, monthly: {}, dailyHistory: [] };

export interface SalesOrderRow {
  businessDate: string;
  fulfillmentStatus: string;
  items?: { noodleHalfUnits?: number; quantity: number }[];
}

/** 有效（未取消）订单的面团半粒数。 */
export function doughHalfUnits(orders: SalesOrderRow[]): number {
  let half = 0;
  for (const o of orders) {
    if (o.fulfillmentStatus === 'cancelled') continue;
    for (const it of o.items ?? []) half += (it.noodleHalfUnits ?? 0) * it.quantity;
  }
  return half;
}

export const ballsText = (half: number) => (half % 2 === 0 ? String(half / 2) : `${(half - 1) / 2}½`);

/** 月目标建议值：每日目标 × 当月天数（只是建议，不自动保存）。 */
export function suggestedMonthlyBalls(dailyBalls: number, month: string): number {
  return dailyBalls * daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
}

/** 达标后建议的下一个每日目标：50 → 100，之后 +50。 */
export function nextDailyTarget(current: number): number {
  return current < 100 ? 100 : current + 50;
}

export interface GoalDoc {
  id: string;
  title: string;
  targetSen: Sen;
  deadline: string | null;
  note: string;
  status: 'active' | 'achieved' | 'archived';
  order: number;
  createdAtMs: number;
  /** 建立时的现金回本结余；进度 = 当前结余 − 基线。旧文档没有时按 0。 */
  baselineRecoveredSen?: Sen;
  achievedAtMs?: number | null;
  achievedSnapshot?: { progressSen: Sen; recoveredSen: Sen } | null;
  archivedReason?: string | null;
}

/** 后续目标进度：自建立目标起新增的现金回本结余（与第一目标同一口径）。 */
export function goalProgress(g: { baselineRecoveredSen?: Sen; targetSen: Sen }, recoveredSen: Sen) {
  const progressSen = recoveredSen - (g.baselineRecoveredSen ?? 0);
  return { progressSen, ratio: g.targetSen > 0 ? progressSen / g.targetSen : 0, reached: progressSen >= g.targetSen };
}
