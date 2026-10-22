/**
 * 金额与成本精度。
 * - 售价、付款、找零：整数 sen（RM1 = 100 sen）。
 * - 成本：整数「成本单位」，1 单位 = 0.1 sen，避免 1.5 面球 × RM0.85 过早舍入。
 * 只有展示和最终汇总才舍入，舍入规则为 half-up（远离零）。
 */

export type Sen = number;
export type CostUnits = number;

export const COST_UNITS_PER_SEN = 10;

export function isSen(value: unknown): value is Sen {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertSen(value: number, field = 'amount'): Sen {
  if (!isSen(value)) throw new RangeError(`${field} 必须是整数 sen：${value}`);
  return value;
}

export function assertCostUnits(value: number, field = 'cost'): CostUnits {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} 必须是整数成本单位：${value}`);
  return value;
}

/** 成本单位 → sen，half-up（远离零）。 */
export function costUnitsToSen(units: CostUnits): Sen {
  assertCostUnits(units);
  const sign = units < 0 ? -1 : 1;
  const abs = Math.abs(units);
  return sign * Math.floor((abs + COST_UNITS_PER_SEN / 2) / COST_UNITS_PER_SEN) || 0;
}

export function senToCostUnits(sen: Sen): CostUnits {
  return assertSen(sen) * COST_UNITS_PER_SEN;
}

/** RM 两位小数，例如 700 → "RM7.00"，-150 → "-RM1.50"。 */
export function formatRM(sen: Sen): string {
  assertSen(sen);
  const sign = sen < 0 ? '-' : '';
  const abs = Math.abs(sen);
  const ringgit = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}RM${ringgit.toLocaleString('en-US')}.${cents}`;
}

/** 成本显示为 RM 两位（half-up）。 */
export function formatCostRM(units: CostUnits): string {
  return formatRM(costUnitsToSen(units));
}

/** 成本保留三位，用于老板成本页核对，例如 3635 → "RM3.635"。 */
export function formatCostRMPrecise(units: CostUnits): string {
  assertCostUnits(units);
  const sign = units < 0 ? '-' : '';
  const abs = Math.abs(units);
  const ringgit = Math.floor(abs / 1000);
  const rest = String(abs % 1000).padStart(3, '0');
  return `${sign}RM${ringgit}.${rest}`;
}

/** 把用户输入的 "20" / "20.5" / "RM 16.00" 解析为 sen；非法返回 null。 */
export function parseRMInput(input: string): Sen | null {
  const cleaned = input.replace(/rm/i, '').replace(/[\s,]/g, '');
  if (!/^\d{1,6}(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
