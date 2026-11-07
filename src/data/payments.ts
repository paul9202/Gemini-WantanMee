/**
 * 收款登记（主点单平板）：员工确认整单已收到，不分渠道、不输入实收找零。
 * - 联网：recordPayment 命令；先补传本机未同步日志（保证原订单 / 先前的离线收款先到）。
 *   同一订单在本页内重试复用同一个 operationId，结果不明先查询原操作，不让员工再收一次。
 * - 断网，或订单本身还只在本机：写 offline_payment_recorded 事件，先原子落盘再算成功。
 * 原单与加单可以一次结账（useRecordPayments）。
 * 二维码显示 / 扫描 / 关闭都不调用这里；只有员工点「确认已收款」才登记。
 */
import { useCallback } from 'react';
import { PaidAtServeConflict, paidAtServeConflict } from '../domain/bill';
import { formatRM } from '../domain/money';
import { currentLang } from '../app/i18n';
import { CommandFailure, newOperationId, submit } from './firebase/commands';
import { useOnline } from './firebase/live';
import { reasonText } from './firebase/reasons';
import { appendManualEvent, syncNow, unsyncedEvents, useOfflineRuntime } from './offline/runtime';
import { useRegister } from './register';

/**
 * paidAtServe：前台点收款的同时后厨刚好出餐，服务器已按「出餐即记收款」记了这张单（送餐的人可能已经收过钱）。
 * 这时不是「之前已登记」那么简单：页面要拦下来明说不要再收这一碗，剩下的按刷新后的账单再让员工确认，绝不自动替他收。
 */
export type RecordPaymentOutcome =
  | { ok: true; offline: boolean; alreadyRecorded: boolean }
  | { ok: false; code: string; message: string; uncertain: boolean; paidAtServe?: PaidAtServeConflict };

/** 「9 号刚出餐，已经自动记收款」：牌号缺失时不写号。 */
export function paidAtServeTitle(c: PaidAtServeConflict): string {
  if (currentLang() === 'en') return c.tokenNumber !== null ? `Token ${c.tokenNumber} was just served and recorded as paid automatically` : 'Just served and recorded as paid automatically';
  return c.tokenNumber !== null ? `${c.tokenNumber} 号刚出餐，已经自动记收款` : '这张单刚出餐，已经自动记收款';
}

function paidAtServeMessage(c: PaidAtServeConflict): string {
  if (currentLang() === 'en') return `${paidAtServeTitle(c)}. The server may already have collected ${formatRM(c.paidSen)} — do not collect this bowl again.`;
  return `${paidAtServeTitle(c)}。送餐的人可能已经收过 ${formatRM(c.paidSen)}，不要再收这一碗。`;
}

/** orderId → 本页尚未得到确定结果的 operationId（超时重试复用，防止重复登记）。 */
const inflight = new Map<string, { id: string; atMs: number }>();
/** 结果不明后多久内重试算同一次收款。过了再收是新的一次（旧请求若已成功，服务器会回 ALREADY_PAID，不会重复记账）。 */
const INFLIGHT_TTL_MS = 5 * 60_000;

export function useRecordPayment() {
  const record = useRecordPayments();
  return useCallback((orderId: string, amountSen: number) => record([{ orderId, amountSen }]), [record]);
}

/**
 * 一次结账多张单：原单 + 它的加单（客人吃完再加打包）。只有一张时就是 recordPayment。
 * 联网：recordGroupPayment 一个事务，要么全部登记要么都不登记。
 * 断网或其中有本机单：逐单写 offline_payment_recorded（每条先落盘；已写过的跳过，可放心重试）。
 */
export function useRecordPayments() {
  const reg = useRegister();
  const rt = useOfflineRuntime();
  const online = useOnline();
  const offlineMode = !online || rt.manualOffline;

  return useCallback(async (orders: { orderId: string; amountSen: number }[]): Promise<RecordPaymentOutcome> => {
    if (!reg.claim || !reg.shiftId) return { ok: false, code: 'REGISTER_REVOKED', message: reasonText('REGISTER_REVOKED'), uncertain: false };
    const events = rt.outbox.filter((r) => r.status !== 'rejected').map((r) => r.event);
    const recordedLocally = (id: string) => events.some((e) => e.type === 'offline_payment_recorded' && e.payload.clientOrderId === id);
    const todo = orders.filter((o) => !recordedLocally(o.orderId));
    if (todo.length === 0) return { ok: true, offline: true, alreadyRecorded: true };
    const localOnly = (id: string) => rt.localOrders.some((o) => o.clientOrderId === id)
      && !rt.outbox.some((r) => r.event.type === 'offline_order_created' && r.event.payload.clientOrderId === id && r.status === 'accepted');
    if (offlineMode || todo.some((o) => localOnly(o.orderId))) {
      for (const o of todo) {
        const err = await appendManualEvent({ claim: reg.claim, shiftId: reg.shiftId, serverApplied: reg.serverApplied }, 'offline_payment_recorded', o.orderId, { amountSen: o.amountSen });
        if (err) return { ok: false, code: 'LOCAL_SAVE_FAILED', message: err, uncertain: false };
      }
      if (!offlineMode) void syncNow();
      return { ok: true, offline: true, alreadyRecorded: false };
    }
    if (unsyncedEvents(rt).length) await syncNow();
    // 按订单 ID 排序：同一组从不同页面重试，请求内容也一致（服务器按内容比对重试）。
    const sorted = [...todo].sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
    const key = sorted.map((o) => o.orderId).join('+');
    const prior = inflight.get(key);
    const operationId = prior && Date.now() - prior.atMs < INFLIGHT_TTL_MS ? prior.id : newOperationId();
    inflight.set(key, { id: operationId, atMs: prior?.id === operationId ? prior.atMs : Date.now() });
    try {
      if (todo.length === 1) await submit('recordPayment', { operationId, ...reg.claim, orderId: todo[0].orderId, amountSen: todo[0].amountSen });
      else await submit('recordGroupPayment', { operationId, ...reg.claim, orders: sorted });
      inflight.delete(key);
      return { ok: true, offline: false, alreadyRecorded: false };
    } catch (e) {
      const f = e instanceof CommandFailure ? e : new CommandFailure('unknown', 'UNKNOWN_RESULT', String(e));
      if (f.kind === 'unknown') return { ok: false, code: f.reasonCode, message: `${reasonText(f.reasonCode)}，请勿重复收钱，稍后再点核对`, uncertain: true };
      inflight.delete(key);
      // 刚被后厨出餐自动记了收款（单张或一组里的某张）：整组都没写。明确拦下，不当作「已登记」悄悄带过。
      const atServe = f.reasonCode === 'ALREADY_PAID' ? paidAtServeConflict(f.details) : null;
      if (atServe) return { ok: false, code: 'PAID_AT_SERVE', message: paidAtServeMessage(atServe), uncertain: false, paidAtServe: atServe };
      // 单张：已被另一台设备 / 先前一次请求登记，对员工来说就是「已登记」。
      // 一组里有一张已登记：整组都没写，列表刷新后只剩未登记的单，再确认一次即可。
      if (f.reasonCode === 'ALREADY_PAID' && todo.length === 1) return { ok: true, offline: false, alreadyRecorded: true };
      return { ok: false, code: f.reasonCode, message: reasonText(f.reasonCode), uncertain: false };
    }
  }, [reg.claim, reg.shiftId, reg.serverApplied, rt, offlineMode]);
}
