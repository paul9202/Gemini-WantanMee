/**
 * 收款登记（主点单平板）：员工确认整单已收到，不分渠道、不输入实收找零。
 * - 联网：recordPayment 命令；先补传本机未同步日志（保证原订单 / 先前的离线收款先到）。
 *   同一订单在本页内重试复用同一个 operationId，结果不明先查询原操作，不让员工再收一次。
 * - 断网，或订单本身还只在本机：写 offline_payment_recorded 事件，先原子落盘再算成功。
 * 二维码显示 / 扫描 / 关闭都不调用这里；只有员工点「确认已收款」才登记。
 */
import { useCallback } from 'react';
import { CommandFailure, newOperationId, submit } from './firebase/commands';
import { useOnline } from './firebase/live';
import { reasonText } from './firebase/reasons';
import { appendManualEvent, syncNow, unsyncedEvents, useOfflineRuntime } from './offline/runtime';
import { useRegister } from './register';

export type RecordPaymentOutcome =
  | { ok: true; offline: boolean; alreadyRecorded: boolean }
  | { ok: false; code: string; message: string; uncertain: boolean };

/** orderId → 本页尚未得到确定结果的 operationId（超时重试复用，防止重复登记）。 */
const inflight = new Map<string, string>();

export function useRecordPayment() {
  const reg = useRegister();
  const rt = useOfflineRuntime();
  const online = useOnline();
  const offlineMode = !online || rt.manualOffline;

  return useCallback(async (orderId: string, amountSen: number): Promise<RecordPaymentOutcome> => {
    if (!reg.claim || !reg.shiftId) return { ok: false, code: 'REGISTER_REVOKED', message: reasonText('REGISTER_REVOKED'), uncertain: false };
    const events = rt.outbox.filter((r) => r.status !== 'rejected').map((r) => r.event);
    if (events.some((e) => e.type === 'offline_payment_recorded' && e.payload.clientOrderId === orderId)) {
      return { ok: true, offline: true, alreadyRecorded: true };
    }
    const localOnly = rt.localOrders.some((o) => o.clientOrderId === orderId)
      && !rt.outbox.some((r) => r.event.type === 'offline_order_created' && r.event.payload.clientOrderId === orderId && r.status === 'accepted');
    if (offlineMode || localOnly) {
      const err = await appendManualEvent({ claim: reg.claim, shiftId: reg.shiftId, serverApplied: reg.serverApplied }, 'offline_payment_recorded', orderId, { amountSen });
      if (err) return { ok: false, code: 'LOCAL_SAVE_FAILED', message: err, uncertain: false };
      if (!offlineMode) void syncNow();
      return { ok: true, offline: true, alreadyRecorded: false };
    }
    if (unsyncedEvents(rt).length) await syncNow();
    const operationId = inflight.get(orderId) ?? newOperationId();
    inflight.set(orderId, operationId);
    try {
      await submit('recordPayment', { operationId, ...reg.claim, orderId, amountSen });
      inflight.delete(orderId);
      return { ok: true, offline: false, alreadyRecorded: false };
    } catch (e) {
      const f = e instanceof CommandFailure ? e : new CommandFailure('unknown', 'UNKNOWN_RESULT', String(e));
      if (f.kind === 'unknown') return { ok: false, code: f.reasonCode, message: `${reasonText(f.reasonCode)}，请勿重复收钱，稍后再点核对`, uncertain: true };
      inflight.delete(orderId);
      // 已被另一台设备 / 先前一次请求登记：对员工来说就是「已登记」，不需要再收钱。
      if (f.reasonCode === 'ALREADY_PAID') return { ok: true, offline: false, alreadyRecorded: true };
      return { ok: false, code: f.reasonCode, message: reasonText(f.reasonCode), uncertain: false };
    }
  }, [reg.claim, reg.shiftId, reg.serverApplied, rt, offlineMode]);
}
