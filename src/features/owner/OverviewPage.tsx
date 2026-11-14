/**
 * 今天（2026-11-14 经营改版，取代「经营概览」）：先回答三件事——卖了多少、赚了多少、用了多少料。
 * - 收入、利润口径不变：按已登记收款（summarizePeriod）；材料成本是下单时按单位成本记的理论成本，租金电费按日历日摊。
 * - 面团粒数、云吞、叉烧等用量全部由订单算出（domain/usage），老板不用录入。
 * - 第二阶段：有进货记录时第三张卡改成「材料够不够」（StockSection 同一算法）；页尾加收档小结（SummaryCard）。
 * - 收款明细、出餐效率、回本等原有细账收在页尾「细账」里，不删。
 * 所有数字都来自账本；无数据时显示空态，不放示例数字。
 */
import { ReactNode, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { addDays, businessDateOf, DateRange, daysInMonth, wallClock } from '../../domain/businessDay';
import { DEFAULT_FIXED_COST, FixedCostPolicy, monthlyFixedSen, summarizePeriod } from '../../domain/finance';
import { ballsText, DEFAULT_EXPENSE_PLAN, ExpenseLinkDoc, monthOf, paybackStatus, PlanExpense, StartupCostDoc, startupSummary } from '../../domain/costing';
import { csvExpenses, csvOrders, csvPayments, csvSummary, csvWastage, ledgerEvents, orderServiceStats, receiptsTrend, registeredBreakdown } from '../../domain/ledger';
import { costUnitsToSen, formatRM } from '../../domain/money';
import { materialUsage, UsageOrder } from '../../domain/usage';
import { OVERDUE_MS } from '../../domain/timing';
import { db, storePath } from '../../data/firebase/client';
import { useLiveQuery, useNow } from '../../data/firebase/live';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { Icon, Photo } from '../../ui/visual';
import type { IconName } from '../../ui/iconSymbols';
import { CALIBRATION_ZH, download, loadActiveBom, loadDailyBallsTarget, loadLedger, loadOpenReviews, orderPaymentOverview, useLoad } from './data';
import { BarList, minutes, OwnerTabs, pct, Section } from './ui';
import { useStock } from './StockSection';
import { SummaryCard } from './SummaryCard';

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayOf = (date: string) => WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
const NOODLE_ROWS = [['thin_egg', '细面'], ['mee_poh', '面薄']] as const;
const SIZE_COLS = [['small', '小', '1粒'], ['medium', '中', '1½粒'], ['large', '大', '2粒']] as const;

export function OverviewPage() {
  const { config } = useSession();
  const now = useNow(60_000);
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked && picked <= today ? picked : today;
  const isToday = date === today;
  const range: DateRange = { start: date || '2000-01-01', endExclusive: addDays(date || '2000-01-01', 1) };
  const lastWeek: DateRange = { start: addDays(range.start, -7), endExclusive: addDays(range.start, -6) };
  const key = `${today}-${date}`;
  // 门店配置载入前营业日为空：先不查询。
  const cur = useLoad(() => (date ? loadLedger(range) : Promise.resolve(null)), `cur-${key}`);
  const before = useLoad(() => (date ? loadLedger(lastWeek) : Promise.resolve(null)), `lastweek-${key}`);
  const all = useLoad(() => (today ? loadLedger(null) : Promise.resolve(null)), `all-${today}`);
  const reviews = useLoad(loadOpenReviews, 'reviews');
  const finance = useLoad(async () => (await getDoc(doc(db, storePath('config/finance')))).data() as { fixedCostPolicy: FixedCostPolicy } | undefined, 'finance');
  const bom = useLoad(() => loadActiveBom(config?.activeBomVersion), `bom-${config?.activeBomVersion}`);
  const target = useLoad(loadDailyBallsTarget, 'balls-target');
  const day = useLoad(async () => (date ? (await getDoc(doc(db, storePath(`businessDays/${date}`)))).data() as { state?: string } | undefined : undefined), `day-${key}`);
  const payInputs = useLoad(async () => ({
    startup: (await getDocs(collection(db, storePath('startupCosts')))).docs.map((d) => d.data() as StartupCostDoc),
    plan: { ...DEFAULT_EXPENSE_PLAN, ...((await getDoc(doc(db, storePath('config/expensePlan')))).data()?.plan ?? {}) },
    links: (await getDocs(collection(db, storePath('expenseLinks')))).docs.map((d) => d.data() as ExpenseLinkDoc),
  }), 'payback-inputs');
  // 提醒用实时数据：厨房超时单、待登记收款、旧版遗留的待回收餐牌。
  const kitchenQ = useLiveQuery<{ tokenNumber: number; acceptedAtEffectiveMs: number; fulfillmentStatus: string; kitchenRouting: string }>(
    query(collection(db, storePath('kitchenTickets')), where('fulfillmentStatus', 'in', ['queued', 'preparing'])), 'owner-kitchen',
  );
  const unpaidQ = useLiveQuery<{ id: string; receiptNumber: string; tokenNumber: number; totalSen: number; fulfillmentStatus: string; businessDate: string }>(
    query(collection(db, storePath('orders')), where('paymentState', '==', 'unpaid')), 'owner-unpaid',
  );
  const stock = useStock(today);
  const tokensQ = useLiveQuery<{ number: number; state: string }>(query(collection(db, storePath('tokens')), where('state', '==', 'awaiting_return')), 'owner-tokens');

  if (!config) return null;
  const fixed = finance.data?.fixedCostPolicy ?? DEFAULT_FIXED_COST;
  const loading = cur.loading || !cur.data;
  const summary = cur.data ? summarizePeriod(ledgerEvents(cur.data.docs), range, fixed) : null;
  const lastSummary = before.data ? summarizePeriod(ledgerEvents(before.data.docs), lastWeek, fixed) : null;
  const usage = cur.data ? materialUsage(cur.data.orders as unknown as UsageOrder[]) : null;
  const svc = cur.data ? orderServiceStats(cur.data.orders) : null;
  const split = cur.data ? registeredBreakdown(cur.data.docs.payments.filter((p) => p.businessDate >= range.start && p.businessDate < range.endExclusive)) : null;
  const hasAuto = Boolean(split && (split.autoCount > 0 || split.undoServeCount > 0 || split.notPaidCount > 0));
  const trend = cur.data ? receiptsTrend(cur.data.docs.payments, cur.data.docs.refunds, range, config.timeZone) : [];
  const refundDue = cur.data ? cur.data.orders.filter((o) => o.paymentState === 'refund_due') : [];
  const orderPay = cur.data ? orderPaymentOverview(cur.data.orders) : null;
  const outstanding = unpaidQ.data.filter((o) => o.fulfillmentStatus !== 'cancelled');
  const outstandingSen = outstanding.reduce((s, o) => s + o.totalSen, 0);
  const startup = startupSummary(payInputs.data?.startup ?? []);
  const payback = all.data && payInputs.data ? paybackStatus({
    startupTotalSen: startup.totalSen, receiptsSen: all.data.docs.payments.reduce((s, p) => s + p.amountSen, 0), refundsSen: all.data.docs.refunds.reduce((s, r) => s + r.amountSen, 0),
    expenses: all.data.docs.expenses as PlanExpense[], plan: payInputs.data.plan, startupRentByMonth: startup.rentByMonth, currentMonth: monthOf(today), links: payInputs.data.links,
  }) : null;
  const openReviews = reviews.data ?? [];
  const reviewAmount = openReviews.reduce((s, r) => s + (r.amountSen ?? 0), 0);
  const overdue = kitchenQ.data.filter((t) => t.kitchenRouting === 'digital' && now - t.acceptedAtEffectiveMs >= OVERDUE_MS);
  const inKitchen = kitchenQ.data.filter((t) => t.kitchenRouting === 'digital').length;
  const hour = wallClock(now, config.timeZone).hh;
  const greeting = hour < 11 ? '早上好' : hour < 17 ? '下午好' : '晚上好';
  const [y, m] = date ? date.split('-').map(Number) : [2000, 1];
  const monthlyFixed = monthlyFixedSen(fixed, y, m);
  const pending = (bom.data?.pendingCalibration ?? []).map((k) => CALIBRATION_ZH[k] ?? k);
  const ballsTarget = target.data ?? 50;
  const delta = summary && lastSummary && lastSummary.netReceiptsSen > 0 ? summary.netReceiptsSen - lastSummary.netReceiptsSen : null;
  const closed = day.data?.state === 'closed';
  const stockShown = isToday ? stock.estimates.filter((e) => e.status !== null) : [];
  const short = stockShown.filter((e) => e.status === 'short');
  const dateLabel = date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日 ${weekdayOf(date)}` : '';
  const servedTimes = cur.data ? cur.data.orders.filter((o) => o.fulfillmentStatus !== 'cancelled').map((o) => o.acceptedAtEffectiveMs).sort((a, b) => a - b) : [];
  const hhmm = (ms: number) => { const w = wallClock(ms, config.timeZone); return `${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}`; };

  const exportCsv = () => {
    if (!cur.data || !summary) return;
    download(`汇总_${date}.csv`, csvSummary(summary));
    download(`订单_${date}.csv`, csvOrders(cur.data.orders, config.timeZone));
    download(`收款退款_${date}.csv`, csvPayments(cur.data.docs.payments, cur.data.docs.refunds, config.timeZone));
    download(`支出_${date}.csv`, csvExpenses(cur.data.docs.expenses, config.timeZone));
    download(`损耗_${date}.csv`, csvWastage(cur.data.docs.wastage, config.timeZone));
  };

  // 同牌加单时一张餐牌可有多单：餐牌号去重后再列出。
  const attention: { icon: IconName; tone: 'warn' | 'bad' | 'plain'; title: string; sub: string; action?: { label: string; go: () => void; primary?: boolean } }[] = [];
  if (overdue.length) attention.push({ icon: 'clock', tone: 'bad', title: `有 ${overdue.length} 单等候超过 12 分钟`, sub: `餐牌 ${[...new Set(overdue.map((t) => t.tokenNumber))].join('、')} · 后厨可优先处理`, action: { label: '去后厨', go: () => navigate('/kitchen') } });
  if (outstanding.length) attention.push({ icon: 'wallet', tone: 'warn', title: `待登记收款 ${outstanding.length} 单 · ${formatRM(outstandingSen)}`, sub: `票号 ${outstanding.slice(0, 6).map((o) => o.receiptNumber).join('、')}${outstanding.length > 6 ? ' 等' : ''} · 收到钱后在主点单平板确认`, action: { label: '去订单', go: () => navigate('/orders') } });
  if (refundDue.length) attention.push({ icon: 'receipt', tone: 'warn', title: `${refundDue.length} 单应退款待登记`, sub: `餐牌 ${[...new Set(refundDue.map((o) => o.tokenNumber))].join('、')} · 实际退款后到订单页登记`, action: { label: '去订单', go: () => navigate('/orders') } });
  if (openReviews.length) attention.push({ icon: 'shield', tone: 'warn', title: `离线记录待核对 ${openReviews.length} 条`, sub: reviewAmount ? `已收 ${formatRM(reviewAmount)} 尚未入云端账，上面的数字不含这些金额` : '逐条补入账或不入账', action: { label: '去核对', go: () => navigate('/owner/review') } });
  if (tokensQ.data.length) attention.push({ icon: 'list', tone: 'plain', title: `旧版遗留 ${tokensQ.data.length} 张餐牌待回收`, sub: `餐牌 ${tokensQ.data.map((t) => t.number).sort((a, b) => a - b).join('、')} · 改版前的记录；新流程出餐即自动释放`, action: { label: '查看', go: () => navigate('/pos') } });
  if (short.length) attention.push({ icon: 'box', tone: 'bad', title: `${short.map((e) => e.name).join('、')}明天不够`, sub: '收档后记得订 / 买；进货后拍进货单就会更新', action: { label: '看用料', go: () => navigate('/owner/materials') } });
  if (pending.length) attention.push({ icon: 'edit', tone: 'warn', title: `${pending.length} 项成本还没核实`, sub: `${pending.join('、')} · 核实后「赚了多少」更准`, action: { label: '看成本', go: () => navigate('/owner/costs') } });
  // 2026-11-14 起每天凌晨系统自动关账，不再提醒老板日结。

  return (
    <div className="mx-auto max-w-[1440px] p-4 pb-8 lg:p-8">
      <OwnerTabs current="/owner" badge={{ '/owner/finance': openReviews.length }} />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold lg:text-[28px]">{isToday ? `${greeting}，今天也辛苦了。` : `${dateLabel}的生意`}</h2>
          <p className="text-sm text-ink-2">
            {dateLabel}{servedTimes.length ? ` · ${hhmm(servedTimes[0])} 第一单 · ${hhmm(servedTimes[servedTimes.length - 1])} 最后一单` : ''} · 更新于 {cur.loadedAt ? new Date(cur.loadedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-2xl bg-subtle p-1" role="group" aria-label="营业日">
            <button type="button" onClick={() => setPicked(addDays(date, -1))} className="h-12 rounded-xl px-4 font-semibold text-ink-2">前一天</button>
            <button type="button" onClick={() => setPicked(null)} aria-pressed={isToday} className={`h-12 rounded-xl px-4 font-semibold ${isToday ? 'bg-card shadow' : 'text-ink-2'}`}>今天</button>
            <label className="flex h-12 items-center px-2 text-ink-2"><span className="sr-only">选日期</span><Icon name="calendar" size={18} />
              <input type="date" value={date} max={today} onChange={(e) => setPicked(e.target.value || null)} className="ml-1 w-[8.5rem] bg-transparent text-sm" />
            </label>
          </div>
          <button type="button" onClick={() => { cur.refresh(); before.refresh(); all.refresh(); reviews.refresh(); day.refresh(); }} aria-label="刷新" className="flex h-14 w-14 items-center justify-center rounded-xl border border-line bg-card"><Icon name="refresh" size={20} /></button>
          <span className={`flex h-14 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold ${closed ? 'bg-ok-bg text-ok' : 'bg-subtle text-ink-2'}`} title="每天凌晨 5 点系统自动关前一天的账">
            <Icon name="check" size={18} />{closed ? '已关账' : isToday ? '凌晨自动关账' : '等自动关账'}
          </span>
        </div>
      </div>

      {cur.error && <p role="alert" className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取失败：{cur.error}</p>}

      {/* 三个答案 */}
      <div className="mb-5 grid gap-4 md:grid-cols-3">
        <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-ink-2"><Icon name="wallet" size={20} />卖了多少</div>
          <Big prefix="RM" value={summary ? formatRM(summary.netReceiptsSen).replace('RM', '') : '…'} />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
            <span><b className="tabular-nums">{usage?.orders ?? '…'}</b> 单</span><span><b className="tabular-nums">{usage?.bowls ?? '…'}</b> 碗</span><span><b className="tabular-nums">{usage ? ballsText(usage.noodleHalf) : '…'}</b> 粒面</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[13px] text-ink-2">
            {delta !== null && lastSummary ? (
              <><span className={`whitespace-nowrap rounded-md px-1.5 py-0.5 font-bold ${delta >= 0 ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>{delta >= 0 ? '↑' : '↓'} {formatRM(Math.abs(delta))}</span>
                <span>比上{weekdayOf(date)}（{formatRM(lastSummary.netReceiptsSen)}）{delta >= 0 ? '多' : '少'}{usage && usage.orders ? ` · 平均每单 ${formatRM(Math.round((summary?.netReceiptsSen ?? 0) / usage.orders))}` : ''}</span></>
            ) : <span>已登记收款 · 退款已扣除{hasAuto ? ' · 含出餐自动记' : ''}</span>}
          </div>
        </section>

        <section className="min-w-0 rounded-2xl bg-ok p-5 text-white shadow-card lg:p-6">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-white/85"><Icon name="chart" size={20} />赚了多少<span className="ml-auto rounded-full bg-white/15 px-2 py-0.5 text-[12px] font-bold">估算</span></div>
          <Big prefix={summary && summary.estimatedProfitSen < 0 ? '亏 RM' : '约 RM'} value={summary ? formatRM(Math.abs(summary.estimatedProfitSen)).replace('RM', '') : '…'} light />
          {summary && (
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[14px] tabular-nums text-white/90">
              <dt>收入</dt><dd className="text-right">{formatRM(summary.netReceiptsSen)}</dd>
              <dt className="flex flex-wrap items-center gap-1.5">− 材料成本{pending.length > 0 && <span className="rounded-full bg-warn-bg px-1.5 text-[11px] font-bold text-warn">含 {pending.length} 项未核实</span>}</dt>
              <dd className="text-right">{formatRM(costUnitsToSen(summary.allocatedCostUnits + summary.wastageCostUnits))}</dd>
              <dt>− 租金电费 <span className="text-white/65">（每月 {formatRM(monthlyFixed)} ÷ {daysInMonth(y, m)} 天）</span></dt><dd className="text-right">{formatRM(summary.fixedCostSen)}</dd>
              {summary.otherOpexSen > 0 && <><dt>− 煤气、杂费等</dt><dd className="text-right">{formatRM(summary.otherOpexSen)}</dd></>}
            </dl>
          )}
          <div className="mt-3 border-t border-white/20 pt-3 text-[13px] text-white/80">{summary && summary.otherOpexSen === 0 ? '煤气、杂费这天没有记 · ' : ''}不含工资和税 · 按已登记收款算</div>
        </section>

        {stockShown.length > 0 ? (
          <section className={`relative min-w-0 overflow-hidden rounded-2xl border bg-card p-5 shadow-card lg:p-6 ${short.length ? 'border-[#ecd9a8]' : 'border-line'}`}>
            {short.length > 0 && <span className="absolute inset-y-0 left-0 w-1.5 bg-warn" />}
            <div className="flex items-center gap-2 text-[15px] font-semibold text-ink-2"><Icon name="box" size={20} />材料够不够</div>
            <div className={`mt-3 text-[28px] font-black leading-tight ${short.length ? 'text-warn' : 'text-ok'}`}>{short.length ? `${short.length} 样明天不够` : '明天够用'}</div>
            <ul className="mt-3 space-y-2 text-[15px]">
              {[...stockShown].sort((a, b) => (a.status === b.status ? 0 : a.status === 'short' ? -1 : b.status === 'short' ? 1 : a.status === 'low' ? -1 : 1)).slice(0, 3).map((e) => (
                <li key={e.ingredientId} className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${e.status === 'short' ? 'bg-danger' : e.status === 'low' ? 'bg-warn' : 'bg-ok'}`} /><b className="truncate">{e.name}</b>
                  <span className="ml-auto whitespace-nowrap text-right tabular-nums">剩约 {e.remaining < 0 ? 0 : Number.isInteger(e.remaining) ? e.remaining : e.remaining.toFixed(1)} {e.unit}{e.tomorrowNeed !== null && <span className="text-ink-2"> · 明天要 ~{e.tomorrowNeed}</span>}</span>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => navigate('/owner/materials')} className="mt-4 flex w-full items-center gap-1 border-t border-line pt-3 text-[14px] font-bold">看用料和剩余 <Icon name="arrow" size={16} /></button>
          </section>
        ) : (
        <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-ink-2"><Icon name="box" size={20} />用了多少料</div>
          {usage && usage.bowls > 0 ? (
            <ul className="mt-3 space-y-2.5 text-[15px]">
              <UseRow icon={<Photo id="noodle.thin_egg" size={28} rounded={8} />} label="面团" value={ballsText(usage.noodleHalf)} unit="粒"
                sub={`目标 ${ballsTarget} 粒 · ${usage.noodleHalf >= ballsTarget * 2 ? `已达标${usage.noodleHalf > ballsTarget * 2 ? `，多 ${ballsText(usage.noodleHalf - ballsTarget * 2)}` : ''}` : `还差 ${ballsText(ballsTarget * 2 - usage.noodleHalf)}`}`} good={usage.noodleHalf >= ballsTarget * 2} />
              <UseRow icon={<Icon name="wanton" size={24} className="text-[#9a7a3c]" />} label="云吞" value={String(usage.wanton.total)} unit="粒" />
              <UseRow icon={<Photo id="ingredient.char_siew" size={28} rounded={8} />} label="叉烧" value={String(usage.charSiew.total)} unit="份" />
            </ul>
          ) : <p className="mt-6 text-ink-2">{loading ? '正在载入…' : '这天还没有订单'}</p>}
          <button type="button" onClick={() => navigate('/owner/materials')} className="mt-4 flex w-full items-center gap-1 border-t border-line pt-3 text-[14px] font-bold">每样怎么算出来的 <Icon name="arrow" size={16} /></button>
        </section>
        )}
      </div>

      {/* 面量 + 卖得最好 */}
      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
          <div className="mb-4 flex flex-wrap items-baseline gap-2"><h3 className="text-lg font-bold">卖了多少面</h3><span className="text-sm text-ink-2">按订单自动算 · 小 1 粒、中 1½ 粒、大 2 粒 · 不含取消的单</span></div>
          {!usage || usage.noodleBowls === 0 ? <Empty text={loading ? '正在载入…' : '这天还没有卖面'} /> : (
            <>
              <div className="flex flex-wrap items-center gap-5">
                <div>
                  <div className="text-[40px] font-black leading-none tabular-nums">{ballsText(usage.noodleHalf)} <span className="text-base font-bold">粒面</span></div>
                  <div className="mt-1 text-[13px] text-ink-2">每日目标 {ballsTarget} 粒 · {usage.noodleHalf >= ballsTarget * 2 ? <b className="text-ok">已达标</b> : `还差 ${ballsText(ballsTarget * 2 - usage.noodleHalf)} 粒`}</div>
                </div>
                <div className="min-w-[200px] flex-1">
                  <div className="relative h-3 rounded-full bg-subtle">
                    <div className="h-3 rounded-full bg-ok" style={{ width: `${Math.min(100, (usage.noodleHalf / Math.max(usage.noodleHalf, ballsTarget * 2)) * 100)}%` }} />
                    <span className="absolute -top-1 h-5 w-0.5 bg-ink" style={{ left: `${(ballsTarget * 2 / Math.max(usage.noodleHalf, ballsTarget * 2)) * 100}%` }} title={`目标 ${ballsTarget}`} />
                  </div>
                </div>
              </div>
              <table className="mt-5 w-full text-[15px] tabular-nums">
                <thead><tr className="text-left text-[13px] text-ink-2"><th className="py-2 font-semibold">面种</th>{SIZE_COLS.map(([k, l, n]) => <th key={k} className="py-2 text-right font-semibold">{l} <span className="font-normal">({n})</span></th>)}<th className="py-2 text-right font-semibold">合计</th></tr></thead>
                <tbody>
                  {NOODLE_ROWS.map(([t, label]) => {
                    const row = usage.noodle[t];
                    const bowls = row.small.bowls + row.medium.bowls + row.large.bowls;
                    return (
                      <tr key={t} className="border-t border-line">
                        <td className="py-2.5 font-semibold">{label}</td>
                        {SIZE_COLS.map(([k]) => <td key={k} className="text-right"><Cell half={row[k].half} bowls={row[k].bowls} /></td>)}
                        <td className="text-right"><Cell half={usage.noodleHalfByType[t]} bowls={bowls} strong /></td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-ink/80 bg-subtle/60">
                    <td className="py-2.5 pl-2 font-bold">合计</td>
                    {SIZE_COLS.map(([k]) => <td key={k} className="text-right"><Cell half={usage.noodle.thin_egg[k].half + usage.noodle.mee_poh[k].half} bowls={usage.noodle.thin_egg[k].bowls + usage.noodle.mee_poh[k].bowls} /></td>)}
                    <td className="pr-2 text-right"><Cell half={usage.noodleHalf} bowls={usage.noodleBowls} strong /></td>
                  </tr>
                </tbody>
              </table>
              <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                <Chip icon={<Icon name="wanton" size={16} />} label="云吞" value={usage.wanton.total} unit="粒" />
                <Chip icon={<Photo id="ingredient.char_siew" size={16} rounded={8} />} label="叉烧" value={usage.charSiew.total} unit="份" />
                <Chip icon={<Icon name="soup" size={16} />} label="汤" value={usage.byKind.soup_noodle + usage.byKind.wanton_soup} unit="碗" />
                <Chip icon={<Icon name="bag" size={16} />} label="打包" value={usage.takeawayBowls} unit="份" />
                <Chip icon={<Icon name="plain" size={16} />} label="净面" value={usage.kosongBowls} unit="碗" />
              </div>
            </>
          )}
        </section>

        <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
          <div className="mb-4 flex items-baseline gap-2"><h3 className="text-lg font-bold">卖得最好</h3><span className="text-sm text-ink-2">碗数 · 金额（按订单）</span></div>
          {!usage || usage.byDish.length === 0 ? <Empty text={loading ? '正在载入…' : '这天还没有订单'} /> : (
            <>
              <ol className="space-y-3.5">
                {usage.byDish.map((d) => (
                  <li key={d.key} className="flex items-center gap-3">
                    <Photo id={d.photoId} size={44} rounded={22} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline"><b>{d.label}</b><span className="ml-auto font-bold tabular-nums">{d.bowls} 碗</span></div>
                      <div className="mt-1 flex items-center gap-2"><div className="h-1.5 flex-1 rounded bg-subtle"><div className="h-1.5 rounded bg-ok/70" style={{ width: `${(d.bowls / usage.byDish[0].bowls) * 100}%` }} /></div><span className="w-[76px] text-right text-[13px] text-ink-2 tabular-nums">{formatRM(d.sen)}</span></div>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-4 border-t border-line pt-3 text-[13px] text-ink-2">酱料：黑酱 {usage.bySauce.black} · 红酱 {usage.bySauce.red} · 白酱 {usage.bySauce.white}（含干捞云吞）</p>
            </>
          )}
        </section>
      </div>

      {/* 几点最忙 + 提醒 */}
      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Section title="几点最忙" hint="每小时收款 · 按登记时间">
          <TrendChart buckets={trend} loading={loading} />
        </Section>
        <Section title="要你看一下" hint={attention.length ? `${attention.length} 件` : undefined}>
          {attention.length === 0 ? (
            <p className="flex items-center gap-2 rounded-xl bg-ok-bg px-4 py-3 text-sm"><Icon name="check" size={18} className="text-ok" />{closed ? '这天已关账，没有要处理的事。' : '没有超时单、待登记收款、待核对记录或应退款。'}</p>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((a) => (
                <li key={a.title} className="flex items-center gap-3 py-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${a.tone === 'bad' ? 'bg-danger-bg text-danger' : a.tone === 'warn' ? 'bg-warn-bg text-warn' : 'bg-subtle text-ink'}`}><Icon name={a.icon} size={20} /></span>
                  <div className="min-w-0 flex-1"><b>{a.title}</b><p className="text-[13px] text-ink-2">{a.sub}</p></div>
                  {a.action && <button type="button" onClick={a.action.go} className={`h-12 shrink-0 rounded-xl px-4 font-bold ${a.action.primary ? 'bg-ink text-white' : 'border border-line'}`}>{a.action.label}</button>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {date && <SummaryCard date={date} isToday={isToday} />}

      {!loading && summary && svc && orderPay && (
        <details className="group mt-5 rounded-2xl border border-line bg-card p-5 shadow-card">
          <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2 font-bold"><Icon name="chevron-right" size={18} className="transition-transform group-open:rotate-90" />细账：收款明细、出餐速度、回本进度、导出</summary>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Section title="收款明细" hint="订单金额按订单营业日；收款按登记日">
              <div className="grid grid-cols-2 gap-3">
                <PayFig label="有效订单金额" value={formatRM(orderPay.validSen)} sub={`${orderPay.validCount} 单${orderPay.cancelledCount ? ` · 另取消 ${orderPay.cancelledCount} 单` : ''}`} />
                <PayFig label="已登记收款" value={formatRM(summary.receipts.totalSen)}
                  sub={hasAuto && split ? `前台确认 ${formatRM(split.manualSen)} · 出餐自动记 ${formatRM(split.autoSen)}${split.notPaidCount ? ` · 没付就走 −${formatRM(split.notPaidSen)}` : ''}` : summary.receipts.correctionsSen ? `含误登记更正 ${formatRM(summary.receipts.correctionsSen)}` : '含跨日补登记'} />
                <PayFig label="未登记（这天的订单）" value={formatRM(orderPay.unpaidSen)} sub={`${orderPay.unpaidCount} 单 · 不算已收`} tone={orderPay.unpaidCount ? 'bad' : undefined} />
                <PayFig label="已登记退款" value={formatRM(summary.refunds.totalSen)} />
              </div>
              {summary.hasLegacyChannels && (
                <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-2">旧版记录（改版前按渠道登记）：现金收款 {formatRM(summary.receipts.cashSen)} · QR 收款 {formatRM(summary.receipts.qrSen)}；已包含在上面的已登记收款内。</p>
              )}
              <p className="mt-3 text-xs text-ink-2">收款数字为员工人工登记{hasAuto ? '或出餐自动记，请和钱箱现金加 QR 到账对一下' : '，未与钱包或银行自动核对'}。</p>
            </Section>
            <Section title="出餐速度" hint={`样本 ${svc.count} 单${inKitchen ? ` · 厨房还有 ${inKitchen} 单` : ''}`}>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[['8 分钟内', svc.onTimeRate === null ? '—' : pct(svc.onTimeRate)], ['平均', minutes(svc.avgMs)], ['最慢', minutes(svc.maxMs)]].map(([l, v]) => (
                  <div key={l} className="rounded-lg bg-subtle p-2"><div className="text-xs text-ink-2">{l}</div><b className="tabular-nums">{v}</b></div>
                ))}
              </div>
              <div className="mt-3">
                <BarList format={(v) => `${v} 单`} rows={[
                  { label: '极速 <4分', value: svc.distribution.lightning }, { label: '正常 4–8分', value: svc.distribution.normal },
                  { label: '偏慢 8–12分', value: svc.distribution.slow }, { label: '超时 ≥12分', value: svc.distribution.overdue },
                ]} />
              </div>
            </Section>
            <Section title="回本进度（参考）" hint="收回开档总投入" actions={<button type="button" onClick={() => navigate('/owner/finance/goals')} className="h-10 rounded-lg border border-line px-3 text-sm">经营目标</button>}>
              {!payback ? <p className="text-ink-2">正在载入…</p> : payback.state === 'pending' ? <p className="text-ink-2">待核算：{payback.pendingReasons.join('；')}。</p> : (
                <>
                  <div className="h-3 rounded bg-subtle"><div className="h-3 rounded bg-ok" style={{ width: `${payback.barRatio * 100}%` }} /></div>
                  <p className="mt-2 text-sm tabular-nums">已收回 <b className={payback.recoveredSen < 0 ? 'text-danger' : ''}>{formatRM(payback.recoveredSen)}</b> · 开档总投入 {formatRM(payback.targetSen)} · 进度 <b>{pct(payback.ratio)}</b> · 还差 {formatRM(payback.remainingSen)}</p>
                </>
              )}
            </Section>
            <Section title="导出" hint="给会计或自己存档">
              <button type="button" onClick={exportCsv} className="flex h-14 items-center gap-1.5 rounded-xl border border-line bg-card px-4 font-semibold"><Icon name="download" size={18} />导出这天的 CSV</button>
              <p className="mt-2 text-xs text-ink-2">汇总、订单、收款退款、支出、损耗五个文件。更长的区间请到账目页。</p>
            </Section>
          </div>
        </details>
      )}
    </div>
  );
}

function Big({ prefix, value, light }: { prefix: string; value: string; light?: boolean }) {
  return (
    <div className="mt-3 flex items-baseline gap-1.5 tabular-nums">
      <span className={`text-lg font-bold ${light ? 'text-white/85' : ''}`}>{prefix}</span>
      <span className="text-[40px] font-black leading-none tracking-tight lg:text-[44px]">{value}</span>
    </div>
  );
}

function UseRow({ icon, label, value, unit, sub, good }: { icon: ReactNode; label: string; value: string; unit: string; sub?: string; good?: boolean }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1"><b>{label}</b>{sub && <p className={`text-[12px] ${good ? 'text-ok' : 'text-ink-2'}`}>{sub}</p>}</div>
      <span className="text-xl font-black tabular-nums">{value} <span className="text-[13px] font-semibold">{unit}</span></span>
    </li>
  );
}

function Cell({ half, bowls, strong }: { half: number; bowls: number; strong?: boolean }) {
  return <><b className={strong ? 'text-[17px]' : ''}>{ballsText(half)}</b> 粒<span className="block text-[12px] text-ink-2">{bowls} 碗</span></>;
}

function Chip({ icon, label, value, unit }: { icon: ReactNode; label: string; value: number; unit: string }) {
  return (
    <div className="rounded-xl bg-subtle px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[13px] text-ink-2">{icon}{label}</div>
      <div className="mt-0.5 text-xl font-black tabular-nums">{value} <span className="text-[13px] font-semibold">{unit}</span></div>
    </div>
  );
}

function PayFig({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="rounded-xl bg-subtle p-3">
      <div className="text-xs text-ink-2">{label}</div>
      <div className={`mt-1 text-xl font-black tabular-nums ${tone === 'bad' ? 'text-danger' : ''}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-2">{text}</p>;
}

/** 柱状走势：最高时段用深绿，其余浅绿；数值写在最高柱上方，不依赖颜色读数。 */
function TrendChart({ buckets, loading }: { buckets: { key: string; label: string; netSen: number }[]; loading: boolean }) {
  if (!buckets.length || buckets.every((b) => b.netSen === 0)) return <Empty text={loading ? '正在载入…' : '这天还没有登记收款'} />;
  const max = Math.max(...buckets.map((b) => b.netSen), 1);
  const peak = buckets.reduce((m, b) => (b.netSen > m.netSen ? b : m), buckets[0]);
  const total = buckets.reduce((s, b) => s + b.netSen, 0);
  return (
    <figure>
      <div className="flex h-44 items-end gap-1.5 border-b border-line sm:gap-2" role="img" aria-label={`最高 ${peak.label} ${formatRM(peak.netSen)}`}>
        {buckets.map((b) => (
          <div key={b.key} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${b.label} ${formatRM(b.netSen)}`}>
            {b === peak && <span className="mb-1 text-xs font-bold whitespace-nowrap">{formatRM(b.netSen)}</span>}
            <div className={`w-full max-w-[56px] rounded-t-md ${b === peak ? 'bg-ok' : 'bg-[#d2dac4]'}`} style={{ height: `${Math.max(1, (Math.max(0, b.netSen) / max) * 85)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 sm:gap-2">
        {buckets.map((b) => <span key={b.key} className={`min-w-0 flex-1 text-center text-[11px] ${b === peak ? 'font-bold text-ok' : 'text-ink-2'}`}>{b.label.slice(0, 2)}点</span>)}
      </div>
      {total > 0 && <figcaption className="mt-3 text-[13px] text-ink-2">{peak.label.slice(0, 2)} 点那一小时最旺（{formatRM(peak.netSen)}，占这天 {Math.round((peak.netSen / total) * 100)}%）。</figcaption>}
    </figure>
  );
}
