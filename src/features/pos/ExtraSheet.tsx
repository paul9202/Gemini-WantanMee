/**
 * 下单后加料面板：客人已经下单，还要加叉烧或云吞。开在点餐页上面，不离开也不动当前这张单（购物车、餐牌、加单目标都不碰）。
 * 左边是今天还能加料的单（同一张牌两张单就是两张卡），右边按所选单的每一碗选加几份；不能加的格子留在原位并写明原因。
 * 这里只负责选和显示，送出由点餐页 sendExtra 完成；金额、牌、那一碗能不能加，最后都以服务器校验为准。
 * 被拒绝时错误留在面板里，面板不关；餐牌订阅一更新，牌号这一行就按最新餐牌重算。
 */
import { useState } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { businessDateOf } from '../../domain/businessDay';
import { extraBlockReason, ExtraBlock, extraConfig } from '../../domain/extras';
import { hasNoTomato, LineConfig, lineName } from '../../domain/lineItem';
import { AddOnId, MenuVersion, NOODLE_TYPE_NAMES, OrderServiceMode, ServiceMode, SERVICE_MODE_NAMES, Spice } from '../../domain/menu';
import { formatRM, Sen } from '../../domain/money';
import type { Fulfillment, PaymentState } from '../../domain/orderLifecycle';
import type { ConfirmationMode } from '../../domain/payment';
import { PICTOGRAMS } from '../../domain/pictograms';
import { TokenBoard, tokenForExtra, tokenSession } from '../../domain/tokens';
import { db, storePath } from '../../data/firebase/client';
import { useLiveQuery, useNow } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { serverNow, useOfflineRuntime } from '../../data/offline/runtime';
import { useLang, useT } from '../../app/i18n';
import { useSession } from '../../app/session';
import { Icon } from '../../ui/visual';

type Tr = (zh: string, en: string) => string;

/** 订单文档里的一行：下单时的完整配置 + 行 ID、数量。 */
interface OrderItem extends LineConfig {
  lineId: string;
  quantity: number;
  serviceMode?: ServiceMode;
}

interface OrderRow {
  id: string;
  receiptNumber: string;
  tokenNumber: number;
  serviceMode: OrderServiceMode;
  fulfillmentStatus: Fulfillment;
  paymentState: PaymentState;
  /** 收款是出餐时自动记的还是前台确认的；旧单没有 = 前台确认。 */
  paymentConfirmationMode?: ConfirmationMode | null;
  totalSen: number;
  kitchenCancelRequested?: boolean;
  extraOnly?: boolean;
  businessDate: string;
  acceptedAtEffectiveMs: number;
  servedAtMs?: number | null;
  items: OrderItem[];
}

export interface ExtraRequest {
  bowlOrderId: string;
  /** 原单的牌号：用了别的号才算发出新牌。 */
  bowlTokenNumber: number;
  tokenNumber: number;
  serviceMode: ServiceMode;
  lines: { lineId: string; config: LineConfig; quantity: number; forLineId: string; serviceMode?: ServiceMode }[];
  totalSen: Sen;
  /** 结果弹窗上的文字，例如「加叉烧 ×1」。 */
  summary: string;
}

const ADD_ONS: AddOnId[] = ['char_siew', 'wanton_3'];
const MAX_PER_CELL = 9;
const cellKey = (lineId: string, addOn: AddOnId) => `${lineId}:${addOn}`;
const minutesSince = (fromMs: number, nowMs: number) => Math.max(0, Math.floor((nowMs - fromMs) / 60_000));

/** 能加料的单，和服务器的条件一致：今天的、不是加料单、没取消也不在等取消、未收款或已收款（退款、放弃追收的不行）。 */
function canTakeExtra(o: OrderRow, date: string): boolean {
  return o.businessDate === date && !o.extraOnly && !o.kitchenCancelRequested && o.fulfillmentStatus !== 'cancelled'
    && (o.paymentState === 'unpaid' || o.paymentState === 'paid');
}

const addOnLabel = (tr: Tr, a: AddOnId) => (a === 'char_siew' ? tr('加叉烧', 'Extra char siew') : tr('加云吞 3 粒', 'Extra 3 wantan'));

function blockText(tr: Tr, block: ExtraBlock, a: AddOnId): string {
  if (block === 'kosong') return tr('净面不能加肉', 'Kosong: no meat');
  if (block === 'is_extra') return tr('这行本身就是加料', 'This line is already an extra');
  return a === 'char_siew' ? tr('这碗不配叉烧', 'Char siew not available on this bowl') : tr('这碗不配云吞', 'Wantan not available on this bowl');
}

/** 碗的辨认信息：面种、辣度、不要番茄酱、备注、打包。 */
function bowlDetail(tr: Tr, i: OrderItem): string {
  const spice = i.spice ? PICTOGRAMS[`spice:${i.spice as Spice}`] : null;
  const noTomato = hasNoTomato(i) ? PICTOGRAMS['sauce:no_tomato'] : null;
  const named = [i.noodleType ? NOODLE_TYPE_NAMES[i.noodleType] : null, spice, noTomato].filter((x) => x !== null).map((x) => tr(x.zh, x.en));
  const takeaway = i.serviceMode === 'takeaway' ? [tr(SERVICE_MODE_NAMES.takeaway.zh, SERVICE_MODE_NAMES.takeaway.en)] : [];
  return [...named, ...(i.note ? [i.note] : []), ...takeaway].join(' · ');
}

export function ExtraSheet({ menu, board, lastIssued, initialOrderId, blockedReason, onClose, onSend }: {
  menu: MenuVersion;
  board: TokenBoard;
  lastIssued: number | null;
  initialOrderId: string | null;
  /** 现在不能送的原因（断网、别的标签页、有单未确认等）；只读显示，能不能送由点餐页决定。 */
  blockedReason: string | null;
  onClose: () => void;
  /** 送出：返回要留在面板里的错误；接单成功返回 null，由点餐页关掉面板。 */
  onSend: (req: ExtraRequest) => Promise<string | null>;
}) {
  const tr = useT();
  const lang = useLang();
  const { config } = useSession();
  const rt = useOfflineRuntime();
  useNow(30_000); // 「n 分钟」和跨营业日靠它定时刷新。
  const now = serverNow(rt);
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const q = useLiveQuery<OrderRow>(
    date ? query(collection(db, storePath('orders')), where('businessDate', '==', date), orderBy('acceptedAtEffectiveMs', 'desc')) : null,
    `orders-${date}`,
  );
  const [find, setFind] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialOrderId);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isServed = (o: OrderRow) => o.fulfillmentStatus === 'served';
  // 制作中的在前（客人多半还在等），已出餐的最近出的在前。
  const orders = q.data.filter((o) => canTakeExtra(o, date)).sort((a, b) =>
    Number(isServed(a)) - Number(isServed(b)) || (b.servedAtMs ?? b.acceptedAtEffectiveMs) - (a.servedAtMs ?? a.acceptedAtEffectiveMs));
  // 找单也认客人现在手上的牌：加料换过号时，这张牌这一轮记着原来那碗。
  const findSession = find ? tokenSession(board[Number(find)]) : [];
  const shown = find ? orders.filter((o) => String(o.tokenNumber) === find || findSession.includes(o.id)) : orders;
  // 被找单筛掉的不算选中：免得左边看的是 7 号，右边还在给 12 号加料。
  const selected = shown.find((o) => o.id === selectedId) ?? null;
  // 指定的单已经不能加料（例如刚被取消、不是今天的单）：明确告诉收银，不是空白。
  const selectedGone = selectedId !== null && !q.loading && !q.fromCache && !orders.some((o) => o.id === selectedId);

  const tokenNumber = selected ? tokenForExtra(board, { id: selected.id, tokenNumber: selected.tokenNumber }, lastIssued) : null;
  const tokenHeldByTable = tokenNumber !== null && selected !== null && board[tokenNumber]?.state === 'held' && tokenSession(board[tokenNumber]).includes(selected.id);

  const picked = (selected?.items ?? []).flatMap((item) => ADD_ONS.flatMap((addOn) => {
    const n = qty[cellKey(item.lineId, addOn)] ?? 0;
    return n > 0 && extraBlockReason(menu, item, addOn) === null ? [{ item, addOn, n }] : [];
  }));
  const totalSen = picked.reduce((s, p) => s + p.n * menu.addOns[p.addOn].priceSen, 0);
  const noToken = selected !== null && tokenNumber === null;
  const blocked = blockedReason ?? (noToken ? tr('没有可用餐牌：牌在出餐或取消成立后自动可用', 'No free token — tokens free up when orders are served or cancelled') : null);
  const canSend = selected !== null && tokenNumber !== null && picked.length > 0 && !blocked && !sending;

  function pick(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    setQty({});
    setError(null);
  }

  function step(key: string, delta: number) {
    setQty((m) => ({ ...m, [key]: Math.min(MAX_PER_CELL, Math.max(0, (m[key] ?? 0) + delta)) }));
    setError(null);
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const first = picked[0];
    const mode: ServiceMode = first.item.serviceMode ?? (selected.serviceMode === 'mixed' ? 'dine_in' : selected.serviceMode);
    try {
      const err = await onSend({
        bowlOrderId: selected.id, bowlTokenNumber: selected.tokenNumber, tokenNumber, serviceMode: mode, totalSen,
        lines: picked.map((p) => ({
          lineId: crypto.randomUUID(), config: extraConfig(p.addOn), quantity: p.n, forLineId: p.item.lineId,
          ...(p.item.serviceMode ? { serviceMode: p.item.serviceMode } : {}),
        })),
        summary: picked.map((p) => `${addOnLabel(tr, p.addOn)} ×${p.n}`).join('，'),
      });
      if (err) setError(err);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const close = () => { if (!sending) onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1d2420]/45 sm:p-4" role="dialog" aria-modal="true" aria-label={tr('加料', 'Add extras')}
      onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="flex h-full w-full max-w-[1080px] flex-col overflow-hidden bg-canvas shadow-2xl sm:h-[min(94dvh,780px)] sm:rounded-2xl">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-card px-4 py-3">
          <h2 className="text-xl font-bold">{tr('加料', 'Add extras')}</h2>
          <label className="flex h-14 items-center gap-2 rounded-xl border border-line bg-card px-3">
            <span className="shrink-0 text-sm font-semibold text-ink-2">{tr('找单', 'Find')}</span>
            <input value={find} inputMode="numeric" maxLength={2} placeholder={tr('牌号', 'Token')} aria-label={tr('按餐牌号找单', 'Find by token number')}
              onChange={(e) => setFind(e.target.value.replace(/\D/g, ''))} className="h-full w-16 min-w-0 bg-transparent text-xl font-bold tabular-nums outline-none" />
          </label>
          <button type="button" onClick={close} disabled={sending} autoFocus className="ml-auto flex h-14 items-center gap-1 rounded-xl border border-line px-4 font-semibold disabled:opacity-40"><Icon name="close" size={20} />{tr('关闭', 'Close')}</button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul className="max-h-[36dvh] shrink-0 space-y-2 overflow-y-auto border-b border-line bg-subtle/60 p-3 md:max-h-none md:w-[clamp(190px,26%,270px)] md:border-r md:border-b-0" aria-label={tr('今天的单', "Today's orders")}>
            {shown.length === 0 && (
              <li className="py-8 text-center text-sm text-ink-2">{q.loading ? tr('正在载入…', 'Loading…') : find ? tr(`没有 ${find} 号的单`, `No orders on token ${find}`) : tr('今天还没有能加料的单', 'No orders can take extras yet today')}</li>
            )}
            {shown.map((o) => {
              const served = isServed(o);
              const on = o.id === selected?.id;
              return (
                <li key={o.id}>
                  <button type="button" aria-pressed={on} onClick={() => pick(o.id)} className={`w-full rounded-xl border-2 p-2.5 text-left ${on ? 'border-ok bg-ok-bg' : 'border-line bg-card'}`}>
                    <span className="flex flex-wrap items-center gap-x-2">
                      <b className="text-2xl tabular-nums">{o.tokenNumber}</b>
                      <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold ${served ? 'bg-subtle text-ink' : 'bg-warn-bg text-warn'}`}>
                        {served
                          ? (o.servedAtMs ? tr(`已出餐 ${minutesSince(o.servedAtMs, now)} 分钟`, `Served ${minutesSince(o.servedAtMs, now)} min`) : tr('已出餐', 'Served'))
                          : tr(`制作中 ${minutesSince(o.acceptedAtEffectiveMs, now)} 分钟`, `Cooking ${minutesSince(o.acceptedAtEffectiveMs, now)} min`)}
                      </span>
                    </span>
                    {o.items.map((i) => <span key={i.lineId} className="mt-0.5 block text-sm">{lineName(menu, i, lang)} ×{i.quantity}</span>)}
                    <span className={`mt-1 block text-sm font-semibold ${o.paymentState === 'paid' ? (o.paymentConfirmationMode === 'auto_on_serve' ? 'text-[#2f4f86]' : 'text-ok') : 'text-danger'}`}>
                      {o.paymentState === 'paid' ? (o.paymentConfirmationMode === 'auto_on_serve' ? tr('出餐已记收款', 'Recorded at serve') : tr('已收款', 'Paid')) : tr('未收款', 'Unpaid')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {!selected && <p className="py-10 text-center text-ink-2">{selectedGone ? reasonText('EXTRA_NOT_ALLOWED') : tr('先在左边选一张单', 'Pick an order on the left')}</p>}
              {selected && (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <b className="text-lg">{tr(`${selected.tokenNumber} 号 · 票号 ${selected.receiptNumber}`, `Token ${selected.tokenNumber} · receipt ${selected.receiptNumber}`)}</b>
                    {isServed(selected) && <span className="text-sm font-semibold text-warn">{tr('这碗已出餐：后厨用小碟送', 'Already served: the kitchen sends it on a small plate')}</span>}
                  </div>
                  {selected.items.map((item) => {
                    const detail = bowlDetail(tr, item);
                    return (
                      <div key={item.lineId} className="rounded-xl border border-line p-2.5">
                        <p><b>{lineName(menu, item, lang)} ×{item.quantity}</b>{detail && <span className="ml-2 text-sm text-ink-2">{detail}</span>}</p>
                        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                          {ADD_ONS.map((addOn) => {
                            const label = addOnLabel(tr, addOn);
                            const block = extraBlockReason(menu, item, addOn);
                            if (block) {
                              return (
                                <div key={addOn} className="flex min-h-14 flex-col justify-center rounded-lg border-2 border-dashed border-line bg-subtle/60 px-3 py-1.5 text-ink-2">
                                  <span className="font-semibold">{label}</span>
                                  <span className="text-xs">{blockText(tr, block, addOn)}</span>
                                </div>
                              );
                            }
                            const key = cellKey(item.lineId, addOn);
                            const n = qty[key] ?? 0;
                            return (
                              <div key={addOn} className={`flex min-h-14 items-center justify-between gap-2 rounded-lg border-2 px-3 py-1 ${n > 0 ? 'border-ok bg-ok-bg' : 'border-line'}`}>
                                <span className="min-w-0 font-semibold">{label}<span className="block text-xs font-normal text-ink-2">{formatRM(menu.addOns[addOn].priceSen)}</span></span>
                                <span className="flex shrink-0 items-center gap-1">
                                  <button type="button" disabled={n === 0} onClick={() => step(key, -1)} aria-label={tr(`${label} 减一份`, `${label}: one less`)} className="h-14 w-12 rounded-lg border border-line bg-card text-xl font-bold disabled:opacity-40">−</button>
                                  <b className="w-6 text-center text-lg tabular-nums" aria-live="polite">{n}</b>
                                  <button type="button" disabled={n === MAX_PER_CELL} onClick={() => step(key, 1)} aria-label={tr(`${label} 加一份`, `${label}: one more`)} className="h-14 w-12 rounded-lg border border-line bg-card text-xl font-bold disabled:opacity-40">＋</button>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {tokenNumber !== null && (
                    <p role="status" className={`rounded-lg px-3 py-2 font-semibold ${tokenHeldByTable || tokenNumber === selected.tokenNumber ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>
                      {tokenHeldByTable
                        ? tr(`客人已拿着 ${tokenNumber} 号牌，不用再给牌`, `The customer already holds token ${tokenNumber} — no new token needed`)
                        : tokenNumber === selected.tokenNumber
                          ? tr(`把 ${tokenNumber} 号牌给客人`, `Give token ${tokenNumber} to the customer`)
                          : tr(`${selected.tokenNumber} 号已给别人，这次给 ${tokenNumber} 号牌`, `Token ${selected.tokenNumber} now belongs to someone else — give token ${tokenNumber} this time`)}
                    </p>
                  )}
                </>
              )}
            </div>

            <footer className="shrink-0 space-y-2 border-t border-line p-3">
              {error && <p role="alert" className="rounded-lg border-2 border-danger bg-danger-bg px-3 py-2 font-semibold text-danger">{error}</p>}
              {blocked && !sending && <p role="alert" className="rounded-lg bg-warn-bg px-3 py-2 text-sm font-semibold text-warn">{blocked}</p>}
              <div className="flex flex-wrap items-center gap-3">
                {selected && (
                  <span className="min-w-0 flex-1 text-sm">{selected.paymentState === 'paid'
                    // 出餐自动记的不是客人在前台付了：写明是出餐时记的，这份另收多少。
                    ? (selected.paymentConfirmationMode === 'auto_on_serve'
                      ? tr(`原单 ${formatRM(selected.totalSen)} 出餐已记收款 · 这份另收${totalSen > 0 ? ` ${formatRM(totalSen)}` : ''}`, `Original ${formatRM(selected.totalSen)} recorded at serve · this is charged separately${totalSen > 0 ? `: ${formatRM(totalSen)}` : ''}`)
                      : tr('这张单已收款，这份另收', 'This order is already paid — this is charged separately'))
                    : tr('这桌还没收款，这份和原单一起算', 'This table has not paid yet — this is billed together with the order')}</span>
                )}
                <button type="button" onClick={() => void send()} disabled={!canSend}
                  className="ml-auto flex h-14 shrink-0 items-center gap-2 rounded-xl bg-ok px-6 text-lg font-bold text-white disabled:bg-control">
                  {sending ? tr('正在送厨…', 'Sending…') : tr(`送厨 · ${formatRM(totalSen)}`, `Send · ${formatRM(totalSen)}`)}
                </button>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
