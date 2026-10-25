/**
 * 设置 · 开业前清空测试数据（一次性）。只限老板：先看每类会删多少条，再输入店主 IC、勾选「无法恢复」才能清空。
 * 清空完成后门店标记为正式营业，这里只显示完成时间，不再提供清空。IC 只随这一次请求发给后台，不保存。
 */
import { useState } from 'react';
import { GO_LIVE_KEPT_LABELS, GO_LIVE_RESET_GROUPS } from '../../domain/goLive';
import { CommandFailure } from '../../data/firebase/commands';
import { previewStoreReset, resetStoreForOpening } from '../../data/firebase/goLive';
import { reasonText } from '../../data/firebase/reasons';
import { useLoad } from './data';
import { Btn, Dialog } from './finance/ui';
import { Section } from './ui';

type Msg = { ok: boolean; text: string } | null;

const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
const icDigits = (s: string) => s.replace(/[\s-]/g, '');

export function GoLiveReset({ setMsg }: { setMsg: (m: Msg) => void }) {
  const preview = useLoad(previewStoreReset, 'goLivePreview');
  const [open, setOpen] = useState(false);
  const p = preview.data;

  if (!p) {
    return (
      <Section title="开业前清空测试数据">
        <p className={preview.error ? 'text-danger' : 'text-ink-2'}>{preview.error ? `读取失败：${preview.error}` : '正在读取…'}</p>
      </Section>
    );
  }

  if (p.status === 'live') {
    return (
      <Section title="开业前清空测试数据" hint="已完成">
        <p>已于 <b>{p.liveAtMs ? time(p.liveAtMs) : '—'}</b> 清空测试数据并正式营业。这个功能已锁定，不能再清空。</p>
      </Section>
    );
  }

  const groups = GO_LIVE_RESET_GROUPS.map((g) => ({ ...g, count: g.collections.reduce((n, c) => n + (p.counts[c] ?? 0), 0) }));
  const total = groups.reduce((n, g) => n + g.count, 0);

  return (
    <Section title="开业前清空测试数据" hint="只能用一次 · 删除后无法恢复">
      <p className="text-sm">正式营业前用一次：删除试营业 / 测试期间的交易和收支记录，菜单和设置都保留。<b className="text-danger">不做备份，删除后无法恢复。</b>清空完成后自动锁定。</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-danger/40 bg-danger-bg/40 p-3">
          <div className="mb-1 font-semibold text-danger">会清空（共 {total} 条）</div>
          <ul className="space-y-1 text-sm">
            {groups.map((g) => <li key={g.id} className="flex justify-between gap-2"><span>{g.label}</span><span className="tabular-nums">{g.count}</span></li>)}
            <li className="text-ink-2">以及 AI 记成本上传的收据图片</li>
          </ul>
        </div>
        <div className="rounded-xl border border-line bg-subtle p-3">
          <div className="mb-1 font-semibold">会保留</div>
          <ul className="list-disc space-y-1 pl-5 text-sm">{GO_LIVE_KEPT_LABELS.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="mt-2 text-xs text-ink-2">餐牌全部放回可用；收银机需要重新开班。</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-2">清空前：请让收银机联网，把离线记录同步完。清空后：收银员重新开班，其他设备刷新一下页面。</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn tone="danger" onClick={() => setOpen(true)}>清空测试数据…</Btn>
        {p.status === 'resetting' && <span className="text-sm text-warn">上次清空没有完成，可以再次确认继续。</span>}
        <button type="button" onClick={preview.refresh} className="text-sm underline underline-offset-4">刷新数量</button>
      </div>
      {open && (
        <ConfirmDialog total={total} lockedUntilMs={p.lockedUntilMs} onClose={() => setOpen(false)}
          onDone={(deletedTotal) => {
            setOpen(false);
            setMsg({ ok: true, text: `已清空 ${deletedTotal} 条测试记录，门店已标记为正式营业。请收银员重新开班，其他设备刷新页面。` });
            preview.refresh();
          }}
          onChanged={preview.refresh} />
      )}
    </Section>
  );
}

function ConfirmDialog({ total, lockedUntilMs, onClose, onDone, onChanged }: {
  total: number; lockedUntilMs: number | null; onClose: () => void; onDone: (deletedTotal: number) => void; onChanged: () => void;
}) {
  const [code, setCode] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(lockedUntilMs && lockedUntilMs > Date.now() ? lockedUntilMs : null);
  const valid = /^\d{12}$/.test(icDigits(code));

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await resetStoreForOpening(icDigits(code));
      onDone(r.deletedTotal);
    } catch (e) {
      if (e instanceof CommandFailure) {
        const left = e.details.remainingAttempts as number | undefined;
        const until = e.details.lockedUntilMs as number | undefined;
        if (until) setLockedUntil(until);
        setError(`${reasonText(e.reasonCode)}${left !== undefined ? `（还可以再试 ${left} 次）` : ''}${until ? `，${time(until)} 后可再试` : ''}`);
      } else setError(String(e));
      onChanged();
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  const locked = lockedUntil !== null && lockedUntil > Date.now();
  return (
    <Dialog title="确认清空测试数据" sub={`将删除 ${total} 条测试记录和收据图片，不做备份`} onClose={busy ? () => undefined : onClose}
      footer={<>
        <Btn onClick={onClose} disabled={busy} className="flex-1 sm:flex-none">取消</Btn>
        <Btn tone="danger" onClick={() => void confirm()} disabled={busy || !valid || !understood || locked} className="flex-1 sm:flex-none">
          {busy ? '正在清空，请不要关闭页面…' : '确认清空（不可恢复）'}
        </Btn>
      </>}>
      <label className="block">
        <span className="font-semibold">店主 IC 号码</span>
        <input type="password" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={16} value={code} disabled={busy || locked}
          onChange={(e) => setCode(e.target.value)} placeholder="12 位数字，可带 -"
          className="mt-1 h-12 w-full rounded-lg border border-control px-3 tracking-widest" />
      </label>
      <label className="mt-4 flex items-start gap-2">
        <input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1 h-5 w-5" />
        <span>我知道删除后<b className="text-danger">无法恢复</b>，也没有备份；清空后这个功能会锁定。</span>
      </label>
      {locked && <p role="alert" className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">输错次数太多，{time(lockedUntil!)} 后可再试。</p>}
      {error && !locked && <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}
