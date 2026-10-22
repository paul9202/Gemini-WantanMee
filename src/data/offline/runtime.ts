/**
 * 离线运行时（主收银机）：本机日志状态、补同步、离线营业快照、结果不明收款的核对。
 * - 「已同步」只来自服务器逐条结果，浏览器 online 事件只触发尝试。
 * - 结果不明的在线收款只自动「查询」，查不到时交给收银决定（厨房没做 → 原单重交；已人工处理 → 原单号转人工补账），
 *   绝不自动换新 ID 复制成新单。
 */
import { useSyncExternalStore } from 'react';
import { nextSyncBatch, OfflineEvent, OfflineEventResult } from '../../domain/offline';
import type { TokenBoard } from '../../domain/tokens';
import { call, CommandFailure } from '../firebase/commands';
import {
  appendOfflineEvent, applySyncResults, kvGet, kvSet, listLocalOrders, listOutbox, listPendingOps, LocalOrder, OutboxRecord, PendingOp,
  putPendingOp, putPresequencedEvent, releaseSequence, seqKey,
} from '../local/idb';

export interface OfflineSnapshot {
  uid: string;
  member: { role: 'owner' | 'cashier' | 'kitchen'; active: boolean; displayName: string };
  config: { name: string; timeZone: string; cutoverMinutes: number; activeMenuVersion: string; activeBomVersion: string; activeRegisterId: string | null; qrPayee: string | null };
  deviceId: string;
  claim: { deviceId: string; registerId: string; registerEpoch: number };
  shiftId: string;
  shift: { status: string; openingFloatSen: number; businessDate: string; offlineCapabilityExpiresAtMs: number };
  serverApplied: number;
  tokens: TokenBoard;
  serverOffsetMs: number;
  savedAtMs: number;
}

interface RuntimeState {
  loaded: boolean;
  outbox: OutboxRecord[];
  localOrders: LocalOrder[];
  pendingOps: PendingOp[];
  manualOffline: boolean;
  syncing: boolean;
  lastSyncAtMs: number | null;
  lastSyncError: string | null;
  snapshot: OfflineSnapshot | null;
  /** 最近一次测得的「服务器时间 − 本机时间」；未测到时为 null。 */
  serverOffsetMs: number | null;
}

let state: RuntimeState = {
  loaded: false, outbox: [], localOrders: [], pendingOps: [], manualOffline: false, syncing: false,
  lastSyncAtMs: null, lastSyncError: null, snapshot: null, serverOffsetMs: null,
};
const listeners = new Set<() => void>();
const emit = (patch: Partial<RuntimeState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function useOfflineRuntime(): RuntimeState {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
}

export async function reloadLocal() {
  const [outbox, localOrders, pendingOps, manualOffline, snapshot] = await Promise.all([
    listOutbox(), listLocalOrders(), listPendingOps(), kvGet<boolean>('manualOffline'), kvGet<OfflineSnapshot>('offlineSnapshot'),
  ]);
  emit({ loaded: true, outbox, localOrders, pendingOps, manualOffline: Boolean(manualOffline), snapshot: snapshot ?? null });
}

export const unsyncedEvents = (s: RuntimeState) => s.outbox.filter((r) => r.status === 'pending' || r.status === 'blocked');
export const unresolvedOps = (s: RuntimeState) => s.pendingOps.filter((o) => o.status === 'submitting' || o.status === 'unknown_result' || o.status === 'not_found');

export async function setManualOffline(v: boolean) {
  await kvSet('manualOffline', v);
  emit({ manualOffline: v });
}

export async function saveSnapshot(s: OfflineSnapshot) {
  await kvSet('offlineSnapshot', s);
  emit({ snapshot: s });
}

export async function recordServerOffset(offsetMs: number) {
  emit({ serverOffsetMs: Math.round(offsetMs) });
  if (!state.snapshot) return;
  await saveSnapshot({ ...state.snapshot, serverOffsetMs: Math.round(offsetMs) });
}

/** 估计的服务器当前时间。 */
export const serverNow = (s: RuntimeState) => Date.now() + (s.serverOffsetMs ?? s.snapshot?.serverOffsetMs ?? 0);

// ---------- 补同步 ----------

let inFlight: Promise<void> | null = null;

/** 按序号分批上传未同步事件。单飞；遇到阻塞（缺号）就停，等前置问题处理。 */
export function syncNow(): Promise<void> {
  if (inFlight) return inFlight;
  if (!navigator.onLine || state.manualOffline) return Promise.resolve();
  inFlight = (async () => {
    emit({ syncing: true, lastSyncError: null });
    try {
      await reconcilePendingOps();
      for (let round = 0; round < 40; round++) {
        await reloadLocal();
        const pending = unsyncedEvents(state);
        if (!pending.length) break;
        const batch = nextSyncBatch(pending);
        const { results } = await call<{ results: OfflineEventResult[] }>('syncOfflineEvents', { events: batch.map((r) => r.event) });
        await applySyncResults(results);
        if (results.some((r) => r.status === 'blocked')) {
          emit({ lastSyncError: '有记录被前面的缺号阻塞，请先处理待核对的收款' });
          break;
        }
      }
      emit({ lastSyncAtMs: Date.now() });
    } catch (e) {
      emit({ lastSyncError: e instanceof CommandFailure ? e.reasonCode : String(e) });
    } finally {
      await reloadLocal();
      emit({ syncing: false });
      inFlight = null;
    }
  })();
  return inFlight;
}

/** 结果不明的在线收款：只查询原操作，不自动重交。 */
async function reconcilePendingOps() {
  for (const op of await listPendingOps()) {
    if (op.status !== 'submitting' && op.status !== 'unknown_result') continue;
    const r = await call<{ status: 'committed' | 'not_found'; result?: Record<string, unknown> }>('getOperationResult', { operationId: op.operationId });
    await putPendingOp(r.status === 'committed'
      ? { ...op, status: 'accepted', result: r.result, updatedAtMs: Date.now() }
      : { ...op, status: 'not_found', updatedAtMs: Date.now() });
  }
}

/**
 * 在线命令被服务器明确拒绝：若其后没有再分配序号就归还；否则写「作废序号」事件补位，
 * 让后面的离线日志可以继续按序接纳。
 */
export async function voidRejectedSequence(op: { operationId: string; clientOrderId: string; sequence: number }, claim: OfflineSnapshot['claim'], shiftId: string) {
  const released = await releaseSequence(seqKey(claim.registerId, claim.registerEpoch), op.sequence);
  if (released) return 'released' as const;
  const event: OfflineEvent = {
    eventId: crypto.randomUUID(), registerId: claim.registerId, deviceId: claim.deviceId, registerEpoch: claim.registerEpoch,
    sequence: op.sequence, shiftId, occurredAtDeviceMs: Date.now(), lastServerOffsetMs: state.snapshot?.serverOffsetMs ?? 0,
    type: 'sequence_void', payload: { clientOrderId: op.clientOrderId, operationId: op.operationId },
  };
  await putPresequencedEvent(event);
  await reloadLocal();
  return 'voided' as const;
}

export interface RegisterContext {
  claim: { deviceId: string; registerId: string; registerEpoch: number };
  shiftId: string;
  serverApplied: number;
}

/** 追加人工交接 / 人工出餐 / 餐牌回收事件；失败返回中文错误，不假装成功。 */
export async function appendManualEvent(
  ctx: RegisterContext, type: 'manual_handoff' | 'manual_served' | 'token_returned', clientOrderId: string, tokenNumber?: number,
): Promise<string | null> {
  try {
    await appendOfflineEvent(seqKey(ctx.claim.registerId, ctx.claim.registerEpoch), ctx.serverApplied, (sequence) => {
      const base = {
        eventId: crypto.randomUUID(), ...ctx.claim, sequence, shiftId: ctx.shiftId, occurredAtDeviceMs: Date.now(),
        lastServerOffsetMs: state.snapshot?.serverOffsetMs ?? 0,
      };
      return type === 'token_returned'
        ? { ...base, type, payload: { clientOrderId, tokenNumber: tokenNumber! } }
        : { ...base, type, payload: { clientOrderId } };
    });
    await reloadLocal();
    return null;
  } catch (e) {
    return `本机保存失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

let autoStarted = false;

/** 联网时自动尝试补同步（浏览器 online 只是提示，结果以服务器逐条回复为准）。 */
export function startAutoSync() {
  if (autoStarted) return;
  autoStarted = true;
  void reloadLocal();
  window.addEventListener('online', () => void syncNow());
  setInterval(() => {
    if (navigator.onLine && !state.manualOffline && (unsyncedEvents(state).length || unresolvedOps(state).some((o) => o.status !== 'not_found'))) void syncNow();
  }, 20_000);
}
