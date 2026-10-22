/**
 * UTF-8 BOM CSV 导出。自由文本按不可信内容处理：
 * 以 = + - @ 制表符 回车 开头的字符串加前导单引号，防止表格软件执行公式。
 */

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('CSV 数字必须有限');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = value;
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: CsvCell[][]): string {
  return '﻿' + rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
}
