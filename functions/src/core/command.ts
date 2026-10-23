/**
 * 统一命令执行：认证 → 事务内读 operation（幂等）→ 读成员（角色）→ 业务读写 → 写 operation 与审计。
 * 同 operationId + 同 payload hash 返回原结果；同 ID 不同 payload 为冲突。
 * 事务回调可能被 Firestore 重试，所以回调里不得有任何外部副作用。
 */
import { DocumentData, DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { payloadHash } from '../../../src/domain/idempotency';
import { CommandError } from './errors';

export type Role = 'owner' | 'cashier' | 'kitchen';

export interface Actor {
  uid: string;
  role: Role;
}

export interface CommandContext {
  tx: Transaction;
  db: Firestore;
  storeId: string;
  operationId: string;
  actor: Actor;
  nowMs: number;
  store: StoreRefs;
}

export interface CommandSpec<R> {
  type: string;
  storeId: string;
  operationId: string;
  uid: string | undefined;
  roles: Role[];
  /** 参与 hash 的标准化输入。 */
  payload: unknown;
  /** 业务逻辑：先读后写；返回结果与审计摘要。 */
  run: (ctx: CommandContext) => Promise<{ result: R; audit: { entityId: string; action?: string; before?: unknown; after?: unknown } }>;
}

export interface CommandOutcome<R> {
  result: R;
  replayed: boolean;
}

export function storeRefs(db: Firestore, storeId: string) {
  const root = db.collection('stores').doc(storeId);
  return {
    root,
    configPublic: root.collection('config').doc('public'),
    configFinance: root.collection('config').doc('finance'),
    member: (uid: string) => root.collection('members').doc(uid),
    register: (id: string) => root.collection('registers').doc(id),
    shift: (id: string) => root.collection('shifts').doc(id),
    order: (id: string) => root.collection('orders').doc(id),
    orderCost: (id: string) => root.collection('orderCosts').doc(id),
    ticket: (id: string) => root.collection('kitchenTickets').doc(id),
    token: (n: number) => root.collection('tokens').doc(String(n).padStart(2, '0')),
    payment: (id: string) => root.collection('payments').doc(id),
    refund: (id: string) => root.collection('refunds').doc(id),
    writeOff: (id: string) => root.collection('paymentWriteOffs').doc(id),
    cashMovement: (id: string) => root.collection('cashMovements').doc(id),
    businessDay: (date: string) => root.collection('businessDays').doc(date),
    operation: (id: string) => root.collection('operations').doc(id),
    audit: (id: string) => root.collection('auditEvents').doc(id),
    inbox: (eventId: string) => root.collection('offlineInbox').doc(eventId),
    costEvent: (id: string) => root.collection('costEvents').doc(id),
    expense: (id: string) => root.collection('expenses').doc(id),
    wastage: (id: string) => root.collection('wastage').doc(id),
    dailyReport: (date: string) => root.collection('dailyReports').doc(date),
    dailyReportVersion: (date: string, n: number) => root.collection('dailyReports').doc(date).collection('versions').doc(String(n)),
    status: root.collection('operationsStatus').doc('current'),
  };
}

export type StoreRefs = ReturnType<typeof storeRefs>;

export async function runCommand<R>(db: Firestore, spec: CommandSpec<R>): Promise<CommandOutcome<R>> {
  if (!spec.uid) throw new CommandError('UNAUTHENTICATED');
  const uid = spec.uid;
  const hash = await payloadHash({ type: spec.type, storeId: spec.storeId, payload: spec.payload });
  const store = storeRefs(db, spec.storeId);
  const opRef: DocumentReference = store.operation(spec.operationId);

  return db.runTransaction(async (tx) => {
    const opSnap = await tx.get(opRef);
    if (opSnap.exists) {
      const op = opSnap.data()!;
      if (op.payloadHash !== hash || op.actorUid !== uid) throw new CommandError('OPERATION_CONFLICT');
      return { result: op.result as R, replayed: true };
    }
    const memberSnap = await tx.get(store.member(uid));
    const member = memberSnap.data();
    if (!memberSnap.exists || !member || member.active !== true) throw new CommandError('NOT_A_MEMBER');
    if (!spec.roles.includes(member.role)) throw new CommandError('FORBIDDEN');
    const actor: Actor = { uid, role: member.role };
    const nowMs = Date.now();

    const { result, audit } = await spec.run({ tx, db, storeId: spec.storeId, operationId: spec.operationId, actor, nowMs, store });

    tx.create(opRef, {
      type: spec.type, actorUid: uid, payloadHash: hash, result, committedAtMs: nowMs,
    });
    tx.create(store.audit(spec.operationId), {
      operationId: spec.operationId, action: audit.action ?? spec.type, actorUid: uid, actorRole: actor.role,
      entityId: audit.entityId, before: audit.before ?? null, after: audit.after ?? null, atMs: nowMs,
    });
    return { result, replayed: false };
  });
}

/** 把 tx.get 的结果转成普通对象；不存在时抛 NOT_FOUND。 */
export async function getRequired<T = DocumentData>(tx: Transaction, ref: DocumentReference, what: string): Promise<T> {
  const snap = await tx.get(ref);
  if (!snap.exists) throw new CommandError('NOT_FOUND', `${what} 不存在`);
  return snap.data() as T;
}
