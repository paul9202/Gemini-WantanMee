/**
 * 待登记收款：员工送餐收到钱后，回主点单平板按「订单」确认（不是按餐牌——牌出餐即释放、会被新单复用）。
 * 每张卡显示唯一票号 / 临时号、原餐牌、下单时间、餐品与数量、整单金额、制作状态；已出餐未收的排最前。
 * 「确认已收款」直接登记一次全额收款（防连点，明确成功反馈）；误登记由老板在订单页更正。
 * 「显示收款码」只显示原图，不改变付款状态。
 * 同桌账单（原单 + 加单）合成一张卡：一起列出、合计金额、一次「确认已收款」登记整组，没有单收其中一张的按钮。
 * 取消待后厨确认的单留在卡上但不计钱，其余的照常收；整组都在等取消才不能登记。原单已收款时卡上只收还没收的。
 * 一组超过服务器单次上限（10 张）时拆成连续几张卡，每张卡的按钮都能用。
 * 每张卡有「加单」：回点餐页给这位客人再点，送厨后仍挂在同一组里；原牌仍被这桌占着时同牌加单，不用再给牌。
 * 还有「加料」：开加料面板，预选这组第一张正常的单（加料单本身不能再加料）。
 * 门店开了「出餐即记收款」时：出餐的单服务器自动记收款，这里只剩还没出餐的（和更新前就出餐、还挂着的旧单）。
 * 前台点收款的同时后厨刚好出餐，服务器会拒绝并说明是出餐自动记的：拦下来写明「不要再收这一碗」，
 * 剩下的按刷新后的账单重新算，由员工再点一次才登记，绝不自动替他收。
 */
import { useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import type { PaidAtServeConflict } from '../../domain/bill';
import { formatRM, Sen } from '../../domain/money';
import { manualStatus } from '../../domain/offline';
import type { LineConfig } from '../../domain/lineItem';
import type { Fulfillment } from '../../domain/orderLifecycle';
import { db, storePath } from '../../data/firebase/client';
import { useLiveQuery } from '../../data/firebase/live';
import { paidAtServeTitle, useRecordPayments } from '../../data/payments';
import { useOfflineRuntime } from '../../data/offline/runtime';
import { useSession } from '../../app/session';
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
  /** served：已出餐；cooking：制作中（含人工单）；cancel_pending：取消待后厨确认（这张不计钱）。 */
  stage: 'served' | 'cooking' | 'cancel_pending';
  /** 加单挂在哪张原单上；普通单为 null。 */
  addOnToOrderId: string | null;
  /** 下单后加料的小单。 */
  extraOnly?: boolean;
}

/** 一张卡：原单 + 它的加单（原单已另行收款时只剩加单）。按接单时间排，原单在前。 */
export interface UnpaidGroup {
  /** 卡片的 key：一组拆成几张卡时 rootId 会重复。 */
  key: string;
  rootId: string;
  orders: UnpaidOrder[];
  /** 现在能收的单：不含取消待确认。 */
  payable: UnpaidOrder[];
  /** 现在要收的钱：只算 payable。 */
  totalSen: Sen;
  /** 整张卡的单都在等取消才是 cancel_pending；否则有一张已出餐就排到最前。 */
  stage: UnpaidOrder['stage'];
  /** 组长单不在待收款列表里：已收款、已取消或已放弃追收，这里分不清，只说已结清或已取消。 */
  rootGone: boolean;
  /** 第几张卡 / 这组共几张卡；没拆就是 1 / 1。 */
  part: number;
  parts: number;
}

/** 服务器一次结账最多登记这么多张单（recordGroupPayment 的 MAX_GROUP_ORDERS）。 */
export const MAX_PAY_ORDERS = 10;

const STAGE_RANK = { served: 0, cooking: 1, cancel_pending: 2 } as const;

/** 按时间顺序切成每张卡最多 MAX_PAY_ORDERS 张能收的单；取消待确认的不占名额，留在它原来的位置。 */
function splitForPayment(sorted: UnpaidOrder[]): UnpaidOrder[][] {
  const parts: UnpaidOrder[][] = [[]];
  let count = 0;
  for (const o of sorted) {
    const payable = o.stage !== 'cancel_pending';
    if (payable && count === MAX_PAY_ORDERS) {
      parts.push([]);
      count = 0;
    }
    parts[parts.length - 1].push(o);
    if (payable) count++;
  }
  return parts;
}

export function groupUnpaid(orders: UnpaidOrder[]): UnpaidGroup[] {
  const byRoot = new Map<string, UnpaidOrder[]>();
  for (const o of orders) {
    const root = o.addOnToOrderId ?? o.id;
    byRoot.set(root, [...(byRoot.get(root) ?? []), o]);
  }
  return [...byRoot.entries()].flatMap(([rootId, list]): UnpaidGroup[] => {
    const parts = splitForPayment([...list].sort((a, b) => a.acceptedAtMs - b.acceptedAtMs));
    const rootGone = !list.some((o) => o.id === rootId);
    return parts.map((part, i): UnpaidGroup => {
      const payable = part.filter((o) => o.stage !== 'cancel_pending');
      const stage = payable.length === 0 ? 'cancel_pending' : payable.some((o) => o.stage === 'served') ? 'served' : 'cooking';
      return { key: i === 0 ? rootId : `${rootId}#${i}`, rootId, orders: part, payable, totalSen: payable.reduce((s, o) => s + o.totalSen, 0), stage, rootGone, part: i + 1, parts: parts.length };
    });
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
  extraOnly?: boolean;
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
        extraOnly: Boolean(o.extraOnly),
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
    return { orders, totalSen: orders.reduce((s, o) => (o.stage === 'cancel_pending' ? s : s + o.totalSen), 0), fromCache: q.fromCache };
    // nameOf 只是显示名称，随菜单变化；不作为依赖避免每次渲染重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, q.fromCache, rt.outbox, rt.localOrders]);
}

/**
 * 「9 号刚出餐，已经自动记收款」：送餐的人可能已经收过这一碗，不要再收。
 * remaining 是按最新数据重算的、这桌还要收的单（不含刚被自动记的那张）；按钮只是让员工自己确认，不会自动收。
 */
export function PaidAtServeNotice({ conflict, remaining, busy, onConfirm, onDismiss }: {
  conflict: PaidAtServeConflict;
  remaining: { orderId: string; amountSen: Sen; label?: string }[];
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const tr = useT();
  const restSen = remaining.reduce((s, o) => s + o.amountSen, 0);
  const labels = remaining.map((o) => o.label).filter(Boolean).join('、');
  return (
    <div role="alert" className="mt-3 rounded-xl border-2 border-danger bg-card p-3 text-left">
      <b className="text-lg text-danger">{paidAtServeTitle(conflict)}</b>
      <p className="mt-1 text-sm">
        {tr(`送餐的人可能已经收过 ${formatRM(conflict.paidSen)}，`, `The server may already have collected ${formatRM(conflict.paidSen)} — `)}
        <b>{tr('不要再收这一碗', 'do not collect this bowl again')}</b>{tr('。', '. ')}
        {remaining.length > 0
          ? <>{tr('这桌还要收 ', 'This table still owes ')}<b className="tabular-nums">{formatRM(restSen)}</b>{labels ? tr(`（${labels}）`, ` (${labels})`) : ''}{tr('。', '.')}</>
          : tr('这桌不用再收了。', 'Nothing more to collect for this table.')}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {remaining.length > 0 && (
          <button type="button" disabled={busy} onClick={onConfirm} className="flex h-14 items-center gap-2 rounded-xl bg-ok px-4 font-bold text-white disabled:bg-control">
            <Icon name="check" size={22} />{busy ? tr('正在登记…', 'Recording…') : tr(`按 ${formatRM(restSen)} 确认已收款`, `Confirm ${formatRM(restSen)} received`)}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onDismiss} className="h-14 rounded-xl border border-line px-4 font-semibold">{remaining.length > 0 ? tr('先不收', 'Not now') : tr('知道了', 'Got it')}</button>
      </div>
    </div>
  );
}

/** 一张待收款卡（单张订单，或原单 + 加单一组）：主按钮登记这张卡上现在能收的单；成功后显示明确反馈。 */
export function PaymentCard({ group, onRecorded, onAddOn, onExtra }: { group: UnpaidGroup; onRecorded?: (ids: string[]) => void; onAddOn?: (order: UnpaidOrder) => void; onExtra?: (order: UnpaidOrder) => void }) {
  const tr = useT();
  const record = useRecordPayments();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [qr, setQr] = useState(false);
  // 本卡刚登记的单仍留在卡上显示；之后若有取消被后厨拒绝，那张单回到能收，只收它。
  const [recordedIds, setRecordedIds] = useState<string[]>([]);
  // 点收款时刚被后厨出餐自动记了的单：马上不算要收（订阅稍后也会把它移走），并显示拦截说明。
  const [atServe, setAtServe] = useState<PaidAtServeConflict | null>(null);
  const [servedPaidIds, setServedPaidIds] = useState<string[]>([]);
  const due = group.payable.filter((o) => !recordedIds.includes(o.id) && !servedPaidIds.includes(o.id));
  const dueSen = due.reduce((s, o) => s + o.totalSen, 0);
  const multi = group.orders.length > 1;
  const first = group.orders[0];
  const head = due[0] ?? first;
  // 取消待确认的单不能加料，面板里也没有它。
  const extraOrder = group.orders.find((o) => !o.extraOnly && o.stage !== 'cancel_pending');
  const stageText = (s: UnpaidOrder['stage']) => s === 'served' ? tr('已出餐 · 未收款', 'Served · unpaid')
    : s === 'cancel_pending' ? tr('取消待后厨确认，不计', 'Cancel pending · not counted') : tr('制作中 · 未收款', 'Cooking · unpaid');

  async function confirm() {
    if (busy || due.length === 0) return;
    setBusy(true);
    setMsg(null);
    const r = await record(due.map((o) => ({ orderId: o.id, amountSen: o.totalSen })));
    setBusy(false);
    if (!r.ok && r.paidAtServe) {
      const hit = r.paidAtServe;
      setServedPaidIds((prev) => [...prev, hit.orderId]);
      setAtServe(hit);
      // 让抽屉把这张卡留在原位（订阅会把已收款的单移走），员工才看得到说明。
      onRecorded?.([hit.orderId]);
      return;
    }
    setAtServe(null);
    if (r.ok) {
      const ids = due.map((o) => o.id);
      setRecordedIds((prev) => [...prev, ...ids]);
      onRecorded?.(ids);
      setMsg({ ok: true, text: r.alreadyRecorded ? tr('这张单之前已登记收款', 'Already recorded earlier')
        : r.offline ? tr(`已登记收款 ${formatRM(dueSen)}（本机保存，联网后同步）`, `Recorded ${formatRM(dueSen)} (saved here, will sync)`)
        : due.length > 1 ? tr(`已登记收款 ${formatRM(dueSen)}（${due.length} 张单一起）`, `Recorded ${formatRM(dueSen)} (${due.length} orders)`)
        : tr(`已登记收款 ${formatRM(dueSen)}`, `Recorded ${formatRM(dueSen)}`) });
    } else {
      setMsg({ ok: false, text: r.message });
    }
  }

  return (
    <li className={`rounded-2xl border p-3 ${group.stage === 'served' ? 'border-warn/50 bg-warn-bg/40' : 'border-line bg-card'}`} data-order-id={first.id}>
      {group.payable.length > 1 && (
        <p className="mb-2 text-sm font-semibold text-brand">{group.payable.some((o) => o.id === group.rootId)
          ? tr(`原单 + 加单 · ${group.payable.length} 张单一起结账`, `Order + add-on · ${group.payable.length} orders, one payment`)
          : tr(`加单 · ${group.payable.length} 张单一起结账`, `Add-ons · ${group.payable.length} orders, one payment`)}</p>
      )}
      {group.rootGone && <p className="mb-2 text-sm font-semibold text-brand">{tr('这桌前面的单已结清或已取消，这里只收还没收的', "This table's earlier order is settled or cancelled; this collects only what is still unpaid")}</p>}
      {group.parts > 1 && <p className="mb-2 text-sm font-semibold text-warn">{tr(`这桌单太多，要分开确认：第 ${group.part} / ${group.parts} 张卡`, `Too many orders for one payment: card ${group.part} of ${group.parts}`)}</p>}
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
                  {servedPaidIds.includes(order.id)
                    ? <span className="ml-auto rounded-lg bg-[#e2eaf7] px-2 py-0.5 text-sm font-semibold text-[#2f4f86]">{tr('出餐已记收款', 'Recorded at serve')}</span>
                    : <span className={`ml-auto rounded-lg px-2 py-0.5 text-sm font-semibold ${order.stage === 'served' ? 'bg-warn-bg text-warn' : 'bg-subtle text-ink-2'}`}>{stageText(order.stage)}</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm">{items}{multi && <b className={`ml-2 tabular-nums ${order.stage === 'cancel_pending' ? 'font-normal text-ink-2 line-through' : ''}`}>{formatRM(order.totalSen)}</b>}</p>
              </div>
            </div>
          );
        })}
      </div>
      {msg && (
        <p role="status" className={`mt-3 flex min-h-14 items-center gap-2 rounded-xl px-3 font-semibold ${msg.ok ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>
          {msg.ok && <Icon name="check" size={22} />}{msg.text}
        </p>
      )}
      {atServe && (
        <PaidAtServeNotice conflict={atServe} busy={busy} onConfirm={() => void confirm()} onDismiss={() => setAtServe(null)}
          remaining={due.map((o) => ({ orderId: o.id, amountSen: o.totalSen, label: o.items.map((i) => i.name).filter(Boolean).join('、') }))} />
      )}
      {/* 失败后留着按钮可重试（结果不明时重试只是核对原操作）；全部收完才收起。出餐自动记收款的拦截说明显示时，按钮在说明里。 */}
      {!atServe && (!msg?.ok || due.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void confirm()} disabled={busy || due.length === 0}
            className="flex h-14 min-w-[60%] flex-1 items-center justify-center gap-2 rounded-xl bg-ok px-3 text-lg font-bold text-white disabled:bg-control">
            <Icon name="check" size={24} />{busy ? tr('正在登记…', 'Recording…') : due.length === 0 ? tr('确认已收款', 'Confirm received') : tr(`确认已收款 ${formatRM(dueSen)}`, `Confirm received ${formatRM(dueSen)}`)}
          </button>
          {due.length > 0 && (
            <button type="button" onClick={() => setQr(true)} className="flex h-14 shrink-0 items-center gap-2 rounded-xl border border-line px-3 font-semibold">
              <Icon name="qr" size={22} />{tr('显示收款码', 'Show QR')}
            </button>
          )}
          {/* 客人吃完再加（多为打包）：回点餐页给同一组加一张新单，最后一起结账。人工单（本机）不能加单；取消待确认的单不能当原单。 */}
          {onAddOn && due.length > 0 && !head.offline && (
            <button type="button" onClick={() => onAddOn(head)} className="flex h-14 shrink-0 items-center gap-2 rounded-xl border border-line px-3 font-semibold">
              <Icon name="bag" size={22} />{tr('加单', 'Add on')}
            </button>
          )}
          {onExtra && extraOrder && !extraOrder.offline && (
            <button type="button" onClick={() => onExtra(extraOrder)} className="flex h-14 shrink-0 items-center gap-2 rounded-xl border border-line px-3 font-semibold">
              <Icon name="plus" size={22} />{tr('加料', 'Extras')}
            </button>
          )}
        </div>
      )}
      {qr && due.length > 0 && <ReceivingQrDialog amountSen={dueSen} label={due.length > 1 ? tr(`${head.ticketNo} 等 ${due.length} 张 · 原餐牌 ${head.tokenNumber}`, `${head.ticketNo} +${due.length - 1} · token ${head.tokenNumber}`) : tr(`${head.ticketNo} · 原餐牌 ${head.tokenNumber}`, `${head.ticketNo} · token ${head.tokenNumber}`)} onClose={() => setQr(false)} />}
    </li>
  );
}

export function PendingPaymentsDrawer({ onClose, nameOf, onAddOn, onExtra }: { onClose: () => void; nameOf?: (c: LineConfig) => string; onAddOn?: (order: UnpaidOrder) => void; onExtra?: (order: UnpaidOrder) => void }) {
  const tr = useT();
  const payOnServe = useSession().config?.payOnServe === true;
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
            <p className="text-sm text-ink-2">{payOnServe
              ? tr(`${orders.length} 单 · ${formatRM(totalSen)} · 出餐时自动记收款，这里只剩还没出餐的单；客人先付的收到钱后按订单确认。更新前已出餐的旧单确认一次就清掉`,
                `${orders.length} · ${formatRM(totalSen)} · served orders are recorded automatically, so only unserved ones stay here; confirm per order when a customer pays first. Older served orders from before the update need one confirmation`)
              : tr(`${orders.length} 单 · ${formatRM(totalSen)} · 收到钱后按订单确认，不选现金或 TNG`, `${orders.length} · ${formatRM(totalSen)} · confirm per order once collected; no cash/TNG choice`)}</p>
          </div>
          <button type="button" onClick={onClose} autoFocus className="flex h-14 items-center gap-1 rounded-xl border border-line px-4 font-semibold"><Icon name="close" size={20} />{tr('关闭', 'Close')}</button>
        </header>
        {fromCache && <p className="border-b border-warn/40 bg-warn-bg px-4 py-2 text-sm text-warn">{tr('画面可能不是最新（离线或缓存）；后厨在云端出餐的单，本机可能看不到。', 'May be out of date (offline/cache); orders served in the cloud may not show here.')}</p>}
        <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {groups.length === 0 && <li className="py-16 text-center text-ink-2">{tr('没有待登记收款的订单', 'Nothing to record')}</li>}
          {groups.map((g) => <PaymentCard key={g.key} group={g} onRecorded={keep} onAddOn={onAddOn} onExtra={onExtra} />)}
        </ul>
      </div>
    </div>
  );
}

/**
 * 下单成功后的收款区：默认「待收款」。已收到钱可立即确认（与出餐后补登记同一条收款逻辑，
 * 不重新下单、不重发厨单、不重复分配成本）；不强迫每张单都进入收款步骤。
 * more：这桌超过单次上限、这次没算进来的单数（还在「待登记收款」里）。
 * 门店开了「出餐即记收款」时提醒：客人现在付就一定要点确认，否则后厨卡片会显示要收钱；吃完再付的不用点。
 */
export function QuickPay({ orders, label, paid, paidSen, more = 0 }: { orders: { orderId: string; amountSen: Sen }[]; label: string; paid: boolean; paidSen?: Sen; more?: number }) {
  const tr = useT();
  const payOnServe = useSession().config?.payOnServe === true;
  const record = useRecordPayments();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [qr, setQr] = useState(false);
  // 点收款时刚被后厨出餐自动记了的单：立即不算要收，并拦下说明（父组件的列表稍后也会刷新掉它）。
  const [atServe, setAtServe] = useState<PaidAtServeConflict | null>(null);
  const [servedPaidIds, setServedPaidIds] = useState<string[]>([]);
  const due = orders.filter((o) => !servedPaidIds.includes(o.orderId));
  const totalSen = due.reduce((s, o) => s + o.amountSen, 0);

  async function pay() {
    if (busy || due.length === 0) return;
    setBusy(true);
    const r = await record(due);
    setBusy(false);
    if (!r.ok && r.paidAtServe) {
      const hit = r.paidAtServe;
      setServedPaidIds((prev) => [...prev, hit.orderId]);
      setAtServe(hit);
      setMsg(null);
      return;
    }
    setAtServe(null);
    setMsg(r.ok
      ? { ok: true, text: r.alreadyRecorded ? tr('这张单之前已登记收款', 'Already recorded earlier') : r.offline ? tr(`已登记收款 ${formatRM(totalSen)}（本机保存）`, `Recorded ${formatRM(totalSen)} (saved here)`) : tr(`已登记收款 ${formatRM(totalSen)}`, `Recorded ${formatRM(totalSen)}`) }
      : { ok: false, text: r.message });
  }

  if (atServe) {
    return <PaidAtServeNotice conflict={atServe} busy={busy} remaining={due} onConfirm={() => void pay()} onDismiss={() => setAtServe(null)} />;
  }
  if (paid || msg?.ok) {
    return (
      <p role="status" className="mt-4 flex min-h-14 items-center justify-center gap-2 rounded-xl bg-ok-bg px-3 font-semibold text-ok">
        <Icon name="check" size={22} />{msg?.text ?? tr(`已收款 ${formatRM(paidSen ?? totalSen)}`, `Paid ${formatRM(paidSen ?? totalSen)}`)}
      </p>
    );
  }
  if (due.length === 0) {
    // 只剩刚被出餐自动记了的单：不用再收。
    return <p role="status" className="mt-4 rounded-xl bg-[#e2eaf7] px-3 py-3 text-center font-semibold text-[#2f4f86]">{tr('出餐已记收款，不用再收', 'Recorded at serve — nothing more to collect')}</p>;
  }
  return (
    <div className="mt-4 rounded-xl border border-line bg-canvas p-3">
      <p className="font-semibold">{tr(`待收款 ${formatRM(totalSen)}`, `Unpaid ${formatRM(totalSen)}`)}{due.length > 1 && <span className="ml-2 text-sm font-semibold text-brand">{tr(`这桌 ${due.length} 张一起`, `${due.length} orders together`)}</span>}{!payOnServe && <span className="ml-2 text-sm font-normal text-ink-2">{tr('可先送餐，收到钱后再登记', 'Serve first; record when collected')}</span>}</p>
      {payOnServe && (
        <p className="mt-1 text-sm text-ink">
          <b>{tr('客人现在就付钱，一定要点「确认已收款」', 'If the customer pays now, you must tap “Confirm received”')}</b>
          {tr('，否则后厨会显示要收钱。吃完再付的不用点，出餐时自动记收款。', ' — otherwise the kitchen will show it as still to collect. If they pay after eating, skip it: payment is recorded automatically at serve.')}
        </p>
      )}
      {more > 0 && <p className="mt-1 text-sm font-semibold text-warn">{tr(`这桌还有 ${more} 张单没算进来，到「待登记收款」继续收`, `${more} more order(s) for this table are not included; collect them under “To record”`)}</p>}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button type="button" disabled={busy} onClick={() => void pay()} className="flex h-14 items-center gap-2 rounded-xl bg-ok px-5 font-bold text-white disabled:bg-control">
          <Icon name="check" size={22} />{busy ? tr('正在登记…', 'Recording…') : tr(`确认已收款 ${formatRM(totalSen)}`, `Confirm received ${formatRM(totalSen)}`)}
        </button>
        <button type="button" onClick={() => setQr(true)} className="flex h-14 items-center gap-2 rounded-xl border border-line px-4 font-semibold"><Icon name="qr" size={22} />{tr('显示收款码', 'Show QR')}</button>
      </div>
      {msg && !msg.ok && <p role="alert" className="mt-2 text-sm text-danger">{msg.text}</p>}
      {qr && <ReceivingQrDialog amountSen={totalSen} label={label} onClose={() => setQr(false)} />}
    </div>
  );
}
