/**
 * 用料（2026-11-14 经营改版）：每天用了多少料，全部从订单算出来（domain/usage），老板不用另外记。
 * 每样写「怎么算出来的」，近 7 天的面团粒数对比每日目标；下面是还剩多少、够不够明天（StockSection）。
 * 批次、换批、损耗等详细用料管理仍在账目 · AI 记成本里。
 */
import { ReactNode, useState } from 'react';
import { addDays, businessDateOf, DateRange, datesInRange } from '../../domain/businessDay';
import { ballsText } from '../../domain/costing';
import { MaterialUsage, materialUsage, UsageOrder } from '../../domain/usage';
import { useNow } from '../../data/firebase/live';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { Icon, Photo } from '../../ui/visual';
import { loadDailyBallsTarget, loadLedger, useLoad } from './data';
import { OwnerTabs } from './ui';
import { StockSection } from './StockSection';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
type Mode = 'day' | 'week';

export function MaterialsPage() {
  const { config } = useSession();
  const now = useNow(60_000);
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('day');
  const date = picked && picked <= today ? picked : today;
  const week: DateRange = { start: addDays(date || '2000-01-01', -6), endExclusive: addDays(date || '2000-01-01', 1) };
  const ledger = useLoad(() => (date ? loadLedger(week) : Promise.resolve(null)), `materials-${date}`);
  const target = useLoad(loadDailyBallsTarget, 'balls-target');
  if (!config) return null;

  const orders = (ledger.data?.orders ?? []) as unknown as (UsageOrder & { businessDate: string })[];
  const days = datesInRange(week).map((d) => ({ date: d, usage: materialUsage(orders.filter((o) => o.businessDate === d)) }));
  const dayUsage = days.find((d) => d.date === date)?.usage ?? null;
  const weekUsage = ledger.data ? materialUsage(orders) : null;
  const u = mode === 'day' ? dayUsage : weekUsage;
  const openDays = days.filter((d) => d.usage.bowls > 0);
  const avg = (f: (x: MaterialUsage) => number) => (openDays.length ? openDays.reduce((s, d) => s + f(d.usage), 0) / openDays.length : null);
  const avgText = (f: (x: MaterialUsage) => number, half = false) => {
    const a = avg(f);
    if (a === null) return null;
    return half ? ballsText(Math.round(a)) : String(Math.round(a));
  };
  const ballsTarget = target.data ?? 50;
  const label = mode === 'day' ? (date === today ? '今天' : `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`) : `近 7 天（${week.start.slice(5).replace('-', '/')}–${date.slice(5).replace('-', '/')}）`;
  const loading = ledger.loading || !ledger.data;

  return (
    <div className="mx-auto max-w-[1440px] p-4 pb-8 lg:p-8">
      <OwnerTabs current="/owner/materials" />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <div className="text-[11px] tracking-[0.18em] text-ink-2">WHAT WE USED / 用掉的材料</div>
          <h2 className="mt-1 text-2xl font-bold lg:text-[28px]">卖一碗，就自动记一碗的料。</h2>
          <p className="text-sm text-ink-2">每碗用多少是菜单上定好的（面碗都放 4 粒云吞、1 份叉烧），系统按卖出的碗数乘出来。</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center rounded-2xl bg-subtle p-1" role="group" aria-label="区间">
          <button type="button" aria-pressed={mode === 'day'} onClick={() => setMode('day')} className={`h-12 rounded-xl px-4 font-semibold ${mode === 'day' ? 'bg-card shadow' : 'text-ink-2'}`}>{date === today ? '今天' : '这天'}</button>
          <button type="button" aria-pressed={mode === 'week'} onClick={() => setMode('week')} className={`h-12 rounded-xl px-4 font-semibold ${mode === 'week' ? 'bg-card shadow' : 'text-ink-2'}`}>近 7 天</button>
          <label className="flex h-12 items-center px-2 text-ink-2"><span className="sr-only">选日期</span><Icon name="calendar" size={18} />
            <input type="date" value={date} max={today} onChange={(e) => setPicked(e.target.value || null)} className="ml-1 w-[8.5rem] bg-transparent text-sm" />
          </label>
        </div>
      </div>

      {ledger.error && <p role="alert" className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取失败：{ledger.error}</p>}

      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
          <div className="mb-1 flex flex-wrap items-baseline gap-2"><h3 className="text-lg font-bold">{label}用了多少</h3>{u && <span className="text-sm text-ink-2">{u.orders} 单 · {u.bowls} 碗 · 不含取消的单</span>}</div>
          {!u || u.bowls === 0 && u.wanton.total === 0 ? <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-2">{loading ? '正在载入…' : '这段时间还没有订单'}</p> : (
            <ul className="divide-y divide-line">
              <Line icon={<Photo id="noodle.thin_egg" size={44} rounded={12} />} name="细面面团" value={ballsText(u.noodleHalfByType.thin_egg)} unit="粒"
                how={sizeFormula(u, 'thin_egg')} avg={mode === 'day' ? avgText((x) => x.noodleHalfByType.thin_egg, true) : null} />
              <Line icon={<Photo id="noodle.mee_poh" size={44} rounded={12} />} name="面薄面团" value={ballsText(u.noodleHalfByType.mee_poh)} unit="粒"
                how={sizeFormula(u, 'mee_poh')} avg={mode === 'day' ? avgText((x) => x.noodleHalfByType.mee_poh, true) : null} />
              <Line icon={<span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f6efe1] text-[#9a7a3c]"><Icon name="wanton" size={26} /></span>} name="云吞" value={String(u.wanton.total)} unit="粒"
                how={join([
                  u.wanton.noodleBowls && `面 ${u.wanton.noodleBowls} 碗 × ${Math.round(u.wanton.fromNoodle / u.wanton.noodleBowls)} 粒`,
                  u.wanton.wanton10Bowls && `云吞 10 粒 × ${u.wanton.wanton10Bowls} 碗`,
                  u.wanton.wanton15Bowls && `15 粒 × ${u.wanton.wanton15Bowls} 碗`,
                  u.wanton.extraPacks && `加云吞 ${u.wanton.extraPacks} 份 × 3 粒`,
                ])}
                note={u.kosongBowls ? `净面 ${u.kosongBowls} 碗不放云吞，已扣掉` : undefined} avg={mode === 'day' ? avgText((x) => x.wanton.total) : null} />
              <Line icon={<Photo id="ingredient.char_siew" size={44} rounded={12} />} name="叉烧" value={String(u.charSiew.total)} unit="份"
                how={join([u.charSiew.noodleBowls && `面 ${u.charSiew.noodleBowls} 碗 × 1 份`, u.charSiew.extra && `加叉烧 ${u.charSiew.extra} 份`])}
                note={u.kosongBowls || u.noCharSiewBowls ? `${join([u.kosongBowls && `净面 ${u.kosongBowls} 碗`, u.noCharSiewBowls && `「不要叉烧」${u.noCharSiewBowls} 碗`], '、')}不放，已扣掉` : undefined}
                avg={mode === 'day' ? avgText((x) => x.charSiew.total) : null} />
              <Line icon={<span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ok-bg text-ok"><Icon name="soup" size={24} /></span>} name="汤底" value={String(u.byKind.soup_noodle + u.byKind.wanton_soup)} unit="碗"
                how={`云吞汤面 ${u.byKind.soup_noodle} 碗 + 云吞汤 ${u.byKind.wanton_soup} 碗`} avg={mode === 'day' ? avgText((x) => x.byKind.soup_noodle + x.byKind.wanton_soup) : null} />
              <Line icon={<span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-brand"><Icon name="bottle" size={24} /></span>} name="干捞酱料 + 葱 + 油渣" value={String(u.byKind.dry_noodle + u.byKind.dry_wanton)} unit="碗"
                how={`黑酱 ${u.bySauce.black} · 红酱 ${u.bySauce.red} · 白酱 ${u.bySauce.white}（干捞面 ${u.byKind.dry_noodle} + 干捞云吞 ${u.byKind.dry_wanton}）`} avg={mode === 'day' ? avgText((x) => x.byKind.dry_noodle + x.byKind.dry_wanton) : null} />
              <Line icon={<span className="flex h-11 w-11 items-center justify-center rounded-xl bg-subtle"><Icon name="bag" size={24} /></span>} name="打包盒 + 袋" value={String(u.takeawayBowls)} unit="套"
                how="打包的碗数（加料不算）" avg={mode === 'day' ? avgText((x) => x.takeawayBowls) : null} />
            </ul>
          )}
          <p className="mt-2 flex items-start gap-1.5 rounded-xl bg-subtle px-4 py-3 text-[13px] text-ink-2"><Icon name="info" size={15} className="mt-0.5 shrink-0" />每碗用量来自菜单：小 1 粒面、中 1½、大 2；面碗 4 粒云吞 + 1 份叉烧；云吞汤 / 干捞云吞 10 或 15 粒；加云吞 3 粒、加叉烧 1 份。{mode === 'day' ? '「平时」是近 7 天有营业的日子平均。' : ''}</p>
        </section>

        <div className="grid min-w-0 content-start gap-4">
          <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
            <div className="mb-4 flex flex-wrap items-baseline gap-2"><h3 className="text-lg font-bold">近 7 天卖了多少面</h3><span className="text-sm text-ink-2">面团粒数 · 目标 {ballsTarget}</span></div>
            <WeekChart days={days} target={ballsTarget} selected={date} today={today} />
            {openDays.length > 0 && (
              <p className="mt-3 text-[13px] text-ink-2">
                7 天共 {ballsText(days.reduce((s, d) => s + d.usage.noodleHalf, 0))} 粒，营业的日子平均每天 {ballsText(Math.round(avg((x) => x.noodleHalf) ?? 0))} 粒，{days.filter((d) => d.usage.noodleHalf >= ballsTarget * 2).length} 天达标。
              </p>
            )}
          </section>
          <section className="min-w-0 rounded-2xl border border-line bg-[#fbfaf6] p-5 lg:p-6">
            <h3 className="text-lg font-bold">进货和批次</h3>
            <p className="mt-1 text-[13px] text-ink-2">拍进货单、记批次、换批、按份量记损耗，都在账目里，原来的功能不变。</p>
            <div className="mt-3 grid gap-2">
              <button type="button" onClick={() => navigate('/owner/finance/ingredients')} className="flex min-h-12 items-center gap-2 rounded-xl border border-line bg-card px-4 text-left font-semibold"><Icon name="camera" size={18} />拍进货单 / 说一句（AI 记成本）<Icon name="chevron-right" size={18} className="ml-auto text-ink-2" /></button>
              <button type="button" onClick={() => navigate('/owner/costs')} className="flex min-h-12 items-center gap-2 rounded-xl border border-line bg-card px-4 text-left font-semibold"><Icon name="receipt" size={18} />这些料花了多少钱（成本）<Icon name="chevron-right" size={18} className="ml-auto text-ink-2" /></button>
            </div>
          </section>
        </div>
      </div>

      <StockSection today={today} />
    </div>
  );
}

function sizeFormula(u: MaterialUsage, t: 'thin_egg' | 'mee_poh'): string {
  const r = u.noodle[t];
  return join([r.small.bowls && `小 ${r.small.bowls} 碗 × 1`, r.medium.bowls && `中 ${r.medium.bowls} 碗 × 1½`, r.large.bowls && `大 ${r.large.bowls} 碗 × 2`]) || '这段时间没有卖';
}

const join = (parts: (string | number | false | null | undefined)[], sep = ' + ') => parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(sep);

function Line({ icon, name, value, unit, how, note, avg }: { icon: ReactNode; name: string; value: string; unit: string; how: string; note?: string; avg: string | null }) {
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 py-3.5">
      {icon}
      <div className="min-w-0"><b>{name}</b><p className="text-[13px] text-ink-2">{how || '—'}</p>{note && <p className="text-[12px] text-ink-2">{note}</p>}</div>
      <div className="text-right"><div className="text-2xl font-black tabular-nums">{value} <span className="text-[13px] font-semibold">{unit}</span></div>{avg !== null && <div className="text-[12px] text-ink-2">平时每天 {avg}</div>}</div>
    </li>
  );
}

function WeekChart({ days, target, selected, today }: { days: { date: string; usage: MaterialUsage }[]; target: number; selected: string; today: string }) {
  const max = Math.max(target * 2, ...days.map((d) => d.usage.noodleHalf), 1);
  const h = (half: number) => (half / max) * 85;
  return (
    <figure>
      <div className="relative">
        <div className="flex h-48 items-end gap-2 border-b border-line" role="img" aria-label={`近 7 天面团粒数，目标 ${target}`}>
          {days.map((d) => {
            const hit = d.usage.noodleHalf >= target * 2;
            return (
              <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                <span className={`mb-1 text-[11px] tabular-nums ${hit ? 'font-bold' : 'text-ink-2'}`}>{d.usage.noodleHalf ? ballsText(d.usage.noodleHalf) : ''}</span>
                <div className={`w-full max-w-[40px] rounded-t-md ${d.date === selected ? 'bg-ok' : hit ? 'bg-ok/60' : 'bg-[#d2dac4]'}`} style={{ height: `${Math.max(d.usage.noodleHalf ? 2 : 0.5, h(d.usage.noodleHalf))}%` }} />
              </div>
            );
          })}
        </div>
        <div className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-brand/60" style={{ bottom: `${h(target * 2)}%` }}><span className="absolute -top-5 left-0 bg-card px-1 text-[11px] font-bold text-brand">目标 {target}</span></div>
      </div>
      <div className="mt-1.5 flex gap-2 text-center text-[12px] text-ink-2">
        {days.map((d) => <span key={d.date} className={`min-w-0 flex-1 ${d.date === selected ? 'font-bold text-ok' : ''}`}>{WEEKDAY[new Date(`${d.date}T00:00:00Z`).getUTCDay()]}<br />{d.date === today ? '今天' : `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}`}</span>)}
      </div>
    </figure>
  );
}
