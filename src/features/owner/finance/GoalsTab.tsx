/** 经营目标：第一目标收回开档投入（真实账目、口径明示）；每日面量 50 → 100；月目标由老板设定；回本后拟定下一目标。 */
import { navigate } from '../../../app/router';
import { addDays, ballsText, formatRM, goalProgress, monthOf, monthRange, nextDailyTarget, suggestedMonthlyBalls } from '../../../domain';
import { Icon } from '../../../ui/visual';
import type { TabProps } from '../FinancePage';
import { payback, rangeFigures } from './model';
import { Btn, IconTile, Note, PageHead, Panel, Progress, Tag } from './ui';

export function GoalsTab({ data, today, nowMs, policy, open, run, busy }: TabProps) {
  const { result: pb, startup } = payback(data, today);
  const month = monthOf(today);
  const todayHalf = rangeFigures(data, { start: today, endExclusive: addDays(today, 1) }, policy, nowMs).balls;
  const monthHalf = rangeFigures(data, { start: monthRange(month).start, endExclusive: addDays(today, 1) }, policy, nowMs).balls;
  const daily = data.sales.dailyBalls;
  const monthly = data.sales.monthly[month] ?? null;
  const dailyDone = todayHalf >= daily * 2;
  const achieved = pb.state === 'achieved';
  const nextGoals = data.goals.filter((g) => g.status === 'active');
  const pastGoals = data.goals.filter((g) => g.status !== 'active');
  // 计算起点：系统里最早一笔收款或支出的营业日。
  const since = [...data.payments.map((p) => p.businessDate), ...data.expenses.map((e) => e.businessDate)].sort()[0] ?? null;

  return (
    <>
      <PageHead eyebrow="SMALL STEPS, REAL PROGRESS / 给每一天一个方向" title="一家小档口，也有大目标。" sub="先赚回开档投入，再决定下一站；每天与每月都有看得见的进步。"
        actions={<Btn onClick={() => open({ kind: 'salesTarget', scope: 'daily', current: daily, month })}><Icon name="edit" size={18} />调整销量目标</Btn>} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
        <div className="grid min-w-0 content-start gap-5">
          <section className="rounded-2xl border border-[#d9e2d0] bg-[#edf2e8] p-6 sm:p-7">
            <div className="flex items-center justify-between gap-3"><Tag tone="green">{achieved ? '首个目标已完成' : pb.state === 'pending' ? '首个目标 · 待核算' : '首个目标 · 进行中'}</Tag><Icon name="flag" size={22} /></div>
            <h3 className="mt-4 text-[23px] font-bold">先把开档的钱，赚回来。</h3>
            <p className="mt-1.5 text-sm text-[#5a6e52]">当前开档总投入 {formatRM(startup.totalSen)}，追加或更正开档成本后同步更新目标。进度按「现金回本结余」计算{since ? `，自 ${since} 第一笔账起` : ''}；口径尚待你确认，暂作参考。</p>
            {pb.state === 'pending' ? (
              <div className="mt-6"><div className="text-[36px] font-semibold text-ok">待核算</div><p className="mt-1 text-sm text-[#5a6e52]">{pb.pendingReasons.join('；')}。补齐后显示回本进度。</p><p className="mt-1 text-xs text-[#5a6e52]">目前账面：{formatRM(pb.recoveredSen)}（未核实，不作为完成依据）</p></div>
            ) : (
              <>
                <div className="mt-6 text-[34px] font-semibold tracking-tight text-ok tabular-nums sm:text-[43px]">{formatRM(pb.recoveredSen)} <small className="text-sm font-normal tracking-normal">/ {formatRM(pb.targetSen)}</small></div>
                <div className="mt-4"><Progress ratio={pb.barRatio} label="回本进度" tall /></div>
                <div className="mt-2 flex justify-between text-xs text-[#5a6e52]"><span>{achieved ? '已达成，可以拟定下一目标' : pb.recoveredSen < 0 ? '累计结余仍为负，尚未开始回本' : `已完成 ${pb.ratio === null ? '—' : (pb.ratio * 100).toFixed(1)}%`}</span><span>按真实账目</span></div>
              </>
            )}
            <div className="mt-6 grid grid-cols-3 gap-4 border-t border-[#d3ddca] pt-5">
              <div><small className="text-xs text-[#62735b]">距离回本还差</small><b className="block text-lg tabular-nums">{pb.state === 'pending' ? '—' : formatRM(pb.remainingSen)}</b></div>
              <div><small className="text-xs text-[#62735b]">已付开档成本</small><b className="block text-lg tabular-nums">{formatRM(startup.paidSen)}</b></div>
              <div><small className="text-xs text-[#62735b]">待付 / 待核实</small><b className="block text-lg text-warn tabular-nums">{formatRM(startup.unpaidSen + startup.unverifiedSen)}</b></div>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              <Btn onClick={() => navigate('/owner/finance/startup')}>查看开档成本 <Icon name="arrow" size={16} /></Btn>
              {achieved && !nextGoals.length && <Btn tone="dark" onClick={() => open({ kind: 'nextGoal' })}>制定下一个目标</Btn>}
            </div>
          </section>

          <Note>
            <b>现金回本结余（参考，口径待确认）：</b>累计实际收款（已登记收款 − 退款）{formatRM(pb.receiptsNetSen)}，减去累计已付经营支出（食材进货、日常开支）{formatRM(pb.paidOperatingSen)}，
            再减去已到期未付的经营支出（未付进货 / 开支、到期未付的租金和电费）{formatRM(pb.unpaidOperatingSen)}。这是现金口径，和总览里按食材消耗算的经营利润不同。
            老板注资不算收入；开档投入是目标本身，关联到开档项目的付款 {formatRM(pb.startupLinkedSen)} 不再按经营支出扣；后续资本投入 {formatRM(pb.laterCapitalSen)} 单列、未计入目标。
            现金总支出 {formatRM(pb.totalPaidSen)} 照实保留。押金在开档成本中单列。
          </Note>

          <div className="grid gap-5 md:grid-cols-2">
            <Panel>
              <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-2.5"><IconTile name="noodle" /><h3 className="text-base font-bold">每日面量</h3></div><Tag tone={dailyDone ? 'green' : 'gold'}>{dailyDone ? '今天已达标' : '今天加油'}</Tag></div>
              <div className="mt-5 text-[31px] font-semibold tracking-tight tabular-nums">{ballsText(todayHalf)} <small className="text-sm font-normal text-ink-2">/ {daily} 粒</small></div>
              <div className="my-3"><Progress ratio={todayHalf / 2 / daily} label="每日面量" /></div>
              <div className="flex justify-between text-xs text-ink-2"><span>今日完成 {Math.round((todayHalf / 2 / daily) * 100)}%</span><span>{dailyDone ? '完成！' : `还差 ${ballsText(daily * 2 - todayHalf)} 粒`}</span></div>
              <p className="mt-2 text-xs text-ink-2">{dailyDone ? `${daily} 粒达成了。准备好就向 ${nextDailyTarget(daily)} 粒出发，由你决定何时提升。` : '一步一步，朝每天的目标靠近。'}</p>
              {dailyDone ? <Btn small tone="ghost" className="mt-2" onClick={() => open({ kind: 'salesTarget', scope: 'daily', current: daily, month })}>下个挑战：每日 {nextDailyTarget(daily)} 粒 <Icon name="arrow" size={16} /></Btn>
                : <Btn small tone="ghost" className="mt-2" onClick={() => open({ kind: 'salesTarget', scope: 'daily', current: daily, month })}>调整每日目标</Btn>}
            </Panel>
            <Panel>
              <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-2.5"><IconTile name="calendar" /><h3 className="text-base font-bold">每月面量</h3></div><Tag>{Number(month.slice(5))} 月</Tag></div>
              <div className="mt-5 text-[31px] font-semibold tracking-tight tabular-nums">{ballsText(monthHalf)} <small className="text-sm font-normal text-ink-2">{monthly ? `/ ${monthly.toLocaleString()} 粒` : '粒 · 未设目标'}</small></div>
              {monthly ? (
                <>
                  <div className="my-3"><Progress ratio={monthHalf / 2 / monthly} label="每月面量" /></div>
                  <div className="flex justify-between text-xs text-ink-2"><span>本月完成 {Math.round((monthHalf / 2 / monthly) * 100)}%</span><span>还差 {ballsText(Math.max(0, monthly * 2 - monthHalf))} 粒</span></div>
                </>
              ) : <p className="mt-3 text-xs text-ink-2">还没有确认本月目标。建议：每日 {daily} 粒 × 当月天数 = {suggestedMonthlyBalls(daily, month).toLocaleString()} 粒，仅供参考。</p>}
              <Btn small tone="ghost" className="mt-2" onClick={() => open({ kind: 'salesTarget', scope: 'monthly', current: daily, month })}>{monthly ? '调整每月目标' : '设定本月目标'}</Btn>
            </Panel>
          </div>
          <Note tone="green">销量暂按「面团粒数」统计（未取消的订单）：小份 1 粒、中份 1½ 粒、大份 2 粒；云吞汤与干捞云吞不计入面量。日后若改为按碗数，只需换统计口径，目标数据保留。</Note>
        </div>

        <aside className="grid min-w-0 content-start gap-5">
          <Panel title="我们的里程碑" sub="先做好这一站，再想下一站">
            {[
              ['01', '收回开档投入', `${formatRM(startup.totalSen)} · ${achieved ? '已完成' : '当前主目标'}`],
              ['02', nextGoals[0]?.title ?? '下一个目标，由你决定', nextGoals[0] ? `${formatRM(nextGoals[0].targetSen)}${nextGoals[0].deadline ? ` · ${nextGoals[0].deadline} 前` : ''}` : '首个目标完成后，再拟定金额与期限。'],
              ['↗', `每日 ${daily} → ${nextDailyTarget(daily)} 粒面`, `${daily} 粒达标后，由你决定何时提升目标。`],
              ['↗', '建立每月的小目标', monthly ? `${month}：${monthly.toLocaleString()} 粒` : '按实际营业天数，拟定适合的月目标。'],
            ].map(([n, t, p]) => (
              <div key={t} className="flex gap-3 border-b border-line py-4 last:border-0"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[#d0d8c9] bg-[#f4f6ef] text-xs text-[#5b7051]">{n}</span><div><b className="text-sm">{t}</b><p className="mt-1 text-xs text-ink-2">{p}</p></div></div>
            ))}
          </Panel>
          <Panel title="回本以后，下一站？">
            <div className="flex gap-3 rounded-xl border border-dashed border-[#bfcdb5] bg-[#f3f6ef] p-4 text-sm">
              <Icon name={achieved ? 'flag' : 'lock'} size={20} className="shrink-0 text-ok" />
              <div><b>{achieved ? '第一站完成了！' : '先专注完成第一个目标'}</b><p className="mt-1 text-xs text-ink-2">{nextGoals[0] ? `已拟定：${nextGoals[0].title}` : '新设备、存备用金或提高收入，届时再决定名称、金额与期限。'}</p></div>
            </div>
            {nextGoals.map((g) => {
              const p = goalProgress(g, pb.recoveredSen);
              return (
                <div key={g.id} className="mt-4 rounded-xl border border-line p-4">
                  <div className="flex items-start justify-between gap-2"><b>{g.title}</b><Tag tone="green">进行中</Tag></div>
                  <div className="mt-2 text-xl font-semibold tabular-nums">{formatRM(p.progressSen)} <small className="text-sm font-normal text-ink-2">/ {formatRM(g.targetSen)}</small></div>
                  <div className="my-2"><Progress ratio={p.ratio} label={`${g.title}进度`} /></div>
                  <p className="text-xs text-ink-2">进度 = 建立目标后新增的现金回本结余（基线 {formatRM(g.baselineRecoveredSen ?? 0)}）{g.deadline ? ` · 期限 ${g.deadline}` : ''}{pb.state === 'pending' ? ' · 资料待核算时不能确认完成' : ''}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Btn small tone="dark" disabled={busy || !p.reached || pb.state === 'pending'} onClick={() => void run('completeGoal', { goalId: g.id }, '目标已完成')}>确认完成</Btn>
                    <Btn small tone="ghost" onClick={() => open({ kind: 'archiveGoal', goalId: g.id, title: g.title })}>放弃 / 改订</Btn>
                  </div>
                </div>
              );
            })}
            {achieved && !nextGoals.length && <Btn tone="dark" className="mt-4 w-full" onClick={() => open({ kind: 'nextGoal' })}>{pastGoals.length ? '拟定新的目标' : '拟定下一目标'}</Btn>}
            {pastGoals.length > 0 && (
              <details className="mt-4 text-sm"><summary className="min-h-11 cursor-pointer font-semibold text-ok">过往目标（{pastGoals.length}）</summary>
                <ul className="mt-1 space-y-1 text-xs text-ink-2">{pastGoals.map((g) => <li key={g.id}>{g.title} · {formatRM(g.targetSen)} · {g.status === 'achieved' ? `已完成${g.achievedSnapshot ? `（新增 ${formatRM(g.achievedSnapshot.progressSen)}）` : ''}` : `已放弃：${g.archivedReason ?? ''}`}</li>)}</ul>
              </details>
            )}
          </Panel>
        </aside>
      </div>
    </>
  );
}
