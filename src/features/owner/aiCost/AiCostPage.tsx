/**
 * AI 记成本（取代原「食材与用料」首屏）：记一笔 / 采购记录 / 开销分析三个页签。
 * 原来的批次、开始使用、换批、核算范围与份量损耗折叠在「详细用料管理」里，照常可用。
 */
import { ReactNode, useMemo, useState } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { db, storePath } from '../../../data/firebase/client';
import { useLiveDoc, useLiveQuery } from '../../../data/firebase/live';
import { setAiEnabled } from '../../../data/firebase/aiCost';
import { formatRM } from '../../../domain';
import { Icon } from '../../../ui/visual';
import type { TabProps } from '../FinancePage';
import { IngredientsTab } from '../finance/IngredientsTab';
import { failureText } from '../finance/data';
import { Btn, Panel, Tag } from '../finance/ui';
import { CostInsights } from './CostInsights';
import { DraftReview } from './DraftReview';
import { EntryComposer } from './EntryComposer';
import { PurchaseHistory } from './PurchaseHistory';
import { SaveResult } from './SaveResult';
import { SOURCE_LABEL } from './model';
import { useCostDraft } from './useCostDraft';

type Tab = 'entry' | 'history' | 'insights';
const TABS: { id: Tab; label: string; icon: 'sparkle' | 'receipt' | 'chart' }[] = [{ id: 'entry', label: '记一笔', icon: 'sparkle' }, { id: 'history', label: '采购记录', icon: 'receipt' }, { id: 'insights', label: '开销分析', icon: 'chart' }];
const STATUS_ZH: Record<string, string> = { created: '待整理', analyzing: '整理中', review: '待核对', failed: '整理失败' };

export function AiCostPage(props: TabProps & { refresh: () => void }) {
  const { data, today } = props;
  const [tab, setTab] = useState<Tab>('entry');
  const [focus, setFocus] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const s = useCostDraft();
  const flag = useLiveDoc<{ enabled?: boolean }>(storePath('config/aiCost'));
  const aiEnabled = flag.loading ? null : flag.data?.enabled === true;
  const [flagErr, setFlagErr] = useState<string | null>(null);
  const openDrafts = useLiveQuery<{ source: string; status: string; updatedAtMs: number; input: { text: string | null; attachments: unknown[] } }>(
    query(collection(db, storePath('costDrafts')), where('status', 'in', ['created', 'analyzing', 'review', 'failed']), orderBy('updatedAtMs', 'desc'), limit(6)), 'open-cost-drafts');

  const todaySummary = useMemo(() => {
    const rows = data.expenses.filter((e) => e.status === 'active' && !e.settlesExpenseId && e.businessDate === today && e.category !== 'capital');
    return { count: rows.length, totalSen: rows.reduce((t, e) => t + e.amountSen, 0), pendingUsage: data.purchaseDetails.filter((p) => p.usageState === 'pending' && p.purchasedDate === today).length };
  }, [data, today]);

  const enableAi = async () => {
    setFlagErr(null);
    try { await setAiEnabled(true); } catch (e) { setFlagErr(failureText(e)); }
  };
  const afterSave = () => { props.refresh(); setRefreshKey((k) => k + 1); };
  const others = openDrafts.data.filter((x) => x.id !== s.draftId);

  return (
    <>
      <div role="tablist" aria-label="AI 记成本" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => { setTab(t.id); if (t.id !== 'entry') afterSave(); }}
            className={`-mb-px flex min-h-12 shrink-0 items-center gap-2 border-b-2 px-3 text-[15px] font-semibold ${tab === t.id ? 'border-brand text-brand' : 'border-transparent text-ink-2 hover:text-ink'}`}>
            <Icon name={t.icon} size={18} />{t.label}
          </button>
        ))}
      </div>
      {flagErr && <p role="alert" className="mb-4 rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">{flagErr}</p>}

      {tab === 'entry' && (
        <>
          {s.phase === 'input' && (
            <>
              <div className="mb-6">
                <div className="mb-1.5 text-[11px] tracking-[0.18em] text-ink-2">LESS TYPING, CLEARER COSTS / 少填一点，记清每一笔</div>
                <h2 className="text-2xl font-bold tracking-tight sm:text-[29px]">今天花了什么，告诉我就好。</h2>
                <p className="mt-1.5 text-[13px] text-ink-2">拍一张收据，或像平常说话一样输入。整理完，你说了算。</p>
              </div>
              <EntryComposer s={s} aiEnabled={aiEnabled} todaySummary={todaySummary} onEnableAi={() => void enableAi()} />
              {others.length > 0 && (
                <Panel className="mt-5" title="还没保存的草稿" sub="刷新或换设备后可以接着改；不保存不会入账。">
                  <ul className="divide-y divide-line">{others.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                      <Tag tone={o.status === 'failed' ? 'red' : 'gold'}>{STATUS_ZH[o.status] ?? o.status}</Tag>
                      <span className="min-w-0 flex-1 truncate">{SOURCE_LABEL[o.source]} · {o.input.text ? o.input.text.slice(0, 40) : `${o.input.attachments.length} 张收据照片`}</span>
                      <small className="text-xs text-ink-2">{new Date(o.updatedAtMs).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
                      <Btn small onClick={() => s.open(o.id)}>继续</Btn>
                    </li>
                  ))}</ul>
                </Panel>
              )}
            </>
          )}
          {s.phase === 'analyzing' && (
            <section className="mx-auto max-w-xl rounded-3xl border border-line bg-card p-8 text-center shadow-card" aria-live="polite">
              <span className="mx-auto mb-4 grid h-14 w-14 animate-pulse place-items-center rounded-full bg-brand-soft text-brand motion-reduce:animate-none"><Icon name="sparkle" size={28} /></span>
              <h2 className="text-xl font-bold">{s.busy === 'uploading' ? '正在上传收据…' : '正在整理项目、金额和分类…'}</h2>
              <p className="mt-2 text-sm text-ink-2">不会自动记账。整理完你可以逐项修改。{s.draft?.source === 'receipt' ? '长收据可能需要半分钟左右。' : ''}</p>
              <p className="mt-1 text-xs text-ink-2">离开这个页面也没关系，回来后会接着显示结果，不会重复收费。</p>
            </section>
          )}
          {s.phase === 'pending' && s.draft && (
            <PendingCard title={s.similar.length ? '这张收据好像已经在别的草稿里' : '这份草稿还没整理'}
              body={s.similar.length ? `相同的图片出现在 ${s.similar.length} 份草稿中。可以打开原来的草稿接着改，或者确认这是另一笔再识别。` : '原话 / 图片已经保存。可以现在整理，或直接手动填写。'}
              actions={<>
                {s.similar.filter((x) => !['committed', 'discarded', 'expired'].includes(x.status)).slice(0, 1).map((x) => <Btn key={x.draftId} tone="dark" onClick={() => s.open(x.draftId)}>打开原来的草稿</Btn>)}
                <Btn tone="primary" disabled={aiEnabled !== true || s.busy !== null} onClick={() => void s.analyze()}><Icon name="sparkle" size={18} />{s.similar.length ? '这是另一笔，继续识别' : '现在整理'}</Btn>
                <Btn onClick={s.fillManually}>手动填写</Btn>
                <Btn tone="ghost" onClick={() => void s.change({ discard: true })}>放弃这份草稿</Btn>
              </>} error={s.error} />
          )}
          {s.phase === 'failed' && s.draft && (
            <PendingCard title="这次没能整理出来" tone="red"
              body={`${s.draft.lastAttempt?.reason === 'vision_unavailable' ? '主服务暂时不可用，备用服务没有配置看图能力。' : 'Claude 和备用服务都没有给出可用的结果。'}原话和图片都已保留，没有记任何账。可以稍后重试，或者直接手动填写。`}
              actions={<>
                <Btn tone="primary" disabled={aiEnabled !== true || s.busy !== null} onClick={() => void s.analyze(true)}><Icon name="refresh" size={18} />再试一次</Btn>
                <Btn tone="dark" onClick={s.fillManually}>手动填写</Btn>
                <Btn tone="ghost" onClick={() => void s.change({ discard: true })}>放弃这份草稿</Btn>
              </>} error={s.error} quote={s.draft.input.text} />
          )}
          {s.phase === 'review' && s.draft && s.local && <DraftReview s={s} today={today} ingredients={data.ingredients} onLater={s.reset} />}
          {s.phase === 'saved' && s.receipt && (
            <SaveResult receipt={s.receipt} onNext={() => { afterSave(); s.reset(); }} onView={() => { afterSave(); setFocus(s.receipt!.receiptId); setTab('history'); s.reset(); }} />
          )}

          <details className="mt-8 rounded-2xl border border-dashed border-line bg-card/60 p-4 sm:p-5">
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 font-semibold">已经在记录食材用量？ · 详细用料管理<Icon name="chevron-right" size={18} /></summary>
            <p className="mt-1 text-xs text-ink-2">批次、开始使用、换批、成本核算范围与份量损耗都在这里。AI 不会自动判断上一批用完；采购不等于实际消耗。</p>
            <div className="mt-5"><IngredientsTab {...props} /></div>
          </details>
        </>
      )}
      {tab === 'history' && <PurchaseHistory data={data} open={props.open} run={props.run} busy={props.busy} today={today} focusReceiptId={focus} />}
      {tab === 'insights' && <CostInsights today={today} refreshKey={refreshKey} onGoEntry={() => setTab('entry')} onRecord={(id) => { const r = data.expenses.find((e) => e.id === id); if (r?.costReceiptId) setFocus(r.costReceiptId); setTab('history'); }} />}
      <p className="mt-6 text-xs text-ink-2">今日已记 {formatRM(todaySummary.totalSen)} · AI 只给建议，账目以你确认保存的为准{aiEnabled === true ? ' · 默认 Claude，备用 DeepSeek' : ''}</p>
    </>
  );
}

function PendingCard({ title, body, actions, error, tone, quote }: { title: string; body: string; actions: ReactNode; error: string | null; tone?: 'red'; quote?: string | null }) {
  return (
    <section className={`mx-auto max-w-2xl rounded-3xl border p-6 shadow-card sm:p-8 ${tone === 'red' ? 'border-[#e9cfc7] bg-[#fdf3ef]' : 'border-line bg-card'}`} aria-live="polite">
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="mt-2 text-sm text-ink-2">{body}</p>
      {quote && <blockquote className="mt-3 rounded-xl border-l-4 border-[#a9b99c] bg-[#eef2e8] px-4 py-3 text-sm">{quote}</blockquote>}
      <div className="mt-5 flex flex-wrap gap-2">{actions}</div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
