/**
 * 还剩多少、够不够明天（经营改版第二阶段）：用进货批次 − 订单用量估剩余；收档点数（可不填）重新校准；
 * 按公斤买、按粒用的材料要换算（1 kg 肉碎几粒云吞等），换算先给默认 / AI 估值，老板按「对」或改。
 */
import { useState } from 'react';
import { CONVERSION_ZH, ConversionKey, conversionOf, CostSourcesDoc, DEFAULT_CONVERSIONS, isValidConversion, StockEstimate, stockEstimates } from '../../domain/costSources';
import { Icon, Photo } from '../../ui/visual';
import { navigate } from '../../app/router';
import { loadStockInputs, useLoad } from './data';
import { useRunner } from './finance/data';
import { Btn, Dialog, inputCls, Toast } from './finance/ui';

const PHOTO: Record<string, string> = { 'ing-thin-noodle': 'noodle.thin_egg', 'ing-mee-poh': 'noodle.mee_poh' };
const COUNTABLE = [['ing-thin-noodle', '细面面团', '粒'], ['ing-mee-poh', '面薄面团', '粒'], ['ing-minced-pork', '肉碎', 'kg'], ['ing-wanton-skin', '云吞皮', '张']] as const;
const STATUS: Record<string, { label: string; cls: string; bar: string; card: string }> = {
  short: { label: '明天不够', cls: 'bg-danger text-white', bar: 'bg-danger', card: 'border-2 border-danger/40 bg-danger-bg/40' },
  low: { label: '后天前要补', cls: 'bg-warn text-white', bar: 'bg-warn', card: 'border border-[#ecd9a8] bg-warn-bg/40' },
  ok: { label: '够用', cls: 'bg-ok-bg text-ok', bar: 'bg-ok', card: 'border border-line' },
};
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** 今天页和用料页共用：读资料、算剩余。 */
export function useStock(today: string) {
  const q = useLoad(() => (today ? loadStockInputs(today) : Promise.resolve(null)), `stock-${today}`);
  const estimates = q.data ? stockEstimates({ ...q.data, today }) : [];
  return { estimates, sources: q.data?.sources ?? null, loading: q.loading, error: q.error, refresh: q.refresh };
}

export function StockSection({ today }: { today: string }) {
  const s = useStock(today);
  const { busy, toast, clearToast, run } = useRunner(s.refresh);
  const [counting, setCounting] = useState(false);
  const [editConv, setEditConv] = useState<ConversionKey | null>(null);
  const shown = s.estimates.filter((e) => e.status !== null || e.unitIssue);

  return (
    <section className="rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h3 className="text-lg font-bold">还剩多少，够不够明天</h3>
        <span className="text-sm text-ink-2">进货的数量 − 之后卖掉的用量 · 估算</span>
        <button type="button" onClick={() => setCounting(true)} className="ml-auto flex h-12 items-center gap-1.5 rounded-xl border border-line bg-card px-4 font-semibold"><Icon name="edit" size={18} />收档点一下</button>
      </div>
      <p className="mb-4 text-[13px] text-ink-2">「明天要」按前几个同一天的平均。进货数量来自拍进货单或记进货（要按粒 / kg / 张记）。</p>
      {s.error && <p role="alert" className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取失败：{s.error}</p>}
      {s.loading && !s.estimates.length ? <p className="py-6 text-center text-ink-2">正在载入…</p> : !shown.length ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-ink-2">
          <p>还没有面团、肉碎、云吞皮的进货记录，所以算不出剩余。</p>
          <button type="button" onClick={() => navigate('/owner/finance/ingredients')} className="mt-3 inline-flex h-12 items-center gap-1.5 rounded-xl bg-brand px-4 font-bold text-[#fff8e8]"><Icon name="camera" size={18} />拍进货单</button>
          <p className="mt-2 text-[12px]">或者先「收档点一下」实际剩多少。</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {shown.map((e) => <StockCard key={e.ingredientId} e={e} />)}
        </div>
      )}

      <div className="mt-5 border-t border-line pt-4">
        <b className="text-[15px]">换算</b><span className="ml-2 text-[13px] text-ink-2">按公斤买、按粒用的，要知道 1 公斤能做多少</span>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {(Object.keys(CONVERSION_ZH) as ConversionKey[]).map((k) => <ConvRow key={k} k={k} sources={s.sources} busy={busy} onEdit={() => setEditConv(k)}
            onConfirm={() => void run('setCostConversions', { values: { [k]: conversionOf(s.sources, k) } }, '换算已确认')} />)}
        </div>
      </div>
      <p className="mt-4 flex items-start gap-2 rounded-xl bg-subtle px-4 py-3 text-[13px] text-ink-2"><Icon name="info" size={16} className="mt-0.5 shrink-0" /><span>剩余是算出来的，不是实点：有损耗、试吃、送人就会偏多。<b className="text-ink">收档时点一下实际数量</b>，以后就从实数算。</span></p>

      {counting && <CountDialog estimates={s.estimates} busy={busy} onClose={() => setCounting(false)}
        onSave={async (counts) => { if (await run('recordStockCount', { counts }, '已记下实际数量')) setCounting(false); }} />}
      {editConv && <ConvDialog k={editConv} current={conversionOf(s.sources, editConv)} busy={busy} onClose={() => setEditConv(null)}
        onSave={async (v) => { if (await run('setCostConversions', { values: { [editConv]: v } }, '换算已保存')) setEditConv(null); }} />}
      <Toast toast={toast} onClose={clearToast} />
    </section>
  );
}

function StockCard({ e }: { e: StockEstimate }) {
  const st = e.status ? STATUS[e.status] : null;
  const ratio = e.tomorrowNeed ? Math.max(0, Math.min(1, e.remaining / (e.tomorrowNeed * 3))) : 0;
  return (
    <div className={`rounded-2xl p-4 ${st?.card ?? 'border border-line'}`}>
      <div className="flex items-center gap-2">
        {PHOTO[e.ingredientId] ? <Photo id={PHOTO[e.ingredientId]} size={36} rounded={8} /> : <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f6efe1] text-[#9a7a3c]"><Icon name="wanton" size={22} /></span>}
        <b className="text-[16px]">{e.name}</b>
        {st && <span className={`ml-auto whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-bold ${st.cls}`}>{st.label}</span>}
      </div>
      {e.status !== null ? (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-2"><span className="text-[30px] font-black leading-none tabular-nums">{e.remaining < 0 ? '0' : `约 ${qty(e.remaining)}`}</span><span className="font-semibold">{e.unit}</span>{e.tomorrowNeed !== null && <span className="ml-auto text-[13px] text-ink-2">明天要 ~{qty(e.tomorrowNeed)}</span>}</div>
          <div className="mt-2 h-2 rounded-full bg-card"><div className={`h-2 rounded-full ${st?.bar ?? 'bg-ok'}`} style={{ width: `${ratio * 100}%` }} /></div>
          <p className="mt-2 text-[13px] text-ink-2">{e.anchorText}{e.purchasedSince ? ` · 进 ${qty(e.purchasedSince)}` : ''} · 用了 {qty(e.usedSince)}{e.remaining < 0 ? ' · 算出来是负的，可能有进货没记' : ''}</p>
        </>
      ) : null}
      {e.unitIssue && <p className="mt-2 text-[12px] text-warn">{e.unitIssue}</p>}
    </div>
  );
}

function ConvRow({ k, sources, busy, onEdit, onConfirm }: { k: ConversionKey; sources: CostSourcesDoc | null; busy: boolean; onEdit: () => void; onConfirm: () => void }) {
  const c = sources?.conversions?.[k];
  const confirmed = c?.kind === 'owner';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-subtle px-3 py-2 text-[13px]">
      <span>{CONVERSION_ZH[k].label.replace('多少', '')}</span><b className="tabular-nums">{conversionOf(sources, k)} {CONVERSION_ZH[k].unit}</b>
      {confirmed ? <span className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-[12px] font-bold"><Icon name="check" size={13} />已确认</span>
        : <span className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[12px] font-bold text-warn"><Icon name="sparkle" size={13} />{c?.kind === 'ai' ? 'AI 估' : '一般做法'}</span>}
      <span className="ml-auto flex gap-1.5">
        {!confirmed && <button type="button" disabled={busy} onClick={onConfirm} className="rounded-lg bg-ok px-2.5 py-1 font-bold text-white disabled:opacity-50">对</button>}
        <button type="button" disabled={busy} onClick={onEdit} className="rounded-lg border border-line bg-card px-2.5 py-1 font-bold disabled:opacity-50">改</button>
      </span>
    </div>
  );
}

function CountDialog({ estimates, busy, onClose, onSave }: { estimates: StockEstimate[]; busy: boolean; onClose: () => void; onSave: (counts: { ingredientId: string; quantity: number }[]) => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const parsed = COUNTABLE.map(([id]) => ({ id, v: vals[id]?.trim() ? Number(vals[id]) : null }));
  const bad = parsed.some((p) => p.v !== null && (!Number.isFinite(p.v) || p.v < 0));
  const counts = parsed.filter((p) => p.v !== null && !bad).map((p) => ({ ingredientId: p.id, quantity: Math.round(p.v! * 1000) / 1000 }));
  return (
    <Dialog title="收档点一下" sub="只填你点过的就好，其他留空。之后的剩余会从这个数重新算。" onClose={onClose}
      footer={<><Btn onClick={onClose}>取消</Btn><Btn tone="primary" disabled={!counts.length || bad || busy} onClick={() => onSave(counts)}>保存</Btn></>}>
      <div className="space-y-3">
        {COUNTABLE.map(([id, name, unit]) => {
          const est = estimates.find((e) => e.ingredientId === id);
          return (
            <label key={id} className="flex items-center gap-3 text-[15px]">
              <span className="w-24 shrink-0 font-semibold">{name}</span>
              <input inputMode="decimal" value={vals[id] ?? ''} onChange={(e) => setVals({ ...vals, [id]: e.target.value })} placeholder={est && est.status !== null ? `算出来约 ${qty(Math.max(0, est.remaining))}` : '没点可留空'} className={inputCls} />
              <span className="w-8 shrink-0 text-ink-2">{unit}</span>
            </label>
          );
        })}
      </div>
      {bad && <p className="mt-2 text-[13px] text-danger">请输入 0 或以上的数字。</p>}
    </Dialog>
  );
}

function ConvDialog({ k, current, busy, onClose, onSave }: { k: ConversionKey; current: number; busy: boolean; onClose: () => void; onSave: (v: number) => void }) {
  const [text, setText] = useState(String(current));
  const v = Number(text);
  const ok = isValidConversion(k, v);
  return (
    <Dialog title={CONVERSION_ZH[k].label} sub={`一般做法约 ${DEFAULT_CONVERSIONS[k]} ${CONVERSION_ZH[k].unit}。只影响剩余和收据价的估算，不会改账。`} onClose={onClose}
      footer={<><Btn onClick={onClose}>取消</Btn><Btn tone="primary" disabled={!ok || busy} onClick={() => onSave(Math.round(v))}>保存</Btn></>}>
      <label className="flex items-center gap-3"><input inputMode="numeric" autoFocus value={text} onChange={(e) => setText(e.target.value)} className={inputCls} /><span className="text-ink-2">{CONVERSION_ZH[k].unit}</span></label>
      {!ok && <p className="mt-2 text-[13px] text-danger">应在 {CONVERSION_ZH[k].min}–{CONVERSION_ZH[k].max} 之间。</p>}
    </Dialog>
  );
}
