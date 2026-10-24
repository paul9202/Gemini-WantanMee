/**
 * 待登记收款：员工送餐收到钱后，回主点单平板按「订单」确认（不是按餐牌——牌出餐即释放、会被新单复用）。
 * 每张卡显示唯一票号 / 临时号、原餐牌、下单时间、餐品与数量、整单金额、制作状态；已出餐未收的排最前。
 * 「确认已收款」直接登记一次全额收款（防连点，明确成功反馈）；误登记由老板在订单页更正。
 * 「显示收款码」只显示原图，不改变付款状态。
 * 加单（客人吃完再加打包）与原单合成一张卡：一起列出、合计金额、一次「确认已收款」登记整组。
 * 每张卡有「加单」：回点餐页给这位客人再点，送厨后仍挂在同一组里。
 */
import { useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { formatRM, Sen } from '../../domain/money';
import { manualStatus } from '../../domain/offline';
import type { LineConfig } from '../../domain/lineItem';
import type { Fulfillment } from '../../domain/orderLifecycle';
import { db, storePath } from '../../data/firebase/client';
import { useLiveQuery } from '../../data/firebase/live';
import { useRecordPayments } from '../../data/payments';
import { useOfflineRuntime } from '../../data/offline/runtime';
import { useT } from '../../app/i18n';
import { Icon } from '../../ui/visual';
import { ReceivingQrDialog } from './ReceivingQr';

export interface UnpaidOrder {
  id: string;
  ticketNo: string;
  offline: boolean;
  tokenNumber: number;
  acceptedAtMs: number;
  items: { name: string; quantity: number }[];
  totalSen: Sen;
  /** served：已出餐；cooking：制作中（含人工单）；cancel_pending：取消待后厨确认（暂不能登记）。 */
  stage: 'served' | 'cooking' | 'cancel_pending';
  /** 加单挂在哪张原单上；普通单为 null。 */
  addOnToOrderId: string | null;
}

/** 一组：原单 + 它的加单（原单已另行收款时只剩加单）。按接单时间排，原单在前。 */
export interface UnpaidGroup {
  rootId: string;
  orders: UnpaidOrder[];
  totalSen: Sen;
  stage: UnpaidOrder['stage'];
}

const STAGE_RANK = { served: 0, cooking: 1, cancel_pending: 2 } as const;

export function groupUnpaid(orders: UnpaidOrder[]): UnpaidGroup[] {
  const byRoot = new Map<string, UnpaidOrder[]>();
  for (const o of orders) {
    const root = o.addOnToOrderId ?? o.id;
    byRoot.set(root, [...(byRoot.get(root) ?? []), o]);
  }
  return [...byRoot.entries()].map(([rootId, list]): UnpaidGroup => {
    const sorted = [...list].sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);
    // 整组状态：有一张取消待确认就整组暂不能登记；否则有一张已出餐就排到最前。
    const stage = sorted.some((o) => o.stage === 'cancel_pending') ? 'cancel_pending' : sorted.some((o) => o.stage === 'served') ? 'served' : 'cooking';
    return { rootId, orders: sorted, totalSen: sorted.reduce((s, o) => s + o.totalSen, 0), stage };
  }).sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || a.orders[0].acceptedAtMs - b.orders[0].acceptedAtMs);
}

interface OrderDoc {
  receiptNumber: string;
  offlineReceiptNumber: string | null;
  source: 'online' | 'offline';
  tokenNumber: number;
  acceptedAtEffectiveMs: number;
  totalSen: number;
  fulfillmentStatus: Fulfillment;
  kitchenCancelRequested?: boolean;
  paymentState: string;
  items: { nameZh: string; quantity: number }[];
  addOnTo?: { orderId: string } | null;
}

/** 云端待收款订单 + 本机尚未同步的离线未付款单，扣除本机已登记（待同步）的。 */
export function useUnpaidOrders(nameOf?: (c: LineConfig) => string): { orders: UnpaidOrder[]; totalSen: Sen; fromCache: boolean } {
  const rt = useOfflineRuntime();
  const q = useLiveQuery<OrderDoc>(query(collection(db, storePath('orders')), where('paymentState', '==', 'unpaid')), 'unpaid-orders');
  return useMemo(() => {
    const events = rt.outbox.filter((r) => r.status !== 'rejected').map((r) => r.event);
    const paidLocally = new Set(events.filter((e) => e.type === 'offline_payment_recorded').map((e) => e.payload.clientOrderId));
    const out = new Map<string, UnpaidOrder>();
    for (const o of q.data) {
      if (o.fulfillmentStatus === 'cancelled' || paidLocally.has(o.id)) continue;
      out.set(o.id, {
        id: o.id, ticketNo: o.receiptNumber ?? o.offlineReceiptNumber ?? '', offline: o.source === 'offline', tokenNumber: o.tokenNumber,
        acceptedAtMs: o.acceptedAtEffectiveMs, items: (o.items ?? []).map((i) => ({ name: i.nameZh, quantity: i.quantity })), totalSen: o.totalSen,
        stage: o.kitchenCancelRequested ? 'cancel_pending' : o.fulfillmentStatus === 'served' ? 'served' : 'cooking',
        addOnToOrderId: o.addOnTo?.orderId ?? null,
      });
    }
    for (const o of rt.localOrders) {
      if (o.payment || out.has(o.clientOrderId) || paidLocally.has(o.clientOrderId)) continue;
      const rec = rt.outbox.find((r) => r.event.type === 'offline_order_created' && r.event.payload.clientOrderId === o.clientOrderId);
      if (rec?.status === 'accepted' || rec?.status === 'rejected') continue; // 已入云端（以云端为准）或被拒
      out.set(o.clientOrderId, {
        id: o.clientOrderId, ticketNo: o.offlineReceiptNumber, offline: true, tokenNumber: o.tokenNumber, acceptedAtMs: o.createdAtMs,
        items: o.lines.map((l) => ({ name: nameOf?.(l.config) ?? '', quantity: l.quantity })), totalSen: o.totalSen,
        stage: manualStatus(events, o.clientOrderId).served ? 'served' : 'cooking',
        addOnToOrderId: null,
      });
    }
    const rank = { served: 0, cooking: 1, cancel_pending: 2 } as const;
    const orders = [...out.values()].sort((a, b) => rank[a.stage] - rank[b.stage] || a.acceptedAtMs - b.acceptedAtMs);
    return { orders, totalSen: orders.reduce((s, o) => s + o.totalSen, 0), fromCache: q.fromCache };
    // nameOf 只是显示名称，随菜单变化；不作为依赖避免每次渲染重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, q.fromCache, rt.outbox, rt.localOrders]);
}

/** 一张待收款卡（单张订单，或原单 + 加单一组）：主按钮登记整组；成功后显示明确反馈。 */
export function PaymentCard({ group, onRecorded, onAddOn }: { group: UnpaidGroup; onRecorded?: (ids: string[]) => void; onAddOn?: (order: UnpaidOrder) => void }) {
  const tr = useT();
  const record = useRecordPayments();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [qr, setQr] = useState(false);
  const multi = group.orders.length > 1;
  const first = group.orders[0];
  const stageText = (s: UnpaidOrder['stage']) => s === 'served' ? tr('已出餐 · 未收款', 'Served · unpaid')
    : s === 'cancel_pending' ? tr('取消待后厨确认', 'Cancel pending') : tr('制作中 · 未收款', 'Cooking · unpaid');

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await record(group.orders.map((o) => ({ orderId: o.id, amountSen: o.totalSen })));
    setBusy(false);
    if (r.ok) {
      onRecorded?.(group.orders.map((o) => o.id));
      setMsg({ ok: true, text: r.alreadyRecorded ? tr('这张单之前已登记收款', 'Already recorded earlier')
        : r.offline ? tr(`已登记收款 ${formatRM(group.totalSen)}（本机保存，联网后同步）`, `Recorded ${formatRM(group.totalSen)} (saved here, will sync)`)
        : multi ? tr(`已登记收款 ${formatRM(group.totalSen)}（${group.orders.length} 张单一起）`, `Recorded ${formatRM(group.totalSen)} (${group.orders.length} orders)`)
        : tr(`已登记收款 ${formatRM(group.totalSen)}`, `Recorded ${formatRM(group.totalSen)}`) });
    } else {
      setMsg({ ok: false, text: r.message });
    }
  }

  return (
    <li className={`rounded-2xl border p-3 ${group.stage === 'served' ? 'border-warn/50 bg-warn-bg/40' : 'border-line bg-card'}`} data-order-id={first.id}>
      {multi && <p className="mb-2 text-sm font-semibold text-brand">{tr(`原单 + 加单 · ${group.orders.length} 张单一起结账`, `Order + add-on · ${group.orders.length} orders, one payment`)}</p>}
      <div className={multi ? 'space-y-2' : ''}>
        {group.orders.map((order) => {
          const time = new Date(order.acceptedAtMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
          const items = order.items.map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join('，');
          return (
            <div key={order.id} className={`flex items-start gap-3 ${multi ? 'rounded-xl border border-line/70 bg-card p-2' : ''}`}>
              <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl border border-line bg-canvas">
                <span className="text-[10px] text-ink-2">{tr('原餐牌', 'Token')}</span>
                <b className="text-2xl tabular-nums">{order.tokenNumber}</b>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <b className="tabular-nums">{order.ticketNo}</b>
                  <span className="text-sm text-ink-2">{time}</span>
                  {order.addOnToOrderId && <span className="rounded bg-brand-soft px-1.5 text-xs font-semibold text-brand">{tr('加单', 'Add-on')}</span>}
                  {order.offline && <span className="rounded bg-subtle px-1.5 text-xs text-ink-2">{tr('人工单', 'Manual')}</span>}
                  <span className={`ml-auto rounded-lg px-2 py-0.5 text-sm font-semibold ${order.stage === 'served' ? 'bg-warn-bg text-warn' : 'bg-subtle text-ink-2'}`}>{stageText(order.stage)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm">{items}{multi && <b className="ml-2 tabular-nums">{formatRM(order.totalSen)}</b>}</p>
              </div>
            </div>
          );
        })}
      </div>
      {msg
        ? <p role="status" className={`mt-3 flex min-h-14 items-center gap-2 rounded-xl px-3 font-semibold ${msg.ok ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>
            {msg.ok && <Icon name="check" size={22} />}{msg.text}
          </p>
        : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void confirm()} disabled={busy || group.stage === 'cancel_pending'}
              className="flex h-14 min-w-[60%] flex-1 items-center justify-center gap-2 rounded-xl bg-ok px-3 text-lg font-bold text-white disabled:bg-control">
              <Icon name="check" size={24} />{busy ? tr('正在登记…', 'Recording…') : tr(`确认已收款 ${formatRM(group.totalSen)}`, `Confirm received ${formatRM(group.totalSen)}`)}
            </button>
            <button type="button" onClick={() => setQr(true)} className="flex h-14 shrink-0 items-center gap-2 rounded-xl border border-line px-3 font-semibold">
              <Icon name="qr" size={22} />{tr('显示收款码', 'Show QR')}
            </button>
            {/* 客人吃完再加（多为打包）：回点餐页给同一组加一张新单，最后一起结账。人工单（本机）不能加单。 */}
            {onAddOn && group.stage !== 'cancel_pending' && !first.offline && (
              <button type="button" onClick={() => onAddOn(first)} className="flex h-14 shrink-0 items-center gap-2 rounded-xl border border-line px-3 font-semibold">
                <Icon name="bag" size={22} />{tr('加单', 'Add on')}
              </button>
            )}
          </div>
        )}
      {qr && <ReceivingQrDialog amountSen={group.totalSen} label={multi ? tr(`${first.ticketNo} 等 ${group.orders.length} 张 · 原餐牌 ${first.tokenNumber}`, `${first.ticketNo} +${group.orders.length - 1} · token ${first.tokenNumber}`) : tr(`${first.ticketNo} · 原餐牌 ${first.tokenNumber}`, `${first.ticketNo} · token ${first.tokenNumber}`)} onClose={() => setQr(false)} />}
    </li>
  );
}

export function PendingPaymentsDrawer({ onClose, nameOf, onAddOn }: { onClose: () => void; nameOf?: (c: LineConfig) => string; onAddOn?: (order: UnpaidOrder) => void }) {
  const tr = useT();
  const { orders, totalSen, fromCache } = useUnpaidOrders(nameOf);
  // 本抽屉里登记成功的卡：订阅更新后它已不在待收款查询里，仍留在原位显示成功反馈，直到关闭抽屉。
  // （订阅首帧总是空列表，所以不能在首次渲染时拍快照。）在别处被登记的单照常从列表消失。
  const [recorded, setRecorded] = useState<Map<string, UnpaidOrder>>(() => new Map());
  const keep = (ids: string[]) => setRecorded((m) => {
    const add = orders.filter((x) => ids.includes(x.id) && !m.has(x.id));
    if (!add.length) return m;
    const next = new Map(m);
    for (const o of add) next.set(o.id, o);
    return next;
  });
  const groups = groupUnpaid([...orders, ...[...recorded.values()].filter((r) => !orders.some((o) => o.id === r.id))]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#1d2420]/45" role="dialog" aria-modal="true" aria-label={tr('待登记收款', 'Payments to record')}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="flex h-full w-full max-w-[640px] flex-col bg-canvas shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line bg-card px-4 py-3">
          <Icon name="wallet" size={28} />
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold">{tr('待登记收款', 'Payments to record')}</h2>
            <p className="text-sm text-ink-2">{tr(`${orders.length} 单 · ${formatRM(totalSen)} · 收到钱后按订单确认，不选现金或 TNG`, `${orders.length} · ${formatRM(totalSen)} · confirm per order once collected; no cash/TNG choice`)}</p>
          </div>
          <button type="button" onClick={onClose} autoFocus className="flex h-14 items-center gap-1 rounded-xl border border-line px-4 font-semibold"><Icon name="close" size={20} />{tr('关闭', 'Close')}</button>
        </header>
        {fromCache && <p className="border-b border-warn/40 bg-warn-bg px-4 py-2 text-sm text-warn">{tr('画面可能不是最新（离线或缓存）；后厨在云端出餐的单，本机可能看不到。', 'May be out of date (offline/cache); orders served in the cloud may not show here.')}</p>}
        <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {groups.length === 0 && <li className="py-16 text-center text-ink-2">{tr('没有待登记收款的订单', 'Nothing to record')}</li>}
          {groups.map((g) => <PaymentCard key={g.rootId} group={g} onRecorded={keep} onAddOn={onAddOn} />)}
        </ul>
      </div>
    </div>
  );
}

/**
 * 下单成功后的收款区：默认「待收款」。已收到钱可立即确认（与出餐后补登记同一条收款逻辑，
 * 不重新下单、不重发厨单、不重复分配成本）；不强迫每张单都进入收款步骤。
 */
export function QuickPay({ orders, label, paid }: { orders: { orderId: string; amountSen: Sen }[]; label: string; paid: boolean }) {
  const tr = useT();
  const record = useRecordPayments();
  const totalSen = orders.reduce((s, o) => s + o.amountSen, 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [qr, setQr] = useState(false);
  if (paid || msg?.ok) {
    return (
      <p role="status" className="mt-4 flex min-h-14 items-center justify-center gap-2 rounded-xl bg-ok-bg px-3 font-semibold text-ok">
        <Icon name="check" size={22} />{msg?.text ?? tr(`已收款 ${formatRM(totalSen)}`, `Paid ${formatRM(totalSen)}`)}
      </p>
    );
  }
  return (
    <div className="mt-4 rounded-xl border border-line bg-canvas p-3">
      <p className="font-semibold">{tr(`待收款 ${formatRM(totalSen)}`, `Unpaid ${formatRM(totalSen)}`)}{orders.length > 1 && <span className="ml-2 text-sm font-semibold text-brand">{tr(`原单 + 加单 · ${orders.length} 张一起`, `${orders.length} orders together`)}</span>}<span className="ml-2 text-sm font-normal text-ink-2">{tr('可先送餐，收到钱后再登记', 'Serve first; record when collected')}</span></p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button type="button" disabled={busy} onClick={async () => {
          if (busy) return;
          setBusy(true);
          const r = await record(orders);
          setBusy(false);
          setMsg(r.ok
            ? { ok: true, text: r.alreadyRecorded ? tr('这张单之前已登记收款', 'Already recorded earlier') : r.offline ? tr(`已登记收款 ${formatRM(totalSen)}（本机保存）`, `Recorded ${formatRM(totalSen)} (saved here)`) : tr(`已登记收款 ${formatRM(totalSen)}`, `Recorded ${formatRM(totalSen)}`) }
            : { ok: false, text: r.message });
        }} className="flex h-14 items-center gap-2 rounded-xl bg-ok px-5 font-bold text-white disabled:bg-control">
          <Icon name="check" size={22} />{busy ? tr('正在登记…', 'Recording…') : tr(`确认已收款 ${formatRM(totalSen)}`, `Confirm received ${formatRM(totalSen)}`)}
        </button>
        <button type="button" onClick={() => setQr(true)} className="flex h-14 items-center gap-2 rounded-xl border border-line px-4 font-semibold"><Icon name="qr" size={22} />{tr('显示收款码', 'Show QR')}</button>
      </div>
      {msg && !msg.ok && <p role="alert" className="mt-2 text-sm text-danger">{msg.text}</p>}
      {qr && <ReceivingQrDialog amountSen={totalSen} label={label} onClose={() => setQr(false)} />}
    </div>
  );
}
