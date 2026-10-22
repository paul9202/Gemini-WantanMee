/**
 * 后厨 KDS（02 §5）：深色全屏；顶部待下锅（细面/面薄分栏、云吞、口味），左待做 FIFO，右制作中。
 * 收到非缓存厨单才发送「后厨已收到」回执；断网时冻结操作并提示画面可能过期。
 */
import { useEffect, useRef, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { businessDateOf } from '../../domain/businessDay';
import { formatNoodleBalls, KitchenLine, KitchenTicket, sortFifo, summarizeKitchen } from '../../domain/kitchen';
import { formatClock, kitchenUrgency } from '../../domain/timing';
import { UNDO_SERVE_WINDOW_MS } from '../../domain/orderLifecycle';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useLiveQuery, useNow, useOnline } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { useSession } from '../../app/session';
import { navigate } from '../../app/router';
import { Icon, Photo, Picto, PictoArt } from '../../ui/visual';

type Ticket = KitchenTicket & { id: string; kitchenAckAtMs: number | null; cancelReason?: string | null };

export function KitchenPage() {
  const { config, member, deviceId, signOut } = useSession();
  const online = useOnline();
  const now = useNow();
  const q = useLiveQuery<Ticket>(
    query(collection(db, storePath('kitchenTickets')), where('kitchenRouting', '==', 'digital'), where('fulfillmentStatus', 'in', ['queued', 'preparing'])),
    'kds',
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ orderId: string; token: number; version: number; servedAt: number } | null>(null);
  const acked = useRef(new Set<string>());

  const stale = q.fromCache || !online;
  const tickets = sortFifo(q.data);

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

  async function act(name: 'startOrder' | 'serveOrder' | 'confirmKitchenCancel' | 'undoServe', t: { id: string; version: number; tokenNumber: number }) {
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

  const sum = summarizeKitchen(tickets);
  const queued = tickets.filter((t) => t.fulfillmentStatus === 'queued');
  const preparing = tickets.filter((t) => t.fulfillmentStatus === 'preparing');
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const undoLeft = undo ? UNDO_SERVE_WINDOW_MS - (now - undo.servedAt) : 0;

  return (
    <div className="min-h-screen bg-kds text-kds-text">
      <header className="flex items-center gap-4 border-b border-[#2c3a32] px-5 py-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-kds-action text-xl font-black text-kds">豪</span>
        <b className="text-xl">头手工作台</b>
        <span className="text-kds-muted">{date}</span>
        <span className={`ml-auto inline-flex items-center gap-2 font-semibold ${stale ? 'text-[#f2a68f]' : 'text-[#8fd6a8]'}`}>
          <span className={`h-3 w-3 rounded-full ${stale ? 'bg-[#f2a68f]' : 'bg-[#8fd6a8]'}`} />{stale ? '连接中断' : '实时连接'}
        </span>
        <span className="text-3xl font-bold tabular-nums">{new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
        {member?.role === 'owner' && <button type="button" onClick={() => navigate('/pos')} className="h-11 rounded-lg border border-[#4b5f52] px-3">返回前台</button>}
        <button type="button" onClick={() => void signOut()} className="h-11 rounded-lg border border-[#4b5f52] px-3 text-kds-muted">退出</button>
      </header>

      {stale && (
        <div role="alert" className="bg-[#5a2a20] px-5 py-3 text-xl font-bold text-[#ffd9cc]">厨房断网 · 画面可能过期 · 请与收银核对（操作已暂停）</div>
      )}

      <section className="flex flex-wrap items-center gap-6 border-b border-[#2c3a32] px-5 py-4" aria-label="待下锅合计">
        <BigCount photo="noodle.thin_egg" label="待下锅 · 细面" value={formatNoodleBalls(sum.queued.thinEggHalfUnits)} unit="团" />
        <BigCount photo="noodle.mee_poh" label="待下锅 · 面薄" value={formatNoodleBalls(sum.queued.meePohHalfUnits)} unit="团" />
        <div className="flex items-center gap-3">
          <Icon name="dumpling" size={64} />
          <div><div className="text-lg text-kds-muted">待下锅 · 云吞</div><div className="text-6xl font-black text-kds-action tabular-nums">{sum.queued.wantons}<span className="text-2xl">粒</span></div></div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-5xl font-black tabular-nums">{sum.queued.orders}<span className="text-xl font-semibold"> 单待做</span></div>
          <div className="text-lg text-kds-muted">面条共 {formatNoodleBalls(sum.queued.noodleHalfUnits)} 团 · 制作中 {sum.preparing.orders} 单</div>
        </div>
        <div className="flex w-full flex-wrap gap-2 text-xl">
          <Chip photo="dish.dry_noodle.black" text={`黑酱 ${sum.queued.sauce.black}份`} />
          <Chip photo="dish.dry_noodle.white" text={`白酱 ${sum.queued.sauce.white}份`} />
          <Chip photo="dish.dry_noodle.red" text={`红酱 ${sum.queued.sauce.red}份`} />
          <Chip photo="dish.soup_noodle" text={`汤面 ${sum.queued.soupNoodle}份`} />
          <Chip photo="dish.wanton_soup" text={`云吞汤 ${sum.queued.wantonSoup}份`} />
          {sum.queued.kosong > 0 && <span className="rounded-lg border-2 border-kds-action px-3 py-1 font-bold text-kds-action">其中净面 {sum.queued.kosong}份</span>}
        </div>
      </section>

      {message && <div role="alert" className="mx-5 mt-3 rounded-lg bg-[#5a2a20] px-4 py-3 text-lg">{message}</div>}

      <div className="flex gap-5 p-5">
        <section className="min-w-0 flex-[72]" aria-label="待做">
          <h2 className="mb-3 text-2xl font-bold">待做 <span className="text-base font-normal text-kds-muted">等候最久在前</span></h2>
          {q.loading && <p className="text-kds-muted">正在载入厨单…</p>}
          {!q.loading && queued.length === 0 && <p className="text-xl text-kds-muted">暂无待做的单</p>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {queued.map((t) => <TicketCard key={t.id} t={t} now={now} disabled={stale || busyId === t.id} onAct={act} />)}
          </div>
        </section>
        <section className="min-w-[280px] flex-[28] border-l border-[#2c3a32] pl-5" aria-label="制作中">
          <h2 className="mb-3 text-2xl font-bold">制作中 <span className="text-base font-normal text-kds-muted">{preparing.length}单</span></h2>
          <div className="space-y-4">
            {preparing.map((t) => <TicketCard key={t.id} t={t} now={now} disabled={stale || busyId === t.id} onAct={act} />)}
          </div>
          <p className="mt-6 border-t border-[#2c3a32] pt-3 text-kds-muted">人工单待核对：{sum.manualPending}单 · 补同步订单不会自动重做</p>
        </section>
      </div>

      {undo && undoLeft > 0 && (
        <div role="status" className="fixed inset-x-0 bottom-0 flex items-center gap-4 bg-[#2d3d34] px-5 py-3 text-xl">
          <PictoArt id="action:serve" size={40} />
          <span><b className="text-3xl">{undo.token}</b> 号已出餐</span>
          <button type="button" disabled={stale || busyId === undo.orderId}
            onClick={() => void act('undoServe', { id: undo.orderId, version: undo.version, tokenNumber: undo.token })}
            className="ml-auto h-14 rounded-xl border-2 border-kds-action px-6 font-bold text-kds-action">↶ 撤回 {undo.token}号（{Math.ceil(undoLeft / 1000)}秒）</button>
        </div>
      )}
    </div>
  );
}

function BigCount({ photo, label, value, unit }: { photo: string; label: string; value: string; unit: string }) {
  return (
    <div className="flex items-center gap-3">
      <Photo id={photo} size={72} rounded={10} />
      <div><div className="text-lg text-kds-muted">{label}</div><div className="text-6xl font-black tabular-nums">{value}<span className="text-2xl">{unit}</span></div></div>
    </div>
  );
}

function Chip({ photo, text }: { photo: string; text: string }) {
  return <span className="inline-flex items-center gap-2 rounded-lg border border-[#4b5f52] px-2 py-1"><Photo id={photo} size={34} rounded={8} />{text}</span>;
}

const URGENCY = {
  normal: { bar: 'bg-[#2a3a31]', label: '正常', border: 'border-[#33443a]' },
  warning: { bar: 'bg-[#5a4522]', label: '稍慢', border: 'border-kds-action' },
  overdue: { bar: 'bg-[#6a2a20]', label: '超时优先', border: 'border-[#e0735c]' },
};

function TicketCard({ t, now, disabled, onAct }: {
  t: Ticket; now: number; disabled: boolean;
  onAct: (name: 'startOrder' | 'serveOrder' | 'confirmKitchenCancel', t: { id: string; version: number; tokenNumber: number }) => void;
}) {
  const elapsed = now - t.acceptedAtEffectiveMs;
  const u = URGENCY[kitchenUrgency(elapsed)];
  const portions = t.lines.reduce((s, l) => s + l.quantity, 0);
  const noodle = t.lines.reduce((s, l) => s + l.noodleHalfUnits * l.quantity, 0);
  const wantons = t.lines.reduce((s, l) => s + l.wantonCount * l.quantity, 0);
  return (
    <article className={`flex flex-col overflow-hidden rounded-2xl border-2 bg-kds-card ${t.kitchenCancelRequested ? 'border-[#e0735c]' : u.border}`} aria-label={`${t.tokenNumber}号`}>
      <div className="flex items-center px-4 pt-3">
        <span className="text-7xl font-black leading-none tabular-nums">{t.tokenNumber}</span>
        <span className="ml-auto inline-flex items-center gap-2 rounded-lg bg-[#2d3d34] px-3 py-2 text-xl font-bold">
          <PictoArt id={t.serviceMode === 'dine_in' ? 'service:dine_in' : 'service:takeaway'} size={30} />{t.serviceMode === 'dine_in' ? '堂食' : '打包'}
        </span>
      </div>
      <div className={`mt-3 px-4 py-2 text-xl font-semibold ${u.bar}`}>{formatClock(elapsed)} · {u.label}</div>
      <div className="px-4 pt-2 text-lg text-kds-muted">{portions}份 · {formatNoodleBalls(noodle)}面球 · {wantons}云吞</div>
      <ul className="flex-1 space-y-3 px-4 py-3">
        {t.lines.map((l) => <KitchenLineRow key={l.lineId} l={l} />)}
      </ul>
      {t.kitchenCancelRequested ? (
        <div className="m-3 rounded-xl bg-[#5a2a20] p-3">
          <b className="text-xl">收银请求取消：{t.cancelReason ?? '未注明'}</b>
          <button type="button" disabled={disabled} onClick={() => onAct('confirmKitchenCancel', { id: t.id, version: t.version, tokenNumber: t.tokenNumber })}
            className="mt-2 h-16 w-full rounded-xl border-2 border-[#ffd9cc] text-xl font-bold disabled:opacity-50">确认停止制作</button>
        </div>
      ) : (
        <button type="button" disabled={disabled}
          onClick={() => onAct(t.fulfillmentStatus === 'queued' ? 'startOrder' : 'serveOrder', { id: t.id, version: t.version, tokenNumber: t.tokenNumber })}
          className={`m-3 flex h-16 items-center justify-center gap-3 rounded-xl text-2xl font-bold disabled:opacity-50 ${t.fulfillmentStatus === 'queued' ? 'bg-kds-action text-kds' : 'bg-[#e5f2ea] text-kds'}`}>
          <PictoArt id={t.fulfillmentStatus === 'queued' ? 'action:start' : 'action:serve'} size={40} />
          {t.fulfillmentStatus === 'queued' ? '开始制作' : '完成出餐'}
        </button>
      )}
    </article>
  );
}

function KitchenLineRow({ l }: { l: KitchenLine }) {
  const shown = l.pictograms.filter((p) => p.emphasized && p.id !== 'kosong:on' && !p.id.startsWith('noodle:'));
  return (
    <li>
      <div className="flex items-center gap-3">
        <Photo id={l.photoId} size={64} rounded={10} />
        <div className="min-w-0">
          <div className="text-2xl font-bold">{l.quantity > 1 ? <span className="text-kds-action">{l.quantity} ×</span> : '1 ×'} {l.nameZh}</div>
          {l.noodleType && (
            <span className="mt-1 inline-flex items-center gap-2 rounded-lg bg-[#2d3d34] px-2 py-0.5 text-lg">
              <Photo id={`noodle.${l.noodleType}`} size={30} rounded={6} />{l.noodleType === 'thin_egg' ? '细面' : '面薄'}
            </span>
          )}
          {!l.noodleType && (l.productKind === 'wanton_soup' || l.productKind === 'soup_noodle') && <span className="text-lg text-kds-muted">原汁汤底</span>}
        </div>
      </div>
      {l.isKosong && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-kds-action px-3 py-2 text-xl font-bold text-kds">
          <PictoArt id="kosong:on" size={34} />净面 · 不放叉烧 / 云吞
        </div>
      )}
      {shown.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">{shown.map((p) => <Picto key={p.id} id={p.id} size={30} tone="dark" />)}</div>
      )}
      {l.note && <p className="mt-1 text-lg text-kds-muted">备注：{l.note}</p>}
    </li>
  );
}
