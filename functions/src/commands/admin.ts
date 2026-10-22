/**
 * 老板命令：成员管理、指定主收银机；以及结果查询。
 * 第一个 owner 只能由管理员脚本初始化（见 src/admin/bootstrap.ts），没有公开的「注册成为老板」接口。
 */
import { Firestore } from 'firebase-admin/firestore';
import { runCommand, storeRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { bool, obj, oneOf, str, storeId, uuid } from '../core/input';

export async function manageMember(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'memberUid', 'role', 'active', 'displayName', 'reason']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), memberUid: str(o, 'memberUid', 128),
    role: oneOf(o, 'role', ['owner', 'cashier', 'kitchen'] as const), active: bool(o, 'active'),
    displayName: str(o, 'displayName', 60), reason: str(o, 'reason', 200),
  };
  return runCommand(db, {
    type: 'manageMember', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ref = store.member(input.memberUid);
      const before = (await tx.get(ref)).data() ?? null;
      if (input.memberUid === actor.uid && (input.role !== 'owner' || !input.active)) {
        throw new CommandError('FORBIDDEN', '不能停用或降级自己的老板账号');
      }
      tx.set(ref, { role: input.role, active: input.active, displayName: input.displayName, updatedAtMs: nowMs, updatedBy: actor.uid });
      return {
        result: { memberUid: input.memberUid, role: input.role, active: input.active },
        audit: { entityId: `member-${input.memberUid}`, before, after: { role: input.role, active: input.active } },
      };
    },
  });
}

/** 指定主收银设备：epoch +1，旧设备的后续日志只能进入待核对。 */
export async function assignRegister(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'registerId', 'deviceId', 'reason']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), registerId: str(o, 'registerId', 40),
    deviceId: str(o, 'deviceId', 64), reason: str(o, 'reason', 200),
  };
  return runCommand(db, {
    type: 'assignRegister', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      const ref = store.register(input.registerId);
      const before = (await tx.get(ref)).data();
      const epoch = ((before?.epoch as number) ?? 0) + 1;
      tx.set(ref, {
        id: input.registerId, activeDeviceId: input.deviceId, epoch, lastAppliedSequence: 0, shiftId: null,
        assignedAtMs: nowMs, previousDeviceId: before?.activeDeviceId ?? null,
      });
      tx.set(store.configPublic, { activeRegisterId: input.registerId }, { merge: true });
      return {
        result: { registerId: input.registerId, deviceId: input.deviceId, epoch, lastAppliedSequence: 0 },
        audit: { entityId: `register-${input.registerId}`, before: before ?? null, after: { deviceId: input.deviceId, epoch } },
      };
    },
  });
}

/** 查询原操作结果（请求结果不明时先核对，不写入）。仅原操作者或老板可查。 */
export async function getOperationResult(db: Firestore, uid: string | undefined, raw: unknown) {
  if (!uid) throw new CommandError('UNAUTHENTICATED');
  const o = obj(raw, ['storeId', 'operationId']);
  const sid = storeId(o);
  const operationId = uuid(o, 'operationId');
  const store = storeRefs(db, sid);
  const member = (await store.member(uid).get()).data();
  if (!member || member.active !== true) throw new CommandError('NOT_A_MEMBER');
  const op = (await store.operation(operationId).get()).data();
  if (!op) return { status: 'not_found' as const };
  if (op.actorUid !== uid && member.role !== 'owner') throw new CommandError('FORBIDDEN');
  return { status: 'committed' as const, type: op.type as string, result: op.result };
}
