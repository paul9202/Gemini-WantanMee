/** 老板端通用组件：页内导航、指标卡、带数值横条、区块。 */
import { ReactNode } from 'react';
import { navigate, Route } from '../../app/router';

/**
 * 2026-11-14 经营改版：今天 · 用料 · 成本 · 账目 · 设置。
 * 日结、待核对并入「账目」（今天页的提醒和账目页的入口都能进），页签上仍亮「账目」。
 */
const TABS: { route: Route; label: string; also?: Route[] }[] = [
  { route: '/owner', label: '今天' },
  { route: '/owner/materials', label: '用料' },
  { route: '/owner/costs', label: '成本' },
  { route: '/owner/finance', label: '账目', also: ['/owner/review', '/owner/close'] },
  { route: '/owner/settings', label: '设置' },
];

/** 老板子页标签：所有宽度都在页内横向排列（窄屏可横向滑动）；底部导航由外壳统一提供。 */
export function OwnerTabs({ current, badge }: { current: Route; badge?: Partial<Record<Route, number>> }) {
  return (
    <nav aria-label="老板页面" className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
      {TABS.map((t) => {
        const active = current === t.route || Boolean(t.also?.includes(current)) || (t.route === '/owner/finance' && current.startsWith('/owner/finance'));
        return (
          <button key={t.route} type="button" onClick={() => navigate(t.route)} aria-current={active ? 'page' : undefined}
            className={`relative h-14 shrink-0 rounded-xl border px-4 font-semibold sm:px-5 ${active ? 'border-ink bg-ink text-white' : 'border-line bg-card text-ink-2 hover:text-ink'}`}>
            {t.label}
            {badge?.[t.route] ? <span className="ml-1.5 rounded-full bg-danger px-1.5 text-xs text-white">{badge[t.route]}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

export function Section({ title, hint, children, actions }: { title: string; hint?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        {hint && <span className="text-sm text-ink-2">{hint}</span>}
        {actions && <div className="ml-auto flex gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone = 'normal' }: { label: string; value: string; sub?: string; tone?: 'normal' | 'warn' | 'bad' | 'good' }) {
  const color = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-ok' : 'text-ink';
  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-card">
      <div className="text-sm text-ink-2">{label}</div>
      <div className={`mt-1 text-3xl font-black tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

/** 带数值的横条（不用大面积环图）。 */
export function BarList({ rows, format }: { rows: { label: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  if (!rows.length) return <p className="text-ink-2">暂无可统计数据</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[6rem_1fr_6rem] items-center gap-2">
          <span className="truncate text-sm">{r.label}</span>
          <span className="h-3 rounded bg-subtle"><span className="block h-3 rounded bg-ok/70" style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} /></span>
          <span className="text-right text-sm font-semibold tabular-nums">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(x * 100 % 1 === 0 ? 0 : 1)}%`);
export const minutes = (ms: number | null) => (ms === null ? '—' : `${(ms / 60_000).toFixed(1)} 分`);
