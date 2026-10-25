/**
 * 收支（2026-10-25 改版）：收支总览、AI 记成本（含详细用料管理）、日常开支、经营目标、开档成本五个子页。
 * - 钱箱资金往来的录入与列表已移除；旧记录仍留在账本中，日结与历史报表照常读取。
 * - 所有写入经 Callable 命令（老板权限、幂等、审计、关账屏障）；记录不删除，只作废并可更正。
 * - 数字全部来自真实账目；成本资料不全时显示「待核算」或「暂估」，不给虚假的精确利润。
 */
import { useState } from 'react';
import { navigate, Route } from '../../app/router';
import { useSession } from '../../app/session';
import { addDays, BatchDoc, businessDateOf, IngredientCategory, monthOf, RecurringItem, Sen, StartupCostDoc } from '../../domain';
import type { ExpenseDoc } from '../../domain/ledger';
import { useNow } from '../../data/firebase/live';
import { OwnerTabs } from './ui';
import { FinanceData, useFinance, useRunner } from './finance/data';
import {
  AddIngredientDialog, BatchCostDialog, LinkExpenseDialog, BatchHistoryDialog, ExistingBatchDialog, FinishBatchDialog, NextGoalDialog, PlanExpenseDialog, PurchaseDialog,
  RecurringPaymentDialog, RentStartDialog, SalesTargetDialog, SettleDialog, SplitRentDialog, StartBatchDialog, StartupAddDialog, StartupCorrectDialog,
  StartupPaymentDialog, VoidDialog,
} from './finance/dialogs';
import { Btn, Dialog, FinanceNav, Toast } from './finance/ui';
import { OverviewTab } from './finance/OverviewTab';
import { ExpensesTab } from './finance/ExpensesTab';
import { GoalsTab } from './finance/GoalsTab';
import { StartupTab } from './finance/StartupTab';
import { AiCostPage } from './aiCost/AiCostPage';

export type DialogState =
  | { kind: 'existing'; ingredientId?: string }
  | { kind: 'purchase'; ingredientId?: string }
  | { kind: 'start'; ingredientId: string }
  | { kind: 'finish'; batch: BatchDoc }
  | { kind: 'cost'; batch: BatchDoc }
  | { kind: 'voidBatch'; batch: BatchDoc }
  | { kind: 'history'; ingredientId: string }
  | { kind: 'addIngredient'; category: IngredientCategory }
  | { kind: 'rentStart' }
  | { kind: 'recurring'; item: RecurringItem; month: string; dueSen: Sen }
  | { kind: 'planExpense'; item: 'gas' | 'misc' | 'wage' }
  | { kind: 'settle'; expense: ExpenseDoc; outstandingSen: Sen }
  | { kind: 'voidExpense'; expense: ExpenseDoc }
  | { kind: 'voidWastage'; id: string; label: string }
  | { kind: 'startupAdd' }
  | { kind: 'startupCorrect'; item: StartupCostDoc }
  | { kind: 'startupPay'; item: StartupCostDoc }
  | { kind: 'startupSplit'; item: StartupCostDoc }
  | { kind: 'salesTarget'; scope: 'daily' | 'monthly'; current: number | null; month: string }
  | { kind: 'nextGoal' }
  | { kind: 'chooser' }
  | { kind: 'link'; expense: ExpenseDoc }
  | { kind: 'unlink'; expenseId: string; linkId: string; label: string }
  | { kind: 'archiveGoal'; goalId: string; title: string };

export interface TabProps {
  data: FinanceData;
  today: string;
  nowMs: number;
  tz: string;
  policy: { timeZone: string; cutoverMinutes: number };
  open: (d: DialogState) => void;
  run: ReturnType<typeof useRunner>['run'];
  busy: boolean;
}

export function FinancePage({ route = '/owner/finance' }: { route?: Route }) {
  const { config } = useSession();
  const now = useNow(60_000);
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  // 近期数据：本月与近 7 天（取较早者），用于销量、理论成本暂估与走势。
  const recentStart = today ? [addDays(today, -6), `${monthOf(today)}-01`].sort()[0] : '';
  const fin = useFinance(recentStart);
  const { busy, toast, clearToast, run } = useRunner(fin.refresh);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  if (!config) return null;
  const tz = config.timeZone;
  const close = () => setDialog(null);
  const data = fin.data;
  const props: TabProps | null = data ? { data, today, nowMs: now, tz, policy: { timeZone: tz, cutoverMinutes: config.cutoverMinutes }, open: setDialog, run, busy } : null;
  const base = { run, busy, onClose: close };

  return (
    <div className="mx-auto max-w-[1500px] p-4 pb-10 lg:p-8">
      <OwnerTabs current="/owner/finance" />
      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
        <aside><FinanceNav current={route} /></aside>
        <div className="min-w-0">
          {fin.error && <p role="alert" className="mb-4 rounded-xl bg-danger-bg px-4 py-3 text-danger">读取失败（{fin.error}）。<button type="button" className="underline" onClick={fin.refresh}>重试</button></p>}
          {!props ? <p className="py-16 text-center text-ink-2">{fin.loading ? '正在载入收支资料…' : '没有数据'}</p> : (
            <>
              {route === '/owner/finance' && <OverviewTab {...props} />}
              {route === '/owner/finance/ingredients' && <AiCostPage {...props} refresh={fin.refresh} />}
              {route === '/owner/finance/expenses' && <ExpensesTab {...props} />}
              {route === '/owner/finance/goals' && <GoalsTab {...props} />}
              {route === '/owner/finance/startup' && <StartupTab {...props} />}
              <footer className="mt-6 flex flex-wrap justify-between gap-3 text-xs text-ink-2">
                <span>数字来自已登记的账目 · 成本资料不全时标为「待核算 / 暂估」</span>
                <span>{fin.loadedAt ? `更新于 ${new Date(fin.loadedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''} · <button type="button" className="min-h-11 underline" onClick={fin.refresh}>刷新</button></span>
              </footer>
            </>
          )}
        </div>
      </div>

      {data && dialog && (() => {
        switch (dialog.kind) {
          case 'existing': return <ExistingBatchDialog {...base} data={data} ingredientId={dialog.ingredientId} tz={tz} nowMs={now} />;
          case 'purchase': return <PurchaseDialog {...base} data={data} ingredientId={dialog.ingredientId} today={today} />;
          case 'start': return <StartBatchDialog {...base} data={data} ingredientId={dialog.ingredientId} tz={tz} nowMs={now} />;
          case 'finish': return <FinishBatchDialog {...base} batch={dialog.batch} tz={tz} nowMs={now} />;
          case 'cost': return <BatchCostDialog {...base} batch={dialog.batch} />;
          case 'voidBatch': return (
            <VoidDialog busy={busy} onClose={close} title={`作废这一批 ${dialog.batch.ingredientName}`}
              sub={dialog.batch.origin === 'purchase' ? '进货批次作废时，对应的进货支出一并作废（其营业日必须未关账）。' : '首次录入的批次没有支出，只作废批次。'}
              onConfirm={(reason) => run('voidBatch', { batchId: dialog.batch.id, reason }, '已作废')} />
          );
          case 'history': {
            const ing = data.ingredients.find((i) => i.id === dialog.ingredientId)!;
            return (
              <BatchHistoryDialog ingredient={ing} batches={data.batches.filter((b) => b.ingredientId === ing.id)} expenses={data.expenses} tz={tz} nowMs={now} onClose={close}
                onAction={(a, b) => {
                  if (a === 'start') setDialog({ kind: 'start', ingredientId: b.ingredientId });
                  else if (a === 'finish') setDialog({ kind: 'finish', batch: b });
                  else if (a === 'cost') setDialog({ kind: 'cost', batch: b });
                  else if (a === 'void') setDialog({ kind: 'voidBatch', batch: b });
                  else {
                    const e = data.expenses.find((x) => x.id === b.purchaseExpenseId);
                    if (e) setDialog({ kind: 'settle', expense: e, outstandingSen: e.amountSen - e.paidSen });
                  }
                }} />
            );
          }
          case 'addIngredient': return <AddIngredientDialog {...base} category={dialog.category} />;
          case 'rentStart': return <RentStartDialog {...base} data={data} today={today} />;
          case 'recurring': return <RecurringPaymentDialog {...base} item={dialog.item} month={dialog.month} dueSen={dialog.dueSen} today={today} />;
          case 'planExpense': return <PlanExpenseDialog {...base} item={dialog.item} staffDailySen={data.plan.staff.dailyBudgetSen} today={today} />;
          case 'settle': return <SettleDialog {...base} expense={dialog.expense} outstandingSen={dialog.outstandingSen} today={today} />;
          case 'voidExpense': return (
            <VoidDialog busy={busy} onClose={close} title={`作废「${dialog.expense.description}」`} sub="作废后不计入收支；需要时另记一笔正确的。已关账营业日的记录请走日结更正。"
              onConfirm={(reason) => run('voidLedgerEntry', { kind: 'expense', id: dialog.expense.id, reason }, '已作废')} />
          );
          case 'voidWastage': return (
            <VoidDialog busy={busy} onClose={close} title={`作废损耗「${dialog.label}」`} sub="作废后不计入损耗成本，记录保留。"
              onConfirm={(reason) => run('voidLedgerEntry', { kind: 'wastage', id: dialog.id, reason }, '已作废')} />
          );
          case 'startupAdd': return <StartupAddDialog {...base} today={today} />;
          case 'startupCorrect': return <StartupCorrectDialog {...base} item={dialog.item} />;
          case 'startupPay': return <StartupPaymentDialog {...base} item={dialog.item} today={today} />;
          case 'startupSplit': return <SplitRentDialog {...base} item={dialog.item} />;
          case 'salesTarget': return <SalesTargetDialog {...base} scope={dialog.scope} current={dialog.current} month={dialog.month} />;
          case 'nextGoal': return <NextGoalDialog {...base} today={today} />;
          case 'link': return <LinkExpenseDialog {...base} data={data} expense={dialog.expense} />;
          case 'unlink': return (
            <VoidDialog busy={busy} onClose={close} title={`取消归属：${dialog.label}`} sub="关联记录保留并标为已取消；原付款不变。之后可以重新确认。" confirmLabel="取消归属"
              onConfirm={(reason) => run('unlinkExpense', { expenseId: dialog.expenseId, linkId: dialog.linkId, reason }, '已取消归属')} />
          );
          case 'archiveGoal': return (
            <VoidDialog busy={busy} onClose={close} title={`放弃目标「${dialog.title}」`} sub="目标保留在记录里并标为已放弃，之后可以重新拟定。" confirmLabel="放弃这个目标" reasonLabel="原因"
              onConfirm={(reason) => run('archiveGoal', { goalId: dialog.goalId, reason }, '目标已放弃')} />
          );
          case 'chooser': return (
            <Dialog title="记一笔支出" sub="选一个项目，表单会按项目预设。" onClose={close} footer={<Btn onClick={close} className="w-full sm:w-auto">取消</Btn>}>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {([
                  ['AI 记成本', '说一句或拍收据，整理后核对再保存', () => { close(); navigate('/owner/finance/ingredients'); }],
                  ['食材进货', '记数量、金额与付款，放入库存', () => setDialog({ kind: 'purchase' })],
                  ['煤气', '换一桶记一笔', () => setDialog({ kind: 'planExpense', item: 'gas' })],
                  ['杂费', '清洁、维修及其他', () => setDialog({ kind: 'planExpense', item: 'misc' })],
                  ...(data.plan.staff.enabled ? [['员工工资', '按实际出勤', () => setDialog({ kind: 'planExpense', item: 'wage' })] as const] : []),
                  ['租金 / 冰箱电费', '每月一笔，到日常开支登记', () => { close(); navigate('/owner/finance/expenses'); }],
                ] as const).map(([t, s, go]) => (
                  <button key={t} type="button" onClick={go} className="min-h-16 rounded-xl border border-line bg-card px-4 py-3 text-left hover:bg-subtle"><b className="block">{t}</b><small className="text-xs text-ink-2">{s}</small></button>
                ))}
              </div>
            </Dialog>
          );
        }
      })()}
      <Toast toast={toast} onClose={clearToast} />
    </div>
  );
}
