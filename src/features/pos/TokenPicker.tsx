/**
 * 餐牌选择器：1–50，状态（可用 / 当前 / 占用中）。出餐或取消成立即自动释放，不再人工回收。
 * 占用中的牌不能给新客人；点它可「在这个号加单」（同牌加单：同一桌再点，新单挂在同一张牌上，不用再给牌），
 * 确认前列出牌上现有的单供核对。断网时不能同牌加单（只显示原因）。
 * 「旧版待回收」只出现在改版前出餐的单上，实体牌收回后由收银逐张确认释放（留审计）。
 */
import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { TokenBoard, tokenHolders } from '../../domain/tokens';
import { db, storePath } from '../../data/firebase/client';
import { Icon } from '../../ui/visual';
import { useT } from '../../app/i18n';

export function TokenPicker({ board, current, onPick, onRelease, onJoin, joinDisabledReason, onClose }: {
  board: TokenBoard;
  current: number | null;
  onPick: (n: number) => void;
  onRelease: (n: number, orderId: string) => Promise<string | null>;
  /** 同牌加单：新单挂到 n 号上，withOrderId 是牌上现有的一张单。 */
  onJoin?: (n: number, withOrderId: string) => void;
  /** 不能同牌加单的原因（如断网）；有值时确认按钮禁用并显示原因。 */
  joinDisabledReason?: string | null;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState<{ n: number; orderId: string } | null>(null);
  const [join, setJoin] = useState<number | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tr = useT();
  // 按实时餐牌取牌上的单；牌已空出或不再占用时面板自动收起。
  const joinHolders = join !== null && board[join]?.state === 'held' ? tokenHolders(board[join]) : [];

  return (
    <div role="dialog" aria-modal="true" aria-label={tr('选择餐牌', 'Choose token')} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="max-h-full w-full max-w-3xl overflow-y-auto overscroll-contain rounded-2xl bg-card p-4 shadow-xl sm:p-5">
        <div className="mb-3 flex items-center">
          <h2 className="text-2xl font-bold">{tr('选择餐牌', 'Choose token')}</h2>
          <button type="button" onClick={onClose} className="ml-auto h-14 rounded-xl border border-line px-5 font-semibold" autoFocus>{tr('关闭', 'Close')}</button>
        </div>
        <div className="mb-3 flex flex-wrap gap-3 text-sm">
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded border-2 border-line bg-card" />{tr('可用', 'Free')}</span>
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded bg-ink" />{tr('当前', 'Current')}</span>
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded bg-[#cfd5cc]" />{tr('占用中（同一桌要加单，点它在这个号加单）', 'In use (same table adding more? tap it to add on this token)')}</span>
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded border-2 border-dashed border-warn bg-warn-bg" />{tr('旧版待回收（改版前出餐的单；实体牌收回后点击确认）', 'Legacy “to collect” (pre-update orders; tap when token is back)')}</span>
        </div>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
          {Array.from({ length: 50 }, (_, i) => i + 1).map((n) => {
            const t = board[n];
            const state = t?.state ?? 'available';
            const isCurrent = current === n;
            const cls = isCurrent ? 'bg-ink text-white border-ink'
              : state === 'held' ? 'bg-[#cfd5cc] text-ink-2 border-transparent'
              : state === 'awaiting_return' ? 'bg-warn-bg text-warn border-dashed border-warn'
              : 'bg-card border-line hover:border-control';
            return (
              <button key={n} type="button"
                aria-label={tr(`${n}号 ${isCurrent ? '当前' : state === 'held' ? '占用中' : state === 'awaiting_return' ? '待回收' : '可用'}`, `No. ${n} ${isCurrent ? 'current' : state === 'held' ? 'in use' : state === 'awaiting_return' ? 'to collect' : 'free'}`)}
                onClick={() => {
                  setInfo(null);
                  setConfirm(null);
                  setJoin(null);
                  if (state === 'available') { onPick(n); onClose(); }
                  else if (state === 'awaiting_return' && t.orderId) setConfirm({ n, orderId: t.orderId });
                  else if (state === 'held' && onJoin && tokenHolders(t).length > 0) setJoin(n);
                  else setInfo(tr(`${n}号仍被订单 …${t?.orderId?.slice(-6) ?? ''} 占用（制作中或取消待后厨确认），出餐或取消成立后自动可用。`, `No. ${n} is still used by order …${t?.orderId?.slice(-6) ?? ''} (cooking or cancel pending). It frees itself once served or cancelled.`));
                }}
                className={`h-14 rounded-xl border-2 text-lg font-bold tabular-nums ${cls}`}>
                {n}
              </button>
            );
          })}
        </div>
        {info && <p role="status" className="mt-3 rounded-lg bg-subtle px-3 py-2">{info}</p>}
        {join !== null && joinHolders.length > 0 && (
          <div className="mt-4 rounded-xl border-2 border-brand bg-brand-soft p-3 text-brand">
            <div className="flex items-start gap-3">
              <Icon name="plus" size={40} />
              <div className="flex-1">
                <b className="text-lg">{tr(`${join}号的客人要加单？`, `Token ${join}'s customer is adding more?`)}</b>
                <p className="text-sm">{tr(`新单挂在 ${join} 号上，不用再给牌；${join} 号的单全部出餐或取消后牌才释放`, `The new order goes on token ${join} — no new token needed. Token ${join} frees only when all its orders are served or cancelled.`)}</p>
              </div>
            </div>
            <TokenOrders ids={joinHolders} />
            {joinDisabledReason && <p role="status" className="mt-2 text-sm font-semibold text-warn">{joinDisabledReason}</p>}
            <div className="mt-3 flex flex-wrap justify-end gap-3">
              <button type="button" onClick={() => setJoin(null)} className="h-14 rounded-xl border border-control bg-card px-4 font-semibold text-ink">{tr('不是', 'No')}</button>
              <button type="button" disabled={Boolean(joinDisabledReason)}
                onClick={() => {
                  if (!onJoin || joinDisabledReason) return;
                  onJoin(join, joinHolders[0]);
                  onClose();
                }}
                className="h-14 rounded-xl bg-brand px-4 font-bold text-white disabled:bg-control">{tr(`在 ${join} 号加单`, `Add on token ${join}`)}</button>
            </div>
          </div>
        )}
        {confirm && (
          <div className="mt-4 flex items-center gap-3 rounded-xl border-2 border-warn bg-warn-bg p-3">
            <Icon name="handoff" size={40} />
            <div className="flex-1">
              <b className="text-lg">{tr(`${confirm.n}号实体牌已经收回？`, `Token ${confirm.n} is back with you?`)}</b>
              <p className="text-sm text-warn">{tr('只有真的拿回牌才确认；确认后这张牌可以给新客人。', 'Only confirm when you hold the token. It can then go to a new customer.')}</p>
            </div>
            <button type="button" onClick={() => setConfirm(null)} className="h-14 rounded-xl border border-control bg-card px-4 font-semibold">{tr('不是', 'No')}</button>
            <button type="button" disabled={busy}
              onClick={async () => {
                setBusy(true);
                const err = await onRelease(confirm.n, confirm.orderId);
                setBusy(false);
                if (err) setInfo(err);
                setConfirm(null);
              }}
              className="h-14 rounded-xl bg-ok px-4 font-bold text-white disabled:opacity-60">{busy ? tr('处理中…', 'Working…') : tr('已收回', 'Token back')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

interface HolderOrder { ticketNo: string; items: string; paid: boolean }

/** 牌上现有的单（供收银核对是不是同一桌）：每张单只读一次；读不到就只显示单号尾数。 */
function TokenOrders({ ids }: { ids: string[] }) {
  const tr = useT();
  const [loaded, setLoaded] = useState<Record<string, HolderOrder | null>>({});
  const key = ids.join(',');
  useEffect(() => {
    let alive = true;
    for (const id of key.split(',').filter(Boolean)) {
      getDoc(doc(db, storePath('orders'), id))
        .then((s) => {
          const d = s.data() as { receiptNumber?: string | null; offlineReceiptNumber?: string | null; items?: { nameZh: string; quantity: number }[]; paymentState?: string } | undefined;
          const v = d ? {
            ticketNo: d.receiptNumber ?? d.offlineReceiptNumber ?? `…${id.slice(-6)}`,
            items: (d.items ?? []).map((i) => `${i.nameZh} ×${i.quantity}`).join('，'),
            paid: d.paymentState === 'paid',
          } : null;
          if (alive) setLoaded((m) => ({ ...m, [id]: v }));
        })
        .catch(() => { if (alive) setLoaded((m) => ({ ...m, [id]: null })); });
    }
    return () => { alive = false; };
  }, [key]);
  return (
    <ul className="mt-3 space-y-1.5" aria-label={tr('牌上现有的单', 'Orders on this token')}>
      {ids.map((id) => {
        const o = loaded[id];
        return (
          <li key={id} className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-card px-3 py-2 text-sm text-ink">
            <b className="tabular-nums">{o?.ticketNo ?? `…${id.slice(-6)}`}</b>
            <span className="min-w-0 flex-1">{o === undefined ? tr('载入中…', 'Loading…') : o?.items ?? ''}</span>
            {o && <span className={`rounded px-1.5 text-xs font-semibold ${o.paid ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>{o.paid ? tr('已收款', 'Paid') : tr('未收款', 'Unpaid')}</span>}
          </li>
        );
      })}
    </ul>
  );
}
