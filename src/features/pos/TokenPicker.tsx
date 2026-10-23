/**
 * 餐牌选择器：1–50，四种状态（可用 / 当前 / 占用中 / 待回收）。
 * 占用牌不能强选；待回收牌在实体牌收回后由收银确认释放。
 */
import { useState } from 'react';
import { TokenBoard } from '../../domain/tokens';
import { Icon } from '../../ui/visual';
import { useT } from '../../app/i18n';

export function TokenPicker({ board, current, onPick, onRelease, onClose }: {
  board: TokenBoard;
  current: number | null;
  onPick: (n: number) => void;
  onRelease: (n: number, orderId: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState<{ n: number; orderId: string } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tr = useT();

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
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded bg-[#cfd5cc]" />{tr('占用中', 'In use')}</span>
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded border-2 border-dashed border-warn bg-warn-bg" />{tr('待回收（点击确认实体牌已收回）', 'To collect (tap when token is back)')}</span>
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
                  if (state === 'available') { onPick(n); onClose(); }
                  else if (state === 'awaiting_return' && t.orderId) setConfirm({ n, orderId: t.orderId });
                  else setInfo(tr(`${n}号仍被订单 …${t?.orderId?.slice(-6) ?? ''} 占用，出餐并回收实体牌后才能再用。`, `No. ${n} is still used by order …${t?.orderId?.slice(-6) ?? ''}. Serve it and collect the token first.`));
                }}
                className={`h-14 rounded-xl border-2 text-lg font-bold tabular-nums ${cls}`}>
                {n}
              </button>
            );
          })}
        </div>
        {info && <p role="status" className="mt-3 rounded-lg bg-subtle px-3 py-2">{info}</p>}
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
