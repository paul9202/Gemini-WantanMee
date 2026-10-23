/**
 * 后厨 KDS（02 §5，2026-10-23 新版布局）：顶部待下锅（细面 / 面薄 / 云吞 / 口味），左待做 FIFO，右制作中。
 * 餐牌、堂食/打包、等待时间、面种份量、特殊要求、动作按钮都在固定位置。
 * 收到非缓存厨单才发送「后厨已收到」回执；断网或数据来自缓存时冻结操作并提示画面可能过期。
 * 不显示售价、收款或利润（厨房投影本身不含这些字段）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, disableNetwork, enableNetwork, query, where } from 'firebase/firestore';
import { businessDateOf } from '../../domain/businessDay';
import { formatNoodleBalls, KitchenLine, KitchenTicket, sortFifo, summarizeKitchen } from '../../domain/kitchen';
import { formatClock, kitchenUrgency } from '../../domain/timing';
import { UNDO_SERVE_WINDOW_MS } from '../../domain/orderLifecycle';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useLiveQuery, useNow, useOnline } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { useSession } from '../../app/session';
import { useHeartbeat } from '../../data/heartbeat';
import { navigate } from '../../app/router';
import { Icon, Photo, PictoArt } from '../../ui/visual';
import { useLang, useT } from '../../app/i18n';
import { lineNameEn, LineConfig } from '../../domain/lineItem';
import { MENU_V1, SAUCE_NAMES } from '../../domain/menu';
import { PICTOGRAMS } from '../../domain/pictograms';
import { useKdsTheme, useNewTicketChime } from './prefs';

type Ticket = KitchenTicket & { id: string; kitchenAckAtMs: number | null; cancelReason?: string | null; routedFromManual?: boolean; manualHandoffAtMs?: number | null };
type Action = 'startOrder' | 'serveOrder' | 'confirmKitchenCancel' | 'undoServe';

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
  const [undo, setUndo] = useState<{ orderId: string; token: number; version: number; servedAt: number } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const acked = useRef(new Set<string>());
  const tr = useT();
  const lang = useLang();
  const [theme, toggleTheme] = useKdsTheme();
  useHeartbeat(deviceId, true);

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
  const tickets = sortFifo(q.data);
  const queued = tickets.filter((t) => t.fulfillmentStatus === 'queued');
  const preparing = tickets.filter((t) => t.fulfillmentStatus === 'preparing');
  const queuedIds = useMemo(() => queued.map((t) => t.id), [queued.map((t) => t.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const sound = useNewTicketChime(queuedIds, !q.fromCache && !q.loading);

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

  async function act(name: Action, t: { id: string; version: number; tokenNumber: number }) {
    if (busyId) return; // 防止连点：同一时间只处理一张单
    setBusyId(t.id);
    setMessage(null);
    try {
      const r = await submit<{ version: number }>(name, { operationId: newOperationId(), orderId: t.id, expectedVersion: t.version });
      if (name === 'serveOrder') setUndo({ orderId: t.id, token: t.tokenNumber, version: r.version, servedAt: Date.now() });
      if (name === 'undoServe') setUndo(null);
    } catch (e) {
      setMessage(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
      if (name === 'undoServe') setUndo(null);
    } finally {
      setBusyId(null);
    }
  }

  /** 强制 Firestore 重新建立连接；是否恢复以服务器快照为准。 */
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
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const dateLabel = date ? new Intl.DateTimeFormat(lang === 'en' ? 'en-MY' : 'zh-CN', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) : '';
  // now 每秒刷新一次，可能略早于出餐时刻；显示不超过 30 秒。实际时限由服务器判断。
  const undoLeft = undo ? Math.min(UNDO_SERVE_WINDOW_MS, UNDO_SERVE_WINDOW_MS - (now - undo.servedAt)) : 0;
  const iconBtn = 'flex h-14 w-14 items-center justify-center rounded-xl border border-kds-line text-kds-text hover:bg-kds-soft';

  return (
    <div className={`flex min-h-[100dvh] flex-col bg-kds text-kds-text ${theme === 'light' ? 'kds-light' : ''}`}>
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

      <section className="grid grid-cols-3 gap-2 px-4 pt-4 sm:gap-3 sm:px-7 sm:pt-5 lg:grid-cols-4 lg:gap-4" aria-label={tr('待下锅合计', 'To cook')}>
        <CountCard art={<Photo id="noodle.thin_egg" size={64} rounded={10} />} label={tr('待下锅 · 细面', 'To cook · Thin')} value={balls(sum.queued.thinEggHalfUnits)} unit={tr('团', 'balls')} />
        <CountCard art={<Photo id="noodle.mee_poh" size={64} rounded={10} />} label={tr('待下锅 · 面薄', 'To cook · Mee pok')} value={balls(sum.queued.meePohHalfUnits)} unit={tr('团', 'balls')} />
        <CountCard art={<Icon name="dumpling" size={56} />} label={tr('待下锅 · 云吞', 'To cook · Wantan')} value={String(sum.queued.wantons)} unit={tr('粒', 'pcs')} />
        <div className="col-span-3 flex flex-col justify-center rounded-2xl border border-kds-line bg-kds-card px-5 py-3 lg:col-span-1">
          <div className="text-sm text-kds-muted">{tr(`待做口味 · 共 ${sum.queued.orders} 单`, `Flavours waiting · ${sum.queued.orders} orders`)}</div>
          <div className="mt-1 grid grid-cols-5 gap-1 text-sm">
            {[
              [tr('黑酱', 'Black'), sum.queued.sauce.black], [tr('红酱', 'Red'), sum.queued.sauce.red], [tr('白酱', 'White'), sum.queued.sauce.white],
              [tr('汤面', 'Soup'), sum.queued.soupNoodle], [tr('云吞汤', 'W. soup'), sum.queued.wantonSoup],
            ].map(([l, v]) => (
              <span key={l as string} className={`whitespace-nowrap ${v ? '' : 'opacity-50'}`}>{l} <b className="text-lg">{v}</b></span>
            ))}
          </div>
          {sum.queued.kosong > 0 && <div className="mt-1 text-sm font-bold text-kds-action">{tr(`其中净面 ${sum.queued.kosong} 份`, `incl. Kosong ${sum.queued.kosong}`)}</div>}
        </div>
      </section>

      {message && <div role="alert" className="mx-4 mt-4 rounded-xl bg-kds-danger-bg px-4 py-3 text-lg text-kds-danger sm:mx-7">{message}</div>}

      <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-7 md:flex-row">
        <section className="min-w-0 md:flex-1 xl:flex-[2]" aria-label={tr('待做', 'Waiting')}>
          <SectionHead title={tr('待做', 'Waiting')} count={queued.length} hint={tr('等候最久在前', 'Oldest first')} />
          {q.loading && <p className="text-kds-muted">{tr('正在载入厨单…', 'Loading tickets…')}</p>}
          {!q.loading && queued.length === 0 && <Empty text={tr('暂无待做的单', 'Nothing waiting')} />}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {queued.map((t) => <TicketCard key={t.id} t={t} now={now} today={date} disabled={stale || busyId !== null} busy={busyId === t.id} onAct={act} />)}
          </div>
        </section>
        <section className="min-w-0 md:flex-1" aria-label={tr('制作中', 'Cooking')}>
          <SectionHead title={tr('制作中', 'Cooking')} count={preparing.length} hint={tr('完成后点出餐', 'Tap Served when done')} />
          {!q.loading && preparing.length === 0 && <Empty text={tr('没有正在制作的单', 'Nothing cooking')} />}
          <div className="grid grid-cols-1 gap-4">
            {preparing.map((t) => <TicketCard key={t.id} t={t} now={now} today={date} disabled={stale || busyId !== null} busy={busyId === t.id} onAct={act} />)}
          </div>
        </section>
      </div>

      <footer className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-kds-line bg-kds px-4 py-3 sm:px-7">
        <Icon name="cloud" size={22} />
        <span className="text-sm text-kds-muted">
          {stale ? tr('画面可能过期 · 不要据此开始制作', 'Screen may be stale — do not start from it') : tr('订单已实时更新', 'Orders are live')}
          {' · '}{tr(`人工单待核对 ${manualQ.data.length} 单（补同步订单不会自动重做）`, `${manualQ.data.length} paper ticket(s) to check (synced orders are not re-cooked)`)}
        </span>
        {undo && undoLeft > 0 && (
          <div role="status" className="ml-auto flex items-center gap-3 rounded-xl bg-kds-soft px-3 py-1.5">
            <PictoArt id="action:serve" size={32} />
            <span className="text-lg"><b className="text-2xl">{undo.token}</b> {tr('号已出餐', 'served')}</span>
            <button type="button" disabled={stale || busyId !== null}
              onClick={() => void act('undoServe', { id: undo.orderId, version: undo.version, tokenNumber: undo.token })}
              className="h-14 rounded-xl border-2 border-kds-action px-5 font-bold text-kds-action disabled:opacity-50">
              ↶ {tr(`撤回（${Math.ceil(undoLeft / 1000)}秒）`, `Undo (${Math.ceil(undoLeft / 1000)} s)`)}
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}

/** 半球单位 → 显示，例如 5 → 2½。 */
function balls(halfUnits: number): string {
  return formatNoodleBalls(halfUnits).replace(/\.5$/, '½').replace(/^0½$/, '½');
}

function CountCard({ art, label, value, unit }: { art: React.ReactNode; label: string; value: string; unit: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-2xl border border-kds-line bg-kds-card px-2 py-3 text-center sm:flex-row sm:gap-4 sm:px-5 sm:text-left">
      <span className="shrink-0 [&>*]:max-sm:!h-11 [&>*]:max-sm:!w-11">{art}</span>
      <div className="min-w-0">
        <div className="text-xs text-kds-muted sm:text-sm">{label}</div>
        <div className="text-4xl font-black leading-tight tabular-nums">{value}<span className="ml-1 text-base font-semibold text-kds-muted">{unit}</span></div>
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

function TicketCard({ t, now, today, disabled, busy, onAct }: {
  t: Ticket; now: number; today: string; disabled: boolean; busy: boolean;
  onAct: (name: Action, t: { id: string; version: number; tokenNumber: number }) => void;
}) {
  const tr = useT();
  const elapsed = now - t.acceptedAtEffectiveMs;
  const urgency = kitchenUrgency(elapsed);
  const u = URGENCY[urgency];
  const isQueued = t.fulfillmentStatus === 'queued';
  const noodle = t.lines.reduce((s, l) => s + l.noodleHalfUnits * l.quantity, 0);
  const wantons = t.lines.reduce((s, l) => s + l.wantonCount * l.quantity, 0);
  const ref = { id: t.id, version: t.version, tokenNumber: t.tokenNumber };
  return (
    <article className={`flex flex-col overflow-hidden rounded-2xl border bg-kds-card ${t.kitchenCancelRequested ? 'border-[#e0735c]' : u.border}`} aria-label={tr(`${t.tokenNumber}号`, `No. ${t.tokenNumber}`)}>
      <div className="flex items-center gap-3 border-b border-kds-line px-5 pt-2.5 pb-2">
        <span className="text-[42px] font-black leading-none tabular-nums">{t.tokenNumber}</span>
        <span className="ml-auto inline-flex items-center gap-2 rounded-xl bg-kds-soft px-3 py-2 font-bold">
          <PictoArt id={t.serviceMode === 'dine_in' ? 'service:dine_in' : 'service:takeaway'} size={26} />{t.serviceMode === 'dine_in' ? tr('堂食', 'Dine in') : tr('打包', 'Takeaway')}
        </span>
      </div>
      <div className={`flex items-center gap-2 px-5 py-2 ${isQueued ? u.bar : 'bg-kds-soft/60'}`}>
        <Icon name="clock" size={18} className={isQueued ? u.text : 'text-kds-muted'} />
        <b className={`text-lg tabular-nums ${isQueued && urgency !== 'normal' ? u.text : ''}`}>{formatClock(elapsed)}</b>
        {t.timeQuality === 'device_estimated' && <span className="text-xs text-kds-muted">{tr('（离线时间）', '(offline time)')}</span>}
        <span className={`ml-auto text-sm font-semibold ${isQueued ? u.text : 'text-kds-muted'}`}>
          {isQueued ? tr(u.label, u.en) : urgency === 'overdue' ? tr('正在制作 · 已超时', 'Cooking · overdue') : tr('正在制作', 'Cooking')}
        </span>
      </div>
      {today && t.businessDate < today && (
        <Banner tone="warn">{tr(`跨营业日 · ${t.businessDate.slice(5)} 的单（仍需完成）`, `From ${t.businessDate.slice(5)} · still to finish`)}</Banner>
      )}
      {t.manualHandoffAtMs && <Banner tone="danger"><PictoArt id="token:return" size={24} />{tr('收银已递纸单 · 先核对是否已做，避免做两份', 'Paper ticket given · check before cooking twice')}</Banner>}
      {t.routedFromManual && <Banner tone="action"><PictoArt id="token:return" size={24} />{tr('人工单转入 · 收银已核实厨房未做', 'From paper ticket · cashier confirmed not cooked')}</Banner>}
      <ul className="flex-1 space-y-3 px-5 py-3">
        {t.lines.map((l) => <KitchenLineRow key={l.lineId} l={l} serviceMode={t.serviceMode} />)}
      </ul>
      {t.kitchenCancelRequested ? (
        <div className="m-4 mt-0 rounded-xl bg-kds-danger-bg p-3 text-kds-danger">
          <b className="text-lg">{tr('收银请求取消：', 'Cashier asks to cancel: ')}{t.cancelReason ?? tr('未注明', 'no reason')}</b>
          <button type="button" disabled={disabled} onClick={() => onAct('confirmKitchenCancel', ref)}
            className="mt-2 h-14 w-full rounded-xl border-2 border-current text-lg font-bold disabled:opacity-50">{busy ? tr('处理中…', 'Working…') : tr('确认停止制作', 'Stop cooking')}</button>
        </div>
      ) : (
        <div className="flex items-end gap-4 px-5 pb-3.5">
          <div className="shrink-0 text-sm leading-6 text-kds-muted">
            {noodle > 0 && <div>{tr('面', 'Noodle')} {balls(noodle)} {tr('团', 'balls')}</div>}
            {wantons > 0 && <div>{tr('云吞', 'Wantan')} {wantons} {tr('粒', 'pcs')}</div>}
          </div>
          <button type="button" disabled={disabled} onClick={() => onAct(isQueued ? 'startOrder' : 'serveOrder', ref)}
            className={`flex h-14 flex-1 items-center justify-center gap-3 rounded-xl text-xl font-bold text-kds-action-ink disabled:opacity-45 ${isQueued ? 'bg-kds-action' : 'bg-kds-serve'}`}>
            <PictoArt id={isQueued ? 'action:start' : 'action:serve'} size={30} />
            {busy ? tr('处理中…', 'Working…') : isQueued ? tr('开始制作', 'Start') : tr('完成出餐', 'Served')}
            <Icon name="arrow" size={20} />
          </button>
        </div>
      )}
    </article>
  );
}

function Banner({ tone, children }: { tone: 'warn' | 'danger' | 'action'; children: React.ReactNode }) {
  const cls = tone === 'danger' ? 'bg-kds-danger-bg text-kds-danger' : tone === 'action' ? 'bg-kds-action text-kds-action-ink' : 'bg-kds-warning-bg text-kds-warning';
  return <div className={`mx-5 mt-3 flex items-center gap-2 rounded-lg px-3 py-1.5 font-bold ${cls}`}>{children}</div>;
}

function KitchenLineRow({ l, serviceMode }: { l: KitchenLine; serviceMode: 'dine_in' | 'takeaway' }) {
  const tr = useT();
  const lang = useLang();
  const name = lang === 'en' ? lineNameEn(MENU_V1, l as unknown as LineConfig) : l.nameZh;
  const special = l.pictograms.filter((p) => p.emphasized && p.id !== 'kosong:on' && !p.id.startsWith('noodle:') && p.id !== 'takeaway:no_side_soup');
  const standard = l.pictograms.filter((p) => !p.emphasized && !p.id.startsWith('noodle:') && p.id !== 'soup:base');
  const isSoup = l.productKind === 'wanton_soup' || l.productKind === 'soup_noodle';
  const label = (id: keyof typeof PICTOGRAMS) => (lang === 'en' ? PICTOGRAMS[id].en : PICTOGRAMS[id].zh);
  return (
    <li>
      <div className="flex items-start gap-3">
        <Photo id={l.photoId} size={60} rounded={12} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <b className="text-xl leading-tight">{name}</b>
            <b className={`ml-auto shrink-0 text-2xl tabular-nums ${l.quantity > 1 ? 'text-kds-action' : ''}`}>×{l.quantity}</b>
          </div>
          {l.noodleType ? (
            <span className="mt-1 inline-flex items-center gap-2 text-kds-muted">
              <Photo id={`noodle.${l.noodleType}`} size={24} rounded={5} />
              <span className="font-semibold text-kds-text">{l.noodleType === 'thin_egg' ? tr('细面', 'Thin') : tr('面薄', 'Mee pok')}</span>
              · {balls(l.noodleHalfUnits)} {tr('团 / 份', 'ball(s) each')}
            </span>
          ) : isSoup ? (
            <span className="mt-1 block text-kds-muted">{tr('云吞 · 原汁汤底', 'Wantan · house soup')}</span>
          ) : l.sauce ? (
            <span className="mt-1 inline-flex items-center gap-2 text-kds-muted">
              <span className={`h-4 w-4 rounded-full border border-kds-line ${l.sauce === 'red' ? 'bg-[#c7482c]' : l.sauce === 'white' ? 'bg-[#efe3c4]' : 'bg-[#2b211c]'}`} />
              <span className="font-semibold text-kds-text">{tr(SAUCE_NAMES[l.sauce].zh, SAUCE_NAMES[l.sauce].en)}</span> · {tr('干捞云吞', 'dry wantan')}
            </span>
          ) : null}
        </div>
      </div>
      {l.isKosong && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-kds-action px-3 py-2 text-lg font-bold text-kds-action-ink">
          <PictoArt id="kosong:on" size={30} />{tr('净面 · 不放叉烧 / 云吞', 'Kosong · no char siew / wantan')}
        </div>
      )}
      {special.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {special.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-2 rounded-xl border border-kds-line bg-kds-soft px-2.5 py-1.5 font-bold">
              <PictoArt id={p.id} size={28} />{label(p.id)}
            </span>
          ))}
        </div>
      )}
      {special.length === 0 && !l.isKosong && standard.length > 0 && (
        <p className="mt-1 text-sm text-kds-muted">{tr('标准配料', 'Standard')} · {standard.map((p) => label(p.id)).join(' · ')}</p>
      )}
      {serviceMode === 'takeaway' && (
        <p className="mt-2 flex items-center gap-2 text-sm text-kds-muted">
          {isSoup ? <Icon name="bag" size={20} /> : <PictoArt id="takeaway:no_side_soup" size={22} />}{isSoup ? tr('汤品打包 · 保留原汤', 'Soup takeaway · keep the soup') : tr('干捞打包 · 不附送清汤', 'Dry takeaway · no side soup')}
        </p>
      )}
      {l.note && <p className="mt-1 text-kds-muted">{tr('备注：', 'Note: ')}{l.note}</p>}
    </li>
  );
}
