/**
 * AI 记成本（2026-10-25）：可编辑草稿的结构、校验、收据折扣 / 税费分摊与入账计划。前端、Functions 与测试共用。
 *
 * 口径：
 * - AI 只给建议；草稿只有在老板确认后才由服务端按本文件的计划写账。
 * - 金额一律整数 sen。折扣与税费按明细毛额用最大余数法分摊（余数相同按 lineId 排序），原收据总额保留不改。
 * - 收据父记录只是汇总与凭证，不是额外支出；付款金额 / 找零不是成本。
 * - 私人行：先按整张收据分摊，再排除，排除原因必填；其余营业行的净额不变。
 * - 数量 / 单位可空；不伪造数量。付款状态 unknown 不等于 unpaid，未确认不能入账。付款来源可「未说明」。
 */
import { isDateString } from './businessDay';
import { BUILT_IN_INGREDIENTS, Ingredient, IngredientCategory, isMonthString, isQuantity, PlanItem } from './costing';
import { formatRM, type Sen } from './money';

export const MAX_DRAFT_LINES = 50;
export const MAX_DRAFT_TEXT = 6_000;
export const MAX_RECEIPT_IMAGES = 5;
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ReceiptMime = (typeof RECEIPT_MIME)[number];
const MAX_LINE_SEN = 100_000_000;

/** 五类食材 + 现有日常开支项目。unknown = 待分类，保存前必须选。 */
export const COST_CATEGORIES = ['noodle', 'wonton', 'topping', 'seasoning', 'other_food', 'gas', 'misc', 'wage', 'rent', 'fridge_power'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
export type CostCategoryOrUnknown = CostCategory | 'unknown';

export const COST_CATEGORY_ZH: Record<CostCategoryOrUnknown, string> = {
  noodle: '面和面薄 · 食材', wonton: '云吞 · 食材', topping: '配料 · 食材', seasoning: '调味料 · 食材', other_food: '其他食材',
  gas: '煤气 · 日常', misc: '杂费 · 日常', wage: '员工工资 · 日常', rent: '档口租金 · 每月', fridge_power: '冰箱额外电费 · 每月', unknown: '请选择分类',
};

export const FOOD_CATEGORIES: CostCategory[] = ['noodle', 'wonton', 'topping', 'seasoning', 'other_food'];
export const isFoodCategory = (c: CostCategoryOrUnknown): c is CostCategory => (FOOD_CATEGORIES as string[]).includes(c);
export const ingredientCategoryOf = (c: CostCategory): IngredientCategory | null => (isFoodCategory(c) ? (c === 'other_food' ? 'other' : c) as IngredientCategory : null);
export const costCategoryOfIngredient = (c: IngredientCategory): CostCategory => (c === 'other' ? 'other_food' : c);

export type CostPayment = 'paid' | 'unpaid' | 'unknown';
export const COST_PAYMENT_ZH: Record<CostPayment, string> = { paid: '已付', unpaid: '待付（赊账）', unknown: '请确认是否已付' };
export type CostPaymentSource = 'drawer' | 'bank' | 'owner' | 'unspecified';
export const COST_SOURCE_ZH: Record<CostPaymentSource, string> = { drawer: '钱箱现金', bank: '银行 / QR', owner: '老板自付', unspecified: '未说明' };

export interface CostDraftLine {
  lineId: string;
  name: string;
  category: CostCategoryOrUnknown;
  /** 明细毛额（折扣 / 税费分摊前）；null = 未识别，必须由老板填写。 */
  grossSen: Sen | null;
  quantity: number | null;
  unit: string | null;
  note: string;
  /** 明确匹配的食材；只有数量、单位与食材都确定时才建库存批次。 */
  ingredientId: string | null;
  /** inherit = 跟随全单。 */
  payment: CostPayment | 'inherit';
  /** false = 私人 / 非营业项目：保留凭证，不入营业账。 */
  includeInBusiness: boolean;
  excludeReason: string | null;
  /** 月租 / 电费归属月份。 */
  periodMonth: string | null;
  /** 员工工资出勤天数。 */
  workDays: number | null;
}

export interface EditedCostDraft {
  purchaseDate: string;
  currency: string;
  payment: CostPayment;
  paymentSource: CostPaymentSource;
  supplier: string | null;
  receiptNumber: string | null;
  discountSen: Sen;
  taxSen: Sen;
  /** 收据原打印总额（原始依据，不改写）；文字录入为 null。 */
  printedTotalSen: Sen | null;
  /** 与收据不一致时，老板说明原因并确认采用的总额；必须等于当前计算总额。 */
  difference: { acceptedTotalSen: Sen; reason: string } | null;
  lines: CostDraftLine[];
}

/** 模型提取结果（服务端结构校验后）；只作为草稿建议。 */
export interface ExtractedCostLine {
  name: string | null;
  category: CostCategoryOrUnknown;
  amountSen: Sen | null;
  quantity: number | null;
  unit: string | null;
  payment: CostPayment | null;
  evidence: string | null;
  /** 模型认为像私人 / 非营业用品（只提示，不自动排除）。 */
  personalSuggested: boolean;
  periodMonth: string | null;
}

export interface ExtractedCostDraft {
  purchaseDate: string | null;
  currency: string | null;
  payment: CostPayment;
  paymentSource: CostPaymentSource | null;
  supplier: string | null;
  receiptNumber: string | null;
  discountSen: Sen;
  taxSen: Sen;
  printedTotalSen: Sen | null;
  lines: ExtractedCostLine[];
  warnings: string[];
}

export type IssueCode =
  | 'no_lines' | 'too_many_lines' | 'duplicate_line_id' | 'name_required' | 'amount_required' | 'amount_invalid' | 'category_required'
  | 'payment_unknown' | 'discount_exceeds' | 'difference_unconfirmed' | 'exclude_reason_required' | 'nothing_to_post' | 'period_month_required'
  | 'recurring_must_be_paid' | 'work_days_required' | 'quantity_invalid' | 'unit_required' | 'date_invalid' | 'date_future' | 'currency_unsupported';

export interface DraftIssue { code: IssueCode; lineId: string | null; field: string; message: string }

export interface DraftTotals {
  subtotalSen: Sen;
  discountSen: Sen;
  taxSen: Sen;
  /** 全部明细（含排除的私人行）分摊后的合计，用于对照收据。 */
  computedTotalSen: Sen;
  /** 本次记入营业成本的合计。 */
  businessTotalSen: Sen;
  printedTotalSen: Sen | null;
  /** 计算总额 − 收据总额；null = 没有收据总额可对照。 */
  differenceSen: Sen | null;
  lineCount: number;
}

export interface AllocatedLine { lineId: string; grossSen: Sen; discountSen: Sen; taxSen: Sen; netSen: Sen }

const isWholeSen = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= MAX_LINE_SEN;

/** 按权重分摊整数金额：先取整，余数按小数部分从大到小（相同按 lineId）各补 1 sen。 */
function largestRemainder(lines: { lineId: string; grossSen: Sen }[], amountSen: Sen): Map<string, Sen> {
  const total = lines.reduce((s, l) => s + l.grossSen, 0);
  const out = new Map<string, Sen>(lines.map((l) => [l.lineId, 0]));
  if (amountSen === 0 || total === 0) return out;
  const parts = lines.map((l) => {
    const exact = l.grossSen * amountSen;
    return { lineId: l.lineId, floor: Math.floor(exact / total), rem: exact % total };
  });
  let left = amountSen - parts.reduce((s, p) => s + p.floor, 0);
  for (const p of parts) out.set(p.lineId, p.floor);
  const order = [...parts].sort((a, b) => b.rem - a.rem || (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
  for (const p of order) {
    if (left <= 0) break;
    out.set(p.lineId, out.get(p.lineId)! + 1);
    left--;
  }
  return out;
}

/** 全单折扣与税费分摊到每一行（含之后要排除的私人行），折扣不得超过小计。 */
export function allocateReceiptAmounts(lines: { lineId: string; grossSen: Sen }[], discountSen: Sen, taxSen: Sen): AllocatedLine[] {
  const subtotal = lines.reduce((s, l) => s + l.grossSen, 0);
  if (!isWholeSen(discountSen, 0) || !isWholeSen(taxSen, 0)) throw new RangeError('折扣与税费必须是非负整数 sen');
  if (discountSen > subtotal) throw new RangeError('折扣不能超过明细小计');
  const d = largestRemainder(lines, discountSen);
  const t = largestRemainder(lines, taxSen);
  return lines.map((l) => ({ lineId: l.lineId, grossSen: l.grossSen, discountSen: d.get(l.lineId)!, taxSen: t.get(l.lineId)!, netSen: l.grossSen - d.get(l.lineId)! + t.get(l.lineId)! }));
}

export const linePayment = (d: Pick<EditedCostDraft, 'payment'>, l: Pick<CostDraftLine, 'payment'>): CostPayment => (l.payment === 'inherit' ? d.payment : l.payment);

/** 校验草稿并计算合计。不抛错；issues 为空时才能确认保存。 */
export function validateCostDraft(d: EditedCostDraft, opts: { today: string }): { issues: DraftIssue[]; totals: DraftTotals; allocated: AllocatedLine[] } {
  const issues: DraftIssue[] = [];
  const add = (code: IssueCode, lineId: string | null, field: string, message: string) => issues.push({ code, lineId, field, message });
  if (!isDateString(d.purchaseDate)) add('date_invalid', null, 'purchaseDate', '购买日期不正确');
  else if (d.purchaseDate > opts.today) add('date_future', null, 'purchaseDate', '购买日期不能晚于今天的营业日');
  if (d.currency !== 'MYR') add('currency_unsupported', null, 'currency', `本期只记令吉（MYR）；${d.currency} 请换算后手动填写`);
  if (!d.lines.length) add('no_lines', null, 'lines', '至少要有一个项目');
  if (d.lines.length > MAX_DRAFT_LINES) add('too_many_lines', null, 'lines', `一次最多 ${MAX_DRAFT_LINES} 项，请分开记`);
  const seen = new Set<string>();
  for (const l of d.lines) {
    if (seen.has(l.lineId)) add('duplicate_line_id', l.lineId, 'lineId', '项目编号重复');
    seen.add(l.lineId);
    if (!l.name.trim()) add('name_required', l.lineId, 'name', '请填写项目名称');
    if (l.grossSen === null) add('amount_required', l.lineId, 'grossSen', '请填写金额');
    else if (!isWholeSen(l.grossSen, l.includeInBusiness ? 1 : 0)) add('amount_invalid', l.lineId, 'grossSen', '金额必须大于 0，最多两位小数');
    if (!l.includeInBusiness) {
      if (!l.excludeReason || l.excludeReason.trim().length < 2) add('exclude_reason_required', l.lineId, 'excludeReason', '不计入营业成本需写明原因');
      continue;
    }
    if (l.category === 'unknown') add('category_required', l.lineId, 'category', '请选择分类（不确定可选「杂费」或「其他食材」）');
    if (linePayment(d, l) === 'unknown') add('payment_unknown', l.lineId, 'payment', '请确认这一项是否已付款');
    if (l.quantity !== null && !isQuantity(l.quantity)) add('quantity_invalid', l.lineId, 'quantity', '数量必须大于 0，最多 3 位小数');
    if (l.quantity !== null && !l.unit?.trim()) add('unit_required', l.lineId, 'unit', '填了数量请同时填单位');
    if (l.category === 'rent' || l.category === 'fridge_power') {
      if (!isMonthString(l.periodMonth)) add('period_month_required', l.lineId, 'periodMonth', '请选择这笔费用属于哪个月');
      if (linePayment(d, l) === 'unpaid') add('recurring_must_be_paid', l.lineId, 'payment', '月租 / 电费只登记已付的款项；未付的到期后再登记');
    }
    if (l.category === 'wage' && (l.workDays === null || !Number.isSafeInteger(l.workDays) || l.workDays < 1 || l.workDays > 31)) add('work_days_required', l.lineId, 'workDays', '工资需填写出勤天数（1–31）');
  }
  if (!isWholeSen(d.discountSen, 0)) add('amount_invalid', null, 'discountSen', '折扣必须是非负金额');
  if (!isWholeSen(d.taxSen, 0)) add('amount_invalid', null, 'taxSen', '税费必须是非负金额');
  if (d.printedTotalSen !== null && !isWholeSen(d.printedTotalSen, 0)) add('amount_invalid', null, 'printedTotalSen', '收据总额不正确');

  const priced = d.lines.filter((l) => l.grossSen !== null && isWholeSen(l.grossSen, 0)) as (CostDraftLine & { grossSen: Sen })[];
  const subtotalSen = priced.reduce((s, l) => s + l.grossSen, 0);
  let allocated: AllocatedLine[] = [];
  if (isWholeSen(d.discountSen, 0) && isWholeSen(d.taxSen, 0)) {
    if (d.discountSen > subtotalSen) add('discount_exceeds', null, 'discountSen', `折扣 ${formatRM(d.discountSen)} 超过明细小计 ${formatRM(subtotalSen)}`);
    else allocated = allocateReceiptAmounts(priced.map((l) => ({ lineId: l.lineId, grossSen: l.grossSen })), d.discountSen, d.taxSen);
  }
  const net = new Map(allocated.map((a) => [a.lineId, a.netSen]));
  const computedTotalSen = subtotalSen - (isWholeSen(d.discountSen, 0) ? d.discountSen : 0) + (isWholeSen(d.taxSen, 0) ? d.taxSen : 0);
  const businessTotalSen = d.lines.filter((l) => l.includeInBusiness).reduce((s, l) => s + (net.get(l.lineId) ?? 0), 0);
  const differenceSen = d.printedTotalSen === null ? null : computedTotalSen - d.printedTotalSen;
  if (differenceSen !== null && differenceSen !== 0) {
    const ok = d.difference && d.difference.acceptedTotalSen === computedTotalSen && d.difference.reason.trim().length >= 2;
    if (!ok) add('difference_unconfirmed', null, 'difference', `与收据原总额相差 ${formatRM(Math.abs(differenceSen))}，请核对或说明原因`);
  }
  if (d.lines.length && !issues.some((i) => i.code === 'amount_required' || i.code === 'amount_invalid' || i.code === 'discount_exceeds')
    && !d.lines.some((l) => l.includeInBusiness && (net.get(l.lineId) ?? 0) > 0)) {
    add('nothing_to_post', null, 'lines', '没有需要入账的金额（全部折完或都不计入营业）；请手动处理');
  }
  return {
    issues, allocated,
    totals: { subtotalSen, discountSen: d.discountSen, taxSen: d.taxSen, computedTotalSen, businessTotalSen, printedTotalSen: d.printedTotalSen, differenceSen, lineCount: d.lines.length },
  };
}

export interface PostingLine {
  lineId: string;
  name: string;
  category: CostCategory;
  kind: 'purchase' | 'opex' | 'fixed_payment';
  planItem: PlanItem | null;
  ingredientCategory: IngredientCategory | null;
  grossSen: Sen;
  discountShareSen: Sen;
  taxShareSen: Sen;
  netSen: Sen;
  paid: boolean;
  quantity: number | null;
  unit: string | null;
  ingredientId: string | null;
  /** 数量、单位、食材都明确 → 同时建一批「库存待启用」（不开封、不结束旧批）。 */
  stock: boolean;
  periodMonth: string | null;
  workDays: number | null;
  note: string;
}

export interface CostPostingPlan {
  purchaseDate: string;
  paymentSource: CostPaymentSource;
  lines: PostingLine[];
  /** 不计入营业的行：保留凭证与分摊后的金额。 */
  excluded: { lineId: string; name: string; netSen: Sen; reason: string }[];
  /** 分摊后净额为 0 的行：保留凭证，不生成支出。 */
  zeroLines: { lineId: string; name: string }[];
  totals: DraftTotals;
}

export class CostDraftInvalid extends Error {
  constructor(public readonly issues: DraftIssue[]) {
    super(issues.map((i) => i.message).join('；'));
  }
}

/** 由老板确认的草稿生成入账计划；有任何问题抛 CostDraftInvalid（服务端据此整单拒绝）。 */
export function buildCostPostingPlan(d: EditedCostDraft, opts: { today: string }): CostPostingPlan {
  const v = validateCostDraft(d, opts);
  if (v.issues.length) throw new CostDraftInvalid(v.issues);
  const alloc = new Map(v.allocated.map((a) => [a.lineId, a]));
  const lines: PostingLine[] = [];
  const excluded: CostPostingPlan['excluded'] = [];
  const zeroLines: CostPostingPlan['zeroLines'] = [];
  for (const l of d.lines) {
    const a = alloc.get(l.lineId)!;
    if (!l.includeInBusiness) { excluded.push({ lineId: l.lineId, name: l.name.trim(), netSen: a.netSen, reason: l.excludeReason!.trim() }); continue; }
    if (a.netSen <= 0) { zeroLines.push({ lineId: l.lineId, name: l.name.trim() }); continue; }
    const category = l.category as CostCategory;
    const food = isFoodCategory(category);
    const recurring = category === 'rent' || category === 'fridge_power';
    const unit = l.unit?.trim() || null;
    lines.push({
      lineId: l.lineId, name: l.name.trim(), category, kind: food ? 'purchase' : recurring ? 'fixed_payment' : 'opex',
      planItem: food ? null : (category as PlanItem), ingredientCategory: ingredientCategoryOf(category),
      grossSen: a.grossSen, discountShareSen: a.discountSen, taxShareSen: a.taxSen, netSen: a.netSen,
      paid: linePayment(d, l) === 'paid', quantity: l.quantity, unit, ingredientId: food ? l.ingredientId : null,
      stock: food && l.quantity !== null && unit !== null && l.ingredientId !== null,
      periodMonth: recurring ? l.periodMonth : null, workDays: category === 'wage' ? l.workDays : null, note: l.note.trim(),
    });
  }
  return { purchaseDate: d.purchaseDate, paymentSource: d.paymentSource, lines, excluded, zeroLines, totals: v.totals };
}

/** 名称与食材完全一致（忽略空白）才算明确匹配；不做模糊猜测。 */
export function matchIngredient(name: string | null, ingredients: Pick<Ingredient, 'id' | 'name'>[] = BUILT_IN_INGREDIENTS): string | null {
  const n = (name ?? '').replace(/\s+/g, '');
  if (!n) return null;
  return ingredients.find((i) => i.name.replace(/\s+/g, '') === n)?.id ?? null;
}

/** 模型提取 → 第一次的可编辑草稿。缺的资料保持空 / 待确认，不补假值。 */
export function extractionToEdited(x: ExtractedCostDraft, opts: { defaultDate: string; ingredients?: Pick<Ingredient, 'id' | 'name' | 'category'>[] }): EditedCostDraft {
  const ingredients = opts.ingredients ?? BUILT_IN_INGREDIENTS;
  return {
    purchaseDate: x.purchaseDate && isDateString(x.purchaseDate) ? x.purchaseDate : opts.defaultDate,
    currency: x.currency ?? 'MYR',
    payment: x.payment,
    paymentSource: x.paymentSource ?? 'unspecified',
    supplier: x.supplier, receiptNumber: x.receiptNumber,
    discountSen: x.discountSen, taxSen: x.taxSen, printedTotalSen: x.printedTotalSen, difference: null,
    lines: x.lines.map((l, i) => {
      const ingredientId = isFoodCategory(l.category) ? matchIngredient(l.name, ingredients) : null;
      return {
        lineId: `l${i + 1}`, name: l.name ?? '', category: l.category, grossSen: l.amountSen, quantity: l.quantity, unit: l.unit, note: '',
        ingredientId, payment: l.payment ?? 'inherit', includeInBusiness: true, excludeReason: null,
        periodMonth: l.category === 'rent' || l.category === 'fridge_power' ? l.periodMonth : null, workDays: null,
      };
    }),
  };
}

/** 空白手动草稿：不调用模型时使用。 */
export function emptyEditedDraft(date: string): EditedCostDraft {
  return {
    purchaseDate: date, currency: 'MYR', payment: 'unknown', paymentSource: 'unspecified', supplier: null, receiptNumber: null,
    discountSen: 0, taxSen: 0, printedTotalSen: null, difference: null,
    lines: [{ lineId: 'l1', name: '', category: 'unknown', grossSen: null, quantity: null, unit: null, note: '', ingredientId: null, payment: 'inherit', includeInBusiness: true, excludeReason: null, periodMonth: null, workDays: null }],
  };
}
