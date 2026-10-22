/**
 * 门店配置与主收银机资格检查。
 */
import { Transaction } from 'firebase-admin/firestore';
import { BusinessDayPolicy } from '../../../src/domain/businessDay';
import { CommandError } from './errors';
import { Raw, int, str } from './input';
import type { StoreRefs } from './command';

export interface StoreConfig {
  name: string;
  businessDay: BusinessDayPolicy;
  activeMenuVersion: string;
  activeBomVersion: string;
  activeRegisterId: string | null;
  qrConfigured: boolean;
}

export async function loadStoreConfig(tx: Transaction, store: StoreRefs): Promise<StoreConfig> {
  const snap = await tx.get(store.configPublic);
  const c = snap.data();
  if (!snap.exists || !c) throw new CommandError('STORE_NOT_CONFIGURED');
  return {
    name: c.name,
    businessDay: { timeZone: c.timeZone, cutoverMinutes: c.cutoverMinutes },
    activeMenuVersion: c.activeMenuVersion,
    activeBomVersion: c.activeBomVersion,
    activeRegisterId: c.activeRegisterId ?? null,
    qrConfigured: Boolean(c.qrPayee),
  };
}

export interface RegisterClaim {
  deviceId: string;
  registerId: string;
  registerEpoch: number;
}

export const REGISTER_CLAIM_FIELDS = ['deviceId', 'registerId', 'registerEpoch'];

export function parseRegisterClaim(o: Raw): RegisterClaim {
  return { deviceId: str(o, 'deviceId', 64), registerId: str(o, 'registerId', 40), registerEpoch: int(o, 'registerEpoch', 0, 1_000_000) };
}

/** 只有门店当前指定的主收银机、且设备与 epoch 吻合，才能产生新订单。 */
export async function requireActiveRegister(tx: Transaction, store: StoreRefs, config: StoreConfig, claim: RegisterClaim) {
  if (config.activeRegisterId !== claim.registerId) throw new CommandError('REGISTER_REVOKED', '不是当前主收银机');
  const snap = await tx.get(store.register(claim.registerId));
  const r = snap.data();
  if (!snap.exists || !r) throw new CommandError('REGISTER_REVOKED', '收银机不存在');
  if (r.activeDeviceId !== claim.deviceId || r.epoch !== claim.registerEpoch) {
    throw new CommandError('REGISTER_REVOKED', '设备或 epoch 已失效', { currentEpoch: r.epoch });
  }
  return { lastAppliedSequence: (r.lastAppliedSequence as number) ?? 0, shiftId: (r.shiftId as string | null) ?? null, epoch: r.epoch as number };
}

/** 本机日志序号必须连续；缺号不能越过。 */
export function requireNextSequence(lastApplied: number, sequence: number) {
  if (sequence !== lastApplied + 1) throw new CommandError('SEQUENCE_GAP', `期望序号 ${lastApplied + 1}`, { expectedSequence: lastApplied + 1 });
}

/** 营业日写入屏障：closing/closed 状态拒绝影响当日账本的命令。 */
export async function requireDayOpen(tx: Transaction, store: StoreRefs, date: string) {
  const snap = await tx.get(store.businessDay(date));
  const d = snap.data();
  if (d && d.state !== 'open') throw new CommandError('DAY_CLOSED', `${date} 已${d.state === 'closing' ? '在关账中' : '关账'}`);
  return { exists: snap.exists, receiptSeq: (d?.receiptSeq as number) ?? 0 };
}

/**
 * 记录当日账本活动：所有影响某营业日账本的命令都写一次营业日文档，
 * 与关账在同一文档上串行——关账先提交则本命令重试后被拒绝，本命令先提交则被关账汇总包含。
 */
export function markDayActivity(tx: Transaction, store: StoreRefs, date: string, day: { exists: boolean }, nowMs: number) {
  if (day.exists) tx.update(store.businessDay(date), { lastActivityAtMs: nowMs });
  else tx.set(store.businessDay(date), { state: 'open', receiptSeq: 0, lastActivityAtMs: nowMs });
}
