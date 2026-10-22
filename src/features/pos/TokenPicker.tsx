/**
 * 餐牌选择器：1–50，四种状态（可用 / 当前 / 占用中 / 待回收）。
 * 占用牌不能强选；待回收牌在实体牌收回后由收银确认释放。
 */
import { useState } from 'react';
import { TokenBoard } from '../../domain/tokens';
import { Icon } from '../../ui/visual';

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

  return (
    <div role="dialog" aria-modal="true" aria-label="选择餐牌" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="w-full max-w-2xl rounded-2xl bg-card p-5 shadow-xl">
        <div className="mb-3 flex items-center">
          <h2 className="text-2xl font-bold">选择餐牌</h2>
          <button type="button" onClick={onClose} className="ml-auto h-12 rounded-lg border border-line px-4 font-semibold" autoFocus>关闭</button>
        </div>
        <div className="mb-3 flex flex-wrap gap-3 text-sm">
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded border-2 border-line bg-card" />可用</span>
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded bg-ink" />当前</span>
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded bg-[#cfd5cc]" />占用中</span>
          <span className="inline-flex items-center gap-1"><i className="h-4 w-4 rounded border-2 border-dashed border-warn bg-warn-bg" />待回收（点击确认实体牌已收回）</span>
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
                aria-label={`${n}号 ${isCurrent ? '当前' : state === 'held' ? '占用中' : state === 'awaiting_return' ? '待回收' : '可用'}`}
                onClick={() => {
                  setInfo(null);
                  if (state === 'available') { onPick(n); onClose(); }
                  else if (state === 'awaiting_return' && t.orderId) setConfirm({ n, orderId: t.orderId });
                  else setInfo(`${n}号仍被订单 …${t?.orderId?.slice(-6) ?? ''} 占用，出餐并回收实体牌后才能再用。`);
                }}
                className={`h-12 rounded-lg border-2 text-lg font-bold tabular-nums ${cls}`}>
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
              <b className="text-lg">{confirm.n}号实体牌已经收回？</b>
              <p className="text-sm text-warn">只有真的拿回牌才确认；确认后这张牌可以给新客人。</p>
            </div>
            <button type="button" onClick={() => setConfirm(null)} className="h-12 rounded-lg border border-control bg-card px-4 font-semibold">不是</button>
            <button type="button" disabled={busy}
              onClick={async () => {
                setBusy(true);
                const err = await onRelease(confirm.n, confirm.orderId);
                setBusy(false);
                if (err) setInfo(err);
                setConfirm(null);
              }}
              className="h-12 rounded-lg bg-ok px-4 font-bold text-white disabled:opacity-60">{busy ? '处理中…' : '已收回'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
