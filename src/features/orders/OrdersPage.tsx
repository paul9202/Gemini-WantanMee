/**
 * 订单页：制作状态与收款状态分开显示（取消 ≠ 已退款；出餐 ≠ 已收款；未收款绝不显示为已收）。
 * 2026-10-23 运营改版：下单即送厨，收款由前台另行确认。
 * - 前台（收银 / 老板）对未收款的有效订单点「确认已收款 RM金额」直接登记整单（不选渠道、不弹二次确认），防连点。
 * - 老板可「更正误登记收款」（有原因、有审计，追加反向调整，不是退款），也可登记退款（不强制选择渠道）。
 * - 旧订单保留真实付款渠道（现金 / DuitNow QR）。餐牌会复用：订单以票号 + 原餐牌号 + 时间识别，操作绑定订单 ID。
 */
import { useRef, useState } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { businessDateOf } from '../../domain/businessDay';
import { OrderServiceMode, SERVICE_MODE_NAMES, Spice } from '../../domain/menu';
import { PICTOGRAMS } from '../../domain/pictograms';
import { formatRM } from '../../domain/money';
import type { PaymentMethod } from '../../domain/payment';
import { isAwaitingPayment, PaymentState } from '../../domain/orderLifecycle';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useLiveQuery, useNow, useOnline } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { useRecordPayment } from '../../data/payments';
import { useRegister } from '../../data/register';
import { useOfflineRuntime } from '../../data/offline/runtime';
import { useSession } from '../../app/session';
import { useT } from '../../app/i18n';
import { Icon, Photo } from '../../ui/visual';
import { toCsv } from '../../domain/csv';
import { download } from '../owner/data';

import { ReceiptDialog, receiptFromOrder } from '../receipt/ReceiptDialog';

type Tr = (zh: string, en: string) => string;

interface OrderRow {
  id: string;
  receiptNumber: string;
  tokenNumber: number;
  serviceMode: OrderServiceMode;
  fulfillmentStatus: 'queued' | 'preparing' | 'served' | 'cancelled';
  /** 旧订单只有 paid / refund_due / refunded。 */
  paymentState: PaymentState;
  kitchenCancelRequested: boolean;
  /** 旧订单为真实渠道；新订单登记前为 null，登记后为 unspecified。 */
  paymentMethod?: PaymentMethod | null;
  totalSen: number;
  paidSen: number;
  refundedSen: number;
  paidAtMs?: number | null;
  acceptedAtEffectiveMs: number;
  kitchenAckAtMs: number | null;
  tokenReturnedAtMs?: number;
  manualHandoffAtMs?: number | null;
  /** 加单：挂在哪张原单上（收款时可一起结）。 */
  addOnTo?: { orderId: string; tokenNumber: number; receiptNumber: string | null } | null;
  source?: 'online' | 'offline';
  offlineReceiptNumber?: string | null;
  /** 后厨「继续做，拒绝取消」的记录。 */
  cancelRejection?: { reason: string | null; atMs: number } | null;
  /** 老板放弃追收的记录（恢复后为 null）。 */
  writeOff?: { reason: string; amountSen: number; atMs: number } | null;
  businessDate: string;
  version: number;
  /** items 带下单时的完整配置；这里只用到辣度（汤品为 null）。 */
  items: { lineId: string; nameZh: string; quantity: number; photoId: string; spice?: Spice | null }[];
}

/** 订单页的餐品文字：品名 + 辣度，例如「黑酱面 · 小 · 辣」。 */
const itemName = (i: OrderRow['items'][number]) => (i.spice ? `${i.nameZh} · ${PICTOGRAMS[`spice:${i.spice}`].zh}` : i.nameZh);

type Filter = 'all' | 'unpaid' | 'queued' | 'preparing' | 'served' | 'cancelled';
const CANCEL_REASONS: [string, string][] = [['顾客离开', 'Customer left'], ['点错单', 'Wrong order'], ['重复下单', 'Duplicate order'], ['其他', 'Other']];

const fulfillLabel = (tr: Tr, s: OrderRow['fulfillmentStatus']) => ({
  queued: tr('待做', 'Queued'), preparing: tr('制作中', 'Preparing'), served: tr('已出餐', 'Served'), cancelled: tr('已取消', 'Cancelled'),
})[s];

/** 收款状态文案。未收款永远单独标出，不和制作状态混在一起。 */
function payLabel(tr: Tr, s: PaymentState): string {
  switch (s) {
    case 'unpaid': return tr('未收款', 'Unpaid');
    case 'paid': return tr('已收款', 'Paid');
    case 'refund_due': return tr('应退款', 'Refund due');
    case 'refunded': return tr('已退款', 'Refunded');
    case 'not_due': return tr('已取消 · 无需收款', 'Cancelled · nothing due');
    case 'written_off': return tr('已放弃追收 · 未收回', 'Written off · not collected');
    default: return String(s);
  }
}

/** 只有旧订单有真实渠道；新收款不分渠道，不显示伪造的现金 / QR。 */
function channelLabel(tr: Tr, m: PaymentMethod | null | undefined): string | null {
  if (m === 'cash') return tr('现金', 'Cash');
  if (m === 'qr_manual') return 'DuitNow QR';
  return null;
}

const payTone = (s: PaymentState) =>
  s === 'unpaid' ? 'bg-danger-bg text-danger' : s === 'paid' ? 'bg-ok-bg text-ok' : s === 'refund_due' ? 'bg-warn-bg text-warn' : 'bg-subtle text-ink-2';

type Dialog = { kind: 'cancel' | 'refund' | 'reverse' | 'writeOff' | 'reinstate'; order: OrderRow };
type RunName = 'requestCancel' | 'confirmFullRefund' | 'reversePayment' | 'writeOffPayment' | 'reinstateWrittenOff';
/** 付款类更正不改制作版本号，不带 expectedVersion。 */
const PAYMENT_ONLY: RunName[] = ['reversePayment', 'writeOffPayment', 'reinstateWrittenOff'];
type Feedback = { ok: boolean; text: string };

export function OrdersPage() {
  const tr = useT();
  const { config, member } = useSession();
  const now = useNow(60_000);
  const reg = useRegister();
  const rt = useOfflineRuntime();
  const recordPayment = useRecordPayment();
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const q = useLiveQuery<OrderRow>(
    date ? query(collection(db, storePath('orders')), where('businessDate', '==', date), orderBy('acceptedAtEffectiveMs', 'desc')) : null,
    `orders-${date}`,
  );
  // O12：新营业日仍未完成的旧单单独列出，保持原营业日。
  const openQ = useLiveQuery<OrderRow>(
    query(collection(db, storePath('orders')), where('fulfillmentStatus', 'in', ['queued', 'preparing'])),
    'orders-open',
  );
  // 之前营业日仍未登记收款的订单（出餐后未收钱）：继续追收，归属原营业日。
  const unpaidQ = useLiveQuery<OrderRow>(query(collection(db, storePath('orders')), where('paymentState', '==', 'unpaid')), 'orders-unpaid');
  const carriedMap = new Map<string, OrderRow>();
  for (const o of [...openQ.data, ...unpaidQ.data]) if (date && o.businessDate < date && o.fulfillmentStatus !== 'cancelled') carriedMap.set(o.id, o);
  const carried = [...carriedMap.values()].sort((a, b) => a.acceptedAtEffectiveMs - b.acceptedAtEffectiveMs);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState<Set<string>>(new Set());
  const payingRef = useRef(new Set<string>());
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const isOwner = member?.role === 'owner';
  const isFront = member?.role === 'owner' || member?.role === 'cashier';
  const canRegister = reg.status === 'ready';
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  // 本机已离线登记、尚未同步的收款：显示为「本机已登记」，不再让员工重复收钱。
  const localPaid = new Set(rt.outbox
    .filter((r) => r.status !== 'rejected' && r.event.type === 'offline_payment_recorded')
    .map((r) => (r.event.payload as { clientOrderId: string }).clientOrderId));

  async function confirmPaid(o: OrderRow) {
    if (payingRef.current.has(o.id)) return;
    payingRef.current.add(o.id);
    setPaying(new Set(payingRef.current));
    setFeedback((f) => { const n = { ...f }; delete n[o.id]; return n; });
    try {
      const r = await recordPayment(o.id, o.totalSen);
      const fb: Feedback = r.ok
        ? {
          ok: true,
          text: r.alreadyRecorded
            ? tr(`票号 ${o.receiptNumber} 之前已登记收款，请勿重复收钱`, `Receipt ${o.receiptNumber} was already recorded — do not collect again`)
            : r.offline
              ? tr(`已在本机登记收款 ${formatRM(o.totalSen)}，联网后自动同步`, `Payment ${formatRM(o.totalSen)} saved on this device; it will sync when online`)
              : tr(`已登记收款 ${formatRM(o.totalSen)} · 票号 ${o.receiptNumber}`, `Payment ${formatRM(o.totalSen)} recorded · receipt ${o.receiptNumber}`),
        }
        : { ok: false, text: r.message };
      setFeedback((f) => ({ ...f, [o.id]: fb }));
    } catch (e) {
      setFeedback((f) => ({ ...f, [o.id]: { ok: false, text: String(e) } }));
    } finally {
      payingRef.current.delete(o.id);
      setPaying(new Set(payingRef.current));
    }
  }

  async function run(name: RunName, o: OrderRow, extra: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      // 收款更正不改变制作版本号，不带 expectedVersion。
      await submit(name, { operationId: newOperationId(), orderId: o.id, ...(PAYMENT_ONLY.includes(name) ? {} : { expectedVersion: o.version }), ...extra });
      if (name === 'reversePayment') setFeedback((f) => ({ ...f, [o.id]: { ok: true, text: tr('已更正：原收款保留，订单回到未收款', 'Corrected: original payment kept, order is unpaid again') } }));
      if (name === 'writeOffPayment') setFeedback((f) => ({ ...f, [o.id]: { ok: true, text: tr(`已放弃追收 ${formatRM(o.totalSen)}：不计实收，已移出待收款`, `Written off ${formatRM(o.totalSen)}: not counted as received`) } }));
      if (name === 'reinstateWrittenOff') setFeedback((f) => ({ ...f, [o.id]: { ok: true, text: tr('已恢复待收款：请在主点单平板确认已收款', 'Back to unpaid: record the payment on the main register') } }));
      setDialog(null);
    } catch (e) {
      setMsg(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
    } finally {
      setBusy(false);
    }
  }

  const matches = (o: OrderRow) => {
    if (filter === 'unpaid' ? !isAwaitingPayment(o) : filter !== 'all' && o.fulfillmentStatus !== filter) return false;
    const k = search.trim();
    if (!k) return true;
    return String(o.tokenNumber) === k || o.receiptNumber.includes(k) || Boolean(o.offlineReceiptNumber?.includes(k)) || o.items.some((i) => itemName(i).includes(k));
  };
  const counts: Record<Filter, number> = { all: q.data.length, unpaid: 0, queued: 0, preparing: 0, served: 0, cancelled: 0 };
  for (const o of q.data) {
    counts[o.fulfillmentStatus]++;
    if (isAwaitingPayment(o)) counts.unpaid++;
  }
  const filters: [Filter, string][] = [
    ['all', tr('全部', 'All')], ['unpaid', tr('未收款', 'Unpaid')], ['queued', tr('待做', 'Queued')],
    ['preparing', tr('制作中', 'Preparing')], ['served', tr('已出餐', 'Served')], ['cancelled', tr('已取消', 'Cancelled')],
  ];
  const shown = q.data.filter(matches);
  const unpaidTodaySen = q.data.filter(isAwaitingPayment).reduce((s, o) => s + o.totalSen, 0);
  const cols = 'lg:grid-cols-[6.5rem_minmax(0,2fr)_5rem_minmax(0,1.1fr)_minmax(0,1.2fr)_16rem]';

  const row = (o: OrderRow) => {
    const t = new Date(o.acceptedAtEffectiveMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const kitchenNote = o.fulfillmentStatus === 'served' ? tr('已出餐 · 餐牌已释放', 'Served · token released')
      : o.fulfillmentStatus === 'cancelled' ? tr('已停止制作', 'Stopped')
      : o.source === 'offline' ? tr('离线单 · 人工传单', 'Offline · paper ticket') : o.manualHandoffAtMs ? tr('已人工传单', 'Handed over manually') : o.kitchenAckAtMs ? tr('后厨已收到', 'Kitchen received') : tr('等待厨房确认', 'Waiting for kitchen');
    const pendingLocal = localPaid.has(o.id) && o.paymentState === 'unpaid';
    const channel = channelLabel(tr, o.paymentMethod);
    const fb = feedback[o.id];
    const inFlight = paying.has(o.id);
    const canConfirm = isFront && isAwaitingPayment(o) && !o.kitchenCancelRequested && !pendingLocal;
    const canReverse = isOwner && (o.paymentState === 'paid' || o.paymentState === 'refund_due') && o.paidSen > 0 && !o.refundedSen;
    const canRefund = isOwner && (o.paymentState === 'paid' || o.paymentState === 'refund_due') && (o.fulfillmentStatus === 'served' || o.fulfillmentStatus === 'cancelled');
    const canWriteOff = isOwner && isAwaitingPayment(o) && !o.kitchenCancelRequested && !pendingLocal;
    const canReinstate = isOwner && o.paymentState === 'written_off';
    return (
      <div key={o.id} className={`grid grid-cols-[5rem_1fr] items-center gap-x-4 gap-y-2 border-b border-line px-5 py-4 last:border-0 ${cols}`}>
        <div>
          <div className="text-3xl font-black leading-none tabular-nums">{o.tokenNumber}<span className="ml-0.5 text-sm font-bold">{tr('号', '')}</span></div>
          <div className="mt-1 text-xs text-ink-2">{o.businessDate !== date ? `${o.businessDate.slice(5)} ` : ''}{t}</div>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex shrink-0 -space-x-3">{o.items.slice(0, 2).map((i) => <Photo key={i.lineId} id={i.photoId} size={44} rounded={22} className="border-2 border-white" />)}</div>
          <div className="min-w-0">
            <div className="text-sm font-bold">{tr('票号', 'Receipt')} {o.receiptNumber}{o.offlineReceiptNumber ? `（${o.offlineReceiptNumber}）` : ''}
              {o.addOnTo && <span className="ml-2 rounded bg-brand-soft px-1.5 text-xs font-semibold text-brand">{tr(`加单 · 原 ${o.addOnTo.tokenNumber} 号 ${o.addOnTo.receiptNumber ?? ''}`, `Add-on · token ${o.addOnTo.tokenNumber} ${o.addOnTo.receiptNumber ?? ''}`)}</span>}
            </div>
            <div className="font-semibold">{o.items.map((i) => `${itemName(i)} ×${i.quantity}`).join('，')}</div>
          </div>
        </div>
        <div className="col-start-2 text-sm lg:col-start-auto">{tr(SERVICE_MODE_NAMES[o.serviceMode].zh, SERVICE_MODE_NAMES[o.serviceMode].en)}</div>
        <div className="col-start-2 lg:col-start-auto">
          <span className={`inline-block rounded-lg px-2.5 py-1 text-sm font-bold ${o.kitchenCancelRequested ? 'bg-danger-bg text-danger' : o.fulfillmentStatus === 'cancelled' ? 'bg-subtle text-ink-2' : o.fulfillmentStatus === 'served' ? 'bg-subtle text-ink' : o.fulfillmentStatus === 'preparing' ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>
            {o.kitchenCancelRequested ? tr('取消待后厨确认', 'Cancel awaiting kitchen') : fulfillLabel(tr, o.fulfillmentStatus)}
          </span>
          <div className="mt-1 text-xs text-ink-2">{kitchenNote}</div>
        </div>
        <div className="col-start-2 lg:col-start-auto">
          <b className="tabular-nums">{formatRM(o.totalSen)}</b>
          <div className="mt-1">
            <span className={`inline-block rounded-lg px-2 py-0.5 text-sm font-bold ${pendingLocal ? 'bg-warn-bg text-warn' : payTone(o.paymentState)}`}>
              {pendingLocal ? tr('本机已登记 · 待同步', 'Recorded here · syncing') : payLabel(tr, o.paymentState)}
            </span>
            {channel && o.paymentState !== 'unpaid' && o.paymentState !== 'not_due' && <span className="ml-1 text-xs text-ink-2">{tr('旧记录', 'legacy')} · {channel}</span>}
          </div>
          {fb && <div role={fb.ok ? 'status' : 'alert'} className={`mt-1 text-xs font-semibold ${fb.ok ? 'text-ok' : 'text-danger'}`}>{fb.text}</div>}
        </div>
        <div className="col-start-2 flex flex-wrap gap-2 lg:col-start-auto lg:justify-end">
          {canConfirm && (
            <button type="button" disabled={inFlight || !canRegister} onClick={() => void confirmPaid(o)}
              title={canRegister ? undefined : tr('只能在已开班的主点单平板登记收款', 'Only the main register with an open shift can record payments')}
              className="h-14 rounded-xl bg-brand px-4 font-bold text-white disabled:bg-control">
              {inFlight ? tr('正在登记…', 'Recording…') : tr(`确认已收款 ${formatRM(o.totalSen)}`, `Confirm paid ${formatRM(o.totalSen)}`)}
            </button>
          )}
          <button type="button" onClick={() => setReceiptId(o.id)} className="flex h-14 items-center gap-1.5 rounded-xl border border-line bg-card px-4 font-semibold"><Icon name="list" size={18} />{tr('收据', 'Receipt')}</button>
          {isFront && (o.fulfillmentStatus === 'queued' || (o.fulfillmentStatus === 'preparing' && !o.kitchenCancelRequested)) && (
            <button type="button" onClick={() => setDialog({ kind: 'cancel', order: o })} className="h-14 rounded-xl border border-line bg-card px-4 font-semibold">{tr('取消', 'Cancel')}</button>
          )}
          {canReverse && (
            <button type="button" onClick={() => setDialog({ kind: 'reverse', order: o })} className="h-14 rounded-xl border border-line bg-card px-4 font-semibold">{tr('更正误登记收款', 'Correct payment')}</button>
          )}
          {canRefund && (
            <button type="button" onClick={() => setDialog({ kind: 'refund', order: o })} className="h-14 rounded-xl border border-danger/50 bg-card px-4 font-semibold text-danger">{tr('登记退款', 'Record refund')}</button>
          )}
          {canWriteOff && (
            <button type="button" onClick={() => setDialog({ kind: 'writeOff', order: o })} className="h-14 rounded-xl border border-line bg-card px-4 font-semibold">{tr('放弃追收', 'Write off')}</button>
          )}
          {canReinstate && (
            <button type="button" onClick={() => setDialog({ kind: 'reinstate', order: o })} className="h-14 rounded-xl border border-line bg-card px-4 font-semibold">{tr('又收到钱 · 恢复待收款', 'Money received · reinstate')}</button>
          )}
        </div>
        {o.cancelRejection && o.fulfillmentStatus !== 'cancelled' && (
          <p role="status" className="col-span-2 rounded-lg bg-warn-bg px-3 py-2 text-sm font-semibold text-warn lg:col-span-6">
            {tr(`后厨拒绝取消，继续制作${o.cancelRejection.reason ? `：${o.cancelRejection.reason}` : ''}。订单照常出餐、照常收款。`, `Kitchen rejected the cancel and keeps cooking${o.cancelRejection.reason ? `: ${o.cancelRejection.reason}` : ''}. Serve and collect as usual.`)}
          </p>
        )}
        {o.paymentState === 'written_off' && o.writeOff && (
          <p className="col-span-2 text-xs text-ink-2 lg:col-span-6">{tr(`放弃追收：${o.writeOff.reason}（${formatRM(o.writeOff.amountSen)}，${new Date(o.writeOff.atMs).toLocaleString('zh-CN', { hour12: false })}）`, `Written off: ${o.writeOff.reason} (${formatRM(o.writeOff.amountSen)})`)}</p>
        )}
        {canConfirm && !canRegister && reg.status !== 'loading' && (
          <p className="col-span-2 text-xs text-ink-2 lg:col-span-6 lg:text-right">{tr('收款只能在已开班的主点单平板登记。', 'Payments can only be recorded on the main register with an open shift.')}</p>
        )}
      </div>
    );
  };

  const exportCsv = () => {
    if (!config) return;
    const head = ['餐牌', '票号', '营业日', '时间', '用餐方式', '后厨进度', '收款状态', '付款方式', '金额(sen)', '餐品'];
    const zh: Tr = (z) => z;
    const body = shown.map((o) => [
      o.tokenNumber, o.receiptNumber, o.businessDate, new Date(o.acceptedAtEffectiveMs).toLocaleString('zh-CN', { hour12: false, timeZone: config.timeZone }), SERVICE_MODE_NAMES[o.serviceMode].zh,
      fulfillLabel(zh, o.fulfillmentStatus), payLabel(zh, o.paymentState), channelLabel(zh, o.paymentMethod) ?? (o.paymentMethod === 'unspecified' ? '人工确认（不分渠道）' : ''),
      o.totalSen, o.items.map((i) => `${itemName(i)}×${i.quantity}`).join(' / '),
    ]);
    download(`订单_${date}.csv`, toCsv([head, ...body]));
  };

  return (
    <div className="mx-auto max-w-[1440px] p-4 pb-8 lg:p-8">
      {carried.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-1 text-xl font-bold text-warn">{tr(`之前营业日未完成或未收款 · ${carried.length} 单`, `Earlier days: unfinished or unpaid · ${carried.length}`)}</h2>
          <p className="mb-2 text-sm text-ink-2">{tr('归属原营业日；仍在制作的后厨屏继续显示，未收款的收到钱后照常确认。请按票号核对，餐牌已可能被新单使用。', 'They stay on their original business day. Match by receipt number — the token may now belong to a new order.')}</p>
          <div className="overflow-hidden rounded-2xl border-2 border-warn/60 bg-card">{carried.map(row)}</div>
        </section>
      )}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-2xl font-bold lg:text-[28px]">{tr('掌握每一单的进度', 'Every order at a glance')}</h2>
          <p className="text-sm text-ink-2">
            {tr(`营业日 ${date} · ${q.data.length} 单`, `Business day ${date} · ${q.data.length} orders`)}
            {counts.unpaid ? tr(` · 未收款 ${counts.unpaid} 单 ${formatRM(unpaidTodaySen)}`, ` · ${counts.unpaid} unpaid ${formatRM(unpaidTodaySen)}`) : ''}
            {q.fromCache ? tr(' · 画面可能过期', ' · may be out of date') : ''}
          </p>
        </div>
        <button type="button" onClick={exportCsv} disabled={!shown.length} className="ml-auto flex h-14 items-center gap-2 rounded-xl border border-line bg-card px-4 font-bold disabled:opacity-40"><Icon name="download" size={20} />{tr('导出订单', 'Export orders')}</button>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {filters.map(([f, label]) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
            className={`h-14 rounded-xl border px-4 font-semibold ${filter === f ? 'border-ink bg-ink text-white' : f === 'unpaid' && counts.unpaid ? 'border-danger/50 bg-card text-danger' : 'border-line bg-card text-ink-2'}`}>
            {label} <span className="ml-1 text-sm opacity-70">{counts[f]}</span>
          </button>
        ))}
        <label className="flex h-14 w-full items-center gap-2 rounded-xl border border-line bg-card px-3 sm:ml-auto sm:w-72">
          <Icon name="search" size={18} className="text-ink-2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('搜索票号 / 餐牌号 / 餐品', 'Search receipt / token / item')} aria-label={tr('搜索订单', 'Search orders')} className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
      </div>
      {msg && <p role="alert" className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-danger">{msg}</p>}
      <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
        <div className={`hidden gap-x-4 border-b border-line bg-[#fbfaf6] px-5 py-3 text-xs text-ink-2 lg:grid ${cols}`}>
          <span>{tr('餐牌 / 时间', 'Token / time')}</span><span>{tr('票号 / 餐品', 'Receipt / items')}</span><span>{tr('用餐方式', 'Mode')}</span><span>{tr('后厨进度', 'Kitchen')}</span><span>{tr('收款', 'Payment')}</span><span className="text-right">{tr('操作', 'Actions')}</span>
        </div>
        {shown.length === 0 && <p className="p-8 text-center text-ink-2">{q.loading ? tr('正在载入…', 'Loading…') : q.data.length ? tr('没有符合条件的订单', 'No matching orders') : tr('今天还没有订单', 'No orders yet today')}</p>}
        {shown.map(row)}
      </div>
      <p className="mt-4 flex items-start gap-2 rounded-2xl border border-warn/30 bg-warn-bg px-4 py-3 text-sm text-warn">
        <Icon name="help" size={18} />
        {tr('下单、出餐、收款是三个独立状态：出餐会自动释放餐牌；收到整单货款后点「确认已收款」。显示或扫描收款码都不算收款，系统也不会自动核对钱包或银行到账。',
          'Ordering, serving and payment are separate: serving releases the token automatically; tap "Confirm paid" once the full amount is received. Showing or scanning the QR does not count as payment, and nothing is verified with the wallet or bank.')}
      </p>
      {receiptId && config && (
        <ReceiptDialog receiptKey={receiptId} load={() => receiptFromOrder(receiptId, config.name)} menuVersion={config.activeMenuVersion} timeZone={config.timeZone} onClose={() => setReceiptId(null)} />
      )}
      {dialog && <ActionDialog dialog={dialog} busy={busy} onClose={() => setDialog(null)} onRun={run} />}
    </div>
  );
}

function ActionDialog({ dialog, busy, onClose, onRun }: {
  dialog: Dialog;
  busy: boolean;
  onClose: () => void;
  onRun: (name: RunName, o: OrderRow, extra: Record<string, unknown>) => void;
}) {
  const online = useOnline();
  const tr = useT();
  const o = dialog.order;
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const ident = tr(`票号 ${o.receiptNumber} · ${o.tokenNumber}号`, `Receipt ${o.receiptNumber} · token ${o.tokenNumber}`);
  const reasonInput = (placeholder: string) => (
    <input placeholder={placeholder} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200}
      className="mt-3 h-14 w-full rounded-xl border border-control px-3 text-base" onFocus={(e) => { const el = e.currentTarget; setTimeout(() => el.scrollIntoView({ block: 'center' }), 300); }} />
  );
  const needsConfirm = dialog.kind !== 'cancel';
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
      <div className="max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl bg-card p-5">
        {dialog.kind === 'cancel' && (
          <>
            <h2 className="text-xl font-bold">{tr('取消订单', 'Cancel order')} · {ident}</h2>
            <p className="mt-1 text-sm text-ink-2">
              {o.fulfillmentStatus === 'preparing' ? tr('已在制作中：需要后厨确认停止制作。', 'Already preparing: the kitchen must confirm it stopped. ') : tr('尚未开始制作，会直接取消。', 'Not started yet — it will be cancelled now. ')}
              {o.paymentState === 'unpaid' ? tr('这单还没收款，取消后无需收款、也不用退款。', 'Not paid yet: nothing will be due and no refund is needed.') : tr('取消不等于已退款，退款由老板另行登记。', 'Cancelling is not a refund; the owner records refunds separately.')}
            </p>
            {!online && (
              <p role="alert" className="mt-2 rounded-lg bg-warn-bg p-2 text-sm font-semibold text-warn">
                {tr('现在断网：系统取消无法完成。请口头通知厨房停做；联网后再在这里完成取消。系统取消完成前餐牌仍占用，后厨屏也没有收到取消通知。', 'Offline: the cancel cannot be completed in the system. Tell the kitchen in person; finish the cancel here once back online. Until then the token stays in use and the kitchen screen has not been told.')}
              </p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {CANCEL_REASONS.map(([zh, en]) => (
                <button key={zh} type="button" aria-pressed={reason === zh} onClick={() => setReason(zh)}
                  className={`h-14 rounded-xl border-2 font-semibold ${reason === zh ? 'border-ink bg-ok-bg' : 'border-line'}`}>{tr(zh, en)}</button>
              ))}
            </div>
          </>
        )}
        {dialog.kind === 'refund' && (
          <>
            <h2 className="text-xl font-bold">{tr('登记退款', 'Record refund')} · {ident} {formatRM(o.paidSen - o.refundedSen)}</h2>
            <p className="mt-1 text-sm text-ink-2">{tr('系统不会自动转账。请先实际把钱退给顾客，再登记。只能整单退款，不需要选择退款渠道。', 'Nothing is transferred automatically. Refund the customer first, then record it. Full refunds only; no channel needed.')}</p>
            {reasonInput(tr('退款原因（必填）', 'Refund reason (required)'))}
            <label className="mt-3 flex items-center gap-2 font-semibold">
              <input type="checkbox" className="h-6 w-6" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {tr('钱已经实际退给顾客', 'The money has actually been returned')}
            </label>
          </>
        )}
        {dialog.kind === 'reverse' && (
          <>
            <h2 className="text-xl font-bold">{tr('更正误登记收款', 'Correct a mis-recorded payment')} · {ident}</h2>
            <p className="mt-1 text-sm text-ink-2">
              {tr(`用于员工误点「确认已收款」、其实没收到 ${formatRM(o.paidSen)} 的情况。原收款记录保留，追加一笔反向调整，订单回到未收款。这不是退款：如果钱已经收了又退给顾客，请用「登记退款」。`,
                `Use this when "Confirm paid" was tapped by mistake and ${formatRM(o.paidSen)} was never received. The original record stays and a reversal is added; the order becomes unpaid again. This is not a refund — use "Record refund" if money was returned.`)}
            </p>
            {reasonInput(tr('更正原因（必填，例如：点错单）', 'Reason (required, e.g. tapped wrong order)'))}
            <label className="mt-3 flex items-center gap-2 font-semibold">
              <input type="checkbox" className="h-6 w-6" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {tr('我已核对，这笔钱确实没有收到', 'I checked: this money was not received')}
            </label>
          </>
        )}
        {dialog.kind === 'writeOff' && (
          <>
            <h2 className="text-xl font-bold">{tr('放弃追收', 'Write off')} · {ident} {formatRM(o.totalSen)}</h2>
            <p className="mt-1 text-sm text-ink-2">
              {tr('确认这笔钱确实收不回来。订单保留在历史里并标为「已放弃追收」，移出待登记收款和日结例外；报表单独显示未收回金额。不算已付款、不计实收，已发生的食材成本不变。之后如果又收到钱，可在这里恢复待收款再登记。',
                'Confirm this money will not be collected. The order stays in history as written off and leaves the to-record list and close exceptions; reports show it as not collected. It is not paid, not counted as received, and food cost is unchanged. If money arrives later you can reinstate it here.')}
            </p>
            {reasonInput(tr('原因（必填，例如：顾客未付款离开）', 'Reason (required, e.g. customer left without paying)'))}
            <label className="mt-3 flex items-center gap-2 font-semibold">
              <input type="checkbox" className="h-6 w-6" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {tr('我确认这笔钱没有收到，也不再追收', 'I confirm it was not received and will not be chased')}
            </label>
          </>
        )}
        {dialog.kind === 'reinstate' && (
          <>
            <h2 className="text-xl font-bold">{tr('恢复待收款', 'Reinstate as unpaid')} · {ident} {formatRM(o.totalSen)}</h2>
            <p className="mt-1 text-sm text-ink-2">{tr('用于放弃追收后又收到钱。恢复后订单回到待登记收款，再由主点单平板确认已收款；原放弃记录保留，并追加一条恢复记录。', 'Use when money arrives after a write-off. The order returns to the to-record list; then confirm the payment on the main register. The write-off record stays and a reinstate record is added.')}</p>
            {reasonInput(tr('原因（必填，例如：顾客回来付款）', 'Reason (required, e.g. customer came back to pay)'))}
            <label className="mt-3 flex items-center gap-2 font-semibold">
              <input type="checkbox" className="h-6 w-6" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {tr('顾客确实回来付款了', 'The customer did come back to pay')}
            </label>
          </>
        )}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="h-14 flex-1 rounded-xl border border-control font-semibold">{tr('返回', 'Back')}</button>
          <button type="button"
            disabled={busy || reason.trim().length < 2 || (needsConfirm && !confirmed) || (dialog.kind === 'cancel' && !online)}
            onClick={() => dialog.kind === 'cancel'
              ? onRun('requestCancel', o, { reason })
              : dialog.kind === 'refund'
                ? onRun('confirmFullRefund', o, { amountSen: o.paidSen - o.refundedSen, reason })
                : dialog.kind === 'writeOff'
                  ? onRun('writeOffPayment', o, { reason })
                  : dialog.kind === 'reinstate'
                    ? onRun('reinstateWrittenOff', o, { reason })
                    : onRun('reversePayment', o, { reason })}
            className="h-14 flex-1 rounded-xl bg-brand font-bold text-white disabled:bg-control">{busy ? tr('处理中…', 'Working…') : tr('确认', 'Confirm')}</button>
        </div>
      </div>
    </div>
  );
}
