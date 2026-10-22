/**
 * 老板概览（02 §7、01 §9）：先回答「今天经营如何」。
 * 估算经营利润为管理估算，未含工资/税费；现金流单独展示；回本进度按估算利润，允许负值。
 */
import { useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { BOM_V1 } from '../../domain/bom';
import { addDays, businessDateOf, DateRange, lastNDays, previousRange } from '../../domain/businessDay';
import { DEFAULT_FIXED_COST, FixedCostPolicy, paybackProgress, ratioOrNull, summarizePeriod } from '../../domain/finance';
import { csvExpenses, csvOrders, csvPayments, csvSummary, csvWastage, ledgerEvents, orderServiceStats, productMix } from '../../domain/ledger';
import { costUnitsToSen, formatRM } from '../../domain/money';
import { db, storePath } from '../../data/firebase/client';
import { useNow } from '../../data/firebase/live';
import { useSession } from '../../app/session';
import { download, loadLedger, loadOpenReviews, useLoad } from './data';
import { BarList, Kpi, minutes, OwnerTabs, pct, Section } from './ui';

type Period = 'today' | 'd7' | 'd30';
const PERIOD_ZH: Record<Period, string> = { today: '今日', d7: '近7天', d30: '近30天' };

export function OverviewPage() {
  const { config } = useSession();
  const now = useNow(60_000);
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const [period, setPeriod] = useState<Period>('today');
  const range: DateRange = lastNDays(today || '2000-01-01', period === 'today' ? 1 : period === 'd7' ? 7 : 30);
  const prev = previousRange(range);
  const key = `${today}-${range.start}-${range.endExclusive}`;
  // 门店配置载入前营业日为空：先不查询。
  const cur = useLoad(() => (today ? loadLedger(range) : Promise.resolve(null)), `cur-${key}`);
  const before = useLoad(() => (today ? loadLedger(prev) : Promise.resolve(null)), `prev-${key}`);
  const all = useLoad(() => (today ? loadLedger(null) : Promise.resolve(null)), `all-${today}`);
  const reviews = useLoad(loadOpenReviews, 'reviews');
  const finance = useLoad(async () => (await getDoc(doc(db, storePath('config/finance')))).data() as { initialCapitalSen: number; openingProfitSen: number; fixedCostPolicy: FixedCostPolicy } | undefined, 'finance');

  if (!config) return null;
  const fixed = finance.data?.fixedCostPolicy ?? DEFAULT_FIXED_COST;
  const loading = cur.loading || !cur.data;
  const summary = cur.data ? summarizePeriod(ledgerEvents(cur.data.docs), range, fixed) : null;
  const prevSummary = before.data ? summarizePeriod(ledgerEvents(before.data.docs), prev, fixed) : null;
  const svc = cur.data ? orderServiceStats(cur.data.orders) : null;
  const mix = cur.data ? productMix(cur.data.orders) : null;
  // 回本：所有日期的估算利润累计（从第一笔账到今天）+ 老板确认的期初余额。
  const allDates = all.data ? [...all.data.docs.payments, ...all.data.docs.expenses, ...all.data.docs.costEvents].map((d) => d.businessDate).sort() : [];
  const allRange: DateRange | null = allDates.length ? { start: allDates[0], endExclusive: addDays(today, 1) } : null;
  const cumulative = all.data && allRange ? summarizePeriod(ledgerEvents(all.data.docs), allRange, fixed).estimatedProfitSen : 0;
  const payback = paybackProgress({ initialCapitalSen: finance.data?.initialCapitalSen ?? 0, openingBalanceSen: finance.data?.openingProfitSen ?? 0, cumulativeProfitSen: cumulative });
  const openReviews = reviews.data ?? [];
  const reviewAmount = openReviews.reduce((s, r) => s + (r.amountSen ?? 0), 0);
  const delta = summary && prevSummary ? ratioOrNull(summary.netReceiptsSen - prevSummary.netReceiptsSen, prevSummary.netReceiptsSen) : null;

  const exportCsv = () => {
    if (!cur.data || !summary) return;
    const tag = `${range.start}_${addDays(range.endExclusive, -1)}`;
    download(`汇总_${tag}.csv`, csvSummary(summary));
    download(`订单_${tag}.csv`, csvOrders(cur.data.orders, config.timeZone));
    download(`收款退款_${tag}.csv`, csvPayments(cur.data.docs.payments, cur.data.docs.refunds, config.timeZone));
    download(`支出_${tag}.csv`, csvExpenses(cur.data.docs.expenses, config.timeZone));
    download(`损耗_${tag}.csv`, csvWastage(cur.data.docs.wastage, config.timeZone));
  };

  return (
    <div className="mx-auto max-w-[1440px] p-4 pb-24 md:pb-6">
      <OwnerTabs current="/owner" badge={{ '/owner/review': openReviews.length }} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">经营概览</h1>
        <div className="flex rounded-lg bg-subtle p-1" role="group" aria-label="统计区间">
          {(Object.keys(PERIOD_ZH) as Period[]).map((p) => (
            <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}
              className={`h-10 rounded-md px-3 font-semibold ${period === p ? 'bg-card shadow' : 'text-ink-2'}`}>{PERIOD_ZH[p]}</button>
          ))}
        </div>
        <span className="text-sm text-ink-2">
          {range.start}{period !== 'today' ? ` 至 ${addDays(range.endExclusive, -1)}` : ''} · 更新于 {cur.loadedAt ? new Date(cur.loadedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => { cur.refresh(); before.refresh(); all.refresh(); reviews.refresh(); }} className="h-10 rounded-lg border border-control px-3 font-semibold">刷新</button>
          <button type="button" disabled={!summary} onClick={exportCsv} className="h-10 rounded-lg border border-control px-3 font-semibold disabled:opacity-40">导出 CSV</button>
        </div>
      </div>

      {openReviews.length > 0 && (
        <div role="alert" className="mb-4 rounded-xl border-2 border-warn bg-warn-bg px-4 py-3 text-warn">
          <b>离线记录待核对 {openReviews.length} 条{reviewAmount ? ` · 已收 ${formatRM(reviewAmount)} 尚未入云端账` : ''}</b>，下面的数字不包含这些金额。
        </div>
      )}
      {cur.error && <p role="alert" className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取失败：{cur.error}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="净收款（已确认收款 − 退款）" value={summary ? formatRM(summary.netReceiptsSen) : '…'} sub={delta === null ? '对比上一区间：—' : `对比上一区间 ${delta >= 0 ? '+' : ''}${pct(delta)}`} />
        <Kpi label="估算经营利润" value={summary ? formatRM(summary.estimatedProfitSen) : '…'} tone={summary && summary.estimatedProfitSen < 0 ? 'bad' : 'normal'}
          sub="管理估算：未含工资、税费；面薄与汤底成本待实店校准" />
        <Kpi label="已出餐份数" value={mix ? String(mix.portionsServed) : '…'} />
        <Kpi label="8 分钟内达标率" value={svc ? pct(svc.onTimeRate) : '…'} sub={svc ? `样本 ${svc.count} 单${svc.excluded ? `（另有 ${svc.excluded} 单离线时间未核对，不计入）` : ''}` : undefined} />
      </div>

      {!loading && summary && svc && mix && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="收款构成" hint="现金与 QR 分开；QR 不进钱箱">
            <BarList format={formatRM} rows={[
              { label: '现金收款', value: summary.receipts.cashSen }, { label: 'QR 收款', value: summary.receipts.qrSen },
              { label: '现金退款', value: -summary.refunds.cashSen }, { label: 'QR 退款', value: -summary.refunds.qrSen },
            ]} />
            <p className="mt-2 text-sm text-ink-2">
              现金占比 {pct(ratioOrNull(summary.receipts.cashSen, summary.receipts.totalSen))} · QR 占比 {pct(ratioOrNull(summary.receipts.qrSen, summary.receipts.totalSen))}
            </p>
          </Section>
          <Section title="出餐效率" hint={`样本 ${svc.count} 单`}>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[['平均', svc.avgMs], ['中位数', svc.medianMs], ['P90', svc.p90Ms], ['最快', svc.minMs], ['最慢', svc.maxMs], ['打包平均', svc.takeaway.avgMs]].map(([l, v]) => (
                <div key={l as string} className="rounded-lg bg-subtle p-2"><div className="text-xs text-ink-2">{l}</div><b className="tabular-nums">{minutes(v as number | null)}</b></div>
              ))}
            </div>
            <div className="mt-3">
              <BarList format={(v) => `${v} 单`} rows={[
                { label: '极速 <4分', value: svc.distribution.lightning }, { label: '正常 4–8分', value: svc.distribution.normal },
                { label: '偏慢 8–12分', value: svc.distribution.slow }, { label: '超时 ≥12分', value: svc.distribution.overdue },
              ]} />
            </div>
          </Section>
          <Section title="畅销品" hint="只算实际已出餐的份数">
            <BarList format={(v) => `${v} 份`} rows={mix.byProduct.map((r) => ({ label: r.label, value: r.portions }))} />
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div><div className="mb-1 text-sm font-semibold text-ink-2">酱料</div><BarList format={(v) => `${v}`} rows={mix.bySauce.map((r) => ({ label: r.label, value: r.portions }))} /></div>
              <div><div className="mb-1 text-sm font-semibold text-ink-2">面种</div><BarList format={(v) => `${v}`} rows={mix.byNoodle.map((r) => ({ label: r.label, value: r.portions }))} /></div>
            </div>
          </Section>
          <Section title="经营估算 vs 现金" hint="两本账分开，进货不与理论成本重复扣">
            <table className="w-full text-sm">
              <tbody>
                {[
                  ['净收款', summary.netReceiptsSen], ['已分配理论食材与包装成本', -costUnitsToSen(summary.allocatedCostUnits)],
                  ['未重复计算的损耗', -costUnitsToSen(summary.wastageCostUnits)], ['固定费用摊销（按日历日）', -summary.fixedCostSen],
                  ['其他营业费用', -summary.otherOpexSen], ['= 估算经营利润', summary.estimatedProfitSen],
                ].map(([l, v]) => <tr key={l as string} className="border-b border-line"><td className="py-1">{l}</td><td className="text-right tabular-nums">{formatRM(v as number)}</td></tr>)}
                <tr><td className="pt-3 font-semibold" colSpan={2}>现金视角</td></tr>
                {[
                  ['实际收款 − 实际退款', summary.receipts.totalSen - summary.refunds.totalSen], ['已付进货', -summary.cash.purchasesPaidSen],
                  ['已付营业费用（含房租等付款）', -summary.cash.opexPaidSen], ['= 经营现金净流入', summary.cash.operatingNetInflowSen],
                  ['资本设备付款（另列，不计经营）', -summary.cash.capitalPaidSen],
                ].map(([l, v]) => <tr key={l as string} className="border-b border-line"><td className="py-1">{l}</td><td className="text-right tabular-nums">{formatRM(v as number)}</td></tr>)}
              </tbody>
            </table>
            {summary.wastageAlreadyAllocatedCount > 0 && <p className="mt-2 text-xs text-ink-2">另有 {summary.wastageAlreadyAllocatedCount} 条损耗属于已计入订单成本的食材，只记数量、不重复扣款。</p>}
          </Section>
          <Section title="按估算利润的回本进度" hint="期初余额由老板确认；不是现金回收">
            {payback.applicable ? (
              <>
                <div className="h-4 rounded bg-subtle"><div className="h-4 rounded bg-ok" style={{ width: `${payback.barRatio * 100}%` }} /></div>
                <p className="mt-2 tabular-nums">
                  累计估算经营结果 <b className={payback.cumulativeResultSen < 0 ? 'text-danger' : ''}>{formatRM(payback.cumulativeResultSen)}</b> ·
                  初始投入 {formatRM(finance.data!.initialCapitalSen)} · 进度 <b>{pct(payback.ratio)}</b> · 待收回 {formatRM(payback.remainingSen)}
                </p>
              </>
            ) : <p className="text-ink-2">初始投入为 0，不适用。</p>}
          </Section>
        </div>
      )}
      {loading && <p className="text-ink-2">正在载入…</p>}
      <p className="mt-4 text-xs text-ink-2">BOM 版本 {BOM_V1.version}；固定费用 {formatRM(fixed.monthlySen)}/月按日历日摊销。</p>
    </div>
  );
}
