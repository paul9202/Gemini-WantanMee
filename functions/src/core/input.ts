/**
 * 不可信输入解析：拒绝未知字段、错误类型、超长字符串。不做静默纠正。
 */
import { isUuid } from '../../../src/domain/idempotency';
import { CommandError } from './errors';

export type Raw = Record<string, unknown>;

export function obj(raw: unknown, allowed: string[], field = 'data'): Raw {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad(`${field} 必须是对象`);
  const o = raw as Raw;
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  if (unknown.length) throw bad(`${field} 含未知字段：${unknown.join(',')}`);
  return o;
}

export function bad(message: string): CommandError {
  return new CommandError('INVALID_ARGUMENT', message);
}

export function str(o: Raw, k: string, max = 64, min = 1): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad(`${k} 必须是 ${min}–${max} 字符的字符串`);
  return v;
}

export function optStr(o: Raw, k: string, max: number): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw bad(`${k} 最长 ${max} 字符`);
  return v;
}

export function int(o: Raw, k: string, min: number, max: number): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw bad(`${k} 必须是 ${min}–${max} 的整数`);
  return v;
}

export function optInt(o: Raw, k: string, min: number, max: number): number | null {
  return o[k] === undefined || o[k] === null ? null : int(o, k, min, max);
}

export function bool(o: Raw, k: string): boolean {
  if (typeof o[k] !== 'boolean') throw bad(`${k} 必须是布尔值`);
  return o[k] as boolean;
}

export function oneOf<T extends string>(o: Raw, k: string, values: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !values.includes(v as T)) throw bad(`${k} 必须是 ${values.join('/')}`);
  return v as T;
}

export function uuid(o: Raw, k: string): string {
  if (!isUuid(o[k])) throw bad(`${k} 必须是 UUID`);
  return o[k] as string;
}

const STORE_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;

export function storeId(o: Raw): string {
  const v = o.storeId;
  if (typeof v !== 'string' || !STORE_ID.test(v)) throw bad('storeId 非法');
  return v;
}
