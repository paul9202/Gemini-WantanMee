/**
 * 采购记录：按购买日列出采购与 AI 记的开支，可按日期、名称、分类筛选；详情可回看原话 / 收据、补用量、补付款或作废（沿用原流程）。
 * 补用量只给原采购建一批库存，原支出不变、不再记钱。
 */
import { useEffect, useMemo, useState } from 'react';
import { BATCH_STATUS_ZH, COST_CATEGORY_ZH, COST_SOURCE_ZH, CostCategory, costCategoryOfIngredient, INGREDIENT_CATEGORIES, PLAN_ITEM_ZH, isQuantity } from '../../../domain';
import type { ExpenseDoc } from '../../../domain/ledger';
import { receiptImageUrl } from '../../../data/firebase/aiCost';
import { Icon } from '../../../ui/visual';
import type { TabProps } from '../FinancePage';
import type { CostReceiptDoc, PurchaseDetailDoc } from '../finance/data';
import { Btn, Dialog, Empty, Field, inputCls, Note, Panel, Tag } from '../finance/ui';
import { rm } from './model';

interface Row { e: ExpenseDoc; category: CostCategory | 'fixed_other'; outstandingSen: number; pd: PurchaseDetailDoc | null; receipt: CostReceiptDoc | null }

const SHORT: Record<string, string> = { noodle: '面和面薄', wonton: '云吞', topping: '配料', seasoning: '调味料', other_food: '其他食材', gas: '煤气', misc: '杂费', wage: '员工工资', rent: '档口租金', fridge_power: '冰箱电费', fixed_other: '固定费用' };
const SOURCE_TAG: Record<string, string> = { text: 'AI · 原话', receipt: 'AI · 收据', manual: '手动' };

export function PurchaseHistory({ data, open, run, busy, focusReceiptId, today }: Pick<TabProps, 'data' | 'open' | 'run' | 'busy' | 'today'> & { focusReceiptId: string | null }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'all' | 'food' | 'daily' | string>('all');
  const [detail, setDetail] = useState<Row | null>(null);
  const [usage, setUsage] = useState<Row | null>(null);

  const rows = useMemo<Row[]>(() => {
    const settled = new Map<string, number>();
    for (const s of data.expenses) if (s.status === 'active' && s.settlesExpenseId) settled.set(s.settlesExpenseId, (settled.get(s.settlesExpenseId) ?? 0) + s.paidSen);
    const batches = new Map(data.batches.map((b) => [b.id, b]));
    const pds = new Map(data.purchaseDetails.map((p) => [p.expenseId, p]));
    const receipts = new Map(data.costReceipts.map((r) => [r.id, r]));
    return data.expenses
      .filter((e) => !e.settlesExpenseId && (e.category === 'purchase' || e.costReceiptId))
      .map((e) => {
        const b = e.ingredientBatchId ? batches.get(e.ingredientBatchId) : undefined;
        const category: Row['category'] = e.costCategory ?? (e.category === 'purchase' ? (b ? costCategoryOfIngredient(b.category) : 'other_food') : e.category === 'fixed_payment' ? (e.planItem === 'rent' || e.planItem === 'fridge_power' ? e.planItem : 'fixed_other') : ((e.planItem as CostCategory) ?? 'misc'));
        return { e, category, outstandingSen: e.status === 'active' ? Math.max(0, e.amountSen - e.paidSen - (settled.get(e.id) ?? 0)) : 0, pd: pds.get(e.id) ?? null, receipt: e.costReceiptId ? receipts.get(e.costReceiptId) ?? null : null };
      })
      .sort((a, b) => b.e.businessDate.localeCompare(a.e.businessDate) || b.e.occurredAtMs - a.e.occurredAtMs);
  }, [data]);

  useEffect(() => {
    if (!focusReceiptId) return;
    const r = rows.find((x) => x.e.costReceiptId === focusReceiptId);
    if (r) { setMonth(r.e.businessDate.slice(0, 7)); setDetail(r); }
  }, [focusReceiptId, rows]);

  const food = ['noodle', 'wonton', 'topping', 'seasoning', 'other_food'];
  const shown = rows.filter((r) => r.e.businessDate.startsWith(month) && (!q.trim() || r.e.description.includes(q.trim()))
    && (cat === 'all' || (cat === 'food' ? food.includes(r.category) : cat === 'daily' ? !food.includes(r.category) : r.category === cat)));
  const active = shown.filter((r) => r.e.status === 'active');
  const pendingUsage = rows.filter((r) => r.e.status === 'active' && r.pd?.usageState === 'pending').length;

  return (
    <div className="grid gap-5">
      <Panel pad={false} title="采购记录" sub={`${month} · ${active.length} 笔有效 · 合计 ${rm(active.reduce((s, r) => s + r.e.amountSen, 0))}`}
        actions={<div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <input type="month" aria-label="月份" value={month} max={today.slice(0, 7)} onChange={(e) => setMonth(e.target.value || today.slice(0, 7))} className={`${inputCls} !w-40`} />
          <select aria-label="分类" value={cat} onChange={(e) => setCat(e.target.value)} className={`${inputCls} !w-36`}>
            <option value="all">全部分类</option><option value="food">全部食材</option><option value="daily">全部日常开支</option>
            {Object.entries(SHORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#d9ddcf] bg-card px-3 sm:w-48 sm:flex-none"><Icon name="search" size={16} className="text-ink-2" /><input aria-label="搜索名称" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
        </div>}>
        {pendingUsage > 0 && <div className="px-5 pb-3 sm:px-6"><Note>{pendingUsage} 笔采购还没有数量。支出已照常计入；补上数量和单位后，才能比较同规格单价。</Note></div>}
        {!shown.length ? <div className="p-6"><Empty>这个月还没有符合条件的记录。</Empty></div> : (
          <ul className="divide-y divide-line">
            {shown.map((r) => (
              <li key={r.e.id}>
                <button type="button" onClick={() => setDetail(r)} className={`flex w-full min-h-16 items-center gap-3 px-5 py-3 text-left hover:bg-subtle sm:px-6 ${r.e.status === 'voided' ? 'opacity-55' : ''}`}>
                  <span className="w-12 shrink-0 text-xs text-ink-2 tabular-nums">{r.e.businessDate.slice(5).replace('-', '/')}</span>
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-sm">{r.e.description}</b>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Tag>{SHORT[r.category]}</Tag>
                      {r.e.status === 'voided' ? <Tag tone="red">已作废</Tag> : r.outstandingSen > 0 ? <Tag tone="gold">待付 {rm(r.outstandingSen)}</Tag> : <Tag tone="green">已付</Tag>}
                      {r.pd?.usageState === 'pending' && r.e.status === 'active' && <Tag tone="gold">用量待补</Tag>}
                      {r.receipt && <Tag>{SOURCE_TAG[r.receipt.source]}</Tag>}
                    </span>
                  </span>
                  <b className="shrink-0 tabular-nums">{rm(r.e.amountSen)}</b>
                  <Icon name="chevron-right" size={16} className="shrink-0 text-ink-2" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {detail && <RecordDialog row={detail} rows={rows} data={data} onClose={() => setDetail(null)}
        onUsage={() => { setUsage(detail); setDetail(null); }}
        onSettle={() => { const r = detail; setDetail(null); open({ kind: 'settle', expense: r.e, outstandingSen: r.outstandingSen }); }}
        onVoid={() => {
          const r = detail; setDetail(null);
          const b = r.e.ingredientBatchId ? data.batches.find((x) => x.id === r.e.ingredientBatchId) : undefined;
          open(b ? { kind: 'voidBatch', batch: b } : { kind: 'voidExpense', expense: r.e });
        }} />}
      {usage && usage.pd && <UsageDialog row={usage} pd={usage.pd} data={data} run={run} busy={busy} onClose={() => setUsage(null)} />}
    </div>
  );
}

function RecordDialog({ row, rows, data, onClose, onUsage, onSettle, onVoid }: { row: Row; rows: Row[]; data: TabProps['data']; onClose: () => void; onUsage: () => void; onSettle: () => void; onVoid: () => void }) {
  const r = row.receipt;
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made: string[] = [];
    let alive = true;
    Promise.all((r?.attachments ?? []).map((a) => receiptImageUrl(a.path).then((u) => (made.push(u), u)).catch(() => ''))).then((u) => alive && setUrls(u));
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [r?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const siblings = r ? rows.filter((x) => x.e.costReceiptId === r.id) : [];
  const batch = row.e.ingredientBatchId ? data.batches.find((b) => b.id === row.e.ingredientBatchId) : undefined;
  const active = row.e.status === 'active';
  return (
    <Dialog title={row.e.description} sub={`${row.e.businessDate} · ${SHORT[row.category]} · ${rm(row.e.amountSen)}`} wide onClose={onClose}
      footer={<div className="flex w-full flex-wrap justify-end gap-2">
        {active && row.pd?.usageState === 'pending' && <Btn tone="dark" onClick={onUsage}><Icon name="plus" size={16} />补数量 / 放入库存</Btn>}
        {active && row.outstandingSen > 0 && <Btn onClick={onSettle}>补登付款</Btn>}
        {active && <Btn tone="danger" onClick={onVoid}>作废</Btn>}
        <Btn onClick={onClose}>关闭</Btn>
      </div>}>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-ink-2">状态</dt><dd className="font-semibold">{active ? (row.outstandingSen > 0 ? `待付 ${rm(row.outstandingSen)}` : '已付') : `已作废${row.e.voidReason ? `（${row.e.voidReason}）` : ''}`}</dd></div>
        <div><dt className="text-xs text-ink-2">付款来源</dt><dd className="font-semibold">{COST_SOURCE_ZH[row.e.paymentSource]}</dd></div>
        <div><dt className="text-xs text-ink-2">用量</dt><dd className="font-semibold">{batch ? `${batch.quantity} ${batch.unit} · ${BATCH_STATUS_ZH[batch.status]}` : row.pd ? '待补' : '—'}</dd></div>
        <div><dt className="text-xs text-ink-2">归类</dt><dd className="font-semibold">{row.e.planItem ? PLAN_ITEM_ZH[row.e.planItem] : row.e.costCategory ? COST_CATEGORY_ZH[row.e.costCategory] : '食材进货'}</dd></div>
      </dl>
      {r ? (
        <section className="mt-5 border-t border-line pt-4">
          <h3 className="mb-2 font-bold">来源 · {SOURCE_TAG[r.source]}{r.extractionMeta ? ` · ${r.extractionMeta.provider === 'claude' ? 'Claude' : 'DeepSeek（备用）'}` : ''}</h3>
          {r.text && <blockquote className="rounded-xl border-l-4 border-[#a9b99c] bg-[#eef2e8] px-4 py-3 text-sm">{r.text}</blockquote>}
          {urls.length > 0 && <div className="mt-2 grid grid-cols-3 gap-2">{urls.map((u, i) => (u ? <img key={i} src={u} alt={`收据第 ${i + 1} 页`} className="aspect-[3/4] w-full rounded-lg border border-line object-contain" /> : <span key={i} className="text-xs text-ink-2">图片无法读取</span>))}</div>}
          <ul className="mt-3 divide-y divide-line text-sm">{siblings.map((x) => <li key={x.e.id} className="flex justify-between py-1.5"><span>{x.e.description}{x.e.status === 'voided' ? '（已作废）' : ''}</span><span className="tabular-nums">{rm(x.e.amountSen)}</span></li>)}</ul>
          <p className="mt-2 text-xs text-ink-2">这张凭证合计 {rm(r.totalSen)}{r.discountSen ? ` · 折扣 ${rm(r.discountSen)} 已分摊` : ''}{r.printedTotalSen !== null ? ` · 收据原总额 ${rm(r.printedTotalSen)}` : ''}{r.difference ? ` · 差额说明：${r.difference.reason}` : ''}</p>
          {r.excluded.length > 0 && <p className="mt-1 text-xs text-ink-2">不计入营业：{r.excluded.map((x) => `${x.name} ${rm(x.netSen)}（${x.reason}）`).join('；')}</p>}
          {r.duplicateAcknowledgement && <p className="mt-1 text-xs text-warn">保存时提示过可能重复，老板说明：{r.duplicateAcknowledgement.reason}</p>}
        </section>
      ) : <p className="mt-5 border-t border-line pt-4 text-sm text-ink-2">旧版录入的记录，没有原话或收据凭证。</p>}
    </Dialog>
  );
}

function UsageDialog({ row, pd, data, run, busy, onClose }: { row: Row; pd: PurchaseDetailDoc; data: TabProps['data']; run: TabProps['run']; busy: boolean; onClose: () => void }) {
  const options = data.ingredients.filter((i) => !pd.ingredientCategory || i.category === pd.ingredientCategory);
  const [ing, setIng] = useState(pd.ingredientId ?? options.find((i) => i.name === pd.name)?.id ?? options[0]?.id ?? '');
  const sel = data.ingredients.find((i) => i.id === ing);
  const [qty, setQty] = useState(pd.quantity !== null ? String(pd.quantity) : '');
  const [unit, setUnit] = useState(pd.unit ?? sel?.unit ?? '');
  const q = Number(qty);
  const ok = Boolean(ing) && isQuantity(q) && unit.trim().length > 0;
  return (
    <Dialog title={`补数量：${row.e.description}`} sub={`原采购 ${rm(row.e.amountSen)} 不变，也不会再记一笔钱；只是放入库存（待启用）。开封、换批请到「详细用料管理」。`} onClose={onClose}
      footer={<><Btn onClick={onClose}>取消</Btn><Btn tone="primary" disabled={!ok || busy} onClick={async () => { if (await run('completePurchaseUsage', { purchaseId: pd.id, expectedRevision: pd.revision, ingredientId: ing, quantity: q, unit: unit.trim() }, '数量已补上，放入库存待启用')) onClose(); }}>保存数量</Btn></>}>
      <Field label="对应食材">
        <select value={ing} onChange={(e) => { setIng(e.target.value); setUnit(data.ingredients.find((i) => i.id === e.target.value)?.unit ?? unit); }} className={inputCls}>
          {INGREDIENT_CATEGORIES.filter((c) => options.some((o) => o.category === c.id)).map((c) => <optgroup key={c.id} label={c.nameZh}>{options.filter((o) => o.category === c.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="数量"><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} placeholder="例如 1.5" /></Field>
        <Field label="单位"><input value={unit} maxLength={10} onChange={(e) => setUnit(e.target.value)} className={inputCls} /></Field>
      </div>
    </Dialog>
  );
}
