/**
 * 老板端数据：按营业日区间一次性读取账本（受 Rules 限制，仅老板可读），用领域函数纯计算。
 * 首版直接读账本，不依赖 dailyStats 缓存；数据量变大后再加可重建的汇总缓存。
 */
import { useCallback, useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where, QueryConstraint } from 'firebase/firestore';
import { BOM_V1, BOM_VERSIONS, BomVersion } from '../../domain/bom';
import { DEFAULT_SALES_TARGETS } from '../../domain/costing';
import { addDays } from '../../domain/businessDay';
import { CostSourcesDoc, DayUsage, EMPTY_COST_SOURCES, StockBatch, StockCountDoc } from '../../domain/costSources';
import { materialUsage, UsageOrder } from '../../domain/usage';
import type { DateRange } from '../../domain/businessDay';
import type { CloseOrderRow, LedgerDocs, OrderReportRow } from '../../domain/ledger';
import type { Sen } from '../../domain/money';
import { db, storePath } from '../../data/firebase/client';

async function fetchAll<T>(name: string, ...constraints: QueryConstraint[]): Promise<T[]> {
  const snap = await getDocs(query(collection(db, storePath(name)), ...constraints));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
}

const inRange = (field: string, r: DateRange) => [where(field, '>=', r.start), where(field, '<', r.endExclusive)];

export async function loadLedger(range: DateRange | null): Promise<{ docs: LedgerDocs; orders: OrderReportRow[] }> {
  const c = (field = 'businessDate') => (range ? inRange(field, range) : []);
  const [payments, refunds, costEvents, wastage, expensesPaid, expensesAccrued, cashMovements, orders, writeOffs, expenseLinks] = await Promise.all([
    fetchAll<LedgerDocs['payments'][number]>('payments', ...c()),
    fetchAll<LedgerDocs['refunds'][number]>('refunds', ...c()),
    fetchAll<LedgerDocs['costEvents'][number]>('costEvents', ...c()),
    fetchAll<LedgerDocs['wastage'][number]>('wastage', ...c()),
    fetchAll<LedgerDocs['expenses'][number]>('expenses', ...c()),
    range ? fetchAll<LedgerDocs['expenses'][number]>('expenses', ...c('accrualDate')) : Promise.resolve([]),
    fetchAll<LedgerDocs['cashMovements'][number]>('cashMovements', ...c()),
    range ? fetchAll<OrderReportRow>('orders', ...c()) : Promise.resolve([] as OrderReportRow[]),
    fetchAll<NonNullable<LedgerDocs['writeOffs']>[number]>('paymentWriteOffs', ...c()),
    fetchAll<NonNullable<LedgerDocs['expenseLinks']>[number]>('expenseLinks'),
  ]);
  const expenses = [...new Map([...expensesPaid, ...expensesAccrued].map((e) => [e.id, e])).values()];
  return { docs: { payments, refunds, costEvents, wastage, expenses, cashMovements, writeOffs, expenseLinks }, orders };
}

/**
 * 截至某营业日仍待登记收款的有效订单（含之前营业日结转来的）。
 * 餐牌会复用：每单以订单 ID / 票号识别，餐牌号只作辅助。
 */
export async function loadUnpaidOrders(upTo: string | null): Promise<CloseOrderRow[]> {
  const rows = await fetchAll<CloseOrderRow>('orders', where('paymentState', '==', 'unpaid'));
  return rows
    .filter((o) => o.fulfillmentStatus !== 'cancelled' && (upTo === null || o.businessDate <= upTo))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || (a.acceptedAtEffectiveMs ?? 0) - (b.acceptedAtEffectiveMs ?? 0));
}

/**
 * 区间内订单的应收与登记情况（按订单营业日）。有效订单金额是应收口径，不等于实收；
 * 未登记 = 有效且仍待登记收款的订单金额。收款数字以账本流水（按登记日）为准，两者口径不同。
 */
export function orderPaymentOverview(orders: Pick<OrderReportRow, 'fulfillmentStatus' | 'paymentState' | 'totalSen'>[]): {
  validCount: number; validSen: Sen; unpaidCount: number; unpaidSen: Sen; cancelledCount: number;
} {
  const valid = orders.filter((o) => o.fulfillmentStatus !== 'cancelled');
  const unpaid = valid.filter((o) => o.paymentState === 'unpaid');
  return {
    validCount: valid.length, validSen: valid.reduce((s, o) => s + o.totalSen, 0),
    unpaidCount: unpaid.length, unpaidSen: unpaid.reduce((s, o) => s + o.totalSen, 0),
    cancelledCount: orders.length - valid.length,
  };
}

export const FULFILL_ZH: Record<string, string> = { queued: '待做', preparing: '制作中', served: '已出餐', cancelled: '已取消' };

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
  payload: { type: string; payload: { clientOrderId: string; tokenNumber?: number; offlineReceiptNumber?: string; totalSen?: number; payment?: { method: string } | null; amountSen?: number }; occurredAtDeviceMs: number };
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

/** 当前启用的单位成本（BOM）：随代码发布的版本直接用；老板发布的版本从 bomVersions 读。读不到时退回 BOM_V1。 */
export async function loadActiveBom(version: string | null | undefined): Promise<BomVersion> {
  if (!version) return BOM_V1;
  if (BOM_VERSIONS[version]) return BOM_VERSIONS[version];
  return ((await getDoc(doc(db, storePath(`bomVersions/${version}`)))).data()?.bom as BomVersion | undefined) ?? BOM_V1;
}

/** 每日面团粒数目标（经营目标里设的，默认 50）。 */
export async function loadDailyBallsTarget(): Promise<number> {
  const goals = (await getDoc(doc(db, storePath('config/goals')))).data() as { sales?: { dailyBalls?: number } } | undefined;
  return goals?.sales?.dailyBalls ?? DEFAULT_SALES_TARGETS.dailyBalls;
}

/** 单位成本里还没实店核实的项目（老板看得懂的名字）。 */
export const CALIBRATION_ZH: Record<string, string> = {
  'noodleHalfBall.mee_poh': '面薄面团', 'base.soup_noodle': '汤面汤底', scallion_lard_extra: '多葱 / 多油渣',
};

/** 单价来源与 AI 建议（config/costSources）。 */
export async function loadCostSources(): Promise<CostSourcesDoc> {
  const d = (await getDoc(doc(db, storePath('config/costSources')))).data() as Partial<CostSourcesDoc> | undefined;
  return { ...EMPTY_COST_SOURCES, ...d, prices: d?.prices ?? {}, suggestions: d?.suggestions ?? {}, conversions: d?.conversions ?? {} };
}

/**
 * 算剩余要用的资料：近 35 天每天的用量（订单算）、进货批次、收档点数、单价来源。
 * 35 天够涵盖「近 30 天第一次进货」起点和前三周同一天。
 */
export async function loadStockInputs(today: string): Promise<{ days: DayUsage[]; batches: StockBatch[]; counts: StockCountDoc[]; sources: CostSourcesDoc }> {
  const from = addDays(today, -35), to = addDays(today, 1);
  const [orders, batches, counts, sources] = await Promise.all([
    fetchAll<UsageOrder & { businessDate: string }>('orders', where('businessDate', '>=', from), where('businessDate', '<', to)),
    fetchAll<StockBatch>('ingredientBatches'),
    fetchAll<StockCountDoc>('stockCounts'),
    loadCostSources(),
  ]);
  const days: DayUsage[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push({ date: d, usage: materialUsage(orders.filter((o) => o.businessDate === d)) });
  return { days, batches, counts, sources };
}

/** 一段营业日的订单（今天页「最近的生意」算单数、碗数、粒面、卖最多用）。 */
export async function loadOrdersRange(range: DateRange): Promise<(UsageOrder & { businessDate: string })[]> {
  return fetchAll<UsageOrder & { businessDate: string }>('orders', ...inRange('businessDate', range));
}
