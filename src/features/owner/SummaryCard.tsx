/**
 * 收档小结（经营改版第二阶段）：数字由服务器先算好；打开页面只读已写好的小结或程序写的白话（不调用 AI、不花钱），
 * 老板按「让 AI 写」才请 AI 把同样的数字写成三句话。数据有更新时提示重写。
 */
import { useEffect, useState } from 'react';
import { DailySummaryView, getDailySummary } from '../../data/firebase/aiCost';
import { Icon } from '../../ui/visual';
import { failureText } from './finance/data';

const TITLES = ['今天', '卖得好的', '明天备料'];
const STATUS_TEXT: Record<string, string> = {
  disabled: 'AI 记成本还没开启（账目 · AI 记成本里可以开），先显示系统写的小结。',
  not_configured: '服务器还没设定 AI，先显示系统写的小结。',
  quota: '今天的 AI 次数用完了，先显示系统写的小结。',
  failed: 'AI 这次没写成功，先显示系统写的小结，可以稍后再试。',
};

export function SummaryCard({ date, isToday }: { date: string; isToday: boolean }) {
  const [view, setView] = useState<DailySummaryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setView(null); setErr(null);
    getDailySummary(date, false).then((v) => live && setView(v)).catch((e) => live && setErr(failureText(e)));
    return () => { live = false; };
  }, [date]);
  const write = async () => {
    setBusy(true); setErr(null);
    try { setView(await getDailySummary(date, true)); } catch (e) { setErr(failureText(e)); } finally { setBusy(false); }
  };
  if (view && view.facts.bowls === 0) return null;
  const ai = view?.ai;
  const paragraphs = ai ? ai.paragraphs.map((p) => p.text) : view?.plain ?? [];

  return (
    <section className="mt-5 rounded-2xl border border-line bg-[#fbfaf6] p-5 shadow-card lg:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand"><Icon name="sparkle" size={20} /></span>
        <h3 className="text-lg font-bold">{isToday ? '收档小结' : '这天的小结'}</h3>
        <span className="text-sm text-ink-2">{ai ? `AI 写的 · 数字全部来自账本${ai.stale ? ' · 数据有更新' : ''}` : '系统按账本写的'}</span>
        <button type="button" disabled={busy || !view} onClick={() => void write()} className="ml-auto flex h-11 items-center gap-1.5 rounded-xl border border-line bg-card px-3 text-[14px] font-semibold disabled:opacity-50">
          <Icon name="sparkle" size={16} />{busy ? 'AI 写小结中…' : ai ? (ai.stale ? '按新数据重写' : '已是最新') : '让 AI 写'}
        </button>
      </div>
      {err && <p role="alert" className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-[14px] text-danger">{err}</p>}
      {view && STATUS_TEXT[view.status] && <p className="mb-3 rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn">{STATUS_TEXT[view.status]}</p>}
      {!view && !err ? <p className="py-4 text-center text-ink-2">正在整理…</p> : (
        <ol className="grid gap-3 text-[15px] leading-relaxed md:grid-cols-3">
          {paragraphs.map((t, i) => <li key={i} className="rounded-xl bg-card p-4"><b className="mb-1 block text-[13px] text-ink-2">{i === 2 && view ? `${TITLES[2]}（明天${view.facts.tomorrow.weekday}）` : TITLES[i]}</b>{t}</li>)}
        </ol>
      )}
      <p className="mt-3 text-[12px] text-ink-2">AI 只把系统算好的数字写成白话，不自己加总；备料建议按前几个同一天的平均，只供参考，不会自动下单。</p>
    </section>
  );
}
