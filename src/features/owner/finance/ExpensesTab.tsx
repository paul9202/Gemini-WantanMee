/** 日常开支：租金（阶段）、冰箱额外电费、员工工资（默认未启用）、煤气、杂费。预算、应付、已付分开；每月固定项只能登记一笔。 */
import { useState } from 'react';
import { addMonths, classifyExpenses, formatRM, LINK_KIND_ZH, monthOf, MonthlyPlanRow, PLAN_ITEM_ZH, rentMonthIndex, unpaidExpenses, PlanExpense } from '../../../domain';
import { Icon } from '../../../ui/visual';
import type { IconName } from '../../../ui/iconSymbols';
import type { TabProps } from '../FinancePage';
import { planRows, sumSen } from './model';
import { Btn, Empty, IconTile, Metric, Note, PageHead, Panel, Row, shortDate, Tag } from './ui';

const ICON: Record<string, IconName> = { rent: 'rent', fridge_power: 'plug', wage: 'users', gas: 'flame', misc: 'receipt' };

export function ExpensesTab({ data, today, open, run, busy }: TabProps) {
  const [month, setMonth] = useState(monthOf(today));
  const rows = Object.fromEntries(planRows(data, month).map((r) => [r.item, r])) as Record<string, MonthlyPlanRow>;
  const plan = data.plan;
  const idx = rentMonthIndex(plan, month);
  const fixedBudget = rows.rent.budgetSen === null ? null : (rows.rent.budgetSen ?? 0) + (rows.fridge_power.budgetSen ?? 0);
  const monthExpenses = data.expenses.filter((e) => e.periodMonth === month || (e.category !== 'purchase' && monthOf(e.businessDate) === month))
    .filter((e) => e.category !== 'purchase').sort((a, b) => b.occurredAtMs - a.occurredAtMs);
  const unpaid = unpaidExpenses(data.expenses as PlanExpense[]);
  const cls = classifyExpenses(data.expenses as PlanExpense[], data.links);
  const toConfirm = [...cls.legacyUnlinked.map((x) => ({ ...x, why: '旧版固定费用付款，未确认归属月份' })), ...cls.unclassifiedCapital.map((x) => ({ ...x, why: '资本支出，未确认是开档投入还是后续投入' }))];
  const activeLinks = data.links.flatMap((d) => d.links.filter((l) => l.status === 'active').map((l) => ({ l, e: data.expenses.find((x) => x.id === d.expenseId) })));
  const startupTitle = (id: string) => data.startup.find((s) => s.id === id)?.title ?? id;
  const linkedOf = (id: string) => (data.links.find((d) => d.expenseId === id)?.links ?? []).filter((l) => l.status === 'active').reduce((s, l) => s + l.amountSen, 0);
  const isPast = month < monthOf(today);
  const toggleStaff = () => run('setExpensePlan', { rentStartMonth: plan.rentStartMonth, staffEnabled: !plan.staff.enabled }, plan.staff.enabled ? '已停用员工工资' : '已启用员工工资：按实际出勤登记');

  const fixedAction = (r: MonthlyPlanRow) => {
    if (r.state === 'unset') return <Btn small onClick={() => open({ kind: 'rentStart' })}>先设置起租月份</Btn>;
    if (r.state === 'not_started') return <Tag>起租前</Tag>;
    if (r.state === 'covered') return <Tag tone="green">开档已付</Tag>;
    if (r.state === 'paid') return <Tag tone="green">已付 {formatRM(r.paidSen)}</Tag>;
    return <Btn small onClick={() => open({ kind: 'recurring', item: r.item as 'rent' | 'fridge_power', month, dueSen: r.outstandingSen })}>登记付款</Btn>;
  };

  return (
    <>
      <PageHead eyebrow="RUNNING COSTS / 每一笔，都记得轻松一点" title="日常开支，照着项目记。" sub="固定费用设一次，煤气和杂费随手记；还没请人的工资先不计入。"
        actions={<>
          <label className="flex min-h-12 items-center gap-2 rounded-xl border border-[#d6d9cc] bg-card px-3 text-sm font-semibold"><Icon name="calendar" size={18} />
            <span className="sr-only">月份</span><input type="month" value={month} max={addMonths(monthOf(today), 1)} onChange={(e) => setMonth(e.target.value || monthOf(today))} className="min-w-0 bg-transparent" />
          </label>
          <Btn tone="primary" onClick={() => open({ kind: 'planExpense', item: 'misc' })}><Icon name="plus" size={18} />记日常开支</Btn>
        </>} />

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="本月固定费用" icon="rent" value={fixedBudget} sub={fixedBudget === null ? '未设置起租月份' : '租金 + 冰箱额外电费（预算）'} />
        <Metric label="员工日薪预算" icon="users" value={plan.staff.dailyBudgetSen} sub={plan.staff.enabled ? `已启用 · 本月实际 ${formatRM(rows.wage.actualSen)}` : '未招聘 · 不计入实际支出'} />
        <Metric label="本月煤气" icon="flame" value={rows.gas.actualSen} sub={`${rows.gas.payments.length} 笔 · 按实际金额`} />
        <Metric label="本月杂费" icon="receipt" value={rows.misc.actualSen} sub={`${rows.misc.payments.length} 笔${rows.misc.outstandingSen ? ` · 待付 ${formatRM(rows.misc.outstandingSen)}` : ''}`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(290px,1fr)]">
        <Panel pad={false} title="我的 5 项日常开支" sub="常用项目直接记，不用每次重新分类">
          <Item icon="rent" title="档口租金" tag={idx ? <Tag tone="green">第 {idx} 个月</Tag> : plan.rentStartMonth ? <Tag>起租前</Tag> : <Tag tone="gold">未设置起租月</Tag>}
            desc="前三个月 RM800 / 月，第 4 个月起 RM1,000 / 月。"
            extra={<>
              <div className="mt-3 flex max-w-[270px] gap-1.5" aria-label="租金阶段">{[1, 2, 3, 4, 5, 6].map((i) => <span key={i} className={`h-1.5 flex-1 rounded ${idx === i ? 'bg-ok' : i <= 3 ? 'bg-[#d7dfce]' : 'bg-[#d4b79c]'}`} />)}</div>
              <Btn small tone="ghost" className="mt-2" onClick={() => open({ kind: 'rentStart' })}>{plan.rentStartMonth ? `起租月 ${plan.rentStartMonth} · 修改` : '设置起租月份'}</Btn>
              {rows.rent.coveredByStartupSen > 0 && <p className="text-xs text-ink-2">开档成本已付本月租金 {formatRM(rows.rent.coveredByStartupSen)}，本月不再收。</p>}
            </>}
            price={rows.rent.budgetSen === null ? '待设置' : formatRM(rows.rent.budgetSen)} unit="/ 月" action={fixedAction(rows.rent)} />
          <Item icon="plug" title="冰箱额外电费" tag={<Tag>固定费用</Tag>} desc="每月固定 RM100，与租金分开显示。"
            price={formatRM(plan.fridgeMonthlySen)} unit="/ 月" action={fixedAction(rows.fridge_power)} />
          <Item icon="users" title="员工工资" tag={<Tag tone={plan.staff.enabled ? 'green' : 'gold'}>{plan.staff.enabled ? '已启用' : '未招聘'}</Tag>}
            desc={`日薪暂定 ${formatRM(plan.staff.dailyBudgetSen)}；招到人后按实际出勤记录。`}
            extra={<label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
              <button type="button" role="switch" aria-checked={plan.staff.enabled} aria-label="启用员工工资" disabled={busy} onClick={() => void toggleStaff()}
                className={`relative h-7 w-12 rounded-full ${plan.staff.enabled ? 'bg-ok' : 'bg-[#c5cbbf]'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${plan.staff.enabled ? 'left-6' : 'left-1'}`} /></button>
              {plan.staff.enabled ? '已启用工资记录' : '招聘后再启用'}
            </label>}
            price={formatRM(plan.staff.dailyBudgetSen)} unit="/ 天" action={<Btn small disabled={!plan.staff.enabled} onClick={() => open({ kind: 'planExpense', item: 'wage' })}>记出勤工资</Btn>} />
          <Item icon="flame" title="煤气" desc="换一桶记一笔，金额按实际账单填写。" action={<Btn small onClick={() => open({ kind: 'planExpense', item: 'gas' })}><Icon name="plus" size={16} />换气记账</Btn>} />
          <Item icon="receipt" title="杂费" desc="清洁、维修及其他营业小开支。" action={<Btn small onClick={() => open({ kind: 'planExpense', item: 'misc' })}><Icon name="plus" size={16} />记一笔</Btn>} />
        </Panel>

        <aside className="grid min-w-0 content-start gap-5">
          <Panel title={isPast ? `${month}，固定费用` : '这个月，固定要准备'} sub="预算、应付和已付分开看" actions={<Tag tone="green">{month}</Tag>}>
            {(['rent', 'fridge_power'] as const).map((k) => {
              const r = rows[k];
              return <Row key={k} title={PLAN_ITEM_ZH[k]} sub={r.budgetSen === null ? '待设置起租月份' : `预算 ${formatRM(r.budgetSen)}${r.coveredByStartupSen ? ` · 开档已付 ${formatRM(r.coveredByStartupSen)}` : ''} · 应付 ${formatRM(r.dueSen ?? 0)}`}
                right={<span className="text-right text-sm"><b className="block tabular-nums">已付 {formatRM(r.paidSen)}</b>{r.outstandingSen > 0 && <small className="text-warn">未付 {formatRM(r.outstandingSen)}</small>}</span>} />;
            })}
            <Row title="员工工资" sub={plan.staff.enabled ? '按实际出勤另外记录' : '暂不计入'} right={<span className="text-sm text-ink-2">{plan.staff.enabled ? formatRM(rows.wage.actualSen) : '—'}</span>} />
            <div className="mt-3 flex items-center justify-between border-t border-dashed border-line pt-3 text-sm">
              <span>固定费用应付 / 月</span><strong className="text-2xl text-ok tabular-nums">{rows.rent.dueSen === null ? '待设置' : formatRM((rows.rent.dueSen ?? 0) + (rows.fridge_power.dueSen ?? 0))}</strong>
            </div>
            <p className="mt-2 text-xs text-ink-2">煤气、杂费按实际记账；日薪预算不会自动变成已付工资。</p>
          </Panel>

          {(toConfirm.length > 0 || activeLinks.length > 0) && (
            <Panel title="旧账与资本支出的归属" sub="确认后才计入正确的口径；只记录归属，不改原付款，已关账日也可以确认" actions={toConfirm.length ? <Tag tone="gold">{toConfirm.length} 笔待确认</Tag> : <Tag tone="green">已确认</Tag>}>
              {toConfirm.map(({ expense, sen, why }) => {
                const e = data.expenses.find((x) => x.id === expense.id)!;
                return <Row key={e.id} icon="receipt" tone="warm" title={`${e.description} · ${formatRM(sen)} 待确认`} sub={`${e.businessDate} 付款 · ${why}`} right={<Btn small onClick={() => open({ kind: 'link', expense: e })}>确认归属</Btn>} />;
              })}
              {activeLinks.map(({ l, e }) => (
                <Row key={l.linkId} icon="check" title={`${e?.description ?? l.linkId} → ${l.kind === 'recurring' ? `${l.month} ${PLAN_ITEM_ZH[l.item]}` : l.kind === 'startup' ? `开档：${startupTitle(l.startupId)}` : LINK_KIND_ZH[l.kind]}`}
                  sub={`${formatRM(l.amountSen)} · ${e?.businessDate ?? ''} 的付款`}
                  right={<Btn small tone="ghost" onClick={() => open({ kind: 'unlink', expenseId: e?.id ?? '', linkId: l.linkId, label: e?.description ?? '' })}>取消归属</Btn>} />
              ))}
            </Panel>
          )}

          {unpaid.length > 0 && (
            <Panel title="待付" sub="记了但还没付的开支与进货">
              {unpaid.map(({ expense, outstandingSen }) => {
                const e = data.expenses.find((x) => x.id === expense.id)!;
                return <Row key={e.id} icon="receipt" tone="warm" title={e.description} sub={`${shortDate(e.businessDate)} 记录`} right={<Btn small onClick={() => open({ kind: 'settle', expense: e, outstandingSen })}>付 {formatRM(outstandingSen)}</Btn>} />;
              })}
            </Panel>
          )}

          <Panel title="这个月记过的开支" sub={`${month} · 按付款日或所属月份`}>
            {!monthExpenses.length ? <Empty>这个月还没有日常开支记录。</Empty> : monthExpenses.slice(0, 12).map((e) => (
              <Row key={e.id} icon={ICON[e.planItem ?? 'misc'] ?? 'receipt'} title={<span className={e.status === 'voided' ? 'line-through opacity-60' : ''}>{e.description}</span>}
                sub={`${shortDate(e.businessDate)} · ${e.status === 'voided' ? `已作废：${e.voidReason ?? ''}` : e.settlesExpenseId ? '补付款' : e.paidSen ? '已付' : '未付'}`}
                right={<span className="flex items-center gap-1"><b className="text-sm tabular-nums">{formatRM(-(e.settlesExpenseId ? e.paidSen : e.amountSen))}</b>
                  {/* 旧版未分类的记录（例如把房租记成营业费用）：可确认归属到月租 / 电费或开档项目。 */}
                  {e.status === 'active' && !e.ingredientBatchId && !e.planItem && !e.settlesExpenseId && e.category !== 'purchase' && linkedOf(e.id) < e.amountSen && <Btn small tone="ghost" onClick={() => open({ kind: 'link', expense: e })}>归属</Btn>}
                  {e.status === 'active' && !e.ingredientBatchId && <Btn small tone="ghost" onClick={() => open({ kind: 'voidExpense', expense: e })}>作废</Btn>}</span>} />
            ))}
            {monthExpenses.length > 0 && <p className="mt-2 text-xs text-ink-2">本月已付合计 {formatRM(sumSen(monthExpenses.filter((e) => e.status === 'active'), (e) => e.paidSen))}</p>}
          </Panel>
          <Note>登记房租付款后，现金支出显示整笔金额；计算经营成本时按月份分摊，不重复扣除。开档成本里已付的同月租金不会再要求付款。</Note>
        </aside>
      </div>
    </>
  );
}

function Item({ icon, title, tag, desc, extra, price, unit, action }: { icon: IconName; title: string; tag?: React.ReactNode; desc: string; extra?: React.ReactNode; price?: string; unit?: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-4 border-b border-line px-5 py-5 last:border-0 sm:flex-nowrap sm:px-6">
      <IconTile name={icon} />
      <div className="min-w-0 flex-1">
        <h4 className="flex flex-wrap items-center gap-2 font-bold">{title}{tag}</h4>
        <p className="mt-1 text-xs text-ink-2">{desc}</p>
        {extra}
      </div>
      <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:flex-col sm:items-end">
        {price && <div className="text-xl font-semibold tabular-nums">{price}<small className="ml-1 text-xs font-normal text-ink-2">{unit}</small></div>}
        {action}
      </div>
    </div>
  );
}
