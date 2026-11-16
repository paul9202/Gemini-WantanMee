/**
 * 改单（2026-11-16）：还没出餐的电子单可以在后厨屏（或收银机）直接改——加减碗数、改口味、删一碗、加一碗。
 * 改的是原单：单号、餐牌、排队位置都不变，后厨卡片留在原位。删光不算改单，走取消。
 * 这里只有纯函数：能不能改、改前改后比较出「改了什么」（给后厨卡片、收银机和订单记录看）。
 * 收过钱的单改了金额：命令层冲掉原收款（cause=amend），订单回到待收款并记住客人已付多少，
 * 收银机据此提示「补收 / 退给客人」多少，再按新金额登记一次收款。
 */
import { addOnCount, LineConfig, lineMergeKey, lineNameZh } from './lineItem';
import { ADD_ON_IDS, MenuVersion, NOODLE_TYPE_NAMES, ServiceMode, SERVICE_MODE_NAMES, getSize, Spice, Level } from './menu';
import type { Fulfillment, PaymentState } from './orderLifecycle';

/** 一张单最多改这么多次（含撤回），防止误触循环。 */
export const MAX_AMENDS = 20;
/** 改好后多久内可以「撤回」（只是再改回去，服务器照常当改单处理）。 */
export const UNDO_AMEND_WINDOW_MS = 30_000;

export interface AmendLine {
  lineId: string;
  config: LineConfig;
  quantity: number;
  serviceMode: ServiceMode;
}

export type AmendMark = 'mod' | 'add';

/** 一行的变化。change：同一行改了数量和 / 或口味。 */
export interface AmendChange {
  kind: 'add' | 'remove' | 'change';
  lineId: string;
  /** 改后的名字（删掉的是原来的名字）。 */
  name: string;
  fromQty: number;
  toQty: number;
  /** 口味等改动，例如「面薄→细面」「辣→不辣」。 */
  details: string[];
}

export interface AmendDiff {
  changes: AmendChange[];
  /** 改后的每一行：改过 mod / 新加 add；没变的不在里面。 */
  marks: Record<string, AmendMark>;
}

export type AmendBlock = 'served' | 'cancelled' | 'cancel_pending' | 'manual' | 'extra' | 'payment' | 'too_many';

/** 订单现在能不能改；能改返回 null。 */
export function amendBlock(o: {
  fulfillmentStatus: Fulfillment; kitchenCancelRequested?: boolean; kitchenRouting?: string; extraOnly?: boolean;
  paymentState: PaymentState; refundedSen?: number; amendCount?: number;
}): AmendBlock | null {
  if (o.fulfillmentStatus === 'served') return 'served';
  if (o.fulfillmentStatus === 'cancelled') return 'cancelled';
  if (o.kitchenCancelRequested) return 'cancel_pending';
  if (o.kitchenRouting !== 'digital') return 'manual';
  if (o.extraOnly) return 'extra';
  if ((o.paymentState !== 'unpaid' && o.paymentState !== 'paid') || (o.refundedSen ?? 0) > 0) return 'payment';
  if ((o.amendCount ?? 0) >= MAX_AMENDS) return 'too_many';
  return null;
}

const SPICE_ZH: Record<Spice, string> = { none: '不辣', less: '少辣', normal: '辣', extra: '加辣' };
const LARD_ZH: Record<Level, string> = { none: '无油渣', normal: '正常油渣', extra: '多油渣' };
const SCALLION_ZH: Record<Level, string> = { none: '走青', normal: '正常葱', extra: '多葱' };

const sameLine = (a: AmendLine, b: AmendLine) => lineMergeKey(a.config) === lineMergeKey(b.config) && a.serviceMode === b.serviceMode;

/** 同一行口味的变化（中文短句）。 */
export function configDetails(menu: MenuVersion, a: LineConfig, b: LineConfig, am?: ServiceMode, bm?: ServiceMode): string[] {
  const out: string[] = [];
  const base = (c: LineConfig) => lineNameZh(menu, c).split(' · ').slice(0, -1).join(' · ');
  if (base(a) !== base(b)) out.push(`${base(a)}→${base(b)}`);
  if (a.size !== b.size) out.push(`${getSize(menu, a.productKind, a.size)?.nameZh ?? a.size}→${getSize(menu, b.productKind, b.size)?.nameZh ?? b.size}`);
  if (a.noodleType && b.noodleType && a.noodleType !== b.noodleType) out.push(`${NOODLE_TYPE_NAMES[a.noodleType].zh}→${NOODLE_TYPE_NAMES[b.noodleType].zh}`);
  if (a.spice && b.spice && a.spice !== b.spice) out.push(`${SPICE_ZH[a.spice]}→${SPICE_ZH[b.spice]}`);
  if (a.lard && b.lard && a.lard !== b.lard) out.push(`${LARD_ZH[a.lard]}→${LARD_ZH[b.lard]}`);
  if (a.scallion !== b.scallion) out.push(`${SCALLION_ZH[a.scallion]}→${SCALLION_ZH[b.scallion]}`);
  // 加料：0→1 写「加叉烧」，去掉写「不加叉烧」，份数变了写「加叉烧 ×1→×3」。
  for (const id of ADD_ON_IDS) {
    const from = addOnCount(a, id);
    const to = addOnCount(b, id);
    const name = menu.addOns[id].nameZh;
    if (from === to) continue;
    if (to === 0) out.push(`不${name}`);
    else if (from === 0) out.push(to > 1 ? `${name} ×${to}` : name);
    else out.push(`${name} ×${from}→×${to}`);
  }
  if (a.note !== b.note) out.push(b.note ? `备注：${b.note}` : '去掉备注');
  if (am && bm && am !== bm) out.push(`${SERVICE_MODE_NAMES[am].zh}→${SERVICE_MODE_NAMES[bm].zh}`);
  return out;
}

/** 改前改后按 lineId 比较。改后新出现的 lineId 是新加的；改前有、改后没有的是删掉的。 */
export function diffAmend(menu: MenuVersion, before: readonly AmendLine[], after: readonly AmendLine[]): AmendDiff {
  const changes: AmendChange[] = [];
  const marks: Record<string, AmendMark> = {};
  const old = new Map(before.map((l) => [l.lineId, l]));
  const kept = new Set<string>();
  for (const l of after) {
    const o = old.get(l.lineId);
    if (!o) {
      changes.push({ kind: 'add', lineId: l.lineId, name: lineNameZh(menu, l.config), fromQty: 0, toQty: l.quantity, details: [] });
      marks[l.lineId] = 'add';
      continue;
    }
    kept.add(l.lineId);
    if (sameLine(o, l) && o.quantity === l.quantity) continue;
    const details = sameLine(o, l) ? [] : configDetails(menu, o.config, l.config, o.serviceMode, l.serviceMode);
    changes.push({ kind: 'change', lineId: l.lineId, name: lineNameZh(menu, l.config), fromQty: o.quantity, toQty: l.quantity, details });
    marks[l.lineId] = 'mod';
  }
  for (const o of before) {
    if (!kept.has(o.lineId)) changes.push({ kind: 'remove', lineId: o.lineId, name: lineNameZh(menu, o.config), fromQty: o.quantity, toQty: 0, details: [] });
  }
  return { changes, marks };
}

/** 一句话说清改了什么，例如「红酱面 · 中 2→1 碗 面薄→细面；加 干捞云吞 · 10粒」。 */
export function amendSummaryZh(changes: readonly AmendChange[]): string {
  return changes.map((c) => {
    if (c.kind === 'add') return `加 ${c.name}${c.toQty > 1 ? ` ×${c.toQty}` : ''}`;
    if (c.kind === 'remove') return `删 ${c.name}${c.fromQty > 1 ? ` ×${c.fromQty}` : ''}`;
    const qty = c.fromQty !== c.toQty ? ` ${c.fromQty}→${c.toQty} 碗` : '';
    return `${c.name}${qty}${c.details.length ? ` ${c.details.join(' ')}` : ''}`;
  }).join('；');
}

/**
 * 收过钱的单改了金额后，收银机要做的事。priorPaidSen：改单前客人已付（命令层冲正前的 paidSen）。
 * collect：按新金额登记时客人还要补多少；refund：要退给客人多少。两者都是正数，最多一个不为 0。
 */
export function amendSettlement(totalSen: number, priorPaidSen: number | null | undefined): { collectSen: number; refundSen: number } | null {
  if (!priorPaidSen || priorPaidSen <= 0) return null;
  const d = totalSen - priorPaidSen;
  return { collectSen: Math.max(0, d), refundSen: Math.max(0, -d) };
}

