/**
 * 订单页：当日订单，制作 / 付款两种状态分开显示（取消 ≠ 已退款）。
 * 收银可请求取消；只有老板能确认已实际退款（整单，首版不调用银行）。
 */
import { useState } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { businessDateOf } from '../../domain/businessDay';
import { formatRM } from '../../domain/money';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useLiveQuery, useNow } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { useSession } from '../../app/session';
import { Photo } from '../../ui/visual';
import { ReceiptDialog, receiptFromOrder } from '../receipt/ReceiptDialog';

interface OrderRow {
  id: string;
  receiptNumber: string;
  tokenNumber: number;
  serviceMode: 'dine_in' | 'takeaway';
  fulfillmentStatus: 'queued' | 'preparing' | 'served' | 'cancelled';
  paymentState: 'paid' | 'refund_due' | 'refunded';
  kitchenCancelRequested: boolean;
  paymentMethod: 'cash' | 'qr_manual';
  totalSen: number;
  paidSen: number;
  refundedSen: number;
  acceptedAtEffectiveMs: number;
  kitchenAckAtMs: number | null;
  tokenReturnedAtMs?: number;
  manualHandoffAtMs?: number | null;
  source?: 'online' | 'offline';
  offlineReceiptNumber?: string | null;
  businessDate: string;
  version: number;
  items: { lineId: string; nameZh: string; quantity: number; photoId: string }[];
}

const FULFILL_ZH = { queued: '待做', preparing: '制作中', served: '已出餐', cancelled: '已取消' };
const PAY_ZH = { paid: '已收款', refund_due: '应退款待处理', refunded: '已退款' };
const CANCEL_REASONS = ['顾客离开', '点错单', '重复下单', '其他'];

export function OrdersPage() {
  const { config, member } = useSession();
  const now = useNow(60_000);
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
  const carried = openQ.data.filter((o) => date && o.businessDate < date).sort((a, b) => a.acceptedAtEffectiveMs - b.acceptedAtEffectiveMs);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'cancel' | 'refund'; order: OrderRow } | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = member?.role === 'owner';

  async function run(name: 'requestCancel' | 'confirmFullRefund', o: OrderRow, extra: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await submit(name, { operationId: newOperationId(), orderId: o.id, expectedVersion: o.version, ...extra });
      setDialog(null);
    } catch (e) {
      setMsg(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
    } finally {
      setBusy(false);
    }
  }

  const row = (o: OrderRow) => (
          <div key={o.id} className="flex flex-wrap items-center gap-3 border-b border-line p-3 last:border-0">
            <span className="w-14 text-center text-3xl font-black tabular-nums">{o.tokenNumber}</span>
            <div className="flex -space-x-2">{o.items.slice(0, 3).map((i) => <Photo key={i.lineId} id={i.photoId} size={44} rounded={22} className="border-2 border-white" />)}</div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{o.items.map((i) => `${i.quantity}× ${i.nameZh}`).join('，')}</div>
              <div className="text-sm text-ink-2">
                {o.businessDate !== date ? `营业日 ${o.businessDate} · ` : ''}票号 {o.receiptNumber}{o.offlineReceiptNumber ? `（${o.offlineReceiptNumber}）` : ''} · {new Date(o.acceptedAtEffectiveMs).toLocaleTimeString('zh-CN', { hour12: false })} · {o.serviceMode === 'dine_in' ? '堂食' : '打包'} · {o.paymentMethod === 'cash' ? '现金' : 'QR'}
                {o.source === 'offline' ? ' · 离线单（人工传单）' : o.kitchenAckAtMs ? ' · 后厨已收到' : ' · 等待厨房确认'}
                {o.manualHandoffAtMs ? ' · 已人工传单' : ''}
                {o.tokenReturnedAtMs ? ' · 餐牌已收回' : ''}
              </div>
            </div>
            <span className={`rounded-lg px-2 py-1 text-sm font-semibold ${o.fulfillmentStatus === 'cancelled' ? 'bg-subtle text-ink-2' : o.fulfillmentStatus === 'served' ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>
              {o.kitchenCancelRequested ? '取消待后厨确认' : FULFILL_ZH[o.fulfillmentStatus]}
            </span>
            <span className={`rounded-lg px-2 py-1 text-sm font-semibold ${o.paymentState === 'refund_due' ? 'bg-danger-bg text-danger' : 'bg-subtle'}`}>{PAY_ZH[o.paymentState]}</span>
            <b className="w-24 text-right tabular-nums">{formatRM(o.totalSen)}</b>
            <button type="button" onClick={() => setReceiptId(o.id)} className="h-11 rounded-lg border border-control px-3 font-semibold">收据</button>
            {(o.fulfillmentStatus === 'queued' || (o.fulfillmentStatus === 'preparing' && !o.kitchenCancelRequested)) && (
              <button type="button" onClick={() => setDialog({ kind: 'cancel', order: o })} className="h-11 rounded-lg border border-control px-3 font-semibold">取消</button>
            )}
            {isOwner && o.paymentState !== 'refunded' && (o.fulfillmentStatus === 'served' || o.fulfillmentStatus === 'cancelled') && (
              <button type="button" onClick={() => setDialog({ kind: 'refund', order: o })} className="h-11 rounded-lg border border-danger px-3 font-semibold text-danger">登记退款</button>
            )}
          </div>
  );

  return (
    <div className="mx-auto max-w-6xl p-4">
      {carried.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-1 text-xl font-bold text-warn">跨营业日未完成 · {carried.length} 单</h2>
          <p className="mb-2 text-sm text-ink-2">前一营业日接的单仍在制作，归属原营业日，后厨屏继续显示。</p>
          <div className="overflow-hidden rounded-2xl border-2 border-warn bg-card">{carried.map(row)}</div>
        </section>
      )}
      <h1 className="mb-1 text-2xl font-bold">今日订单</h1>
      <p className="mb-4 text-ink-2">营业日 {date} · {q.data.length} 单{q.fromCache ? ' · 画面可能过期' : ''}</p>
      {msg && <p role="alert" className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-danger">{msg}</p>}
      <div className="overflow-hidden rounded-2xl border border-line bg-card">
        {q.data.length === 0 && <p className="p-6 text-ink-2">{q.loading ? '正在载入…' : '今天还没有订单'}</p>}
        {q.data.map(row)}
      </div>
      {receiptId && config && (
        <ReceiptDialog receiptKey={receiptId} load={() => receiptFromOrder(receiptId, config.name)} menuVersion={config.activeMenuVersion} timeZone={config.timeZone} onClose={() => setReceiptId(null)} />
      )}
      {dialog && <ActionDialog dialog={dialog} busy={busy} onClose={() => setDialog(null)} onRun={run} />}
    </div>
  );
}

function ActionDialog({ dialog, busy, onClose, onRun }: {
  dialog: { kind: 'cancel' | 'refund'; order: OrderRow };
  busy: boolean;
  onClose: () => void;
  onRun: (name: 'requestCancel' | 'confirmFullRefund', o: OrderRow, extra: Record<string, unknown>) => void;
}) {
  const o = dialog.order;
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'cash' | 'qr_manual'>(o.paymentMethod);
  const [actuallyRefunded, setActuallyRefunded] = useState(false);
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-card p-5">
        {dialog.kind === 'cancel' ? (
          <>
            <h2 className="text-xl font-bold">取消 {o.tokenNumber}号</h2>
            <p className="mt-1 text-sm text-ink-2">{o.fulfillmentStatus === 'preparing' ? '已在制作中：需要后厨确认停止制作。' : '尚未开始制作，会直接取消。'}取消不等于已退款，退款由老板另行登记。</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {CANCEL_REASONS.map((r) => (
                <button key={r} type="button" aria-pressed={reason === r} onClick={() => setReason(r)}
                  className={`h-12 rounded-lg border-2 font-semibold ${reason === r ? 'border-ink bg-ok-bg' : 'border-line'}`}>{r}</button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h2 className="text-xl font-bold">登记退款 · {o.tokenNumber}号 {formatRM(o.paidSen - o.refundedSen)}</h2>
            <p className="mt-1 text-sm text-ink-2">系统不会自动转账。请先实际把钱退给顾客，再登记。首版只能整单退款。</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(['cash', 'qr_manual'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}
                  className={`h-12 rounded-lg border-2 font-semibold ${method === m ? 'border-ink bg-ok-bg' : 'border-line'}`}>{m === 'cash' ? '现金退回' : '转账退回'}</button>
              ))}
            </div>
            <input placeholder="退款原因（必填）" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200}
              className="mt-3 h-12 w-full rounded-lg border border-control px-3" />
            <label className="mt-3 flex items-center gap-2 font-semibold">
              <input type="checkbox" className="h-6 w-6" checked={actuallyRefunded} onChange={(e) => setActuallyRefunded(e.target.checked)} />
              钱已经实际退给顾客
            </label>
          </>
        )}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="h-12 flex-1 rounded-lg border border-control font-semibold">返回</button>
          <button type="button"
            disabled={busy || reason.trim().length < 2 || (dialog.kind === 'refund' && !actuallyRefunded)}
            onClick={() => dialog.kind === 'cancel'
              ? onRun('requestCancel', o, { reason })
              : onRun('confirmFullRefund', o, { amountSen: o.paidSen - o.refundedSen, refundMethod: method, reason })}
            className="h-12 flex-1 rounded-lg bg-brand font-bold text-white disabled:bg-control">{busy ? '处理中…' : '确认'}</button>
        </div>
      </div>
    </div>
  );
}
