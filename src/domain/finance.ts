/**
 * 老板财务口径（管理估算，非审计净利润）。两本视角分开，避免进货与 BOM 重复扣：
 * - 经营视角：净收款 − 已分配理论成本 − 未重复的损耗 − 固定费用摊销 − 其他营业费用。
 * - 现金视角：实收 − 实退 − 已付进货 − 已付营业费用（含房租付款），不再扣 BOM/摊销。
 * 每个事件按「自己的」营业日筛选：退款属于退款日，订单留在销售日；跨日补登记的收款属于登记日。
 * 新收款不分渠道（unspecified）：只汇总「已登记收款」，不推算现金/QR 拆分或钱箱应有；
 * cash / qr_manual 只来自旧记录，单独列出供历史对照。收入数字是人工登记，不是钱包或银行自动核对。
 */
import { DateRange, datesInRange, daysInMonth, inRange } from './businessDay';
import { costUnitsToSen, CostUnits, Sen } from './money';
import type { PaymentMethod } from './payment';

export interface FixedCostPolicy {
  mode: 'calendar_day';
  monthlySen: Sen;
  /**
   * 日常开支计划（租金阶段 + 冰箱电费）。设置起租月后按月取额：起租前为 0，之后按阶段租金 + 额外固定费用；
   * 未设置时沿用 monthlySen。已冻结的日结快照不受影响。
   */
  schedule?: { rentStartMonth: string; rentPhases: { fromMonthIndex: number; monthlySen: Sen }[]; extraMonthlySen: Sen } | null;
}

export const DEFAULT_FIXED_COST: FixedCostPolicy = { mode: 'calendar_day', monthlySen: 90_000 };

/** 当月逐日分摊（含休息日），余数从月初逐日 +1 sen，总和严格等于月额。 */
export function allocateMonthlyFixedCost(monthlySen: Sen, year: number, month: number): Sen[] {
  const days = daysInMonth(year, month);
  const base = Math.floor(monthlySen / days);
  const remainder = monthlySen - base * days;
  return Array.from({ length: days }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** 某月的固定费用总额。 */
export function monthlyFixedSen(policy: FixedCostPolicy, year: number, month: number): Sen {
  const s = policy.schedule;
  if (!s) return policy.monthlySen;
  const [sy, sm] = s.rentStartMonth.split('-').map(Number);
  const index = (year - sy) * 12 + (month - sm) + 1;
  if (index < 1) return 0;
  let rent = 0;
  for (const p of [...s.rentPhases].sort((a, b) => a.fromMonthIndex - b.fromMonthIndex)) if (index >= p.fromMonthIndex) rent = p.monthlySen;
  return rent + s.extraMonthlySen;
}

export function fixedCostForDate(policy: FixedCostPolicy, date: string): Sen {
  const [y, m, d] = date.split('-').map(Number);
  return allocateMonthlyFixedCost(monthlyFixedSen(policy, y, m), y, m)[d - 1];
}

export function fixedCostForRange(policy: FixedCostPolicy, range: DateRange): Sen {
  return datesInRange(range).reduce((s, d) => s + fixedCostForDate(policy, d), 0);
}

export type ExpenseCategory = 'purchase' | 'fixed_payment' | 'opex' | 'capital';

export type LedgerEvent =
  /** 收款登记；correction=true 是老板对误登记的反向调整（金额为负），不是实际退款。 */
  | { kind: 'payment'; id: string; orderId: string; businessDate: string; method: PaymentMethod; amountSen: Sen; correction?: boolean }
  | { kind: 'refund'; id: string; orderId: string; businessDate: string; method: PaymentMethod; amountSen: Sen }
  /** 理论成本分配；待做取消时以负数反转。 */
  | { kind: 'cost_allocation'; id: string; orderId: string; businessDate: string; costUnits: CostUnits }
  /** 损耗：alreadyAllocated 表示该份食材已在订单成本中，只记数量不扣钱。 */
  | { kind: 'wastage'; id: string; businessDate: string; costUnits: CostUnits; alreadyAllocated: boolean; noodleHalfUnits: number; wantonCount: number }
  /**
   * 支出：businessDate 为实际付款日（现金视角）；accrualDate 为经营归属日（只对 opex 有意义）。
   * 未付款的支出 paidSen = 0。
   */
  | { kind: 'expense'; id: string; category: ExpenseCategory; businessDate: string; accrualDate: string; amountSen: Sen; paidSen: Sen; paidFromDrawer: boolean }
  | { kind: 'cash_movement'; id: string; businessDate: string; type: 'opening_float' | 'cash_in' | 'cash_out' | 'bank_deposit'; amountSen: Sen };

export interface PeriodSummary {
  range: DateRange;
  /** totalSen = 已登记收款（含更正）；cash/qr 只来自旧记录，unspecified 为新流程统一收款。 */
  receipts: { cashSen: Sen; qrSen: Sen; unspecifiedSen: Sen; correctionsSen: Sen; totalSen: Sen };
  refunds: { cashSen: Sen; qrSen: Sen; unspecifiedSen: Sen; totalSen: Sen };
  /** 区间内有旧版渠道记录（现金 / QR），报表可附带历史拆分。 */
  hasLegacyChannels: boolean;
  netReceiptsSen: Sen;
  allocatedCostUnits: CostUnits;
  wastageCostUnits: CostUnits;
  /** 已在订单成本中的损耗数量（仅显示，不扣钱）。 */
  wastageAlreadyAllocatedCount: number;
  fixedCostSen: Sen;
  otherOpexSen: Sen;
  /** 估算经营利润（sen）。成本在最后一步统一 half-up 舍入。 */
  estimatedProfitSen: Sen;
  cash: {
    purchasesPaidSen: Sen;
    opexPaidSen: Sen;
    capitalPaidSen: Sen;
    operatingNetInflowSen: Sen;
  };
}

export function summarizePeriod(events: LedgerEvent[], range: DateRange, fixed: FixedCostPolicy = DEFAULT_FIXED_COST): PeriodSummary {
  let cashSen = 0, qrSen = 0, unspecifiedSen = 0, correctionsSen = 0, refundCash = 0, refundQr = 0, refundUnspecified = 0;
  let allocated = 0, wastage = 0, wastageAllocatedCount = 0;
  let opexAccrued = 0, purchasesPaid = 0, opexPaid = 0, capitalPaid = 0;

  for (const e of events) {
    if (e.kind === 'expense') {
      if (e.category === 'opex' && inRange(e.accrualDate, range)) opexAccrued += e.amountSen;
      if (inRange(e.businessDate, range)) {
        if (e.category === 'purchase') purchasesPaid += e.paidSen;
        else if (e.category === 'opex' || e.category === 'fixed_payment') opexPaid += e.paidSen;
        else capitalPaid += e.paidSen;
      }
      continue;
    }
    if (!inRange(e.businessDate, range)) continue;
    switch (e.kind) {
      case 'payment':
        if (e.correction) correctionsSen += e.amountSen;
        else if (e.method === 'cash') cashSen += e.amountSen;
        else if (e.method === 'qr_manual') qrSen += e.amountSen;
        else unspecifiedSen += e.amountSen;
        break;
      case 'refund':
        if (e.method === 'cash') refundCash += e.amountSen;
        else if (e.method === 'qr_manual') refundQr += e.amountSen;
        else refundUnspecified += e.amountSen;
        break;
      case 'cost_allocation':
        allocated += e.costUnits;
        break;
      case 'wastage':
        if (e.alreadyAllocated) wastageAllocatedCount++;
        else wastage += e.costUnits;
        break;
      case 'cash_movement':
        break;
    }
  }

  const receiptsTotal = cashSen + qrSen + unspecifiedSen + correctionsSen;
  const refundsTotal = refundCash + refundQr + refundUnspecified;
  const net = receiptsTotal - refundsTotal;
  const fixedCostSen = fixedCostForRange(fixed, range);
  const costSen = costUnitsToSen(allocated + wastage);
  return {
    range,
    receipts: { cashSen, qrSen, unspecifiedSen, correctionsSen, totalSen: receiptsTotal },
    refunds: { cashSen: refundCash, qrSen: refundQr, unspecifiedSen: refundUnspecified, totalSen: refundsTotal },
    hasLegacyChannels: cashSen + qrSen + refundCash + refundQr !== 0,
    netReceiptsSen: net,
    allocatedCostUnits: allocated,
    wastageCostUnits: wastage,
    wastageAlreadyAllocatedCount: wastageAllocatedCount,
    fixedCostSen,
    otherOpexSen: opexAccrued,
    estimatedProfitSen: net - costSen - fixedCostSen - opexAccrued,
    cash: {
      purchasesPaidSen: purchasesPaid,
      opexPaidSen: opexPaid,
      capitalPaidSen: capitalPaid,
      operatingNetInflowSen: receiptsTotal - refundsTotal - purchasesPaid - opexPaid,
    },
  };
}

/**
 * 旧版日结（schemaVersion 1）专用。新收款不分渠道，无法推算物理钱箱，新日结不调用。
 * 钱箱应有 = 备用金 + 现金收款 − 现金退款 − 钱箱付出的支出 + 补入 − 存银行/取走。QR 不进钱箱。 */
export function expectedCashDrawer(events: LedgerEvent[], businessDate: string): Sen {
  let total = 0;
  for (const e of events) {
    if (e.businessDate !== businessDate) continue;
    if (e.kind === 'payment' && e.method === 'cash') total += e.amountSen;
    else if (e.kind === 'refund' && e.method === 'cash') total -= e.amountSen;
    else if (e.kind === 'expense' && e.paidFromDrawer) total -= e.paidSen;
    else if (e.kind === 'cash_movement') {
      total += e.type === 'opening_float' || e.type === 'cash_in' ? e.amountSen : -e.amountSen;
    }
  }
  return total;
}

/** 钱箱差额文案：「实际比应有少 RM…」，不只给负号。 */
export function describeDrawerDifference(countedSen: Sen, expectedSen: Sen): { diffSen: Sen; kind: 'match' | 'short' | 'over' } {
  const diffSen = countedSen - expectedSen;
  return { diffSen, kind: diffSen === 0 ? 'match' : diffSen < 0 ? 'short' : 'over' };
}

export interface PaybackProgress {
  applicable: boolean;
  cumulativeResultSen: Sen;
  /** 原始比例，允许负值与超过 1。 */
  ratio: number | null;
  /** 进度条用，限制在 0–1。 */
  barRatio: number;
  remainingSen: Sen;
}

/** 按估算利润的回本进度。期初余额默认 0（不沿用演示 RM1,920），亏损不被吞掉。 */
export function paybackProgress(input: { initialCapitalSen: Sen; openingBalanceSen: Sen; cumulativeProfitSen: Sen }): PaybackProgress {
  const cumulative = input.openingBalanceSen + input.cumulativeProfitSen;
  if (input.initialCapitalSen <= 0) {
    return { applicable: false, cumulativeResultSen: cumulative, ratio: null, barRatio: 0, remainingSen: 0 };
  }
  const ratio = cumulative / input.initialCapitalSen;
  return {
    applicable: true,
    cumulativeResultSen: cumulative,
    ratio,
    barRatio: Math.min(1, Math.max(0, ratio)),
    remainingSen: Math.max(0, input.initialCapitalSen - cumulative),
  };
}

/** 比率：分母为 0 返回 null（UI 显示「—」）。 */
export function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

