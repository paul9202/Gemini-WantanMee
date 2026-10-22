/**
 * POS 点单页：同一画布完成常规点单（02 §4）；指定主收银机断网时本机接单（01 §7）。
 * 接单进度只显示有依据的事实：本机已记录 → 云端已接单 → 后厨已收到；
 * 断网时只完成第一步，后两步明确显示「未同步」与「请人工传单」。
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { BOM_V1 } from '../../domain/bom';
import { addLine, Cart, computeTotals, emptyCart, setLineQuantity, setServiceMode, updateLineConfig } from '../../domain/cart';
import { defaultConfig, LineConfig } from '../../domain/lineItem';
import { formatRM, parseRMInput } from '../../domain/money';
import { manualStatus, OfflineEvent, offlineReceiptNumber, overlayLocalTokens } from '../../domain/offline';
import { createTokenBoard, countTokens, suggestNextToken, TokenBoard, TokenStateName } from '../../domain/tokens';
import { formatClock } from '../../domain/timing';
import { AckState, ackState, kitchenHealth } from '../../domain/kitchenLink';
import { useHeartbeat } from '../../data/heartbeat';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useLiveDoc, useLiveQuery, useNow, useOnline } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { commitOfflineOrder, kvGet, kvSet, PendingOp, putPendingOp, seqKey } from '../../data/local/idb';
import { useWriterLock } from '../../data/local/writerLock';
import {
  appendManualEvent, recordServerOffset, reloadLocal, serverNow, saveSnapshot, setManualOffline, syncNow, unresolvedOps, unsyncedEvents, useOfflineRuntime, voidRejectedSequence,
} from '../../data/offline/runtime';
import { useRegister } from '../../data/register';
import { menuForVersion, useMenu } from '../../data/menu';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { Icon } from '../../ui/visual';
import { useT } from '../../app/i18n';
import { CartPanel } from './CartPanel';
import { PaymentDrawer, PaymentInput } from './PaymentDrawer';
import { ProductPanel } from './ProductPanel';
import { TokenPicker } from './TokenPicker';
import { ReceiptDialog, receiptFromLocal, receiptFromOrder } from '../receipt/ReceiptDialog';
import type { ReceiptSource } from '../../domain/receipt';

interface CreateOrderResult {
  orderId: string;
  receiptNumber: string;
  tokenNumber: number;
  totalSen: number;
  changeSen: number | null;
  acceptedAtMs: number;
  replayed?: boolean;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'submitting' }
  | { kind: 'accepted'; result: CreateOrderResult; method: string }
  | { kind: 'local_accepted'; clientOrderId: string; offlineReceiptNumber: string; tokenNumber: number; totalSen: number; changeSen: number | null }
  | { kind: 'rejected'; reason: string; code: string }
  | { kind: 'unknown'; operationId: string }
  | { kind: 'local_failed'; message: string };

export function PosPage() {
  const { config, member, user, deviceId, usingSnapshot } = useSession();
  const reg = useRegister();
  const browserOnline = useOnline();
  const rt = useOfflineRuntime();
  const offlineMode = !browserOnline || rt.manualOffline;
  const writer = useWriterLock(true);
  const tr = useT();
  useHeartbeat(deviceId, !offlineMode);
  const opsStatus = useLiveDoc<{ kitchenLastSeenAtMs?: number }>(storePath('operationsStatus/current'));
  const menu = useMenu(config?.activeMenuVersion);

  const tokensQ = useLiveQuery<{ number: number; state: TokenStateName; orderId: string | null; version: number }>(collection(db, storePath('tokens')), 'tokens');
  const tokensFromServer = !tokensQ.fromCache && tokensQ.data.length > 0;
  const unsynced = unsyncedEvents(rt);
  const unresolved = unresolvedOps(rt);
  // 本机餐牌视图：服务器餐牌（断网时用最后快照）+ 尚未被服务器接纳的本机事件。
  const board: TokenBoard = useMemo(() => {
    let base = createTokenBoard();
    if (tokensFromServer || !rt.snapshot) for (const t of tokensQ.data) base[t.number] = { number: t.number, state: t.state, orderId: t.orderId, version: t.version };
    else base = { ...rt.snapshot.tokens };
    return overlayLocalTokens(base, unsynced.map((r) => r.event));
  }, [tokensQ.data, tokensFromServer, rt.snapshot, unsynced]);
  const queueQ = useLiveQuery<{ fulfillmentStatus: string; acceptedAtEffectiveMs: number }>(
    query(collection(db, storePath('kitchenTickets')), where('kitchenRouting', '==', 'digital'), where('fulfillmentStatus', 'in', ['queued', 'preparing'])),
    'pos-queue',
  );

  const [cart, setCart] = useState<Cart>(emptyCart());
  const [draft, setDraft] = useState<LineConfig | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ cart: Cart; label: string } | null>(null);
  const [token, setToken] = useState<number | null>(null);
  const [lastIssued, setLastIssued] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 窄屏（<1024）本单收起为底部条，点开后全屏显示。
  const [cartOpen, setCartOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ key: string; load: () => Promise<ReceiptSource> } | null>(null);

  useEffect(() => {
    if (menu && !draft) setDraft(defaultConfig(menu, 'dry_noodle', 'black'));
  }, [menu, draft]);
  // 上一次发出的牌号存本机，页面切换或刷新后仍按顺序循环建议。
  useEffect(() => {
    void kvGet<number>('lastIssuedToken').then((n) => {
      if (!n) return;
      setLastIssued(n);
      setToken(null);
    });
  }, []);
  const rememberIssued = (n: number) => {
    setLastIssued(n);
    void kvSet('lastIssuedToken', n);
  };
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);

  // 当前牌失效（被占用）或未选时，循环建议下一个可用牌；只建议，不抢占。
  useEffect(() => {
    if (tokensQ.loading && !rt.snapshot) return;
    if (token === null || board[token]?.state !== 'available') setToken(suggestNextToken(board, lastIssued));
  }, [board, token, lastIssued, tokensQ.loading, rt.snapshot]);

  // 联网且数据来自服务器时，持续保存离线营业快照（开档时的「离线可用」准备）。
  useEffect(() => {
    if (offlineMode || usingSnapshot || reg.fromSnapshot || reg.status !== 'ready' || !tokensFromServer) return;
    if (!user || !member || !config || !deviceId || !reg.claim || !reg.shiftId || !reg.shift) return;
    const tokens: TokenBoard = {};
    for (const t of tokensQ.data) tokens[t.number] = { number: t.number, state: t.state, orderId: t.orderId, version: t.version };
    void saveSnapshot({
      uid: user.uid, member, config, deviceId, claim: reg.claim, shiftId: reg.shiftId, shift: reg.shift, serverApplied: reg.serverApplied,
      tokens, serverOffsetMs: rt.snapshot?.serverOffsetMs ?? 0, savedAtMs: Date.now(),
    });
    // 只在服务器数据变化时保存。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineMode, usingSnapshot, reg.status, reg.serverApplied, reg.shiftId, reg.claim?.registerEpoch, tokensFromServer, tokensQ.data, config, member]);

  const lastOrder = useLiveDoc<{ kitchenAckAtMs: number | null; fulfillmentStatus: string; manualHandoffAtMs?: number | null }>(
    stage.kind === 'accepted' ? storePath(`orders/${stage.result.orderId}`) : null,
  );

  if (!menu || !config || !draft) return <p className="p-6">{tr('正在载入菜单…', 'Loading menu…')}</p>;
  if (reg.status !== 'ready') return <RegisterGate status={reg.status} isOwner={member?.role === 'owner'} />;

  const totals = computeTotals(menu, BOM_V1, cart);
  const counts = countTokens(board);
  const busy = stage.kind === 'saving' || stage.kind === 'submitting';
  const blockingOnline = unresolved.filter((o) => o.status === 'not_found');

  const payDisabledReason = writer !== 'held' ? tr('另一个标签页正在收银，这里只能查看', 'Another tab is the register — view only here')
    : cart.lines.length === 0 ? tr('先加入餐品', 'Add an item first')
    : token === null ? tr('没有可用餐牌，请先回收餐牌', 'No free token — collect tokens first')
    : !offlineMode && blockingOnline.length > 0 ? tr('有收款待你决定处理方式，请先到「同步」页处理', 'A payment needs your decision — open Sync first')
    : null;

  function addOrSave() {
    if (!draft || !menu) return;
    if (editingLineId) {
      setCart(updateLineConfig(menu, cart, editingLineId, draft));
      setEditingLineId(null);
    } else {
      setUndo({ cart, label: tr('已加入本单', 'Added') });
      setCart(addLine(menu, cart, draft, crypto.randomUUID()));
    }
    // 每次加入后特殊选项归默认，防止上一位顾客的走青或 Kosong 残留；保留所选餐品与面种。
    const keep = defaultConfig(menu, draft.productKind, draft.sauce);
    setDraft({ ...keep, noodleType: keep.noodleType ? draft.noodleType : null });
    if (stage.kind !== 'idle' && !busy) setStage({ kind: 'idle' });
  }

  function changeQuantity(lineId: string, q: number) {
    if (q > 50) return;
    if (q === 0) setUndo({ cart, label: tr('已移除一行', 'Removed') });
    setCart(setLineQuantity(cart, lineId, q));
    if (q === 0 && editingLineId === lineId) setEditingLineId(null);
  }

  function clearAfterAccept(tokenNumber: number) {
    rememberIssued(tokenNumber);
    setToken(null);
    setCart(emptyCart(cart.serviceMode));
    setEditingLineId(null);
    setUndo(null);
    setPayOpen(false);
  }

  const lines = () => cart.lines.map((l) => ({ lineId: l.lineId, config: l.config, quantity: l.quantity }));

  /** 断网：订单、收款事实、占牌、日志、序号在同一个 IndexedDB 事务里提交。 */
  async function confirmOffline(p: PaymentInput) {
    if (!menu || !reg.claim || !reg.shiftId || token === null) return;
    const claim = reg.claim;
    const clientOrderId = crypto.randomUUID();
    const changeSen = p.method === 'cash' && p.tenderedSen !== null ? p.tenderedSen - totals.totalSen : null;
    setStage({ kind: 'saving' });
    try {
      const { order } = await commitOfflineOrder(seqKey(claim.registerId, claim.registerEpoch), reg.serverApplied, (sequence) => {
        const payload = {
          clientOrderId, offlineReceiptNumber: offlineReceiptNumber(claim.registerId, sequence), tokenNumber: token, serviceMode: cart.serviceMode,
          menuVersion: menu.version, lines: lines(), totalSen: totals.totalSen,
          payment: { method: p.method, tenderedSen: p.tenderedSen, qrExternalVerificationNote: p.qrExternalVerificationNote },
        };
        const event: OfflineEvent = {
          eventId: crypto.randomUUID(), ...claim, sequence, shiftId: reg.shiftId!, occurredAtDeviceMs: Date.now(),
          lastServerOffsetMs: rt.snapshot?.serverOffsetMs ?? 0, type: 'offline_order_created', payload,
        };
        return { event, order: { ...payload, sequence, createdAtMs: Date.now(), changeSen } };
      });
      await reloadLocal();
      setStage({ kind: 'local_accepted', clientOrderId, offlineReceiptNumber: order.offlineReceiptNumber, tokenNumber: token, totalSen: totals.totalSen, changeSen });
      clearAfterAccept(token);
    } catch (e) {
      setStage({ kind: 'local_failed', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 人工交接 / 人工出餐 / 餐牌回收：追加不可变本机事件。 */
  const appendManual = (type: 'manual_handoff' | 'manual_served' | 'token_returned', clientOrderId: string, tokenNumber?: number) =>
    reg.claim && reg.shiftId
      ? appendManualEvent({ claim: reg.claim, shiftId: reg.shiftId, serverApplied: reg.serverApplied }, type, clientOrderId, tokenNumber)
      : Promise.resolve('收银机未就绪');

  async function confirmOnline(p: PaymentInput) {
    if (!menu || !reg.claim || !reg.shiftId || token === null) return;
    // 先补传离线日志，保证序号连续。
    if (unsynced.length) {
      setStage({ kind: 'submitting' });
      await syncNow();
      await reloadLocal();
    }
    const claim = reg.claim;
    const sequence = await reg.allocate();
    const operationId = newOperationId();
    const clientOrderId = crypto.randomUUID();
    const payload = {
      operationId, ...claim, sequence, shiftId: reg.shiftId,
      order: { clientOrderId, tokenNumber: token, serviceMode: cart.serviceMode, menuVersion: menu.version, lines: lines(), expectedTotalSen: totals.totalSen, deviceAcceptedAtMs: Date.now() },
      payment: { method: p.method, tenderedSen: p.tenderedSen, qrConfirmed: p.qrConfirmed },
    };
    const op: PendingOp = {
      operationId, name: 'createOrder', payload, status: 'submitting', createdAtMs: Date.now(), updatedAtMs: Date.now(),
      summary: { tokenNumber: token, totalSen: totals.totalSen, method: p.method, tenderedSen: p.tenderedSen },
    };
    setStage({ kind: 'saving' });
    try {
      await putPendingOp(op);
    } catch (e) {
      setStage({ kind: 'local_failed', message: e instanceof Error ? e.message : String(e) });
      return; // 不清空购物车，不声称成功
    }
    setStage({ kind: 'submitting' });
    const sentAt = Date.now();
    try {
      const result = await submit<CreateOrderResult>('createOrder', payload);
      await putPendingOp({ ...op, status: 'accepted', result: { ...result }, updatedAtMs: Date.now() });
      if (!result.replayed) void recordServerOffset(result.acceptedAtMs - (sentAt + Date.now()) / 2);
      setStage({ kind: 'accepted', result, method: p.method });
      clearAfterAccept(result.tokenNumber);
    } catch (e) {
      const f = e instanceof CommandFailure ? e : new CommandFailure('unknown', 'UNKNOWN_RESULT', String(e));
      if (f.kind === 'rejected') {
        await putPendingOp({ ...op, status: 'rejected', reasonCode: f.reasonCode, updatedAtMs: Date.now() });
        await voidRejectedSequence({ operationId, clientOrderId, sequence }, claim, reg.shiftId);
        setStage({ kind: 'rejected', code: f.reasonCode, reason: reasonText(f.reasonCode) });
      } else {
        // 结果不明：保留原 ID，等待核对；绝不改成新的人工单。
        await putPendingOp({ ...op, status: 'unknown_result', updatedAtMs: Date.now() });
        setStage({ kind: 'unknown', operationId });
        setPayOpen(false);
      }
    }
    await reloadLocal();
  }

  async function releaseTokenAction(n: number, orderId: string): Promise<string | null> {
    if (!reg.claim || !reg.shiftId) return '收银机未就绪';
    const localUnsynced = rt.localOrders.some((o) => o.clientOrderId === orderId)
      && !rt.outbox.some((r) => r.event.type === 'offline_order_created' && r.event.payload.clientOrderId === orderId && r.status === 'accepted');
    if (offlineMode || localUnsynced) return appendManual('token_returned', orderId, n);
    if (unsynced.length) await syncNow();
    const sequence = await reg.allocate();
    const operationId = newOperationId();
    try {
      await submit('releaseToken', { operationId, ...reg.claim, sequence, tokenNumber: n, orderId });
      return null;
    } catch (e) {
      if (e instanceof CommandFailure && e.kind === 'rejected') await voidRejectedSequence({ operationId, clientOrderId: orderId, sequence }, reg.claim, reg.shiftId);
      return e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e);
    } finally {
      await reloadLocal();
    }
  }

  const oldest = queueQ.data.reduce((m, t) => Math.min(m, t.acceptedAtEffectiveMs), Infinity);
  const unknownOps = unresolved.filter((o) => o.status !== 'not_found');
  const reviewCount = rt.outbox.filter((r) => r.status === 'needs_review' || r.status === 'rejected').length;
  const handedOff = stage.kind === 'local_accepted' && manualStatus(rt.outbox.map((r) => r.event), stage.clientOrderId).handedOff;

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {offlineMode && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b-2 border-warn bg-warn-bg px-4 py-2 text-warn">
          <Icon name="handoff" size={36} />
          <div className="min-w-0 flex-1">
            <b className="text-lg">{tr(`离线营业 · 仅本机保存 · 未同步 ${unsynced.length} 条`, `Offline · saved on this device only · ${unsynced.length} not synced`)}</b>
            <div className="text-sm">{tr('后厨屏不会自动收到，请把纸单递给厨师（人工传单）。', 'The kitchen screen will not get these — hand the paper ticket to the cook. ')}{reg.fromSnapshot ? `${tr('离线营业资格到', 'Offline allowed until')} ${new Date(reg.shift!.offlineCapabilityExpiresAtMs).toLocaleString('zh-CN', { hour12: false })}` : ''}</div>
          </div>
          {rt.manualOffline && browserOnline && (
            <button type="button" onClick={() => void setManualOffline(false).then(() => syncNow())} className="h-11 rounded-lg border border-warn bg-card px-3 font-semibold">{tr('恢复在线', 'Back online')}</button>
          )}
          <button type="button" onClick={() => navigate('/sync')} className="h-11 rounded-lg bg-warn px-4 font-bold text-white">{tr('同步中心', 'Sync')}</button>
        </div>
      )}
      {!offlineMode && (unsynced.length > 0 || reviewCount > 0 || rt.syncing) && (
        <div role="status" className="flex flex-wrap items-center gap-3 border-b border-warn bg-warn-bg px-4 py-2 text-warn">
          <b>{rt.syncing ? tr('正在补同步本机记录…', 'Syncing local records…') : tr(`本机还有 ${unsynced.length} 条未同步`, `${unsynced.length} local record(s) not synced`)}{reviewCount ? tr(` · ${reviewCount} 条待老板核对`, ` · ${reviewCount} need owner review`) : ''}</b>
          <button type="button" onClick={() => navigate('/sync')} className="ml-auto h-10 rounded-lg border border-warn bg-card px-3 font-semibold">{tr('同步中心', 'Sync')}</button>
        </div>
      )}
      {writer === 'busy' && <div role="alert" className="border-b border-danger bg-danger-bg px-4 py-2 font-semibold text-danger">{tr('另一个标签页正在收银。为避免重复记录，这个标签页只能查看。', 'Another tab is the register. This tab is view-only to avoid duplicates.')}</div>}

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas px-4 py-2">
        <div className="flex rounded-xl bg-subtle p-1" role="group" aria-label={tr('就餐方式', 'Service')}>
          {(['dine_in', 'takeaway'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={cart.serviceMode === m} onClick={() => setCart(setServiceMode(cart, m))}
              className={`flex h-12 items-center gap-2 rounded-lg px-4 text-lg font-bold ${cart.serviceMode === m ? 'bg-card shadow' : 'text-ink-2'}`}>
              <Icon name={m === 'dine_in' ? 'table' : 'bag'} size={30} />{m === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway')}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setPickerOpen(true)} className="flex h-14 items-center gap-3 rounded-xl border-2 border-control bg-card px-4">
          <span className="text-lg">{tr('餐牌', 'Token')}</span><b className="text-3xl tabular-nums">{token ?? tr('满', 'Full')}</b><span aria-hidden>▾</span>
        </button>
        <span className="rounded-lg bg-ok-bg px-2 py-1 text-sm font-semibold text-ok">{tr(`${counts.available}个可用`, `${counts.available} free`)}</span>
        {counts.awaiting_return > 0 && (
          <button type="button" onClick={() => setPickerOpen(true)} className="rounded-lg bg-warn-bg px-2 py-1 text-sm font-semibold text-warn">
            {tr(`${counts.awaiting_return}个待回收`, `${counts.awaiting_return} to collect`)}
          </button>
        )}
        {!tokensFromServer && <span className="text-sm text-warn">{tr('餐牌为本机记录', 'Tokens from this device')}{rt.snapshot ? `（快照 ${new Date(rt.snapshot.savedAtMs).toLocaleTimeString('zh-CN', { hour12: false })}）` : ''}</span>}
      </div>

      {(unknownOps.length > 0 || notice) && (
        <div className="space-y-2 border-b border-warn bg-warn-bg px-4 py-2" role="alert">
          {unknownOps.map((op) => (
            <div key={op.operationId} className="flex flex-wrap items-center gap-3 text-warn">
              <b>{tr(`${op.summary.tokenNumber}号 · ${formatRM(op.summary.totalSen)}：已记录收款，正在核对订单；请勿再次收钱。请问厨房是否收到这张单。`, `No. ${op.summary.tokenNumber} · ${formatRM(op.summary.totalSen)}: payment recorded, checking the order. Do NOT collect again. Ask the kitchen if they got it.`)}</b>
              {!offlineMode && <button type="button" onClick={() => void syncNow()} className="h-11 rounded-lg bg-warn px-4 font-bold text-white">{tr('核对结果', 'Check result')}</button>}
              {!offlineMode && <button type="button" onClick={() => void setManualOffline(true)} className="h-11 rounded-lg border border-warn bg-card px-3 font-semibold">云端连不上？改为离线营业</button>}
            </div>
          ))}
          {notice && (
            <div className="flex items-center gap-3 text-ink"><span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="ml-auto h-10 rounded-lg border border-control px-3">{tr('知道了', 'OK')}</button>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="min-h-0 flex-1 lg:flex-[62] lg:border-r lg:border-line">
          <ProductPanel menu={menu} config={draft} onChange={setDraft} editing={Boolean(editingLineId)} onSubmit={addOrSave}
            onCancelEdit={() => { setEditingLineId(null); setDraft(defaultConfig(menu, draft.productKind, draft.sauce)); }} />
        </section>
        <aside className={`${cartOpen ? 'fixed inset-x-0 top-16 bottom-0 z-30 flex' : 'hidden'} min-h-0 flex-col bg-card lg:static lg:z-auto lg:flex lg:max-w-[560px] lg:min-w-[340px] lg:flex-[38]`}>
          {cartOpen && (
            <button type="button" onClick={() => setCartOpen(false)} className="h-12 border-b border-line font-semibold text-ink-2 lg:hidden">{tr('▼ 收起本单，继续点餐', '▼ Hide order, keep ordering')}</button>
          )}
          <div className="min-h-0 flex-1">
            <CartPanel menu={menu} cart={cart} totals={totals} tokenNumber={token} editingLineId={editingLineId}
              onEdit={(id) => { const l = cart.lines.find((x) => x.lineId === id); if (l) { setEditingLineId(id); setDraft(l.config); setCartOpen(false); } }}
              onQuantity={changeQuantity} onPay={() => setPayOpen(true)} payDisabledReason={payDisabledReason}>
              <SubmitSteps stage={stage} kitchenAckAtMs={lastOrder.data?.kitchenAckAtMs ?? null} handedOff={handedOff}
                kitchenLastSeenMs={opsStatus.data?.kitchenLastSeenAtMs ?? null} offsetMs={rt.serverOffsetMs ?? rt.snapshot?.serverOffsetMs ?? 0}
                onlineHandoffAtMs={lastOrder.data?.manualHandoffAtMs ?? null}
                onReceipt={() => {
                  if (stage.kind === 'accepted') setReceipt({ key: stage.result.orderId, load: () => receiptFromOrder(stage.result.orderId, config.name) });
                  if (stage.kind === 'local_accepted') {
                    const id = stage.clientOrderId;
                    setReceipt({
                      key: id,
                      load: async () => {
                        const o = rt.localOrders.find((x) => x.clientOrderId === id);
                        if (!o) throw new Error('找不到本机订单');
                        const rec = rt.outbox.find((r) => r.event.type === 'offline_order_created' && r.event.payload.clientOrderId === id);
                        const soldMenu = await menuForVersion(o.menuVersion);
                        if (!soldMenu) throw new Error('本机没有这张单成交时的菜单版本');
                        return receiptFromLocal(o, soldMenu, config.name, { synced: rec?.status === 'accepted', receiptNumber: rec?.result?.receiptNumber ?? null, served: manualStatus(rt.outbox.map((r) => r.event), id).served });
                      },
                    });
                  }
                }}
                onOnlineHandoff={async () => {
                  if (stage.kind !== 'accepted') return;
                  try {
                    await submit('recordManualHandoff', { operationId: newOperationId(), orderId: stage.result.orderId, reason: '后厨屏未确认，收银已递纸单' });
                  } catch (e) {
                    setNotice(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
                  }
                }}
                onHandoff={async () => {
                  if (stage.kind !== 'local_accepted') return;
                  const err = await appendManual('manual_handoff', stage.clientOrderId);
                  if (err) setNotice(err);
                }} />
            </CartPanel>
          </div>
        </aside>
      </div>

      <div className="flex items-center gap-2 border-t border-line bg-card p-2 lg:hidden">
        <button type="button" onClick={() => setCartOpen(true)} aria-expanded={cartOpen} className="flex h-14 min-w-0 flex-1 items-center gap-2 rounded-xl border-2 border-control px-3 text-left">
          <span className="text-lg font-bold">{tr('本单', 'Order')} · {token ?? '—'}</span>
          <span className="text-ink-2">{tr(`${totals.portionCount}份`, `${totals.portionCount} pcs`)}</span>
          {stage.kind === 'accepted' && totals.portionCount === 0 && <span className="truncate text-sm text-ok">✓ {tr(`${stage.result.tokenNumber}号已接单`, `No. ${stage.result.tokenNumber} accepted`)}</span>}
          {stage.kind === 'local_accepted' && totals.portionCount === 0 && <span className="truncate text-sm text-warn">{tr('本机已接单 · 请人工传单', 'Saved here · hand ticket over')}</span>}
          <span className="ml-auto text-sm text-ink-2">{tr('查看 ▲', 'View ▲')}</span>
        </button>
        <button type="button" onClick={() => setPayOpen(true)} disabled={Boolean(payDisabledReason)}
          className="h-14 shrink-0 rounded-xl bg-brand px-4 text-lg font-bold text-white disabled:bg-control">{tr('收款', 'Pay')} {formatRM(totals.totalSen)}</button>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-card px-4 py-2 text-base">
        <Icon name="clock" size={20} />
        {offlineMode ? <span className="text-warn">{tr('断网中：厨房队列无法更新', 'Offline: kitchen queue not updating')}</span> : <span>{tr('厨房待做', 'Kitchen queue')} <b>{queueQ.data.length}</b> {tr('单', '')}</span>}
        {!offlineMode && <KitchenHealthBadge lastSeenMs={opsStatus.data?.kitchenLastSeenAtMs ?? null} />}
        {!offlineMode && Number.isFinite(oldest) && <QueueClock since={oldest} />}
        {undo && (
          <span className="ml-auto flex items-center gap-2 rounded-lg bg-subtle px-3 py-1">
            {undo.label}
            <button type="button" onClick={() => { setCart(undo.cart); setUndo(null); setEditingLineId(null); }} className="h-10 rounded-lg border border-control px-3 font-semibold">{tr('撤销', 'Undo')}</button>
          </span>
        )}
      </footer>

      {receipt && <ReceiptDialog receiptKey={receipt.key} load={receipt.load} menuVersion={menu.version} timeZone={config.timeZone} onClose={() => setReceipt(null)} />}
      {pickerOpen && <TokenPicker board={board} current={token} onPick={setToken} onRelease={releaseTokenAction} onClose={() => setPickerOpen(false)} />}
      {payOpen && token !== null && (
        <PaymentDrawer dueSen={totals.totalSen} tokenNumber={token} portions={totals.portionCount} serviceMode={cart.serviceMode}
          qrPayee={config.qrPayee} online={!offlineMode} busy={busy}
          onConfirm={(p) => void (offlineMode ? confirmOffline(p) : confirmOnline(p))}
          onClose={() => { setPayOpen(false); if (stage.kind === 'rejected') setStage({ kind: 'idle' }); }} />
      )}
      {payOpen && stage.kind === 'rejected' && (
        <div role="alert" className="fixed bottom-28 right-4 z-50 max-w-[440px] rounded-xl border-2 border-danger bg-danger-bg p-4 text-danger shadow-xl">
          <b>{tr('云端未接单：', 'Not accepted: ')}{stage.reason}</b>
          <p className="text-sm">{tr('这次没有生成订单。若已收钱，请勿再次收钱，修正后再提交。', 'No order was created. If you already took money, do not collect again — fix and resubmit.')}</p>
        </div>
      )}
    </div>
  );
}

function KitchenHealthBadge({ lastSeenMs }: { lastSeenMs: number | null }) {
  useNow(5000);
  const rt = useOfflineRuntime();
  const tr = useT();
  const h = kitchenHealth(lastSeenMs, serverNow(rt));
  if (h === 'online') return <span className="text-ok">· {tr('后厨屏在线', 'Kitchen online')}</span>;
  return <span className="font-semibold text-danger">· {h === 'unknown' ? tr('后厨屏未连接', 'Kitchen not connected') : tr(`后厨屏离线（最后 ${formatClock(serverNow(rt) - lastSeenMs!)} 前）`, `Kitchen offline (last seen ${formatClock(serverNow(rt) - lastSeenMs!)} ago)`)}</span>;
}

function QueueClock({ since }: { since: number }) {
  const now = useNow();
  const tr = useT();
  return <span>· {tr('最久', 'Longest')} <b>{formatClock(now - since)}</b></span>;
}

/**
 * 三个事实分别有依据才点亮：本机已记录（IndexedDB 事务完成）、云端已接单（服务器事务提交）、后厨已收到（KDS 回执）。
 * 断网接单只点亮第一步；后厨一步改为人工传单。
 */
function SubmitSteps({ stage, kitchenAckAtMs, handedOff, onHandoff, kitchenLastSeenMs, offsetMs, onlineHandoffAtMs, onOnlineHandoff, onReceipt }: {
  stage: Stage; kitchenAckAtMs: number | null; handedOff: boolean; onHandoff: () => void;
  kitchenLastSeenMs: number | null; offsetMs: number; onlineHandoffAtMs: number | null; onOnlineHandoff: () => void; onReceipt: () => void;
}) {
  const now = useNow(1000);
  const tr = useT();
  if (stage.kind === 'idle') return null;
  const ack: AckState | null = stage.kind === 'accepted'
    ? ackState({ acceptedAtMs: stage.result.acceptedAtMs, kitchenAckAtMs, nowServerMs: now + offsetMs, kitchenLastSeenMs })
    : null;
  const kitchenAck = ack === 'acked';
  const offline = stage.kind === 'local_accepted';
  const local = stage.kind !== 'saving' && stage.kind !== 'local_failed';
  const cloud = stage.kind === 'accepted';
  const steps: { label: string; done: boolean; icon: 'register' | 'cloud' | 'cook' | 'handoff'; warn?: boolean }[] = offline
    ? [
        { label: tr('本机已接单', 'Saved here'), done: true, icon: 'register' },
        { label: tr('云端未同步（断网）', 'Not synced (offline)'), done: false, icon: 'cloud', warn: true },
        { label: handedOff ? tr('已人工交接', 'Handed over') : tr('请人工传单', 'Hand ticket over'), done: handedOff, icon: 'handoff', warn: !handedOff },
      ]
    : [
        { label: tr('本机已记录', 'Saved here'), done: local, icon: 'register' },
        { label: tr('云端已接单', 'Accepted online'), done: cloud, icon: 'cloud' },
        {
          label: kitchenAck ? tr('后厨已收到', 'Kitchen got it') : ack === 'alarm' ? tr('后厨屏可能离线', 'Kitchen may be offline') : ack === 'waiting' ? tr('等待厨房确认', 'Waiting for kitchen') : tr('正在送到后厨', 'Sending to kitchen'),
          done: cloud && kitchenAck, icon: 'cook', warn: ack === 'waiting' || ack === 'alarm',
        },
      ];
  return (
    <div className="mt-3 rounded-xl bg-subtle p-3" aria-live="polite">
      <div className="flex items-center justify-between">
        {steps.map((s, i) => (
          <div key={s.label} className="flex flex-1 items-center">
            <div className={`flex flex-col items-center text-center text-sm ${s.done ? 'text-ok' : s.warn ? 'text-warn' : 'text-ink-2 opacity-60'}`}>
              <Icon name={s.icon} size={34} />
              <span className="font-semibold">{s.done ? '✓ ' : ''}{s.label}</span>
            </div>
            {i < 2 && <span className={`mx-1 flex-1 text-center ${offline && i === 0 ? 'text-warn' : 'text-ink-2'}`}>{offline && i === 0 ? '✕' : '→'}</span>}
          </div>
        ))}
      </div>
      {ack === 'alarm' && (
        <div role="alert" className="mt-2 rounded-lg border-2 border-danger bg-danger-bg p-2 text-center text-danger">
          <b>{tr('已超过 15 秒没有后厨回执，后厨屏可能离线。请把纸单递给厨师。', 'No kitchen receipt after 15 s — the kitchen screen may be offline. Hand the paper ticket to the cook.')}</b>
          {onlineHandoffAtMs
            ? <p className="mt-1 font-semibold">✓ {tr('已登记人工传单；后厨屏恢复后会看到提示，避免做两份。', 'Hand-over recorded; the kitchen screen will show it to avoid cooking twice.')}</p>
            : <button type="button" onClick={onOnlineHandoff} className="mt-2 inline-flex h-12 items-center gap-2 rounded-xl bg-danger px-4 font-bold text-white"><Icon name="handoff" size={28} />{tr('我已递纸单给厨师', 'I gave the ticket to the cook')}</button>}
        </div>
      )}
      {stage.kind === 'accepted' && (
        <p className="mt-2 text-center font-semibold">
          {tr(`${stage.result.tokenNumber}号 · 票号 ${stage.result.receiptNumber}`, `No. ${stage.result.tokenNumber} · receipt ${stage.result.receiptNumber}`)} · {formatRM(stage.result.totalSen)}
          {stage.result.changeSen !== null && stage.result.changeSen > 0 && <> · {tr('找零', 'change')} <span className="text-xl">{formatRM(stage.result.changeSen)}</span></>}
        </p>
      )}
      {offline && (
        <div className="mt-2 text-center">
          <p className="font-semibold">
            {tr(`${stage.tokenNumber}号 · 临时号 ${stage.offlineReceiptNumber}`, `No. ${stage.tokenNumber} · temp ${stage.offlineReceiptNumber}`)} · {formatRM(stage.totalSen)}
            {stage.changeSen !== null && stage.changeSen > 0 && <> · {tr('找零', 'change')} <span className="text-xl">{formatRM(stage.changeSen)}</span></>}
          </p>
          <p className="text-sm text-warn">{tr('已保存在本机；后厨屏不会收到。请把纸单递给厨师。', 'Saved on this device; the kitchen screen will not get it. Hand the ticket to the cook.')}</p>
          {!handedOff && (
            <button type="button" onClick={onHandoff} className="mt-2 inline-flex h-12 items-center gap-2 rounded-xl bg-warn px-4 font-bold text-white">
              <Icon name="handoff" size={28} />{tr('我已把单交给厨师', 'I handed it to the cook')}
            </button>
          )}
        </div>
      )}
      {(stage.kind === 'accepted' || offline) && (
        <div className="mt-2 text-center">
          <button type="button" onClick={onReceipt} className="h-11 rounded-lg border border-control bg-card px-4 font-semibold">{tr('收据', 'Receipt')}</button>
        </div>
      )}
      {stage.kind === 'submitting' && <p className="mt-2 text-center text-warn">{tr('正在提交，请勿重复收钱或重复点击。', 'Submitting — do not collect again or tap again.')}</p>}
      {stage.kind === 'unknown' && <p className="mt-2 text-center font-semibold text-warn">{tr('已记录收款，正在核对订单；请勿再次收钱。', 'Payment recorded, checking the order. Do NOT collect again.')}</p>}
      {stage.kind === 'local_failed' && <p className="mt-2 text-center font-semibold text-danger">{tr('本机保存失败，订单尚未确认', 'Could not save on this device — order not confirmed')}（{stage.message}）{tr('。购物车已保留。', '. Cart kept.')}</p>}
      {stage.kind === 'rejected' && <p className="mt-2 text-center font-semibold text-danger">{tr('云端未接单：', 'Not accepted: ')}{stage.reason}</p>}
    </div>
  );
}

/** 不是主收银机 / 未开班 / 离线资格过期时的说明页。 */
function RegisterGate({ status, isOwner }: { status: string; isOwner: boolean }) {
  const reg = useRegister();
  const [floatText, setFloatText] = useState('100');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tr = useT();
  if (status === 'loading') return <p className="p-6">{tr('正在检查收银机…', 'Checking register…')}</p>;
  if (status === 'offline_expired') {
    return (
      <div className="mx-auto mt-10 max-w-lg rounded-2xl border-2 border-danger bg-card p-6">
        <h2 className="text-2xl font-bold text-danger">{tr('离线营业资格已过期（超过 24 小时）', 'Offline allowance expired (over 24 h)')}</h2>
        <p className="mt-2">{tr('请改用纸单营业，并通知老板。已有的本机记录仍可在「同步」页查看和导出。', 'Use paper tickets and tell the owner. Existing records can still be viewed and exported in Sync.')}</p>
        <button type="button" onClick={() => navigate('/sync')} className="mt-4 h-14 rounded-xl bg-brand px-6 text-lg font-bold text-white">{tr('去同步中心', 'Open Sync')}</button>
      </div>
    );
  }
  if (status === 'not_configured' || status === 'not_this_device') {
    return (
      <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-line bg-card p-6">
        <Icon name="register" size={56} />
        <h2 className="mt-2 text-2xl font-bold">{tr('这台设备不是主收银机', 'This device is not the main register')}</h2>
        <p className="mt-2 text-ink-2">首版只允许一台指定收银设备接单。{isOwner ? '老板可以在「设备」页把这台设备设为主收银机。' : '请老板在这台设备上登录并指定。'}</p>
        {isOwner && <button type="button" onClick={() => navigate('/device')} className="mt-4 h-14 rounded-xl bg-brand px-6 text-lg font-bold text-white">{tr('去设备页', 'Open Device')}</button>}
      </div>
    );
  }
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-line bg-card p-6">
      <Icon name="cash" size={56} />
      <h2 className="mt-2 text-2xl font-bold">{tr('开班', 'Open shift')}</h2>
      <p className="mt-1 text-ink-2">{tr('点清钱箱里的备用金后开班。开班需要联网；开班后这台收银机断网也能接单（最多 24 小时）。', 'Count the float in the drawer, then open the shift. Needs internet; afterwards this register can take orders offline for up to 24 h.')}</p>
      <label className="mt-4 block font-semibold" htmlFor="float">{tr('备用金 (RM)', 'Float (RM)')}</label>
      <input id="float" inputMode="decimal" value={floatText} onChange={(e) => setFloatText(e.target.value)} className="mt-1 h-14 w-full rounded-lg border border-control px-3 text-2xl tabular-nums" />
      {err && <p role="alert" className="mt-2 text-danger">{err}</p>}
      <button type="button" disabled={busy || parseRMInput(floatText) === null || !reg.claim}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await submit('openShift', { operationId: newOperationId(), ...reg.claim!, openingFloatSen: parseRMInput(floatText)! });
          } catch (e) {
            setErr(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-4 h-14 w-full rounded-xl bg-brand text-lg font-bold text-white disabled:bg-control">{busy ? tr('正在开班…', 'Opening…') : tr('确认开班', 'Open shift')}</button>
    </div>
  );
}
