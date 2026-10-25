/** AI 记成本界面用的小工具：分类选项、空白行、金额输入。账务计算一律用 domain/aiCost，不在这里另算。 */
import { COST_CATEGORY_ZH, CostCategoryOrUnknown, CostDraftLine, EditedCostDraft, formatRM, isFoodCategory, Sen } from '../../../domain';

export const CATEGORY_GROUPS: { label: string; items: CostCategoryOrUnknown[] }[] = [
  { label: '食材', items: ['noodle', 'wonton', 'topping', 'seasoning', 'other_food'] },
  { label: '日常开支', items: ['gas', 'misc', 'wage'] },
  { label: '每月固定（按月份登记一次）', items: ['rent', 'fridge_power'] },
];

export const categoryLabel = (c: CostCategoryOrUnknown) => COST_CATEGORY_ZH[c];

export function kindHint(c: CostCategoryOrUnknown): string {
  if (c === 'unknown') return '请选择分类后才能保存';
  if (isFoodCategory(c)) return '归入食材采购 · 保存前可修改';
  if (c === 'rent' || c === 'fridge_power') return '每月固定费用 · 同一个月只能登记一笔';
  return '归入日常开支 · 保存前可修改';
}

export function newLine(lines: CostDraftLine[]): CostDraftLine {
  const n = Math.max(0, ...lines.map((l) => Number(l.lineId.replace(/\D/g, '')) || 0)) + 1;
  return { lineId: `l${n}`, name: '', category: 'unknown', grossSen: null, quantity: null, unit: null, note: '', ingredientId: null, payment: 'inherit', includeInBusiness: true, excludeReason: null, periodMonth: null, workDays: null };
}

export const senText = (sen: Sen | null) => (sen === null ? '' : (sen / 100).toFixed(2));
export const rm = (sen: Sen) => formatRM(sen);

/** 草稿内容是否相同（用于判断是否需要保存）。 */
export const sameDraft = (a: EditedCostDraft | null, b: EditedCostDraft | null) => JSON.stringify(a) === JSON.stringify(b);

export const SOURCE_LABEL: Record<string, string> = { text: '文字输入', receipt: '收据照片', manual: '手动填写' };
