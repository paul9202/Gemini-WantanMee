/**
 * 老板命令：成员管理、指定主收银机；以及结果查询。
 * 第一个 owner 只能由管理员脚本初始化（见 src/admin/bootstrap.ts），没有公开的「注册成为老板」接口。
 */
import { Firestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { runCommand, storeRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { bool, obj, oneOf, str, storeId, uuid } from '../core/input';

/**
 * 邀请成员：老板填写员工邮箱与岗位。账号不存在时由服务端创建（不设密码），
 * 返回一次性的设置密码链接，由老板交给员工；没有公开的自助注册。
 */
export async function inviteMember(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'email', 'role', 'displayName']);
  const email = str(o, 'email', 120, 3).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CommandError('INVALID_ARGUMENT', '邮箱格式不正确');
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), email,
    role: oneOf(o, 'role', ['owner', 'cashier', 'kitchen'] as const), displayName: str(o, 'displayName', 60),
  };
  if (!uid) throw new CommandError('UNAUTHENTICATED');
  // 先在事务外确认调用者是老板，再创建 Auth 账号（Auth 不在 Firestore 事务内）。
  const caller = (await storeRefs(db, input.storeId).member(uid).get()).data();
  if (!caller || caller.active !== true) throw new CommandError('NOT_A_MEMBER');
  if (caller.role !== 'owner') throw new CommandError('FORBIDDEN');
  const auth = getAuth();
  const existing = await auth.getUserByEmail(input.email).catch(() => null);
  const user = existing ?? (await auth.createUser({ email: input.email, displayName: input.displayName, emailVerified: false }));
  const out = await runCommand(db, {
    type: 'inviteMember', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ref = store.member(user.uid);
      const before = (await tx.get(ref)).data() ?? null;
      if (before?.role === 'owner' && input.role !== 'owner') throw new CommandError('FORBIDDEN', '不能用邀请降级老板账号');
      tx.set(ref, { role: input.role, active: true, displayName: input.displayName, email: input.email, updatedAtMs: nowMs, updatedBy: actor.uid });
      return {
        result: { memberUid: user.uid, created: !existing },
        audit: { entityId: `member-${user.uid}`, before, after: { role: input.role, email: input.email } },
      };
    },
  });
  // 设置密码链接：每次调用重新生成；不记录在数据库里。
  const setupLink = await auth.generatePasswordResetLink(input.email);
  return { ...out, result: { ...out.result, setupLink } };
}

export async function manageMember(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'memberUid', 'role', 'active', 'displayName', 'reason']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), memberUid: str(o, 'memberUid', 128),
    role: oneOf(o, 'role', ['owner', 'cashier', 'kitchen'] as const), active: bool(o, 'active'),
    displayName: str(o, 'displayName', 60), reason: str(o, 'reason', 200),
  };
  const out = await runCommand(db, {
    type: 'manageMember', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ref = store.member(input.memberUid);
      const before = (await tx.get(ref)).data() ?? null;
      if (input.memberUid === actor.uid && (input.role !== 'owner' || !input.active)) {
        throw new CommandError('FORBIDDEN', '不能停用或降级自己的老板账号');
      }
      tx.set(ref, { role: input.role, active: input.active, displayName: input.displayName, updatedAtMs: nowMs, updatedBy: actor.uid }, { merge: true });
      return {
        result: { memberUid: input.memberUid, role: input.role, active: input.active },
        audit: { entityId: `member-${input.memberUid}`, before, after: { role: input.role, active: input.active } },
      };
    },
  });
  // 停用成员时吊销登录令牌，已登录的设备在令牌刷新时被拒绝；Rules 与命令也会因成员停用而拒绝。
  if (!out.replayed && !input.active) await getAuth().revokeRefreshTokens(input.memberUid).catch(() => undefined);
  return out;
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
