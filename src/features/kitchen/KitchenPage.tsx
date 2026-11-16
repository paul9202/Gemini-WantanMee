/**
 * 后厨 KDS（02 §5；运营重设计 2026-10-23 §4/§5/§7）：顶部制作中合计（细面 / 面薄 / 云吞 / 口味），
 * 下方单一「制作中 / 待出餐」工作区，按排队位置先后（普通单即接单先后）。新电子单接单即自动进入制作中，没有日常「开始制作」步骤；
 * 旧 queued 单同样在此区域，可直接出餐。
 * 餐牌、堂食/打包、接单至今时间、面种份量、特殊要求、动作按钮都在固定位置。
 * 收到非缓存厨单才发送「后厨已收到」回执；断网或数据来自缓存时冻结操作并提示画面可能过期。
 * 取消待确认单冻结：不能正常出餐，只能由后厨确认「未做」或「已下锅/已用料」；确认后餐牌（同牌没有别的单时）自动释放。
 * 面种放在每行最前面：面薄约占一成，容易凭习惯煮成细面，所以整行蓝底大字，卡片与合计也单独标出。
 * 同牌加单：同一张餐牌可挂多单。加单排在同桌原位，同桌的单放进一个粗框，可逐张或「全部出餐」（30 秒内可全部撤回）；
 * 顶部横幅提醒还没点「知道了」的加单，提示音最多响 3 次；旧单没有排队字段，不进框，卡片上标出同牌还有几单。出餐 / 撤回提示带票号区分。
 * 下单后加料（extraOnly）：一张小卡，只写加什么、给哪一碗，不按面种排版；排在那碗的位置，同组就进同一个框。卡上的送法横幅按同组还有没有没出的碗实时算，不存状态。提醒和提示音同加单。
 * 金额（出餐即记收款 2026-11-07）：卡片在牌号旁大字写这张单要收多少（送餐时照着收）；出餐前已在前台付了的写「已付 · 不用收」；
 * 更新前就在排队的旧单没有金额，写「RM —」照旧问收银。同牌框上只写一个「合计」（不写「共收」），卡里改小字，避免两边相加；
 * 加料有自己的卡和金额，碗卡不重复写（框上的合计已含加料）。金额只从厨单 totalSen / paidBeforeServe 计算，没有单价、成本、付款方式。
 * 老板开了「出餐即记收款」时，按「完成出餐」由服务器顺带记收款；底部提示条写服务器实际记下的金额（autoPaidSen），30 秒内撤回出餐，收款一起撤回。
 * 开关关着时服务器不记收款、返回 0，提示条只说已出餐。后厨没有单独的「确认收款」按钮。
 * 后厨路由没有 Shell：在本页提供更新入口；打开期间保持屏幕常亮。
 * 手动补打送餐单（2026-11-16）：这台平板连着送餐单打印机、全店开着送餐单打印、登录的是老板或收银时，每张卡上有「补打」，
 * 按订单现在的内容再打一张（改过的单打最近一次改单那张）。后厨账号看不到订单单价，没有这个按钮。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, disableNetwork, doc, enableNetwork, getDoc, query, where } from 'firebase/firestore';
import { businessDateOf } from '../../domain/businessDay';
import {
  arrangeKitchen, formatNoodleBalls, kitchenAmount, kitchenFrameTotal, KitchenLine, kitchenLineMode, kitchenRM, kitchenSenPlain, KitchenTicket,
  sortFifo, summarizeKitchen,
} from '../../domain/kitchen';
import { formatClock, kitchenUrgency } from '../../domain/timing';
import { UNDO_SERVE_WINDOW_MS } from '../../domain/orderLifecycle';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useLiveQuery, useNow, useOnline } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { useSession } from '../../app/session';
import { useHeartbeat } from '../../data/heartbeat';
import { navigate } from '../../app/router';
import { applyUpdate, useSwState } from '../../app/swUpdate';
import { Icon, Photo, PictoArt } from '../../ui/visual';
import { Lang, useLang, useT } from '../../app/i18n';
import { lineNameEn, LineConfig } from '../../domain/lineItem';
import { MENU_V1, OrderServiceMode, SAUCE_NAMES, SERVICE_MODE_NAMES, ServiceMode } from '../../domain/menu';
import { linePictograms, PICTOGRAMS } from '../../domain/pictograms';
import { addOnCount, hasNoCharSiew, hasNoTomato, noteFreeText } from '../../domain/lineItem';
import { useKdsTheme, useNewTicketChime, useScreenWakeLock } from './prefs';
import { UpdateNotice, UpdatesDialog } from '../updates/UpdatesPage';
import { menuForVersion, useMenu } from '../../data/menu';
import { printer, slipPrintingOn, usePrinter } from '../../data/printer/printer';
import { buildRunnerSlip, manualSlip, OrderSlipView } from '../../domain/runnerSlip';
import { AmendLine, amendSettlement, UNDO_AMEND_WINDOW_MS } from '../../domain/amend';
import { AmendSheet, KitchenCancelDialog, ticketLines } from './AmendSheet';

/** 改单字段（2026-11-16）：priorPaidSen 改单前客人已付（收过钱又改了金额）；amendMarks 每行改过 / 新加；amendSummary 改了什么。 */
type Ticket = KitchenTicket & {
  id: string; kitchenAckAtMs: number | null; cancelReason?: string | null; routedFromManual?: boolean; manualHandoffAtMs?: number | null; receiptNumber?: string | null;
  priorPaidSen?: number | null; amendCount?: number; amendedAtMs?: number; amendMarks?: Record<string, 'mod' | 'add'>; amendSummary?: string; amendUndo?: boolean;
};
type AmendResult = { version: number; fromTotalSen: number; totalSen: number; paymentReversedSen: number; priorPaidSen: number | null; summary: string };
/** 刚改好的单：30 秒内可以撤回（带着改前的内容再改一次）。收过钱又改了金额的不给撤回（钱已经重算）。 */
type AmendUndo = { orderId: string; token: number; prev: AmendLine[]; prevTotal: number; version: number; at: number; fromTotalSen: number; totalSen: number };
// 不再提供 startOrder：新单接单即制作中，旧 queued 单也直接出餐。撤回走 undoServed。
type Action = 'serveOrder' | 'confirmKitchenCancel' | 'rejectKitchenCancel';
type ActExtra = { consumed?: boolean; reason?: string };
/** autoPaidSen：服务器出餐时实际记下的收款（开关关着、已付或当天已结账时为 0）。 */
type UndoItem = { orderId: string; token: number; receipt: string | null; version: number; autoPaidSen: number };
/** 出餐 / 撤回的返回：旧版服务器没有金额字段，按 0 处理。 */
type ServeResult = { version: number; autoPaidSen?: number };
type UndoResult = { version: number; autoPaymentReversedSen?: number };
const senOf = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);
const sumAutoPaid = (items: UndoItem[]) => items.reduce((s, i) => s + i.autoPaidSen, 0);
/** 拒绝取消的可选简短原因。 */
const REJECT_REASONS: [string, string][] = [['已送餐，顾客仍要', 'Already served, customer keeps it'], ['顾客改主意，仍要', 'Customer changed mind, keeps it']];
type TicketRef = { id: string; version: number; tokenNumber: number; receiptNumber?: string | null };

export function KitchenPage() {
  const { config, member, deviceId, signOut } = useSession();
  const online = useOnline();
  const now = useNow();
  const q = useLiveQuery<Ticket>(
    query(collection(db, storePath('kitchenTickets')), where('kitchenRouting', '==', 'digital'), where('fulfillmentStatus', 'in', ['queued', 'preparing'])),
    'kds',
  );
  // 离线补同步的人工单：只显示数量，不混入待下锅合计，也不自动重做。
  const manualQ = useLiveQuery<{ fulfillmentStatus: string }>(
    query(collection(db, storePath('kitchenTickets')), where('kitchenRouting', '==', 'manual'), where('fulfillmentStatus', 'in', ['queued', 'preparing'])),
    'kds-manual',
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 不是错误的提示（例如「已撤回出餐和收款」），几秒后自动收起。
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  // 全部出餐一次可撤回多张；servedAt 取最早一张的时间，倒计时不会超过任何一张的撤回时限。
  const [undo, setUndo] = useState<{ items: UndoItem[]; servedAt: number } | null>(null);
  // 改单：打开时记下那一刻的版本，交的时候用它（期间别人改过 / 出餐了，服务器会拒绝，不会盖掉别人的改动）。
  const [amending, setAmending] = useState<{ id: string; version: number } | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [amendUndo, setAmendUndo] = useState<AmendUndo | null>(null);
  const menu = useMenu(config?.activeMenuVersion);
  // 手动补打送餐单：只有连着打印机的老板 / 收银平板（后厨账号读不到订单单价）。
  const front = member?.role === 'owner' || member?.role === 'cashier';
  const slipOn = slipPrintingOn(config) && front;
  const printerState = usePrinter(slipOn);
  const canReprint = slipOn && printerState.settings.enabled;
  const [reprinting, setReprinting] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const acked = useRef(new Set<string>());
  // 已点「知道了」的同牌加单 / 加料：只存内存，刷新后重新提醒。
  const [notedAddOns, setNotedAddOns] = useState<ReadonlySet<string>>(() => new Set());
  const tr = useT();
  const lang = useLang();
  const [theme, toggleTheme] = useKdsTheme();
  // 更新记录在当前页上打开面板：不离开厨单，新单提示音和回执继续工作。
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const sw = useSwState();
  useHeartbeat(deviceId, true);
  useScreenWakeLock();

  // 浏览器显示「已联网」不代表数据已更新：必须收到服务器快照才解除冻结。
  // Firestore 在出餐后核对移出队列的单时会短暂（<1 秒）标记 fromCache；持续 1.5 秒以上才算过期，断网则立即冻结。
  const [cacheStale, setCacheStale] = useState(false);
  useEffect(() => {
    if (!q.fromCache) {
      setCacheStale(false);
      return;
    }
    const t = setTimeout(() => setCacheStale(true), 1500);
    return () => clearTimeout(t);
  }, [q.fromCache]);
  const stale = cacheStale || (q.fromCache && q.loading) || !online;
  // 同桌的单一组；单张单自成一组。合计按单计，不受分组影响。
  const groups = arrangeKitchen(q.data);
  const tickets = groups.flatMap((g) => g.tickets);
  // 单一工作区：全部未出餐电子单（含旧 queued），取消待确认单留在原位但冻结。
  const working = tickets;
  // 同牌加单：同一餐牌号在工作区里有几张未出餐单（含取消待确认），卡片上提示「同牌 k 单」。
  const queuedIds = new Set(working.map((t) => t.id));
  const tokenCounts = new Map<number, number>();
  for (const t of working) tokenCounts.set(t.tokenNumber, (tokenCounts.get(t.tokenNumber) ?? 0) + 1);
  const openIds = working.filter((t) => !t.kitchenCancelRequested).map((t) => t.id);
  const newIds = useMemo(() => openIds, [openIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  // 还没点「知道了」的同牌加单和加料（取消待确认的不提醒，卡片上已有冻结提示），最早的在前。
  const addOns = sortFifo(working.filter((t) => (t.sharedToken || t.extraOnly) && !t.kitchenCancelRequested && !notedAddOns.has(t.id)));
  const addOnIds = addOns.map((t) => t.id);
  const repeatIds = useMemo(() => addOnIds, [addOnIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const sound = useNewTicketChime(newIds, !q.fromCache && !q.loading, repeatIds);

  // 只对来自服务器（非缓存）的厨单回执一次。
  useEffect(() => {
    if (q.fromCache) return;
    for (const t of tickets) {
      if (t.kitchenAckAtMs == null && !q.pendingIds.has(t.id) && !acked.current.has(t.id)) {
        acked.current.add(t.id);
        submit('ackKitchenTicket', { operationId: newOperationId(), orderId: t.id, deviceId }).catch(() => acked.current.delete(t.id));
      }
    }
  }, [tickets, q.fromCache, q.pendingIds, deviceId]);

  async function act(name: Action, t: TicketRef, extra: ActExtra = {}) {
    if (busyId) return; // 防止连点：同一时间只处理一张单
    if (name === 'confirmKitchenCancel' && typeof extra.consumed !== 'boolean') return; // 服务器要求明确 consumed
    setBusyId(t.id);
    setMessage(null);
    setNotice(null);
    try {
      const r = await submit<ServeResult>(name, { operationId: newOperationId(), orderId: t.id, expectedVersion: t.version, ...extra });
      if (name === 'serveOrder') {
        setUndo({ items: [{ orderId: t.id, token: t.tokenNumber, receipt: t.receiptNumber ?? null, version: r.version, autoPaidSen: senOf(r.autoPaidSen) }], servedAt: Date.now() });
      }
    } catch (e) {
      setMessage(failureText(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 改单 / 撤回改单：交整张新的清单，金额由服务器重算后比对。undoOf：撤回时传刚才那次的记录。
   * 成功后关掉改单页；没动到钱的改单给 30 秒撤回。
   */
  async function submitAmend(orderId: string, version: number, lines: AmendLine[], totalSen: number, undoOf: AmendUndo | null = null) {
    if (busyId || !config) return;
    const before = tickets.find((x) => x.id === orderId);
    setBusyId(orderId);
    setMessage(null);
    setNotice(null);
    try {
      const r = await submit<AmendResult>('amendOrder', {
        operationId: newOperationId(), orderId, expectedVersion: version, menuVersion: config.activeMenuVersion, lines, expectedTotalSen: totalSen, ...(undoOf ? { undo: true } : {}),
      });
      setAmending(null);
      if (undoOf) {
        setAmendUndo(null);
        setNotice(tr(`${undoOf.token} 号已撤回改单 · 回到 ${kitchenRM(r.totalSen)}`, `No. ${undoOf.token} edit undone · back to ${kitchenRM(r.totalSen)}`));
        return;
      }
      if (before && r.paymentReversedSen === 0) {
        setAmendUndo({ orderId, token: before.tokenNumber, prev: ticketLines(before), prevTotal: r.fromTotalSen, version: r.version, at: Date.now(), fromTotalSen: r.fromTotalSen, totalSen: r.totalSen });
      } else {
        setAmendUndo(null);
        const s = amendSettlement(r.totalSen, r.priorPaidSen);
        setNotice(s?.refundSen ? tr(`${before?.tokenNumber ?? ''} 号改好了 · 收银机会提示退 ${kitchenRM(s.refundSen)} 给客人`, `Saved · front will refund ${kitchenRM(s.refundSen)}`)
          : s?.collectSen ? tr(`${before?.tokenNumber ?? ''} 号改好了 · 收银机会提示补收 ${kitchenRM(s.collectSen)}`, `Saved · front will collect ${kitchenRM(s.collectSen)} more`)
            : tr('改好了', 'Saved'));
      }
    } catch (e) {
      const stale = e instanceof CommandFailure && e.reasonCode === 'STALE_VERSION';
      setMessage(stale ? tr('这张单刚刚被改过或出餐了：请关掉重新打开再改', 'This order just changed: close and open it again') : failureText(e));
    } finally {
      setBusyId(null);
    }
  }

  async function kitchenCancel(t: Ticket, reason: string, consumed: boolean) {
    if (busyId) return;
    setBusyId(t.id);
    setMessage(null);
    setNotice(null);
    try {
      await submit('kitchenCancelOrder', { operationId: newOperationId(), orderId: t.id, expectedVersion: t.version, reason, consumed });
      setCancelling(null);
      setAmending(null);
      if (amendUndo?.orderId === t.id) setAmendUndo(null);
      setNotice(tr(`${t.tokenNumber} 号已取消 · ${reason}`, `No. ${t.tokenNumber} cancelled`));
    } catch (e) {
      setMessage(failureText(e));
    } finally {
      setBusyId(null);
    }
  }

  /** 全部出餐：逐张出餐（跳过取消待确认），第一张失败就停。不走 act，整个过程占住 busyId，其他按钮都不可点。 */
  async function serveAll(group: Ticket[]) {
    if (busyId) return;
    const served: UndoItem[] = [];
    let servedAt = 0;
    setMessage(null);
    setNotice(null);
    try {
      for (const t of group.filter((x) => !x.kitchenCancelRequested)) {
        setBusyId(t.id);
        const r = await submit<ServeResult>('serveOrder', { operationId: newOperationId(), orderId: t.id, expectedVersion: t.version });
        servedAt ||= Date.now();
        served.push({ orderId: t.id, token: t.tokenNumber, receipt: t.receiptNumber ?? null, version: r.version, autoPaidSen: senOf(r.autoPaidSen) });
      }
    } catch (e) {
      const reason = failureText(e);
      // 只写服务器真正记下的金额：送餐的人据此知道已出的几张记了多少，没出的照卡片另收。
      const paid = sumAutoPaid(served);
      const paidZh = paid > 0 ? `（已记收款 ${kitchenRM(paid)}）` : '';
      const paidEn = paid > 0 ? ` (${kitchenRM(paid)} recorded as paid)` : '';
      setMessage(served.length ? tr(`已出餐 ${served.length} 张${paidZh}，其余没有出餐：${reason}`, `${served.length} served${paidEn}, the rest were not: ${reason}`) : reason);
    } finally {
      if (served.length) setUndo({ items: served, servedAt });
      setBusyId(null);
    }
  }

  /** 撤回最近一次出餐（全部出餐则逐张撤回），第一张失败就停；多张时没撤回的留在提示条上，时限内可再试。 */
  async function undoServed() {
    if (busyId || !undo) return;
    let done = 0;
    let reversed = 0;
    setMessage(null);
    setNotice(null);
    try {
      for (const item of undo.items) {
        setBusyId(item.orderId);
        const r = await submit<UndoResult>('undoServe', { operationId: newOperationId(), orderId: item.orderId, expectedVersion: item.version });
        reversed += senOf(r.autoPaymentReversedSen);
        done++;
      }
      setUndo(null);
      // 收款跟着撤回时明确说一声：单回到「未收款」，送餐时照卡片收。
      if (reversed > 0) setNotice(tr(`已撤回出餐和收款 · ${kitchenRM(reversed)}`, `Serve and payment undone · ${kitchenRM(reversed)}`));
    } catch (e) {
      // 撤回失败（含 TOKEN_REASSIGNED：餐牌已给新单）只显示原因，不尝试换牌；换牌只能由前台/老板明确执行。
      const reason = failureText(e);
      const revZh = reversed > 0 ? `（收款也已撤回 ${kitchenRM(reversed)}）` : '';
      const revEn = reversed > 0 ? ` (payment ${kitchenRM(reversed)} undone too)` : '';
      setMessage(done ? tr(`已撤回 ${done} 张${revZh}，其余没有撤回：${reason}`, `${done} undone${revEn}, the rest were not: ${reason}`) : reason);
      setUndo(undo.items.length > 1 ? { ...undo, items: undo.items.slice(done) } : null);
    } finally {
      setBusyId(null);
    }
  }

  /** 知道了：只关提醒和剩余的提示音，然后滚到这张单所在的框。 */
  function noteAddOn(t: Ticket) {
    setNotedAddOns((prev) => new Set(prev).add(t.id));
    const key = groups.find((g) => g.tickets.includes(t))?.key;
    // 等横幅收起、版面稳定后再滚动。
    requestAnimationFrame(() => document.getElementById(`kds-group-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  /** 强制 Firestore 重新建立连接；是否恢复以服务器快照为准。 */
  /** 按订单现在的内容再打一张送餐单。打印出任何问题都只提示，不影响出餐。 */
  async function reprintSlip(t: Ticket) {
    if (!config || reprinting) return;
    setReprinting(t.id);
    setMessage(null);
    try {
      const snap = await getDoc(doc(db, storePath(`orders/${t.id}`)));
      const o = snap.data() as (OrderSlipView & { menuVersion: string }) | undefined;
      if (!o) throw new Error('NO_ORDER');
      const m = menu?.version === o.menuVersion ? menu : (await menuForVersion(o.menuVersion)) ?? menu;
      if (!m) throw new Error('NO_MENU');
      const { key, source } = manualSlip(t.id, o, t);
      const slip = buildRunnerSlip(m, source, { timeZone: config.timeZone, printIndex: 0 });
      const ref = o.receiptNumber ? `#${o.receiptNumber}` : `${o.tokenNumber} 号`;
      const r = printer.printNow(key, slip, `${ref} · 后厨补打`);
      const linked = printer.getState().link === 'ready';
      setNotice(r === 'already'
        ? tr(`${t.tokenNumber} 号的送餐单已经在排着打`, `No. ${t.tokenNumber}'s slip is already queued`)
        : r === 'off'
          ? tr('这台平板没连送餐单打印机', 'This tablet has no slip printer')
          : linked
            ? tr(`${t.tokenNumber} 号送餐单补打中，去出餐口拿`, `Reprinting No. ${t.tokenNumber}'s slip at the pass`)
            : tr(`${t.tokenNumber} 号已排上，打印机连上就打`, `No. ${t.tokenNumber} queued — prints when the printer connects`));
    } catch {
      setMessage(tr('补打没成功：读不到这张单，检查网络后再试', 'Reprint failed: could not load the order. Check the connection and try again.'));
    } finally {
      setReprinting(null);
    }
  }

  async function reconnect() {
    setReconnecting(true);
    try {
      await disableNetwork(db);
      await enableNetwork(db);
    } finally {
      setReconnecting(false);
    }
  }

  const sum = summarizeKitchen(tickets);
  const a = sum.active;
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const dateLabel = date ? new Intl.DateTimeFormat(lang === 'en' ? 'en-MY' : 'zh-CN', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) : '';
  // now 每秒刷新一次，可能略早于出餐时刻；显示不超过 30 秒。实际时限由服务器判断。
  const undoLeft = undo ? Math.min(UNDO_SERVE_WINDOW_MS, UNDO_SERVE_WINDOW_MS - (now - undo.servedAt)) : 0;
  const amendUndoLeft = amendUndo && tickets.some((x) => x.id === amendUndo.orderId && x.version === amendUndo.version)
    ? Math.min(UNDO_AMEND_WINDOW_MS, UNDO_AMEND_WINDOW_MS - (now - amendUndo.at)) : 0;
  const amendTicket = amending ? tickets.find((x) => x.id === amending.id) ?? null : null;
  const cancelTicket = cancelling ? tickets.find((x) => x.id === cancelling) ?? null : null;
  const iconBtn = 'flex h-14 w-14 items-center justify-center rounded-xl border border-kds-line text-kds-text hover:bg-kds-soft';

  return (
    <div className={`flex min-h-[100dvh] flex-col bg-kds text-kds-text ${theme === 'light' ? 'kds-light' : ''}`}>
      {addOns.length > 0 && <AddOnAlert t={addOns[0]} more={addOns.length - 1} onNote={() => noteAddOn(addOns[0])} />}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-kds-line px-4 py-3 sm:px-7 sm:py-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-kds-action text-2xl font-black text-kds-action-ink">豪</span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.2em] text-kds-muted">HAO · KITCHEN DISPLAY</div>
          <h1 className="text-xl font-bold leading-tight sm:text-2xl">{tr('后厨工作台', 'Kitchen')}</h1>
        </div>
        {dateLabel && <span className="hidden text-sm text-kds-muted md:inline">{dateLabel}</span>}
        <span className="ml-auto inline-flex items-center gap-2 text-sm font-semibold" role="status">
          <span className={`h-2.5 w-2.5 rounded-full ${stale ? 'bg-kds-danger' : 'bg-kds-live'}`} />
          <span className={stale ? 'text-kds-danger' : 'text-kds-live'}>{stale ? tr('连接中断', 'Disconnected') : tr('实时连接', 'Live')}</span>
        </span>
        <span className="text-2xl font-bold tabular-nums sm:text-3xl">{new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
        <button type="button" onClick={sound.toggle} aria-pressed={sound.state !== 'off'} className={`${iconBtn} relative`}
          aria-label={sound.state === 'off' ? tr('开启新单提示音', 'Turn on new-order sound') : tr('关闭新单提示音', 'Turn off new-order sound')}
          title={sound.state === 'needs_tap' ? tr('点一下屏幕后才能出声', 'Tap the screen once to allow sound') : undefined}>
          <Icon name={sound.state === 'off' ? 'mute' : 'volume'} size={22} />
          {sound.state === 'needs_tap' && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-kds-warning" />}
        </button>
        <button type="button" onClick={() => setUpdatesOpen(true)} className={iconBtn} aria-label={tr('更新记录', 'Updates')}>
          <Icon name="sparkle" size={22} />
        </button>
        <button type="button" onClick={toggleTheme} className={iconBtn} aria-label={theme === 'dark' ? tr('切换浅色', 'Light mode') : tr('切换深色', 'Dark mode')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={22} />
        </button>
        {member?.role === 'owner' && (
          <button type="button" onClick={() => navigate('/pos')} className="flex h-14 items-center gap-2 rounded-xl border border-kds-line px-4 font-bold hover:bg-kds-soft">
            <Icon name="arrow-left" size={20} />{tr('返回前台', 'Front')}
          </button>
        )}
        <button type="button" onClick={() => void signOut()} className="h-14 rounded-xl px-3 text-sm text-kds-muted hover:text-kds-text">{tr('退出', 'Sign out')}</button>
      </header>

      {stale && (
        <div role="alert" className="flex flex-wrap items-center gap-4 bg-[#723b2a] px-4 py-4 text-[#fff0e8] sm:px-7">
          <Icon name="wifi-off" size={30} />
          <div className="min-w-0 flex-1">
            <b className="text-lg">{tr('厨房连接中断，操作已暂停', 'Kitchen disconnected — actions paused')}</b>
            <p className="text-sm">{tr('画面可能已过期。请与收银核对，以人工纸单交接。', 'The screen may be out of date. Check with the cashier and use paper tickets.')}</p>
          </div>
          <button type="button" onClick={() => void reconnect()} disabled={reconnecting}
            className="flex h-14 items-center gap-2 rounded-xl bg-[#fff3ea] px-5 font-bold text-[#5a2a20] disabled:opacity-60">
            <Icon name="refresh" size={20} />{reconnecting ? tr('正在连接…', 'Connecting…') : tr('重新连接', 'Reconnect')}
          </button>
        </div>
      )}

      {updatesOpen && <UpdatesDialog onClose={() => setUpdatesOpen(false)} />}
      {amending && amendTicket && menu && (
        <AmendSheet key={amending.id} ticket={amendTicket} menu={menu} busy={busyId === amending.id} disabled={stale || (busyId !== null && busyId !== amending.id)}
          onClose={() => setAmending(null)} onCancelOrder={() => setCancelling(amending.id)}
          onSubmit={(lines, total) => void submitAmend(amending.id, amending.version, lines, total)} />
      )}
      {amending && !amendTicket && (
        // 打开期间这张单出餐 / 被取消了：改单页自己关掉并说明。
        <div role="alert" className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center gap-3 bg-kds-danger-bg px-4 py-3 text-lg font-bold text-kds-danger sm:px-7">
          {tr('这张单已经出餐或取消了，不能再改', 'This order was served or cancelled — it can no longer be changed')}
          <button type="button" onClick={() => setAmending(null)} className="ml-auto h-14 rounded-xl border-2 border-current px-5">{tr('知道了', 'Got it')}</button>
        </div>
      )}
      {cancelTicket && (
        <KitchenCancelDialog ticket={cancelTicket} busy={busyId === cancelTicket.id} disabled={stale || (busyId !== null && busyId !== cancelTicket.id)}
          onClose={() => setCancelling(null)} onConfirm={(reason, consumed) => void kitchenCancel(cancelTicket, reason, consumed)} />
      )}
      <UpdateNotice className="border-b border-kds-line bg-kds-soft px-4 py-3 sm:px-7" primaryClassName="bg-kds-action text-kds-action-ink" />
      {sw === 'update' && (
        <div role="status" className="flex flex-wrap items-center gap-4 border-b border-kds-line bg-kds-soft px-4 py-3 sm:px-7">
          <Icon name="refresh" size={26} />
          <b className="min-w-0 flex-1 text-lg">{tr('有新版本', 'New version available')}</b>
          <button type="button" disabled={busyId !== null} onClick={() => void applyUpdate()}
            className="h-14 rounded-xl bg-kds-action px-5 font-bold text-kds-action-ink disabled:opacity-50">
            {tr('更新并重新载入', 'Update & reload')}
          </button>
        </div>
      )}

      {/* 点这里或页面任何位置都能开启；按钮只是让「现在没有声音」看得见。 */}
      {sound.state === 'needs_tap' && (
        <button type="button" onClick={sound.unlock} className="flex min-h-14 items-center justify-center gap-3 bg-kds-warning-bg px-4 py-2 text-lg font-bold text-kds-warning sm:px-7">
          <Icon name="volume" size={24} />{tr('点一下开启声音', 'Tap to turn on sound')}
        </button>
      )}

      <section className="grid grid-cols-3 gap-2 px-4 pt-4 sm:gap-3 sm:px-7 sm:pt-5 lg:grid-cols-4 lg:gap-4" aria-label={tr('制作中合计', 'In-progress totals')}>
        <CountCard art={<Photo id="noodle.thin_egg" size={64} rounded={10} />} label={tr('制作中 · 细面', 'In progress · Thin')} value={balls(a.thinEggHalfUnits)} unit={tr('团', 'balls')} />
        <CountCard art={<Photo id="noodle.mee_poh" size={64} rounded={10} />} label={tr('制作中 · 面薄', 'In progress · Mee pok')} value={balls(a.meePohHalfUnits)} unit={tr('团', 'balls')} hot={a.meePohHalfUnits > 0} />
        <CountCard art={<Icon name="dumpling" size={56} />} label={tr('制作中 · 云吞', 'In progress · Wantan')} value={String(a.wantons)} unit={tr('粒', 'pcs')} />
        <div className="col-span-3 flex flex-col justify-center rounded-2xl border border-kds-line bg-kds-card px-5 py-3 lg:col-span-1">
          <div className="text-sm text-kds-muted">{tr(`口味 · 共 ${a.orders} 单`, `Flavours · ${a.orders} orders`)}</div>
          <div className="mt-1 grid grid-cols-5 gap-1 text-sm">
            {[
              [tr('黑酱', 'Black'), a.sauce.black], [tr('红酱', 'Red'), a.sauce.red], [tr('白酱', 'White'), a.sauce.white],
              [tr('汤面', 'Soup'), a.soupNoodle], [tr('云吞汤', 'W. soup'), a.wantonSoup],
            ].map(([l, v]) => (
              <span key={l as string} className={`whitespace-nowrap ${v ? '' : 'opacity-50'}`}>{l} <b className="text-lg">{v}</b></span>
            ))}
          </div>
          {a.kosong > 0 && <div className="mt-1 text-sm font-bold text-kds-warning">{tr(`其中净面 ${a.kosong} 份`, `incl. Kosong ${a.kosong}`)}</div>}
          {a.noTomato > 0 && <div className="mt-1 text-sm font-bold text-kds-warning">{tr(`其中不要番茄酱 ${a.noTomato} 份`, `incl. no tomato sauce ${a.noTomato}`)}</div>}
          {a.noCharSiew > 0 && <div className="mt-1 text-sm font-bold text-kds-warning">{tr(`其中不要叉烧 ${a.noCharSiew} 份`, `incl. no char siew ${a.noCharSiew}`)}</div>}
          {sum.cancelPending > 0 && (
            <div className="mt-1 text-sm font-bold text-kds-danger">{tr(`取消待确认 ${sum.cancelPending} 单，不计入合计`, `${sum.cancelPending} cancel request(s) pending · not in totals`)}</div>
          )}
        </div>
      </section>

      {message && <div role="alert" className="mx-4 mt-4 rounded-xl bg-kds-danger-bg px-4 py-3 text-lg text-kds-danger sm:mx-7">{message}</div>}
      {notice && <div role="status" className="mx-4 mt-4 rounded-xl bg-kds-soft px-4 py-3 text-lg font-bold sm:mx-7">{notice}</div>}

      <section className="min-w-0 flex-1 px-4 py-5 sm:px-7" aria-label={tr('制作中 / 待出餐', 'Cooking / to serve')}>
        <SectionHead title={tr('制作中 / 待出餐', 'Cooking / to serve')} count={working.length} hint={tr('先来的桌在前 · 做好点完成出餐', 'Earliest table first · tap Served when done')} />
        {q.loading && <p className="text-kds-muted">{tr('正在载入厨单…', 'Loading tickets…')}</p>}
        {!q.loading && working.length === 0 && <Empty text={tr('暂无要做的单', 'Nothing to cook')} />}
        {/* min-w-0：卡片内容再长也只在卡内换行，不撑破网格（1280 宽三栏、960 宽两栏）。 */}
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
          {groups.map((g) => {
            const cardProps = {
              now, today: date, disabled: stale || busyId !== null, onAct: act, openIds: queuedIds,
              // 改单要用当前菜单算价；菜单还没载入时先不给按钮。
              onAmend: menu ? (x: Ticket) => { setMessage(null); setAmending({ id: x.id, version: x.version }); } : undefined,
              onReprint: canReprint ? (x: Ticket) => void reprintSlip(x) : undefined,
              reprintingId: reprinting,
            };
            // 碗卡不再补「＋加料」：加料有自己的卡、自己的金额（还没出的碗和它的加料总在同一个框，框上合计已含）。
            // 两处都写同一笔，送餐的人会收两次；出餐时也只各记各的。
            const extrasOf = (_t: Ticket): Extras => NO_EXTRAS;
            if (g.tickets.length === 1) {
              const t = g.tickets[0];
              return <TicketCard key={t.id} anchorId={`kds-group-${g.key}`} t={t} sameToken={tokenCounts.get(t.tokenNumber) ?? 1} busy={busyId === t.id} extras={extrasOf(t)} {...cardProps} />;
            }
            const servable = g.tickets.filter((t) => !t.kitchenCancelRequested).length;
            return (
              <section key={g.key} id={`kds-group-${g.key}`} className="flex scroll-mt-28 flex-col gap-3 rounded-3xl border-4 border-kds-action p-2 sm:p-3" aria-label={tr(`${g.tickets[0].tokenNumber}号同牌`, `No. ${g.tickets[0].tokenNumber} together`)}>
                {/* 标题单独一行，合计和「全部出餐」在下一行：窄栏里也不会挤爆。 */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
                  <b className="w-full min-w-0 text-xl leading-tight">{tr(`${g.tickets[0].tokenNumber} 号 · 同牌 ${g.tickets.length} 张 · 一起送`, `No. ${g.tickets[0].tokenNumber} · ${g.tickets.length} tickets · serve together`)}</b>
                  <FrameTotal tickets={g.tickets} />
                  <button type="button" disabled={stale || busyId !== null || servable === 0} onClick={() => void serveAll(g.tickets)}
                    className="ml-auto h-14 shrink-0 rounded-xl bg-kds-serve px-3 text-lg font-bold text-kds-action-ink disabled:opacity-45">
                    {g.tickets.some((t) => t.id === busyId) ? tr('处理中…', 'Working…') : tr(`全部出餐（${servable} 张）`, `Serve all (${servable})`)}
                  </button>
                </div>
                {/* 框里已写明同牌，卡片不再重复「同牌 k 单」；金额改小字，送餐的人只看框上的合计。 */}
                {g.tickets.map((t) => <TicketCard key={t.id} t={t} sameToken={1} framed busy={busyId === t.id} extras={extrasOf(t)} {...cardProps} />)}
              </section>
            );
          })}
        </div>
      </section>

      <footer className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-kds-line bg-kds px-4 py-3 sm:px-7">
        <Icon name="cloud" size={22} />
        <span className="text-sm text-kds-muted">
          {stale ? tr('画面可能过期 · 不要据此制作或出餐', 'Screen may be stale — do not cook or serve from it') : tr('订单已实时更新', 'Orders are live')}
          {' · '}{tr(`人工单待核对 ${manualQ.data.length} 单（补同步订单不会自动重做）`, `${manualQ.data.length} paper ticket(s) to check (synced orders are not re-cooked)`)}
        </span>
        {amendUndo && amendUndoLeft > 0 && (
          <div role="status" className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-kds-soft px-3 py-1.5">
            <Icon name="edit" size={26} />
            <span className="text-lg"><b className="text-2xl">{amendUndo.token}</b> {tr('号改好了', 'edited')}
              {amendUndo.totalSen !== amendUndo.fromTotalSen && <> · <b className="tabular-nums">{kitchenRM(amendUndo.fromTotalSen)} → {kitchenRM(amendUndo.totalSen)}</b></>}
            </span>
            <button type="button" disabled={stale || busyId !== null} onClick={() => void submitAmend(amendUndo.orderId, amendUndo.version, amendUndo.prev, amendUndo.prevTotal, amendUndo)}
              className="h-14 rounded-xl border-2 border-kds-action px-5 font-bold text-kds-action disabled:opacity-50">
              ↶ {tr(`撤回（${Math.ceil(amendUndoLeft / 1000)}秒）`, `Undo (${Math.ceil(amendUndoLeft / 1000)} s)`)}
            </button>
          </div>
        )}
        {undo && undoLeft > 0 && (
          <div role="status" className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-kds-soft px-3 py-1.5">
            <PictoArt id="action:serve" size={32} />
            {/* 带票号：同牌多单时只是这一单出餐，不代表整张牌的单都完成。全部出餐时报张数。 */}
            <span className="text-lg"><b className="text-2xl">{undo.items[0].token}</b> {undo.items.length > 1 ? tr(`号 ${undo.items.length} 张已出餐`, `served (${undo.items.length} tickets)`) : undo.items[0].receipt ? tr(`号（票号 ${undo.items[0].receipt}）已出餐`, `served (receipt ${undo.items[0].receipt})`) : tr('号已出餐', 'served')}</span>
            {/* 写服务器真正记下的金额（不是卡片上的数）；没记收款就不提钱。 */}
            {sumAutoPaid(undo.items) > 0 && (
              <span className="text-lg">
                · {tr('已记收款', 'recorded as paid')} <b className="whitespace-nowrap text-xl font-black tabular-nums text-kds-warning">{kitchenRM(sumAutoPaid(undo.items))}</b>
              </span>
            )}
            <button type="button" disabled={stale || busyId !== null} onClick={() => void undoServed()}
              className="h-14 rounded-xl border-2 border-kds-action px-5 font-bold text-kds-action disabled:opacity-50">
              ↶ {undo.items.length > 1 ? tr(`全部撤回（${Math.ceil(undoLeft / 1000)}秒）`, `Undo all (${Math.ceil(undoLeft / 1000)} s)`) : tr(`撤回（${Math.ceil(undoLeft / 1000)}秒）`, `Undo (${Math.ceil(undoLeft / 1000)} s)`)}
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}

function failureText(e: unknown): string {
  return e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e);
}

/** 同牌加单 / 加料提醒：占自己的一行、停在页面顶部，不盖住任何出餐按钮；不点「知道了」也能照常出餐。 */
function AddOnAlert({ t, more, onNote }: { t: Ticket; more: number; onNote: () => void }) {
  const tr = useT();
  const lang = useLang();
  const mode = (m: OrderServiceMode) => tr(SERVICE_MODE_NAMES[m].zh, SERVICE_MODE_NAMES[m].en);
  const mixed = t.serviceMode === 'mixed';
  const lines = t.lines.map((l) => {
    if (t.extraOnly) return `${extraLineName(l, lang)} ×${l.quantity}${l.note ? ` · ${l.note}` : ''}`;
    const name = lang === 'en' ? lineNameEn(MENU_V1, l as unknown as LineConfig) : l.nameZh;
    return `${name} ×${l.quantity}${mixed ? ` ${mode(kitchenLineMode(t, l))}` : ''}`;
  }).join(lang === 'en' ? ', ' : '、');
  return (
    <div role="alert" className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 bg-kds-action px-4 py-2 text-kds-action-ink sm:px-7">
      <Icon name={t.extraOnly ? 'dumpling' : 'users'} size={28} />
      <b className="line-clamp-2 min-w-0 flex-1 text-xl">
        {t.extraOnly ? tr(`${t.tokenNumber} 号 加料`, `No. ${t.tokenNumber} extra`) : tr(`${t.tokenNumber} 号 加单`, `No. ${t.tokenNumber} add-on`)} · {lines}{mixed || t.extraOnly ? '' : ` · ${mode(t.serviceMode)}`}
      </b>
      {more > 0 && <span className="shrink-0 font-bold">{tr(`还有 ${more} 条`, `${more} more`)}</span>}
      <button type="button" onClick={onNote} className="h-14 shrink-0 rounded-xl border-2 border-current px-6 text-lg font-bold">{tr('知道了', 'Got it')}</button>
    </div>
  );
}

/** 半球单位 → 显示，例如 5 → 2½。 */
function balls(halfUnits: number): string {
  return formatNoodleBalls(halfUnits).replace(/\.5$/, '½').replace(/^0½$/, '½');
}

function CountCard({ art, label, value, unit, hot = false }: { art: React.ReactNode; label: string; value: string; unit: string; hot?: boolean }) {
  const muted = hot ? '' : 'text-kds-muted';
  return (
    <div className={`flex flex-col items-center gap-1 rounded-2xl border px-2 py-3 text-center sm:flex-row sm:gap-4 sm:px-5 sm:text-left ${hot ? 'border-kds-pok bg-kds-pok text-kds-pok-ink' : 'border-kds-line bg-kds-card'}`}>
      <span className="shrink-0 [&>*]:max-sm:!h-11 [&>*]:max-sm:!w-11">{art}</span>
      <div className="min-w-0">
        <div className={`text-xs sm:text-sm ${muted}`}>{label}</div>
        <div className="text-4xl font-black leading-tight tabular-nums">{value}<span className={`ml-1 text-base font-semibold ${muted}`}>{unit}</span></div>
      </div>
    </div>
  );
}

function SectionHead({ title, count, hint }: { title: string; count: number; hint: string }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="text-xl font-bold">{title}</h2>
      <span className="rounded-md bg-kds-soft px-2 py-0.5 text-sm font-bold">{count}</span>
      <span className="text-sm text-kds-muted">{hint}</span>
      <span className="h-px flex-1 bg-kds-line" />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-2xl border border-dashed border-kds-line px-5 py-10 text-center text-lg text-kds-muted">{text}</p>;
}

const URGENCY = {
  normal: { bar: 'bg-kds-soft/60', text: 'text-kds-muted', label: '正常等候', en: 'On time', border: 'border-kds-line' },
  warning: { bar: 'bg-kds-warning-bg', text: 'text-kds-warning', label: '等候较久', en: 'Waiting long', border: 'border-kds-warning/60' },
  overdue: { bar: 'bg-kds-danger-bg', text: 'text-kds-danger', label: '已超时 · 请优先处理', en: 'Overdue · do first', border: 'border-[#e0735c]' },
};

/** 同牌框合计：只写一个「合计」（不写「共收」），已付的不加；有旧单没金额就写「＋?」。全都付了写「已付 · 不用收」。 */
function FrameTotal({ tickets }: { tickets: Ticket[] }) {
  const tr = useT();
  const f = kitchenFrameTotal(tickets);
  if (f.collect === 0 && f.unknown === 0) return <PaidPill />;
  const amount = f.collect === 0 ? 'RM —' : `${kitchenRM(f.sen)}${f.unknown > 0 ? '＋?' : ''}`;
  return (
    // 22px：1280 宽三栏时框内约 350px，「合计 RM 18.00」和「全部出餐（3 张）」还能排在同一行。
    <span className={`whitespace-nowrap text-[22px] font-black leading-none tabular-nums ${f.collect === 0 ? 'text-kds-muted' : 'text-kds-warning'}`}>
      {tr('合计', 'Total')} {amount}
    </span>
  );
}

function PaidPill({ short = false, small = false }: { short?: boolean; small?: boolean }) {
  const tr = useT();
  return (
    <span className={`whitespace-nowrap rounded-lg border border-kds-live/50 bg-kds-live/20 px-2.5 py-1 font-black text-kds-live ${small ? 'text-base' : 'text-lg'}`}>
      {short ? tr('已付', 'Paid') : tr('已付 · 不用收', 'Paid · no charge')}
    </span>
  );
}

/**
 * 牌号旁的金额：单张卡大字琥珀色；框里小一号（送餐的人看框上的合计）。
 * 碗还挂着没出的加料时补「＋加料 2.00」；碗已付但加料没付，写「已付」再补加料，避免误以为整桌都不用收。
 */
function AmountTag({ t, framed, extras }: { t: Ticket; framed: boolean; extras: Extras }) {
  const tr = useT();
  const a = kitchenAmount(t);
  const extraText = extras.count > 0
    ? `＋${tr('加料', 'extra')} ${kitchenSenPlain(extras.sen)}${extras.unknown > 0 ? '＋?' : ''}`
    : extras.unknown > 0 ? `＋${tr('加料', 'extra')} ?` : null;
  const extra = extraText && <small className="ml-1 text-[15px] font-bold text-kds-warning">{extraText}</small>;
  if (a.kind === 'paid') {
    return extra ? <span className="inline-flex items-center gap-1 whitespace-nowrap"><PaidPill short small={framed} />{extra}</span> : <PaidPill small={framed} />;
  }
  if (a.kind === 'unknown') {
    return <span className={`whitespace-nowrap font-black text-kds-muted ${framed ? 'text-xl' : 'text-[28px] leading-none'}`}>RM —{extra}</span>;
  }
  // 收过钱又改了金额：客人已付过一笔，送餐时只补差额 / 退差额（收银机按新金额登记）。
  const settle = amendSettlement(a.sen, t.priorPaidSen);
  return (
    <span className={`whitespace-nowrap font-black tabular-nums text-kds-warning ${framed ? 'text-xl opacity-90' : 'text-[28px] leading-none'}`}>
      {kitchenRM(a.sen)}{extra}
      {settle && (
        <small className={`ml-1.5 text-[15px] font-bold ${settle.refundSen ? 'text-kds-danger' : 'text-kds-warning'}`}>
          {settle.refundSen ? tr(`已付 ${kitchenSenPlain(t.priorPaidSen!)} · 退 ${kitchenSenPlain(settle.refundSen)}`, `paid ${kitchenSenPlain(t.priorPaidSen!)} · refund ${kitchenSenPlain(settle.refundSen)}`)
            : settle.collectSen ? tr(`已付 ${kitchenSenPlain(t.priorPaidSen!)} · 补 ${kitchenSenPlain(settle.collectSen)}`, `paid ${kitchenSenPlain(t.priorPaidSen!)} · +${kitchenSenPlain(settle.collectSen)}`)
              : tr('已付 · 不用收', 'paid')}
        </small>
      )}
    </span>
  );
}

type Extras = { sen: number; count: number; unknown: number };
const NO_EXTRAS: Extras = { sen: 0, count: 0, unknown: 0 };

function TicketCard({ t, sameToken, now, today, disabled, busy, onAct, onAmend, onReprint, reprintingId, anchorId, openIds, framed = false, extras }: {
  /** sameToken：要在卡片上标出的同牌单数（含本单）；在框里的卡片传 1，不重复标。anchorId：提醒横幅滚动的目标。openIds：队列里还没出餐的单（加料卡据此判断那碗出了没有）。 */
  t: Ticket; sameToken: number; now: number; today: string; disabled: boolean; busy: boolean; anchorId?: string; openIds: ReadonlySet<string>;
  /** framed：在同牌框里，金额改小字。extras：这碗还挂着没出的加料金额。 */
  framed?: boolean; extras: Extras;
  onAct: (name: Action, t: TicketRef, extra?: ActExtra) => void;
  /** 打开改单（菜单没载入时为 undefined，不显示按钮）。 */
  onAmend?: (t: Ticket) => void;
  /** 补打送餐单（这台平板没连打印机时为 undefined，不显示按钮）。reprintingId：正在读哪张单。 */
  onReprint?: (t: Ticket) => void;
  reprintingId?: string | null;
}) {
  const tr = useT();
  const [rejectReason, setRejectReason] = useState<string | null>(null);
  // 出餐效率按「接单至出餐」计算；自动开始时间不是厨师实际开工，不作测量。
  const elapsed = now - t.acceptedAtEffectiveMs;
  const urgency = kitchenUrgency(elapsed);
  const u = URGENCY[urgency];
  const frozen = t.kitchenCancelRequested;
  const ofType = (type: 'mee_poh' | 'thin_egg') => t.lines.filter((l) => l.noodleType === type);
  const pokBowls = ofType('mee_poh').reduce((s, l) => s + l.quantity, 0);
  const thinBowls = ofType('thin_egg').reduce((s, l) => s + l.quantity, 0);
  const pokHalf = ofType('mee_poh').reduce((s, l) => s + l.noodleHalfUnits * l.quantity, 0);
  const thinHalf = ofType('thin_egg').reduce((s, l) => s + l.noodleHalfUnits * l.quantity, 0);
  const wantons = t.lines.reduce((s, l) => s + l.wantonCount * l.quantity, 0);
  const charSiew = t.extraOnly ? t.lines.reduce((s, l) => s + addOnCount(l, 'char_siew') * l.quantity, 0) : 0;
  const ref: TicketRef = { id: t.id, version: t.version, tokenNumber: t.tokenNumber, receiptNumber: t.receiptNumber };
  // 只有人工开工（旧流程 startOrder）才显示具体开工时刻。自动开工每张都一样，不再占一行（让位给金额，1280×800 一屏多看几张）。
  const manualStart = t.startedSource === 'manual' && t.startedAtMs != null ? t.startedAtMs : null;
  const canAmend = Boolean(onAmend) && !t.extraOnly && t.kitchenRouting === 'digital';
  // 有改单 / 补打按钮时它们靠右，堂食 / 打包跟在金额后面；没有按钮时堂食 / 打包靠右。
  const actions = !frozen && (canAmend || Boolean(onReprint));
  return (
    <article id={anchorId} className={`flex scroll-mt-28 flex-col overflow-hidden rounded-2xl border bg-kds-card ${frozen ? 'border-[#e0735c]' : u.border}`} aria-label={tr(`${t.tokenNumber}号`, `No. ${t.tokenNumber}`)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-kds-line px-5 pt-2.5 pb-2">
        <span className="text-[42px] font-black leading-none tabular-nums">{t.tokenNumber}</span>
        {t.extraOnly && <span className="rounded-lg bg-kds-action px-2.5 py-1 text-lg font-black text-kds-action-ink">{tr('加料', 'Extra')}</span>}
        {/* 金额紧跟牌号（加料卡在「加料」之后）：送餐的人一眼看到要收多少。 */}
        <AmountTag t={t} framed={framed} extras={extras} />
        {pokBowls > 0 && <span className="rounded-lg bg-kds-pok px-2.5 py-1 text-lg font-black text-kds-pok-ink">{tr('面薄', 'Mee pok')} ×{pokBowls}</span>}
        {pokBowls > 0 && thinBowls > 0 && <span className="rounded-lg border border-kds-line px-2 py-1 font-bold">{tr('细面', 'Thin')} ×{thinBowls}</span>}
        {sameToken > 1 && <span className="rounded-lg bg-kds-action px-2 py-1 text-sm font-bold text-kds-action-ink">{tr(`同牌 ${sameToken} 单`, `${sameToken} on this token`)}</span>}
        <span className={`${actions ? '' : 'ml-auto '}inline-flex items-center gap-2 rounded-xl bg-kds-soft px-3 py-2 font-bold`}>
          {t.serviceMode !== 'takeaway' && <PictoArt id="service:dine_in" size={26} />}
          {t.serviceMode !== 'dine_in' && <PictoArt id="service:takeaway" size={26} />}
          {tr(SERVICE_MODE_NAMES[t.serviceMode].zh, SERVICE_MODE_NAMES[t.serviceMode].en)}
        </span>
        {/* 改单、补打（2026-11-16）：放在牌号这一行的最右边，离最下面的「完成出餐」远，油手不容易按错；窄栏里两个一起换行、靠右。 */}
        {actions && (
          <span className="ml-auto flex gap-2">
            {canAmend && (
              <button type="button" disabled={disabled} onClick={() => onAmend!(t)}
                className="inline-flex h-12 items-center gap-1.5 rounded-xl border-2 border-kds-line px-3 text-base font-bold disabled:opacity-45">
                <Icon name="edit" size={20} />{tr('改单', 'Edit')}
              </button>
            )}
            {/* 补打不改数据，画面过期或别的单在处理时也能按；只在读同一张时防连按。 */}
            {onReprint && (
              <button type="button" disabled={reprintingId != null} onClick={() => onReprint(t)}
                className="inline-flex h-12 items-center gap-1.5 rounded-xl border-2 border-kds-line px-3 text-base font-bold disabled:opacity-45">
                <Icon name="receipt" size={20} />{reprintingId === t.id ? tr('读取中…', 'Loading…') : tr('补打', 'Reprint')}
              </button>
            )}
          </span>
        )}
      </div>
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 px-5 py-2 ${frozen ? 'bg-kds-danger-bg' : u.bar}`}>
        <Icon name="clock" size={18} className={frozen ? 'text-kds-danger' : u.text} />
        <span className="text-xs text-kds-muted">{tr('接单至今', 'Since order')}</span>
        <b className={`text-lg tabular-nums ${!frozen && urgency !== 'normal' ? u.text : ''}`}>{formatClock(elapsed)}</b>
        {t.timeQuality === 'device_estimated' && <span className="text-xs text-kds-muted">{tr('（离线时间）', '(offline time)')}</span>}
        <span className={`ml-auto text-sm font-semibold ${frozen ? 'text-kds-danger' : u.text}`}>
          {frozen ? tr('取消待确认 · 已冻结', 'Cancel requested · frozen') : tr(u.label, u.en)}
        </span>
        {manualStart != null && <span className="w-full text-xs text-kds-muted">{tr(`开始：人工开工 ${clock(manualStart)}`, `Start: by cook ${clock(manualStart)}`)}</span>}
      </div>
      {today && t.businessDate < today && (
        <Banner tone="warn">{tr(`跨营业日 · ${t.businessDate.slice(5)} 的单（仍需完成）`, `From ${t.businessDate.slice(5)} · still to finish`)}</Banner>
      )}
      {t.manualHandoffAtMs && <Banner tone="danger"><PictoArt id="token:return" size={24} />{tr('收银已递纸单 · 先核对是否已做，避免做两份', 'Paper ticket given · check before cooking twice')}</Banner>}
      {/* 同牌加单自动并入同一结账组，也带 addOnTo；只显示同牌提示，避免误以为是吃完再加的打包单。 */}
      {/* 加料也带 sharedToken、addOnTo：它有自己的送法提示，不显示这两条。取消待确认时已冻结，也不提示送法。 */}
      {t.extraOnly && !frozen && t.lines.some((l) => kitchenLineMode(t, l) === 'takeaway') && (
        <Banner tone="warn"><PictoArt id="service:takeaway" size={24} />{tr(`打包 → 单独装袋，交给 ${t.tokenNumber} 号`, `Takeaway → bag it separately, hand to No. ${t.tokenNumber}`)}</Banner>
      )}
      {t.extraOnly && !frozen && t.lines.some((l) => kitchenLineMode(t, l) !== 'takeaway') && (
        <Banner tone="warn">
          {/* 人工单的碗不在电子队列里，分不清出了没有（没有 queueGroupId），只说送到哪。 */}
          {!t.queueGroupId
            ? tr(`小碟送到 ${t.tokenNumber} 号`, `Small plate to No. ${t.tokenNumber}`)
            : t.extraForOrderId && openIds.has(t.extraForOrderId)
              ? tr('还没出 → 放进这碗；已装好 → 小碟一起送', 'Bowl not out → add to it; already dished up → small plate alongside')
              : tr(`碗已出 → 小碟送到 ${t.tokenNumber} 号`, `Bowl is out → small plate to No. ${t.tokenNumber}`)}
        </Banner>
      )}
      {t.sharedToken && !t.extraOnly && <Banner tone="action"><Icon name="users" size={22} />{tr(`同牌加单 · ${t.tokenNumber} 号的客人再加（和前面 ${t.tokenNumber} 号的一起送）`, `Same-token add-on · token ${t.tokenNumber} ordered more (serve with the earlier ${t.tokenNumber})`)}</Banner>}
      {t.addOnTo && !t.sharedToken && !t.extraOnly && <Banner tone="action"><PictoArt id="service:takeaway" size={24} />{tr(`加单 · 原 ${t.addOnTo.tokenNumber} 号的客人（吃完再加）`, `Add-on · for token ${t.addOnTo.tokenNumber}'s customer`)}</Banner>}
      {(t.amendCount ?? 0) > 0 && t.amendSummary && !frozen && (
        <Banner tone="warn"><Icon name="edit" size={20} className="shrink-0" />
          <span className="line-clamp-2">{t.amendedAtMs ? clock(t.amendedAtMs) : ''} {t.amendUndo ? tr('撤回了改单', 'edit undone') : tr('改过', 'edited')} · {t.amendSummary}</span>
        </Banner>
      )}
      {t.routedFromManual &&<Banner tone="action"><PictoArt id="token:return" size={24} />{tr('人工单转入 · 收银已核实厨房未做', 'From paper ticket · cashier confirmed not cooked')}</Banner>}
      <ul className={`flex-1 space-y-3 px-5 py-3 ${frozen ? 'opacity-60' : ''}`}>
        {t.lines.map((l) => t.extraOnly
          ? <ExtraLineRow key={l.lineId} l={l} />
          : <KitchenLineRow key={l.lineId} l={l} serviceMode={kitchenLineMode(t, l)} mixed={t.serviceMode === 'mixed'} mark={t.amendMarks?.[l.lineId] ?? null} />)}
      </ul>
      {frozen ? (
        <div className="m-4 mt-0 rounded-xl bg-kds-danger-bg p-3 text-kds-danger">
          <b className="text-lg">{tr('收银请求取消：', 'Cashier asks to cancel: ')}{t.cancelReason ?? tr('未注明', 'no reason')}</b>
          <p className="mt-1 text-sm">{tr('此单已冻结，不能出餐。请停止制作并如实选择；确认后订单取消，餐牌（同牌没有别的单时）自动释放。', 'Frozen — cannot be served. Stop cooking and choose truthfully; confirming cancels the order and frees the token (if no other order shares it).')}</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" disabled={disabled} onClick={() => onAct('confirmKitchenCancel', ref, { consumed: false })}
              className="min-h-14 rounded-xl border-2 border-current px-3 py-2 text-lg font-bold disabled:opacity-50">
              {busy ? tr('处理中…', 'Working…') : tr('未做，确认取消', 'Not cooked · confirm cancel')}
            </button>
            <button type="button" disabled={disabled} onClick={() => onAct('confirmKitchenCancel', ref, { consumed: true })}
              className="min-h-14 rounded-xl border-2 border-current px-3 py-2 text-lg font-bold disabled:opacity-50">
              {busy ? tr('处理中…', 'Working…') : tr('已下锅/已用料，确认取消', 'Already cooked / used · confirm cancel')}
            </button>
          </div>
          {/* 拒绝取消：结束本次申请，订单恢复正常制作；不标付款、不退款、不释放餐牌，出餐仍要点「完成出餐」。 */}
          <div className="mt-3 border-t border-current/30 pt-3">
            <div className="flex flex-wrap gap-2" role="group" aria-label={tr('拒绝原因（可选）', 'Reason (optional)')}>
              {REJECT_REASONS.map(([zh, en]) => (
                <button key={zh} type="button" aria-pressed={rejectReason === zh} disabled={disabled} onClick={() => setRejectReason(rejectReason === zh ? null : zh)}
                  className={`min-h-14 rounded-xl border px-3 text-sm font-semibold ${rejectReason === zh ? 'border-current bg-current/15' : 'border-current/40'}`}>{tr(zh, en)}</button>
              ))}
            </div>
            <button type="button" disabled={disabled} onClick={() => onAct('rejectKitchenCancel', ref, rejectReason ? { reason: rejectReason } : {})}
              className="mt-2 min-h-14 w-full rounded-xl bg-kds-soft px-3 py-2 text-lg font-bold text-kds-ink disabled:opacity-50">
              {busy ? tr('处理中…', 'Working…') : tr('继续做，拒绝取消', 'Keep cooking · reject cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-4 px-5 pb-3.5">
          <div className="shrink-0 text-sm leading-6 text-kds-muted">
            {thinHalf > 0 && <div>{tr('细面', 'Thin')} {balls(thinHalf)} {tr('团', 'balls')}</div>}
            {pokHalf > 0 && <div className="rounded bg-kds-pok px-1.5 font-bold text-kds-pok-ink">{tr('面薄', 'Mee pok')} {balls(pokHalf)} {tr('团', 'balls')}</div>}
            {wantons > 0 && <div>{tr('云吞', 'Wantan')} {wantons} {tr('粒', 'pcs')}</div>}
            {charSiew > 0 && <div>{tr('叉烧', 'Char siew')} {charSiew} {tr('份', charSiew > 1 ? 'portions' : 'portion')}</div>}
          </div>
          <button type="button" disabled={disabled} onClick={() => onAct('serveOrder', ref)}
            className="flex h-14 flex-1 items-center justify-center gap-3 rounded-xl bg-kds-serve text-xl font-bold text-kds-action-ink disabled:opacity-45">
            <PictoArt id="action:serve" size={30} />
            {busy ? tr('处理中…', 'Working…') : tr('完成出餐', 'Served')}
            <Icon name="arrow" size={20} />
          </button>
        </div>
      )}
    </article>
  );
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function Banner({ tone, children }: { tone: 'warn' | 'danger' | 'action'; children: React.ReactNode }) {
  const cls = tone === 'danger' ? 'bg-kds-danger-bg text-kds-danger' : tone === 'action' ? 'bg-kds-action text-kds-action-ink' : 'bg-kds-warning-bg text-kds-warning';
  return <div className={`mx-5 mt-3 flex items-center gap-2 rounded-lg px-3 py-1.5 font-bold ${cls}`}>{children}</div>;
}

/** 加料的品名。厨单把加料行写成干捞云吞（旧后厨屏兼容），lineNameEn 不适用，英文按加料本身取。 */
function extraLineName(l: KitchenLine, lang: Lang): string {
  return lang === 'en' ? (MENU_V1.addOns[l.addOns[0]]?.nameEn ?? l.nameZh) : l.nameZh;
}

/** 加料行：加什么、几份、给哪一碗。note 是服务器写的「给 红酱面 · 中 · 细面 · 辣」，存的就是中文。 */
function ExtraLineRow({ l }: { l: KitchenLine }) {
  const lang = useLang();
  return (
    <li className="rounded-xl border-2 border-kds-line p-2.5">
      <div className="flex items-center gap-3">
        <Photo id={l.photoId} size={56} rounded={10} />
        <b className="min-w-0 text-[28px] font-black leading-none">{extraLineName(l, lang)}</b>
        <b className={`ml-auto shrink-0 text-[32px] font-black tabular-nums ${l.quantity > 1 ? 'text-kds-action' : ''}`}>×{l.quantity}</b>
      </div>
      {l.note && <p className="mt-2 text-lg font-bold leading-tight">{l.note}</p>}
    </li>
  );
}

/** mixed：同一单有堂食也有打包，每行醒目标出这碗是哪一种。 */
function KitchenLineRow({ l, serviceMode, mixed, mark = null }: { l: KitchenLine; serviceMode: ServiceMode; mixed: boolean; mark?: 'mod' | 'add' | null }) {
  const tr = useT();
  // 改单后这一行：改过「改」、新加「新」，一直留到出餐。
  const markChip = mark && (
    <span className={`shrink-0 rounded-md px-2 py-0.5 text-sm font-black ${mark === 'add' ? 'bg-kds-live/25 text-kds-live' : 'bg-kds-warning-bg text-kds-warning'}`}>{mark === 'add' ? tr('新', 'New') : tr('改', 'Changed')}</span>
  );
  const lang = useLang();
  const cfg = l as unknown as LineConfig;
  const name = lang === 'en' ? lineNameEn(MENU_V1, cfg) : l.nameZh;
  // 按当前规则重算：l.pictograms 是下单时服务端存的，旧厨单里默认的「辣」没有强调。
  const pictograms = linePictograms(MENU_V1, cfg, serviceMode);
  const special = pictograms.filter((p) => p.emphasized && p.id !== 'kosong:on' && p.id !== 'sauce:no_tomato' && p.id !== 'charsiew:none' && !p.id.startsWith('noodle:') && p.id !== 'takeaway:no_side_soup');
  const standard = pictograms.filter((p) => !p.emphasized && !p.id.startsWith('noodle:') && p.id !== 'soup:base');
  const isSoup = l.productKind === 'wanton_soup' || l.productKind === 'soup_noodle';
  const label = (id: keyof typeof PICTOGRAMS) => (lang === 'en' ? PICTOGRAMS[id].en : PICTOGRAMS[id].zh);
  const isPok = l.noodleType === 'mee_poh';
  const muted = isPok ? '' : 'text-kds-muted';
  const chipTone = isPok ? 'bg-kds-card text-kds-text' : 'bg-kds-soft';
  const modeChip = mixed && (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-base font-bold ${serviceMode === 'takeaway' ? 'bg-kds-action text-kds-action-ink' : chipTone}`}>
      <PictoArt id={`service:${serviceMode}`} size={20} />{tr(SERVICE_MODE_NAMES[serviceMode].zh, SERVICE_MODE_NAMES[serviceMode].en)}
    </span>
  );
  const sauceDot = l.sauce && <span className={`h-4 w-4 shrink-0 rounded-full border border-kds-muted ${l.sauce === 'red' ? 'bg-[#c7482c]' : l.sauce === 'white' ? 'bg-[#efe3c4]' : 'bg-[#2b211c]'}`} />;
  return (
    <li className={l.noodleType ? `rounded-xl border-2 p-2.5 ${isPok ? 'border-kds-pok bg-kds-pok text-kds-pok-ink' : 'border-kds-line'}` : ''}>
      {l.noodleType ? (
        <>
          {/* 先看面种：面薄大字大图，细面保持安静。 */}
          <div className="flex items-center gap-3">
            <Photo id={`noodle.${l.noodleType}`} size={isPok ? 76 : 56} rounded={10} />
            <b className={isPok ? 'text-[44px] font-black leading-none' : 'text-[28px] font-extrabold leading-none'}>{isPok ? tr('面薄', 'Mee pok') : tr('细面', 'Thin')}</b>
            <b className={`ml-auto shrink-0 text-[32px] font-black tabular-nums ${l.quantity > 1 && !isPok ? 'text-kds-action' : ''}`}>×{l.quantity}</b>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {sauceDot}
            <b className="text-lg leading-tight">{name}</b>
            {markChip}
            {modeChip}
            <span className={`ml-auto text-sm ${muted}`}>{balls(l.noodleHalfUnits)} {tr('团 / 份', 'ball(s) each')}</span>
          </div>
        </>
      ) : (
      <div className="flex items-start gap-3">
        <Photo id={l.photoId} size={60} rounded={12} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <b className="text-xl leading-tight">{name}</b>
            {markChip}
            {modeChip}
            <b className={`ml-auto shrink-0 text-2xl tabular-nums ${l.quantity > 1 ? 'text-kds-action' : ''}`}>×{l.quantity}</b>
          </div>
          {isSoup ? (
            <span className="mt-1 block text-kds-muted">{tr('云吞 · 原汁汤底', 'Wantan · house soup')}</span>
          ) : l.sauce ? (
            <span className="mt-1 inline-flex items-center gap-2 text-kds-muted">
              {sauceDot}
              <span className="font-semibold text-kds-text">{tr(SAUCE_NAMES[l.sauce].zh, SAUCE_NAMES[l.sauce].en)}</span> · {tr('干捞云吞', 'dry wantan')}
            </span>
          ) : null}
        </div>
      </div>
      )}
      {l.isKosong && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-kds-action px-3 py-2 text-lg font-bold text-kds-action-ink">
          <PictoArt id="kosong:on" size={30} />{tr('净面 · 不放叉烧 / 云吞', 'Kosong · no char siew / wantan')}
        </div>
      )}
      {hasNoTomato(l) && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-kds-action px-3 py-2 text-lg font-bold text-kds-action-ink">
          <PictoArt id="sauce:no_tomato" size={30} />{l.sauce ? tr(`${SAUCE_NAMES[l.sauce].zh} · 不要番茄酱`, `${SAUCE_NAMES[l.sauce].en} · no tomato sauce`) : tr('不要番茄酱', 'No tomato sauce')}
        </div>
      )}
      {hasNoCharSiew(l) && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-kds-action px-3 py-2 text-lg font-bold text-kds-action-ink">
          <PictoArt id="charsiew:none" size={30} />{tr('不要叉烧 · 云吞照放', 'No char siew · wantan as usual')}
        </div>
      )}
      {special.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {special.map((p) => (
            <span key={p.id} className={`inline-flex items-center gap-2 rounded-xl border border-kds-line px-2.5 py-1.5 font-bold ${chipTone}`}>
              <PictoArt id={p.id} size={28} />{label(p.id)}
              {p.count && p.count > 1 && <span className="rounded-md bg-kds-action px-1.5 text-xl font-black tabular-nums text-kds-action-ink">×{p.count}</span>}
            </span>
          ))}
        </div>
      )}
      {special.length === 0 && !l.isKosong && standard.length > 0 && (
        <p className={`mt-1 text-sm ${muted}`}>{tr('标准配料', 'Standard')} · {standard.map((p) => label(p.id)).join(' · ')}</p>
      )}
      {serviceMode === 'takeaway' && (
        <p className={`mt-2 flex items-center gap-2 text-sm ${muted}`}>
          {isSoup ? <Icon name="bag" size={20} /> : <PictoArt id="takeaway:no_side_soup" size={22} />}{isSoup ? tr('汤品打包 · 保留原汤', 'Soup takeaway · keep the soup') : tr('干捞打包 · 不附送清汤', 'Dry takeaway · no side soup')}
        </p>
      )}
      {noteFreeText(l.note) && <p className={`mt-1 ${muted}`}>{tr('备注：', 'Note: ')}{noteFreeText(l.note)}</p>}
    </li>
  );
}
