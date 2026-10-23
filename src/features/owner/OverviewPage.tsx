/**
 * 老板概览（02 §7、01 §9；2026-10-23 新版布局）：先回答「今天经营如何」。
 * 所有数字、走势与排行都来自账本查询和领域函数；无数据时显示空态，不放示例数字。
 * 估算经营利润为管理估算，未含工资/税费；经营现金流与钱箱金额分开展示，不混用。
 */
import { useState } from 'react';
import { collection, doc, getDoc, query, where } from 'firebase/firestore';
import { BOM_V1 } from '../../domain/bom';
import { addDays, businessDateOf, DateRange, lastNDays, previousRange, wallClock } from '../../domain/businessDay';
import { DEFAULT_FIXED_COST, FixedCostPolicy, paybackProgress, ratioOrNull, summarizePeriod } from '../../domain/finance';
import { csvExpenses, csvOrders, csvPayments, csvSummary, csvWastage, dishRanking, ledgerEvents, orderServiceStats, productMix, receiptsTrend } from '../../domain/ledger';
import { costUnitsToSen, formatRM } from '../../domain/money';
import { OVERDUE_MS } from '../../domain/timing';
import { db, storePath } from '../../data/firebase/client';
import { useLiveQuery, useNow } from '../../data/firebase/live';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { Icon, Photo } from '../../ui/visual';
import { download, loadLedger, loadOpenReviews, useLoad } from './data';
import { BarList, minutes, OwnerTabs, pct, Section } from './ui';

type Period = 'today' | 'd7' | 'd30';
const PERIOD_ZH: Record<Period, string> = { today: '今日', d7: '近7天', d30: '近30天' };

export function OverviewPage() {
  const { config } = useSession();
  const now = useNow(60_000);
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const [period, setPeriod] = useState<Period>('today');
  const [detail, setDetail] = useState(false);
  const range: DateRange = lastNDays(today || '2000-01-01', period === 'today' ? 1 : period === 'd7' ? 7 : 30);
  const prev = previousRange(range);
  const key = `${today}-${range.start}-${range.endExclusive}`;
  // 门店配置载入前营业日为空：先不查询。
  const cur = useLoad(() => (today ? loadLedger(range) : Promise.resolve(null)), `cur-${key}`);
  const before = useLoad(() => (today ? loadLedger(prev) : Promise.resolve(null)), `prev-${key}`);
  const all = useLoad(() => (today ? loadLedger(null) : Promise.resolve(null)), `all-${today}`);
  const reviews = useLoad(loadOpenReviews, 'reviews');
  const finance = useLoad(async () => (await getDoc(doc(db, storePath('config/finance')))).data() as { initialCapitalSen: number; openingProfitSen: number; fixedCostPolicy: FixedCostPolicy } | undefined, 'finance');
  // 关注事项用实时数据：厨房超时单、待回收餐牌。
  const kitchenQ = useLiveQuery<{ tokenNumber: number; acceptedAtEffectiveMs: number; fulfillmentStatus: string; kitchenRouting: string }>(
    query(collection(db, storePath('kitchenTickets')), where('fulfillmentStatus', 'in', ['queued', 'preparing'])), 'owner-kitchen',
  );
  const tokensQ = useLiveQuery<{ number: number; state: string }>(query(collection(db, storePath('tokens')), where('state', '==', 'awaiting_return')), 'owner-tokens');

  if (!config) return null;
  const fixed = finance.data?.fixedCostPolicy ?? DEFAULT_FIXED_COST;
  const loading = cur.loading || !cur.data;
  const summary = cur.data ? summarizePeriod(ledgerEvents(cur.data.docs), range, fixed) : null;
  const prevSummary = before.data ? summarizePeriod(ledgerEvents(before.data.docs), prev, fixed) : null;
  const svc = cur.data ? orderServiceStats(cur.data.orders) : null;
  const mix = cur.data ? productMix(cur.data.orders) : null;
  const ranking = cur.data ? dishRanking(cur.data.orders) : [];
  const trend = cur.data ? receiptsTrend(cur.data.docs.payments, cur.data.docs.refunds, range, config.timeZone) : [];
  const refundDue = cur.data ? cur.data.orders.filter((o) => o.paymentState === 'refund_due') : [];
  // 回本：所有日期的估算利润累计（从第一笔账到今天）+ 老板确认的期初余额。
  const allDates = all.data ? [...all.data.docs.payments, ...all.data.docs.expenses, ...all.data.docs.costEvents].map((d) => d.businessDate).sort() : [];
  const allRange: DateRange | null = allDates.length ? { start: allDates[0], endExclusive: addDays(today, 1) } : null;
  const cumulative = all.data && allRange ? summarizePeriod(ledgerEvents(all.data.docs), allRange, fixed).estimatedProfitSen : 0;
  const payback = paybackProgress({ initialCapitalSen: finance.data?.initialCapitalSen ?? 0, openingBalanceSen: finance.data?.openingProfitSen ?? 0, cumulativeProfitSen: cumulative });
  const openReviews = reviews.data ?? [];
  const reviewAmount = openReviews.reduce((s, r) => s + (r.amountSen ?? 0), 0);
  const delta = summary && prevSummary ? ratioOrNull(summary.netReceiptsSen - prevSummary.netReceiptsSen, prevSummary.netReceiptsSen) : null;
  const overdue = kitchenQ.data.filter((t) => t.kitchenRouting === 'digital' && now - t.acceptedAtEffectiveMs >= OVERDUE_MS);
  const inKitchen = kitchenQ.data.filter((t) => t.kitchenRouting === 'digital').length;
  const hour = wallClock(now, config.timeZone).hh;
  const greeting = hour < 11 ? '早上好' : hour < 17 ? '下午好' : '晚上好';
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${range.start}T00:00:00Z`));

  const exportCsv = () => {
    if (!cur.data || !summary) return;
    const tag = `${range.start}_${addDays(range.endExclusive, -1)}`;
    download(`汇总_${tag}.csv`, csvSummary(summary));
    download(`订单_${tag}.csv`, csvOrders(cur.data.orders, config.timeZone));
    download(`收款退款_${tag}.csv`, csvPayments(cur.data.docs.payments, cur.data.docs.refunds, config.timeZone));
    download(`支出_${tag}.csv`, csvExpenses(cur.data.docs.expenses, config.timeZone));
    download(`损耗_${tag}.csv`, csvWastage(cur.data.docs.wastage, config.timeZone));
  };

  const attention: { title: string; sub: string; action?: { label: string; go: () => void } }[] = [];
  if (overdue.length) attention.push({ title: `有 ${overdue.length} 单等候超过 12 分钟`, sub: `餐牌 ${overdue.map((t) => t.tokenNumber).join('、')} · 后厨可优先处理`, action: { label: '去后厨', go: () => navigate('/kitchen') } });
  if (tokensQ.data.length) attention.push({ title: `还有 ${tokensQ.data.length} 张餐牌未确认回收`, sub: `餐牌 ${tokensQ.data.map((t) => t.number).sort((a, b) => a - b).join('、')} · 先拿回实体牌，再在点餐页释放`, action: { label: '查看', go: () => navigate('/pos') } });
  if (openReviews.length) attention.push({ title: `离线记录待核对 ${openReviews.length} 条`, sub: reviewAmount ? `已收 ${formatRM(reviewAmount)} 尚未入云端账，上面的数字不含这些金额` : '逐条补入账或不入账', action: { label: '去核对', go: () => navigate('/owner/review') } });
  if (refundDue.length) attention.push({ title: `${refundDue.length} 单应退款待登记`, sub: `餐牌 ${refundDue.map((o) => o.tokenNumber).join('、')} · 实际退款后到订单页登记`, action: { label: '去订单', go: () => navigate('/orders') } });

  return (
    <div className="mx-auto max-w-[1440px] p-4 pb-8 lg:p-8">
      <OwnerTabs current="/owner" badge={{ '/owner/review': openReviews.length }} />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-2xl font-bold lg:text-[28px]">{greeting}，今天也辛苦了。</h2>
          <p className="text-sm text-ink-2">
            {dateLabel}{period !== 'today' ? ` 至 ${addDays(range.endExclusive, -1).slice(5)}` : ''} · 更新于 {cur.loadedAt ? new Date(cur.loadedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-2xl bg-subtle p-1" role="group" aria-label="统计区间">
            {(Object.keys(PERIOD_ZH) as Period[]).map((p) => (
              <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}
                className={`h-14 rounded-xl px-4 text-base font-semibold ${period === p ? 'bg-card shadow' : 'text-ink-2'}`}>{PERIOD_ZH[p]}</button>
            ))}
          </div>
          <button type="button" onClick={() => { cur.refresh(); before.refresh(); all.refresh(); reviews.refresh(); }} className="flex h-14 items-center gap-1.5 rounded-xl border border-line bg-card px-4 font-semibold"><Icon name="refresh" size={18} />刷新</button>
          <button type="button" disabled={!summary} onClick={exportCsv} className="flex h-14 items-center gap-1.5 rounded-xl border border-line bg-card px-4 font-semibold disabled:opacity-40"><Icon name="download" size={18} />导出 CSV</button>
        </div>
      </div>

      {cur.error && <p role="alert" className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取失败：{cur.error}</p>}

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl bg-ok p-5 text-white shadow-card">
          <div className="flex items-center text-sm text-white/85">{PERIOD_ZH[period]}净收款<Icon name="wallet" size={20} className="ml-auto" /></div>
          <div className="mt-2 text-4xl font-black tabular-nums"><span className="mr-1 text-lg">RM</span>{summary ? formatRM(summary.netReceiptsSen).replace('RM', '') : '…'}</div>
          <div className="mt-2 text-xs text-white/85">
            {summary ? `现金 ${formatRM(summary.receipts.cashSen)} · QR ${formatRM(summary.receipts.qrSen)}${summary.refunds.totalSen ? ` · 已扣退款 ${formatRM(summary.refunds.totalSen)}` : ''}` : ''}
            {delta !== null && ` · 对比上一区间 ${delta >= 0 ? '+' : ''}${pct(delta)}`}
          </div>
        </div>
        <Kpi icon="chart" label="估算经营利润" value={summary ? formatRM(summary.estimatedProfitSen) : '…'} bad={Boolean(summary && summary.estimatedProfitSen < 0)} sub="管理估算 · 未计工资与税费" />
        <Kpi icon="serve" label="已出餐" value={mix ? `${mix.portionsServed}` : '…'} unit="份" sub={inKitchen ? `厨房还有 ${inKitchen} 单处理中` : '厨房目前没有待做单'} />
        <Kpi icon="clock" label="8 分钟内出餐率" value={svc ? pct(svc.onTimeRate) : '…'} sub={svc ? (svc.count ? `${Math.round((svc.onTimeRate ?? 0) * svc.count)} / ${svc.count} 单达标 · 平均 ${minutes(svc.avgMs)}` : '还没有已出餐样本') + (svc.excluded ? ` · ${svc.excluded} 单离线时间未核对不计` : '') : undefined} />
      </div>

      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Section title={period === 'today' ? '今日收款走势' : `${PERIOD_ZH[period]}收款走势`} hint={period === 'today' ? '按整点 · 实收减退款' : '按营业日 · 实收减退款'}>
          <TrendChart buckets={trend} loading={loading} />
        </Section>
        <Section title="客人最爱" hint="按实际出餐份数排列">
          {ranking.length === 0 ? <Empty text={loading ? '正在载入…' : '这段时间还没有出餐记录'} /> : (
            <ol className="space-y-3">
              {ranking.slice(0, 5).map((r, i) => (
                <li key={r.key} className="flex items-center gap-3">
                  <span className="w-6 text-sm text-ink-2 tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                  <Photo id={r.photoId} size={48} rounded={24} />
                  <div className="min-w-0 flex-1">
                    <b>{r.label}</b>
                    <div className="mt-1 h-1.5 rounded bg-subtle"><div className="h-1.5 rounded bg-ok/60" style={{ width: `${(r.portions / ranking[0].portions) * 100}%` }} /></div>
                  </div>
                  <b className="text-lg tabular-nums">{r.portions}<span className="ml-0.5 text-xs font-normal text-ink-2">份</span></b>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Section title="钱从哪里来，花到哪里去" hint="经营估算 · 进货不与理论成本重复扣减"
          actions={<button type="button" onClick={() => setDetail(!detail)} aria-expanded={detail} className="min-h-14 px-1 text-sm underline underline-offset-4">{detail ? '收起现金视角' : '查看现金视角'}</button>}>
          {summary ? (
            <table className="w-full text-[15px]">
              <tbody>
                {[
                  ['净收款', summary.netReceiptsSen], ['理论食材与包装成本', -costUnitsToSen(summary.allocatedCostUnits)],
                  ['未重复计算的损耗', -costUnitsToSen(summary.wastageCostUnits)], ['固定费用摊销（按日历日）', -summary.fixedCostSen],
                  ['其他营业费用', -summary.otherOpexSen],
                ].map(([l, v]) => <tr key={l as string} className="border-b border-line"><td className="py-2.5">{l}</td><td className="text-right tabular-nums">{formatRM(v as number)}</td></tr>)}
                <tr><td className="pt-3 font-bold text-ok">估算经营利润</td><td className={`pt-3 text-right font-bold tabular-nums ${summary.estimatedProfitSen < 0 ? 'text-danger' : 'text-ok'}`}>{formatRM(summary.estimatedProfitSen)}</td></tr>
                {detail && (
                  <>
                    <tr><td className="pt-5 pb-1 font-semibold" colSpan={2}>现金视角（不同于估算利润，也不是钱箱金额）</td></tr>
                    {[
                      ['实际收款 − 实际退款', summary.receipts.totalSen - summary.refunds.totalSen], ['已付进货', -summary.cash.purchasesPaidSen],
                      ['已付营业费用（含房租等付款）', -summary.cash.opexPaidSen], ['= 经营现金净流入', summary.cash.operatingNetInflowSen],
                      ['资本设备付款（另列，不计经营）', -summary.cash.capitalPaidSen],
                    ].map(([l, v]) => <tr key={l as string} className="border-b border-line"><td className="py-2">{l}</td><td className="text-right tabular-nums">{formatRM(v as number)}</td></tr>)}
                  </>
                )}
              </tbody>
            </table>
          ) : <Empty text="正在载入…" />}
          {summary && summary.wastageAlreadyAllocatedCount > 0 && <p className="mt-2 text-xs text-ink-2">另有 {summary.wastageAlreadyAllocatedCount} 条损耗属于已计入订单成本的食材，只记数量、不重复扣款。</p>}
          <p className="mt-3 text-xs text-ink-2">钱箱应有金额请看「日结」；面薄与汤底成本待实店校准。</p>
        </Section>
        <Section title="营业小提醒" hint="需要关注的事情，集中看">
          {attention.length === 0 ? (
            <p className="flex items-center gap-2 rounded-xl border border-warn/20 bg-warn-bg/60 px-4 py-3 text-sm text-ink"><Icon name="check" size={18} className="text-ok" />目前没有超时单、待回收餐牌、待核对记录或应退款。</p>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((a) => (
                <li key={a.title} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1"><b>{a.title}</b><p className="text-[13px] text-ink-2">{a.sub}</p></div>
                  {a.action && <button type="button" onClick={a.action.go} className="h-14 shrink-0 rounded-xl border border-line px-4 font-bold">{a.action.label}</button>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {!loading && summary && svc && mix && (
        <details className="group rounded-2xl border border-line bg-card p-5 shadow-card">
          <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2 font-bold"><Icon name="chevron-right" size={18} className="transition-transform group-open:rotate-90" />细账：收款构成、出餐效率、酱料与面种、回本进度</summary>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Section title="收款构成" hint="现金与 QR 分开；QR 不进钱箱">
              <BarList format={formatRM} rows={[
                { label: '现金收款', value: summary.receipts.cashSen }, { label: 'QR 收款', value: summary.receipts.qrSen },
                { label: '现金退款', value: -summary.refunds.cashSen }, { label: 'QR 退款', value: -summary.refunds.qrSen },
              ]} />
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
            <Section title="酱料与面种" hint="只算已出餐份数">
              <div className="grid grid-cols-2 gap-4">
                <BarList format={(v) => `${v}`} rows={mix.bySauce.map((r) => ({ label: r.label, value: r.portions }))} />
                <BarList format={(v) => `${v}`} rows={mix.byNoodle.map((r) => ({ label: r.label, value: r.portions }))} />
              </div>
            </Section>
            <Section title="按估算利润的回本进度" hint="期初余额由老板确认；不是现金回收">
              {payback.applicable ? (
                <>
                  <div className="h-3 rounded bg-subtle"><div className="h-3 rounded bg-ok" style={{ width: `${payback.barRatio * 100}%` }} /></div>
                  <p className="mt-2 text-sm tabular-nums">
                    累计估算经营结果 <b className={payback.cumulativeResultSen < 0 ? 'text-danger' : ''}>{formatRM(payback.cumulativeResultSen)}</b> ·
                    初始投入 {formatRM(finance.data!.initialCapitalSen)} · 进度 <b>{pct(payback.ratio)}</b> · 待收回 {formatRM(payback.remainingSen)}
                  </p>
                </>
              ) : <p className="text-ink-2">初始投入为 0，不适用。</p>}
            </Section>
          </div>
        </details>
      )}
      <p className="mt-4 text-xs text-ink-2">BOM 版本 {BOM_V1.version}；固定费用 {formatRM(fixed.monthlySen)}/月按日历日摊销。</p>
    </div>
  );
}

function Kpi({ icon, label, value, unit, sub, bad }: { icon: 'chart' | 'serve' | 'clock'; label: string; value: string; unit?: string; sub?: string; bad?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-card">
      <div className="flex items-center text-sm text-ink-2">{label}<Icon name={icon} size={icon === 'serve' ? 24 : 20} className="ml-auto" /></div>
      <div className={`mt-2 text-4xl font-black tabular-nums ${bad ? 'text-danger' : ''}`}>{value}{unit && <span className="ml-1 text-base font-bold">{unit}</span>}</div>
      {sub && <div className="mt-2 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-2">{text}</p>;
}

/** 柱状走势：最高时段用深绿，其余浅绿；数值写在最高柱上方，不依赖颜色读数。 */
function TrendChart({ buckets, loading }: { buckets: { key: string; label: string; netSen: number }[]; loading: boolean }) {
  if (!buckets.length || buckets.every((b) => b.netSen === 0)) return <Empty text={loading ? '正在载入…' : '这段时间还没有收款'} />;
  const max = Math.max(...buckets.map((b) => b.netSen), 1);
  const peak = buckets.reduce((m, b) => (b.netSen > m.netSen ? b : m), buckets[0]);
  const step = buckets.length > 16 ? Math.ceil(buckets.length / 8) : 1;
  return (
    <figure>
      <div className="flex h-56 items-end gap-1.5 border-b border-line sm:gap-2" role="img" aria-label={`最高 ${peak.label} ${formatRM(peak.netSen)}`}>
        {buckets.map((b) => (
          <div key={b.key} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${b.label} ${formatRM(b.netSen)}`}>
            {b === peak && <span className="mb-1 text-xs whitespace-nowrap text-ink-2">{formatRM(b.netSen).replace('.00', '')}</span>}
            <div className={`w-full max-w-[64px] rounded-t-md ${b === peak ? 'bg-ok' : 'bg-[#d2dac4]'}`} style={{ height: `${Math.max(2, (Math.max(0, b.netSen) / max) * 85)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 sm:gap-2">
        {buckets.map((b, i) => <span key={b.key} className="min-w-0 flex-1 text-center text-[11px] text-ink-2">{i % step === 0 ? b.label : ''}</span>)}
      </div>
      <figcaption className="mt-3 flex gap-4 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[#d2dac4]" />已收款</span>
        <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-ok" />最高时段</span>
      </figcaption>
    </figure>
  );
}
