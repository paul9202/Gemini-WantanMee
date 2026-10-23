/**
 * 离线待核对（老板）：每条显示原因、未入账金额与可选处理。原事件不覆盖，处理结果追加记录。
 */
import { useState } from 'react';
import { formatRM } from '../../domain/money';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { reasonText } from '../../data/firebase/reasons';
import { InboxRow, loadOpenReviews, useLoad } from './data';
import { OwnerTabs, Section } from './ui';

const REASON: Record<string, { zh: string; importable: boolean; hint: string }> = {
  REGISTER_REVOKED: { zh: '来自已被更换的旧收银机', importable: true, hint: '确认这笔钱确实收到后可补入账' },
  TIME_ANOMALY: { zh: '设备时间异常', importable: true, hint: '补入后不计入出餐时效统计' },
  OFFLINE_CAPABILITY_EXPIRED: { zh: '超出 24 小时离线营业资格', importable: true, hint: '核对纸单与钱箱后可补入账' },
  TOKEN_CONFLICT: { zh: '餐牌与云端记录冲突', importable: true, hint: '补入后只记历史账，不占用当前餐牌' },
  PAYMENT_UNVERIFIED: { zh: 'QR 收款没有核实依据', importable: true, hint: '必须先在银行端确认到账' },
  PRICE_MISMATCH: { zh: '金额与菜单价格不符', importable: true, hint: '按实际收到的钱入账，差额会记录下来，不追收' },
  DAY_CLOSED_LATE: { zh: '营业日已关账后才同步', importable: true, hint: '补入后需在日结页做更正版本，原关账版本不变' },
  DEPENDS_ON_REVIEW: { zh: '所属订单仍待核对', importable: true, hint: '先处理所属订单，再补上这条' },
  ORDER_STATE: { zh: '订单状态不允许', importable: true, hint: '已转电子厨单的单，出餐以后厨屏为准' },
  MENU_UNKNOWN: { zh: '菜单版本无法核实', importable: false, hint: '只能核对后不入账，并另行处理这笔钱' },
  INVALID_MODIFIER: { zh: '餐品配置不符合菜单', importable: false, hint: '只能核对后不入账' },
  ORDER_ID_CONFLICT: { zh: '订单号已存在', importable: false, hint: '可能是重复记录，核对后不入账' },
  SEQUENCE_REUSED: { zh: '记录序号重复', importable: false, hint: '核对后不入账' },
  SEQUENCE_GAP: { zh: '前面的记录缺失（阻塞）', importable: false, hint: '请先让收银机补传前面的记录' },
  EVENT_CONFLICT: { zh: '同一记录内容被改动', importable: false, hint: '核对后不入账' },
};
const TYPE_ZH: Record<string, string> = { offline_order_created: '离线接单', manual_handoff: '人工交接', manual_served: '人工出餐', token_returned: '实体牌收回', sequence_void: '作废序号' };

export function ReviewPage() {
  const reviews = useLoad(loadOpenReviews, 'review-page');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = [...(reviews.data ?? [])].sort((a, b) => a.registerId.localeCompare(b.registerId) || a.sequence - b.sequence);
  const total = rows.reduce((s, r) => s + (r.amountSen ?? 0), 0);

  return (
    <div className="mx-auto max-w-[1100px] p-4 pb-8 lg:p-8">
      <OwnerTabs current="/owner/review" badge={{ '/owner/review': rows.length }} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">离线待核对</h1>
        <span className="text-ink-2">{rows.length} 条{total ? ` · 已收 ${formatRM(total)} 尚未入云端账` : ''}</span>
        <button type="button" onClick={reviews.refresh} className="ml-auto h-10 rounded-lg border border-control px-3 font-semibold">刷新</button>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mb-3 rounded-lg px-3 py-2 ${msg.ok ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>{msg.text}</p>}
      {rows.length === 0 && <Section title="没有待核对的记录"><p className="text-ink-2">{reviews.loading ? '正在载入…' : '所有离线记录都已接纳或处理。'}</p></Section>}
      <div className="space-y-3">
        {rows.map((r) => <ReviewCard key={r.id} r={r} onDone={(text, ok) => { setMsg({ ok, text }); if (ok) reviews.refresh(); }} />)}
      </div>
    </div>
  );
}

function ReviewCard({ r, onDone }: { r: InboxRow; onDone: (text: string, ok: boolean) => void }) {
  const info = REASON[r.reasonCode ?? ''] ?? { zh: r.reasonCode ?? '未知', importable: false, hint: '' };
  const [reason, setReason] = useState('');
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = r.payload.payload;
  const blocked = r.status === 'blocked';

  async function act(action: 'import' | 'dismiss') {
    setBusy(true);
    try {
      const res = await submit<{ receiptNumber?: string; postCloseAdjustment?: boolean; priceVarianceSen?: number }>('resolveOfflineReview', {
        operationId: newOperationId(), eventId: r.id, action, reason, confirmPaymentReceived: confirmPaid,
      });
      onDone(action === 'dismiss' ? '已标记为不入账，原记录保留。'
        : `已补入账${res.receiptNumber ? `（票号 ${res.receiptNumber}）` : ''}${res.postCloseAdjustment ? '；该营业日已关账，请到日结页做更正版本' : ''}${res.priceVarianceSen ? `；与菜单价差额 ${formatRM(res.priceVarianceSen)}` : ''}。`, true);
    } catch (e) {
      onDone(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`rounded-2xl border-2 bg-card p-4 ${blocked ? 'border-line' : 'border-warn'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-lg">{TYPE_ZH[r.type] ?? r.type}</b>
        {p.tokenNumber !== undefined && <span className="rounded bg-subtle px-2">餐牌 {p.tokenNumber}</span>}
        {p.offlineReceiptNumber && <span className="rounded bg-subtle px-2">{p.offlineReceiptNumber}</span>}
        {r.amountSen !== null && <b className="ml-auto text-xl tabular-nums">{formatRM(r.amountSen)}{p.payment ? ` · ${p.payment.method === 'cash' ? '现金' : 'QR'}` : ''}</b>}
      </div>
      <p className="mt-1 text-sm text-ink-2">
        {r.registerId} · 序号 {r.sequence} · 本机时间 {new Date(r.payload.occurredAtDeviceMs).toLocaleString('zh-CN', { hour12: false })}
      </p>
      <p className="mt-2 font-semibold text-warn">{info.zh}</p>
      <p className="text-sm text-ink-2">{info.hint}</p>
      {!blocked && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="核对说明（必填，例如：已对过纸单和钱箱）"
            className="h-11 min-w-[260px] flex-1 rounded-lg border border-control px-2" />
          {r.reasonCode === 'PAYMENT_UNVERIFIED' && (
            <label className="flex items-center gap-1 text-sm font-semibold"><input type="checkbox" className="h-5 w-5" checked={confirmPaid} onChange={(e) => setConfirmPaid(e.target.checked)} />我已在银行端确认到账</label>
          )}
          {info.importable && (
            <button type="button" disabled={busy || reason.trim().length < 2 || (r.reasonCode === 'PAYMENT_UNVERIFIED' && !confirmPaid)} onClick={() => void act('import')}
              className="h-11 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">补入账</button>
          )}
          <button type="button" disabled={busy || reason.trim().length < 2} onClick={() => void act('dismiss')}
            className="h-11 rounded-lg border border-control px-4 font-semibold disabled:opacity-40">核对后不入账</button>
        </div>
      )}
    </article>
  );
}
