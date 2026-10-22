/**
 * 主收银机资格与本机序号。
 * 联网时以服务器的收银机/班次文档为准；断网重开时退回最后一次联网保存的快照，
 * 且只在 24 小时离线营业资格内有效。序号在 IndexedDB 中原子分配，在线命令与离线事件共用。
 */
import { useCallback } from 'react';
import { storePath } from './firebase/client';
import { useLiveDoc } from './firebase/live';
import { allocateSequence, seqKey } from './local/idb';
import { useOfflineRuntime } from './offline/runtime';
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

export type RegisterStatus = 'loading' | 'not_configured' | 'not_this_device' | 'no_shift' | 'offline_expired' | 'ready';

export function useRegister() {
  const { config, deviceId, user } = useSession();
  const rt = useOfflineRuntime();
  const registerId = config?.activeRegisterId ?? null;
  const reg = useLiveDoc<RegisterDoc>(registerId ? storePath(`registers/${registerId}`) : null);
  const shift = useLiveDoc<ShiftDoc>(reg.data?.shiftId ? storePath(`shifts/${reg.data.shiftId}`) : null);

  const snap = rt.snapshot && user && rt.snapshot.uid === user.uid && rt.snapshot.deviceId === deviceId ? rt.snapshot : null;
  const fromSnapshot = !reg.data && reg.fromCache && Boolean(snap);

  const regData: RegisterDoc | null = reg.data ?? (fromSnapshot && snap
    ? { activeDeviceId: snap.claim.deviceId, epoch: snap.claim.registerEpoch, lastAppliedSequence: snap.serverApplied, shiftId: snap.shiftId }
    : null);
  const shiftData: ShiftDoc | null = shift.data ?? (snap && regData?.shiftId === snap.shiftId && (fromSnapshot || shift.fromCache) ? (snap.shift as ShiftDoc) : null);

  let status: RegisterStatus = 'ready';
  if (!config || !deviceId || (reg.loading && !fromSnapshot)) status = 'loading';
  else if (!registerId || !regData) status = 'not_configured';
  else if (regData.activeDeviceId !== deviceId) status = 'not_this_device';
  else if (!regData.shiftId || !shiftData || shiftData.status !== 'open') status = shift.loading && !snap ? 'loading' : 'no_shift';
  else if (fromSnapshot && Date.now() > shiftData.offlineCapabilityExpiresAtMs) status = 'offline_expired';

  const claim = registerId && regData && deviceId ? { deviceId, registerId, registerEpoch: regData.epoch } : null;
  const serverApplied = regData?.lastAppliedSequence ?? 0;

  /** 原子分配下一个序号（在线命令与离线事件共用）。 */
  const allocate = useCallback(async () => {
    if (!claim) throw new Error('收银机未就绪');
    return allocateSequence(seqKey(claim.registerId, claim.registerEpoch), serverApplied);
  }, [claim?.registerId, claim?.registerEpoch, serverApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status, registerId, claim, shiftId: regData?.shiftId ?? null, shift: shiftData, serverApplied, allocate,
    fromSnapshot, fromCache: reg.fromCache,
  };
}
