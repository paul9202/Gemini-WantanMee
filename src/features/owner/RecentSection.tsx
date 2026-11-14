/**
 * 今天页「最近的生意」：近 7 天、近 30 天各一张卡（收入、约赚、日均、单数碗数粒面、卖最多、和前一段比），
 * 下面是每天收入的柱子；点卡片切换柱子的天数，点柱子跳到那一天。
 * 区间永远截至今天（含今天，还在营业时今天只算到现在）；开档前的日子不算。口径同今天页：已登记收款、理论材料成本、租金按日摊。
 */
import { useState } from 'react';
import { ballsText } from '../../domain/costing';
import type { FixedCostPolicy, LedgerEvent } from '../../domain/finance';
import { formatRM } from '../../domain/money';
import { DatedOrder, PeriodFigures, periodFigures } from '../../domain/periods';
import { Icon } from '../../ui/visual';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const wd = (date: string) => WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;

export function RecentSection({ today, viewing, onPick, events, orders, firstDay, fixed, loading }: {
  today: string; viewing: string; onPick: (date: string) => void;
  events: LedgerEvent[] | null; orders: DatedOrder[] | null; firstDay: string | null; fixed: FixedCostPolicy; loading: boolean;
}) {
  const [chart, setChart] = useState<7 | 30>(7);
  const ready = events !== null && orders !== null;
  const p7 = ready ? periodFigures({ events, orders, end: today, days: 7, firstDay, fixed }) : null;
  const p30 = ready ? periodFigures({ events, orders, end: today, days: 30, firstDay, fixed }) : null;
  const shown = chart === 7 ? p7 : p30;

  return (
    <section className="mb-5 min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-2">
        <h3 className="text-lg font-bold">最近的生意</h3>
        <span className="text-sm text-ink-2">截至今天 {md(today)}（今天算到现在）· 收入按已登记收款 · 点卡片换天数，点柱子看那一天</span>
      </div>
      {!ready ? <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-2">{loading ? '正在载入…' : '读取失败，请按刷新'}</p>
        : !p7 && !p30 ? <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-2">还没有生意记录</p> : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {p7 && <PeriodCard label="近 7 天" p={p7} on={chart === 7} onClick={() => setChart(7)} />}
            {p30 && <PeriodCard label="近 30 天" p={p30} on={chart === 30} onClick={() => setChart(30)} />}
          </div>
          {shown && <DayBars p={shown} today={today} viewing={viewing} onPick={onPick} />}
        </>
      )}
    </section>
  );
}

function PeriodCard({ label, p, on, onClick }: { label: string; p: PeriodFigures; on: boolean; onClick: () => void }) {
  const last = p.days[p.days.length - 1]?.date ?? p.range.start;
  const c = p.compare;
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`min-w-0 rounded-2xl border-2 p-4 text-left transition-colors lg:p-5 ${on ? 'border-ok bg-ok-bg/50' : 'border-line bg-card hover:border-ink-2/40'}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <b className="text-[17px]">{label}</b>
        <span className="text-[13px] text-ink-2">{md(p.range.start)}–{md(last)}{p.clipped ? ` · 开档以来 ${p.days.length} 天` : ''}</span>
        {on && <span className="ml-auto rounded-full bg-ok px-2 py-0.5 text-[11px] font-bold text-white">下面的柱子</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5 tabular-nums">
        <span className="text-base font-bold">RM</span>
        <span className="text-[34px] font-black leading-none tracking-tight">{formatRM(p.netSen).replace('RM', '')}</span>
        <span className="ml-1 text-[13px] text-ink-2">收入</span>
      </div>
      <div className="mt-2 min-h-[22px] text-[13px]">
        {c ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className={`whitespace-nowrap rounded-md px-1.5 py-0.5 font-bold ${c.deltaSen >= 0 ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>{c.deltaSen >= 0 ? '↑' : '↓'} {formatRM(Math.abs(c.deltaSen))}</span>
            <span className="text-ink-2">{c.kind === 'total' ? `比前 ${p.wantDays} 天（${formatRM(c.baseSen)}）` : `日均比前一段（日均 ${formatRM(c.baseSen)}）`}{c.deltaSen >= 0 ? '多' : '少'}</span>
          </span>
        ) : <span className="text-ink-2">{p.clipped ? '刚开档，还没有前一段可以比' : '前一段没有生意，先不比'}</span>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 text-[14px] tabular-nums">
        <div><dt className="text-[12px] text-ink-2">约赚（估算）</dt><dd className={`font-bold ${p.profitSen < 0 ? 'text-danger' : 'text-ok'}`}>{p.profitSen < 0 ? '亏 ' : ''}{formatRM(Math.abs(p.profitSen))}</dd></div>
        <div><dt className="text-[12px] text-ink-2">日均收入</dt><dd className="font-bold">{p.avgNetSen === null ? '—' : formatRM(p.avgNetSen)} <span className="text-[12px] font-normal text-ink-2">营业 {p.openDays} 天</span></dd></div>
        <div className="col-span-2 flex flex-wrap gap-x-3"><span><b>{p.orders}</b> 单</span><span><b>{p.bowls}</b> 碗</span><span><b>{ballsText(p.noodleHalf)}</b> 粒面</span></div>
      </dl>
      <div className="mt-2 space-y-0.5 text-[13px] text-ink-2">
        {p.best && <p className="truncate">最好的一天：<b className="text-ink">{md(p.best.date)} 周{wd(p.best.date)}</b> {formatRM(p.best.netSen)}</p>}
        {p.topDish && <p className="truncate">卖最多：<b className="text-ink">{p.topDish.label}</b> {p.topDish.bowls} 碗</p>}
      </div>
    </button>
  );
}

/** 每天收入柱：最好的一天深绿，其余浅绿；虚线是日均；没营业的日子留空写「休」。 */
function DayBars({ p, today, viewing, onPick }: { p: PeriodFigures; today: string; viewing: string; onPick: (date: string) => void }) {
  const max = Math.max(...p.days.map((d) => d.netSen), 1);
  const many = p.days.length > 10;
  const avgPct = p.avgNetSen ? (Math.max(0, p.avgNetSen) / max) * 85 : null;
  return (
    <figure className="mt-5">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2">
        <b className="text-[13px] text-ink">每天收入 · {p.clipped ? `开档以来 ${p.days.length} 天` : `近 ${p.wantDays} 天`}</b>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-ok" />最好的一天</span>
        {p.avgNetSen !== null && <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-ink-2" />日均 {formatRM(p.avgNetSen)}</span>}
      </div>
      <div className="relative flex h-44 items-end gap-1 border-b border-line sm:gap-1.5" role="img" aria-label={`每天收入，最好 ${p.best ? `${md(p.best.date)} ${formatRM(p.best.netSen)}` : '无'}`}>
        {avgPct !== null && <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-2/60" style={{ bottom: `${avgPct}%` }} />}
        {p.days.map((d) => {
          const best = p.best?.date === d.date;
          return (
            <button key={d.date} type="button" onClick={() => onPick(d.date)} title={`${md(d.date)} 周${wd(d.date)} · ${d.open ? `${formatRM(d.netSen)} · ${d.orders} 单` : '没营业'}`}
              className={`flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-t-md ${d.date === viewing ? 'bg-subtle' : ''}`}>
              {best && !many && <span className="mb-1 text-xs font-bold whitespace-nowrap">{formatRM(d.netSen)}</span>}
              {d.open ? <div className={`w-full max-w-[56px] rounded-t-md ${best ? 'bg-ok' : 'bg-[#d2dac4]'}`} style={{ height: `${Math.max(1, (Math.max(0, d.netSen) / max) * 85)}%` }} />
                : <span className="mb-1 text-[11px] text-ink-2">休</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1 sm:gap-1.5">
        {p.days.map((d, i) => {
          const showLabel = !many || i === 0 || i === p.days.length - 1 || Number(d.date.slice(8)) % 5 === 0;
          return (
            <span key={d.date} className={`min-w-0 flex-1 text-center text-[11px] leading-tight ${d.date === today ? 'font-bold text-ok' : 'text-ink-2'}`}>
              {showLabel ? (many ? md(d.date) : <>{d.date === today ? '今天' : md(d.date)}<br />周{wd(d.date)}</>) : ''}
            </span>
          );
        })}
      </div>
      {p.best && <figcaption className="mt-3 flex items-start gap-1.5 text-[13px] text-ink-2"><Icon name="info" size={15} className="mt-0.5 shrink-0" />
        <span>{md(p.best.date)} 周{wd(p.best.date)}最好（{formatRM(p.best.netSen)}，{p.best.orders} 单）。约赚已扣理论材料成本和每天摊的租金电费（休息日也摊），不含工资和税。</span>
      </figcaption>}
    </figure>
  );
}
