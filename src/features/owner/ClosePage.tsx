/**
 * 日结（01 §10、02 §7；2026-10-23 运营改版 §8）：逐步核对 → 老板关账 → 冻结版本 → 导出；关账后只能用更正版本追加。
 * 新版日结（figures.schemaVersion=2）不分收款渠道：不录钱箱实点 / QR 银行核对，不推算钱箱应有。
 * 收款数字是员工人工登记，不是钱包或银行自动核对的结果。
 * 未登记收款是明确的例外：老板写明原因后结转，不算已收，也不丢弃。
 * 旧版已冻结报表（钱箱 / QR 字段）保持原样只读查看，标为旧版。
 * 页面上的预览与服务器关账用同一个领域函数计算；最终以服务器写入的快照为准。
 */
import { useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { businessDateOf } from '../../domain/businessDay';
import { DEFAULT_FIXED_COST, FixedCostPolicy, PeriodSummary } from '../../domain/finance';
import { CloseFigures, CloseFiguresV2, closeFiguresV2, CloseOrderRow, csvClose, csvSummary, describeDiff, isCloseFiguresV2 } from '../../domain/ledger';
import { costUnitsToSen, formatRM, parseRMInput } from '../../domain/money';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useNow } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { unsyncedEvents, useOfflineRuntime } from '../../data/offline/runtime';
import { useSession } from '../../app/session';
import { download, FULFILL_ZH, loadLedger, loadOpenReviews, loadUnpaidOrders, useLoad } from './data';
import { OwnerTabs, Section } from './ui';

interface Version {
  version: number;
  kind: 'close' | 'restatement';
  /** 旧版报表为 CloseFigures（钱箱 / QR）；新版为 CloseFiguresV2。 */
  figures: CloseFigures | CloseFiguresV2;
  note: string;
  exceptionReason?: string | null;
  unpaidCarriedForward?: { count: number; totalSen: number; reason: string | null } | null;
  closedAtMs: number;
  restates: number | null;
}

const MANUAL_NOTE = '收款为员工在主点单平板人工登记「已收到整单货款」，未与钱包、TNG 或银行自动核对。';

async function loadDay(date: string) {
  const [dayDoc, report, versions, orders, tokens, reviews, finance, unpaid] = await Promise.all([
    getDoc(doc(db, storePath(`businessDays/${date}`))),
    getDoc(doc(db, storePath(`dailyReports/${date}`))),
    getDocs(collection(db, storePath(`dailyReports/${date}/versions`))),
    getDocs(query(collection(db, storePath('orders')), where('businessDate', '==', date))),
    getDocs(query(collection(db, storePath('tokens')), where('state', '==', 'awaiting_return'))),
    loadOpenReviews(),
    getDoc(doc(db, storePath('config/finance'))),
    loadUnpaidOrders(date),
  ]);
  const ledger = await loadLedger({ start: date, endExclusive: nextDay(date) });
  const orderRows = orders.docs.map((d) => ({ id: d.id, ...d.data() }) as CloseOrderRow);
  return {
    state: (dayDoc.data()?.state as string | undefined) ?? 'open',
    pendingAdjustments: (dayDoc.data()?.pendingAdjustments as number | undefined) ?? 0,
    latestVersion: (report.data()?.latestVersion as number | undefined) ?? 0,
    versions: versions.docs.map((d) => d.data() as Version).sort((a, b) => b.version - a.version),
    ledger,
    orderRows,
    unpaid,
    unfinished: orderRows.filter((o) => o.fulfillmentStatus === 'queued' || o.fulfillmentStatus === 'preparing'),
    refundDue: orderRows.filter((o) => o.paymentState === 'refund_due'),
    // 只会是改版前遗留的待回收牌；新流程出餐 / 取消即自动释放。
    awaitingTokens: tokens.docs.map((d) => d.data().number as number).sort((a, b) => a - b),
    reviews,
    fixed: (finance.data()?.fixedCostPolicy as FixedCostPolicy | undefined) ?? DEFAULT_FIXED_COST,
  };
}

function nextDay(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
}

export function ClosePage() {
  const { config } = useSession();
  const now = useNow(60_000);
  const rt = useOfflineRuntime();
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const [picked, setPicked] = useState('');
  const date = picked || today;
  // 门店配置载入前营业日为空：先不查询。
  const day = useLoad(() => (date ? loadDay(date) : Promise.resolve(null)), `close-${date}`);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [ackUnpaid, setAckUnpaid] = useState(false);
  const [unpaidReason, setUnpaidReason] = useState('');
  const [ackOther, setAckOther] = useState(false);
  const [otherReason, setOtherReason] = useState('');
  const [restateReason, setRestateReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!config) return null;
  const d = day.data;
  const preview = d ? closeFiguresV2(d.ledger.docs, d.orderRows, d.unpaid, date, d.fixed) : null;
  const localUnsynced = unsyncedEvents(rt).length;
  const unpaidCount = preview?.unpaid.count ?? 0;
  const otherCount = d ? d.unfinished.length + d.refundDue.length + d.awaitingTokens.length + d.reviews.length : 0;
  const closed = d?.state === 'closed';
  const unpaidOk = unpaidCount === 0 || (ackUnpaid && unpaidReason.trim().length >= 2);
  const otherOk = otherCount === 0 || (ackOther && otherReason.trim().length >= 2);
  const latest = d?.versions[0] ?? null;
  const latestIsLegacy = Boolean(latest && !isCloseFiguresV2(latest.figures));
  const countedSen = parseRMInput(counted);

  async function close() {
    if (!preview) return;
    setBusy(true);
    setMsg(null);
    const parts = [
      unpaidCount ? `未登记收款 ${unpaidCount} 单 ${formatRM(preview.unpaid.totalSen)} 结转：${unpaidReason.trim()}` : '',
      otherCount ? `其他事项：${otherReason.trim()}` : '',
    ].filter(Boolean);
    try {
      const r = await submit<{ version: number }>('closeBusinessDay', {
        operationId: newOperationId(), businessDate: date, note,
        acknowledgeExceptions: unpaidCount + otherCount > 0 && unpaidOk && otherOk,
        exceptionReason: parts.length ? parts.join('；').slice(0, 500) : null,
      });
      setMsg({ ok: true, text: `${date} 已关账，版本 ${r.version} 已冻结。` });
      day.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e) });
      // 例外可能在预览之后发生变化（例如又有一单未登记）：刷新后重新核对。
      if (e instanceof CommandFailure && e.reasonCode === 'CLOSE_EXCEPTIONS') day.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function restate() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await submit<{ version: number; restates: number }>('restateBusinessDay', {
        operationId: newOperationId(), businessDate: date, reason: restateReason,
        // 旧版报表才有钱箱实点；新版报表不分渠道，不传。
        ...(latestIsLegacy && countedSen !== null ? { countedCashSen: countedSen } : {}),
      });
      setMsg({ ok: true, text: `已生成更正版本 ${r.version}（更正版本 ${r.restates}），旧版本保持不变。` });
      setRestateReason('');
      day.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const step = (n: number, title: string, ok: boolean, body: React.ReactNode) => (
    <li className="rounded-xl border border-line p-3">
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold text-white ${ok ? 'bg-ok' : 'bg-warn'}`}>{ok ? '✓' : n}</span>
        <b>{title}</b>
      </div>
      <div className="mt-2 text-sm">{body}</div>
    </li>
  );

  return (
    <div className="mx-auto max-w-[1100px] p-4 pb-8 lg:p-8">
      <OwnerTabs current="/owner/close" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">日结</h1>
        <input type="date" aria-label="营业日" value={date} max={today} onChange={(e) => setPicked(e.target.value)} className="h-10 rounded-lg border border-control px-2" />
        {d && <span className={`rounded-lg px-2 py-1 text-sm font-semibold ${closed ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>{closed ? `已关账 · 版本 ${d.latestVersion}` : '营业中'}</span>}
        {localUnsynced > 0 && <span className="rounded-lg bg-danger-bg px-2 py-1 text-sm font-semibold text-danger">本机未同步 {localUnsynced} 条</span>}
        <button type="button" onClick={day.refresh} className="ml-auto h-10 rounded-lg border border-control px-3 font-semibold">刷新</button>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`mb-3 rounded-lg px-3 py-2 ${msg.ok ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>{msg.text}</p>}
      {day.error && <p role="alert" className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取失败：{day.error}</p>}
      {!d && <p className="text-ink-2">正在载入…</p>}

      {d && preview && !closed && (
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <Section title="逐步核对">
            <ol className="space-y-2">
              {step(1, '未出餐订单与应退款', d.unfinished.length === 0 && d.refundDue.length === 0 && d.awaitingTokens.length === 0, (
                <>
                  {d.unfinished.length
                    ? <p>未完成 {d.unfinished.length} 单：{d.unfinished.map((o) => `${o.receiptNumber}（${o.tokenNumber}号）`).join('、')}（可结转，保留原营业日）</p>
                    : <p>没有未完成订单</p>}
                  {d.refundDue.length > 0 && <p className="text-danger">应退款待处理 {d.refundDue.length} 单：{d.refundDue.map((o) => o.receiptNumber).join('、')}</p>}
                  {d.awaitingTokens.length > 0 && <p className="text-warn">旧版遗留待回收餐牌：{d.awaitingTokens.join('、')}（新流程出餐即自动释放）</p>}
                </>
              ))}
              {step(2, '待登记收款', unpaidCount === 0, (
                <UnpaidList figures={preview} date={date} />
              ))}
              {step(3, '同步与待核对清零', d.reviews.length === 0 && localUnsynced === 0, (
                <>
                  <p>云端待核对 / 阻塞：{d.reviews.length} 条{d.reviews.length ? '（请先到「待核对」处理）' : ''}</p>
                  <p>本机未同步：{localUnsynced} 条{localUnsynced ? '（请在主收银机联网同步）' : ''}</p>
                  <p className="text-xs text-ink-2">其他设备上的未同步记录（包括离线登记的收款）这里看不到；请确认主收银机已同步完成。</p>
                </>
              ))}
              {step(4, '登记损耗', true, <p>今天已登记 {d.ledger.docs.wastage.filter((w) => w.status === 'active').length} 条。还有未登记的请先到「收支」页登记。</p>)}
            </ol>
          </Section>
          <div className="space-y-4">
            <Section title="当日数字" hint="关账前预览">
              <V2Table f={preview} />
              <p className="mt-2 text-xs text-ink-2">{MANUAL_NOTE}</p>
            </Section>
            <Section title="老板关账">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="备注（可选）" className="mb-2 h-20 w-full rounded-lg border border-control p-2" />
              {unpaidCount > 0 && (
                <div className="mb-2 rounded-lg border border-danger/40 bg-danger-bg p-2 text-sm text-danger">
                  <label className="flex items-start gap-2 font-semibold">
                    <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={ackUnpaid} onChange={(e) => setAckUnpaid(e.target.checked)} />
                    还有 {unpaidCount} 单共 {formatRM(preview.unpaid.totalSen)} 未登记收款。我已核对，这些钱确实还没收到，结转继续追收（不算已收，也不删除）。
                  </label>
                  <input value={unpaidReason} onChange={(e) => setUnpaidReason(e.target.value)} maxLength={200} placeholder="未登记结转原因（必填，例如：顾客明天来付）" className="mt-2 h-11 w-full rounded border border-control bg-card px-2 text-ink" />
                </div>
              )}
              {otherCount > 0 && (
                <div className="mb-2 rounded-lg bg-warn-bg p-2 text-sm text-warn">
                  <label className="flex items-center gap-2 font-semibold"><input type="checkbox" className="h-5 w-5" checked={ackOther} onChange={(e) => setAckOther(e.target.checked)} />我已知道还有 {otherCount} 项未处理，确认结转</label>
                  <input value={otherReason} onChange={(e) => setOtherReason(e.target.value)} maxLength={200} placeholder="结转说明（必填）" className="mt-2 h-11 w-full rounded border border-control bg-card px-2 text-ink" />
                </div>
              )}
              <button type="button" disabled={busy || !unpaidOk || !otherOk} onClick={() => void close()}
                className="h-14 w-full rounded-xl bg-brand text-lg font-bold text-white disabled:bg-control">{busy ? '正在关账…' : `关账并冻结 ${date}`}</button>
              <p className="mt-2 text-xs text-ink-2">关账后当日不能再接单、记账；之后补登记的收款计入登记当天，不改写本日冻结报表。迟到的离线单进入「关账后待调整」，用更正版本追加，原版本和已导出的文件不变。</p>
            </Section>
          </div>
        </div>
      )}

      {d && closed && (
        <div className="space-y-4">
          {d.pendingAdjustments > 0 && (
            <div role="alert" className="rounded-xl border-2 border-warn bg-warn-bg p-3 text-warn">
              <b>关账后待调整 {d.pendingAdjustments} 项</b>（例如迟到补入的离线单）。请核对后生成更正版本。
            </div>
          )}
          <Section title="生成更正版本" hint={latestIsLegacy ? '旧版本保持不变 · 该日为旧版报表，按旧口径更正' : '旧版本保持不变'}>
            <div className="flex flex-wrap items-center gap-2">
              <input value={restateReason} onChange={(e) => setRestateReason(e.target.value)} maxLength={500} placeholder="更正原因（必填）" className="h-11 min-w-[240px] flex-1 rounded-lg border border-control px-2" />
              {latestIsLegacy && (
                <input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="旧版：重新实点现金（可选）" className="h-11 w-52 rounded-lg border border-control px-2" />
              )}
              <button type="button" disabled={busy || restateReason.trim().length < 2} onClick={() => void restate()} className="h-11 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">生成更正版本</button>
            </div>
          </Section>
          {d.versions.map((v) => {
            const v2 = isCloseFiguresV2(v.figures);
            return (
              <Section key={v.version} title={`版本 ${v.version}${v.kind === 'restatement' ? `（更正版本 ${v.restates}）` : '（关账）'}${v2 ? '' : ' · 旧版'}`}
                hint={new Date(v.closedAtMs).toLocaleString('zh-CN', { hour12: false })}
                actions={<button type="button" onClick={() => {
                  download(`日结_${date}_v${v.version}.csv`, csvClose(v.figures, v.version, v.note));
                  download(`汇总_${date}_v${v.version}.csv`, csvSummary(v.figures.summary));
                }} className="h-10 rounded-lg border border-control px-3 font-semibold">导出 CSV</button>}>
                {isCloseFiguresV2(v.figures) ? (
                  <>
                    <V2Table f={v.figures} />
                    {v.figures.unpaid.count > 0 && (
                      <div className="mt-3">
                        <p className="mb-1 text-sm font-semibold text-danger">关账时结转的未登记收款 {v.figures.unpaid.count} 单 · {formatRM(v.figures.unpaid.totalSen)}</p>
                        <UnpaidTable rows={v.figures.unpaid.orders} date={date} />
                        {v.unpaidCarriedForward?.reason && <p className="mt-1 text-xs text-ink-2">结转原因：{v.unpaidCarriedForward.reason}</p>}
                      </div>
                    )}
                    <p className="mt-2 text-xs text-ink-2">{MANUAL_NOTE}</p>
                  </>
                ) : (
                  <LegacyFigures f={v.figures} />
                )}
                {(v.note || v.exceptionReason) && <p className="mt-2 text-sm text-ink-2">{v.note}{v.exceptionReason ? ` · 结转说明：${v.exceptionReason}` : ''}</p>}
              </Section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function UnpaidList({ figures, date }: { figures: CloseFiguresV2; date: string }) {
  if (!figures.unpaid.count) return <p>没有待登记收款的订单</p>;
  return (
    <>
      <p className="mb-1">
        待登记 <b>{figures.unpaid.count}</b> 单 · <b className="tabular-nums">{formatRM(figures.unpaid.totalSen)}</b>
        {figures.unpaid.totalSen !== figures.sameDayUnpaidSen ? `（其中本营业日 ${formatRM(figures.sameDayUnpaidSen)}，其余为之前营业日结转）` : ''}
      </p>
      <p className="mb-2 text-xs text-ink-2">请收银先在主点单平板核对并补登记；确实没收到的，在右侧写明原因后结转。按票号核对，餐牌会复用。</p>
      <UnpaidTable rows={figures.unpaid.orders} date={date} />
    </>
  );
}

function UnpaidTable({ rows, date }: { rows: CloseFiguresV2['unpaid']['orders']; date: string }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-subtle text-left text-xs text-ink-2">
          <tr><th className="px-2 py-1.5">票号</th><th className="px-2 py-1.5">餐牌</th><th className="px-2 py-1.5">营业日</th><th className="px-2 py-1.5 text-right">金额</th><th className="px-2 py-1.5">制作状态</th></tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className="border-t border-line">
              <td className="px-2 py-1.5 font-semibold">{o.receiptNumber}</td>
              <td className="px-2 py-1.5 tabular-nums">{o.tokenNumber}号</td>
              <td className={`px-2 py-1.5 tabular-nums ${o.businessDate < date ? 'text-warn' : ''}`}>{o.businessDate}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatRM(o.totalSen)}</td>
              <td className="px-2 py-1.5">{FULFILL_ZH[o.fulfillmentStatus] ?? o.fulfillmentStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, v, strong, tone }: { label: string; v: number | string; strong?: boolean; tone?: 'bad' | 'warn' }) {
  return (
    <tr className={`border-b border-line ${strong ? 'font-bold' : ''}`}>
      <td className="py-1">{label}</td>
      <td className={`text-right tabular-nums ${tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''}`}>{typeof v === 'number' ? formatRM(v) : v}</td>
    </tr>
  );
}

/** 新版日结数字：不分渠道；成本与利润按已登记收款估算。 */
function V2Table({ f }: { f: CloseFiguresV2 }) {
  const s: PeriodSummary = f.summary;
  return (
    <table className="w-full text-sm"><tbody>
      <Row label={`有效订单金额（${f.validOrderCount} 单${f.cancelledOrderCount ? `，另取消 ${f.cancelledOrderCount} 单` : ''}）`} v={f.validOrderSen} />
      <Row label="出餐份数" v={`${f.servedPortions} 份`} />
      <Row label="已登记收款（人工确认）" v={f.registeredSen} strong />
      {f.registeredForEarlierDaysSen !== 0 && <Row label="　其中跨日补登记（之前营业日的单）" v={f.registeredForEarlierDaysSen} />}
      {f.paymentCorrectionsSen !== 0 && <Row label="　其中误登记更正" v={f.paymentCorrectionsSen} />}
      <Row label="已登记退款" v={-f.refundsSen} />
      <Row label="净登记收款" v={f.netRegisteredSen} strong />
      <Row label={`待登记收款（${f.unpaid.count} 单，含结转）`} v={f.unpaid.totalSen} tone={f.unpaid.count ? 'bad' : undefined} />
      {/* 放弃追收：不计实收，单独列出（扣除恢复待收款的）。旧快照没有这个字段。 */}
      {(f.writtenOffSen ?? 0) !== 0 && <Row label={`未收回金额（老板放弃追收 ${f.writtenOffCount ?? 0} 单，不计实收）`} v={f.writtenOffSen ?? 0} tone="bad" />}
      {s.hasLegacyChannels && <Row label="　旧版记录：现金 / QR 收款" v={`${formatRM(s.receipts.cashSen)} / ${formatRM(s.receipts.qrSen)}`} />}
      <tr><td className="pt-3 pb-1 font-semibold" colSpan={2}>已记录成本与支出</td></tr>
      <Row label="理论食材与包装成本" v={-costUnitsToSen(s.allocatedCostUnits)} />
      <Row label="损耗（不重复）" v={-costUnitsToSen(s.wastageCostUnits)} />
      <Row label="固定费用摊销" v={-s.fixedCostSen} />
      <Row label="其他营业费用" v={-s.otherOpexSen} />
      <Row label="估算经营利润（按已登记收款估算）" v={s.estimatedProfitSen} strong tone={s.estimatedProfitSen < 0 ? 'bad' : undefined} />
      <Row label="已付进货" v={-s.cash.purchasesPaidSen} />
      <Row label="已付营业费用" v={-s.cash.opexPaidSen} />
    </tbody></table>
  );
}

/** 旧版冻结报表（钱箱 / QR 拆分）：只读查看，不改写。 */
function LegacyFigures({ f }: { f: CloseFigures }) {
  return (
    <>
      <p className="mb-2 rounded-lg bg-subtle px-2 py-1 text-xs text-ink-2">旧版日结：当时按现金 / QR 分开核对钱箱与银行端。以下为冻结时的原始数字，只读。</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Fig label="净收款" v={formatRM(f.summary.netReceiptsSen)} />
        <Fig label="估算经营利润" v={formatRM(f.summary.estimatedProfitSen)} />
        <Fig label="经营现金净流入" v={formatRM(f.summary.cash.operatingNetInflowSen)} />
        <Fig label="旧版 · 钱箱应有 / 实点" v={`${formatRM(f.expectedCashSen)} / ${formatRM(f.countedCashSen)}`} />
        <Fig label="旧版 · 现金差额" v={describeDiff(f.cashDiffSen)} bad={f.cashDiffSen !== 0} />
        <Fig label="旧版 · QR 账面 / 银行端" v={`${formatRM(f.qrLedgerNetSen)} / ${formatRM(f.qrBankConfirmedSen)}`} />
        <Fig label="旧版 · QR 差额" v={describeDiff(f.qrDiffSen)} bad={f.qrDiffSen !== 0} />
      </div>
    </>
  );
}

function Fig({ label, v, bad }: { label: string; v: string; bad?: boolean }) {
  return <div className="rounded-lg bg-subtle p-2"><div className="text-xs text-ink-2">{label}</div><b className={`tabular-nums ${bad ? 'text-danger' : ''}`}>{v}</b></div>;
}
