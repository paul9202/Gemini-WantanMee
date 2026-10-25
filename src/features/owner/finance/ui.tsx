/** 收支改版的通用组件：子页导航、页头、指标卡、面板、标签、进度条、提示、弹窗与表单字段（奶油白 / 砖红 / 松绿）。 */
import { ReactNode, useEffect, useId, useRef } from 'react';
import { navigate, Route } from '../../../app/router';
import { formatRM, Sen } from '../../../domain';
import { Icon } from '../../../ui/visual';
import type { IconName } from '../../../ui/iconSymbols';

export const FINANCE_PAGES: { route: Route; label: string; icon: IconName }[] = [
  { route: '/owner/finance', label: '收支总览', icon: 'chart' },
  { route: '/owner/finance/ingredients', label: 'AI 记成本', icon: 'sparkle' },
  { route: '/owner/finance/expenses', label: '日常开支', icon: 'receipt' },
  { route: '/owner/finance/goals', label: '经营目标', icon: 'target' },
  { route: '/owner/finance/startup', label: '开档成本', icon: 'store' },
];

/** 收支五个子页：桌面为左侧栏，手机与平板为页内横排（不与外壳底部导航重叠）。 */
export function FinanceNav({ current }: { current: Route }) {
  return (
    <nav aria-label="收支页面" className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 lg:sticky lg:top-4 lg:mx-0 lg:mb-0 lg:flex-col lg:overflow-visible lg:px-0">
      {FINANCE_PAGES.map((p) => {
        const active = current === p.route;
        return (
          <button key={p.route} type="button" onClick={() => navigate(p.route)} aria-current={active ? 'page' : undefined}
            className={`flex min-h-12 shrink-0 items-center gap-3 rounded-xl px-4 text-[15px] font-semibold lg:w-full ${active ? 'bg-brand-soft text-brand' : 'border border-line bg-card text-ink-2 hover:bg-subtle hover:text-ink lg:border-transparent lg:bg-transparent'}`}>
            <Icon name={p.icon} size={20} />{p.label}
            {active && <span className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-brand lg:block" />}
          </button>
        );
      })}
    </nav>
  );
}

export function PageHead({ eyebrow, title, sub, actions }: { eyebrow: string; title: string; sub: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-1.5 text-[11px] tracking-[0.18em] text-ink-2">{eyebrow}</div>
        <h2 className="text-2xl font-bold tracking-tight sm:text-[29px]">{title}</h2>
        <p className="mt-1.5 text-[13px] text-ink-2">{sub}</p>
      </div>
      {actions && <div className="grid w-full grid-cols-2 gap-2.5 sm:flex sm:w-auto sm:flex-wrap">{actions}</div>}
    </div>
  );
}

/** RM 金额拆成「RM」+ 数字，用于大号指标。 */
export const amount = (sen: Sen) => formatRM(sen).replace('RM', '');

export function Metric({ label, icon, value, sub, highlight, children }: { label: string; icon: IconName; value?: Sen | null; sub: string; highlight?: boolean; children?: ReactNode }) {
  return (
    <div className={`min-w-0 rounded-2xl border p-5 shadow-card ${highlight ? 'border-[#dce4d5] bg-[#edf2e9]' : 'border-line bg-card'}`}>
      <div className="flex items-center justify-between text-[13px] text-ink-2">{label}<Icon name={icon} size={18} className="text-control" /></div>
      <div className={`my-3 text-[28px] font-semibold leading-tight tracking-tight tabular-nums ${highlight ? 'text-ok' : ''}`}>
        {children ?? (value === null || value === undefined ? <span className="text-2xl">待核算</span> : <><span className={`mr-1.5 text-[13px] font-medium ${value < 0 ? 'text-danger' : ''}`}>RM</span><span className={value < 0 ? 'text-danger' : ''}>{amount(value)}</span></>)}
      </div>
      <div className="text-xs text-ink-2">{sub}</div>
    </div>
  );
}

export function Panel({ title, sub, actions, children, className = '', pad = true }: { title?: string; sub?: string; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-card shadow-card ${className}`}>
      {title && (
        <div className={`flex flex-wrap items-start justify-between gap-3 ${pad ? 'px-5 pt-5 sm:px-6 sm:pt-6' : 'px-5 pt-5 sm:px-6 sm:pt-6'} ${pad ? 'mb-4' : 'pb-2'}`}>
          <div className="min-w-0"><h3 className="text-lg font-bold">{title}</h3>{sub && <p className="mt-0.5 text-xs text-ink-2">{sub}</p>}</div>
          {actions}
        </div>
      )}
      <div className={pad ? `px-5 pb-5 sm:px-6 sm:pb-6 ${title ? '' : 'pt-5 sm:pt-6'}` : ''}>{children}</div>
    </section>
  );
}

export function Tag({ tone = 'plain', children }: { tone?: 'plain' | 'green' | 'gold' | 'red'; children: ReactNode }) {
  const c = { plain: 'bg-subtle text-[#5c6859]', green: 'bg-ok-bg text-ok', gold: 'bg-warn-bg text-warn', red: 'bg-brand-soft text-brand' }[tone];
  return <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold ${c}`}>{children}</span>;
}

export function Progress({ ratio, label, tall }: { ratio: number; label: string; tall?: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className={`overflow-hidden rounded-full bg-[#dce3d5] ${tall ? 'h-2.5' : 'h-2'}`}>
      <span className="block h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Note({ children, tone = 'gold' }: { children: ReactNode; tone?: 'gold' | 'green' }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-[13px] ${tone === 'green' ? 'border-[#dce5d5] bg-[#edf2e8] text-[#506949]' : 'border-[#e9e1ce] bg-[#f7f3e8] text-[#786541]'}`}>
      <Icon name="info" size={17} className="mt-0.5 shrink-0" /><div className="min-w-0">{children}</div>
    </div>
  );
}

export function IconTile({ name, tone = 'green', size = 'md' }: { name: IconName; tone?: 'green' | 'warm' | 'brand'; size?: 'sm' | 'md' }) {
  const c = { green: 'bg-ok-bg text-ok', warm: 'bg-[#f3eee4] text-[#9b6946]', brand: 'bg-brand-soft text-brand' }[tone];
  return <span className={`grid shrink-0 place-items-center rounded-xl ${c} ${size === 'sm' ? 'h-9 w-9' : 'h-11 w-11'}`}><Icon name={name} size={size === 'sm' ? 18 : 22} /></span>;
}

export function Btn({ children, onClick, tone = 'plain', disabled, type = 'button', className = '', small }: {
  children: ReactNode; onClick?: () => void; tone?: 'plain' | 'primary' | 'dark' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; className?: string; small?: boolean;
}) {
  const c = {
    plain: 'border border-[#d6d9cc] bg-card text-ink hover:bg-subtle', primary: 'border border-brand bg-brand text-white hover:bg-brand-pressed',
    dark: 'border border-ok bg-ok text-white hover:bg-ok-pressed', ghost: 'border border-transparent bg-transparent text-ok hover:bg-ok-bg', danger: 'border border-danger bg-card text-danger hover:bg-danger-bg',
  }[tone];
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold disabled:cursor-not-allowed disabled:opacity-45 ${small ? 'min-h-11 px-3 text-[13px]' : 'min-h-12 px-4 text-sm'} ${c} ${className}`}>
      {children}
    </button>
  );
}

/** 弹窗：内容区独立滚动，底部操作栏固定（手机上保存按钮始终可见）；Esc 关闭。 */
export function Dialog({ title, sub, onClose, children, footer, wide }: { title: string; sub?: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#29352e]/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id}
        className={`flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-[#fffefa] shadow-2xl sm:max-h-[92dvh] sm:rounded-3xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-xl'}`}>
        <div className="flex items-start gap-3 border-b border-line px-5 py-4 sm:px-7 sm:py-5">
          <div className="min-w-0 flex-1"><h2 id={id} className="text-xl font-bold">{title}</h2>{sub && <p className="mt-1 text-[13px] text-ink-2">{sub}</p>}</div>
          <button type="button" onClick={onClose} aria-label="关闭" className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-line hover:bg-subtle"><Icon name="close" size={20} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">{children}</div>
        <div className="flex gap-3 border-t border-line bg-[#fffefa] px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:justify-end sm:px-7">{footer}</div>
      </div>
    </div>
  );
}

export const inputCls = 'block min-h-12 w-full rounded-xl border border-[#cfd4c5] bg-[#fffefa] px-3 text-base font-normal focus:border-ok';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-4 block text-[13px] font-semibold">
      <span className="mb-1.5 block">{label}</span>
      {children}
      {hint && <small className="mt-1.5 block text-xs font-normal text-ink-2">{hint}</small>}
    </label>
  );
}

export function Radio({ name, checked, onChange, title, sub }: { name: string; checked: boolean; onChange: () => void; title: string; sub?: string }) {
  return (
    <label className={`my-2 flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-sm ${checked ? 'border-[#afc4a4] bg-ok-bg' : 'border-line'}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 h-4 w-4 accent-[#28644c]" />
      <span><b className="font-semibold">{title}</b>{sub && <small className="block text-xs text-ink-2">{sub}</small>}</span>
    </label>
  );
}

export function More({ summary, children, open }: { summary: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group mb-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-ok">
        <Icon name="chevron-right" size={16} className="transition group-open:rotate-90" />{summary}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

export function Toast({ toast, onClose }: { toast: { ok: boolean; text: string; at: number } | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast?.ok) return;
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.at]);
  if (!toast) return null;
  return (
    <div role={toast.ok ? 'status' : 'alert'} className={`fixed inset-x-4 bottom-24 z-[60] mx-auto flex max-w-lg items-center gap-3 rounded-2xl px-4 py-3 font-semibold shadow-xl md:bottom-6 ${toast.ok ? 'bg-ok text-white' : 'bg-danger text-white'}`}>
      <span className="flex-1">{toast.text}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/15"><Icon name="close" size={18} /></button>
    </div>
  );
}

export function Row({ icon, title, sub, right, tone }: { icon?: IconName; title: ReactNode; sub?: ReactNode; right?: ReactNode; tone?: 'green' | 'warm' | 'brand' }) {
  return (
    <div className="flex min-h-16 items-center gap-3 border-b border-line py-3 last:border-0">
      {icon && <IconTile name={icon} size="sm" tone={tone} />}
      <div className="min-w-0 flex-1"><b className="block text-sm font-semibold">{title}</b>{sub && <small className="mt-0.5 block text-xs text-ink-2">{sub}</small>}</div>
      {right}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-ink-2">{children}</p>;
}

export const SOURCE_ZH = { drawer: '钱箱现金', bank: '银行 / QR', owner: '老板自付' } as const;
export type Source = keyof typeof SOURCE_ZH;

export function SourceSelect({ value, onChange }: { value: Source; onChange: (v: Source) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Source)} className={inputCls} aria-label="付款来源">
      {Object.entries(SOURCE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </select>
  );
}

export const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
