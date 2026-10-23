/** 点餐页共用的小组件：选项按钮、分组标题、数量步进器。 */
import { ReactNode } from 'react';
import { Icon } from '../../ui/visual';

export function Choice({ selected, disabled, onClick, children, className = '', label }: {
  selected: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; className?: string; label?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-pressed={selected} aria-label={label}
      className={`relative min-h-14 rounded-xl border-2 transition-colors active:translate-y-px ${
        selected ? 'border-ok bg-ok-bg' : 'border-line bg-card hover:border-control'
      } ${disabled ? 'opacity-45' : ''} ${className}`}
    >
      {children}
      {selected && <span className="absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ok text-white"><Icon name="check" size={13} /></span>}
    </button>
  );
}

export function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="py-3">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-base font-bold">{title}</h3>
        {hint && <span className="ml-auto text-[13px] text-ink-2">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-[0.16em] text-ink-2">{children}</div>;
}

export function Stepper({ value, onChange, min = 1, max = 50, labelLess, labelMore, size = 'md' }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number; labelLess: string; labelMore: string; size?: 'sm' | 'md';
}) {
  const h = size === 'sm' ? 'h-11 w-11' : 'h-12 w-12';
  return (
    <div className="inline-flex items-center rounded-xl border border-line bg-card">
      <button type="button" aria-label={labelLess} disabled={value <= min} onClick={() => onChange(value - 1)} className={`${h} text-2xl text-ink-2 disabled:opacity-35`}>−</button>
      <span className="w-9 text-center text-lg font-bold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" aria-label={labelMore} disabled={value >= max} onClick={() => onChange(value + 1)} className={`${h} text-2xl text-ink-2 disabled:opacity-35`}>+</button>
    </div>
  );
}
