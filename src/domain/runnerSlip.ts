/**
 * 送餐单（2026-11-12）：收银下单后在出餐口打一张纸单，送面的人照着对号送。纯函数，只决定写什么，排版与打印在 data/printer。
 * - 只用订单现有字段：牌号、堂食/打包、接单时间、票号（断网单写临时号）、每行品名、要求、数量、每行金额与合计。
 * - 不写付款状态（要收 / 已付）、付款方式、成本：纸单金额是订单金额，客人付没付看后厨卡片。
 * - 面种、要求的写法和收据同一个规则（modifierNamesZh）；净面加框、混合单里的打包用黑底标出。
 *   面薄和细面一样写普通字（2026-11-16 实机：小字黑底在便宜打印机上糊成一块看不清）；后厨屏照旧强调面薄。
 * - 干捞云吞的酱料收据没写，这里补上：断网时厨师照纸单做。
 * - 加料行写下单时自动生成的「给 …」备注；同牌加单、吃完再加、加料各有一句说明。
 * - 补打写「补打 N」；结果不明、核对后才确认接单的单写「核对后补打」。
 * - 后厨改单后补打（2026-11-16）：按改后的内容再打一张，最上面写「改单 · 以这张为准」，牌号下面写改了什么，
 *   改过的碗前面框「改」、新加的框「加」；时间写改单的时间。原来那张作废，送面的人照新的送。
 */
import { lineNameZh, LineConfig } from './lineItem';
import { MenuVersion, NOODLE_TYPE_NAMES, OrderServiceMode, orderServiceMode, SAUCE_NAMES, ServiceMode } from './menu';
import { formatRM } from './money';
import { modifierNamesZh } from './pictograms';

export interface RunnerSlipSource {
  tokenNumber: number;
  /** 行没有单独标明时的就餐方式。 */
  serviceMode: ServiceMode;
  /** 云端接单时间；断网单是本机时间。 */
  acceptedAtMs: number;
  receiptNumber: string | null;
  offlineReceiptNumber: string | null;
  source: 'online' | 'offline';
  lines: { config: LineConfig; quantity: number; unitPriceSen: number; serviceMode?: ServiceMode; lineId?: string }[];
  totalSen: number;
  /** 同牌加单：挂在客人已拿着的牌上（服务器返回 sharedToken）。 */
  sharedToken?: boolean;
  /** 吃完再加：原单的牌号。同牌加单时不写。 */
  addOnToToken?: number | null;
  /** 下单后加料的小单。 */
  extraOnly?: boolean;
  /** 后厨改单后补打的这一张。 */
  amend?: AmendSlipInfo;
}

/** 改单的信息（从厨单上抄来：第几次改、改了什么一句话、哪几行改过 / 新加；撤回也算一次改单）。 */
export interface AmendSlipInfo {
  no: number;
  summary: string;
  marks: Record<string, 'mod' | 'add'>;
  undo?: boolean;
}

export interface RunnerSlipOptions {
  timeZone: string;
  /** 这张单已经打过几次：0 是第一次，之后都是补打。 */
  printIndex: number;
  /** 下单结果不明，核对后才确认接单。 */
  reconciled?: boolean;
}

export interface RunnerSlipLine {
  quantity: number;
  /** 品名（不含「净面 · 」，净面另用 kosong 标出）。 */
  name: string;
  /** 品名前面的标记：混合单里的打包（黑底）、净面（框）。 */
  tags: { text: string; outline?: boolean }[];
  /** 品名下面的小字，按顺序：面种、干捞云吞的酱料、要求；加料是「给 …」。 */
  detail: { text: string }[];
  amountSen: number;
}

export interface RunnerSlip {
  header: { label: string; inverse: boolean };
  time: string;
  token: number;
  /** 牌号下面的一句说明（同牌加单 / 吃完再加 / 加料）。 */
  flag: string | null;
  /** 补打 N / 核对后补打 / 改单 · 以这张为准。 */
  mark: string | null;
  /** 改单补打：第几次改（打印队列补打时据此仍写「改单」）。 */
  amendNo?: number;
  /** 改单补打：牌号下面写改了什么。 */
  amendNote?: string | null;
  lines: RunnerSlipLine[];
  totalSen: number;
  /** 票号或临时号。 */
  ref: string;
  /** 共 N 份。 */
  count: number;
  /** 试打印的样单（sampleSlips）：纸上前后印「测试 · 不用做」。真单永远没有这个字段。 */
  test?: boolean;
}

const HEADER: Record<OrderServiceMode, string> = { dine_in: '堂食 DINE IN', takeaway: '打包 TAKEAWAY', mixed: '堂食 + 打包' };

function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

function slipLine(menu: MenuVersion, l: RunnerSlipSource['lines'][number], orderMode: OrderServiceMode, fallback: ServiceMode, amendMarks?: AmendSlipInfo['marks']): RunnerSlipLine {
  const mode = l.serviceMode ?? fallback;
  const c = l.config;
  const amountSen = l.unitPriceSen * l.quantity;
  if (c.productKind === 'extra') {
    return { quantity: l.quantity, name: lineNameZh(menu, c), tags: [], detail: c.note ? [{ text: c.note }] : [], amountSen };
  }
  const tags: RunnerSlipLine['tags'] = [];
  const amendMark = l.lineId ? amendMarks?.[l.lineId] : undefined;
  if (amendMark) tags.push({ text: amendMark === 'add' ? '加' : '改', outline: true });
  if (orderMode === 'mixed' && mode === 'takeaway') tags.push({ text: '打包' });
  if (c.isKosong) tags.push({ text: '净面', outline: true });
  const detail: RunnerSlipLine['detail'] = [
    ...(c.noodleType ? [{ text: NOODLE_TYPE_NAMES[c.noodleType].zh }] : []),
    ...(c.productKind === 'dry_wanton' && c.sauce ? [{ text: SAUCE_NAMES[c.sauce].zh }] : []),
    ...modifierNamesZh(menu, c, mode).map((text) => ({ text })),
  ];
  return { quantity: l.quantity, name: lineNameZh(menu, { ...c, isKosong: false }), tags, detail, amountSen };
}

export function buildRunnerSlip(menu: MenuVersion, src: RunnerSlipSource, opts: RunnerSlipOptions): RunnerSlip {
  const mode = orderServiceMode(src.lines.map((l) => l.serviceMode ?? src.serviceMode), src.serviceMode);
  const offline = src.source === 'offline';
  const header = offline
    ? { label: '断网单 · 后厨屏上没有', inverse: true }
    : src.extraOnly
      ? { label: '加料 EXTRA', inverse: false }
      : { label: HEADER[mode], inverse: mode === 'takeaway' };
  const flag = src.extraOnly
    ? '放进碗里还是小碟送 · 看后厨屏'
    : src.sharedToken
      ? `同牌加单 · 和前面的 ${src.tokenNumber} 号一起送`
      : src.addOnToToken != null
        ? `加单 · 原 ${src.addOnToToken} 号的客人`
        : null;
  return {
    header,
    time: clock(src.acceptedAtMs, opts.timeZone),
    token: src.tokenNumber,
    flag,
    mark: slipMark(opts.printIndex, opts.reconciled, src.amend?.no),
    ...(src.amend ? { amendNo: src.amend.no, amendNote: `${src.amend.undo ? '撤回改单' : '改了'}：${src.amend.summary}` } : {}),
    lines: src.lines.map((l) => slipLine(menu, l, mode, src.serviceMode, src.amend?.marks)),
    totalSen: src.totalSen,
    ref: src.receiptNumber ? `#${src.receiptNumber}` : `临时号 ${src.offlineReceiptNumber ?? '—'}`,
    count: src.lines.reduce((s, l) => s + l.quantity, 0),
  };
}

/**
 * 最上面的标记：第一次打不写（核对后才确认接单的写「核对后补打」），之后写「补打 N」。
 * 改单补打写「改单 · 以这张为准」（第二次起写「改单 2」…），这张再补打写「改单 · 补打 N」。
 */
export function slipMark(printIndex: number, reconciled = false, amendNo?: number): string | null {
  if (amendNo) return printIndex > 0 ? `改单 · 补打 ${printIndex + 1}` : `改单${amendNo > 1 ? ` ${amendNo}` : ''} · 以这张为准`;
  return printIndex > 0 ? `补打 ${printIndex + 1}` : reconciled ? '核对后补打' : null;
}

/** 每行金额，例如 1100 → "11.00"。 */
export function slipAmount(sen: number): string {
  return formatRM(sen).replace('RM', '');
}

/** 合计，例如 1800 → "RM 18.00"（和后厨金额一样，RM 后面留空格）。 */
export function slipTotal(sen: number): string {
  return formatRM(sen).replace('RM', 'RM ');
}

// ---- 什么时候自动打 ----

/**
 * 触发打印的事件：
 * accepted（云端接单）、extra_accepted（加料接单）、local_accepted（断网本机接单）、reconciled（结果不明，核对后确认已接单）——自动打；
 * unknown（结果不明，等核对）、rejected（被拒）、not_found（核对查无此单）、synced（断网单补同步）、served、cancelled、reload——不打。
 */
export type SlipTrigger = 'accepted' | 'extra_accepted' | 'local_accepted' | 'reconciled' | 'unknown' | 'rejected' | 'not_found' | 'synced' | 'served' | 'cancelled' | 'reload';

const AUTO: ReadonlySet<SlipTrigger> = new Set<SlipTrigger>(['accepted', 'extra_accepted', 'local_accepted', 'reconciled']);

export function autoPrintsSlip(trigger: SlipTrigger): boolean {
  return AUTO.has(trigger);
}

/** 打印机断开时排着的单：断开超过这么久才连上，多半已经出餐，不再自动补打，留给收银决定。 */
export const SLIP_RESUME_WINDOW_MS = 10 * 60_000;

export function resumesOnReconnect(job: { createdAtMs: number }, nowMs: number): boolean {
  return nowMs - job.createdAtMs <= SLIP_RESUME_WINDOW_MS;
}

/** 同一张单在本机打印记录里的键：云端单用订单 ID，断网单用本机 ID（补同步后不会被当成新单再打）。 */
export function slipKey(src: { orderId?: string | null; clientOrderId?: string | null }): string {
  if (src.orderId) return `order:${src.orderId}`;
  if (src.clientOrderId) return `local:${src.clientOrderId}`;
  throw new Error('送餐单需要订单 ID');
}

// ---- 后厨改单后补打 ----

/** 改单补打在本机打印记录里的键：每一次改单一张（撤回也是一次）。 */
export function amendSlipKey(orderId: string, amendCount: number): string {
  return `order:${orderId}:amend:${amendCount}`;
}

/** 厨单改过、而且是最近改的（和断开补打同一个 10 分钟）：收银机打开时才看到的旧改动不再补打。 */
export function printsAmendSlip(t: { amendCount?: number | null; amendedAtMs?: number | null }, nowMs: number): boolean {
  return (t.amendCount ?? 0) > 0 && typeof t.amendedAtMs === 'number' && nowMs - t.amendedAtMs <= SLIP_RESUME_WINDOW_MS;
}

/** 厨单上改单补打要用的字段（服务器改单时写上）。 */
export interface AmendedTicketView {
  amendCount: number;
  amendedAtMs: number;
  amendSummary?: string;
  amendMarks?: Record<string, 'mod' | 'add'>;
  amendUndo?: boolean;
}

/** 订单文档里改单补打要用的字段：items 是改后的每一行，带成交单价（厨单故意不带单价）。 */
export interface AmendedOrderView {
  tokenNumber: number;
  serviceMode: ServiceMode;
  receiptNumber: string | null;
  offlineReceiptNumber?: string | null;
  totalSen: number;
  sharedToken?: boolean;
  addOnTo?: { tokenNumber: number } | null;
  items: (LineConfig & { lineId: string; quantity: number; unitPriceSen: number; serviceMode?: ServiceMode })[];
}

/**
 * 改单补打的内容：订单现在的每一行 + 厨单上的改单说明。时间写改单的时间。
 * 能改的单都在后厨屏上（断网单补同步后也在），所以表头不写「断网单 · 后厨屏上没有」。
 */
export function amendSlipSource(o: AmendedOrderView, t: AmendedTicketView): RunnerSlipSource {
  return {
    tokenNumber: o.tokenNumber,
    serviceMode: o.serviceMode === 'takeaway' ? 'takeaway' : 'dine_in',
    acceptedAtMs: t.amendedAtMs,
    receiptNumber: o.receiptNumber,
    offlineReceiptNumber: o.offlineReceiptNumber ?? null,
    source: 'online',
    lines: o.items.map((it) => ({
      lineId: it.lineId,
      config: { productKind: it.productKind, size: it.size, noodleType: it.noodleType, sauce: it.sauce, spice: it.spice, lard: it.lard, scallion: it.scallion, isKosong: it.isKosong, addOns: it.addOns, note: it.note },
      quantity: it.quantity,
      unitPriceSen: it.unitPriceSen,
      ...(it.serviceMode ? { serviceMode: it.serviceMode } : {}),
    })),
    totalSen: o.totalSen,
    sharedToken: Boolean(o.sharedToken),
    addOnToToken: o.addOnTo?.tokenNumber ?? null,
    amend: { no: t.amendCount, summary: t.amendSummary ?? '', marks: t.amendMarks ?? {}, undo: t.amendUndo },
  };
}
