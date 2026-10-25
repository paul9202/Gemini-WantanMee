/**
 * 模型输出的结构合约与严格校验。两家供应商输出同一份 JSON 结构；结构合法 ≠ 内容正确，草稿仍需老板核对。
 * - 金额用字符串小数（"12.50"），在这里转成整数 sen，避免浮点误差；无法辨认就是 null，不猜。
 * - 未知字段、错误类型、非法枚举、超长内容一律拒绝（视为结构错误，可交给备用），不静默修补成假数据。
 * - Claude 结构化输出最多允许 16 个可为 null / 联合类型的字段，超过整个请求 400。所以名称、单位、原文片段、商家、单号这类文字字段
 *   不用 null，没有就输出空字符串；解析时空字符串与 null 都当作「没有」（DeepSeek 仍输出 null 也照常接受）。
 */
import { isDateString } from '../../../src/domain/businessDay';
import { COST_CATEGORIES, CostCategoryOrUnknown, CostPayment, CostPaymentSource, ExtractedCostDraft, ExtractedCostLine, MAX_DRAFT_LINES } from '../../../src/domain/aiCost';
import { isMonthString } from '../../../src/domain/costing';
import type { CostExplanation } from './types';

export class SchemaError extends Error {}

const nullable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: 'null' }] });
const str = { type: 'string' };
const text = (description: string) => ({ type: 'string', description: `${description}；没有或看不清就空字符串 ""` });
const money = nullable({ type: 'string', description: '金额，令吉，最多两位小数，例如 "12.50"；看不清就 null' });

/** Claude 结构化输出对可为 null / anyOf / 类型数组字段的上限（超过返回 400）。 */
export const MAX_UNION_PARAMS = 16;

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['purchase_date', 'currency', 'payment', 'payment_source', 'supplier', 'receipt_number', 'discount', 'tax', 'printed_total', 'paid_amount', 'change', 'lines', 'warnings'],
  properties: {
    purchase_date: nullable({ type: 'string', description: 'YYYY-MM-DD；没提到日期就 null' }),
    currency: nullable({ type: 'string', description: '三位币种代码；块 / 令吉 / RM 为 MYR' }),
    payment: { type: 'string', enum: ['paid', 'unpaid', 'unknown'] },
    payment_source: nullable({ type: 'string', enum: ['drawer', 'bank', 'owner'] }),
    supplier: text('商家名称'),
    receipt_number: text('收据单号'),
    discount: money,
    tax: money,
    printed_total: money,
    paid_amount: money,
    change: money,
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'category', 'amount', 'quantity', 'unit', 'payment', 'evidence', 'personal_suggested', 'period_month'],
        properties: {
          name: text('项目名称'),
          category: { type: 'string', enum: [...COST_CATEGORIES, 'unknown'] },
          amount: money,
          quantity: nullable({ type: 'string', description: '数量，最多三位小数；没写就 null' }),
          unit: text('单位，例如 kg、包'),
          payment: nullable({ type: 'string', enum: ['paid', 'unpaid', 'unknown'] }),
          evidence: text('该行对应的原文片段，最多 60 字'),
          personal_suggested: { type: 'boolean' },
          period_month: nullable({ type: 'string', description: 'YYYY-MM，只用于租金 / 电费' }),
        },
      },
    },
    warnings: { type: 'array', items: str },
  },
} as const;

export const EXPLANATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'limitations'],
  properties: {
    summary: str,
    findings: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'evidence_ids'], properties: { text: str, evidence_ids: { type: 'array', items: str } } },
    },
    limitations: { type: 'array', items: str },
  },
} as const;

type Raw = Record<string, unknown>;

function exact(o: unknown, keys: readonly string[], where: string): Raw {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new SchemaError(`${where} 不是对象`);
  const r = o as Raw;
  const extra = Object.keys(r).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in r));
  if (extra.length || missing.length) throw new SchemaError(`${where} 字段不符：多 ${extra.join(',') || '-'}，缺 ${missing.join(',') || '-'}`);
  return r;
}

function optText(v: unknown, where: string, max = 200): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw new SchemaError(`${where} 必须是最多 ${max} 字的文字或 null`);
  const t = v.trim();
  return t ? t : null;
}

function oneOf<T extends string>(v: unknown, values: readonly T[], where: string): T {
  if (typeof v !== 'string' || !values.includes(v as T)) throw new SchemaError(`${where} 不在允许范围`);
  return v as T;
}

/** "12.50" / "12" → 1250。负数、千分位、超过两位小数都不接受。 */
export function moneyToSen(v: unknown, where: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(v.trim())) throw new SchemaError(`${where} 金额格式不对：${String(v).slice(0, 20)}`);
  const [w, f = ''] = v.trim().split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

function quantity(v: unknown, where: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{1,6}(\.\d{1,3})?$/.test(v.trim())) throw new SchemaError(`${where} 数量格式不对`);
  const n = Number(v.trim());
  if (!(n > 0)) throw new SchemaError(`${where} 数量必须大于 0`);
  return n;
}

const LINE_KEYS = ['name', 'category', 'amount', 'quantity', 'unit', 'payment', 'evidence', 'personal_suggested', 'period_month'] as const;
const TOP_KEYS = EXTRACTION_SCHEMA.required;

export function parseExtraction(raw: unknown): ExtractedCostDraft {
  const o = exact(raw, TOP_KEYS, '结果');
  if (!Array.isArray(o.lines)) throw new SchemaError('lines 必须是数组');
  if (o.lines.length > MAX_DRAFT_LINES) throw new SchemaError(`超过 ${MAX_DRAFT_LINES} 项`);
  if (!Array.isArray(o.warnings) || o.warnings.length > 20 || o.warnings.some((w) => typeof w !== 'string' || w.length > 300)) throw new SchemaError('warnings 不正确');
  const purchaseDate = o.purchase_date === null ? null : isDateString(o.purchase_date) ? o.purchase_date : (() => { throw new SchemaError('purchase_date 不是 YYYY-MM-DD'); })();
  const currency = o.currency === null ? null : typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency) ? o.currency : (() => { throw new SchemaError('currency 不正确'); })();
  const lines: ExtractedCostLine[] = o.lines.map((l, i) => {
    const x = exact(l, LINE_KEYS, `lines[${i}]`);
    if (typeof x.personal_suggested !== 'boolean') throw new SchemaError(`lines[${i}].personal_suggested 必须是布尔值`);
    const periodMonth = x.period_month === null ? null : isMonthString(x.period_month) ? x.period_month : (() => { throw new SchemaError(`lines[${i}].period_month 不正确`); })();
    return {
      name: optText(x.name, `lines[${i}].name`, 60),
      category: oneOf<CostCategoryOrUnknown>(x.category, [...COST_CATEGORIES, 'unknown'], `lines[${i}].category`),
      amountSen: moneyToSen(x.amount, `lines[${i}].amount`),
      quantity: quantity(x.quantity, `lines[${i}].quantity`),
      unit: optText(x.unit, `lines[${i}].unit`, 10),
      payment: x.payment === null ? null : oneOf<CostPayment>(x.payment, ['paid', 'unpaid', 'unknown'], `lines[${i}].payment`),
      evidence: optText(x.evidence, `lines[${i}].evidence`, 200),
      personalSuggested: x.personal_suggested,
      periodMonth,
    };
  });
  return {
    purchaseDate, currency,
    payment: oneOf<CostPayment>(o.payment, ['paid', 'unpaid', 'unknown'], 'payment'),
    paymentSource: o.payment_source === null ? null : oneOf<CostPaymentSource>(o.payment_source, ['drawer', 'bank', 'owner'], 'payment_source'),
    supplier: optText(o.supplier, 'supplier', 80),
    receiptNumber: optText(o.receipt_number, 'receipt_number', 60),
    discountSen: moneyToSen(o.discount, 'discount') ?? 0,
    taxSen: moneyToSen(o.tax, 'tax') ?? 0,
    printedTotalSen: moneyToSen(o.printed_total, 'printed_total'),
    // 付款金额与找零只用于核对，不进入任何支出。
    lines,
    warnings: [
      ...(o.warnings as string[]),
      ...(moneyToSen(o.paid_amount, 'paid_amount') !== null || moneyToSen(o.change, 'change') !== null ? ['收据上的付款金额 / 找零只用于核对，不记成本'] : []),
    ].slice(0, 20),
  };
}

const RM_IN_TEXT = /RM\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/gi;

/** 文字里出现的 RM 金额（sen）。用于核对解释只引用后端给出的数值。 */
export function amountsInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(RM_IN_TEXT)) out.push(Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0')));
  return out;
}

/** 解释：引用必须在后端提供的记录内，文中的 RM 金额必须是统计或记录里的数值；否则整段拒绝。 */
export function parseExplanation(raw: unknown, allowedIds: Set<string>, allowedAmounts: Set<number>): CostExplanation {
  const o = exact(raw, ['summary', 'findings', 'limitations'], '解释');
  const summary = optText(o.summary, 'summary', 600);
  if (!summary) throw new SchemaError('summary 为空');
  if (!Array.isArray(o.findings) || o.findings.length > 8) throw new SchemaError('findings 最多 8 条');
  if (!Array.isArray(o.limitations) || o.limitations.length > 6) throw new SchemaError('limitations 最多 6 条');
  const findings = o.findings.map((f, i) => {
    const x = exact(f, ['text', 'evidence_ids'], `findings[${i}]`);
    const text = optText(x.text, `findings[${i}].text`, 400);
    if (!text) throw new SchemaError(`findings[${i}].text 为空`);
    if (!Array.isArray(x.evidence_ids) || x.evidence_ids.length > 20 || x.evidence_ids.some((id) => typeof id !== 'string')) throw new SchemaError(`findings[${i}].evidence_ids 不正确`);
    const bad = (x.evidence_ids as string[]).filter((id) => !allowedIds.has(id));
    if (bad.length) throw new SchemaError(`引用了不存在的记录：${bad.slice(0, 3).join(',')}`);
    return { text, evidenceIds: [...new Set(x.evidence_ids as string[])] };
  });
  const limitations = o.limitations.map((l, i) => optText(l, `limitations[${i}]`, 300) ?? '').filter(Boolean);
  const unknownAmounts = [summary, ...findings.map((f) => f.text), ...limitations].flatMap(amountsInText).filter((a) => !allowedAmounts.has(a));
  if (unknownAmounts.length) throw new SchemaError(`解释中出现账本以外的金额：${unknownAmounts.slice(0, 3).map((a) => (a / 100).toFixed(2)).join(',')}`);
  return { summary, findings, limitations };
}
