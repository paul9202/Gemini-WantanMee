/**
 * 开业前一次性清空测试数据。只限老板，并且必须输入确认码（店主 IC；后台只存哈希）。
 * - 清空：GO_LIVE_RESET_GROUPS 里的交易、收支、AI 记成本、操作与审计记录（连同子集合），以及收据图片。
 * - 保留：菜单、配方、食材清单、成员、设备、收银机、门店设置、开档成本与经营目标。为了让保留的数据仍然自洽：
 *   餐牌全部放回「可用」；收银机解除旧班次（序号不归零，否则收银机会报序号断档）；开档成本解除与已删支出的关联。
 * - 数据可能超过单个事务上限：先在事务里核对确认码并标记「清空中」，再分批删除；中途失败可再次输入确认码继续。
 *   完成后 config/goLive.status = 'live'，从此锁定，不能再清空。连续输错 5 次锁 30 分钟。
 * - 按老板的决定不做备份：删除不可恢复。确认码不写进操作记录、审计或日志。
 */
import { Firestore } from 'firebase-admin/firestore';
import {
  GO_LIVE_LOCKOUT_MS, GO_LIVE_MAX_FAILED_ATTEMPTS, GO_LIVE_RESET_COLLECTIONS, GoLiveStatus,
} from '../../../src/domain/goLive';
import { payloadHash } from '../../../src/domain/idempotency';
import { StoreRefs, storeRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { obj, str, storeId, uuid } from '../core/input';
import { verifyResetCode } from '../core/resetCode';

/** 「清空中」超过这个时间仍未完成，视为上次中途失败，允许用确认码继续。 */
const STALE_RUN_MS = 10 * 60_000;

export interface GoLiveDeps {
  /** Secret Manager 里的确认码哈希；空字符串表示还没设置。 */
  codeHash: string;
  deleteStoragePrefix: (prefix: string) => Promise<void>;
  now?: () => number;
}

export interface GoLiveState {
  status: GoLiveStatus;
  liveAtMs: number | null;
  lockedUntilMs: number | null;
  failedAttempts: number;
}

function stateOf(raw: Record<string, unknown> | undefined): GoLiveState {
  return {
    status: raw?.status === 'live' || raw?.status === 'resetting' ? raw.status : 'testing',
    liveAtMs: (raw?.liveAtMs as number | undefined) ?? null,
    lockedUntilMs: (raw?.lockedUntilMs as number | undefined) ?? null,
    failedAttempts: (raw?.failedAttempts as number | undefined) ?? 0,
  };
}

function requireOwner(uid: string | undefined, member: Record<string, unknown> | undefined): asserts uid is string {
  if (!uid) throw new CommandError('UNAUTHENTICATED');
  if (!member || member.active !== true) throw new CommandError('NOT_A_MEMBER');
  if (member.role !== 'owner') throw new CommandError('FORBIDDEN');
}

async function countAll(store: StoreRefs): Promise<Record<string, number>> {
  const counts = await Promise.all(GO_LIVE_RESET_COLLECTIONS.map(async (c) => [c, (await store.root.collection(c).count().get()).data().count] as const));
  return Object.fromEntries(counts);
}

/** 清空前预览：每类会删多少条，以及是否已锁定。不需要确认码，不改任何数据。 */
export async function previewStoreReset(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId']);
  const store = storeRefs(db, storeId(o));
  requireOwner(uid, uid ? (await store.member(uid).get()).data() : undefined);
  const state = stateOf((await store.configGoLive.get()).data());
  return { ...state, counts: state.status === 'live' ? {} : await countAll(store) };
}

export async function resetStoreForOpening(db: Firestore, uid: string | undefined, raw: unknown, deps: GoLiveDeps) {
  const o = obj(raw, ['storeId', 'operationId', 'confirmCode']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), confirmCode: str(o, 'confirmCode', 64) };
  const now = deps.now ?? Date.now;
  const store = storeRefs(db, input.storeId);
  // scrypt 放在事务外算一次（事务可能被重试）；结果只在确认是本店老板之后才使用。
  const codeOk = deps.codeHash ? verifyResetCode(input.confirmCode, deps.codeHash) : null;

  const gate = await db.runTransaction(async (tx) => {
    const t = now();
    const member = uid ? (await tx.get(store.member(uid))).data() : undefined;
    requireOwner(uid, member);
    const gRaw = (await tx.get(store.configGoLive)).data();
    const g = stateOf(gRaw);
    if (g.status === 'live') throw new CommandError('GO_LIVE_LOCKED', '已经清空过并正式营业，不能再清空', { liveAtMs: g.liveAtMs });
    if (codeOk === null) throw new CommandError('RESET_NOT_CONFIGURED', '还没有设置确认码');
    if (g.lockedUntilMs !== null && g.lockedUntilMs > t) throw new CommandError('RESET_LOCKED_OUT', '输错次数太多，请稍后再试', { lockedUntilMs: g.lockedUntilMs });
    const started = gRaw?.startedAtMs as number | undefined;
    if (g.status === 'resetting' && started !== undefined && t - started < STALE_RUN_MS) throw new CommandError('RESET_IN_PROGRESS', '正在清空，请稍候刷新');
    if (!codeOk) {
      // 上一次锁定已过期就重新计数。
      const failed = (g.lockedUntilMs !== null ? 0 : g.failedAttempts) + 1;
      const lockedUntilMs = failed >= GO_LIVE_MAX_FAILED_ATTEMPTS ? t + GO_LIVE_LOCKOUT_MS : null;
      tx.set(store.configGoLive, { failedAttempts: lockedUntilMs ? 0 : failed, lockedUntilMs, lastFailedAtMs: t, lastFailedBy: uid }, { merge: true });
      return { ok: false as const, remainingAttempts: lockedUntilMs ? 0 : GO_LIVE_MAX_FAILED_ATTEMPTS - failed, lockedUntilMs };
    }
    tx.set(store.configGoLive, { status: 'resetting', startedAtMs: t, startedBy: uid, failedAttempts: 0, lockedUntilMs: null }, { merge: true });
    return { ok: true as const, startedAtMs: t };
  });
  if (!gate.ok) {
    if (gate.lockedUntilMs) throw new CommandError('RESET_LOCKED_OUT', '输错次数太多，请稍后再试', { lockedUntilMs: gate.lockedUntilMs });
    throw new CommandError('WRONG_CONFIRM_CODE', '确认码不对', { remainingAttempts: gate.remainingAttempts });
  }
  const ownerUid = uid as string;

  // 1) 删除测试数据（连同子集合：草稿的识别尝试、日结的历史版本）。
  const deleted: Record<string, number> = {};
  for (const name of GO_LIVE_RESET_COLLECTIONS) {
    const ref = store.root.collection(name);
    deleted[name] = (await ref.count().get()).data().count;
    await db.recursiveDelete(ref);
  }

  // 2) 让保留的数据与清空后的状态一致。
  const t = now();
  const writer = db.bulkWriter();
  for (const tok of (await store.root.collection('tokens').get()).docs) {
    const d = tok.data();
    writer.set(tok.ref, { number: (d.number as number) ?? Number(tok.id), state: 'available', orderId: null, version: ((d.version as number) ?? 0) + 1, updatedAtMs: t });
  }
  for (const reg of (await store.root.collection('registers').get()).docs) {
    if (reg.data().shiftId) writer.update(reg.ref, { shiftId: null });
  }
  for (const s of (await store.root.collection('startupCosts').get()).docs) {
    const linked = s.data().linkedExpenses;
    if (Array.isArray(linked) && linked.length) writer.update(s.ref, { linkedExpenses: [] });
  }
  await writer.close();

  // 3) 收据图片（AI 记成本草稿的附件）。
  await deps.deleteStoragePrefix(`stores/${input.storeId}/ai-cost-drafts/`);

  // 4) 锁定，并留下这一次清空本身的操作与审计记录（不含确认码）。
  const deletedTotal = Object.values(deleted).reduce((a, b) => a + b, 0);
  const result = { status: 'live' as const, liveAtMs: t, deleted, deletedTotal };
  const batch = db.batch();
  batch.set(store.configGoLive, { status: 'live', liveAtMs: t, liveBy: ownerUid, startedAtMs: gate.startedAtMs, deleted, deletedTotal, failedAttempts: 0, lockedUntilMs: null }, { merge: true });
  batch.set(store.operation(input.operationId), {
    type: 'resetStoreForOpening', actorUid: ownerUid, committedAtMs: t, result,
    payloadHash: await payloadHash({ type: 'resetStoreForOpening', storeId: input.storeId, payload: { storeId: input.storeId } }),
  });
  batch.set(store.audit(input.operationId), {
    operationId: input.operationId, action: 'resetStoreForOpening', actorUid: ownerUid, actorRole: 'owner',
    entityId: 'store', before: { deleted, deletedTotal }, after: { status: 'live' }, atMs: t,
  });
  await batch.commit();
  return result;
}
