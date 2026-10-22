/**
 * 本机 IndexedDB（独立于 Firestore 缓存）。当前保存：设备身份、待核对的收款请求。
 * 阶段 D 将在同一数据库增加 localOrders/outbox/localTokens（升级版本时不得删除 pendingOps）。
 * 每次写入都等事务 complete 才算成功；配额不足等错误原样抛出，界面不得假装成功。
 */

const DB_NAME = 'hao-pos';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('pendingOps')) db.createObjectStore('pendingOps', { keyPath: 'operationId' });
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

type StoreName = 'kv' | 'pendingOps';

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result: T | undefined;
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => (result = req.result);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务已中止'));
  });
}

export const kvGet = <T>(key: string) => run<T>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T>);
export const kvSet = (key: string, value: unknown) => run('kv', 'readwrite', (s) => void s.put(value, key));

export type PendingStatus = 'submitting' | 'unknown_result' | 'accepted' | 'rejected';

export interface PendingOp {
  operationId: string;
  name: 'createOrder';
  payload: Record<string, unknown> & { operationId: string };
  status: PendingStatus;
  createdAtMs: number;
  updatedAtMs: number;
  summary: { tokenNumber: number; totalSen: number; method: string; tenderedSen: number | null };
  result?: Record<string, unknown>;
  reasonCode?: string;
}

export const putPendingOp = (op: PendingOp) => run('pendingOps', 'readwrite', (s) => void s.put(op));
export const getPendingOp = (id: string) => run<PendingOp>('pendingOps', 'readonly', (s) => s.get(id) as IDBRequest<PendingOp>);
export const listPendingOps = async () => ((await run<PendingOp[]>('pendingOps', 'readonly', (s) => s.getAll() as IDBRequest<PendingOp[]>)) ?? []);

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
