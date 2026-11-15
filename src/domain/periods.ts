/**
 * 最近 7 天 / 近 30 天的生意（2026-11-14，今天页）：收入、估算利润、单数碗数粒面、日均、最好的一天、卖最多、和前一段比。
 * - 口径和今天页同一套：收入、利润按 summarizePeriod（已登记收款；理论材料成本；租金电费按日历日摊，休息日也算）。
 * - 开档前的日子不算：区间起点不早于第一笔收款 / 订单那天（firstDay），否则开档前的租金会把利润拉成负数。
 * - 和前一段比：前一段完整时比总额；前一段只开了一部分（刚开档）时比日均，免得拿 3 天去比 7 天。
 * - 工钱（2026-11-15）：按成本页填的请人工钱扣（domain/labor）；账目里记的工资付款在有人的日子加回（wageOverlap），不重复扣。
 */
import { addDays, DateRange, datesInRange, inRange } from './businessDay';
import { DEFAULT_FIXED_COST, FixedCostPolicy, LedgerEvent, summarizePeriod } from './finance';
import type { Sen } from './money';
import { DishUsage, materialUsage, UsageOrder } from './usage';
import { EMPTY_LABOR, LaborPlan, laborForDate } from './labor';

export type DatedOrder = UsageOrder & { businessDate: string };

export interface DayFigure { date: string; netSen: Sen; profitSen: Sen; orders: number; bowls: number; noodleHalf: number; open: boolean }

export interface PeriodFigures {
  /** 实际统计的区间（已按开档日截掉）。 */
  range: DateRange;
  /** 想看的天数（7 / 30）；clipped 表示开档还不到这么多天。 */
  wantDays: number;
  clipped: boolean;
  days: DayFigure[];
  netSen: Sen;
  profitSen: Sen;
  /** 区间内扣掉的工钱。 */
  laborSen: Sen;
  orders: number;
  bowls: number;
  noodleHalf: number;
  /** 有订单或有收款的天数。 */
  openDays: number;
  avgNetSen: Sen | null;
  best: DayFigure | null;
  topDish: DishUsage | null;
  compare: { kind: 'total' | 'avg'; deltaSen: Sen; baseSen: Sen } | null;
}

const touches = (e: LedgerEvent, r: DateRange) => inRange(e.businessDate, r) || (e.kind === 'expense' && inRange(e.accrualDate, r));

/** 截至 end（含）的 n 天；firstDay 之前的日子截掉。整段都在开档前时返回 null。 */
export function periodRange(end: string, n: number, firstDay: string | null): { range: DateRange; clipped: boolean } | null {
  const full: DateRange = { start: addDays(end, -(n - 1)), endExclusive: addDays(end, 1) };
  if (!firstDay || firstDay <= full.start) return { range: full, clipped: false };
  if (firstDay >= full.endExclusive) return null;
  return { range: { start: firstDay, endExclusive: full.endExclusive }, clipped: true };
}

type Wage = { labor: LaborPlan; overlap: (range: DateRange) => Sen };

function sumUp(events: LedgerEvent[], orders: DatedOrder[], range: DateRange, fixed: FixedCostPolicy, wage: Wage) {
  const ev = events.filter((e) => touches(e, range));
  let laborSen = 0;
  const days: DayFigure[] = datesInRange(range).map((date) => {
    const day = { start: date, endExclusive: addDays(date, 1) };
    const s = summarizePeriod(ev, day, fixed);
    const u = materialUsage(orders.filter((o) => o.businessDate === date));
    const open = u.orders > 0 || s.netReceiptsSen !== 0;
    const labor = laborForDate(wage.labor, date, open).totalSen;
    laborSen += labor;
    return { date, netSen: s.netReceiptsSen, profitSen: s.estimatedProfitSen - labor + wage.overlap(day), orders: u.orders, bowls: u.bowls, noodleHalf: u.noodleHalf, open };
  });
  const total = summarizePeriod(ev, range, fixed);
  const openDays = days.filter((d) => d.open).length;
  return { days, total, openDays, laborSen, profitSen: total.estimatedProfitSen - laborSen + wage.overlap(range) };
}

/**
 * events：整段账本事件（至少覆盖本段和前一段）；orders：本段订单（带营业日）。
 */
export function periodFigures(input: {
  events: LedgerEvent[]; orders: DatedOrder[]; end: string; days: number; firstDay: string | null; fixed?: FixedCostPolicy;
  /** 请人工钱与账目里重复的工资付款（见 domain/labor）。省略 = 不扣工钱。 */
  labor?: LaborPlan; wageOverlap?: (range: DateRange) => Sen;
}): PeriodFigures | null {
  const fixed = input.fixed ?? DEFAULT_FIXED_COST;
  const wage: Wage = { labor: input.labor ?? EMPTY_LABOR, overlap: input.wageOverlap ?? (() => 0) };
  const pr = periodRange(input.end, input.days, input.firstDay);
  if (!pr) return null;
  const { range, clipped } = pr;
  const inPeriod = input.orders.filter((o) => inRange(o.businessDate, range));
  const { days, total, openDays, laborSen, profitSen } = sumUp(input.events, inPeriod, range, fixed, wage);
  const usage = materialUsage(inPeriod);
  const best = days.filter((d) => d.open).reduce<DayFigure | null>((m, d) => (!m || d.netSen > m.netSen ? d : m), null);
  const avgNetSen = openDays ? Math.round(total.netReceiptsSen / openDays) : null;

  // 前一段：紧挨着的前 n 天（同样按开档日截）。只看收款，不需要订单。
  let compare: PeriodFigures['compare'] = null;
  const prevEnd = addDays(range.start, -1);
  const prev = clipped ? null : periodRange(prevEnd, input.days, input.firstDay);
  if (prev) {
    const ev = input.events.filter((e) => touches(e, prev.range));
    const prevOpen = datesInRange(prev.range).filter((date) => summarizePeriod(ev, { start: date, endExclusive: addDays(date, 1) }, fixed).netReceiptsSen !== 0).length;
    const prevNet = summarizePeriod(ev, prev.range, fixed).netReceiptsSen;
    if (prevOpen > 0 && prevNet > 0) {
      compare = prev.clipped
        ? (avgNetSen === null ? null : { kind: 'avg', deltaSen: avgNetSen - Math.round(prevNet / prevOpen), baseSen: Math.round(prevNet / prevOpen) })
        : { kind: 'total', deltaSen: total.netReceiptsSen - prevNet, baseSen: prevNet };
    }
  }

  return {
    range, wantDays: input.days, clipped, days,
    netSen: total.netReceiptsSen, profitSen, laborSen,
    orders: usage.orders, bowls: usage.bowls, noodleHalf: usage.noodleHalf,
    openDays, avgNetSen, best, topDish: usage.byDish[0] ?? null, compare,
  };
}

/** 开档日：最早一笔收款或订单的营业日。没有任何记录时为 null。 */
export function firstBusinessDay(dates: Iterable<string>): string | null {
  let min: string | null = null;
  for (const d of dates) if (d && (min === null || d < min)) min = d;
  return min;
}
