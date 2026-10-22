/**
 * 命令幂等：同一 operationId + 相同标准化 payload 返回原结果；
 * 同 ID 不同 payload 是冲突。hash 由服务器重算，客户端 hash 不是身份凭证。
 */

/** 稳定 JSON：对象键排序，拒绝 undefined/函数/非有限数字。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('非有限数字不能进入命令 payload');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`不支持的 payload 类型：${typeof value}`);
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function payloadHash(payload: unknown): Promise<string> {
  return `sha256-${await sha256Hex(canonicalJson(payload))}`;
}

export interface OperationRecord<R = unknown> {
  operationId: string;
  payloadHash: string;
  result: R;
}

export type OperationDecision<R> = { kind: 'new' } | { kind: 'replay'; result: R } | { kind: 'conflict' };

export function decideOperation<R>(existing: OperationRecord<R> | undefined, incomingHash: string): OperationDecision<R> {
  if (!existing) return { kind: 'new' };
  return existing.payloadHash === incomingHash ? { kind: 'replay', result: existing.result } : { kind: 'conflict' };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}
