/**
 * 成本（2026-11-14 经营改版）：每样材料多少钱、今天的料花了多少、每碗赚多少。
 * - 单价就是单位成本表（BOM）。第二阶段：每个单价标明来源（收据 / AI 估 / 你改的 / 旧设定）；
 *   AI 估价和收据价先当「建议」，老板按「对」/ 用收据价 / 改一个数，才发布新的 BOM 版本（只影响之后的新订单）。
 * - 「今天的料」= 今天用量 × 当前单价，是估算；日结和利润仍以下单时记下的成本为准。
 * - 「每碗赚多少」= 当前菜单价 − 当前单价，不含打包盒。只是算给老板看，不建议改价。
 */
import { ReactNode, useState } from 'react';
import { addDays, businessDateOf } from '../../domain/businessDay';
import { BomVersion } from '../../domain/bom';
import { ballsText } from '../../domain/costing';
import { bomValueOf, CostSourcesDoc, MATERIAL_KEYS, MATERIAL_ZH, PriceSuggestion, ReceiptPrice, receiptPrices } from '../../domain/costSources';
import { costUnitsToSen, formatCostRM, formatRM } from '../../domain/money';
import { bowlMargins, BowlMarginRow, MaterialKey, materialCost, materialUsage, UsageOrder } from '../../domain/usage';
import { estimateUnitCosts } from '../../data/firebase/aiCost';
import { useMenu } from '../../data/menu';
import { useNow } from '../../data/firebase/live';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { Icon, Photo } from '../../ui/visual';
import { CALIBRATION_ZH, loadActiveBom, loadCostSources, loadLedger, loadStockInputs, useLoad } from './data';
import { failureText, useRunner } from './finance/data';
import { Btn, Dialog, inputCls, Toast } from './finance/ui';
import { OwnerTabs } from './ui';

const COLORS: Record<string, string> = { thin_egg: 'bg-ok', mee_poh: 'bg-ok/60', wanton: 'bg-[#c9a35a]', char_siew: 'bg-brand/80', dry_base: 'bg-[#8f948a]', soup_base: 'bg-[#7fa6c6]', packaging: 'bg-[#cfd2c6]' };
const GROUPS: { id: BowlMarginRow['group']; label: string; photo?: string }[] = [
  { id: 'dry_noodle', label: '干捞面（红 / 黑 / 白酱一样）', photo: 'dish.dry_noodle.red' },
  { id: 'soup_noodle', label: '云吞汤面', photo: 'dish.soup_noodle' },
  { id: 'wanton', label: '云吞汤 · 干捞云吞', photo: 'dish.wanton_soup' },
  { id: 'kosong', label: '净面（不放云吞、叉烧）' },
  { id: 'add_on', label: '加料' },
];
const CAL_OF: Partial<Record<MaterialKey, string>> = { mee_poh: 'noodleHalfBall.mee_poh', soup_base: 'base.soup_noodle', dry_base: 'scallion_lard_extra' };
const ICONS: Record<MaterialKey, ReactNode> = {
  thin_egg: <Photo id="noodle.thin_egg" size={44} rounded={12} />,
  mee_poh: <Photo id="noodle.mee_poh" size={44} rounded={12} />,
  wanton: <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#f6efe1] text-[#9a7a3c]"><Icon name="wanton" size={26} /></span>,
  char_siew: <Photo id="ingredient.char_siew" size={44} rounded={12} />,
  dry_base: <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-brand"><Icon name="bottle" size={24} /></span>,
  soup_base: <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ok-bg text-ok"><Icon name="soup" size={24} /></span>,
  packaging: <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-subtle"><Icon name="bag" size={24} /></span>,
};

type Accept = { key: MaterialKey; unitCostUnits: number; kind: 'ai' | 'receipt' | 'owner'; basis: string; ref?: string | null };

export function CostsPage() {
  const { config } = useSession();
  const now = useNow(60_000);
  const today = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const bomQ = useLoad(() => loadActiveBom(config?.activeBomVersion), `bom-${config?.activeBomVersion}`);
  const sourcesQ = useLoad(loadCostSources, `sources-${config?.activeBomVersion}`);
  const stockQ = useLoad(() => (today ? loadStockInputs(today) : Promise.resolve(null)), `stock-${today}`);
  const menu = useMenu(config?.activeMenuVersion);
  const ledger = useLoad(() => (today ? loadLedger({ start: today, endExclusive: addDays(today, 1) }) : Promise.resolve(null)), `costs-${today}`);
  const refreshAll = () => { bomQ.refresh(); sourcesQ.refresh(); stockQ.refresh(); };
  const { busy, toast, clearToast, run } = useRunner(refreshAll);
  const [editing, setEditing] = useState<MaterialKey | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!config) return null;
  const bom = bomQ.data;
  const sources = sourcesQ.data;
  const pending = bom?.pendingCalibration ?? [];
  const usage = ledger.data ? materialUsage(ledger.data.orders as unknown as UsageOrder[]) : null;
  const cost = usage && bom ? materialCost(usage, bom) : null;
  const totalSen = cost ? costUnitsToSen(cost.totalUnits) : 0;
  const margins = menu && bom ? bowlMargins(menu, bom) : [];
  const revenueSen = usage ? (ledger.data?.orders ?? []).filter((o) => o.fulfillmentStatus !== 'cancelled').reduce((s, o) => s + o.totalSen, 0) : 0;
  const receipts = stockQ.data ? receiptPrices(stockQ.data.batches, stockQ.data.sources) : [];
  const rows = bom && sources ? MATERIAL_KEYS.map((key) => rowState(key, bom, sources, receipts)) : [];
  // 收据价比 AI 估价可靠：两个都有时「全部按对」用收据价。
  const toConfirm = rows.flatMap((r): Accept[] => r.receipt ? [{ key: r.key, unitCostUnits: r.receipt.unitCostUnits, kind: 'receipt', basis: r.receipt.basis, ref: r.receipt.batchId }]
    : r.suggestion ? [{ key: r.key, unitCostUnits: r.suggestion.unitCostUnits, kind: 'ai', basis: r.suggestion.basis }] : []);
  const unverified = rows.filter((r) => !r.source && !r.suggestion && !r.receipt);

  const accept = (items: Accept[], ok: string) => run('acceptUnitCosts', { baseVersion: config.activeBomVersion, items }, ok);
  const askAi = async () => {
    setAiBusy(true); setAiMsg(null);
    try {
      const r = await estimateUnitCosts();
      setAiMsg(r.status === 'ok'
        ? { ok: true, text: `${r.suggested?.length ? 'AI 估好了，黄色的是要你确认的价钱。' : 'AI 看过了，现在的价钱都不用改。'}${r.notes?.length ? ` ${r.notes.join(' ')}` : ''}` }
        : { ok: false, text: { disabled: 'AI 记成本还没开启：到「账目 · AI 记成本」开启后再试。', not_configured: '服务器还没设定 AI 密钥。', quota: '今天的 AI 次数用完了，明天再试。', failed: 'AI 这次没估成功，可以稍后再试，或直接改价钱。', not_requested: '' }[r.status] });
      sourcesQ.refresh();
    } catch (e) {
      setAiMsg({ ok: false, text: failureText(e) });
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] p-4 pb-8 lg:p-8">
      <OwnerTabs current="/owner/costs" />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <div className="text-[11px] tracking-[0.18em] text-ink-2">WHAT A BOWL COSTS / 每碗成本</div>
          <h2 className="mt-1 text-2xl font-bold lg:text-[28px]">每碗赚多少，一目了然。</h2>
          <p className="text-sm text-ink-2">有收据的用收据价；没有的，AI 先估一个。你只要按「对」，或改一个数。</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" disabled={aiBusy || !bom} onClick={() => void askAi()} className="flex h-14 items-center gap-2 rounded-xl border border-line bg-card px-4 font-semibold disabled:opacity-50"><Icon name="sparkle" size={18} />{aiBusy ? 'AI 估价中…' : '让 AI 估价'}</button>
          <button type="button" onClick={() => navigate('/owner/finance/ingredients')} className="flex h-14 items-center gap-2 rounded-xl bg-brand px-5 font-bold text-[#fff8e8]"><Icon name="camera" size={20} />拍进货单</button>
        </div>
      </div>

      {(bomQ.error || sourcesQ.error) && <p role="alert" className="mb-4 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取单价失败：{bomQ.error ?? sourcesQ.error}</p>}
      {aiMsg && <p role="status" className={`mb-4 rounded-xl px-4 py-3 text-[14px] ${aiMsg.ok ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>{aiMsg.text}</p>}

      {toConfirm.length > 0 ? (
        <section className="mb-5 flex flex-wrap items-center gap-4 rounded-2xl border border-[#ecd9a8] bg-warn-bg/70 p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-card text-warn"><Icon name="sparkle" size={24} /></span>
          <div className="min-w-[200px] flex-1">
            <b className="text-[17px]">{toConfirm.length} 个价钱等你确认</b>
            <p className="text-[14px] text-[#6b5524]">{toConfirm.map((t) => MATERIAL_ZH[t.key].name).join('、')}。按「对」后才会用新价钱算（只影响之后的新订单）。</p>
          </div>
          <button type="button" disabled={busy} onClick={() => void accept(toConfirm, `已确认 ${toConfirm.length} 个价钱`)} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-ok px-5 font-bold text-white disabled:opacity-50 sm:w-auto"><Icon name="check" size={18} />全部按对</button>
        </section>
      ) : pending.length > 0 && unverified.length > 0 && (
        <section className="mb-5 flex flex-wrap items-center gap-4 rounded-2xl border border-[#ecd9a8] bg-warn-bg/70 p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-card text-warn"><Icon name="edit" size={24} /></span>
          <div className="min-w-[200px] flex-1">
            <b className="text-[17px]">{pending.length} 项成本还没核实</b>
            <p className="text-[14px] text-[#6b5524]">{pending.map((k) => CALIBRATION_ZH[k] ?? k).join('、')}。按「让 AI 估价」先估一个，或拍进货单。</p>
          </div>
          <button type="button" disabled={aiBusy} onClick={() => void askAi()} className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl border border-[#d9c48f] bg-card px-4 font-bold disabled:opacity-50 sm:w-auto"><Icon name="sparkle" size={18} />让 AI 估价</button>
        </section>
      )}

      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
          <div className="mb-1 flex flex-wrap items-baseline gap-2"><h3 className="text-lg font-bold">每样材料多少钱</h3>{bom && <span className="text-sm text-ink-2">当前版本 {bom.version} · 改价只影响之后的新订单</span>}</div>
          {!rows.length ? <p className="py-8 text-center text-ink-2">正在载入…</p> : (
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.key} className={`grid grid-cols-[44px_minmax(0,1fr)] items-start gap-3 py-4 sm:grid-cols-[44px_minmax(0,1fr)_auto] ${r.suggestion || r.receipt ? 'bg-warn-bg/30' : ''}`}>
                  {ICONS[r.key]}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2"><b className="text-[16px]">{MATERIAL_ZH[r.key].name}</b><span className="text-[22px] font-black tabular-nums">{formatCostRM(r.current)}</span><span className="text-[13px] text-ink-2">/ {MATERIAL_ZH[r.key].unit}</span><SourceTag r={r} /></div>
                    <p className="mt-0.5 text-[13px] text-ink-2">{r.source ? r.source.basis : r.calibrating ? '开张时的估值，还没核实' : '开张时定的，没记来源'}{r.key === 'soup_base' && bom && bom.base.soup_noodle !== bom.base.wanton_soup ? ` · 云吞汤面 ${formatCostRM(bom.base.soup_noodle)}` : ''}</p>
                    {r.suggestion && (
                      <div className="mt-2 rounded-xl border border-[#ecd9a8] bg-card px-3 py-2 text-[13px]">
                        <span className="inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-[12px] font-bold text-warn"><Icon name="sparkle" size={13} />AI 估</span>
                        <b className="ml-2 text-[15px] tabular-nums">{formatCostRM(r.suggestion.unitCostUnits)}</b>
                        {r.suggestion.lowUnits !== null && r.suggestion.highUnits !== null && <span className="ml-1 text-ink-2">（大约 {formatCostRM(r.suggestion.lowUnits)}–{formatCostRM(r.suggestion.highUnits).replace('RM', '')}）</span>}
                        <p className="mt-1 text-ink-2">{r.suggestion.basis}</p>
                      </div>
                    )}
                    {r.receipt && (
                      <div className="mt-2 rounded-xl border border-ok/30 bg-card px-3 py-2 text-[13px]">
                        <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-[12px] font-bold text-ok"><Icon name="receipt" size={13} />收据价</span>
                        <b className="ml-2 text-[15px] tabular-nums">{formatCostRM(r.receipt.unitCostUnits)}</b>
                        <p className="mt-1 text-ink-2">{r.receipt.basis}</p>
                      </div>
                    )}
                  </div>
                  <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-3 sm:self-center sm:justify-end">
                    {r.suggestion && <button type="button" disabled={busy} onClick={() => void accept([{ key: r.key, unitCostUnits: r.suggestion!.unitCostUnits, kind: 'ai', basis: r.suggestion!.basis }], `${MATERIAL_ZH[r.key].name}已确认`)} className="h-11 rounded-xl bg-ok px-4 font-bold text-white disabled:opacity-50">对</button>}
                    {r.receipt && <button type="button" disabled={busy} onClick={() => void accept([{ key: r.key, unitCostUnits: r.receipt!.unitCostUnits, kind: 'receipt', basis: r.receipt!.basis, ref: r.receipt!.batchId }], `${MATERIAL_ZH[r.key].name}改用收据价`)} className="h-11 rounded-xl bg-ok px-4 font-bold text-white disabled:opacity-50">用收据价</button>}
                    {!r.suggestion && !r.receipt && !r.source && <button type="button" disabled={busy} onClick={() => void accept([{ key: r.key, unitCostUnits: r.current, kind: 'owner', basis: '你确认现在的价钱是对的' }], `${MATERIAL_ZH[r.key].name}已确认`)} className="h-11 rounded-xl border border-line bg-card px-3 font-bold disabled:opacity-50">这个价对</button>}
                    <button type="button" disabled={busy} onClick={() => setEditing(r.key)} className="h-11 rounded-xl border border-line bg-card px-4 font-bold disabled:opacity-50">改</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 rounded-xl bg-subtle px-4 py-3 text-[13px] text-ink-2">AI 估价按收据价和柔佛一般批发价估，只是建议；按「对」才会用。也可以在设置里一次改全部单价。</p>
        </section>

        <section className="min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
          <h3 className="text-lg font-bold">今天{usage ? ` ${usage.bowls} 碗` : ''}用掉的材料</h3>
          {!cost || !usage || usage.bowls === 0 ? <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-2">{ledger.loading ? '正在载入…' : '今天还没有订单'}</p> : (
            <>
              <div className="flex flex-wrap items-baseline gap-2"><span className="text-[13px] text-ink-2">约</span><span className="text-[34px] font-black tabular-nums">{formatRM(totalSen)}</span><span className="text-[13px] text-ink-2">· 平均每碗 {formatRM(Math.round(totalSen / usage.bowls))}</span></div>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-subtle">
                {cost.lines.filter((l) => l.costUnits > 0).map((l) => <span key={l.key} className={COLORS[l.key]} style={{ width: `${(l.costUnits / cost.totalUnits) * 100}%` }} />)}
              </div>
              <table className="mt-3 w-full text-[14px] tabular-nums">
                <tbody>
                  {cost.lines.filter((l) => l.qty > 0).sort((a, b) => b.costUnits - a.costUnits).map((l) => (
                    <tr key={l.key} className="border-b border-line last:border-0">
                      <td className="py-2"><i className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${COLORS[l.key]}`} />{l.label} <span className="text-ink-2">{l.key === 'thin_egg' || l.key === 'mee_poh' ? `${ballsText(l.qty)} 粒` : `${l.qty} ${l.unit}`} × {formatCostRM(l.unitCostUnits).replace('RM', '')}</span></td>
                      <td className="w-[90px] text-right font-semibold">{formatCostRM(l.costUnits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {revenueSen > 0 && <p className="mt-3 text-[13px] text-ink-2">今天订单金额 {formatRM(revenueSen)}，扣掉材料约赚 {formatRM(revenueSen - totalSen)}（{Math.round(((revenueSen - totalSen) / revenueSen) * 100)}%），还没扣租金电费。</p>}
            </>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
        <div className="mb-1 flex flex-wrap items-baseline gap-2"><h3 className="text-lg font-bold">每碗赚多少</h3><span className="text-sm text-ink-2">现在的卖价 − 材料成本 · 按上面的单价算</span></div>
        <p className="mb-3 text-[13px] text-ink-2">只是算给你看，不是叫你改价。{bom ? `打包每碗另加 ${formatCostRM(bom.packagingPerPortion)} 盒子钱（不向客人收）。` : ''}</p>
        {!margins.length ? <p className="py-8 text-center text-ink-2">正在载入…</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-[15px] tabular-nums">
              <thead><tr className="text-left text-[13px] text-ink-2"><th className="py-2 font-semibold">菜</th><th className="py-2 text-right font-semibold">卖价</th><th className="py-2 text-right font-semibold">材料</th><th className="py-2 text-right font-semibold">赚</th><th className="w-[34%] py-2 pl-6 font-semibold">赚几成</th></tr></thead>
              <tbody>
                {GROUPS.map((g) => {
                  const list = margins.filter((r) => r.group === g.id);
                  if (!list.length) return null;
                  return [
                    <tr key={g.id}><td colSpan={5} className="pt-4 pb-1 text-[13px] font-bold text-ink-2"><span className="inline-flex items-center gap-2">{g.photo && <Photo id={g.photo} size={24} rounded={12} />}{g.label}</span></td></tr>,
                    ...list.map((r) => <MarginRow key={`${g.id}-${r.label}`} row={r} />),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && bom && (
        <EditPriceDialog keyName={editing} current={bomValueOf(bom, editing)} busy={busy} onClose={() => setEditing(null)}
          onSave={async (units) => { if (await accept([{ key: editing, unitCostUnits: units, kind: 'owner', basis: '你改的价钱' }], `${MATERIAL_ZH[editing].name}已改成 ${formatCostRM(units)}`)) setEditing(null); }} />
      )}
      <Toast toast={toast} onClose={clearToast} />
    </div>
  );
}

interface RowState { key: MaterialKey; current: number; source: CostSourcesDoc['prices'][MaterialKey] | null; suggestion: PriceSuggestion | null; receipt: ReceiptPrice | null; calibrating: boolean }

/** 每一行：现在的价钱、来源（只有和现在的价钱一致才算数）、待确认的 AI 建议、和现在不一样的收据价。 */
function rowState(key: MaterialKey, bom: BomVersion, sources: CostSourcesDoc, receipts: ReceiptPrice[]): RowState {
  const current = bomValueOf(bom, key);
  const src = sources.prices[key];
  const source = src && src.unitCostUnits === current ? src : null;
  const sug = sources.suggestions[key];
  const suggestion = sug && sug.unitCostUnits !== current ? sug : null;
  const rc = receipts.find((r) => r.key === key);
  const receipt = rc && rc.unitCostUnits !== current && !(source?.kind === 'receipt' && source.ref === rc.batchId) && source?.kind !== 'owner' ? rc : null;
  const cal = CAL_OF[key];
  return { key, current, source, suggestion, receipt, calibrating: Boolean(cal && bom.pendingCalibration.includes(cal)) };
}

function SourceTag({ r }: { r: RowState }) {
  if (r.source) {
    const k = r.source.kind;
    const cls = k === 'receipt' ? 'bg-ok-bg text-ok' : k === 'ai' ? 'bg-warn-bg text-warn' : 'bg-subtle text-ink';
    const label = k === 'receipt' ? '收据 · 已确认' : k === 'ai' ? 'AI 估 · 已确认' : '已确认';
    return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-bold ${cls}`}><Icon name={k === 'receipt' ? 'receipt' : 'check'} size={13} />{label}</span>;
  }
  return r.calibrating
    ? <span className="whitespace-nowrap rounded-full border border-dashed border-warn px-2 py-0.5 text-[12px] font-semibold text-warn">还没核实</span>
    : <span className="whitespace-nowrap rounded-full border border-dashed border-control px-2 py-0.5 text-[12px] font-semibold text-ink-2">旧设定</span>;
}

function EditPriceDialog({ keyName, current, busy, onClose, onSave }: { keyName: MaterialKey; current: number; busy: boolean; onClose: () => void; onSave: (units: number) => void }) {
  const [text, setText] = useState((current / 1000).toFixed(3));
  const v = /^\d{1,2}(\.\d{1,3})?$/.test(text.trim()) ? Math.round(Number(text) * 1000) : null;
  const ok = v !== null && v > 0 && v <= 20_000;
  const noodle = keyName === 'thin_egg' || keyName === 'mee_poh';
  return (
    <Dialog title={`改${MATERIAL_ZH[keyName].name}的价钱`} sub={`每${MATERIAL_ZH[keyName].unit}多少钱。保存后发布新的成本版本，只影响之后的新订单。`} onClose={onClose}
      footer={<><Btn onClick={onClose}>取消</Btn><Btn tone="primary" disabled={!ok || busy} onClick={() => ok && onSave(v!)}>保存</Btn></>}>
      <label className="block text-[13px] font-semibold">
        <span className="mb-1.5 block">RM（最多 3 位小数）</span>
        <input inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} className={inputCls} />
      </label>
      <p className="mt-2 text-[13px] text-ink-2">现在是 {formatCostRM(current)}。{noodle ? '面团单价会取到 0.002 的倍数，方便算半粒。' : ''}{!ok && text ? ' 请输入 0.001–20 之间的数字。' : ''}</p>
    </Dialog>
  );
}

function MarginRow({ row }: { row: BowlMarginRow }) {
  const costSen = costUnitsToSen(row.costUnits);
  const profit = row.priceSen - costSen;
  const ratio = row.priceSen > 0 ? profit / row.priceSen : 0;
  const low = ratio < 0.4;
  return (
    <tr className={`border-t border-line ${low ? 'bg-warn-bg/40' : ''}`}>
      <td className="py-2.5 pl-1">{row.label}</td>
      <td className="text-right">{formatRM(row.priceSen)}</td>
      <td className="text-right text-ink-2">{formatRM(costSen)}</td>
      <td className={`text-right font-bold ${profit < 0 ? 'text-danger' : low ? 'text-warn' : ''}`}>{formatRM(profit)}</td>
      <td className="pl-6 pr-1"><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded bg-subtle"><div className={`h-2 rounded ${low ? 'bg-warn' : 'bg-ok/70'}`} style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} /></div><span className={`w-10 text-right text-[13px] ${low ? 'font-bold text-warn' : ''}`}>{Math.round(ratio * 100)}%</span></div></td>
    </tr>
  );
}
