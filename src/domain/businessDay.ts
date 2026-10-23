/**
 * 营业日：档口时区 Asia/Kuala_Lumpur，默认切点 04:00。
 * 例：2026-10-23 03:59 属于 2026-10-22；04:00 属于 2026-10-23。
 * 日期字符串统一为 YYYY-MM-DD，区间半开 [start, endExclusive)。
 */

export interface BusinessDayPolicy {
  timeZone: string;
  /** 自零点起的分钟数，04:00 = 240。 */
  cutoverMinutes: number;
}

export const DEFAULT_BUSINESS_DAY: BusinessDayPolicy = { timeZone: 'Asia/Kuala_Lumpur', cutoverMinutes: 240 };

const formatters = new Map<string, Intl.DateTimeFormat>();

export function wallClock(epochMs: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: Number(parts.hour), mm: Number(parts.minute) };
}

function toDateString(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isDateString(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function businessDateOf(epochMs: number, policy: BusinessDayPolicy = DEFAULT_BUSINESS_DAY): string {
  const w = wallClock(epochMs, policy.timeZone);
  const minutes = w.hh * 60 + w.mm;
  if (minutes >= policy.cutoverMinutes) return toDateString(w.y, w.m, w.d);
  return addDays(toDateString(w.y, w.m, w.d), -1);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return toDateString(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface DateRange {
  start: string;
  endExclusive: string;
}

/** 含今日的 N 个营业日。 */
export function lastNDays(today: string, n: number): DateRange {
  return { start: addDays(today, -(n - 1)), endExclusive: addDays(today, 1) };
}

/** 上一个等长区间，用于对比。 */
export function previousRange(r: DateRange): DateRange {
  const len = rangeLength(r);
  return { start: addDays(r.start, -len), endExclusive: r.start };
}

export function rangeLength(r: DateRange): number {
  const [a, b] = [r.start, r.endExclusive].map((s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86_400_000);
}

export function inRange(date: string, r: DateRange): boolean {
  return date >= r.start && date < r.endExclusive;
}

export function datesInRange(r: DateRange): string[] {
  const out: string[] = [];
  for (let d = r.start; d < r.endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}
