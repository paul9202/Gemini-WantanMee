/** 开档成本：初始清单（幂等导入）、追加、更正、付款状态、租金与押金拆分、明细查看。欠账已含在总投入，清还只改状态。 */
import { Fragment, useState } from 'react';
import { navigate } from '../../../app/router';
import { formatRM, STARTUP_GROUP_ZH, STARTUP_PAYMENT_ZH, STARTUP_SEED, StartupCostDoc, startupSummary } from '../../../domain';
import { Icon } from '../../../ui/visual';
import type { TabProps } from '../FinancePage';
import { Btn, IconTile, Metric, Note, PageHead, Panel, Tag } from './ui';

const DONUT = ['#2c614b', '#8ba17f', '#c8a283', '#a93824', '#d9c9a8', '#6f8a7e', '#b9c4ae'];

export function StartupTab({ data, open, run, busy }: TabProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const sum = startupSummary(data.startup);
  // 初始清单按老板提供的顺序，其余按建立时间。
  const seedOrder = (i: StartupCostDoc) => { const n = STARTUP_SEED.findIndex((s) => s.seedKey === i.seedKey); return n < 0 ? 99 : n; };
  const active = data.startup.filter((i) => i.status === 'active').sort((a, b) => a.createdAtMs - b.createdAtMs || seedOrder(a) - seedOrder(b));
  const history = data.startup.filter((i) => i.status === 'voided');
  const seedTotal = STARTUP_SEED.reduce((s, x) => s + x.amountSen, 0);
  const rentItem = active.find((i) => i.group === 'rent_deposit');

  return (
    <>
      <PageHead eyebrow="THE STARTING LINE / 记住起步的每一分" title="开档投入，都记在这里。" sub="目前总投入是第一个回本目标；有新增项目，随时继续补上。"
        actions={<Btn tone="primary" className="col-span-2" onClick={() => open({ kind: 'startupAdd' })}><Icon name="plus" size={18} />追加开档成本</Btn>} />

      {!active.length && !data.startupSeeded && (
        <div className="mb-6 rounded-2xl border border-dashed border-[#bfcdb5] bg-[#f3f6ef] p-6">
          <h3 className="text-lg font-bold">还没有开档成本记录</h3>
          <p className="mt-1 text-sm text-ink-2">导入你提供的初始清单：6 项，合计 {formatRM(seedTotal)}。除供应商欠账标为「待付」外，其余付款状态标为「待核实」，请逐项确认。重复导入不会重复写入，也不会覆盖已有记录。</p>
          <Btn tone="dark" className="mt-4" disabled={busy} onClick={() => void run('seedStartupCosts', {}, '已导入开档初始清单')}>导入开档初始清单</Btn>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="当前开档总投入" icon="store" value={sum.totalSen} sub="含已付、待付与待核实 · 目标随之调整" highlight />
        <Metric label="已付金额" icon="check" value={sum.paidSen} sub="已核实付款的项目" />
        <Metric label="待付金额" icon="clock" value={sum.unpaidSen} sub="供应商欠账等 · 偿还时不重复加成本" />
        <Metric label="付款待核实" icon="info" value={sum.unverifiedSen} sub={`${sum.count} 项中尚未确认付款的部分`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.75fr)_minmax(290px,1fr)]">
        <Panel pad={false} title="起步清单" sub="按你提供的实际金额整理；点项目查看明细与操作" actions={<Tag>可继续补充</Tag>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead><tr className="bg-[#f6f5ef] text-left text-xs text-ink-2"><th className="px-5 py-3 font-medium">开档项目</th><th className="px-3 py-3 text-right font-medium">金额 / RM</th><th className="px-5 py-3 text-right font-medium">付款状态</th></tr></thead>
              <tbody>
                {active.map((i) => (
                  <Fragment key={i.id}>
                    <tr className="cursor-pointer border-t border-line align-top hover:bg-[#fbfaf5]" onClick={() => setExpanded(expanded === i.id ? null : i.id)}>
                      <td className="px-5 py-4">
                        <b className="flex items-center gap-1.5"><Icon name="chevron-right" size={14} className={`transition ${expanded === i.id ? 'rotate-90' : ''}`} />{i.title}</b>
                        <small className="mt-1 block text-xs text-ink-2">{subLine(i)}</small>
                      </td>
                      <td className="px-3 py-4 text-right tabular-nums">{formatRM(i.amountSen).replace('RM', '')}</td>
                      <td className="px-5 py-4 text-right"><Tag tone={i.paymentStatus === 'paid' ? 'green' : 'gold'}>{STARTUP_PAYMENT_ZH[i.paymentStatus]}{i.paidDate ? ` · ${i.paidDate}` : ''}</Tag></td>
                    </tr>
                    {expanded === i.id && (
                      <tr className="bg-[#fbfaf5]"><td colSpan={3} className="px-5 pb-4">
                        {i.details.length > 0 && <ul className="mb-3 grid gap-1 text-xs text-ink-2 sm:grid-cols-2">{i.details.map((d, n) => <li key={n} className="flex justify-between gap-3 rounded bg-card px-3 py-2"><span>{d.label}</span><b className="tabular-nums text-ink">{formatRM(d.amountSen)}</b></li>)}</ul>}
                        {i.note && <p className="mb-3 text-xs text-ink-2">备注：{i.note}</p>}
                        {i.correctionOf && <p className="mb-3 text-xs text-ink-2">这是更正后的记录。</p>}
                        {(i.linkedExpenses ?? []).some((l) => l.status === 'active') && <p className="mb-3 text-xs text-ink-2">已关联账本付款 {formatRM((i.linkedExpenses ?? []).filter((l) => l.status === 'active').reduce((s, l) => s + l.amountSen, 0))}（这些付款不再按经营支出扣）</p>}
                        <div className="flex flex-wrap gap-2">
                          <Btn small onClick={() => open({ kind: 'startupPay', item: i })}>{i.isDebt && i.paymentStatus !== 'paid' ? '登记已清还' : '更改付款状态'}</Btn>
                          {i.group === 'rent_deposit' && <Btn small onClick={() => open({ kind: 'startupSplit', item: i })}>{i.rentSen === null ? '拆分租金与押金' : '修改拆分'}</Btn>}
                          <Btn small tone="ghost" onClick={() => open({ kind: 'startupCorrect', item: i })}>更正</Btn>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
                {!active.length && <tr><td colSpan={3} className="px-5 py-8 text-center text-ink-2">{data.startupSeeded ? '初始清单已导入过；目前没有有效项目（可能都已更正或作废）。' : '尚未导入。'}</td></tr>}
              </tbody>
              {active.length > 0 && <tfoot><tr className="border-t border-line bg-[#f3f4ee] font-bold"><td className="px-5 py-4">开档总投入</td><td className="px-3 py-4 text-right tabular-nums">{formatRM(sum.totalSen).replace('RM', '')}</td><td className="px-5 py-4 text-right">{sum.count} 项</td></tr></tfoot>}
            </table>
          </div>
          {history.length > 0 && (
            <details className="border-t border-line px-5 py-4 text-sm">
              <summary className="min-h-11 cursor-pointer font-semibold text-ok">更正与作废记录（{history.length}）</summary>
              <ul className="mt-2 space-y-1 text-xs text-ink-2">{history.map((h) => <li key={h.id} className="line-through decoration-ink-2/50"><span className="no-underline">{h.title} {formatRM(h.amountSen)}</span>{h.voidReason ? ` · 原因：${h.voidReason}` : ''}</li>)}</ul>
            </details>
          )}
        </Panel>

        <aside className="grid min-w-0 content-start gap-5">
          <Panel title="第一站的目标金额" sub="跟着真实的投入更新">
            <div className="text-[34px] font-bold tracking-tight text-ok tabular-nums"><span className="mr-1 text-sm font-medium">RM</span>{formatRM(sum.totalSen).replace('RM', '')}</div>
            {sum.totalSen > 0 && <Donut parts={sum.byGroup.map((g) => ({ label: STARTUP_GROUP_ZH[g.group], sen: g.sen }))} total={sum.totalSen} />}
            <Btn tone="dark" className="mt-4 w-full" onClick={() => navigate('/owner/finance/goals')}>查看回本目标 <Icon name="arrow" size={16} /></Btn>
          </Panel>
          <Panel title="两件事，分开记">
            <div className="flex gap-3 py-2"><IconTile name="store" /><div><b className="text-sm">开档租金和押金</b><p className="mt-1 text-xs text-ink-2">{rentItem ? (rentItem.rentSen === null ? `${formatRM(rentItem.amountSen)} 已列入总投入，尚未拆分租金与押金。押金可退，不算营业消耗。` : `租金 ${formatRM(rentItem.rentSen)}${rentItem.rentMonth ? `（${rentItem.rentMonth}）` : ''} · 押金 ${formatRM(rentItem.depositSen ?? 0)}（可退）。`) : '还没有租金押金项目。'}</p>
              {rentItem && <Btn small tone="ghost" onClick={() => open({ kind: 'startupSplit', item: rentItem })}>{rentItem.rentSen === null ? '现在拆分' : '修改拆分'}</Btn>}</div></div>
            <div className="flex gap-3 py-2"><IconTile name="calendar" /><div><b className="text-sm">日常每月租金</b><p className="mt-1 text-xs text-ink-2">前三个月 RM800，之后 RM1,000。开档租金关联月份且已付后，该月月租不再重复要求付款。</p></div></div>
          </Panel>
          <Note>供应商欠账已计入总投入，清还时只更改付款状态，不再增加回本目标。除欠账外，其他项目的付款状态尚未核实，请逐项确认。</Note>
        </aside>
      </div>
    </>
  );
}

function subLine(i: StartupCostDoc) {
  if (i.group === 'rent_deposit') return i.rentSen === null ? '租金与押金尚待拆分' : `租金 ${formatRM(i.rentSen)} · 押金 ${formatRM(i.depositSen ?? 0)}${i.rentMonth ? ` · 覆盖 ${i.rentMonth}` : ''}`;
  if (i.isDebt) return '已计入总投入，清还时只更新状态';
  if (i.details.length) return `${i.details.length} 笔 · 点开查看明细`;
  return i.note || STARTUP_GROUP_ZH[i.group];
}

function Donut({ parts, total }: { parts: { label: string; sen: number }[]; total: number }) {
  let acc = 0;
  const stops = parts.map((p, n) => { const a = acc; acc += p.sen / total; return `${DONUT[n % DONUT.length]} ${a * 360}deg ${acc * 360}deg`; }).join(',');
  return (
    <div className="mt-4 flex flex-wrap items-center gap-5">
      <div className="relative h-28 w-28 shrink-0 rounded-full" style={{ background: `conic-gradient(${stops})` }} role="img" aria-label="开档投入构成">
        <div className="absolute inset-4 grid place-items-center rounded-full bg-card text-center"><span><b className="block text-base">起步</b><small className="text-[10px] text-ink-2">从这一档开始</small></span></div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
        {parts.map((p, n) => <li key={p.label} className="flex items-center gap-2"><i className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: DONUT[n % DONUT.length] }} /><span className="flex-1">{p.label}</span><b className="tabular-nums">{((p.sen / total) * 100).toFixed(1)}%</b></li>)}
      </ul>
    </div>
  );
}
