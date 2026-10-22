/**
 * 日结（01 §10、02 §7）：逐步核对 → 老板关账 → 冻结版本 → 导出；关账后只能用更正版本追加。
 * 页面上的预览与服务器关账用同一个领域函数计算；最终以服务器写入的快照为准。
 */
import { useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { businessDateOf, DateRange } from '../../domain/businessDay';
import { DEFAULT_FIXED_COST, FixedCostPolicy, summarizePeriod } from '../../domain/finance';
import { CloseFigures, closeFigures, csvClose, csvSummary, describeDiff, ledgerEvents } from '../../domain/ledger';
import { costUnitsToSen, formatRM, parseRMInput } from '../../domain/money';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { useNow } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { unsyncedEvents, useOfflineRuntime } from '../../data/offline/runtime';
import { useSession } from '../../app/session';
import { download, loadLedger, loadOpenReviews, useLoad } from './data';
import { OwnerTabs, Section } from './ui';

interface Version {
  version: number;
  kind: 'close' | 'restatement';
  figures: CloseFigures;
  note: string;
  exceptionReason?: string | null;
  closedAtMs: number;
  restates: number | null;
}

async function loadDay(date: string) {
  const [dayDoc, report, versions, orders, tokens, reviews, finance] = await Promise.all([
    getDoc(doc(db, storePath(`businessDays/${date}`))),
    getDoc(doc(db, storePath(`dailyReports/${date}`))),
    getDocs(collection(db, storePath(`dailyReports/${date}/versions`))),
    getDocs(query(collection(db, storePath('orders')), where('businessDate', '==', date))),
    getDocs(query(collection(db, storePath('tokens')), where('state', '==', 'awaiting_return'))),
    loadOpenReviews(),
    getDoc(doc(db, storePath('config/finance'))),
  ]);
  const ledger = await loadLedger({ start: date, endExclusive: nextDay(date) });
  const orderRows = orders.docs.map((d) => ({ id: d.id, ...d.data() }) as { id: string; fulfillmentStatus: string; paymentState: string; tokenNumber: number; receiptNumber: string; totalSen: number });
  return {
    state: (dayDoc.data()?.state as string | undefined) ?? 'open',
    pendingAdjustments: (dayDoc.data()?.pendingAdjustments as number | undefined) ?? 0,
    latestVersion: (report.data()?.latestVersion as number | undefined) ?? 0,
    versions: versions.docs.map((d) => d.data() as Version).sort((a, b) => b.version - a.version),
    ledger,
    unfinished: orderRows.filter((o) => o.fulfillmentStatus === 'queued' || o.fulfillmentStatus === 'preparing'),
    refundDue: orderRows.filter((o) => o.paymentState === 'refund_due'),
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
  const [qrBank, setQrBank] = useState('');
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const [exceptionReason, setExceptionReason] = useState('');
  const [restateReason, setRestateReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!config) return null;
  const d = day.data;
  const countedSen = parseRMInput(counted);
  const qrSen = parseRMInput(qrBank);
  const preview = d && countedSen !== null && qrSen !== null
    ? closeFigures(d.ledger.docs, { businessDate: date, countedCashSen: countedSen, qrBankConfirmedSen: qrSen }, d.fixed) : null;
  const summaryNow = d ? summarizePeriod(ledgerEvents(d.ledger.docs), { start: date, endExclusive: nextDay(date) } as DateRange, d.fixed) : null;
  const localUnsynced = unsyncedEvents(rt).length;
  const exceptionCount = d ? d.unfinished.length + d.refundDue.length + d.awaitingTokens.length + d.reviews.length : 0;
  const closed = d?.state === 'closed';

  async function close() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await submit<{ version: number }>('closeBusinessDay', {
        operationId: newOperationId(), businessDate: date, countedCashSen: countedSen, qrBankConfirmedSen: qrSen, note,
        acknowledgeExceptions: ack, exceptionReason: exceptionReason || null,
      });
      setMsg({ ok: true, text: `${date} 已关账，版本 ${r.version} 已冻结。` });
      day.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e) });
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
        ...(countedSen !== null ? { countedCashSen: countedSen } : {}), ...(qrSen !== null ? { qrBankConfirmedSen: qrSen } : {}),
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
    <div className="mx-auto max-w-[1100px] p-4 pb-24 md:pb-6">
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

      {d && !closed && (
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <Section title="逐步核对">
            <ol className="space-y-2">
              {step(1, '未出餐订单与待回收餐牌', d.unfinished.length === 0 && d.awaitingTokens.length === 0, (
                <>
                  {d.unfinished.length ? <p>未完成 {d.unfinished.length} 单：{d.unfinished.map((o) => `${o.tokenNumber}号`).join('、')}（可结转，保留原营业日）</p> : <p>没有未完成订单</p>}
                  {d.awaitingTokens.length ? <p>待回收餐牌：{d.awaitingTokens.join('、')}</p> : <p>没有待回收餐牌</p>}
                  {d.refundDue.length > 0 && <p className="text-danger">应退款待处理 {d.refundDue.length} 单：{d.refundDue.map((o) => o.receiptNumber).join('、')}</p>}
                </>
              ))}
              {step(2, '同步与待核对清零', d.reviews.length === 0 && localUnsynced === 0, (
                <>
                  <p>云端待核对 / 阻塞：{d.reviews.length} 条{d.reviews.length ? '（请先到「待核对」处理）' : ''}</p>
                  <p>本机未同步：{localUnsynced} 条{localUnsynced ? '（请在主收银机联网同步）' : ''}</p>
                  <p className="text-xs text-ink-2">其他设备上的未同步记录这里看不到；请确认主收银机已同步完成。</p>
                </>
              ))}
              {step(3, '盘点钱箱', countedSen !== null, (
                <label className="flex items-center gap-2">实点现金 RM<input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} className="h-11 w-36 rounded-lg border border-control px-2 tabular-nums" /></label>
              ))}
              {step(4, '核对 QR', qrSen !== null, (
                <label className="flex items-center gap-2">银行端看到的 QR 净额 RM<input inputMode="decimal" value={qrBank} onChange={(e) => setQrBank(e.target.value)} className="h-11 w-36 rounded-lg border border-control px-2 tabular-nums" /></label>
              ))}
              {step(5, '登记损耗', true, <p>今天已登记 {d.ledger.docs.wastage.filter((w) => w.status === 'active').length} 条。还有未登记的请先到「收支」页登记。</p>)}
              {step(6, '查看收支差额', preview !== null, preview ? (
                <table className="w-full">
                  <tbody>
                    <tr><td>钱箱应有</td><td className="text-right tabular-nums">{formatRM(preview.expectedCashSen)}</td></tr>
                    <tr><td>钱箱实点</td><td className="text-right tabular-nums">{formatRM(preview.countedCashSen)}</td></tr>
                    <tr className="font-bold"><td>现金差额</td><td className={`text-right ${preview.cashDiffSen ? 'text-danger' : 'text-ok'}`}>{describeDiff(preview.cashDiffSen)}</td></tr>
                    <tr><td>QR 账面净额</td><td className="text-right tabular-nums">{formatRM(preview.qrLedgerNetSen)}</td></tr>
                    <tr className="font-bold"><td>QR 差额</td><td className={`text-right ${preview.qrDiffSen ? 'text-danger' : 'text-ok'}`}>{describeDiff(preview.qrDiffSen)}</td></tr>
                  </tbody>
                </table>
              ) : <p className="text-ink-2">填好实点现金与 QR 后显示</p>)}
            </ol>
          </Section>
          <div className="space-y-4">
            {summaryNow && (
              <Section title="当日数字">
                <table className="w-full text-sm"><tbody>
                  {[['净收款', summaryNow.netReceiptsSen], ['理论成本', -costUnitsToSen(summaryNow.allocatedCostUnits)], ['损耗（不重复）', -costUnitsToSen(summaryNow.wastageCostUnits)],
                    ['固定费用摊销', -summaryNow.fixedCostSen], ['其他营业费用', -summaryNow.otherOpexSen], ['估算经营利润', summaryNow.estimatedProfitSen], ['经营现金净流入', summaryNow.cash.operatingNetInflowSen]]
                    .map(([l, v]) => <tr key={l as string} className="border-b border-line"><td className="py-1">{l}</td><td className="text-right tabular-nums">{formatRM(v as number)}</td></tr>)}
                </tbody></table>
              </Section>
            )}
            <Section title="老板关账">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="备注（例如现金差额原因）" className="mb-2 h-20 w-full rounded-lg border border-control p-2" />
              {exceptionCount > 0 && (
                <div className="mb-2 rounded-lg bg-warn-bg p-2 text-sm text-warn">
                  <label className="flex items-center gap-2 font-semibold"><input type="checkbox" className="h-5 w-5" checked={ack} onChange={(e) => setAck(e.target.checked)} />我已知道还有 {exceptionCount} 项未处理，确认结转</label>
                  <input value={exceptionReason} onChange={(e) => setExceptionReason(e.target.value)} maxLength={500} placeholder="结转说明（必填）" className="mt-2 h-10 w-full rounded border border-control bg-card px-2" />
                </div>
              )}
              <button type="button" disabled={busy || !preview || (exceptionCount > 0 && (!ack || exceptionReason.trim().length < 2))} onClick={() => void close()}
                className="h-14 w-full rounded-xl bg-brand text-lg font-bold text-white disabled:bg-control">{busy ? '正在关账…' : `关账并冻结 ${date}`}</button>
              <p className="mt-2 text-xs text-ink-2">关账后当日不能再接单、记账；迟到的离线单进入「关账后待调整」，用更正版本追加，原版本和已导出的文件不变。</p>
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
          <Section title="生成更正版本" hint="旧版本保持不变">
            <div className="flex flex-wrap items-center gap-2">
              <input value={restateReason} onChange={(e) => setRestateReason(e.target.value)} maxLength={500} placeholder="更正原因（必填）" className="h-11 min-w-[240px] flex-1 rounded-lg border border-control px-2" />
              <input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="重新实点现金（可选）" className="h-11 w-44 rounded-lg border border-control px-2" />
              <button type="button" disabled={busy || restateReason.trim().length < 2} onClick={() => void restate()} className="h-11 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">生成更正版本</button>
            </div>
          </Section>
          {d.versions.map((v) => (
            <Section key={v.version} title={`版本 ${v.version}${v.kind === 'restatement' ? `（更正版本 ${v.restates}）` : '（关账）'}`}
              hint={new Date(v.closedAtMs).toLocaleString('zh-CN', { hour12: false })}
              actions={<button type="button" onClick={() => {
                download(`日结_${date}_v${v.version}.csv`, csvClose(v.figures, v.version, v.note));
                download(`汇总_${date}_v${v.version}.csv`, csvSummary(v.figures.summary));
              }} className="h-10 rounded-lg border border-control px-3 font-semibold">导出 CSV</button>}>
              <div className="grid gap-2 sm:grid-cols-3">
                <Fig label="净收款" v={formatRM(v.figures.summary.netReceiptsSen)} />
                <Fig label="估算经营利润" v={formatRM(v.figures.summary.estimatedProfitSen)} />
                <Fig label="经营现金净流入" v={formatRM(v.figures.summary.cash.operatingNetInflowSen)} />
                <Fig label="钱箱应有 / 实点" v={`${formatRM(v.figures.expectedCashSen)} / ${formatRM(v.figures.countedCashSen)}`} />
                <Fig label="现金差额" v={describeDiff(v.figures.cashDiffSen)} bad={v.figures.cashDiffSen !== 0} />
                <Fig label="QR 差额" v={describeDiff(v.figures.qrDiffSen)} bad={v.figures.qrDiffSen !== 0} />
              </div>
              {(v.note || v.exceptionReason) && <p className="mt-2 text-sm text-ink-2">{v.note}{v.exceptionReason ? ` · 结转说明：${v.exceptionReason}` : ''}</p>}
            </Section>
          ))}
        </div>
      )}
    </div>
  );
}

function Fig({ label, v, bad }: { label: string; v: string; bad?: boolean }) {
  return <div className="rounded-lg bg-subtle p-2"><div className="text-xs text-ink-2">{label}</div><b className={`tabular-nums ${bad ? 'text-danger' : ''}`}>{v}</b></div>;
}
