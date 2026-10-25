/** 收支总览：实际收款、已付支出、收支结余、食材消耗成本、经营利润分开显示；回本与面量目标；食材与待付提醒。 */
import { useState } from 'react';
import { navigate } from '../../../app/router';
import { addDays, BUILT_IN_INGREDIENTS, DateRange, formatRM, monthOf, monthRange, unpaidExpenses, PlanExpense, ballsText } from '../../../domain';
import { Icon } from '../../../ui/visual';
import type { TabProps } from '../FinancePage';
import { dailySeries, last7, payback, rangeFigures } from './model';
import { Btn, Empty, IconTile, Metric, Note, PageHead, Panel, Progress, Row, shortDate, Tag } from './ui';

export function OverviewTab({ data, today, nowMs, policy, open }: TabProps) {
  const [date, setDate] = useState(today);
  const [chart, setChart] = useState<'7d' | 'month'>('7d');
  const day: DateRange = { start: date, endExclusive: addDays(date, 1) };
  const f = rangeFigures(data, day, policy, nowMs);
  const pb = payback(data, today).result;
  const series = dailySeries(data, chart === '7d' ? last7(today) : { start: monthRange(monthOf(today)).start, endExclusive: addDays(today, 1) });
  const todayBalls = rangeFigures(data, { start: today, endExclusive: addDays(today, 1) }, policy, nowMs).balls;
  const target = data.sales.dailyBalls;
  const dayExpenses = data.expenses.filter((e) => e.businessDate === date || (e.accrualDate === date && e.category === 'opex')).sort((a, b) => b.occurredAtMs - a.occurredAtMs);
  const stocked = data.batches.filter((b) => b.status === 'stocked');
  const untracked = BUILT_IN_INGREDIENTS.filter((i) => !data.batches.some((b) => b.ingredientId === i.id && b.status !== 'voided'));
  const costPending = data.batches.filter((b) => b.status !== 'voided' && b.costSen === null);
  const unpaid = unpaidExpenses(data.expenses as PlanExpense[]);
  const reminders = stocked.length + costPending.length + unpaid.length + (untracked.length ? 1 : 0);
  const isToday = date === today;
  const dayLabel = isToday ? '今日' : shortDate(date);

  return (
    <>
      <PageHead eyebrow="THE DAILY PICTURE / 每天一点，更近一步" title="今天的生意，一眼看清。" sub="收入、花费、食材和目标，都放在顺手的位置。"
        actions={<>
          <label className="flex min-h-12 items-center gap-2 rounded-xl border border-[#d6d9cc] bg-card px-3 text-sm font-semibold"><Icon name="calendar" size={18} />
            <span className="sr-only">营业日</span><input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} className="min-w-0 bg-transparent" />
          </label>
          <Btn tone="primary" onClick={() => open({ kind: 'chooser' })}><Icon name="plus" size={18} />记一笔支出</Btn>
        </>} />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Metric label={`${dayLabel}实际收款`} icon="wallet" value={f.receiptsNetSen} sub="已登记收款 · 退款已扣除" />
        <Metric label={`${dayLabel}已付支出`} icon="receipt" value={f.paidOutSen} sub={`进货 ${formatRM(f.paidPurchasesSen)} + 日常 ${formatRM(f.paidDailySen)} · 按付款日`} />
        <Metric label={`${dayLabel}收支结余`} icon="chart" value={f.balanceSen} sub="收款减已付支出 · 不代表利润" highlight />
        <Metric label="食材消耗成本" icon="leaf"
          sub={f.coverage.state === 'complete' ? '批次周期平均分摊，不是逐日实际用量' : `已记录批次周期平均 ${formatRM(f.consumption.costSen)}（不完整）· ${f.coverage.reasons.slice(0, 2).join('；')}${f.coverage.reasons.length > 2 ? ` 等 ${f.coverage.reasons.length} 项` : ''}`}>
          {f.coverage.state !== 'complete' ? <span className="text-2xl">待核算</span> : <><span className="mr-1.5 text-[13px] font-medium">RM</span>{formatRM(f.consumption.costSen).replace('RM', '')}</>}
        </Metric>
        <Metric label="经营利润" icon="target" value={f.profitSen}
          sub={f.profitSen !== null ? '周期平均分摊口径：收款 − 食材 − 固定费用分摊 − 其他营业费用' : `成本未证实完整。暂估 ${formatRM(f.estimatedProfitSen)}（按理论用量${f.fixedFromPlan ? '' : '，固定费用按旧设定'}），仅供参考`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
        <div className="grid min-w-0 content-start gap-5">
          <Panel title="钱花在哪，心里有数" sub={`${chart === '7d' ? '最近 7 天' : '本月'} · 已登记收款与实际付款`}
            actions={<div className="flex gap-1 rounded-lg bg-subtle p-1">{(['7d', 'month'] as const).map((c) => <button key={c} type="button" onClick={() => setChart(c)} aria-pressed={chart === c} className={`min-h-10 rounded-md px-3 text-xs ${chart === c ? 'bg-card font-semibold shadow-sm' : 'text-ink-2'}`}>{c === '7d' ? '近 7 天' : '本月'}</button>)}</div>}>
            <Bars series={series} today={today} />
            <div className="mt-4 flex items-start gap-2 border-t border-line pt-4 text-xs text-ink-2"><Icon name="info" size={15} className="mt-0.5 shrink-0" /><span>进货付款与食材消耗分开看。<b className="text-ink">这一批何时用完，才知道实际用了多少。</b></span></div>
          </Panel>

          <Panel title={`${isToday ? '今天' : shortDate(date)}的支出`} sub="按付款日；煤气、杂费等也按归属日列出" actions={<Btn tone="ghost" small onClick={() => navigate('/owner/finance/expenses')}>查看全部 <Icon name="arrow" size={16} /></Btn>}>
            {!dayExpenses.length ? <Empty>这一天还没有支出记录。</Empty> : dayExpenses.map((e) => (
              <Row key={e.id} icon={e.category === 'purchase' ? 'leaf' : e.planItem === 'rent' ? 'rent' : e.planItem === 'gas' ? 'flame' : 'receipt'} tone={e.category === 'purchase' ? 'warm' : 'green'}
                title={<span className={e.status === 'voided' ? 'line-through opacity-60' : ''}>{e.description}</span>}
                sub={`${e.category === 'purchase' ? '食材进货' : e.settlesExpenseId ? '补付款' : '日常开支'} · ${e.status === 'voided' ? `已作废：${e.voidReason ?? ''}` : e.paidSen ? '已付' : '未付'}`}
                right={<div className="flex items-center gap-2">
                  <span className="text-right text-sm font-semibold tabular-nums">{e.settlesExpenseId ? formatRM(-e.paidSen) : formatRM(-e.amountSen)}</span>
                  {e.status === 'active' && !e.ingredientBatchId && <Btn small tone="ghost" onClick={() => open({ kind: 'voidExpense', expense: e })}>作废</Btn>}
                </div>} />
            ))}
          </Panel>
        </div>

        <div className="grid min-w-0 content-start gap-5">
          <section className="relative overflow-hidden rounded-2xl border border-[#dce5d5] bg-[#edf2e8] p-6">
            <div className="text-[10px] tracking-[0.18em] text-[#667c5c]">OUR FIRST MILESTONE / 第一个目标 · 现金回本结余（参考）</div>
            <div className="mb-4 mt-3 flex items-center gap-3"><IconTile name="flag" /><h3 className="text-xl font-bold">赚回开档的每一分</h3></div>
            {pb.state === 'pending' ? (
              <><div className="text-2xl font-bold text-ok">待核算</div><p className="mt-2 text-sm text-[#5a6e52]">{pb.pendingReasons.join('；')}。</p><p className="mt-1 text-xs text-[#5a6e52]">目前按账面算：{formatRM(pb.recoveredSen)}（未核实）</p></>
            ) : (
              <>
                <div className="text-[28px] font-bold tracking-tight text-ok tabular-nums">{formatRM(pb.recoveredSen)} <small className="text-sm font-normal text-[#617159]">/ {formatRM(pb.targetSen)}</small></div>
                <div className="my-3"><Progress ratio={pb.barRatio} label="回本进度" /></div>
                <div className="flex justify-between gap-2 text-xs text-[#62725c]"><span>{pb.recoveredSen < 0 ? '累计结余仍为负' : `回本进度 ${pb.ratio === null ? '—' : (pb.ratio * 100).toFixed(1)}%`} · 口径待确认，仅供参考</span><span>还差 {formatRM(pb.remainingSen)}</span></div>
              </>
            )}
            <Btn onClick={() => navigate('/owner/finance/goals')} className="mt-5 w-full border-[#c7d2bd] !bg-transparent text-ok">看看我的目标 <Icon name="arrow" size={16} /></Btn>
          </section>

          <Panel title="今天，比昨天多一点" sub={`每日面量目标 · 面团粒数`} actions={<Tag tone={todayBalls >= target * 2 ? 'green' : 'gold'}>{todayBalls >= target * 2 ? '已达标' : '进行中'}</Tag>}>
            <div className="flex items-center gap-4">
              <Icon name="noodle" size={56} className="shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="text-[26px] font-bold tracking-tight tabular-nums">{ballsText(todayBalls)} <small className="text-sm font-normal text-ink-2">/ {target} 粒面</small></div>
                <div className="my-2.5"><Progress ratio={todayBalls / 2 / target} label="每日面量" /></div>
                <p className="text-xs text-ink-2">{todayBalls >= target * 2 ? `已经完成！${target < 100 ? '可以在经营目标里提升到每日 100 粒。' : ''}` : `再卖 ${ballsText(target * 2 - todayBalls)} 粒面，就达成今天目标。`}</p>
              </div>
            </div>
            <Btn tone="ghost" small className="mt-3" onClick={() => navigate('/owner/finance/goals')}>查看每日与每月目标 <Icon name="arrow" size={16} /></Btn>
          </Panel>

          <Panel title="食材小提醒" sub="记住换批，就能慢慢算准成本" actions={reminders ? <Tag tone="gold">{reminders} 项待办</Tag> : <Tag tone="green">都处理好了</Tag>}>
            {stocked.slice(0, 3).map((b) => (
              <Row key={b.id} icon="bottle" tone="warm" title={`${b.ingredientName} · 新的一批已买入`} sub={`${b.quantity} ${b.unit}${b.purchasedDate ? ` · ${shortDate(b.purchasedDate)} 进货` : ''}，开封时记开始时间`}
                right={<Btn small onClick={() => open({ kind: 'start', ingredientId: b.ingredientId })}>开始使用</Btn>} />
            ))}
            {costPending.slice(0, 2).map((b) => (
              <Row key={b.id} icon="leaf" tone="warm" title={`${b.ingredientName} · 成本待补`} sub="补上成本后才能核算周期平均成本" right={<Btn small onClick={() => open({ kind: 'cost', batch: b })}>补成本</Btn>} />
            ))}
            {unpaid.slice(0, 3).map(({ expense, outstandingSen }) => (
              <Row key={expense.id} icon="receipt" tone="warm" title={`${expense.description} · 待付 ${formatRM(outstandingSen)}`} sub={`${shortDate(expense.businessDate)} 记录 · 付款后补登`}
                right={<Btn small onClick={() => open({ kind: 'settle', expense: data.expenses.find((x) => x.id === expense.id)!, outstandingSen })}>补登付款</Btn>} />
            ))}
            {untracked.length > 0 && (
              <Row icon="carrot" tone="warm" title={`${untracked.slice(0, 3).map((i) => i.name).join('、')}${untracked.length > 3 ? ` 等 ${untracked.length} 项` : ''} · 还没有用料记录`} sub="补上数量、成本和开始使用时间"
                right={<Btn small onClick={() => open({ kind: 'existing', ingredientId: untracked[0].id })}>录入</Btn>} />
            )}
            {!reminders && <p className="text-sm text-ink-2">没有待处理的食材或付款。</p>}
          </Panel>
        </div>
      </div>
      <div className="mt-5"><Note>收支结余只是现金进出；经营利润另按食材消耗（批次周期平均）与固定费用分摊计算。进货付款不再计入经营利润，房租付款按月份分摊，不重复扣除。</Note></div>
    </>
  );
}

function Bars({ series, today }: { series: { date: string; inSen: number; outSen: number }[]; today: string }) {
  const max = Math.max(1, ...series.flatMap((s) => [s.inSen, s.outSen]));
  if (series.every((s) => s.inSen === 0 && s.outSen === 0)) return <Empty>这段时间还没有登记收款或付款。</Empty>;
  const step = series.length > 14 ? Math.ceil(series.length / 8) : 1;
  return (
    <figure>
      <div className="mb-3 flex gap-4 text-xs text-ink-2"><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-[#829a77]" />收款</span><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-[#d3b294]" />实际付款</span></div>
      <div className="flex h-52 items-end gap-1.5 border-b border-line sm:gap-3" role="img" aria-label="每日收款与实际付款">
        {series.map((s) => (
          <div key={s.date} className="flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 sm:gap-1" title={`${s.date} 收款 ${formatRM(s.inSen)} · 付款 ${formatRM(s.outSen)}`}>
            <span className={`w-full max-w-[22px] rounded-t ${s.date === today ? 'bg-ok' : 'bg-[#8ba17f]'}`} style={{ height: `${Math.max(1, (Math.max(0, s.inSen) / max) * 100)}%` }} />
            <span className="w-full max-w-[22px] rounded-t bg-[#d6b89e]" style={{ height: `${Math.max(1, (s.outSen / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 sm:gap-3">{series.map((s, i) => <span key={s.date} className={`min-w-0 flex-1 text-center text-[11px] ${s.date === today ? 'font-bold text-ok' : 'text-ink-2'}`}>{i % step === 0 || s.date === today ? (s.date === today ? '今天' : shortDate(s.date)) : ''}</span>)}</div>
    </figure>
  );
}

