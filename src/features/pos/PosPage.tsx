/**
 * POS 点单页：同一画布完成常规点单（02 §4）；指定主收银机断网时本机接单（01 §7）。
 * 接单进度只显示有依据的事实：本机已记录 → 云端已接单 → 后厨已收到；
 * 断网时只完成第一步，后两步明确显示「未同步」与「请人工传单」。
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { BOM_V1 } from '../../domain/bom';
import { addLine, Cart, computeTotals, emptyCart, setLineQuantity, setServiceMode, updateLineConfig } from '../../domain/cart';
import { defaultConfig, LineConfig, normalizeConfig } from '../../domain/lineItem';
import { formatRM, parseRMInput } from '../../domain/money';
import { manualStatus, OfflineEvent, offlineReceiptNumber, overlayLocalTokens } from '../../domain/offline';
import { createTokenBoard, countTokens, suggestNextToken, TokenBoard, TokenStateName } from '../../domain/tokens';
import { formatClock } from '../../domain/timing';
import { kitchenHealth } from '../../domain/kitchenLink';
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
import { useLang, useT } from '../../app/i18n';
import { ShellHeaderActions } from '../../app/Shell';
import { lineName } from '../../domain/lineItem';
import { CartPanel } from './CartPanel';
import { Customizer } from './Customizer';
import { OrderResultDialog, RecentOrder, ResultStage, ResultSummary } from './OrderResult';
import { PaymentDrawer, PaymentInput } from './PaymentDrawer';
import { ProductGrid } from './ProductGrid';
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
  | { kind: 'accepted'; result: CreateOrderResult; summary: ResultSummary }
  | { kind: 'local_accepted'; clientOrderId: string; offlineReceiptNumber: string; tokenNumber: number; totalSen: number; changeSen: number | null; summary: ResultSummary }
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
  const lang = useLang();
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
  const [draftQty, setDraftQty] = useState(1);
  const [resultOpen, setResultOpen] = useState(false);
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
      setCart(addLine(menu, cart, draft, crypto.randomUUID(), draftQty));
      setDraftQty(1);
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

  function clearCart() {
    if (!cart.lines.length) return;
    setUndo({ cart, label: tr('已清空本单', 'Order cleared') });
    setCart(emptyCart(cart.serviceMode));
    setEditingLineId(null);
  }

  const summaryOf = (method: 'cash' | 'qr_manual'): ResultSummary => ({
    serviceMode: cart.serviceMode,
    method,
    firstItem: cart.lines.map((l) => `${lineName(menu, l.config, lang)}${l.quantity > 1 ? ` ×${l.quantity}` : ''}`).join('，'),
  });

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
      setStage({ kind: 'local_accepted', clientOrderId, offlineReceiptNumber: order.offlineReceiptNumber, tokenNumber: token, totalSen: totals.totalSen, changeSen, summary: summaryOf(p.method) });
      setResultOpen(true);
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
      setStage({ kind: 'accepted', result, summary: summaryOf(p.method) });
      setResultOpen(true);
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

  const resultStage: ResultStage | null = stage.kind === 'accepted'
    ? { kind: 'accepted', orderId: stage.result.orderId, receiptNumber: stage.result.receiptNumber, tokenNumber: stage.result.tokenNumber, totalSen: stage.result.totalSen, changeSen: stage.result.changeSen, acceptedAtMs: stage.result.acceptedAtMs, summary: stage.summary }
    : stage.kind === 'local_accepted'
      ? { kind: 'local_accepted', clientOrderId: stage.clientOrderId, offlineReceiptNumber: stage.offlineReceiptNumber, tokenNumber: stage.tokenNumber, totalSen: stage.totalSen, changeSen: stage.changeSen, summary: stage.summary }
      : null;
  const resultProps = resultStage && {
    stage: resultStage,
    kitchenAckAtMs: lastOrder.data?.kitchenAckAtMs ?? null,
    kitchenLastSeenMs: opsStatus.data?.kitchenLastSeenAtMs ?? null,
    offsetMs: rt.serverOffsetMs ?? rt.snapshot?.serverOffsetMs ?? 0,
    handedOff,
    onlineHandoffAtMs: lastOrder.data?.manualHandoffAtMs ?? null,
    onReceipt: () => {
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
    },
    onOnlineHandoff: async () => {
      if (stage.kind !== 'accepted') return;
      try {
        await submit('recordManualHandoff', { operationId: newOperationId(), orderId: stage.result.orderId, reason: '后厨屏未确认，收银已递纸单' });
      } catch (e) {
        setNotice(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
      }
    },
    onHandoff: async () => {
      if (stage.kind !== 'local_accepted') return;
      const err = await appendManual('manual_handoff', stage.clientOrderId);
      if (err) setNotice(err);
    },
  };
  const payError = stage.kind === 'local_failed'
    ? `${tr('本机保存失败，订单尚未确认', 'Could not save on this device — order not confirmed')}（${stage.message}）${tr('。本单已保留。', '. Order kept.')}`
    : null;
  const editLine = (id: string) => {
    const l = cart.lines.find((x) => x.lineId === id);
    if (!l) return;
    setEditingLineId(id);
    setDraft(l.config);
    setCartOpen(false);
  };

  return (
    <div className="flex h-full flex-col">
      <ShellHeaderActions>
        <div className="flex rounded-2xl bg-subtle p-1" role="group" aria-label={tr('就餐方式', 'Service')}>
          {(['dine_in', 'takeaway'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={cart.serviceMode === m} onClick={() => setCart(setServiceMode(cart, m))}
              className={`flex h-14 items-center gap-2 rounded-xl px-3 text-lg font-bold xl:px-4 ${cart.serviceMode === m ? 'bg-card shadow' : 'text-ink-2'}`}>
              <Icon name={m === 'dine_in' ? 'table' : 'bag'} size={28} />{m === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway')}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setPickerOpen(true)} aria-haspopup="dialog" className="flex h-14 shrink-0 items-center gap-2.5 rounded-2xl border border-line bg-card px-3 xl:gap-3 xl:px-4">
          <span className="text-sm text-ink-2">{tr('餐牌', 'Token')}</span><b className="text-3xl tabular-nums">{token ?? tr('满', 'Full')}</b>
          <span className="text-left text-[11px] leading-tight text-ink-2"><b className="block text-[13px] text-ink">{counts.available}</b>{tr('个可用', 'free')}</span>
          <Icon name="chevron-down" size={18} />
        </button>
        {counts.awaiting_return > 0 && (
          <button type="button" onClick={() => setPickerOpen(true)} className="min-h-14 shrink-0 rounded-xl bg-warn-bg px-3 text-sm font-semibold text-warn">
            {tr(`${counts.awaiting_return} 个待回收`, `${counts.awaiting_return} to collect`)}
          </button>
        )}
        {!offlineMode && <KitchenHealthBadge lastSeenMs={opsStatus.data?.kitchenLastSeenAtMs ?? null} />}
        {!tokensFromServer && <span className="text-sm text-warn">{tr('餐牌为本机记录', 'Tokens from this device')}{rt.snapshot ? `（快照 ${new Date(rt.snapshot.savedAtMs).toLocaleTimeString('zh-CN', { hour12: false })}）` : ''}</span>}
      </ShellHeaderActions>

      {offlineMode && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-warn/40 bg-warn-bg px-4 py-2.5 text-warn lg:px-6">
          <Icon name="handoff" size={34} />
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
        <div role="status" className="flex flex-wrap items-center gap-3 border-b border-warn/40 bg-warn-bg px-4 py-2 text-warn lg:px-6">
          <b>{rt.syncing ? tr('正在补同步本机记录…', 'Syncing local records…') : tr(`本机还有 ${unsynced.length} 条未同步`, `${unsynced.length} local record(s) not synced`)}{reviewCount ? tr(` · ${reviewCount} 条待老板核对`, ` · ${reviewCount} need owner review`) : ''}</b>
          <button type="button" onClick={() => navigate('/sync')} className="ml-auto h-10 rounded-lg border border-warn bg-card px-3 font-semibold">{tr('同步中心', 'Sync')}</button>
        </div>
      )}
      {writer === 'busy' && <div role="alert" className="border-b border-danger bg-danger-bg px-4 py-2 font-semibold text-danger lg:px-6">{tr('另一个标签页正在收银。为避免重复记录，这个标签页只能查看。', 'Another tab is the register. This tab is view-only to avoid duplicates.')}</div>}
      {(unknownOps.length > 0 || notice) && (
        <div className="space-y-2 border-b border-warn/40 bg-warn-bg px-4 py-2 lg:px-6" role="alert">
          {unknownOps.map((op) => (
            <div key={op.operationId} className="flex flex-wrap items-center gap-3 text-warn">
              <b>{tr(`${op.summary.tokenNumber}号 · ${formatRM(op.summary.totalSen)}：已记录收款，正在核对订单；请勿再次收钱。请问厨房是否收到这张单。`, `No. ${op.summary.tokenNumber} · ${formatRM(op.summary.totalSen)}: payment recorded, checking the order. Do NOT collect again. Ask the kitchen if they got it.`)}</b>
              {!offlineMode && <button type="button" onClick={() => void syncNow()} className="h-11 rounded-lg bg-warn px-4 font-bold text-white">{tr('核对结果', 'Check result')}</button>}
              {!offlineMode && <button type="button" onClick={() => void setManualOffline(true)} className="h-11 rounded-lg border border-warn bg-card px-3 font-semibold">{tr('云端连不上？改为离线营业', 'Cloud unreachable? Switch to offline')}</button>}
            </div>
          ))}
          {notice && (
            <div className="flex items-center gap-3 text-ink"><span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="ml-auto h-10 rounded-lg border border-control bg-card px-3">{tr('知道了', 'OK')}</button>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:landscape:flex-row md:landscape:overflow-hidden">
          <section className="@container border-line bg-canvas px-4 pt-4 pb-4 md:landscape:w-[clamp(200px,24vw,280px)] md:landscape:shrink-0 md:landscape:overflow-y-auto md:landscape:border-r md:landscape:px-3 2xl:landscape:w-[38%] 2xl:landscape:max-w-[600px] 2xl:landscape:px-6 2xl:landscape:pt-5" aria-label={tr('选餐', 'Dishes')}>
            <div className="mb-3 flex items-baseline">
              <h2 className="text-xl font-bold">{tr('看图选餐', 'Pick the dish')}</h2>
              <span className="ml-auto text-[11px] font-semibold tracking-[0.16em] text-ink-2">01 / SELECT</span>
            </div>
            <ProductGrid menu={menu} config={draft}
              onPick={(t) => setDraft(normalizeConfig(menu, { ...draft, productKind: t.productKind, sauce: t.productKind === 'dry_noodle' ? t.sauce : draft.sauce }))} />
            <p className="mt-4 hidden items-start gap-2 rounded-2xl border border-line bg-subtle/70 px-4 py-3 text-[13px] text-ink-2 2xl:flex">
              <Icon name="help" size={18} />{tr('选餐后调整面种和份量。普通配料已预设，有特别要求再更改。', 'After picking a dish, choose noodles and size. Standard toppings are preset — change only for special requests.')}
            </p>
            {resultProps && <RecentOrder {...resultProps} onOpen={() => setResultOpen(true)} />}
            {!offlineMode && (
              <p className="mt-4 flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
                <Icon name="clock" size={16} />{tr('厨房待做', 'Kitchen queue')} <b className="text-ink">{queueQ.data.length}</b> {tr('单', '')}
                {Number.isFinite(oldest) && <QueueClock since={oldest} />}
              </p>
            )}
          </section>
          <section className="min-w-0 flex-1 bg-card md:landscape:overflow-y-auto" aria-label={tr('当前配置', 'Customize')}>
            <Customizer menu={menu} config={draft} onChange={setDraft} quantity={draftQty} onQuantity={setDraftQty}
              editing={Boolean(editingLineId)} onSubmit={addOrSave}
              onCancelEdit={() => { setEditingLineId(null); setDraft(defaultConfig(menu, draft.productKind, draft.sauce)); }} />
          </section>
        </div>
        <aside className={`${cartOpen ? 'fixed inset-0 z-40 flex' : 'hidden'} min-h-0 flex-col border-l border-line bg-[#fdfcf8] md:static md:z-auto md:flex md:w-[clamp(300px,30vw,400px)] md:shrink-0`} aria-label={tr('本单', 'Order')}>
          {cartOpen && (
            <button type="button" onClick={() => setCartOpen(false)} className="flex h-14 shrink-0 items-center justify-center gap-2 border-b border-line font-semibold text-ink-2 md:hidden">
              <Icon name="chevron-down" size={18} />{tr('收起本单，继续点餐', 'Hide order, keep ordering')}
            </button>
          )}
          <div className="min-h-0 flex-1">
            <CartPanel menu={menu} cart={cart} totals={totals} tokenNumber={token} editingLineId={editingLineId}
              onEdit={editLine} onQuantity={changeQuantity} onClear={clearCart}
              onPay={() => { setCartOpen(false); setPayOpen(true); }} payDisabledReason={payDisabledReason}>
              {stage.kind === 'submitting' && <p className="mt-2 text-center text-sm text-warn">{tr('正在提交，请勿重复收钱或重复点击。', 'Submitting — do not collect again or tap again.')}</p>}
              {stage.kind === 'unknown' && <p className="mt-2 text-center text-sm font-semibold text-warn">{tr('已记录收款，正在核对订单；请勿再次收钱。', 'Payment recorded, checking the order. Do NOT collect again.')}</p>}
            </CartPanel>
          </div>
        </aside>
      </div>

      {undo && (
        <div role="status" className="fixed bottom-40 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-ink px-4 py-2 whitespace-nowrap text-white shadow-xl md:top-2 md:right-4 md:bottom-auto md:left-auto md:translate-x-0">
          {undo.label}
          <button type="button" onClick={() => { setCart(undo.cart); setUndo(null); setEditingLineId(null); }} className="h-14 rounded-xl border border-white/40 px-5 font-semibold">{tr('撤销', 'Undo')}</button>
        </div>
      )}

      <div className="flex shrink-0 items-stretch gap-2 border-t border-line bg-card p-2 md:hidden">
        <button type="button" onClick={() => setCartOpen(true)} aria-expanded={cartOpen} className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line px-3 text-left">
          <span className="font-bold">{tr('本单', 'Order')} {totals.portionCount} {tr('份', 'pcs')} · {formatRM(totals.totalSen)}</span>
          <span className="ml-auto text-sm text-ink-2">{tr('查看 / 修改', 'View / edit')}</span>
        </button>
        <button type="button" onClick={() => setPayOpen(true)} disabled={Boolean(payDisabledReason)}
          className="flex min-h-14 shrink-0 items-center gap-1.5 rounded-xl bg-ok px-4 text-lg font-bold text-white disabled:bg-control">{tr('去收款', 'Pay')}<span className="sr-only"> {formatRM(totals.totalSen)}</span><Icon name="arrow" size={20} /></button>
      </div>

      {receipt && <ReceiptDialog receiptKey={receipt.key} load={receipt.load} menuVersion={menu.version} timeZone={config.timeZone} onClose={() => setReceipt(null)} />}
      {pickerOpen && <TokenPicker board={board} current={token} onPick={setToken} onRelease={releaseTokenAction} onClose={() => setPickerOpen(false)} />}
      {payOpen && token !== null && (
        <PaymentDrawer menu={menu} cart={cart} totals={totals} tokenNumber={token}
          qrPayee={config.qrPayee} online={!offlineMode} busy={busy} error={payError}
          onConfirm={(p) => void (offlineMode ? confirmOffline(p) : confirmOnline(p))}
          onClose={() => { setPayOpen(false); if (stage.kind === 'rejected' || stage.kind === 'local_failed') setStage({ kind: 'idle' }); }} />
      )}
      {payOpen && stage.kind === 'rejected' && (
        <div role="alert" className="fixed right-4 bottom-6 z-[60] max-w-[440px] rounded-xl border-2 border-danger bg-danger-bg p-4 text-danger shadow-xl">
          <b>{tr('云端未接单：', 'Not accepted: ')}{stage.reason}</b>
          <p className="text-sm">{tr('这次没有生成订单。若已收钱，请勿再次收钱，修正后再提交。', 'No order was created. If you already took money, do not collect again — fix and resubmit.')}</p>
        </div>
      )}
      {resultProps && resultOpen && !receipt && <OrderResultDialog {...resultProps} onClose={() => setResultOpen(false)} />}
    </div>
  );
}

function KitchenHealthBadge({ lastSeenMs }: { lastSeenMs: number | null }) {
  useNow(5000);
  const rt = useOfflineRuntime();
  const tr = useT();
  const h = kitchenHealth(lastSeenMs, serverNow(rt));
  if (h === 'online') return <span className="inline-flex items-center gap-1.5 rounded-lg bg-ok-bg px-2.5 py-1.5 text-[13px] font-semibold text-ok"><span className="h-2 w-2 rounded-full bg-ok" />{tr('后厨已连接', 'Kitchen online')}</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-danger-bg px-2.5 py-1.5 text-[13px] font-semibold text-danger">
      <span className="h-2 w-2 rounded-full bg-danger" />
      {h === 'unknown' ? tr('后厨屏未连接', 'Kitchen not connected') : tr(`后厨屏离线（${formatClock(serverNow(rt) - lastSeenMs!)} 前）`, `Kitchen offline (${formatClock(serverNow(rt) - lastSeenMs!)} ago)`)}
    </span>
  );
}

function QueueClock({ since }: { since: number }) {
  const now = useNow();
  const tr = useT();
  return <span>· {tr('最久', 'Longest')} <b className="text-ink">{formatClock(now - since)}</b></span>;
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
