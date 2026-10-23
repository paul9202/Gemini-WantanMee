/**
 * 收支与损耗（01 §10）：当日收款登记与成本、进货/支出、损耗、资金往来。
 * 新收款不分现金 / QR，只汇总已登记 / 未登记；新开班不再有备用金，旧备用金记录只读显示。
 * 快捷模板只是预填表单，必须确认实际金额、是否已付、付款来源后才保存；记录不删除，只作废并可更正。
 */
import { FormEvent, useState } from 'react';
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { db, storePath } from '../../data/firebase/client';
import { businessDateOf } from '../../domain/businessDay';
import { BOM_V1 } from '../../domain/bom';
import { DEFAULT_FIXED_COST, FixedCostPolicy, summarizePeriod } from '../../domain/finance';
import { ledgerEvents, wastageCostUnits } from '../../domain/ledger';
import { costUnitsToSen, formatCostRM, formatRM, parseRMInput } from '../../domain/money';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { reasonText } from '../../data/firebase/reasons';
import { useNow } from '../../data/firebase/live';
import { useSession } from '../../app/session';
import { loadLedger, orderPaymentOverview, useLoad } from './data';
import { OwnerTabs, Section } from './ui';

const CATEGORY_ZH = { purchase: '进货', fixed_payment: '固定费用付款（房租等）', opex: '其他营业费用', capital: '资本设备' } as const;
const SOURCE_ZH = { drawer: '钱箱现金', bank: '银行/QR', owner: '老板自付' } as const;
const WASTE_ZH = { overcooked: '煮烂', dropped: '掉落', leftover: '剩余', other: '其他' } as const;
const CASH_ZH = { cash_in: '补入现金', cash_out: '取走现金', bank_deposit: '存入银行' } as const;
const TEMPLATES: { label: string; category: keyof typeof CATEGORY_ZH; description: string }[] = [
  { label: '面球', category: 'purchase', description: '面球进货' },
  { label: '云吞皮/馅', category: 'purchase', description: '云吞皮与馅料' },
  { label: '叉烧', category: 'purchase', description: '叉烧进货' },
  { label: '煤气', category: 'opex', description: '煤气' },
  { label: '包装', category: 'purchase', description: '打包盒与袋' },
  { label: '房租', category: 'fixed_payment', description: '本月房租' },
];

export function FinancePage() {
  const { config } = useSession();
  const now = useNow(60_000);
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const [date, setDate] = useState('');
  const day = date || today;
  // 门店配置载入前营业日为空：先不查询。
  const ledger = useLoad(() => (day ? loadLedger({ start: day, endExclusive: nextDay(day) }) : Promise.resolve(null)), `fin-${day}`);
  const finance = useLoad(async () => (await getDoc(doc(db, storePath('config/finance')))).data()?.fixedCostPolicy as FixedCostPolicy | undefined, 'fin-config');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(name: Parameters<typeof submit>[0], payload: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      await submit(name, { operationId: newOperationId(), ...payload });
      setMsg({ ok: true, text: okText });
      ledger.refresh();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!config) return null;
  const docs = ledger.data?.docs;
  const fixed = finance.data ?? DEFAULT_FIXED_COST;
  const summary = docs && day ? summarizePeriod(ledgerEvents(docs), { start: day, endExclusive: nextDay(day) }, fixed) : null;
  const orderPay = ledger.data ? orderPaymentOverview(ledger.data.orders) : null;

  return (
    <div className="mx-auto max-w-[1200px] p-4 pb-8 lg:p-8">
      <OwnerTabs current="/owner/finance" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">收支与损耗</h1>
        <label className="flex items-center gap-2 text-sm">营业日
          <input type="date" value={day} max={today} onChange={(e) => setDate(e.target.value)} className="h-10 rounded-lg border border-control px-2" />
        </label>
        <span className="text-sm text-ink-2">已关账的营业日不能再记账，差错请走日结更正版本。</span>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mb-3 rounded-lg px-3 py-2 ${msg.ok ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>{msg.text}</p>}

      <div className="mb-4">
        <Section title={`当日收款与成本 · ${day}`} hint="收款为员工人工登记，未与钱包或银行自动核对；利润按已登记收款估算">
          {summary && orderPay ? (
            <div className="grid gap-4 md:grid-cols-2">
              <table className="w-full text-sm"><tbody>
                {([
                  [`有效订单金额（${orderPay.validCount} 单）`, orderPay.validSen],
                  ['已登记收款（含跨日补登记）', summary.receipts.totalSen],
                  ...(summary.receipts.correctionsSen ? [['　其中误登记更正', summary.receipts.correctionsSen]] : []),
                  [`未登记（本日订单 ${orderPay.unpaidCount} 单，不算已收）`, orderPay.unpaidSen],
                  ['已登记退款', -summary.refunds.totalSen],
                  ['净登记收款', summary.netReceiptsSen],
                ] as [string, number][]).map(([l, v]) => <tr key={l} className="border-b border-line"><td className="py-1">{l}</td><td className="text-right tabular-nums">{formatRM(v)}</td></tr>)}
              </tbody></table>
              <table className="w-full text-sm"><tbody>
                {([
                  ['理论食材与包装成本', -costUnitsToSen(summary.allocatedCostUnits)], ['损耗（不重复）', -costUnitsToSen(summary.wastageCostUnits)],
                  ['固定费用摊销', -summary.fixedCostSen], ['其他营业费用', -summary.otherOpexSen],
                  ['估算经营利润（按已登记收款估算）', summary.estimatedProfitSen],
                  ['已付进货', -summary.cash.purchasesPaidSen], ['已付营业费用', -summary.cash.opexPaidSen],
                ] as [string, number][]).map(([l, v]) => <tr key={l} className="border-b border-line"><td className="py-1">{l}</td><td className="text-right tabular-nums">{formatRM(v)}</td></tr>)}
              </tbody></table>
            </div>
          ) : <p className="text-ink-2">{ledger.loading ? '正在载入…' : '没有数据'}</p>}
          {summary?.hasLegacyChannels && (
            <p className="mt-2 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2">
              旧版记录：现金收款 {formatRM(summary.receipts.cashSen)} · QR 收款 {formatRM(summary.receipts.qrSen)} · 现金退款 {formatRM(summary.refunds.cashSen)} · QR 退款 {formatRM(summary.refunds.qrSen)}（已含在上面合计内）
            </p>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ExpenseForm busy={busy} day={day} today={today}
          onSubmit={(p) => run('recordExpense', p, '支出已记录')} />
        <WastageForm busy={busy} day={day} today={today} onSubmit={(p) => run('recordWastage', p, '损耗已记录')} />
        <CashForm busy={busy} day={day} today={today} onSubmit={(p) => run('recordCashMovement', p, '资金往来已记录')} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title={`支出 · ${day}`} hint="含按归属日计入的营业费用">
          {!docs?.expenses.length && <p className="text-ink-2">{ledger.loading ? '正在载入…' : '没有记录'}</p>}
          <ul className="divide-y divide-line">
            {docs?.expenses.map((e) => (
              <li key={e.id} className={`flex flex-wrap items-center gap-2 py-2 ${e.status === 'voided' ? 'opacity-50' : ''}`}>
                <span className="rounded bg-subtle px-2 text-sm">{CATEGORY_ZH[e.category]}</span>
                <span className="min-w-0 flex-1">{e.description}{e.correctionOf ? '（更正）' : ''}<span className="block text-xs text-ink-2">{SOURCE_ZH[e.paymentSource]} · {e.paidSen ? '已付' : '未付'} · 归属 {e.accrualDate}</span></span>
                <b className="tabular-nums">{formatRM(e.amountSen)}</b>
                {e.status === 'voided' ? <span className="text-sm">已作废</span> : <VoidButton busy={busy} onVoid={(reason) => run('voidLedgerEntry', { kind: 'expense', id: e.id, reason }, '已作废')} />}
              </li>
            ))}
          </ul>
        </Section>
        <Section title={`损耗 · ${day}`}>
          {!docs?.wastage.length && <p className="text-ink-2">{ledger.loading ? '正在载入…' : '没有记录'}</p>}
          <ul className="divide-y divide-line">
            {docs?.wastage.map((w) => (
              <li key={w.id} className={`flex flex-wrap items-center gap-2 py-2 ${w.status === 'voided' ? 'opacity-50' : ''}`}>
                <span className="rounded bg-subtle px-2 text-sm">{WASTE_ZH[w.reason as keyof typeof WASTE_ZH] ?? w.reason}</span>
                <span className="min-w-0 flex-1">{w.noodleHalfUnits / 2} 面球 · {w.wantonCount} 云吞 · {w.charSiewPortions} 叉烧
                  <span className="block text-xs text-ink-2">{w.alreadyAllocated ? '已在订单成本中：只记数量，不重复扣款' : `成本 ${formatCostRM(w.costUnits)}`}{w.note ? ` · ${w.note}` : ''}</span></span>
                {w.status === 'voided' ? <span className="text-sm">已作废</span> : <VoidButton busy={busy} onVoid={(reason) => run('voidLedgerEntry', { kind: 'wastage', id: w.id, reason }, '已作废')} />}
              </li>
            ))}
          </ul>
        </Section>
        <Section title={`钱箱资金往来 · ${day}`}>
          <ul className="divide-y divide-line">
            {docs?.cashMovements.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                <span className="flex-1">{c.type === 'opening_float' ? '开班备用金（旧版记录）' : CASH_ZH[c.type as keyof typeof CASH_ZH]}{c.reason ? ` · ${c.reason}` : ''}</span>
                <b className="tabular-nums">{formatRM(c.amountSen)}</b>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function nextDay(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
}

function VoidButton({ busy, onVoid }: { busy: boolean; onVoid: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="h-9 rounded-lg border border-control px-2 text-sm">作废</button>;
  return (
    <span className="flex items-center gap-1">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="作废原因" className="h-9 w-32 rounded border border-control px-2 text-sm" />
      <button type="button" disabled={busy || reason.trim().length < 2} onClick={() => onVoid(reason)} className="h-9 rounded-lg bg-danger px-2 text-sm text-white disabled:opacity-40">确认</button>
    </span>
  );
}

const field = 'h-11 w-full rounded-lg border border-control px-2';

function ExpenseForm({ busy, day, today, onSubmit }: { busy: boolean; day: string; today: string; onSubmit: (p: Record<string, unknown>) => Promise<boolean> }) {
  const [category, setCategory] = useState<keyof typeof CATEGORY_ZH>('purchase');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paid, setPaid] = useState(true);
  const [source, setSource] = useState<keyof typeof SOURCE_ZH>('drawer');
  const [accrual, setAccrual] = useState('');
  const amountSen = parseRMInput(amount);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!amountSen) return;
    const ok = await onSubmit({ category, description, amountSen, paid, paymentSource: source, businessDate: day, ...(accrual ? { accrualDate: accrual } : {}) });
    if (ok) { setDescription(''); setAmount(''); setAccrual(''); }
  }
  return (
    <Section title="记一笔支出" hint="模板只预填，金额要自己确认">
      <div className="mb-2 flex flex-wrap gap-1">
        {TEMPLATES.map((t) => <button key={t.label} type="button" onClick={() => { setCategory(t.category); setDescription(t.description); }} className="h-9 rounded-lg border border-line px-2 text-sm">{t.label}</button>)}
      </div>
      <form onSubmit={save} className="space-y-2">
        <select aria-label="类别" value={category} onChange={(e) => setCategory(e.target.value as keyof typeof CATEGORY_ZH)} className={field}>
          {Object.entries(CATEGORY_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input aria-label="说明 / 供应商" placeholder="说明 / 供应商" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} required className={field} />
        <input aria-label="实际金额 RM" placeholder="实际金额 RM" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required className={field} />
        <div className="flex gap-2">
          <select aria-label="付款来源" value={source} onChange={(e) => setSource(e.target.value as keyof typeof SOURCE_ZH)} className={field}>
            {Object.entries(SOURCE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label className="flex shrink-0 items-center gap-1 text-sm"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="h-5 w-5" />已付</label>
        </div>
        {category === 'opex' && (
          <label className="block text-sm">归属日（默认当天）<input type="date" value={accrual} max={today} onChange={(e) => setAccrual(e.target.value)} className={field} /></label>
        )}
        {category === 'fixed_payment' && <p className="text-xs text-ink-2">房租等固定费用：现金账扣这笔付款；经营利润只按每月固定费用摊销，不再扣这一整笔。</p>}
        {category === 'purchase' && <p className="text-xs text-ink-2">进货只计入现金账；经营利润已按订单理论成本扣过食材，不重复扣。</p>}
        <button disabled={busy || !amountSen || !description.trim()} className="h-12 w-full rounded-lg bg-brand font-bold text-white disabled:bg-control">保存 {amountSen ? formatRM(amountSen) : ''}</button>
      </form>
    </Section>
  );
}

function WastageForm({ busy, day, onSubmit }: { busy: boolean; day: string; today: string; onSubmit: (p: Record<string, unknown>) => Promise<boolean> }) {
  const [balls, setBalls] = useState(0);
  const [wantons, setWantons] = useState(0);
  const [charSiew, setCharSiew] = useState(0);
  const [reason, setReason] = useState<keyof typeof WASTE_ZH>('dropped');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState('');
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const half = Math.round(balls * 2);
  const cost = wastageCostUnits(BOM_V1, { noodleHalfUnits: half, wantonCount: wantons, charSiewPortions: charSiew });
  const step = (label: string, value: number, set: (v: number) => void, by: number) => (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className="flex items-center rounded-lg border border-control">
        <button type="button" aria-label={`${label}减`} onClick={() => set(Math.max(0, value - by))} className="h-11 w-11 text-xl">−</button>
        <span className="w-12 text-center font-bold tabular-nums">{value}</span>
        <button type="button" aria-label={`${label}加`} onClick={() => set(value + by)} className="h-11 w-11 text-xl">＋</button>
      </span>
    </div>
  );
  return (
    <Section title="记损耗" hint="面球按 0.5 递增">
      <div className="space-y-2">
        {step('面球', balls, setBalls, 0.5)}
        {step('云吞（粒）', wantons, setWantons, 1)}
        {step('叉烧（份）', charSiew, setCharSiew, 1)}
        <select aria-label="损耗原因" value={reason} onChange={(e) => setReason(e.target.value as keyof typeof WASTE_ZH)} className={field}>
          {Object.entries(WASTE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input aria-label="说明" placeholder="说明（可选）" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={field} />
        <input aria-label="关联订单票号" placeholder="关联订单票号（已制作后取消的单，可选）" value={receipt} onChange={(e) => setReceipt(e.target.value.trim())} className={field} />
        {linkErr && <p role="alert" className="text-sm text-danger">{linkErr}</p>}
        <p className="text-xs text-ink-2">估算成本 {formatCostRM(cost)}。关联了已计入订单成本的取消单时，系统只记数量、不重复扣款。</p>
        <button type="button" disabled={busy || half + wantons + charSiew === 0}
          onClick={async () => {
            setLinkErr(null);
            let linkedOrderId: string | null = null;
            if (receipt) {
              const snap = await getDocs(query(collection(db, storePath('orders')), where('receiptNumber', '==', receipt), limit(1)));
              if (snap.empty) { setLinkErr(`找不到票号 ${receipt}`); return; }
              linkedOrderId = snap.docs[0].id;
            }
            if (await onSubmit({ noodleHalfUnits: half, wantonCount: wantons, charSiewPortions: charSiew, reason, note, businessDate: day, linkedOrderId })) {
              setBalls(0); setWantons(0); setCharSiew(0); setNote(''); setReceipt('');
            }
          }}
          className="h-12 w-full rounded-lg bg-brand font-bold text-white disabled:bg-control">保存损耗</button>
      </div>
    </Section>
  );
}

function CashForm({ busy, day, onSubmit }: { busy: boolean; day: string; today: string; onSubmit: (p: Record<string, unknown>) => Promise<boolean> }) {
  const [type, setType] = useState<keyof typeof CASH_ZH>('bank_deposit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const amountSen = parseRMInput(amount);
  return (
    <Section title="钱箱资金往来" hint="老板投资/提现不是营业收入或成本">
      <div className="space-y-2">
        <select aria-label="往来类型" value={type} onChange={(e) => setType(e.target.value as keyof typeof CASH_ZH)} className={field}>
          {Object.entries(CASH_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input aria-label="金额 RM" placeholder="金额 RM" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
        <input aria-label="往来原因" placeholder="原因（必填）" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className={field} />
        <button type="button" disabled={busy || !amountSen || reason.trim().length < 2}
          onClick={async () => { if (await onSubmit({ type, amountSen, reason, businessDate: day })) { setAmount(''); setReason(''); } }}
          className="h-12 w-full rounded-lg bg-brand font-bold text-white disabled:bg-control">保存</button>
      </div>
    </Section>
  );
}
