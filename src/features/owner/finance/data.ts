/**
 * 收支改版的数据：一次读取老板端需要的配置、批次、开档成本、目标与账本（受 Rules 限制，仅老板可读）。
 * 单店数据量小，首版直接全量读取支出 / 收款 / 退款以计算回本；订单、成本事件只读近期区间。
 * 所有数字由领域函数计算，没有示例数据。
 */
import { useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db, storePath } from '../../../data/firebase/client';
import { CommandFailure, CommandName, newOperationId, submit } from '../../../data/firebase/commands';
import { reasonText } from '../../../data/firebase/reasons';
import {
  BatchDoc, BUILT_IN_INGREDIENTS, CostCoverage, DEFAULT_COST_COVERAGE, DEFAULT_EXPENSE_PLAN, ExpenseLinkDoc, DEFAULT_FIXED_COST, DEFAULT_SALES_TARGETS, ExpensePlan, FixedCostPolicy, GoalDoc, Ingredient,
  SalesTargets, StartupCostDoc,
} from '../../../domain';
import type { CostEventDoc, ExpenseDoc, OrderReportRow, PaymentDoc, RefundDoc, WastageDoc } from '../../../domain/ledger';
import { useLoad } from '../data';

async function all<T>(name: string, ...c: ReturnType<typeof where>[]): Promise<T[]> {
  const snap = await getDocs(query(collection(db, storePath(name)), ...c));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
}

export interface FinanceData {
  plan: ExpensePlan;
  sales: SalesTargets;
  goalsConfig: { paybackAchievedAtMs?: number };
  startupSeeded: boolean;
  fixedPolicy: FixedCostPolicy;
  ingredients: Ingredient[];
  batches: BatchDoc[];
  startup: StartupCostDoc[];
  goals: GoalDoc[];
  expenses: ExpenseDoc[];
  payments: PaymentDoc[];
  refunds: RefundDoc[];
  /** 近期（recentStart 起）的订单、成本事件与损耗。 */
  orders: OrderReportRow[];
  costEvents: CostEventDoc[];
  wastage: WastageDoc[];
  recentStart: string;
  /** 老板确认的旧账 / 资本支出归属。 */
  links: ExpenseLinkDoc[];
  coverage: CostCoverage;
  /** AI 记成本：采购明细（用量待补 / 已建库存）与来源凭证（原话、收据图片路径、分摊与差额）。 */
  purchaseDetails: PurchaseDetailDoc[];
  costReceipts: CostReceiptDoc[];
}

export interface PurchaseDetailDoc {
  id: string; expenseId: string; draftId: string; receiptId: string; name: string; costCategory: string; ingredientCategory: string | null; ingredientId: string | null;
  quantity: number | null; unit: string | null; amountSen: number; purchasedDate: string; usageState: 'pending' | 'stocked'; batchId: string | null; revision: number;
}
export interface CostReceiptDoc {
  id: string; draftId: string; businessDate: string; source: 'text' | 'receipt' | 'manual'; text: string | null; attachments: { path: string }[]; expenseIds: string[];
  totalSen: number; printedTotalSen: number | null; computedTotalSen: number; discountSen: number; taxSen: number; supplier: string | null; receiptNumber: string | null;
  difference: { acceptedTotalSen: number; reason: string } | null; excluded: { lineId: string; name: string; netSen: number; reason: string }[];
  extractionMeta: { provider: string; model: string } | null; createdAtMs: number; duplicateAcknowledgement: { candidateId: string; reason: string } | null;
}

export async function loadFinance(recentStart: string): Promise<FinanceData> {
  const cfg = (name: string) => getDoc(doc(db, storePath(`config/${name}`))).then((s) => s.data());
  const since = where('businessDate', '>=', recentStart);
  const [plan, goals, startupCfg, finance, coverageCfg, links, custom, batches, startup, goalDocs, expenses, payments, refunds, orders, costEvents, wastage, purchaseDetails, costReceipts] = await Promise.all([
    cfg('expensePlan'), cfg('goals'), cfg('startup'), cfg('finance'), cfg('costCoverage'), all<ExpenseLinkDoc>('expenseLinks'),
    all<Ingredient & { active?: boolean }>('ingredients'), all<BatchDoc>('ingredientBatches'), all<StartupCostDoc>('startupCosts'), all<GoalDoc>('goals'),
    all<ExpenseDoc>('expenses'), all<PaymentDoc>('payments'), all<RefundDoc>('refunds'),
    all<OrderReportRow>('orders', since), all<CostEventDoc>('costEvents', since), all<WastageDoc>('wastage', since),
    all<PurchaseDetailDoc>('purchaseDetails'), all<CostReceiptDoc>('costReceipts'),
  ]);
  return {
    plan: { ...DEFAULT_EXPENSE_PLAN, ...(plan?.plan ?? {}) },
    sales: { ...DEFAULT_SALES_TARGETS, ...(goals?.sales ?? {}) },
    goalsConfig: { paybackAchievedAtMs: goals?.paybackAchievedAtMs },
    startupSeeded: Boolean(startupCfg?.seededAtMs),
    fixedPolicy: (finance?.fixedCostPolicy as FixedCostPolicy | undefined) ?? DEFAULT_FIXED_COST,
    ingredients: [...BUILT_IN_INGREDIENTS, ...custom.filter((i) => i.active !== false).map((i) => ({ ...i, builtIn: false }))],
    links, coverage: { ...DEFAULT_COST_COVERAGE, ...((coverageCfg?.coverage as CostCoverage | undefined) ?? {}) },
    batches, startup, goals: goalDocs.sort((a, b) => a.createdAtMs - b.createdAtMs), expenses, payments, refunds, orders, costEvents, wastage, recentStart, purchaseDetails, costReceipts,
  };
}

export function useFinance(recentStart: string) {
  return useLoad(() => (recentStart ? loadFinance(recentStart) : Promise.resolve(null)), `finance-${recentStart}`);
}

/** 失败说明：已知原因码给中文；服务端的具体校验说明（中文）一并显示。 */
export function failureText(e: unknown): string {
  if (!(e instanceof CommandFailure)) return String(e);
  const base = reasonText(e.reasonCode);
  const detail = e.message && !/^[A-Z_]+$/.test(e.message) && !e.message.includes('internal') && e.kind === 'rejected' ? e.message : '';
  return detail && detail !== base ? `${base}：${detail}` : base;
}

/** 写命令：同一 operationId 防重复提交；成功后刷新数据。 */
export function useRunner(refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string; at: number } | null>(null);
  async function run(name: CommandName, payload: Record<string, unknown>, okText: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await submit(name, { operationId: newOperationId(), ...payload });
      setToast({ ok: true, text: okText, at: Date.now() });
      refresh();
      return true;
    } catch (e) {
      setToast({ ok: false, text: failureText(e), at: Date.now() });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, toast, clearToast: () => setToast(null), run };
}

export type Runner = ReturnType<typeof useRunner>['run'];
