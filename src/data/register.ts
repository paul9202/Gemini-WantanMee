/**
 * 主收银机资格与本机序号。
 * 序号 = max(服务器已应用序号, 本机最近成功序号) + 1；被拒绝的命令不消耗序号。
 * 阶段 D 会把在线与离线日志统一进 IndexedDB outbox。
 */
import { useCallback, useEffect, useRef } from 'react';
import { storePath } from './firebase/client';
import { useLiveDoc } from './firebase/live';
import { kvGet, kvSet } from './local/idb';
import { useSession } from '../app/session';

interface RegisterDoc {
  activeDeviceId: string;
  epoch: number;
  lastAppliedSequence: number;
  shiftId: string | null;
}

interface ShiftDoc {
  status: 'open' | 'closed';
  openingFloatSen: number;
  businessDate: string;
  offlineCapabilityExpiresAtMs: number;
}

export type RegisterStatus = 'loading' | 'not_configured' | 'not_this_device' | 'no_shift' | 'ready';

export function useRegister() {
  const { config, deviceId } = useSession();
  const registerId = config?.activeRegisterId ?? null;
  const reg = useLiveDoc<RegisterDoc>(registerId ? storePath(`registers/${registerId}`) : null);
  const shift = useLiveDoc<ShiftDoc>(reg.data?.shiftId ? storePath(`shifts/${reg.data.shiftId}`) : null);
  const localSeq = useRef(0);
  const seqKey = registerId && reg.data ? `seq:${registerId}:${reg.data.epoch}` : null;

  useEffect(() => {
    localSeq.current = 0;
    if (seqKey) void kvGet<number>(seqKey).then((v) => (localSeq.current = Math.max(localSeq.current, v ?? 0)));
  }, [seqKey]);

  let status: RegisterStatus = 'ready';
  if (!config || reg.loading || !deviceId) status = 'loading';
  else if (!registerId || !reg.data) status = 'not_configured';
  else if (reg.data.activeDeviceId !== deviceId) status = 'not_this_device';
  else if (!reg.data.shiftId || shift.loading) status = shift.loading ? 'loading' : 'no_shift';
  else if (!shift.data || shift.data.status !== 'open') status = 'no_shift';

  const claim = registerId && reg.data && deviceId ? { deviceId, registerId, registerEpoch: reg.data.epoch } : null;
  const serverSeq = reg.data?.lastAppliedSequence ?? 0;

  const nextSequence = useCallback(() => Math.max(serverSeq, localSeq.current) + 1, [serverSeq]);
  const markApplied = useCallback(async (seq: number) => {
    localSeq.current = Math.max(localSeq.current, seq);
    if (seqKey) await kvSet(seqKey, localSeq.current);
  }, [seqKey]);

  return { status, registerId, claim, shiftId: reg.data?.shiftId ?? null, shift: shift.data, nextSequence, markApplied, fromCache: reg.fromCache };
}
