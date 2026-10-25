/**
 * 开销分析：先显示后端按账本算好的统计（不调用模型），老板提问才生成解读。
 * 解读显示区间、生成时间、资料完整性与可点开的记录；账目变化后旧解读标为过期。两家都失败时统计照常。
 */
import { useEffect, useState } from 'react';
import { addDays, monthOf } from '../../../domain';
import { CostAnalysisView, getAnalysis } from '../../../data/firebase/aiCost';
import { Icon } from '../../../ui/visual';
import { failureText } from '../finance/data';
import { Btn, Empty, Metric, Note, Panel, Progress, Tag } from '../finance/ui';
import { rm } from './model';

const QUICK = ['这个月花在哪？', '比上个月多花在哪里？', '有哪些还没付的款？'];
type Preset = 'month' | 'last' | '7d';

function rangeOf(p: Preset, today: string) {
  const end = addDays(today, 1);
  if (p === '7d') return { start: addDays(today, -6), endExclusive: end, label: '近 7 天' };
  const m = monthOf(today);
  if (p === 'month') return { start: `${m}-01`, endExclusive: end, label: `本月 · ${m.replace('-', '.')}` };
  const [y, mo] = m.split('-').map(Number);
  const pm = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  return { start: `${pm}-01`, endExclusive: `${m}-01`, label: `上个月 · ${pm.replace('-', '.')}` };
}

const STATUS_TEXT: Record<string, string> = {
  failed: 'AI 解读暂时不可用（两家服务都没有给出合格的结果），下面的统计不受影响，稍后可以再试。',
  disabled: 'AI 解读尚未开启，统计照常可用。', not_configured: 'AI 服务尚未配置，统计照常可用。', quota: '今天的 AI 次数已用完，统计照常可用。',
};

export function CostInsights({ today, refreshKey, onRecord, onGoEntry }: { today: string; refreshKey: number; onRecord: (expenseId: string) => void; onGoEntry: () => void }) {
  const [preset, setPreset] = useState<Preset>('month');
  const range = rangeOf(preset, today);
  const [view, setView] = useState<CostAnalysisView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [question, setQuestion] = useState(QUICK[0]);
  const [answer, setAnswer] = useState<{ view: CostAnalysisView } | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    getAnalysis({ start: range.start, endExclusive: range.endExclusive }, false)
      .then((v) => alive && setView(v)).catch((e) => alive && setErr(failureText(e))).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.endExclusive, refreshKey]);

  async function ask(q: string) {
    setAsking(true);
    setErr(null);
    try {
      const v = await getAnalysis({ start: range.start, endExclusive: range.endExclusive }, true, q);
      setView(v);
      setAnswer({ view: v });
    } catch (e) {
      setErr(failureText(e));
    } finally {
      setAsking(false);
    }
  }

  const s = view?.stats;
  const stale = answer && view && answer.view.dataDigest !== view.dataDigest;
  const max = Math.max(1, ...(s?.current.byBucket.map((b) => b.sen) ?? [1]));
  const evidence = new Map((answer?.view.stats.evidence ?? []).map((e) => [e.id, e]));
  const exp = answer?.view.explanation;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1.5 text-[11px] tracking-[0.18em] text-ink-2">COST INSIGHTS / 钱花在哪，一眼看明白</div>
          <h2 className="text-2xl font-bold tracking-tight sm:text-[29px]">这段时间，开销清楚一点。</h2>
          <p className="mt-1.5 text-[13px] text-ink-2">先看账本统计，再让 AI 帮你解释。每个结论都有记录可查。</p>
        </div>
        <div role="group" aria-label="统计区间" className="flex gap-1 rounded-xl bg-subtle p-1">
          {(['month', 'last', '7d'] as Preset[]).map((p) => <button key={p} type="button" aria-pressed={preset === p} onClick={() => { setPreset(p); setAnswer(null); }} className={`min-h-11 rounded-lg px-3 text-sm font-semibold ${preset === p ? 'bg-card shadow-card' : 'text-ink-2'}`}>{rangeOf(p, today).label.split(' · ')[0]}</button>)}
        </div>
      </div>
      {err && <p role="alert" className="mb-4 rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">{err}</p>}
      {loading && !s ? <p className="py-16 text-center text-ink-2">正在按账本统计…</p> : s && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <Metric label="采购与开支发生额" icon="receipt" value={s.current.totalSen} sub={`${range.label} · 按购买 / 发生日，不代表实际消耗`} highlight />
            <Metric label="其中已付" icon="check" value={s.current.paidSen} sub="这些记录目前的付款状态" />
            <Metric label="仍待付款" icon="clock" value={s.outstanding.totalSen} sub={`截至现在 ${s.outstanding.count} 笔（不限日期）`} />
          </div>
          {!s.current.recordCount ? (
            <Panel><Empty>这段时间还没有开销记录。<button type="button" className="ml-1 font-semibold text-ok underline" onClick={onGoEntry}>去记一笔</button></Empty></Panel>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
              <div className="grid content-start gap-5">
                <Panel title="花在哪里" sub={`${range.start.slice(5).replace('-', '/')} – ${addDays(range.endExclusive, -1).slice(5).replace('-', '/')} · 账本统计`} actions={<Tag tone="gold">不是消耗成本</Tag>}>
                  <ul className="space-y-3">
                    {s.current.byBucket.map((b) => (
                      <li key={b.bucket} className="grid grid-cols-[88px_minmax(0,1fr)_96px] items-center gap-3 text-sm">
                        <span>{b.label}</span><Progress ratio={b.sen / max} label={`${b.label}占比`} /><b className="text-right tabular-nums">{rm(b.sen)}</b>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 flex items-start gap-1.5 border-t border-line pt-3 text-xs text-ink-2"><Icon name="info" size={14} className="mt-0.5" />采购金额不能直接当作已消耗的食材成本；缺少用量时，不推算剩余或浪费。</p>
                </Panel>
                <Panel title="和对比区间" sub={`${s.previous.range.start} 至 ${addDays(s.previous.range.endExclusive, -1)}（${s.previous.days} 天）`}>
                  <p className="text-sm">对比区间合计 <b className="tabular-nums">{rm(s.previous.totalSen)}</b>，本期{s.current.totalSen >= s.previous.totalSen ? '多' : '少'} <b className="tabular-nums">{rm(Math.abs(s.current.totalSen - s.previous.totalSen))}</b>。</p>
                  {s.unitPrices.length > 0 && <ul className="mt-2 text-xs text-ink-2">{s.unitPrices.map((u) => <li key={u.ingredientId}>{u.name}：本期 {rm(u.currentPerUnitSen)} / {u.unit}，对比 {rm(u.previousPerUnitSen)} / {u.unit}（{u.currentSamples} / {u.previousSamples} 笔有数量）</li>)}</ul>}
                </Panel>
                <Panel title="这些资料，补上后更准确">
                  <ul className="space-y-2 text-sm">{s.coverage.notes.map((n) => <li key={n} className="flex gap-2"><Icon name="leaf" size={16} className="mt-0.5 shrink-0 text-ok" />{n}</li>)}</ul>
                  {(s.excluded.capitalSen > 0 || s.excluded.startupLinkedSen > 0 || s.excluded.laterCapitalSen > 0) && <p className="mt-3 text-xs text-ink-2">另有资本 / 开档相关支出 {rm(s.excluded.capitalSen + s.excluded.startupLinkedSen + s.excluded.laterCapitalSen)} 不算日常开销，已单独列出。</p>}
                </Panel>
              </div>
              <aside className="grid content-start gap-5">
                <Panel title="问问这段开销" sub="不必自己翻每一笔。">
                  <label className="block"><span className="sr-only">你的问题</span>
                    <textarea value={question} maxLength={300} rows={3} onChange={(e) => setQuestion(e.target.value)} className="block w-full rounded-xl border border-[#cfd4c5] bg-[#fffefa] p-3 text-base" />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">{QUICK.map((qq) => <button key={qq} type="button" onClick={() => setQuestion(qq)} className="min-h-10 rounded-lg border border-line px-2.5 text-xs">{qq}</button>)}</div>
                  <Btn tone="primary" className="mt-3" disabled={asking || !question.trim()} onClick={() => void ask(question.trim())}><Icon name="sparkle" size={18} />{asking ? '正在生成解读…' : '生成解读'}</Btn>
                </Panel>
                {answer && answer.view.explainStatus !== 'ok' && <Note>{STATUS_TEXT[answer.view.explainStatus]}</Note>}
                {exp && (
                  <section className="rounded-2xl border border-[#dce4d5] bg-[#edf2e9] p-5" aria-live="polite">
                    <div className="mb-2 flex items-center gap-2 text-xs text-ink-2"><Icon name="sparkle" size={16} />AI 开销解读 · {exp.provider === 'claude' ? 'Claude' : 'DeepSeek（备用）'}{/模拟/.test(exp.model) ? ' · 模拟' : ''}{exp.cached ? ' · 账目未变，沿用上次解读' : ''}</div>
                    {stale && <p role="alert" className="mb-2 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">账目已经变化，这段解读已过期。<button type="button" className="underline" onClick={() => void ask(exp.question)}>重新生成</button></p>}
                    <h3 className="font-bold">{exp.summary}</h3>
                    <ul className="mt-3 space-y-3 text-sm">{exp.findings.map((f, i) => (
                      <li key={i}>{f.text}
                        <span className="mt-1 flex flex-wrap gap-1.5">{f.evidenceIds.map((id) => { const e = evidence.get(id); return e ? <button key={id} type="button" onClick={() => onRecord(id)} className="rounded-md border border-[#c9d5bf] bg-card px-2 py-1 text-xs">{e.date.slice(5)} · {e.label} · {rm(e.amountSen)}</button> : null; })}</span>
                      </li>
                    ))}</ul>
                    {exp.limitations.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-ink-2">{exp.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
                    <p className="mt-4 border-t border-[#d4dccb] pt-3 text-[11px] text-ink-2">区间 {answer!.view.range.start} 至 {addDays(answer!.view.range.endExclusive, -1)} · 对比 {answer!.view.stats.previous.range.start} 起 {answer!.view.stats.previous.days} 天 · 生成于 {new Date(exp.generatedAtMs).toLocaleString('zh-CN', { hour12: false })}</p>
                  </section>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}
