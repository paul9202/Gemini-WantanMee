/**
 * 记一笔 · 核对：电脑左边来源、右边编辑；手机来源可收起，明细单列卡片，底部固定保存条。
 * 金额由 domain/aiCost 实时重算；有问题时保存按钮不可用，问题就近显示。只有「确认保存」才写账。
 */
import { useEffect, useMemo, useState } from 'react';
import { COST_PAYMENT_ZH, COST_SOURCE_ZH, CostPayment, CostPaymentSource, EditedCostDraft, Ingredient, validateCostDraft } from '../../../domain';
import { receiptImageUrl } from '../../../data/firebase/aiCost';
import { Icon } from '../../../ui/visual';
import { Btn, Dialog, Field, inputCls, Note, Tag } from '../finance/ui';
import { AmountInput, LineEditor } from './DraftLineEditor';
import { newLine, rm, SOURCE_LABEL } from './model';
import type { CostDraftState, DraftView } from './useCostDraft';

const PROVIDER_ZH: Record<string, string> = { claude: 'Claude', deepseek: 'DeepSeek（备用）' };

export function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2 text-xs text-ink-2" aria-label="步骤">
      {['告诉我花了什么', '核对一下', '确认保存'].map((t, i) => (
        <li key={t} className="flex items-center gap-2" aria-current={at === i + 1 ? 'step' : undefined}>
          <span className={`grid h-6 w-6 place-items-center rounded-full border text-[11px] ${at === i + 1 ? 'border-ok bg-ok text-white' : 'border-line'}`}>{i + 1}</span>
          <span className={at === i + 1 ? 'font-semibold text-ink' : ''}>{t}</span>
          {i < 2 && <Icon name="chevron-right" size={14} />}
        </li>
      ))}
    </ol>
  );
}

function SourcePanel({ d }: { d: DraftView }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [big, setBig] = useState<string | null>(null);
  // 电脑双栏时默认展开；平板与手机编辑区优先，来源先收起。
  const [wide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches);
  const paths = d.input.attachments.map((a) => a.path).join('|');
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    Promise.all(d.input.attachments.map((a) => receiptImageUrl(a.path).then((u) => { made.push(u); return u; }).catch(() => ''))).then((u) => { if (alive) setUrls(u); });
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths]);
  const meta = d.extractionMeta;
  return (
    <details open={wide} className="group rounded-2xl border border-line bg-card shadow-card xl:sticky xl:top-4" id="cost-source">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 font-bold">
        <span className="flex items-center gap-2"><Icon name={d.source === 'receipt' ? 'receipt' : 'edit'} size={19} />{d.source === 'receipt' ? '收据原图' : d.source === 'text' ? '你的原话' : '手动填写'}</span>
        <small className="text-xs font-normal text-ink-2 group-open:hidden">展开</small><small className="hidden text-xs font-normal text-ink-2 group-open:inline">收起</small>
      </summary>
      <div className="px-5 pb-5">
        {d.input.text && <blockquote className="rounded-xl border-l-4 border-[#a9b99c] bg-[#eef2e8] px-4 py-3 text-[15px] leading-relaxed text-[#4c6146]">{d.input.text}</blockquote>}
        {d.input.attachments.length > 0 && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {d.input.attachments.map((a, i) => (
              <button key={a.path} type="button" onClick={() => urls[i] && setBig(urls[i])} className="aspect-[3/4] overflow-hidden rounded-xl border border-line bg-[#efece3]" aria-label={`查看收据第 ${i + 1} 页大图`}>
                {urls[i] ? <img src={urls[i]} alt={`收据第 ${i + 1} 页`} className="h-full w-full object-contain" /> : <span className="text-xs text-ink-2">载入中…</span>}
              </button>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-2">AI 只整理你提供的内容；没说清楚的资料，留给你确认。</p>
        <dl className="mt-3 divide-y divide-line border-t border-line text-xs">
          {[['资料来源', SOURCE_LABEL[d.source]], ['币种', 'MYR · 令吉'], ['识别', meta ? `${PROVIDER_ZH[meta.provider] ?? meta.provider}${/模拟/.test(meta.model) ? ' · 模拟' : ''}` : '—'], ['状态', '草稿 · 尚未入账']].map(([k, v]) => (
            <div key={k} className="flex justify-between py-2"><dt className="text-ink-2">{k}</dt><dd className="font-semibold">{v}</dd></div>
          ))}
        </dl>
      </div>
      {big && <Dialog title="收据大图" wide onClose={() => setBig(null)} footer={<Btn onClick={() => setBig(null)} className="w-full sm:w-auto">关闭</Btn>}><img src={big} alt="收据大图" className="mx-auto max-h-[70dvh] object-contain" /></Dialog>}
    </details>
  );
}

export function DraftReview({ s, today, ingredients, onLater }: { s: CostDraftState; today: string; ingredients: Ingredient[]; onLater: () => void }) {
  const d = s.draft!;
  const e = s.local!;
  const v = useMemo(() => validateCostDraft(e, { today }), [e, today]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [hideCandidate, setHideCandidate] = useState<string | null>(null);
  const [ackReason, setAckReason] = useState('');
  const [ackId, setAckId] = useState<string | null>(null);
  const set = (patch: Partial<EditedCostDraft>) => s.edit({ ...e, ...patch });
  const lineIssues = (id: string) => v.issues.filter((i) => i.lineId === id);
  const topIssues = v.issues.filter((i) => i.lineId === null);
  const t = v.totals;
  const saving = s.busy === 'saving' || s.busy === 'committing';
  const included = e.lines.filter((l) => l.includeInBusiness).length;
  const paymentSummary = e.payment === 'paid' ? '已付' : e.payment === 'unpaid' ? '待付' : '付款待确认';
  const cand = d.candidate && d.candidate.attemptId !== hideCandidate ? d.candidate : null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <button type="button" onClick={onLater} className="mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px]"><Icon name="arrow-left" size={15} />先放着，记新的一笔</button>
          <h2 className="text-2xl font-bold tracking-tight sm:text-[29px]">帮你整理好了，核对一下。</h2>
          <p className="mt-1.5 text-[13px] text-ink-2">项目和金额都能改，确认后才会记入成本。</p>
        </div>
        <Steps at={2} />
      </div>
      {s.conflict && (
        <div role="alert" className="mb-4 rounded-2xl border border-[#e9cfc7] bg-brand-soft p-4 text-sm">
          <b>这份草稿已在别的页面修改过。</b> 为了不覆盖对方的内容，请先选择：
          <div className="mt-2 flex flex-wrap gap-2"><Btn small onClick={s.reloadLatest}>载入最新版本（放弃我这边的修改）</Btn><Btn small tone="ghost" onClick={() => void s.saveAsNew()}>把我的修改另存为新草稿</Btn></div>
        </div>
      )}
      {d.status === 'analyzing' && <div className="mb-4"><Note tone="green">正在重新识别，结果出来后会作为「新的识别结果」给你比较，不会覆盖你已经改过的内容。</Note></div>}
      {cand && (
        <div className="mb-4 rounded-2xl border border-[#dce5d5] bg-[#edf2e8] p-4 text-sm">
          <b>有一份新的识别结果</b>（{PROVIDER_ZH[cand.provider] ?? cand.provider}，{cand.extraction.lines.length} 项）。不会自动覆盖你的修改。
          <ul className="mt-2 list-disc pl-5 text-xs text-ink-2">{cand.extraction.lines.slice(0, 6).map((l, i) => <li key={i}>{l.name ?? '（未识别）'} · {l.amountSen === null ? '金额待填' : rm(l.amountSen)}</li>)}</ul>
          <div className="mt-2 flex gap-2"><Btn small tone="dark" onClick={() => void s.change({ applyCandidate: { attemptId: cand.attemptId } })}>用这次识别替换</Btn><Btn small onClick={() => setHideCandidate(cand.attemptId)}>保留我的版本</Btn></div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="min-w-0"><SourcePanel d={d} /></div>
        <div className="grid min-w-0 content-start gap-4">
          {(d.warnings?.length ?? 0) > 0 && <Note><ul className="space-y-0.5">{d.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Note>}
          <section className="min-w-0 rounded-2xl border border-line bg-card shadow-card">
            <div className="grid gap-3 border-b border-line p-5 sm:grid-cols-3 sm:p-6">
              <Field label="购买日期"><input type="date" value={e.purchaseDate} max={today} onChange={(x) => set({ purchaseDate: x.target.value })} className={inputCls} /></Field>
              <Field label="这笔是否已付款？">
                <select value={e.payment} onChange={(x) => set({ payment: x.target.value as CostPayment })} className={`${inputCls} ${e.payment === 'unknown' ? '!border-warn' : ''}`}>
                  {(['unknown', 'paid', 'unpaid'] as CostPayment[]).map((p) => <option key={p} value={p}>{COST_PAYMENT_ZH[p]}</option>)}
                </select>
              </Field>
              <Field label="付款来源（可不填）">
                <select value={e.paymentSource} onChange={(x) => set({ paymentSource: x.target.value as CostPaymentSource })} className={inputCls}>
                  {(['unspecified', 'drawer', 'bank', 'owner'] as CostPaymentSource[]).map((p) => <option key={p} value={p}>{COST_SOURCE_ZH[p]}</option>)}
                </select>
              </Field>
              {topIssues.filter((i) => ['date_invalid', 'date_future', 'currency_unsupported'].includes(i.code)).map((i) => <p key={i.code} className="text-xs text-danger sm:col-span-3">{i.message}</p>)}
            </div>
            <div className="flex items-center justify-between px-5 pt-5 sm:px-6"><b>整理出的项目 {e.lines.length}</b><Tag tone="green">可直接修改</Tag></div>
            {e.lines.map((l, i) => (
              <LineEditor key={l.lineId} line={l} index={i} issues={lineIssues(l.lineId)} ingredients={ingredients} purchaseMonth={e.purchaseDate.slice(0, 7)}
                onChange={(nl) => set({ lines: e.lines.map((x) => (x.lineId === l.lineId ? nl : x)) })}
                onRemove={() => set({ lines: e.lines.filter((x) => x.lineId !== l.lineId) })} />
            ))}
            <div className="border-t border-line px-5 py-3 sm:px-6"><Btn tone="ghost" small onClick={() => set({ lines: [...e.lines, newLine(e.lines)] })}><Icon name="plus" size={16} />增加一个项目</Btn></div>
            <dl className="space-y-3 border-t border-line p-5 text-sm sm:p-6">
              <div className="flex justify-between"><dt>明细小计</dt><dd className="font-semibold tabular-nums">{rm(t.subtotalSen)}</dd></div>
              <div className="flex items-center justify-between gap-3"><dt>整单折扣 <small className="text-xs text-ink-2">只扣一次</small></dt><dd className="w-40"><AmountInput value={e.discountSen} onChange={(x) => set({ discountSen: x ?? 0 })} label="整单折扣" invalid={topIssues.some((i) => i.code === 'discount_exceeds')} /></dd></div>
              <div className="flex items-center justify-between gap-3"><dt>税费 / 服务费</dt><dd className="w-40"><AmountInput value={e.taxSen} onChange={(x) => set({ taxSen: x ?? 0 })} label="税费" /></dd></div>
              {e.printedTotalSen !== null && <div className="flex justify-between"><dt>收据原总额 <small className="text-xs text-ink-2">保留原始依据</small></dt><dd className="font-semibold tabular-nums">{rm(e.printedTotalSen)}</dd></div>}
              {t.businessTotalSen !== t.computedTotalSen && <div className="flex justify-between text-ink-2"><dt>其中不计入营业</dt><dd className="tabular-nums">{rm(t.computedTotalSen - t.businessTotalSen)}</dd></div>}
              <div className="flex items-center justify-between border-t border-line pt-3"><dt className="font-bold">本次记入成本</dt><dd className="text-2xl font-bold tabular-nums text-ok">{rm(t.businessTotalSen)}</dd></div>
              {(e.discountSen > 0 || e.taxSen > 0) && <p className="text-xs text-ink-2">折扣与税费按金额分摊到明细，只记录一次。</p>}
            </dl>
          </section>
          {t.differenceSen !== null && t.differenceSen !== 0 && (
            <section role="alert" className={`rounded-2xl border p-4 text-sm ${topIssues.some((i) => i.code === 'difference_unconfirmed') ? 'border-[#e8d49b] bg-[#fdf5df]' : 'border-[#dce5d5] bg-[#edf2e8]'}`}>
              <b>与收据原总额相差 {rm(Math.abs(t.differenceSen))}</b>
              {e.difference && e.difference.acceptedTotalSen === t.computedTotalSen
                ? <p className="mt-1 text-xs">已说明：{e.difference.reason}（采用 {rm(t.computedTotalSen)}；再改金额需要重新说明）</p>
                : <p className="mt-1 text-xs text-ink-2">请看看是否有项目、折扣或金额识别错误。不会自动凑平这笔账。</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Btn small onClick={() => { const el = document.getElementById('cost-source') as HTMLDetailsElement | null; if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth' }); } }}>查看原图</Btn>
                <Btn small onClick={() => { setReason(e.difference?.reason ?? ''); setDiffOpen(true); }}>说明并采用修改总额</Btn>
              </div>
            </section>
          )}
          <p className="flex items-start gap-1.5 text-xs text-ink-2"><Icon name="info" size={14} className="mt-0.5" />数量和单位可以稍后补。现在先记采购支出，不会推算实际消耗或自动标记食材已用完。</p>
        </div>
      </div>

      {/* 页面在 main 内滚动：sticky 让保存条贴住可视区底部，又不会盖住手机底部导航。 */}
      <div className="sticky bottom-0 z-30 -mx-4 mt-5 border-t border-line bg-[#fffefa]/95 px-4 pb-3 pt-3 shadow-[0_-8px_24px_rgba(41,53,46,0.08)] backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <small className="text-xs text-ink-2">共 {included} 项 · {paymentSummary}{s.dirty ? ' · 正在保存修改…' : ''}</small>
            <div className="text-2xl font-bold tabular-nums">{rm(t.businessTotalSen)}</div>
          </div>
          <Btn tone="primary" className="min-w-[200px] flex-1 sm:flex-none" disabled={saving || v.issues.length > 0 || s.conflict || d.status === 'analyzing'} onClick={() => void s.commit()}>
            <Icon name="check" size={18} />{saving ? '正在保存…' : `确认保存 ${rm(t.businessTotalSen)}`}
          </Btn>
        </div>
        <div aria-live="polite">
          {v.issues.length > 0 && <p className="mt-1 text-xs text-warn">还差 {v.issues.length} 处：{v.issues.slice(0, 2).map((i) => i.message).join('；')}</p>}
          {s.error && <p role="alert" className="mt-1 text-xs text-danger">{s.error}</p>}
        </div>
      </div>

      {diffOpen && (
        <Dialog title="说明差额并采用修改总额" sub={`收据原总额 ${rm(e.printedTotalSen ?? 0)} 保留不变；本次采用 ${rm(t.computedTotalSen)}。`} onClose={() => setDiffOpen(false)}
          footer={<><Btn onClick={() => setDiffOpen(false)}>取消</Btn><Btn tone="primary" disabled={reason.trim().length < 2} onClick={() => { set({ difference: { acceptedTotalSen: t.computedTotalSen, reason: reason.trim() } }); setDiffOpen(false); }}>确认采用</Btn></>}>
          <Field label="原因（必填）" hint="例如：收据印错、找零时商家改价。之后再改金额，这个确认会失效。"><input value={reason} maxLength={200} onChange={(x) => setReason(x.target.value)} className={inputCls} /></Field>
        </Dialog>
      )}
      {s.duplicate && (
        <Dialog title="这张收据好像已经记过了" sub="系统找到相同的图片，或相同商家、单号、日期和总额的记录。" onClose={() => s.setDuplicate(null)}
          footer={<><Btn onClick={() => s.setDuplicate(null)}>先不保存</Btn><Btn tone="primary" disabled={!ackId || ackReason.trim().length < 2} onClick={() => void s.commit({ candidateId: ackId!, reason: ackReason.trim() })}>确实是另一笔，保存</Btn></>}>
          <ul className="space-y-2">{s.duplicate.map((c) => (
            <li key={c.receiptId}><label className="flex items-center gap-2 rounded-xl border border-line p-3 text-sm"><input type="radio" name="dup" checked={ackId === c.receiptId} onChange={() => setAckId(c.receiptId)} />{c.businessDate} · {c.supplier ?? '未写商家'} · {rm(c.totalSen)}</label></li>
          ))}</ul>
          <Field label="为什么是另一笔（必填）"><input value={ackReason} maxLength={200} onChange={(x) => setAckReason(x.target.value)} className={`${inputCls} mt-2`} /></Field>
        </Dialog>
      )}
    </div>
  );
}
