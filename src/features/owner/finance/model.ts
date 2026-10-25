/** 由 FinanceData 计算各子页数字（纯函数，口径见 domain/costing）。 */
import {
  addDays, BusinessDayPolicy, businessRangeMs, CoverageResult, coverageInRange, costUnitsToSen, DateRange, datesInRange, doughHalfUnits, fixedCostForRange, inRange,
  monthlyPlanRows, monthOf, opexAccrualSen, paybackStatus, PlanExpense, Sen, startupSummary,
} from '../../../domain';
import type { FinanceData } from './data';

export const sumSen = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

export interface RangeFigures {
  receiptsNetSen: Sen;
  paidOutSen: Sen;
  paidPurchasesSen: Sen;
  paidDailySen: Sen;
  balanceSen: Sen;
  /** 已记录批次的周期平均分摊（可能不完整）。 */
  consumption: { costSen: Sen; completeBatches: number; pendingBatches: number };
  /** 成本覆盖：只有 complete 才给经营利润。 */
  coverage: CoverageResult;
  /** 经营利润（周期平均分摊口径）；成本覆盖未证实完整时为 null。 */
  profitSen: Sen | null;
  /** 理论用量（BOM）暂估的经营利润，只在 profitSen 为 null 时作参考。 */
  estimatedProfitSen: Sen;
  fixedSen: Sen;
  opexSen: Sen;
  fixedFromPlan: boolean;
  balls: number;
}

export function rangeFigures(d: FinanceData, range: DateRange, policy: BusinessDayPolicy, nowMs: number): RangeFigures {
  const pay = d.payments.filter((p) => inRange(p.businessDate, range));
  const ref = d.refunds.filter((r) => inRange(r.businessDate, range));
  const receiptsNetSen = sumSen(pay, (p) => p.amountSen) - sumSen(ref, (r) => r.amountSen);
  const active = d.expenses.filter((e) => e.status === 'active');
  const paidIn = active.filter((e) => inRange(e.businessDate, range));
  const paidPurchasesSen = sumSen(paidIn.filter((e) => e.category === 'purchase'), (e) => e.paidSen);
  const paidOutSen = sumSen(paidIn, (e) => e.paidSen);
  const { startMs, endMs } = businessRangeMs(range, policy);
  const coverage = coverageInRange(d.batches, d.coverage, startMs, endMs, nowMs);
  const consumption = { costSen: coverage.costSen, completeBatches: coverage.completeBatches, pendingBatches: coverage.pendingBatches };
  const fixedSen = fixedCostForRange(d.fixedPolicy, range);
  // 营业费用扣除已归属到月租 / 电费 / 开档项目的部分，避免与固定费用摊销重复。
  const opexSen = sumSen(active.filter((e) => e.category === 'opex' && inRange(e.accrualDate, range)), (e) => opexAccrualSen(e, d.links));
  const bomUnits = sumSen(d.costEvents.filter((c) => inRange(c.businessDate, range)), (c) => c.costUnits)
    + sumSen(d.wastage.filter((w) => w.status === 'active' && !w.alreadyAllocated && inRange(w.businessDate, range)), (w) => w.costUnits);
  const complete = coverage.state === 'complete';
  return {
    receiptsNetSen, paidOutSen, paidPurchasesSen, paidDailySen: paidOutSen - paidPurchasesSen, balanceSen: receiptsNetSen - paidOutSen, consumption, coverage,
    profitSen: complete ? receiptsNetSen - consumption.costSen - fixedSen - opexSen : null,
    estimatedProfitSen: receiptsNetSen - costUnitsToSen(bomUnits) - fixedSen - opexSen,
    fixedSen, opexSen, fixedFromPlan: Boolean(d.fixedPolicy.schedule),
    balls: doughHalfUnits(d.orders.filter((o) => inRange(o.businessDate, range))),
  };
}

export function dailySeries(d: FinanceData, range: DateRange) {
  const active = d.expenses.filter((e) => e.status === 'active');
  return datesInRange(range).map((date) => ({
    date,
    inSen: sumSen(d.payments.filter((p) => p.businessDate === date), (p) => p.amountSen) - sumSen(d.refunds.filter((r) => r.businessDate === date), (r) => r.amountSen),
    outSen: sumSen(active.filter((e) => e.businessDate === date), (e) => e.paidSen),
  }));
}

export function payback(d: FinanceData, today: string) {
  const startup = startupSummary(d.startup);
  return {
    startup,
    result: paybackStatus({
      startupTotalSen: startup.totalSen, receiptsSen: sumSen(d.payments, (p) => p.amountSen), refundsSen: sumSen(d.refunds, (r) => r.amountSen),
      expenses: d.expenses as PlanExpense[], plan: d.plan, startupRentByMonth: startup.rentByMonth, currentMonth: monthOf(today), links: d.links,
    }),
  };
}

export function planRows(d: FinanceData, month: string) {
  return monthlyPlanRows(d.plan, month, d.expenses as PlanExpense[], startupSummary(d.startup).rentByMonth, d.links);
}

export function last7(today: string): DateRange {
  return { start: addDays(today, -6), endExclusive: addDays(today, 1) };
}
