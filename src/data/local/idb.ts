/**
 * 本机 IndexedDB（独立于 Firestore 缓存）。
 * - kv：设备 ID、本机序号、离线营业快照、上次发出的牌号
 * - pendingOps：在线下单请求（结果不明时据此核对，不重复送厨 / 不让顾客重复付钱）
 * - localOrders / outbox：离线接单与不可变事件日志
 * 离线接单在「同一个事务」里写入订单、事件与序号：任何一步失败整次回滚，界面不得假装成功。
 * 升级版本只新增存储，绝不删除 outbox / pendingOps。
 */
import type { OfflineEvent, OfflineEventResult, OfflineOrderPayload } from '../../domain/offline';

const DB_NAME = 'hao-pos';
const DB_VERSION = 2;

type StoreName = 'kv' | 'pendingOps' | 'localOrders' | 'outbox';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('pendingOps')) db.createObjectStore('pendingOps', { keyPath: 'operationId' });
        if (!db.objectStoreNames.contains('localOrders')) db.createObjectStore('localOrders', { keyPath: 'clientOrderId' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'eventId' }).createIndex('sequence', 'sequence');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

/** 仅测试用：关闭并重置连接，模拟「关闭浏览器后重开」。 */
export async function _resetConnectionForTests() {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

/** 多存储原子事务：fn 内的所有读写要么全部提交，要么全部回滚。 */
async function atomic<T>(stores: StoreName[], fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await open();
  const tx = db.transaction(stores, 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务已中止'));
  });
  let result: T;
  try {
    result = await fn(tx);
  } catch (e) {
    try { tx.abort(); } catch { /* 已中止 */ }
    await done.catch(() => {});
    throw e;
  }
  await done;
  return result;
}

async function readAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  return req(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return req(db.transaction('kv', 'readonly').objectStore('kv').get(key) as IDBRequest<T | undefined>);
}

export const kvSet = (key: string, value: unknown) => atomic(['kv'], async (tx) => void (await req(tx.objectStore('kv').put(value, key))));

// ---------- 在线收款请求 ----------

export type PendingStatus = 'submitting' | 'unknown_result' | 'not_found' | 'accepted' | 'rejected' | 'converted';

export interface PendingOp {
  operationId: string;
  name: 'createOrder';
  payload: Record<string, unknown> & { operationId: string; sequence: number; order: { clientOrderId: string } };
  status: PendingStatus;
  createdAtMs: number;
  updatedAtMs: number;
  /** 旧版记录还带 method / tenderedSen（下单即收款），只用于显示。 */
  summary: { tokenNumber: number; totalSen: number; method?: string; tenderedSen?: number | null };
  result?: Record<string, unknown>;
  reasonCode?: string;
}

export const putPendingOp = (op: PendingOp) => atomic(['pendingOps'], async (tx) => void (await req(tx.objectStore('pendingOps').put(op))));
export const listPendingOps = () => readAll<PendingOp>('pendingOps');

// ---------- 本机序号 ----------

export const seqKey = (registerId: string, epoch: number) => `seq:${registerId}:${epoch}`;

async function nextSeq(tx: IDBTransaction, key: string, serverApplied: number): Promise<number> {
  const stored = ((await req(tx.objectStore('kv').get(key))) as number | undefined) ?? 0;
  const seq = Math.max(stored, serverApplied) + 1;
  await req(tx.objectStore('kv').put(seq, key));
  return seq;
}

/** 为在线命令分配序号（与离线事件共用同一序号流）。 */
export const allocateSequence = (key: string, serverApplied: number) => atomic(['kv'], (tx) => nextSeq(tx, key, serverApplied));

/** 在线命令被明确拒绝且其后没有再分配序号时，归还这个序号；否则返回 false，需要写作废事件。 */
export const releaseSequence = (key: string, seq: number) => atomic(['kv'], async (tx) => {
  const stored = ((await req(tx.objectStore('kv').get(key))) as number | undefined) ?? 0;
  if (stored !== seq) return false;
  await req(tx.objectStore('kv').put(seq - 1, key));
  return true;
});

// ---------- 离线订单与事件日志 ----------

export type OutboxStatus = 'pending' | OfflineEventResult['status'];

export interface OutboxRecord {
  eventId: string;
  sequence: number;
  event: OfflineEvent;
  status: OutboxStatus;
  result: OfflineEventResult | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LocalOrder extends OfflineOrderPayload {
  sequence: number;
  createdAtMs: number;
  changeSen: number | null;
}

/** 离线接单：订单、事件、序号同一事务提交。 */
export function commitOfflineOrder(key: string, serverApplied: number, build: (sequence: number) => { event: OfflineEvent; order: LocalOrder }) {
  return atomic(['kv', 'outbox', 'localOrders'], async (tx) => {
    const sequence = await nextSeq(tx, key, serverApplied);
    const { event, order } = build(sequence);
    const now = Date.now();
    await req(tx.objectStore('outbox').add({ eventId: event.eventId, sequence, event, status: 'pending', result: null, createdAtMs: now, updatedAtMs: now } satisfies OutboxRecord));
    await req(tx.objectStore('localOrders').add(order));
    return { event, order };
  });
}

/** 追加收款确认 / 人工交接 / 人工出餐（旧版还有餐牌回收）事件。 */
export function appendOfflineEvent(key: string, serverApplied: number, build: (sequence: number) => OfflineEvent) {
  return atomic(['kv', 'outbox'], async (tx) => {
    const sequence = await nextSeq(tx, key, serverApplied);
    const event = build(sequence);
    const now = Date.now();
    await req(tx.objectStore('outbox').add({ eventId: event.eventId, sequence, event, status: 'pending', result: null, createdAtMs: now, updatedAtMs: now } satisfies OutboxRecord));
    return event;
  });
}

/** 写入使用既有序号的事件（作废序号、结果不明单转人工补账）。 */
export function putPresequencedEvent(event: OfflineEvent) {
  return atomic(['outbox'], async (tx) => {
    const now = Date.now();
    await req(tx.objectStore('outbox').add({ eventId: event.eventId, sequence: event.sequence, event, status: 'pending', result: null, createdAtMs: now, updatedAtMs: now } satisfies OutboxRecord));
  });
}

/**
 * 结果不明、云端查无此单、且收银确认已人工处理：用原订单号与原序号转为离线人工单补账。
 * 不换新 ID；若原请求其实稍后才落地，服务器会判冲突进入待核对，不会重复入账。
 */
export function convertPendingToOffline(op: PendingOp, event: OfflineEvent, order: LocalOrder) {
  return atomic(['outbox', 'localOrders', 'pendingOps'], async (tx) => {
    const now = Date.now();
    await req(tx.objectStore('outbox').add({ eventId: event.eventId, sequence: event.sequence, event, status: 'pending', result: null, createdAtMs: now, updatedAtMs: now } satisfies OutboxRecord));
    await req(tx.objectStore('localOrders').add(order));
    await req(tx.objectStore('pendingOps').put({ ...op, status: 'converted', updatedAtMs: now }));
  });
}

export const listOutbox = async () => (await readAll<OutboxRecord>('outbox')).sort((a, b) => a.sequence - b.sequence);
export const listLocalOrders = async () => (await readAll<LocalOrder>('localOrders')).sort((a, b) => a.sequence - b.sequence);

export function applySyncResults(results: OfflineEventResult[]) {
  return atomic(['outbox'], async (tx) => {
    const s = tx.objectStore('outbox');
    for (const r of results) {
      const rec = (await req(s.get(r.eventId))) as OutboxRecord | undefined;
      if (rec) await req(s.put({ ...rec, status: r.status, result: r, updatedAtMs: Date.now() }));
    }
  });
}

// ---------- 恢复包 ----------

export interface RecoveryPackage {
  kind: 'hao-pos-recovery';
  version: 1;
  exportedAtMs: number;
  deviceId: string | undefined;
  outbox: OutboxRecord[];
  localOrders: LocalOrder[];
  pendingOps: PendingOp[];
}

export async function exportRecoveryPackage(): Promise<RecoveryPackage> {
  return {
    kind: 'hao-pos-recovery', version: 1, exportedAtMs: Date.now(), deviceId: await kvGet<string>('deviceId'),
    outbox: await listOutbox(), localOrders: await listLocalOrders(), pendingOps: await listPendingOps(),
  };
}

/** 导入恢复包：已有的 eventId / 订单不覆盖（服务器端同样按 eventId 幂等）。 */
export function importRecoveryPackage(p: RecoveryPackage) {
  if (p.kind !== 'hao-pos-recovery' || p.version !== 1) throw new Error('不是有效的恢复包');
  return atomic(['outbox', 'localOrders'], async (tx) => {
    let added = 0;
    for (const r of p.outbox) {
      if (!(await req(tx.objectStore('outbox').get(r.eventId)))) {
        await req(tx.objectStore('outbox').add(r));
        added++;
      }
    }
    for (const o of p.localOrders) if (!(await req(tx.objectStore('localOrders').get(o.clientOrderId)))) await req(tx.objectStore('localOrders').add(o));
    return added;
  });
}

// ---------- 设备 ----------

/** 申请持久化存储（辅助，不保证永不被清除）。 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function getDeviceId(): Promise<string> {
  const existing = await kvGet<string>('deviceId');
  if (existing) return existing;
  const id = `dev-${crypto.randomUUID()}`;
  await kvSet('deviceId', id);
  return id;
}
