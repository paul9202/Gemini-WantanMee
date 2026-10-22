/**
 * 老板端数据：按营业日区间一次性读取账本（受 Rules 限制，仅老板可读），用领域函数纯计算。
 * 首版直接读账本，不依赖 dailyStats 缓存；数据量变大后再加可重建的汇总缓存。
 */
import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, query, where, QueryConstraint } from 'firebase/firestore';
import type { DateRange } from '../../domain/businessDay';
import type { LedgerDocs, OrderReportRow } from '../../domain/ledger';
import { db, storePath } from '../../data/firebase/client';

async function fetchAll<T>(name: string, ...constraints: QueryConstraint[]): Promise<T[]> {
  const snap = await getDocs(query(collection(db, storePath(name)), ...constraints));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
}

const inRange = (field: string, r: DateRange) => [where(field, '>=', r.start), where(field, '<', r.endExclusive)];

export async function loadLedger(range: DateRange | null): Promise<{ docs: LedgerDocs; orders: OrderReportRow[] }> {
  const c = (field = 'businessDate') => (range ? inRange(field, range) : []);
  const [payments, refunds, costEvents, wastage, expensesPaid, expensesAccrued, cashMovements, orders] = await Promise.all([
    fetchAll<LedgerDocs['payments'][number]>('payments', ...c()),
    fetchAll<LedgerDocs['refunds'][number]>('refunds', ...c()),
    fetchAll<LedgerDocs['costEvents'][number]>('costEvents', ...c()),
    fetchAll<LedgerDocs['wastage'][number]>('wastage', ...c()),
    fetchAll<LedgerDocs['expenses'][number]>('expenses', ...c()),
    range ? fetchAll<LedgerDocs['expenses'][number]>('expenses', ...c('accrualDate')) : Promise.resolve([]),
    fetchAll<LedgerDocs['cashMovements'][number]>('cashMovements', ...c()),
    range ? fetchAll<OrderReportRow>('orders', ...c()) : Promise.resolve([] as OrderReportRow[]),
  ]);
  const expenses = [...new Map([...expensesPaid, ...expensesAccrued].map((e) => [e.id, e])).values()];
  return { docs: { payments, refunds, costEvents, wastage, expenses, cashMovements }, orders };
}

export interface InboxRow {
  id: string;
  type: string;
  status: 'needs_review' | 'blocked' | 'accepted' | 'rejected' | 'resolved';
  reasonCode: string | null;
  amountSen: number | null;
  sequence: number;
  registerId: string;
  receivedAtMs: number;
  resolution?: string;
  resolutionReason?: string;
  payload: { type: string; payload: { clientOrderId: string; tokenNumber?: number; offlineReceiptNumber?: string; totalSen?: number; payment?: { method: string } }; occurredAtDeviceMs: number };
}

export async function loadOpenReviews(): Promise<InboxRow[]> {
  return fetchAll<InboxRow>('offlineInbox', where('status', 'in', ['needs_review', 'blocked']));
}

/** 通用的「加载 + 手动刷新」状态。 */
export function useLoad<T>(fn: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; loadedAt: number | null }>({ data: null, error: null, loading: true, loadedAt: null });
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => setState({ data, error: null, loading: false, loadedAt: Date.now() }))
      .catch((e) => setState((s) => ({ ...s, loading: false, error: e?.code ?? String(e) })));
    // fn 每次渲染都是新函数；以 key 表示查询条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => run(), [run]);
  return { ...state, refresh: run };
}

/** 浏览器下载文本文件（CSV 已含 UTF-8 BOM）。 */
export function download(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
