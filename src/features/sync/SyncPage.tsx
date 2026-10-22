/**
 * 同步中心（01 §7）：本机未同步记录、离线人工单的交接/出餐/回收、补同步结果、
 * 待老板核对的收款、结果不明收款的处理决定、恢复包导出与导入。
 * 「已同步」只在服务器逐条确认后显示。
 */
import { useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { formatRM } from '../../domain/money';
import { manualStatus, OfflineEvent, offlineReceiptNumber, OfflineReviewReason } from '../../domain/offline';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, reconcile, submit } from '../../data/firebase/commands';
import { useOnline } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import {
  convertPendingToOffline, exportRecoveryPackage, importRecoveryPackage, LocalOrder, OutboxRecord, PendingOp, putPendingOp, RecoveryPackage,
} from '../../data/local/idb';
import {
  appendManualEvent, reloadLocal, setManualOffline, syncNow, unresolvedOps, unsyncedEvents, useOfflineRuntime, voidRejectedSequence,
} from '../../data/offline/runtime';
import { useRegister } from '../../data/register';
import { Icon } from '../../ui/visual';
import { useSession } from '../../app/session';
import { ReceiptDialog, receiptFromLocal } from '../receipt/ReceiptDialog';
import { menuForVersion } from '../../data/menu';

const REVIEW_ZH: Record<OfflineReviewReason, string> = {
  REGISTER_REVOKED: '这台设备已不是主收银机（换机）',
  SEQUENCE_GAP: '前面的记录缺失，暂时阻塞',
  SEQUENCE_REUSED: '记录序号重复',
  TIME_ANOMALY: '设备时间异常',
  OFFLINE_CAPABILITY_EXPIRED: '超出 24 小时离线营业资格',
  MENU_UNKNOWN: '菜单版本无法核实',
  INVALID_MODIFIER: '餐品配置不符合菜单',
  PRICE_MISMATCH: '金额与菜单价格不符',
  PAYMENT_UNVERIFIED: '收款没有核实依据',
  TOKEN_CONFLICT: '餐牌与云端记录冲突',
  DAY_CLOSED_LATE: '营业日已关账（关账后待调整）',
  ORDER_ID_CONFLICT: '订单号已存在',
  DEPENDS_ON_REVIEW: '所属订单仍待核对',
  ORDER_STATE: '订单状态不允许',
  EVENT_CONFLICT: '同一记录内容被改动',
};

const STATUS_ZH: Record<OutboxRecord['status'], string> = {
  pending: '未同步', accepted: '云端已接纳', needs_review: '待老板核对', blocked: '阻塞，等待前面的记录', rejected: '已拒收',
};

const TYPE_ZH: Record<OfflineEvent['type'], string> = {
  offline_order_created: '本机接单', manual_handoff: '人工交接', manual_served: '人工出餐', token_returned: '实体牌收回', sequence_void: '作废序号',
};

export function SyncPage() {
  const rt = useOfflineRuntime();
  const reg = useRegister();
  const browserOnline = useOnline();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [receiptOrder, setReceiptOrder] = useState<LocalOrder | null>(null);
  const { config } = useSession();
  const offline = !browserOnline || rt.manualOffline;
  const unsynced = unsyncedEvents(rt);
  const decisions = unresolvedOps(rt).filter((o) => o.status === 'not_found');
  const waiting = unresolvedOps(rt).filter((o) => o.status !== 'not_found');
  const events = rt.outbox.map((r) => r.event);
  const ctx = reg.claim && reg.shiftId ? { claim: reg.claim, shiftId: reg.shiftId, serverApplied: reg.serverApplied } : null;

  async function run(key: string, fn: () => Promise<string | null | void>) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      if (r) setMsg(r);
    } catch (e) {
      setMsg(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
    } finally {
      setBusy(null);
      await reloadLocal();
    }
  }

  const createRecord = (o: LocalOrder) => rt.outbox.find((r) => r.event.type === 'offline_order_created' && r.event.payload.clientOrderId === o.clientOrderId);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">同步中心</h1>
        <span className={`rounded-lg px-2 py-1 text-sm font-semibold ${offline ? 'bg-warn-bg text-warn' : 'bg-ok-bg text-ok'}`}>{offline ? (rt.manualOffline && browserOnline ? '手动离线营业' : '已断网') : '在线'}</span>
        <span className="text-ink-2">未同步 {unsynced.length} 条{rt.lastSyncAtMs ? ` · 上次同步 ${new Date(rt.lastSyncAtMs).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span>
        <div className="ml-auto flex gap-2">
          {browserOnline && (
            <button type="button" onClick={() => void setManualOffline(!rt.manualOffline)} className="h-12 rounded-lg border border-control px-3 font-semibold">
              {rt.manualOffline ? '恢复在线' : '云端连不上：改为离线营业'}
            </button>
          )}
          <button type="button" disabled={offline || rt.syncing} onClick={() => void run('sync', () => syncNow())}
            className="h-12 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">{rt.syncing ? '同步中…' : '立即同步'}</button>
        </div>
      </div>
      {rt.lastSyncError && <p role="alert" className="rounded-lg bg-warn-bg px-3 py-2 text-warn">同步未完成：{REVIEW_ZH[rt.lastSyncError as OfflineReviewReason] ?? reasonText(rt.lastSyncError)}</p>}
      {msg && <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-danger">{msg}</p>}

      {(decisions.length > 0 || waiting.length > 0) && (
        <section className="rounded-2xl border-2 border-warn bg-card p-4">
          <h2 className="text-xl font-bold text-warn">结果不明的收款（请勿再次收钱）</h2>
          {waiting.map((op) => (
            <p key={op.operationId} className="mt-2">{op.summary.tokenNumber}号 · {formatRM(op.summary.totalSen)}：等待联网后自动核对云端是否已接单。</p>
          ))}
          {decisions.map((op) => (
            <DecisionRow key={op.operationId} op={op} busy={busy === op.operationId} disabled={offline}
              onRetry={() => run(op.operationId, async () => {
                // 厨房没做：按原单（同一 operationId 与订单号）重新提交。
                try {
                  const r = await reconcile<{ receiptNumber: string }>('createOrder', op.payload);
                  await putPendingOp({ ...op, status: 'accepted', result: r, updatedAtMs: Date.now() });
                  return `已按原单提交成功（票号 ${r.receiptNumber}），未重复收款。`;
                } catch (e) {
                  if (e instanceof CommandFailure && e.kind === 'rejected' && reg.claim && reg.shiftId) {
                    await putPendingOp({ ...op, status: 'rejected', reasonCode: e.reasonCode, updatedAtMs: Date.now() });
                    await voidRejectedSequence({ operationId: op.operationId, clientOrderId: op.payload.order.clientOrderId, sequence: op.payload.sequence }, reg.claim, reg.shiftId);
                  }
                  throw e;
                }
              })}
              onConvert={() => run(op.operationId, async () => {
                // 已人工处理：原订单号与原序号转为人工单补账，之后照常记录人工出餐、回收。
                const p = op.payload as unknown as {
                  registerId: string; deviceId: string; registerEpoch: number; sequence: number; shiftId: string;
                  order: { clientOrderId: string; tokenNumber: number; serviceMode: 'dine_in' | 'takeaway'; menuVersion: string; lines: LocalOrder['lines']; expectedTotalSen: number; deviceAcceptedAtMs: number };
                  payment: { method: 'cash' | 'qr_manual'; tenderedSen: number | null };
                };
                const payload = {
                  clientOrderId: p.order.clientOrderId, offlineReceiptNumber: offlineReceiptNumber(p.registerId, p.sequence), tokenNumber: p.order.tokenNumber,
                  serviceMode: p.order.serviceMode, menuVersion: p.order.menuVersion, lines: p.order.lines, totalSen: p.order.expectedTotalSen,
                  payment: { method: p.payment.method, tenderedSen: p.payment.tenderedSen, qrExternalVerificationNote: p.payment.method === 'qr_manual' ? '在线时已在收款端核对到账（结果不明后转人工补账）' : null },
                };
                const event: OfflineEvent = {
                  eventId: crypto.randomUUID(), registerId: p.registerId, deviceId: p.deviceId, registerEpoch: p.registerEpoch, sequence: p.sequence,
                  shiftId: p.shiftId, occurredAtDeviceMs: p.order.deviceAcceptedAtMs, lastServerOffsetMs: rt.snapshot?.serverOffsetMs ?? 0,
                  type: 'offline_order_created', payload,
                };
                await convertPendingToOffline(op, event, { ...payload, sequence: p.sequence, createdAtMs: op.createdAtMs, changeSen: null });
                return '已转为人工单补账。请在下方登记人工出餐与实体牌收回。';
              })} />
          ))}
        </section>
      )}

      <section className="rounded-2xl border border-line bg-card p-4">
        <h2 className="text-xl font-bold">本机离线单</h2>
        {rt.localOrders.length === 0 && <p className="mt-2 text-ink-2">没有离线单。</p>}
        <div className="mt-2 divide-y divide-line">
          {[...rt.localOrders].reverse().map((o) => {
            const rec = createRecord(o);
            const m = manualStatus(events, o.clientOrderId);
            const accepted = rec?.status === 'accepted';
            return (
              <div key={o.clientOrderId} className="flex flex-wrap items-center gap-3 py-3">
                <span className="w-12 text-center text-3xl font-black tabular-nums">{o.tokenNumber}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{o.offlineReceiptNumber} · {formatRM(o.totalSen)} · {o.payment.method === 'cash' ? '现金' : 'QR（外部核实）'}</div>
                  <div className="text-sm text-ink-2">
                    {new Date(o.createdAtMs).toLocaleTimeString('zh-CN', { hour12: false })} · {o.lines.reduce((s, l) => s + l.quantity, 0)} 份 ·
                    <span className={rec?.status === 'accepted' ? ' text-ok' : rec?.status === 'needs_review' ? ' text-danger' : ' text-warn'}> {rec ? STATUS_ZH[rec.status] : '—'}</span>
                    {rec?.result?.receiptNumber ? ` · 云端票号 ${rec.result.receiptNumber}` : ''}
                    {rec?.result?.reasonCode ? ` · ${REVIEW_ZH[rec.result.reasonCode]}` : ''}
                  </div>
                </div>
                <Step done={m.handedOff} label="已人工交接" disabled={!ctx || busy !== null}
                  onClick={() => run(o.clientOrderId, () => appendManualEvent(ctx!, 'manual_handoff', o.clientOrderId))} />
                <Step done={m.served} label="已人工出餐" disabled={!ctx || busy !== null}
                  onClick={() => run(o.clientOrderId, () => appendManualEvent(ctx!, 'manual_served', o.clientOrderId))} />
                <Step done={m.tokenReturned} label="实体牌已收回" disabled={!ctx || busy !== null || !m.served}
                  onClick={() => run(o.clientOrderId, () => appendManualEvent(ctx!, 'token_returned', o.clientOrderId, o.tokenNumber))} />
                <button type="button" onClick={() => setReceiptOrder(o)} className="h-11 rounded-lg border border-control px-3 text-sm font-semibold">收据</button>
                {accepted && !m.served && !offline && (
                  <button type="button" disabled={busy !== null}
                    onClick={() => run(o.clientOrderId, async () => {
                      const snap = await getDoc(doc(db, storePath(`orders/${o.clientOrderId}`)));
                      if (snap.data()?.kitchenRouting !== 'manual') return '这张单已经转为电子厨单';
                      await submit('routeManualOrderToKitchen', { operationId: newOperationId(), orderId: o.clientOrderId, expectedVersion: snap.data()!.version, note: '收银已向厨师核实尚未制作' });
                      return `${o.tokenNumber}号已转为电子厨单，后厨屏会显示「人工单转入」。`;
                    })}
                    className="h-11 rounded-lg border border-ok px-3 font-semibold text-ok">厨师确认没做 → 转电子厨单</button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-card p-4">
        <h2 className="text-xl font-bold">记录明细</h2>
        <p className="text-sm text-ink-2">每一条都按本机序号上传；「云端已接纳」来自服务器逐条回复。</p>
        <div className="mt-2 max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-ink-2"><th className="py-1">序号</th><th>类型</th><th>餐牌</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>
              {[...rt.outbox].reverse().map((r) => (
                <tr key={r.eventId} className="border-t border-line">
                  <td className="py-1 tabular-nums">{r.sequence}</td>
                  <td>{TYPE_ZH[r.event.type]}</td>
                  <td className="tabular-nums">{r.event.type === 'offline_order_created' || r.event.type === 'token_returned' ? r.event.payload.tokenNumber : ''}</td>
                  <td className={r.status === 'accepted' ? 'text-ok' : r.status === 'needs_review' || r.status === 'rejected' ? 'text-danger' : 'text-warn'}>{STATUS_ZH[r.status]}</td>
                  <td>{r.result?.reasonCode ? REVIEW_ZH[r.result.reasonCode] : ''}{r.event.type === 'offline_order_created' && r.status === 'needs_review' ? ` · 已收 ${formatRM(r.event.payload.totalSen)} 尚未入云端账` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {receiptOrder && config && (() => {
        const rec = createRecord(receiptOrder);
        return (
          <ReceiptDialog receiptKey={receiptOrder.clientOrderId} menuVersion={receiptOrder.menuVersion} timeZone={config.timeZone} onClose={() => setReceiptOrder(null)}
            load={async () => {
              const soldMenu = await menuForVersion(receiptOrder.menuVersion);
              if (!soldMenu) throw new Error('本机没有这张单成交时的菜单版本');
              return receiptFromLocal(receiptOrder, soldMenu, config.name, { synced: rec?.status === 'accepted', receiptNumber: rec?.result?.receiptNumber ?? null, served: manualStatus(events, receiptOrder.clientOrderId).served });
            }} />
        );
      })()}

      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card p-4">
        <Icon name="list" size={28} />
        <div className="min-w-0 flex-1">
          <b>恢复包</b>
          <p className="text-sm text-ink-2">交班或设备有问题时导出本机全部记录。重复导入同一份不会重复入账。</p>
        </div>
        <button type="button" onClick={() => void run('export', async () => {
          const pkg = await exportRecoveryPackage();
          const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }));
          const a = Object.assign(document.createElement('a'), { href: url, download: `hao-pos-recovery-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json` });
          a.click();
          URL.revokeObjectURL(url);
        })} className="h-12 rounded-lg border border-control px-4 font-semibold">导出恢复包</button>
        <label className="flex h-12 cursor-pointer items-center rounded-lg border border-control px-4 font-semibold">
          导入恢复包
          <input type="file" accept="application/json" className="sr-only" onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void run('import', async () => `导入 ${await importRecoveryPackage(JSON.parse(await f.text()) as RecoveryPackage)} 条新记录`);
            e.target.value = '';
          }} />
        </label>
      </section>
    </div>
  );
}

function Step({ done, label, disabled, onClick }: { done: boolean; label: string; disabled: boolean; onClick: () => void }) {
  return done
    ? <span className="inline-flex h-11 items-center rounded-lg bg-ok-bg px-3 text-sm font-semibold text-ok">✓ {label}</span>
    : <button type="button" disabled={disabled} onClick={onClick} className="h-11 rounded-lg border border-control px-3 text-sm font-semibold disabled:opacity-40">{label}</button>;
}

function DecisionRow({ op, busy, disabled, onRetry, onConvert }: { op: PendingOp; busy: boolean; disabled: boolean; onRetry: () => void; onConvert: () => void }) {
  return (
    <div className="mt-3 rounded-xl bg-warn-bg p-3">
      <b>{op.summary.tokenNumber}号 · {formatRM(op.summary.totalSen)} · {op.summary.method === 'cash' ? '现金' : 'QR'}：云端没有这张单。</b>
      <p className="text-sm text-warn">钱已经收了，请勿再次收钱。先问厨房：这张单做了吗？</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy || disabled} onClick={onRetry} className="h-12 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">厨房没做：按原单重新提交</button>
        <button type="button" disabled={busy} onClick={onConvert} className="h-12 rounded-lg border border-warn bg-card px-4 font-semibold">已人工处理：转人工单补账</button>
      </div>
    </div>
  );
}
