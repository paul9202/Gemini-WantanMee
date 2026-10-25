/**
 * 开业清空的确认码（店主 IC）只以 scrypt 哈希存在 Secret Manager（STORE_RESET_CODE_HASH）；
 * 代码、网页、Firestore 与日志里都不出现原文。格式：scrypt$N$r$p$<salt base64>$<hash base64>。
 * IC 常写成 910101-01-0101：比对前去掉「-」与空格。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;

export function normalizeResetCode(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

export function hashResetCode(code: string, salt: Buffer = randomBytes(16)): string {
  const key = scryptSync(normalizeResetCode(code), salt, KEY_BYTES, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** 存储的哈希格式不对返回 null（当作未设置）；否则返回是否一致（恒定时间比较）。 */
export function verifyResetCode(code: string, stored: string): boolean | null {
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 2 ** 17 || r > 16 || p > 4) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || expected.length < 16) return null;
  const got = scryptSync(normalizeResetCode(code), salt, expected.length, { N: n, r, p, maxmem: 256 * n * r * p });
  return timingSafeEqual(got, expected);
}
