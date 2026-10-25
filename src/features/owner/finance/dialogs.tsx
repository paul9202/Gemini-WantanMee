/**
 * 收支改版的录入弹窗。每个弹窗打开时生成一个 operationId：结果不明时重试沿用同一 ID，服务器只入账一次。
 * 常用字段在前，可选资料折叠；底部操作栏固定，手机上保存按钮始终可见。
 */
import { useState } from 'react';
import { newOperationId } from '../../../data/firebase/commands';
import {
  addMonths, BATCH_STATUS_ZH, BatchDoc, batchPeriod, formatDays, formatRM, Ingredient, INGREDIENT_CATEGORIES, IngredientCategory, isQuantity, monthOf,
  monthlyPlanRows, msToZonedLocal, NewExpenseLink, nextDailyTarget, parseRMInput, PLAN_ITEM_ZH, PlanExpense, RecurringItem, startupSummary, validateExpenseLink, rentForMonth, Sen, STARTUP_GROUP_ZH, STARTUP_PAYMENT_ZH, StartupCostDoc,
  StartupGroup, StartupPayment, suggestedMonthlyBalls, zonedLocalToMs,
} from '../../../domain';
import type { ExpenseDoc } from '../../../domain/ledger';
import type { FinanceData, Runner } from './data';
import { Btn, Dialog, Field, inputCls, More, Radio, shortDate, Source, SourceSelect, Tag } from './ui';

interface Base { run: Runner; busy: boolean; onClose: () => void }

const parseQty = (s: string) => {
  const n = Number(s.replace(/[,\s]/g, ''));
  return s.trim() && isQuantity(n) ? n : null;
};

function Footer({ onClose, busy, disabled, label, tone = 'primary' }: { onClose: () => void; busy: boolean; disabled?: boolean; label: string; tone?: 'primary' | 'dark' | 'danger' }) {
  return (
    <>
      <Btn onClick={onClose} className="flex-1 sm:flex-none sm:min-w-28">取消</Btn>
      <Btn type="submit" tone={tone} disabled={busy || disabled} className="flex-[2] sm:flex-none sm:min-w-36">{busy ? '正在保存…' : label}</Btn>
    </>
  );
}

/** 表单 + 弹窗：Enter 提交，底部按钮也是提交按钮。 */
function FormDialog({ title, sub, onClose, onSubmit, footer, children, wide }: { title: string; sub?: string; onClose: () => void; onSubmit: () => void; footer: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <Dialog title={title} sub={sub} onClose={onClose} wide={wide} footer={footer}>{children}</Dialog>
    </form>
  );
}

function IngredientSelect({ ingredients, value, onChange, category }: { ingredients: Ingredient[]; value: string; onChange: (id: string) => void; category?: IngredientCategory }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls} aria-label="食材" required>
      <option value="" disabled>选择食材</option>
      {INGREDIENT_CATEGORIES.filter((c) => !category || c.id === category).map((c) => (
        <optgroup key={c.id} label={c.nameZh}>
          {ingredients.filter((i) => i.category === c.id).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function QtyUnit({ qty, setQty, unit, setUnit }: { qty: string; setQty: (v: string) => void; unit: string; setUnit: (v: string) => void }) {
  return (
    <div className="grid grid-cols-[1fr_7rem] gap-3">
      <Field label="数量"><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="例如 120" className={inputCls} required /></Field>
      <Field label="单位"><input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={10} className={inputCls} required /></Field>
    </div>
  );
}

// ───────────────────────── 食材 ─────────────────────────

export function ExistingBatchDialog({ data, ingredientId, tz, nowMs, run, busy, onClose }: Base & { data: FinanceData; ingredientId?: string; tz: string; nowMs: number }) {
  const [op] = useState(newOperationId);
  const [ing, setIng] = useState(ingredientId ?? '');
  const def = data.ingredients.find((i) => i.id === ing);
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState(def?.unit ?? '');
  const [cost, setCost] = useState('');
  const [costLater, setCostLater] = useState(false);
  const [inUse, setInUse] = useState(true);
  const [start, setStart] = useState(msToZonedLocal(nowMs, tz));
  const [note, setNote] = useState('');
  const q = parseQty(qty);
  const c = parseRMInput(cost);
  const startMs = zonedLocalToMs(start, tz);
  const ok = ing && q !== null && unit.trim() && (costLater || c !== null) && (!inUse || (startMs !== null && startMs <= nowMs + 600_000));
  return (
    <FormDialog title="录入现有食材" sub="手上这一批的数量、成本与实际开始使用时间。不会生成采购支出。" onClose={onClose}
      onSubmit={async () => ok && (await run('recordExistingBatch', { operationId: op, ingredientId: ing, quantity: q, unit: unit.trim(), costSen: costLater ? null : c, startedAtMs: inUse ? startMs : null, note }, `${def?.name ?? '食材'}已录入`)) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="保存这一批" />}>
      <Field label="食材"><IngredientSelect ingredients={data.ingredients} value={ing} onChange={(id) => { setIng(id); setUnit(data.ingredients.find((i) => i.id === id)?.unit ?? ''); }} /></Field>
      <QtyUnit qty={qty} setQty={setQty} unit={unit} setUnit={setUnit} />
      <Field label="这一批对应成本 RM" hint="如果已用掉一部分，填剩余数量及其对应成本。">
        <input inputMode="decimal" value={cost} disabled={costLater} onChange={(e) => setCost(e.target.value)} placeholder={costLater ? '成本待补' : '例如 96.00'} className={inputCls} />
      </Field>
      <label className="-mt-2 mb-4 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={costLater} onChange={(e) => setCostLater(e.target.checked)} className="h-5 w-5 accent-[#28644c]" />成本暂时不知道，之后补（标记「成本待补」）</label>
      <Radio name="in-use" checked={inUse} onChange={() => setInUse(true)} title="已经在使用" sub="填写实际开始使用时间" />
      <Radio name="in-use" checked={!inUse} onChange={() => setInUse(false)} title="还没开封，放在库存" sub="之后启用时再记开始时间" />
      {inUse && <Field label="实际开始使用时间" hint="不一定是购买当天。"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} required /></Field>}
      <More summary="备注（可选）"><textarea value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={`${inputCls} min-h-20 py-2`} aria-label="备注" /></More>
    </FormDialog>
  );
}

export function PurchaseDialog({ data, ingredientId, today, run, busy, onClose }: Base & { data: FinanceData; ingredientId?: string; today: string }) {
  const [op] = useState(newOperationId);
  const [ing, setIng] = useState(ingredientId ?? '');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState(data.ingredients.find((i) => i.id === ingredientId)?.unit ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [paid, setPaid] = useState(true);
  const [source, setSource] = useState<Source>('drawer');
  const [note, setNote] = useState('');
  const q = parseQty(qty);
  const a = parseRMInput(amount);
  const ok = ing && q !== null && unit.trim() && a && date && date <= today;
  const name = data.ingredients.find((i) => i.id === ing)?.name ?? '食材';
  return (
    <FormDialog title="记录新进货" sub="先记采购与付款，放入库存；真正开始用时再另记开始时间，不会自动结束旧批。" onClose={onClose}
      onSubmit={async () => ok && (await run('recordIngredientPurchase', { operationId: op, ingredientId: ing, quantity: q, unit: unit.trim(), amountSen: a, purchasedDate: date, paid, paymentSource: source, note }, `${name}进货已记录，放入库存`)) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label={a ? `保存 ${formatRM(a)}` : '保存进货'} />}>
      <Field label="食材"><IngredientSelect ingredients={data.ingredients} value={ing} onChange={(id) => { setIng(id); setUnit(data.ingredients.find((i) => i.id === id)?.unit ?? ''); }} /></Field>
      <QtyUnit qty={qty} setQty={setQty} unit={unit} setUnit={setUnit} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="整批金额 RM"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="例如 42.00" className={inputCls} required /></Field>
        <Field label="购买日期"><input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={inputCls} required /></Field>
      </div>
      <Radio name="paid" checked={paid} onChange={() => setPaid(true)} title="已付款" sub="按购买日记入已付支出" />
      <Radio name="paid" checked={!paid} onChange={() => setPaid(false)} title="还没付（赊账）" sub="之后在「待付」里补登付款，不会重复记支出" />
      <Field label="付款来源"><SourceSelect value={source} onChange={setSource} /></Field>
      <More summary="备注（可选）"><textarea value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={`${inputCls} min-h-20 py-2`} aria-label="备注" /></More>
    </FormDialog>
  );
}

const batchLine = (b: BatchDoc) => `${b.quantity} ${b.unit} · ${b.costSen === null ? '成本待补' : formatRM(b.costSen)}`;

/** 换批：选择要启用的库存批，填实际开始使用时间；逐个确认旧批已用完或继续用。 */
export function StartBatchDialog({ data, ingredientId, tz, nowMs, run, busy, onClose }: Base & { data: FinanceData; ingredientId: string; tz: string; nowMs: number }) {
  const [op] = useState(newOperationId);
  const ing = data.ingredients.find((i) => i.id === ingredientId);
  const stocked = data.batches.filter((b) => b.ingredientId === ingredientId && b.status === 'stocked').sort((a, b) => a.createdAtMs - b.createdAtMs);
  const inUse = data.batches.filter((b) => b.ingredientId === ingredientId && b.status === 'in_use');
  const [batchId, setBatchId] = useState(stocked[0]?.id ?? '');
  const [start, setStart] = useState(msToZonedLocal(nowMs, tz));
  const [actions, setActions] = useState<Record<string, { action: 'finished' | 'continue'; end: string; waste: string; note: string }>>(
    Object.fromEntries(inUse.map((b) => [b.id, { action: 'finished', end: '', waste: '', note: '' }])),
  );
  const startMs = zonedLocalToMs(start, tz);
  const next = stocked.find((b) => b.id === batchId);
  const prevPayload = inUse.map((b) => {
    const a = actions[b.id];
    return { batchId: b.id, action: a.action, endedAtMs: a.action === 'finished' && a.end ? zonedLocalToMs(a.end, tz) : null, wastageQuantity: a.action === 'finished' && a.waste ? parseQty(a.waste) : null, endNote: a.note };
  });
  const prevOk = prevPayload.every((p, i) => p.action === 'continue' || ((!actions[inUse[i].id].end || p.endedAtMs !== null) && (!actions[inUse[i].id].waste || p.wastageQuantity !== null)));
  const ok = next && startMs !== null && startMs <= nowMs + 600_000 && prevOk;
  const set = (id: string, patch: Partial<(typeof actions)[string]>) => setActions((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  return (
    <FormDialog title="换新一批，记下开始时间" sub="只需记这一批，不用每天猜消耗量。" onClose={onClose}
      onSubmit={async () => ok && (await run('startBatch', { operationId: op, batchId, startedAtMs: startMs, previous: prevPayload }, `${ing?.name ?? '食材'}新批已启用`)) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="确认换批" />}>
      {inUse.map((b) => (
        <div key={b.id} className="mb-3 rounded-xl border border-line bg-[#f3f4ee] p-4">
          <Tag tone="green">目前使用中</Tag>
          <div className="mt-2 text-sm font-semibold">{ing?.name} · {batchLine(b)}</div>
          <div className="mt-1 text-xs text-ink-2">{b.startedAtMs ? msToZonedLocal(b.startedAtMs, tz).replace('T', ' ') : ''} 开始使用</div>
        </div>
      ))}
      {stocked.length > 1 ? (
        <Field label="启用哪一批库存"><select value={batchId} onChange={(e) => setBatchId(e.target.value)} className={inputCls}>{stocked.map((b) => <option key={b.id} value={b.id}>{b.purchasedDate ? `${shortDate(b.purchasedDate)} 进货 · ` : '现有 · '}{batchLine(b)}</option>)}</select></Field>
      ) : next && (
        <div className="mb-3 rounded-xl bg-ok-bg p-4 text-sm">
          <b className="font-semibold">启用库存新批：{batchLine(next)}</b>
          <div className="mt-1 text-xs text-ink-2">{next.origin === 'purchase' ? `${next.purchasedDate} 已记进货，本次不重复记支出。` : '首次录入的现有食材，不产生支出。'}</div>
        </div>
      )}
      {next && <More summary="核对新批数量与成本"><p className="text-sm text-ink-2">{batchLine(next)}{next.note ? ` · ${next.note}` : ''}。数量或金额有误时，请在用料记录里作废这一批后重新记录。</p></More>}
      <Field label="新一批开始使用时间" hint="填写实际开封使用时间，不一定是购买当天。"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} required /></Field>
      {inUse.map((b) => {
        const a = actions[b.id];
        return (
          <fieldset key={b.id} className="mb-2">
            <legend className="mb-1 text-[13px] font-semibold">上一批的实际情况{inUse.length > 1 ? `（${batchLine(b)}）` : ''}</legend>
            <Radio name={`prev-${b.id}`} checked={a.action === 'finished'} onChange={() => set(b.id, { action: 'finished' })} title="上一批已用完" sub="默认在新批开始时结束旧批，也可另填时间。" />
            <Radio name={`prev-${b.id}`} checked={a.action === 'continue'} onChange={() => set(b.id, { action: 'continue' })} title="上一批还有剩，继续使用" sub="两批同时在用；旧批用完后再记结束，成本继续等待核算。" />
            {a.action === 'finished' && (
              <More summary="补充旧批结束时间、损耗或备注（可选）">
                <Field label="旧批实际结束时间" hint="留空 = 新批开始时间"><input type="datetime-local" value={a.end} onChange={(e) => set(b.id, { end: e.target.value })} className={inputCls} /></Field>
                <Field label={`损耗数量（${b.unit}）`}><input inputMode="decimal" value={a.waste} onChange={(e) => set(b.id, { waste: e.target.value })} className={inputCls} /></Field>
                <Field label="备注"><input value={a.note} maxLength={200} onChange={(e) => set(b.id, { note: e.target.value })} className={inputCls} /></Field>
              </More>
            )}
          </fieldset>
        );
      })}
      {!stocked.length && <p className="text-sm text-danger">这项食材没有库存批次。请先「记录新进货」或「录入现有食材」（放库存）。</p>}
    </FormDialog>
  );
}

export function FinishBatchDialog({ batch, tz, nowMs, run, busy, onClose }: Base & { batch: BatchDoc; tz: string; nowMs: number }) {
  const [op] = useState(newOperationId);
  const [end, setEnd] = useState(msToZonedLocal(nowMs, tz));
  const [waste, setWaste] = useState('');
  const [note, setNote] = useState('');
  const endMs = zonedLocalToMs(end, tz);
  const w = waste ? parseQty(waste) : null;
  const ok = endMs !== null && batch.startedAtMs !== null && endMs > batch.startedAtMs && endMs <= nowMs + 600_000 && (!waste || w !== null);
  const preview = ok ? batchPeriod({ ...batch, status: 'finished', endedAtMs: endMs }) : null;
  return (
    <FormDialog title={`${batch.ingredientName} · 这一批用完了`} sub="记录实际结束时间，得出这一批的使用周期与平均每日成本。" onClose={onClose}
      onSubmit={async () => ok && (await run('finishBatch', { operationId: op, batchId: batch.id, endedAtMs: endMs, wastageQuantity: w, endNote: note }, '已记录用完')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="确认用完" tone="dark" />}>
      <p className="mb-4 rounded-xl bg-[#f3f4ee] p-4 text-sm">{batchLine(batch)} · {batch.startedAtMs ? msToZonedLocal(batch.startedAtMs, tz).replace('T', ' ') : ''} 开始使用</p>
      <Field label="实际结束时间"><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} required /></Field>
      <More summary="损耗与备注（可选）">
        <Field label={`损耗数量（${batch.unit}）`}><input inputMode="decimal" value={waste} onChange={(e) => setWaste(e.target.value)} className={inputCls} /></Field>
        <Field label="备注"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={inputCls} /></Field>
      </More>
      {preview && <p className="text-sm text-ink-2">周期 {formatDays(preview.days)} · {preview.avgDailySen === null ? '成本待补，补齐后才有平均日成本' : `平均 ${formatRM(preview.avgDailySen)} / 天`}（周期平均，不是逐日实际用量）</p>}
    </FormDialog>
  );
}

export function BatchCostDialog({ batch, run, busy, onClose }: Base & { batch: BatchDoc }) {
  const [op] = useState(newOperationId);
  const [cost, setCost] = useState(batch.costSen === null ? '' : (batch.costSen / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const c = parseRMInput(cost);
  const correcting = batch.costSen !== null;
  const ok = c !== null && (!correcting || reason.trim().length >= 2);
  return (
    <FormDialog title={correcting ? '更正这一批的成本' : '补上这一批的成本'} sub={`${batch.ingredientName} · ${batch.quantity} ${batch.unit}。只影响用料成本核算，不生成采购支出。`} onClose={onClose}
      onSubmit={async () => ok && (await run('setBatchCost', { operationId: op, batchId: batch.id, costSen: c, reason }, '成本已更新')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="保存成本" />}>
      <Field label="这一批对应成本 RM"><input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} className={inputCls} required /></Field>
      {correcting && <Field label="更正原因" hint="原成本会保留在修改记录里。"><input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className={inputCls} required /></Field>}
    </FormDialog>
  );
}

/** 通用「作废并写明原因」。 */
export function VoidDialog({ title, sub, onConfirm, busy, onClose, confirmLabel = '确认作废', reasonLabel = '作废原因' }: {
  title: string; sub: string; onConfirm: (reason: string) => Promise<boolean>; busy: boolean; onClose: () => void; confirmLabel?: string; reasonLabel?: string;
}) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog title={title} sub={sub} onClose={onClose} onSubmit={async () => reason.trim().length >= 2 && (await onConfirm(reason.trim())) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={reason.trim().length < 2} label={confirmLabel} tone="danger" />}>
      <Field label={reasonLabel} hint="记录不会删除，状态和原因会保留。"><input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className={inputCls} required /></Field>
    </FormDialog>
  );
}

export function AddIngredientDialog({ category, run, busy, onClose }: Base & { category: IngredientCategory }) {
  const [op] = useState(newOperationId);
  const [cat, setCat] = useState<IngredientCategory>(category);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const ok = name.trim() && unit.trim();
  return (
    <FormDialog title="添加食材" sub="自定义的食材会出现在对应分类里。" onClose={onClose}
      onSubmit={async () => ok && (await run('addIngredient', { operationId: op, category: cat, name: name.trim(), unit: unit.trim() }, `已添加「${name.trim()}」`)) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="添加" />}>
      <Field label="分类"><select value={cat} onChange={(e) => setCat(e.target.value as IngredientCategory)} className={inputCls}>{INGREDIENT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.nameZh}</option>)}</select></Field>
      <Field label="名称"><input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} className={inputCls} required /></Field>
      <Field label="常用单位" hint="例如 kg、包、瓶、粒"><input value={unit} maxLength={10} onChange={(e) => setUnit(e.target.value)} className={inputCls} required /></Field>
    </FormDialog>
  );
}

/** 用料记录：这项食材所有批次的时间线与操作。 */
export function BatchHistoryDialog({ ingredient, batches, expenses, tz, nowMs, onClose, onAction }: {
  ingredient: Ingredient; batches: BatchDoc[]; expenses: ExpenseDoc[]; tz: string; nowMs: number; onClose: () => void;
  onAction: (a: 'finish' | 'cost' | 'void' | 'settle' | 'start', b: BatchDoc) => void;
}) {
  const sorted = [...batches].sort((a, b) => (b.startedAtMs ?? b.createdAtMs) - (a.startedAtMs ?? a.createdAtMs));
  const time = (ms: number | null) => (ms ? msToZonedLocal(ms, tz).replace('T', ' ').slice(5) : '—');
  return (
    <Dialog title={`${ingredient.name} · 用料记录`} sub="每一批的购买、开始、结束与周期平均成本。" onClose={onClose} wide footer={<Btn onClick={onClose} className="w-full sm:w-auto">关闭</Btn>}>
      {!sorted.length && <p className="text-sm text-ink-2">还没有批次记录。</p>}
      <ol className="relative ml-2 border-l border-[#d4dbcd]">
        {sorted.map((b) => {
          const p = batchPeriod(b, nowMs);
          const exp = b.purchaseExpenseId ? expenses.find((e) => e.id === b.purchaseExpenseId) : undefined;
          const settled = exp ? expenses.some((e) => e.settlesExpenseId === exp.id && e.status === 'active') : false;
          const unpaid = exp && exp.status === 'active' && exp.paidSen < exp.amountSen && !settled;
          return (
            <li key={b.id} className={`relative mb-5 pl-5 ${b.status === 'voided' ? 'opacity-50' : ''}`}>
              <span className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ${b.status === 'in_use' ? 'bg-ok' : 'bg-[#9aa88d]'}`} />
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-sm">{batchLine(b)}</b>
                <Tag tone={b.status === 'in_use' ? 'green' : b.status === 'stocked' ? 'gold' : 'plain'}>{BATCH_STATUS_ZH[b.status]}</Tag>
                {b.origin === 'existing' ? <Tag>现有食材</Tag> : <Tag tone={unpaid ? 'gold' : 'plain'}>{unpaid ? '进货 · 未付' : '进货 · 已付'}</Tag>}
              </div>
              <div className="mt-1 grid gap-x-4 text-xs text-ink-2 sm:grid-cols-2">
                {b.purchasedDate && <span>购买 {b.purchasedDate}</span>}
                <span>开始 {time(b.startedAtMs)}</span>
                <span>结束 {time(b.endedAtMs)}</span>
                <span>周期 {p.state === 'complete' ? formatDays(p.days) : p.state === 'running' ? `已用 ${formatDays(p.days)}（未结束）` : '未启用'}</span>
                <span>平均日成本 {p.avgDailySen !== null ? `${formatRM(p.avgDailySen)} / 天` : p.costPending ? '成本待补' : '用完后核算'}</span>
                {b.wastageQuantity !== null && <span>损耗 {b.wastageQuantity} {b.unit}</span>}
                {(b.note || b.endNote) && <span className="sm:col-span-2">备注 {[b.note, b.endNote].filter(Boolean).join(' · ')}</span>}
                {b.voidReason && <span className="sm:col-span-2">作废原因 {b.voidReason}</span>}
              </div>
              {b.status !== 'voided' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {b.status === 'stocked' && <Btn small onClick={() => onAction('start', b)}>启用这一批</Btn>}
                  {b.status === 'in_use' && <Btn small onClick={() => onAction('finish', b)}>用完了</Btn>}
                  {b.origin === 'existing' && <Btn small onClick={() => onAction('cost', b)}>{b.costSen === null ? '补成本' : '更正成本'}</Btn>}
                  {unpaid && <Btn small onClick={() => onAction('settle', b)}>补登付款</Btn>}
                  <Btn small tone="ghost" onClick={() => onAction('void', b)}>作废</Btn>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-ink-2">换批时间只能得出周期平均值；逐日用量、剩余量与单份成本需要结合销售、损耗或盘点。</p>
    </Dialog>
  );
}

// ───────────────────────── 日常开支 ─────────────────────────

export function RentStartDialog({ data, today, run, busy, onClose }: Base & { data: FinanceData; today: string }) {
  const [op] = useState(newOperationId);
  const [month, setMonth] = useState(data.plan.rentStartMonth ?? monthOf(today));
  return (
    <FormDialog title="设置起租月份" sub="起租月为第 1 个月：前三个月 RM800 / 月，第 4 个月起 RM1,000 / 月。冰箱额外电费同月开始。" onClose={onClose}
      onSubmit={async () => /^\d{4}-\d{2}$/.test(month) && (await run('setExpensePlan', { operationId: op, rentStartMonth: month, staffEnabled: data.plan.staff.enabled }, '起租月份已保存')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!/^\d{4}-\d{2}$/.test(month)} label="保存" />}>
      <Field label="起租月份" hint="保存后，未关账营业日的固定费用摊销按新租金阶段计算；已关账的日结不变。"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} required /></Field>
      {/^\d{4}-\d{2}$/.test(month) && (
        <ul className="text-sm text-ink-2">
          {[0, 1, 2, 3].map((i) => { const m = addMonths(month, i); return <li key={m}>{m}：{formatRM(rentForMonth({ ...data.plan, rentStartMonth: month }, m)!)}{i === 3 ? ' 起' : ''}</li>; })}
        </ul>
      )}
    </FormDialog>
  );
}

export function RecurringPaymentDialog({ item, month, dueSen, today, run, busy, onClose }: Base & { item: RecurringItem; month: string; dueSen: Sen; today: string }) {
  const [op] = useState(newOperationId);
  const [m, setM] = useState(month);
  const [amount, setAmount] = useState(dueSen ? (dueSen / 100).toFixed(2) : '');
  const [date, setDate] = useState(today);
  const [source, setSource] = useState<Source>('bank');
  const a = parseRMInput(amount);
  const ok = a && /^\d{4}-\d{2}$/.test(m) && date <= today;
  return (
    <FormDialog title={`登记${PLAN_ITEM_ZH[item]}付款`} sub="每个月只能登记一笔；记错请先作废再重记。经营成本按月份分摊，不重复扣整笔。" onClose={onClose}
      onSubmit={async () => ok && (await run('recordRecurringPayment', { operationId: op, item, month: m, amountSen: a, paymentSource: source, businessDate: date }, `${m} ${PLAN_ITEM_ZH[item]}已登记`)) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label={a ? `登记 ${formatRM(a)}` : '登记付款'} />}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="所属月份"><input type="month" value={m} onChange={(e) => setM(e.target.value)} className={inputCls} required /></Field>
        <Field label="实付金额 RM"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} required /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="付款日期"><input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={inputCls} required /></Field>
        <Field label="付款来源"><SourceSelect value={source} onChange={setSource} /></Field>
      </div>
    </FormDialog>
  );
}

export function PlanExpenseDialog({ item, staffDailySen, today, run, busy, onClose }: Base & { item: 'gas' | 'misc' | 'wage'; staffDailySen: Sen; today: string }) {
  const [op] = useState(newOperationId);
  const [days, setDays] = useState('1');
  const d = Number(days);
  const [amount, setAmount] = useState(item === 'wage' ? (staffDailySen / 100).toFixed(2) : '');
  const [desc, setDesc] = useState('');
  const [date, setDate] = useState(today);
  const [accrual, setAccrual] = useState('');
  const [paid, setPaid] = useState(true);
  const [source, setSource] = useState<Source>('drawer');
  const a = parseRMInput(amount);
  const ok = a && date <= today && (item !== 'wage' || (Number.isInteger(d) && d >= 1 && d <= 31));
  const title = { gas: '换气记账', misc: '记一笔杂费', wage: '记出勤工资' }[item];
  return (
    <FormDialog title={title} sub={item === 'wage' ? '按实际出勤登记；日薪预算不会自动变成工资。' : '金额按实际账单填写。'} onClose={onClose}
      onSubmit={async () => ok && (await run('recordPlanExpense', { operationId: op, item, description: desc, amountSen: a, paid, paymentSource: source, businessDate: date, accrualDate: accrual || null, workDays: item === 'wage' ? d : null }, `${PLAN_ITEM_ZH[item]}已记录`)) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label={a ? `保存 ${formatRM(a)}` : '保存'} />}>
      {item === 'wage' && (
        <Field label="出勤天数"><input inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value); const n = Number(e.target.value); if (Number.isInteger(n) && n > 0) setAmount(((staffDailySen * n) / 100).toFixed(2)); }} className={inputCls} required /></Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="实际金额 RM"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} required /></Field>
        <Field label={paid ? '付款日期' : '记录日期'}><input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={inputCls} required /></Field>
      </div>
      <label className="mb-4 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="h-5 w-5 accent-[#28644c]" />已付款</label>
      <Field label="付款来源"><SourceSelect value={source} onChange={setSource} /></Field>
      <More summary="说明与归属日（可选）">
        <Field label="说明"><input value={desc} maxLength={120} onChange={(e) => setDesc(e.target.value)} placeholder={item === 'misc' ? '例如 清洁用品' : ''} className={inputCls} /></Field>
        <Field label="归属日" hint="默认与付款日相同；例如月底才付的上月开支。"><input type="date" value={accrual} max={today} onChange={(e) => setAccrual(e.target.value)} className={inputCls} /></Field>
      </More>
    </FormDialog>
  );
}

export function SettleDialog({ expense, outstandingSen, today, run, busy, onClose }: Base & { expense: ExpenseDoc; outstandingSen: Sen; today: string }) {
  const [op] = useState(newOperationId);
  const [date, setDate] = useState(today);
  const [source, setSource] = useState<Source>('drawer');
  return (
    <FormDialog title="补登付款" sub={`${expense.description} · 待付 ${formatRM(outstandingSen)}。按付款日记入已付支出，不改动原记录。`} onClose={onClose}
      onSubmit={async () => (await run('settleExpense', { operationId: op, expenseId: expense.id, paymentSource: source, businessDate: date }, '已登记付款')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} label={`付清 ${formatRM(outstandingSen)}`} tone="dark" />}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="付款日期"><input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={inputCls} required /></Field>
        <Field label="付款来源"><SourceSelect value={source} onChange={setSource} /></Field>
      </div>
    </FormDialog>
  );
}

// ───────────────────────── 开档成本 ─────────────────────────

const GROUPS = Object.keys(STARTUP_GROUP_ZH) as StartupGroup[];

function DetailsEditor({ rows, setRows }: { rows: { label: string; amount: string }[]; setRows: (r: { label: string; amount: string }[]) => void }) {
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_8rem_3rem] gap-2">
          <input aria-label={`明细 ${i + 1} 说明`} value={r.label} maxLength={60} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={inputCls} />
          <input aria-label={`明细 ${i + 1} 金额`} inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className={inputCls} />
          <button type="button" aria-label="删除这一行" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="min-h-12 rounded-xl border border-line">×</button>
        </div>
      ))}
      <Btn small tone="ghost" onClick={() => setRows([...rows, { label: `第 ${rows.length + 1} 笔`, amount: '' }])}>＋ 加一行明细</Btn>
    </div>
  );
}

function useStartupForm(init?: StartupCostDoc) {
  const [group, setGroup] = useState<StartupGroup>(init?.group ?? 'other');
  const [title, setTitle] = useState(init?.title ?? '');
  const [amount, setAmount] = useState(init ? (init.amountSen / 100).toFixed(2) : '');
  const [note, setNote] = useState(init?.note ?? '');
  const [rows, setRows] = useState(init?.details.map((d) => ({ label: d.label, amount: (d.amountSen / 100).toFixed(2) })) ?? []);
  const a = parseRMInput(amount);
  const details = rows.map((r) => ({ label: r.label.trim() || '明细', amountSen: parseRMInput(r.amount) }));
  const detailSum = details.reduce((s, d) => s + (d.amountSen ?? 0), 0);
  const detailsOk = !rows.length || (details.every((d) => d.amountSen) && detailSum === a);
  const ok = Boolean(title.trim() && a && detailsOk);
  const fields = (
    <>
      <Field label="项目"><select value={group} onChange={(e) => setGroup(e.target.value as StartupGroup)} className={inputCls}>{GROUPS.map((g) => <option key={g} value={g}>{STARTUP_GROUP_ZH[g]}</option>)}</select></Field>
      <Field label="名称"><input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} className={inputCls} required /></Field>
      <Field label="金额 RM"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} required /></Field>
      <More summary={`明细（可选）${rows.length ? ` · ${rows.length} 笔` : ''}`} open={rows.length > 0}>
        <DetailsEditor rows={rows} setRows={setRows} />
        {rows.length > 0 && <p className={`mt-2 text-xs ${detailsOk ? 'text-ink-2' : 'text-danger'}`}>明细合计 {formatRM(detailSum)}{a && detailSum !== a ? `，与金额 ${formatRM(a)} 不一致` : ''}</p>}
      </More>
      <More summary="备注（可选）"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={inputCls} aria-label="备注" /></More>
    </>
  );
  return { ok, fields, payload: { group, title: title.trim(), amountSen: a, details: rows.length ? details : [], note } };
}

export function StartupAddDialog({ today, run, busy, onClose }: Base & { today: string }) {
  const [op] = useState(newOperationId);
  const f = useStartupForm();
  const [pay, setPay] = useState<StartupPayment>('unverified');
  const [paidDate, setPaidDate] = useState(today);
  return (
    <FormDialog title="追加开档成本" sub="追加后，开档总投入与回本目标同步更新。" onClose={onClose}
      onSubmit={async () => f.ok && (await run('addStartupCost', { operationId: op, ...f.payload, paymentStatus: pay, paidDate: pay === 'paid' ? paidDate : null }, '开档成本已追加')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!f.ok} label="追加" />}>
      {f.fields}
      <Field label="付款状态"><select value={pay} onChange={(e) => setPay(e.target.value as StartupPayment)} className={inputCls}>{Object.entries(STARTUP_PAYMENT_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      {pay === 'paid' && <Field label="付款日期"><input type="date" value={paidDate} max={today} onChange={(e) => setPaidDate(e.target.value)} className={inputCls} /></Field>}
    </FormDialog>
  );
}

export function StartupCorrectDialog({ item, run, busy, onClose }: Base & { item: StartupCostDoc }) {
  const [op] = useState(newOperationId);
  const f = useStartupForm(item);
  const [reason, setReason] = useState('');
  const linkedSen = (item.linkedExpenses ?? []).filter((l) => l.status === 'active').reduce((s, l) => s + l.amountSen, 0);
  const ok = f.ok && reason.trim().length >= 2 && (f.payload.amountSen ?? 0) >= linkedSen;
  return (
    <FormDialog title={`更正「${item.title}」`} sub="原记录保留并标记已更正；新记录沿用付款状态。" onClose={onClose}
      onSubmit={async () => ok && (await run('correctStartupCost', { operationId: op, id: item.id, reason: reason.trim(), ...f.payload }, '已更正')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="保存更正" />}>
      {f.fields}
      {linkedSen > 0 && <p className={`mb-3 text-xs ${(f.payload.amountSen ?? 0) < linkedSen ? 'text-danger' : 'text-ink-2'}`}>这一项已关联账本付款 {formatRM(linkedSen)}，更正后会一并迁移到新记录；更正后的金额不能低于这个数，否则请先在日常开支取消部分归属。</p>}
      <Field label="更正原因"><input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className={inputCls} required /></Field>
    </FormDialog>
  );
}

export function StartupPaymentDialog({ item, today, run, busy, onClose }: Base & { item: StartupCostDoc; today: string }) {
  const [op] = useState(newOperationId);
  const [pay, setPay] = useState<StartupPayment>(item.paymentStatus === 'paid' ? 'paid' : 'paid');
  const [date, setDate] = useState(item.paidDate ?? today);
  return (
    <FormDialog title={`${item.title} · 付款状态`} sub={item.isDebt ? '供应商欠账已计入总投入；登记清还只更新状态，不再增加投入。' : '核实后更新；状态只影响已付 / 待付，不改变总投入。'} onClose={onClose}
      onSubmit={async () => (await run('setStartupPayment', { operationId: op, id: item.id, paymentStatus: pay, paidDate: pay === 'paid' ? date : null }, '付款状态已更新')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={pay === 'paid' && !date} label="保存" />}>
      {(Object.keys(STARTUP_PAYMENT_ZH) as StartupPayment[]).map((k) => <Radio key={k} name="pay" checked={pay === k} onChange={() => setPay(k)} title={STARTUP_PAYMENT_ZH[k]} />)}
      {pay === 'paid' && <Field label="付款日期"><input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={inputCls} required /></Field>}
    </FormDialog>
  );
}

export function SplitRentDialog({ item, run, busy, onClose }: Base & { item: StartupCostDoc }) {
  const [op] = useState(newOperationId);
  const [rent, setRent] = useState(item.rentSen === null ? '' : (item.rentSen / 100).toFixed(2));
  const [month, setMonth] = useState(item.rentMonth ?? '');
  const r = parseRMInput(rent);
  const deposit = r === null ? null : item.amountSen - r;
  const ok = r !== null && deposit !== null && deposit >= 0 && (!month || r > 0);
  return (
    <FormDialog title="拆分租金与押金" sub={`合计 ${formatRM(item.amountSen)}。押金可退，与日常费用分开；租金若是某个月的月租，关联该月避免重复计费。`} onClose={onClose}
      onSubmit={async () => ok && (await run('splitStartupRent', { operationId: op, id: item.id, rentSen: r, depositSen: deposit, rentMonth: month || null }, '已拆分')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="保存拆分" />}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="其中租金 RM"><input inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} className={inputCls} required /></Field>
        <Field label="押金 RM（自动）"><input value={deposit === null ? '' : deposit < 0 ? '超过合计' : (deposit / 100).toFixed(2)} readOnly className={`${inputCls} bg-subtle`} /></Field>
      </div>
      <Field label="这笔租金覆盖的月份（可选）" hint="该项付款状态为「已付」时，这个月的月租应付相应扣减，不再重复登记。"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} /></Field>
    </FormDialog>
  );
}

// ───────────────────────── 目标 ─────────────────────────

export function SalesTargetDialog({ scope, current, month, run, busy, onClose }: Base & { scope: 'daily' | 'monthly'; current: number | null; month: string }) {
  const [op] = useState(newOperationId);
  const suggestion = scope === 'daily' ? nextDailyTarget(current ?? 50) : suggestedMonthlyBalls(current ?? 50, month);
  const [v, setV] = useState(String(scope === 'daily' ? current ?? 50 : ''));
  const n = Number(v);
  const ok = Number.isInteger(n) && n >= 1 && n <= 100_000;
  return (
    <FormDialog title={scope === 'daily' ? '调整每日面量目标' : `设定 ${month} 面量目标`} sub="按面团粒数：小 1 粒、中 1½ 粒、大 2 粒；云吞汤不计。" onClose={onClose}
      onSubmit={async () => ok && (await run('setSalesTarget', { operationId: op, scope, month: scope === 'monthly' ? month : null, balls: n }, '目标已更新')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="保存目标" />}>
      <Field label="目标（粒）" hint={scope === 'monthly' ? `建议：每日 ${current ?? 50} 粒 × 当月天数 = ${suggestion} 粒，仅供参考。` : undefined}>
        <input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} placeholder={String(suggestion)} className={inputCls} required />
      </Field>
      <div className="flex flex-wrap gap-2">
        {(scope === 'daily' ? [50, 100, 150] : [suggestion]).map((x) => <button key={x} type="button" onClick={() => setV(String(x))} className="min-h-11 rounded-lg border border-line bg-[#f5f3ec] px-3 text-sm">{x} 粒</button>)}
      </div>
    </FormDialog>
  );
}

export function NextGoalDialog({ today, run, busy, onClose }: Base & { today: string }) {
  const [op] = useState(newOperationId);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [deadline, setDeadline] = useState('');
  const [note, setNote] = useState('');
  const a = parseRMInput(amount);
  const ok = title.trim() && a;
  return (
    <FormDialog title="拟定下一个目标" sub="名称、金额与期限都由你决定。" onClose={onClose}
      onSubmit={async () => ok && (await run('createNextGoal', { operationId: op, title: title.trim(), targetSen: a, deadline: deadline || null, note }, '下一个目标已建立')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={!ok} label="建立目标" tone="dark" />}>
      <Field label="目标名称"><input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="例如 存一笔备用金" className={inputCls} required /></Field>
      <Field label="目标金额 RM"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} required /></Field>
      <Field label="期限（可选）"><input type="date" value={deadline} min={today} onChange={(e) => setDeadline(e.target.value)} className={inputCls} /></Field>
      <More summary="备注（可选）"><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={inputCls} aria-label="备注" /></More>
    </FormDialog>
  );
}

// ───────────────────────── 旧账 / 资本支出归属 ─────────────────────────

/**
 * 确认一笔已有支出的归属：不改原记录、不新增现金流；已关账营业日的付款也可以确认。
 * 旧版房租 / 电费 → 某月月租或电费（可部分抵扣）；资本或任何付款 → 某开档项目；资本支出 → 后续资本投入。
 */
export function LinkExpenseDialog({ data, expense, run, busy, onClose }: Base & { data: FinanceData; expense: ExpenseDoc }) {
  const [op] = useState(newOperationId);
  const capital = expense.category === 'capital';
  const [kind, setKind] = useState<'recurring' | 'startup' | 'later_capital'>(capital ? 'startup' : 'recurring');
  const [item, setItem] = useState<RecurringItem>('rent');
  const [month, setMonth] = useState(data.plan.rentStartMonth && monthOf(expense.businessDate) < data.plan.rentStartMonth ? data.plan.rentStartMonth : monthOf(expense.businessDate));
  const startupItems = data.startup.filter((s) => s.status === 'active');
  const [startupId, setStartupId] = useState(startupItems[0]?.id ?? '');
  const settledSen = data.expenses.filter((e) => e.settlesExpenseId === expense.id && e.status === 'active').reduce((s, e) => s + e.paidSen, 0);
  const existing = data.links.find((d) => d.expenseId === expense.id)?.links ?? [];
  const row = kind === 'recurring' && /^\d{4}-\d{2}$/.test(month) ? monthlyPlanRows(data.plan, month, data.expenses as PlanExpense[], startupSummary(data.startup).rentByMonth, data.links).find((r) => r.item === item) : undefined;
  const st = startupItems.find((s) => s.id === startupId);
  const startupRemainingSen = st ? st.amountSen - (st.linkedExpenses ?? []).filter((l) => l.status === 'active').reduce((s, l) => s + l.amountSen, 0) : undefined;
  const cap = (capital ? expense.amountSen : expense.paidSen + settledSen) - existing.filter((l) => l.status === 'active').reduce((s, l) => s + l.amountSen, 0);
  const [amount, setAmount] = useState((Math.max(0, cap) / 100).toFixed(2));
  const a = parseRMInput(amount) ?? 0;
  const link: NewExpenseLink = kind === 'recurring' ? { kind, item, month, amountSen: a } : kind === 'startup' ? { kind, startupId, amountSen: a } : { kind, amountSen: a };
  const err = !data.plan.rentStartMonth && kind === 'recurring' ? '请先在日常开支设置起租月份'
    : validateExpenseLink({ expense: expense as PlanExpense, settledSen, existing, link, monthOutstandingSen: row?.outstandingSen, startupRemainingSen });
  const payload = kind === 'recurring' ? { item, month } : kind === 'startup' ? { startupId } : {};
  return (
    <FormDialog title="确认这笔付款的归属" sub={`${expense.description} · ${expense.businessDate} · 已付 ${formatRM(expense.paidSen + settledSen)}。只记录归属，不改原付款、不新增支出，已关账的日结不变。`} onClose={onClose}
      onSubmit={async () => !err && (await run('linkExpense', { operationId: op, expenseId: expense.id, kind, amountSen: a, ...payload }, '已确认归属')) && onClose()}
      footer={<Footer onClose={onClose} busy={busy} disabled={Boolean(err)} label="确认归属" />}>
      {!capital && <Radio name="kind" checked={kind === 'recurring'} onChange={() => setKind('recurring')} title="某个月的月租 / 冰箱电费" sub="抵扣该月应付，可以只抵扣一部分" />}
      <Radio name="kind" checked={kind === 'startup'} onChange={() => setKind('startup')} title="开档投入中的某一项" sub="已在回本目标内，不再按经营支出扣" />
      {capital && <Radio name="kind" checked={kind === 'later_capital'} onChange={() => setKind('later_capital')} title="开档之后的资本投入" sub="不算经营支出，单独列示；是否加入新目标由你决定" />}
      {kind === 'recurring' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="项目"><select value={item} onChange={(e) => setItem(e.target.value as RecurringItem)} className={inputCls}><option value="rent">档口租金</option><option value="fridge_power">冰箱额外电费</option></select></Field>
          <Field label="所属月份" hint={row ? `该月剩余应付 ${formatRM(row.outstandingSen)}` : undefined}><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls} required /></Field>
        </div>
      )}
      {kind === 'startup' && (
        <Field label="开档项目" hint={startupRemainingSen !== undefined ? `该项还可关联 ${formatRM(Math.max(0, startupRemainingSen))}` : undefined}>
          <select value={startupId} onChange={(e) => setStartupId(e.target.value)} className={inputCls}>{startupItems.map((s) => <option key={s.id} value={s.id}>{s.title} · {formatRM(s.amountSen)}</option>)}</select>
        </Field>
      )}
      <Field label="关联金额 RM" hint={`这笔支出还可关联 ${formatRM(Math.max(0, cap))}`}><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} required /></Field>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </FormDialog>
  );
}
