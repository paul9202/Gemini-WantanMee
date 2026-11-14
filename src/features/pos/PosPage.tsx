/**
 * POS 点单页：同一画布完成常规点单（02 §4）；指定主收银机断网时本机接单（01 §7）。
 * 下单即送厨，不需要先收款（2026-10-23 营业流程）：主按钮「下单送厨 · RM金额」。
 * 接单进度只显示有依据的事实：本机已记录 → 云端已接单 → 后厨已收到；
 * 断网时只完成第一步，后两步明确显示「未同步」与「请人工传单」。
 * 收款是独立的事：下单后可立即确认，或送餐收钱后在常驻的「待登记收款」里按订单确认。
 * 同牌加单：同一桌客人拿着 N 号牌再点，新单挂在 N 号上（不用再给牌，后厨排回原位）；只能联网下单，断网时按新单给新牌。
 * 手选的空闲牌，若这个号上一桌还没收款：只在本单上方提示，可一键并到一起算；不理它就是普通新客人。牌号全天复用，绝不按号自动并账。
 * 下单后加料：页头「＋加料」开面板，给已下的单加叉烧 / 云吞，单独一张小单，不动当前这张单、餐牌和加单目标；只能联网。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { BOM_V1 } from '../../domain/bom';
import { addLine, Cart, cartServiceMode, computeTotals, emptyCart, setLineQuantity, setLineServiceMode, setServiceMode, updateLineConfig } from '../../domain/cart';
import { defaultConfig, LineConfig, normalizeConfig, unitPriceSen } from '../../domain/lineItem';
import { notePictogramIds, PICTOGRAMS } from '../../domain/pictograms';
import { formatRM } from '../../domain/money';
import { manualStatus, OfflineEvent, offlineReceiptNumber, overlayLocalTokens } from '../../domain/offline';
import { createTokenBoard, countTokens, suggestNextToken, TokenBoard, tokenFromDoc, tokenHolders, tokenSession, TokenStateName } from '../../domain/tokens';
import { formatClock } from '../../domain/timing';
import { DEFAULT_KITCHEN_LINK, kitchenHealth } from '../../domain/kitchenLink';
import { useHeartbeat } from '../../data/heartbeat';
import { db, storePath } from '../../data/firebase/client';
import { call, CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
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
import { MAX_PAY_ORDERS, PendingPaymentsDrawer, QuickPay, UnpaidOrder, useUnpaidOrders } from './PendingPayments';
import { CartPanel } from './CartPanel';
import { Customizer } from './Customizer';
import { ExtraRequest, ExtraSheet } from './ExtraSheet';
import { OrderResultDialog, RecentOrder, ResultStage, ResultSummary } from './OrderResult';
import { ProductGrid } from './ProductGrid';
import { TokenPicker } from './TokenPicker';
import { ReceiptDialog, receiptFromLocal, receiptFromOrder } from '../receipt/ReceiptDialog';
import type { ReceiptSource } from '../../domain/receipt';
import { buildRunnerSlip, RunnerSlipSource, slipKey } from '../../domain/runnerSlip';
import type { MenuVersion, ServiceMode } from '../../domain/menu';
import type { OrderLineInput } from '../../domain/cart';
import { printer, slipPrintingOn, usePrinter } from '../../data/printer/printer';
import { PrinterChip, slipStep } from '../printer/PrinterPanel';

/** 送餐单的行：订单行 + 成交菜单的单价。 */
function slipLines(menu: MenuVersion, lines: { config: LineConfig; quantity: number; serviceMode?: ServiceMode }[]): RunnerSlipSource['lines'] {
  return lines.map((l) => ({ config: l.config, quantity: l.quantity, unitPriceSen: unitPriceSen(menu, l.config), ...(l.serviceMode ? { serviceMode: l.serviceMode } : {}) }));
}

/** 登记一张送餐单。打印出任何问题都不影响下单，所以这里吞掉所有错误。 */
function queueSlip(menu: MenuVersion, timeZone: string, key: string, src: RunnerSlipSource, label: string, reconciled = false) {
  try {
    const slip = buildRunnerSlip(menu, src, { timeZone, printIndex: 0, reconciled });
    void printer.enqueue(key, slip, { label, reconciled }).catch(() => undefined);
  } catch {
    // 打印不影响下单
  }
}

/** 下单结果不明、核对后确认已接单的单：从本机记下的下单内容补打送餐单。 */
async function queueReconciledSlip(op: PendingOp, current: MenuVersion | undefined, timeZone: string) {
  const order = op.payload.order as unknown as { tokenNumber: number; serviceMode: ServiceMode; menuVersion: string; lines: OrderLineInput[]; extraForOrderId?: string };
  const r = (op.result ?? {}) as Partial<CreateOrderResult>;
  if (!r.orderId || !r.receiptNumber) return;
  const menu = current?.version === order.menuVersion ? current : await menuForVersion(order.menuVersion);
  if (!menu) return;
  const extraOnly = Boolean(order.extraForOrderId);
  queueSlip(menu, timeZone, slipKey({ orderId: r.orderId }), {
    tokenNumber: r.tokenNumber ?? order.tokenNumber, serviceMode: order.serviceMode, acceptedAtMs: r.acceptedAtMs ?? op.createdAtMs,
    receiptNumber: r.receiptNumber, offlineReceiptNumber: null, source: 'online', lines: slipLines(menu, order.lines),
    totalSen: r.totalSen ?? op.summary.totalSen, sharedToken: Boolean(r.sharedToken), extraOnly,
  }, `#${r.receiptNumber}${extraOnly ? ' · 加料' : ''} · 核对后`, true);
}

interface CreateOrderResult {
  orderId: string;
  receiptNumber: string;
  tokenNumber: number;
  totalSen: number;
  paymentState: 'unpaid';
  acceptedAtMs: number;
  replayed?: boolean;
  /** 同牌加单且确实挂到了仍占用的牌上（牌已空出而重新占牌时为 false）。旧服务器不返回。 */
  sharedToken?: boolean;
  /** 厨单确实继承了同桌的排队位置（牌上只有人工单时不继承）。旧服务器不返回。 */
  queueInherited?: boolean;
  /** 本单所在收款组的组长单 ID（组长可能已收款）；不是加单为 null。旧服务器不返回。 */
  addOnToOrderId?: string | null;
}

/** 牌释放后多久内才提示「上一桌还没收款」：再久就不会是同一桌了。 */
const SAME_TABLE_WINDOW_MS = 30 * 60_000;

type Stage =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'submitting' }
  /** joinRequested：下单时要同牌加单（结果弹窗据此说明牌已空出的情况）。extraOnly：这是一份下单后加料。 */
  | { kind: 'accepted'; result: CreateOrderResult; summary: ResultSummary; joinRequested: boolean; extraOnly?: boolean }
  | { kind: 'local_accepted'; clientOrderId: string; offlineReceiptNumber: string; tokenNumber: number; totalSen: number; summary: ResultSummary }
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

  const tokensQ = useLiveQuery<{
    number: number; state: TokenStateName; orderId: string | null; version: number;
    orderIds?: string[]; sessionOrderIds?: string[]; lastReleasedOrderId?: string | null; updatedAtMs?: number;
  }>(collection(db, storePath('tokens')), 'tokens');
  const tokensFromServer = !tokensQ.fromCache && tokensQ.data.length > 0;
  const unsynced = unsyncedEvents(rt);
  const unresolved = unresolvedOps(rt);
  // 本机餐牌视图：服务器餐牌（断网时用最后快照）+ 尚未被服务器接纳的本机事件。
  const board: TokenBoard = useMemo(() => {
    let base = createTokenBoard();
    if (tokensFromServer || !rt.snapshot) for (const t of tokensQ.data) base[t.number] = tokenFromDoc(t.number, t);
    else base = { ...rt.snapshot.tokens };
    return overlayLocalTokens(base, unsynced.map((r) => r.event));
  }, [tokensQ.data, tokensFromServer, rt.snapshot, unsynced]);
  const queueQ = useLiveQuery<{ fulfillmentStatus: string; acceptedAtEffectiveMs: number; kitchenAckAtMs?: number | null; manualHandoffAtMs?: number | null }>(
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
  // 收银在选牌器里亲手点的空闲牌（自动建议的牌不算）：只有手选才提示「上一桌还没收款」。
  const [manualPick, setManualPick] = useState<number | null>(null);
  const [lastIssued, setLastIssued] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 窄屏（<1024）本单收起为底部条，点开后全屏显示。
  const [cartOpen, setCartOpen] = useState(false);
  const [payListOpen, setPayListOpen] = useState(false);
  // 下单后加料面板；orderId 是打开时预选的单。
  const [extraSheet, setExtraSheet] = useState<{ orderId: string | null } | null>(null);
  // 加单：客人吃完再加（多为打包），新单挂到这张未收款的原单上，收款时一起结账。
  const [addOnTarget, setAddOnTarget] = useState<UnpaidOrder | null>(null);
  // 同牌加单：新单挂在客人已拿着的 N 号牌上（withOrderId 为牌上现有的一张单），不再给新牌；期间不自动建议新牌。
  const [joinTarget, setJoinTarget] = useState<{ tokenNumber: number; withOrderId: string } | null>(null);
  /** 刚送出的单若是加单：它所在组的原单 ID（结果弹窗一次结清整组）。 */
  const [resultAddOnRoot, setResultAddOnRoot] = useState<string | null>(null);
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
  // 同牌加单期间用的是客人手上的牌，不建议新牌。
  useEffect(() => {
    if (tokensQ.loading && !rt.snapshot) return;
    if (joinTarget) return;
    if (token === null || board[token]?.state !== 'available') setToken(suggestNextToken(board, lastIssued));
  }, [board, token, lastIssued, tokensQ.loading, rt.snapshot, joinTarget]);

  // 牌一变（下单后清空、牌失效改建议、改去同牌加单）手选标记就作废，之后再建议到同一个号也不算手选。
  useEffect(() => {
    if (manualPick !== null && manualPick !== token) setManualPick(null);
  }, [manualPick, token]);

  // 同牌加单期间牌有变化：牌已给了别的客人 → 取消同牌加单并提示；原单已出餐但同桌别的单还占着牌 → 改挂到仍占牌的那张单上。
  // 牌显示空闲时不动：可能是这桌的单都出餐了（服务器会按同一个号重新占牌），也可能是刚下的单还没同步到本机。
  useEffect(() => {
    if (!joinTarget || (tokensQ.loading && !rt.snapshot)) return;
    const n = joinTarget.tokenNumber;
    const t = board[n];
    if (!t) return;
    if (t.state === 'available') return;
    const holders = tokenHolders(t);
    if (t.state !== 'held' || !(holders.includes(joinTarget.withOrderId) || tokenSession(t).includes(joinTarget.withOrderId))) {
      setJoinTarget(null);
      setToken(null);
      setNotice(tr(`${n} 号已给了别的客人，已取消同牌加单`, `Token ${n} now belongs to another customer — same-token add-on cancelled`));
      return;
    }
    if (!holders.includes(joinTarget.withOrderId) && holders.length > 0) setJoinTarget({ tokenNumber: n, withOrderId: holders[0] });
    // tr 每次渲染都是新函数，只在餐牌或同牌目标变化时核对。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, joinTarget, tokensQ.loading, rt.snapshot]);

  // 离线营业资格自动续期（2026-11-14 修）：有网时，剩不到 20 小时就续到「现在 + 24 小时」。
  // 以前只有开班给 24 小时，班次一直不关就会过期，断线时接的单全部进「待老板核对」。每 15 分钟看一次，失败下次再试。
  const [renewTick, setRenewTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRenewTick((n) => n + 1), 15 * 60_000);
    return () => clearInterval(t);
  }, []);
  const renewing = useRef(false);
  useEffect(() => {
    if (offlineMode || reg.fromSnapshot || reg.status !== 'ready' || !reg.claim || !reg.shift || renewing.current) return;
    if (reg.shift.offlineCapabilityExpiresAtMs - Date.now() > 20 * 60 * 60_000) return;
    renewing.current = true;
    void call('renewOfflineCapability', { operationId: newOperationId(), ...reg.claim }).catch(() => undefined).finally(() => { renewing.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineMode, reg.status, reg.fromSnapshot, reg.shift?.offlineCapabilityExpiresAtMs, reg.claim?.registerEpoch, renewTick]);

  // 联网且数据来自服务器时，持续保存离线营业快照（开档时的「离线可用」准备）。
  useEffect(() => {
    if (offlineMode || usingSnapshot || reg.fromSnapshot || reg.status !== 'ready' || !tokensFromServer) return;
    if (!user || !member || !config || !deviceId || !reg.claim || !reg.shiftId || !reg.shift) return;
    const tokens: TokenBoard = {};
    for (const t of tokensQ.data) tokens[t.number] = tokenFromDoc(t.number, t);
    void saveSnapshot({
      uid: user.uid, member, config, deviceId, claim: reg.claim, shiftId: reg.shiftId, shift: reg.shift, serverApplied: reg.serverApplied,
      tokens, serverOffsetMs: rt.snapshot?.serverOffsetMs ?? 0, savedAtMs: Date.now(),
    });
    // 只在服务器数据变化时保存。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineMode, usingSnapshot, reg.status, reg.serverApplied, reg.shiftId, reg.shift?.offlineCapabilityExpiresAtMs, reg.claim?.registerEpoch, tokensFromServer, tokensQ.data, config, member]);

  const unpaid = useUnpaidOrders(menu ? (c) => lineName(menu, c, lang) : undefined);
  const lastOrder = useLiveDoc<{ kitchenAckAtMs: number | null; fulfillmentStatus: string; manualHandoffAtMs?: number | null; paymentState?: string }>(
    stage.kind === 'accepted' ? storePath(`orders/${stage.result.orderId}`) : null,
  );

  // 送餐单打印：老板在设置里打开总开关才用；关着时不连打印机、不打印、页头不显示。
  const slipOn = slipPrintingOn(config);
  const printerState = usePrinter(slipOn);
  // 总开关被关掉：放开蓝牙连接（打印机可以给别的设备用），排着的单也不再打。
  useEffect(() => {
    if (!slipOn && printer.getState().link !== 'off' && printer.getState().link !== 'needs_tap') printer.disconnect();
  }, [slipOn]);
  // 送餐单：下单结果不明的单，核对确认已接单后补打（标「核对后补打」）；查无此单就不打。
  // 打开页面时还在送单中 / 结果不明的旧单也算（页面在送单途中被关掉）。本次打开里正常送单中的不算，那些接单时直接打。
  const awaitingCheck = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!rt.loaded || !config) return;
    if (awaitingCheck.current === null) {
      awaitingCheck.current = new Set(rt.pendingOps.filter((o) => o.status === 'submitting' || o.status === 'unknown_result').map((o) => o.operationId));
    }
    const waiting = awaitingCheck.current;
    for (const op of rt.pendingOps) {
      if (op.status === 'unknown_result') waiting.add(op.operationId);
      if (!waiting.has(op.operationId)) continue;
      if (op.status === 'accepted') {
        waiting.delete(op.operationId);
        if (slipPrintingOn(config)) void queueReconciledSlip(op, menu, config.timeZone);
      } else if (op.status === 'not_found' || op.status === 'rejected' || op.status === 'converted') {
        waiting.delete(op.operationId);
      }
    }
  }, [rt.loaded, rt.pendingOps, menu, config]);

  if (!menu || !config || !draft) return <p className="p-6">{tr('正在载入菜单…', 'Loading menu…')}</p>;
  if (reg.status !== 'ready') return <RegisterGate status={reg.status} isOwner={member?.role === 'owner'} />;

  const totals = computeTotals(menu, BOM_V1, cart);
  const timeZone = config.timeZone;
  const counts = countTokens(board);
  const busy = stage.kind === 'saving' || stage.kind === 'submitting';
  const blockingOnline = unresolved.filter((o) => o.status === 'not_found');
  /** 本单用的牌：同牌加单时是客人手上的牌，否则是建议 / 选中的新牌。 */
  const orderToken = joinTarget?.tokenNumber ?? token;
  const joinOfflineReason = tr('断网时不能同牌加单：先取消，按新单给新号牌', 'Cannot add on the same token while offline — cancel it and give a new token as a new order');

  const payDisabledReason = writer !== 'held' ? tr('另一个标签页正在收银，这里只能查看', 'Another tab is the register — view only here')
    : cart.lines.length === 0 ? tr('先加入餐品', 'Add an item first')
    : joinTarget && offlineMode ? joinOfflineReason
    : orderToken === null ? tr('没有可用餐牌：牌在出餐或取消成立后自动可用', 'No free token — tokens free up when orders are served or cancelled')
    : addOnTarget && offlineMode ? tr('断网时不能加单：先取消加单，按新单下单', 'Cannot add on while offline — cancel add-on and place a new order')
    : !offlineMode && blockingOnline.length > 0 ? tr('有订单待你决定处理方式，请先到「同步」页处理', 'An order needs your decision — open Sync first')
    : null;
  /** 现在不能送加料的原因，显示在加料面板里；餐牌不是服务器最新时也不送，否则「客人已拿着」这句话没有依据。 */
  const extraBlocked = offlineMode ? tr('断网时不能加料：联网后再加', 'Extras cannot be added while offline — try again once online')
    : writer !== 'held' ? tr('另一个标签页正在收银，这里只能查看', 'Another tab is the register — view only here')
    : busy ? tr('正在送单，请稍等', 'Sending — please wait')
    : unresolved.length > 0 ? tr('还有单结果未确认或待处理：请先到「同步」页处理，再加料', 'An order is unconfirmed or needs a decision — check Sync first, then add extras')
    : !reg.claim || !reg.shiftId ? tr('收银机未就绪', 'Register not ready')
    : !tokensFromServer ? tr('餐牌还没同步到最新，请稍等', 'Tokens are not up to date yet — please wait')
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
    resetDraftOptions();
    if (stage.kind !== 'idle' && !busy) setStage({ kind: 'idle' });
  }

  function changeQuantity(lineId: string, q: number) {
    if (q > 50) return;
    if (q === 0) setUndo({ cart, label: tr('已移除一行', 'Removed') });
    setCart(setLineQuantity(cart, lineId, q));
    if (q === 0 && editingLineId === lineId) {
      setEditingLineId(null);
      resetDraftOptions(); // 正在改的这行删掉了：不把它的要求带给下一碗。
    }
  }

  function clearCart() {
    if (!cart.lines.length) return;
    setUndo({ cart, label: tr('已清空本单', 'Order cleared') });
    setCart(emptyCart(cart.serviceMode));
    if (editingLineId) resetDraftOptions();
    setEditingLineId(null);
  }

  const summaryOf = (): ResultSummary => ({
    serviceMode: cartServiceMode(cart),
    firstItem: cart.lines.map((l) => `${lineName(menu, l.config, lang)}${notePictogramIds(l.config).map((id) => ` · ${lang === 'en' ? PICTOGRAMS[id].en : PICTOGRAMS[id].zh}`).join('')}${l.quantity > 1 ? ` ×${l.quantity}` : ''}`).join('，'),
  });

  /** sharedToken：挂在客人已拿着的牌上，没有发出新牌，不改变循环建议的起点。 */
  /** 特殊选项归默认，防止上一位顾客的走青、Kosong、不要番茄酱、不要叉烧残留；保留所选餐品与面种。 */
  function resetDraftOptions() {
    if (!menu || !draft) return;
    const keep = defaultConfig(menu, draft.productKind, draft.sauce);
    setDraft({ ...keep, noodleType: keep.noodleType ? draft.noodleType : null });
  }

  function clearAfterAccept(tokenNumber: number, sharedToken = false) {
    if (!sharedToken) rememberIssued(tokenNumber);
    resetDraftOptions();
    setToken(null);
    setManualPick(null);
    setCart(emptyCart(cart.serviceMode));
    setEditingLineId(null);
    setUndo(null);
  }

  const lines = () => cart.lines.map((l) => ({ lineId: l.lineId, config: l.config, quantity: l.quantity, serviceMode: l.serviceMode }));

  /** 断网：订单（未付款）、占牌、日志、序号在同一个 IndexedDB 事务里提交；收款另记事件。不支持同牌加单。 */
  async function confirmOffline() {
    if (!menu || !reg.claim || !reg.shiftId || token === null || joinTarget) return;
    const claim = reg.claim;
    const clientOrderId = crypto.randomUUID();
    setStage({ kind: 'saving' });
    try {
      const { order } = await commitOfflineOrder(seqKey(claim.registerId, claim.registerEpoch), reg.serverApplied, (sequence) => {
        const payload = {
          clientOrderId, offlineReceiptNumber: offlineReceiptNumber(claim.registerId, sequence), tokenNumber: token, serviceMode: cart.serviceMode,
          menuVersion: menu.version, lines: lines(), totalSen: totals.totalSen, payment: null,
        };
        const event: OfflineEvent = {
          eventId: crypto.randomUUID(), ...claim, sequence, shiftId: reg.shiftId!, occurredAtDeviceMs: Date.now(),
          lastServerOffsetMs: rt.snapshot?.serverOffsetMs ?? 0, type: 'offline_order_created', payload,
        };
        return { event, order: { ...payload, sequence, createdAtMs: Date.now(), changeSen: null } };
      });
      // 断网单：后厨屏看不到，送餐单就是厨师照着做的纸单（补同步时不会再打）。
      if (slipOn) queueSlip(menu, timeZone, slipKey({ clientOrderId }), {
        tokenNumber: token, serviceMode: cart.serviceMode, acceptedAtMs: order.createdAtMs, receiptNumber: null, offlineReceiptNumber: order.offlineReceiptNumber,
        source: 'offline', lines: slipLines(menu, order.lines), totalSen: order.totalSen,
      }, `临时号 ${order.offlineReceiptNumber} · 断网单`);
      await reloadLocal();
      setStage({ kind: 'local_accepted', clientOrderId, offlineReceiptNumber: order.offlineReceiptNumber, tokenNumber: token, totalSen: totals.totalSen, summary: summaryOf() });
      setResultAddOnRoot(null);
      setResultOpen(true);
      clearAfterAccept(token);
    } catch (e) {
      setStage({ kind: 'local_failed', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 人工交接 / 人工出餐 /（旧版）餐牌回收：追加不可变本机事件。 */
  const appendManual = (type: 'manual_handoff' | 'manual_served' | 'token_returned', clientOrderId: string, tokenNumber?: number) =>
    reg.claim && reg.shiftId
      ? appendManualEvent({ claim: reg.claim, shiftId: reg.shiftId, serverApplied: reg.serverApplied }, type, clientOrderId, { tokenNumber })
      : Promise.resolve('收银机未就绪');

  async function confirmOnline() {
    if (!menu || !reg.claim || !reg.shiftId || orderToken === null) return;
    const joinRequested = Boolean(joinTarget);
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
      order: {
        clientOrderId, tokenNumber: orderToken, serviceMode: cart.serviceMode, menuVersion: menu.version, lines: lines(), expectedTotalSen: totals.totalSen, deviceAcceptedAtMs: Date.now(),
        ...(addOnTarget ? { addOnToOrderId: addOnTarget.id } : {}),
        // 同牌加单：挂到这桌正拿着的牌上；服务器自动并入这一轮的同桌账单（前面的单已收款也并，只收还没收的）。
        ...(joinTarget ? { joinTokenOrderId: joinTarget.withOrderId } : {}),
      },
    };
    const op: PendingOp = {
      operationId, name: 'createOrder', payload, status: 'submitting', createdAtMs: Date.now(), updatedAtMs: Date.now(),
      summary: { tokenNumber: orderToken, totalSen: totals.totalSen },
    };
    setStage({ kind: 'saving' });
    try {
      await putPendingOp(op);
    } catch (e) {
      await voidRejectedSequence({ operationId, clientOrderId, sequence }, claim, reg.shiftId).catch(() => {}); // 没发出去：序号还回去，后面的单不会卡住
      setStage({ kind: 'local_failed', message: e instanceof Error ? e.message : String(e) });
      return; // 不清空购物车，不声称成功
    }
    setStage({ kind: 'submitting' });
    const sentAt = Date.now();
    try {
      const result = await submit<CreateOrderResult>('createOrder', payload);
      await putPendingOp({ ...op, status: 'accepted', result: { ...result }, updatedAtMs: Date.now() });
      if (!result.replayed) void recordServerOffset(result.acceptedAtMs - (sentAt + Date.now()) / 2);
      // 送餐单：牌号、票号、合计都用服务器返回的。
      const addOnToToken = !result.sharedToken && addOnTarget ? addOnTarget.tokenNumber : null;
      if (slipOn) queueSlip(menu, timeZone, slipKey({ orderId: result.orderId }), {
        tokenNumber: result.tokenNumber, serviceMode: cart.serviceMode, acceptedAtMs: result.acceptedAtMs, receiptNumber: result.receiptNumber, offlineReceiptNumber: null,
        source: 'online', lines: slipLines(menu, payload.order.lines), totalSen: result.totalSen, sharedToken: Boolean(result.sharedToken), addOnToToken,
      }, `#${result.receiptNumber}${result.sharedToken ? ' · 同牌加单' : addOnToToken !== null ? ' · 加单' : ''}`);
      setStage({ kind: 'accepted', result, summary: summaryOf(), joinRequested });
      // 收款组以服务器为准（同牌加单可能被自动并入原单）；旧服务器不返回时按本机加单目标推算。
      setResultAddOnRoot(result.addOnToOrderId ?? (addOnTarget ? addOnTarget.addOnToOrderId ?? addOnTarget.id : null));
      setAddOnTarget(null);
      setJoinTarget(null);
      setResultOpen(true);
      clearAfterAccept(result.tokenNumber, Boolean(result.sharedToken));
    } catch (e) {
      const f = e instanceof CommandFailure ? e : new CommandFailure('unknown', 'UNKNOWN_RESULT', String(e));
      if (f.kind === 'rejected') {
        await putPendingOp({ ...op, status: 'rejected', reasonCode: f.reasonCode, updatedAtMs: Date.now() });
        await voidRejectedSequence({ operationId, clientOrderId, sequence }, claim, reg.shiftId);
        setStage({ kind: 'rejected', code: f.reasonCode, reason: reasonText(f.reasonCode) });
        // 牌已被别的客人占用：同牌加单作废，重新建议新牌；其他原因保留同牌加单以便重试。
        if (f.reasonCode === 'TOKEN_OCCUPIED') {
          setJoinTarget(null);
          setToken(null);
        }
        // 原单不能并单结账（已收款等）：去掉加单目标；同牌加单保留，重试时由服务器并入同桌账单。
        if (f.reasonCode === 'ADD_ON_NOT_ALLOWED') setAddOnTarget(null);
      } else {
        // 结果不明：保留原 ID，等待核对；绝不改成新的人工单。
        await putPendingOp({ ...op, status: 'unknown_result', updatedAtMs: Date.now() });
        setStage({ kind: 'unknown', operationId });
      }
    }
    await reloadLocal();
  }

  /**
   * 下单后加料：和 confirmOnline 同样的步骤（先补同步、分配序号、PendingOp 跟踪、被拒作废序号、结果不明留待核对），
   * 但不清空当前这张单，也不动餐牌和加单目标。返回要留在面板里的错误；接单成功返回 null 并关面板。
   */
  async function sendExtra(req: ExtraRequest): Promise<string | null> {
    if (!menu || !reg.claim || !reg.shiftId || busy) return tr('收银机未就绪', 'Register not ready');
    const claim = reg.claim;
    const shiftId = reg.shiftId;
    const notSent = (e: unknown) => {
      setStage({ kind: 'idle' });
      return `${tr('本机保存失败，这份加料没有送出', 'Could not save on this device — this extra was not sent')}（${e instanceof Error ? e.message : String(e)}）`;
    };
    let sequence: number;
    try {
      // 先补传离线日志，保证序号连续。
      if (unsynced.length) {
        setStage({ kind: 'submitting' });
        await syncNow();
        await reloadLocal();
      }
      sequence = await reg.allocate();
    } catch (e) {
      return notSent(e);
    }
    const operationId = newOperationId();
    const clientOrderId = crypto.randomUUID();
    const payload = {
      operationId, ...claim, sequence, shiftId,
      order: { clientOrderId, tokenNumber: req.tokenNumber, serviceMode: req.serviceMode, menuVersion: menu.version, lines: req.lines, expectedTotalSen: req.totalSen, deviceAcceptedAtMs: Date.now(), extraForOrderId: req.bowlOrderId },
    };
    const op: PendingOp = {
      operationId, name: 'createOrder', payload, status: 'submitting', createdAtMs: Date.now(), updatedAtMs: Date.now(),
      summary: { tokenNumber: req.tokenNumber, totalSen: req.totalSen },
    };
    setStage({ kind: 'saving' });
    try {
      await putPendingOp(op);
    } catch (e) {
      await voidRejectedSequence({ operationId, clientOrderId, sequence }, claim, shiftId).catch(() => {}); // 没发出去：序号还回去，后面的单不会卡住
      return notSent(e);
    }
    setStage({ kind: 'submitting' });
    const sentAt = Date.now();
    let failure: string | null = null;
    try {
      const result = await submit<CreateOrderResult>('createOrder', payload);
      await putPendingOp({ ...op, status: 'accepted', result: { ...result }, updatedAtMs: Date.now() });
      if (!result.replayed) void recordServerOffset(result.acceptedAtMs - (sentAt + Date.now()) / 2);
      if (slipOn) queueSlip(menu, timeZone, slipKey({ orderId: result.orderId }), {
        tokenNumber: result.tokenNumber, serviceMode: req.serviceMode, acceptedAtMs: result.acceptedAtMs, receiptNumber: result.receiptNumber, offlineReceiptNumber: null,
        source: 'online', lines: slipLines(menu, req.lines), totalSen: result.totalSen, extraOnly: true,
      }, `#${result.receiptNumber} · 加料`);
      const mixed = new Set(req.lines.map((l) => l.serviceMode ?? req.serviceMode)).size > 1;
      setStage({ kind: 'accepted', result, summary: { serviceMode: mixed ? 'mixed' : req.serviceMode, firstItem: req.summary }, joinRequested: false, extraOnly: true });
      setResultAddOnRoot(result.addOnToOrderId ?? null);
      setExtraSheet(null);
      setResultOpen(true);
      // 只有发出新号才改变循环建议的起点；客人手上的牌、还给客人的原号都不算。
      if (!result.sharedToken && result.tokenNumber !== req.bowlTokenNumber) rememberIssued(result.tokenNumber);
    } catch (e) {
      const f = e instanceof CommandFailure ? e : new CommandFailure('unknown', 'UNKNOWN_RESULT', String(e));
      if (f.kind === 'rejected') {
        setStage({ kind: 'idle' }); // 错误显示在面板里，不留到点餐页的本单上。
        failure = `${tr('云端未接单：', 'Not accepted: ')}${reasonText(f.reasonCode)}`;
        await putPendingOp({ ...op, status: 'rejected', reasonCode: f.reasonCode, updatedAtMs: Date.now() });
        await voidRejectedSequence({ operationId, clientOrderId, sequence }, claim, shiftId);
      } else {
        // 结果不明：保留原 ID，等待核对；不能再送一次。
        setStage({ kind: 'unknown', operationId });
        // 关掉面板：核对完按钮会重新亮起，数量还留着就可能再发一次。
        setExtraSheet(null);
        setNotice(tr('加料结果未确认，正在核对；请勿重复加料。请问厨房是否收到这张单。', 'Result unconfirmed, checking. Do NOT send it again. Ask the kitchen if they got it.'));
        await putPendingOp({ ...op, status: 'unknown_result', updatedAtMs: Date.now() });
      }
    }
    await reloadLocal();
    return failure;
  }

  /** 旧版待回收牌（改版前出餐的单）：实体牌收回后逐张释放。新单出餐 / 取消即自动释放。 */
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
  const localStatus = stage.kind === 'local_accepted' ? manualStatus(rt.outbox.map((r) => r.event), stage.clientOrderId) : null;
  const handedOff = Boolean(localStatus?.handedOff);
  const resultPaid = stage.kind === 'accepted' ? lastOrder.data?.paymentState === 'paid'
    : stage.kind === 'local_accepted' ? Boolean(localStatus?.paid) || rt.outbox.some((r) => r.event.type === 'offline_payment_recorded' && r.event.payload.clientOrderId === stage.clientOrderId) : false;

  const resultStage: ResultStage | null = stage.kind === 'accepted'
    ? { kind: 'accepted', orderId: stage.result.orderId, receiptNumber: stage.result.receiptNumber, tokenNumber: stage.result.tokenNumber, totalSen: stage.result.totalSen, acceptedAtMs: stage.result.acceptedAtMs, summary: stage.summary, sharedToken: Boolean(stage.result.sharedToken), queueInherited: Boolean(stage.result.queueInherited), joinFellBack: stage.joinRequested && stage.result.sharedToken === false, extraOnly: stage.extraOnly }
    : stage.kind === 'local_accepted'
      ? { kind: 'local_accepted', clientOrderId: stage.clientOrderId, offlineReceiptNumber: stage.offlineReceiptNumber, tokenNumber: stage.tokenNumber, totalSen: stage.totalSen, summary: stage.summary }
      : null;
  const resultProps = resultStage && {
    stage: resultStage,
    kitchenAckAtMs: lastOrder.data?.kitchenAckAtMs ?? null,
    kitchenLastSeenMs: opsStatus.data?.kitchenLastSeenAtMs ?? null,
    offsetMs: rt.serverOffsetMs ?? rt.snapshot?.serverOffsetMs ?? 0,
    handedOff,
    paid: resultPaid,
    printStep: slipOn && resultStage ? slipStep(
      printerState.jobs.find((j) => j.key === (resultStage.kind === 'accepted' ? slipKey({ orderId: resultStage.orderId }) : slipKey({ clientOrderId: resultStage.clientOrderId }))),
      printerState, resultStage.kind === 'local_accepted', tr,
    ) : null,
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
            const st = manualStatus(rt.outbox.map((r) => r.event), id);
            return receiptFromLocal(o, soldMenu, config.name, { synced: rec?.status === 'accepted', receiptNumber: rec?.result?.receiptNumber ?? null, served: st.served, paid: st.paid });
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
  /** 下单送厨：不经过收款弹窗；防连点。 */
  /**
   * 从待登记收款的某张单开始加单（与原单一起结账）：关抽屉回点餐。
   * 原牌仍被这桌占着 → 同牌加单，不用再给牌；客人还在，不默认打包。
   * 原牌已空出 → 仍用同一个号；牌已给了别人 → 照常建议新牌。这两种多为吃完带走，本单还空着就默认打包。
   * 手选空闲牌时的「并到一起算」也走这里（原牌已空出那一支）：显式挂到原单，后厨排队尾，钱合并。
   */
  function startAddOn(o: UnpaidOrder) {
    setAddOnTarget(o);
    setPayListOpen(false);
    const t = board[o.tokenNumber];
    const holders = tokenHolders(t);
    if (t?.state === 'held' && holders.length > 0 && (holders.includes(o.id) || tokenSession(t).includes(o.id))) {
      setJoinTarget({ tokenNumber: o.tokenNumber, withOrderId: holders.includes(o.id) ? o.id : holders[0] });
      setToken(null);
    } else {
      setJoinTarget(null);
      if (t?.state === 'available') setToken(o.tokenNumber);
      if (cart.lines.length === 0) setCart(setServiceMode(cart, 'takeaway'));
    }
    if (!busy) setStage({ kind: 'idle' });
  }

  /**
   * 待登记收款卡上的「加单」：一张账单可能跨两轮占用（上一轮的单已出餐、牌又被这桌占着），
   * 优先用仍占着牌的那张单，否则会误以为牌已给了别人。
   */
  function startAddOnFromCard(o: UnpaidOrder) {
    const root = o.addOnToOrderId ?? o.id;
    const live = unpaid.orders.find((x) => {
      if ((x.addOnToOrderId ?? x.id) !== root || x.offline || x.stage === 'cancel_pending') return false;
      const t = board[x.tokenNumber];
      return t?.state === 'held' && (tokenHolders(t).includes(x.id) || tokenSession(t).includes(x.id));
    });
    startAddOn(live ?? o);
  }

  /** 取消加单 / 同牌加单：恢复为普通新单，重新建议新牌。 */
  function cancelAddOn() {
    setAddOnTarget(null);
    setJoinTarget(null);
    setToken(null);
  }

  /**
   * 结果弹窗的收款：加单时连同同桌还没收的单一起结；新单还没出现在待收款订阅里也算进去。
   * 取消待后厨确认的单不计。超过单次上限时新单一定在内，其余的留在「待登记收款」（more）。
   */
  function resultPayOrders(orderId: string, totalSen: number) {
    const group = resultAddOnRoot ? unpaid.orders.filter((o) => (o.addOnToOrderId ?? o.id) === resultAddOnRoot) : [];
    const rest = group.filter((o) => o.id !== orderId && o.stage !== 'cancel_pending').map((o) => ({ orderId: o.id, amountSen: o.totalSen }));
    // 新单还没出现在订阅里算要收；但它已收款、已取消或取消待确认就不算（列表里没有不等于还没同步）。
    const selfDoc = stage.kind === 'accepted' && stage.result.orderId === orderId ? lastOrder.data : null;
    const selfDone = resultPaid || unpaid.orders.find((o) => o.id === orderId)?.stage === 'cancel_pending'
      || selfDoc?.fulfillmentStatus === 'cancelled' || (selfDoc?.paymentState !== undefined && selfDoc.paymentState !== 'unpaid');
    const self = selfDone ? [] : [{ orderId, amountSen: totalSen }];
    const room = MAX_PAY_ORDERS - self.length;
    return { orders: [...rest.slice(0, room), ...self], more: Math.max(0, rest.length - room) };
  }
  const resultPay = resultStage && resultPayOrders(resultStage.kind === 'accepted' ? resultStage.orderId : resultStage.clientOrderId, resultStage.totalSen);

  /** 手选的空闲牌上一桌还没收款的最早一张单：可能是同一桌回头加点，也可能只是号码复用，所以只提示、由收银决定。 */
  const sameTableOrder = (() => {
    if (joinTarget || addOnTarget || offlineMode || !tokensFromServer || token === null || manualPick !== token) return null;
    const t = board[token];
    if (t?.state !== 'available') return null;
    const releasedAtMs = tokensQ.data.find((d) => d.number === token)?.updatedAtMs;
    if (releasedAtMs === undefined || serverNow(rt) - releasedAtMs > SAME_TABLE_WINDOW_MS) return null;
    const session = tokenSession(t);
    return unpaid.orders
      .filter((o) => session.includes(o.id) && o.stage !== 'cancel_pending' && !o.offline)
      .reduce<UnpaidOrder | null>((best, o) => (!best || o.acceptedAtMs < best.acceptedAtMs ? o : best), null);
  })();

  function submitOrder() {
    if (busy || payDisabledReason) return;
    void (offlineMode ? confirmOffline() : confirmOnline());
  }
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
        {/* 整单未混合时切换整单；已逐行混合（部分堂食部分打包）时只决定之后新加餐品的方式。 */}
        <div className="flex rounded-2xl bg-subtle p-1" role="group"
          aria-label={cartServiceMode(cart) === 'mixed' ? tr('新加餐品的就餐方式', 'Service for new items') : tr('就餐方式', 'Service')}>
          {(['dine_in', 'takeaway'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={cart.serviceMode === m} onClick={() => setCart(setServiceMode(cart, m))}
              className={`flex h-14 items-center gap-2 rounded-xl px-3 text-lg font-bold 2xl:px-4 ${cart.serviceMode === m ? 'bg-card shadow' : 'text-ink-2'}`}>
              <Icon name={m === 'dine_in' ? 'table' : 'bag'} size={28} />{m === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway')}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setPickerOpen(true)} aria-haspopup="dialog"
          className={`flex h-14 shrink-0 items-center gap-2.5 rounded-2xl border px-3 2xl:gap-3 2xl:px-4 ${joinTarget ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-card'}`}>
          {joinTarget
            ? <span className="text-sm font-semibold">{tr('同牌加单', 'Same token')}</span>
            : <span className="text-sm text-ink-2">{tr('餐牌', 'Token')}</span>}
          <b className="text-3xl tabular-nums">{orderToken ?? tr('满', 'Full')}</b>
          <span className="text-left text-[11px] leading-tight text-ink-2"><b className="block text-[13px] text-ink">{counts.available}</b>{tr('个可用', 'free')}</span>
          <Icon name="chevron-down" size={18} />
        </button>
        <button type="button" onClick={() => setExtraSheet({ orderId: null })} aria-haspopup="dialog"
          className="flex h-14 shrink-0 items-center rounded-2xl border-2 border-brand bg-brand-soft px-2.5 font-bold whitespace-nowrap text-brand">
          {tr('＋加料', '+ Extra')}
        </button>
        <button type="button" onClick={() => setPayListOpen(true)} aria-haspopup="dialog"
          className={`flex min-h-14 shrink-0 items-center gap-2 rounded-2xl px-3 text-left ${unpaid.orders.length ? 'bg-warn-bg text-warn' : 'border border-line bg-card text-ink-2'}`}>
          <Icon name="wallet" size={24} />
          <span className="leading-tight"><span className="block text-[12px] font-semibold">{tr('待登记收款', 'To record')}</span>
            <b className="tabular-nums">{tr(`${unpaid.orders.length} 单 · ${formatRM(unpaid.totalSen)}`, `${unpaid.orders.length} · ${formatRM(unpaid.totalSen)}`)}</b></span>
        </button>
        {counts.awaiting_return > 0 && (
          <button type="button" onClick={() => setPickerOpen(true)} className="min-h-14 shrink-0 rounded-xl bg-warn-bg px-3 text-sm font-semibold text-warn">
            {tr(`${counts.awaiting_return} 个旧版待回收`, `${counts.awaiting_return} legacy to collect`)}
          </button>
        )}
        {!offlineMode && <KitchenHealthBadge lastSeenMs={opsStatus.data?.kitchenLastSeenAtMs ?? null} tickets={queueQ.data} />}
        {slipOn && <PrinterChip />}
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
              <b>{tr(`${op.summary.tokenNumber}号 · ${formatRM(op.summary.totalSen)}：下单结果未确认，正在核对；请勿重复下单。请问厨房是否收到这张单。`, `No. ${op.summary.tokenNumber} · ${formatRM(op.summary.totalSen)}: order result unconfirmed, checking. Do NOT re-submit. Ask the kitchen if they got it.`)}</b>
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
                <Icon name="clock" size={16} />{tr('后厨制作中', 'Cooking now')} <b className="text-ink">{queueQ.data.length}</b> {tr('单', '')}
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
            <CartPanel menu={menu} cart={cart} totals={totals} tokenNumber={orderToken} tokenShared={Boolean(joinTarget)} editingLineId={editingLineId}
              banner={joinTarget ? (
                <div role="status" className="mx-4 mb-2 flex items-center gap-2 rounded-xl border border-brand bg-brand-soft px-3 py-2 text-sm text-brand xl:mx-5">
                  <Icon name="plus" size={22} />
                  <span className="min-w-0 flex-1">
                    <b>{tr(`同牌加单 · ${joinTarget.tokenNumber} 号`, `Same-token add-on · No. ${joinTarget.tokenNumber}`)}</b>
                    <span className="block text-xs">{tr('不用再给牌', 'No new token needed')}</span>
                    <span className="block text-xs">{addOnTarget
                      ? tr(`票号 ${addOnTarget.ticketNo} · 送厨后与原单一起结账`, `Receipt ${addOnTarget.ticketNo} · paid together with the original`)
                      : tr(`和 ${joinTarget.tokenNumber} 号这桌合并算钱，已收的不会再收`, `Billed together with token ${joinTarget.tokenNumber}'s table; anything already paid is not charged again`)}</span>
                  </span>
                  <button type="button" onClick={cancelAddOn} className="min-h-14 shrink-0 px-2 font-semibold underline underline-offset-4">{tr('取消加单', 'Cancel add-on')}</button>
                </div>
              ) : addOnTarget ? (
                <div role="status" className="mx-4 mb-2 flex items-center gap-2 rounded-xl border border-brand bg-brand-soft px-3 py-2 text-sm text-brand xl:mx-5">
                  <Icon name="bag" size={22} />
                  <span className="min-w-0 flex-1">
                    <b>{tr(`加单 · 原餐牌 ${addOnTarget.tokenNumber}`, `Add-on · token ${addOnTarget.tokenNumber}`)}</b>
                    <span className="block text-xs">{tr(`票号 ${addOnTarget.ticketNo} · 送厨后与原单一起结账`, `Receipt ${addOnTarget.ticketNo} · paid together with the original`)}</span>
                  </span>
                  <button type="button" onClick={cancelAddOn} className="min-h-14 shrink-0 px-2 font-semibold underline underline-offset-4">{tr('取消加单', 'Cancel add-on')}</button>
                </div>
              ) : sameTableOrder && (
                <div role="status" className="mx-4 mb-2 flex items-center gap-2 rounded-xl border border-brand bg-brand-soft px-3 py-2 text-sm text-brand xl:mx-5">
                  <span className="min-w-0 flex-1 font-semibold">{tr(
                    `${sameTableOrder.tokenNumber} 号上一桌（票号 ${sameTableOrder.ticketNo} · ${formatRM(sameTableOrder.totalSen)}）还没收款。是同一桌？`,
                    `Token ${sameTableOrder.tokenNumber}'s last table (receipt ${sameTableOrder.ticketNo} · ${formatRM(sameTableOrder.totalSen)}) is still unpaid. Same table?`,
                  )}</span>
                  <button type="button" onClick={() => startAddOn(sameTableOrder)} className="h-14 shrink-0 rounded-xl bg-brand px-3 font-bold text-white">{tr('并到一起算', 'Bill together')}</button>
                </div>
              )}
              onEdit={editLine} onQuantity={changeQuantity} onServiceMode={(id, m) => setCart(setLineServiceMode(cart, id, m))} onClear={clearCart}
              onPay={() => { setCartOpen(false); submitOrder(); }} payDisabledReason={busy ? tr('正在送单…', 'Sending…') : payDisabledReason}>
              {stage.kind === 'submitting' && <p className="mt-2 text-center text-sm text-warn">{tr('正在送单，请勿重复点击。', 'Sending — do not tap again.')}</p>}
              {stage.kind === 'unknown' && <p className="mt-2 text-center text-sm font-semibold text-warn">{tr('下单结果未确认，正在核对；请勿重复下单。', 'Result unconfirmed, checking. Do not re-submit.')}</p>}
              {payError && <p role="alert" className="mt-2 text-center text-sm font-semibold text-danger">{payError}</p>}
              {stage.kind === 'rejected' && (
                <div role="alert" className="mt-2 rounded-xl border-2 border-danger bg-danger-bg p-3 text-danger">
                  <b>{tr('云端未接单：', 'Not accepted: ')}{stage.reason}</b>
                  <p className="text-sm">{tr('这次没有生成订单、没有送厨。修正后再下单。', 'No order was created or sent. Fix and submit again.')}</p>
                  <button type="button" onClick={() => setStage({ kind: 'idle' })} className="mt-1 h-11 rounded-lg border border-danger bg-card px-3 font-semibold">{tr('知道了', 'OK')}</button>
                </div>
              )}
            </CartPanel>
          </div>
        </aside>
      </div>

      {undo && (
        <div role="status" className="fixed bottom-40 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-ink px-4 py-2 whitespace-nowrap text-white shadow-xl md:top-2 md:right-4 md:bottom-auto md:left-auto md:translate-x-0">
          {undo.label}
          <button type="button" onClick={() => { setCart(undo.cart); setUndo(null); if (editingLineId) resetDraftOptions(); setEditingLineId(null); }} className="h-14 rounded-xl border border-white/40 px-5 font-semibold">{tr('撤销', 'Undo')}</button>
        </div>
      )}

      <div className="flex shrink-0 items-stretch gap-2 border-t border-line bg-card p-2 md:hidden">
        <button type="button" onClick={() => setCartOpen(true)} aria-expanded={cartOpen} className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line px-3 text-left">
          <span className="font-bold">{tr('本单', 'Order')} {totals.portionCount} {tr('份', 'pcs')} · {formatRM(totals.totalSen)}</span>
          <span className="ml-auto text-sm text-ink-2">{tr('查看 / 修改', 'View / edit')}</span>
        </button>
        <button type="button" onClick={() => submitOrder()} disabled={Boolean(payDisabledReason) || busy}
          className="flex min-h-14 shrink-0 items-center gap-1.5 rounded-xl bg-ok px-4 text-lg font-bold text-white disabled:bg-control">{tr('下单送厨', 'Send')}<span className="sr-only"> {formatRM(totals.totalSen)}</span><Icon name="arrow" size={20} /></button>
      </div>

      {receipt && <ReceiptDialog receiptKey={receipt.key} load={receipt.load} menuVersion={menu.version} timeZone={config.timeZone} onClose={() => setReceipt(null)} />}
      {pickerOpen && (
        <TokenPicker board={board} current={orderToken} onRelease={releaseTokenAction} onClose={() => setPickerOpen(false)}
          onPick={(n) => { setJoinTarget(null); setToken(n); setManualPick(n); }}
          onJoin={(n, id) => { setAddOnTarget(null); setJoinTarget({ tokenNumber: n, withOrderId: id }); setToken(null); }}
          joinDisabledReason={offlineMode ? joinOfflineReason : null} />
      )}
      {payListOpen && <PendingPaymentsDrawer onClose={() => setPayListOpen(false)} nameOf={(c) => lineName(menu, c, lang)} onAddOn={startAddOnFromCard}
        onExtra={(o) => { setPayListOpen(false); setExtraSheet({ orderId: o.id }); }} />}
      {extraSheet && (
        <ExtraSheet menu={menu} board={board} lastIssued={lastIssued} initialOrderId={extraSheet.orderId} blockedReason={extraBlocked}
          onClose={() => setExtraSheet(null)} onSend={sendExtra} />
      )}
      {resultProps && resultOpen && !receipt && (
        <OrderResultDialog {...resultProps} onClose={() => setResultOpen(false)}
          onAddSameToken={stage.kind === 'accepted' && !(stage.extraOnly && (cart.lines.length > 0 || addOnTarget || joinTarget)) ? () => {
            // 本机餐牌可能还没收到刚下的单：先用牌上已有的同桌单作锚点，避免误判「牌已给了别人」。
            const n = stage.result.tokenNumber;
            const t = board[n];
            const holders = tokenHolders(t);
            const anchor = holders.includes(stage.result.orderId) || tokenSession(t).includes(stage.result.orderId) || !stage.result.sharedToken || holders.length === 0
              ? stage.result.orderId : holders[0];
            setResultOpen(false);
            setAddOnTarget(null);
            setJoinTarget({ tokenNumber: n, withOrderId: anchor });
            setToken(null);
          } : undefined}
          onExtra={stage.kind === 'accepted' && !stage.extraOnly ? () => {
            setResultOpen(false);
            setExtraSheet({ orderId: stage.result.orderId });
          } : undefined}
          extra={resultStage && resultPay && (resultPay.orders.length > 0 || resultPaid) && (
            <QuickPay key={resultStage.kind === 'accepted' ? resultStage.orderId : resultStage.clientOrderId}
              orders={resultPay.orders} more={resultPay.more} paid={resultPaid && resultPay.orders.length === 0} paidSen={resultStage.totalSen}
              label={resultStage.kind === 'accepted' ? `${resultStage.receiptNumber} · ${tr('原餐牌', 'token')} ${resultStage.tokenNumber}` : `${resultStage.offlineReceiptNumber} · ${tr('原餐牌', 'token')} ${resultStage.tokenNumber}`} />
          )} />
      )}
    </div>
  );
}

/** 排队中的电子单超过告警时间还没有后厨回执（已递纸单的不算）时，「后厨已连接」换成未收到提示；刚下的单有几秒回执时间，不算未收到。 */
function KitchenHealthBadge({ lastSeenMs, tickets }: { lastSeenMs: number | null; tickets: { acceptedAtEffectiveMs: number; kitchenAckAtMs?: number | null; manualHandoffAtMs?: number | null }[] }) {
  useNow(5000);
  const rt = useOfflineRuntime();
  const tr = useT();
  const now = serverNow(rt);
  const h = kitchenHealth(lastSeenMs, now);
  const unacked = tickets.filter((t) => t.kitchenAckAtMs == null && !t.manualHandoffAtMs && now - t.acceptedAtEffectiveMs >= DEFAULT_KITCHEN_LINK.ackAlarmMs).length;
  if (h === 'online' && unacked > 0) return <span className="inline-flex items-center whitespace-nowrap rounded-lg bg-danger-bg px-2.5 py-1.5 text-[13px] font-semibold text-danger">{tr(`${unacked} 张单后厨未收到`, `${unacked} not received by kitchen`)}</span>;
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
      <Icon name="register" size={56} />
      <h2 className="mt-2 text-2xl font-bold">{tr('开始营业（开班）', 'Start trading (open shift)')}</h2>
      <p className="mt-1 text-ink-2">{tr('不需要输入备用金。开班需要联网，用于确认主收银机与营业日；开班后这台收银机断网也能接单（最多 24 小时）。', 'No float needed. Opening needs internet to confirm the main register and business day; afterwards this register can take orders offline for up to 24 h.')}</p>
      {err && <p role="alert" className="mt-2 text-danger">{err}</p>}
      <button type="button" disabled={busy || !reg.claim}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await submit('openShift', { operationId: newOperationId(), ...reg.claim! });
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
