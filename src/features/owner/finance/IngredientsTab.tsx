/** 食材与用料：五类食材、批次状态、换批；购买时间与开始使用时间分开记录。保留按份量记损耗（面球 / 云吞 / 叉烧）。 */
import { useState } from 'react';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db, storePath } from '../../../data/firebase/client';
import {
  addDays, BATCH_STATUS_ZH, BatchDoc, batchPeriod, BOM_V1, businessRangeMs, COVERAGE_STATE_ZH, coverageInRange, formatCostRM, formatDays, formatRM, Ingredient, INGREDIENT_CATEGORIES, IngredientCategory, msToZonedLocal,
  wastageCostUnits,
} from '../../../domain';
import { Icon } from '../../../ui/visual';
import type { IconName } from '../../../ui/iconSymbols';
import type { TabProps } from '../FinancePage';
import { Btn, Empty, IconTile, inputCls, Note, PageHead, Panel, Tag } from './ui';

const CAT_ICON: Record<IngredientCategory, IconName> = { noodle: 'noodle', wonton: 'wonton', topping: 'carrot', seasoning: 'bottle', other: 'box' };

export function IngredientsTab({ data, tz, nowMs, today, open, run, busy, policy }: TabProps) {
  const [cat, setCat] = useState<IngredientCategory>('noodle');
  const [search, setSearch] = useState('');
  const selected = INGREDIENT_CATEGORIES.find((c) => c.id === cat)!;
  const live = (i: Ingredient) => data.batches.filter((b) => b.ingredientId === i.id && b.status !== 'voided');
  const rows = data.ingredients.filter((i) => i.category === cat && (!search.trim() || i.name.includes(search.trim())));
  const tracked = rows.filter((i) => live(i).length);
  const story = [...data.batches].filter((b) => b.status === 'finished').sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0))[0];

  return (
    <>
      <PageHead eyebrow="INGREDIENT NOTEBOOK / 从这一批开始" title="食材怎么用，慢慢算清楚。" sub="买入先记账，开封再记时间；一批用完，自动整理使用周期。"
        actions={<>
          <Btn onClick={() => open({ kind: 'existing' })}><Icon name="plus" size={18} />录入现有食材</Btn>
          <Btn tone="primary" onClick={() => open({ kind: 'purchase' })}><Icon name="receipt" size={18} />记录新进货</Btn>
        </>} />

      <div role="group" aria-label="食材分类" className="mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
        {INGREDIENT_CATEGORIES.map((c) => {
          const n = data.ingredients.filter((i) => i.category === c.id).length;
          const active = data.batches.filter((b) => b.category === c.id && b.status === 'in_use').length;
          return (
            <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => { setCat(c.id); setSearch(''); }}
              className={`relative min-h-[120px] rounded-2xl border p-4 text-left ${cat === c.id ? 'border-[#bf6a52] bg-[#f9eee7] shadow-[inset_0_0_0_1px_#bf6a52]' : 'border-line bg-card hover:bg-subtle'}`}>
              <Icon name={CAT_ICON[c.id]} size={28} className="mb-2 text-brand" />
              <b className="block text-sm">{c.nameZh}</b>
              <small className="mt-1 block text-xs text-ink-2">{c.desc}</small>
              <small className="mt-1 block text-xs text-ink-2">{n} 项 · {active} 批在用</small>
              {cat === c.id && <Icon name="check" size={16} className="absolute right-3 top-3 text-brand" />}
            </button>
          );
        })}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="grid min-w-0 content-start gap-5">
          <Panel pad={false} title={selected.nameZh} sub={`${rows.length} 项食材 · ${tracked.length} 项已有批次记录`}
            actions={<label className="flex min-h-12 w-full items-center gap-2 rounded-xl border border-[#d9ddcf] bg-card px-3 sm:w-60"><Icon name="search" size={16} className="text-ink-2" /><input aria-label="搜索本分类食材" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="找一种食材" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>}>
            {!rows.length ? <div className="p-6"><Empty>没有找到，可以在下方添加食材。</Empty></div> : rows.map((i) => <IngredientCard key={i.id} ing={i} batches={live(i)} tz={tz} nowMs={nowMs} open={open} />)}
          </Panel>
          <Note><b>现在不用估剩多少。</b> 换新一批时，填实际开始时间；若上一批还有剩余，可选择「继续用」，不会直接算成用完。购买记录也不会自动结束上一批。</Note>
          <Panel title="常用食材，点一下就能录" sub="按你目前的用料清单整理；没有的可以自己添加">
            <div className="flex flex-wrap gap-2">
              {data.ingredients.filter((i) => i.category === cat).map((i) => {
                const has = live(i).length > 0;
                return <button key={i.id} type="button" onClick={() => open(has ? { kind: 'history', ingredientId: i.id } : { kind: 'existing', ingredientId: i.id })} className="min-h-11 rounded-lg border border-line bg-[#f5f3ec] px-3 text-sm">{i.name}{has ? '' : ' ＋'}</button>;
              })}
              <Btn small tone="ghost" onClick={() => open({ kind: 'addIngredient', category: cat })}><Icon name="plus" size={16} />添加食材</Btn>
            </div>
          </Panel>
          <WastagePanel today={today} run={run} busy={busy} data={data} open={open} />
        </div>

        <aside className="grid min-w-0 content-start gap-5">
          <CoveragePanel data={data} today={today} nowMs={nowMs} policy={policy} run={run} busy={busy} />
          <Panel title="只要记住这三步" sub="把日常用料变成可参考的成本">
            {[['先录入手上的这一批', '食材、数量、整批成本，以及实际开始使用时间。'], ['买到新货，先记进货', '放库存或立即使用都可以，采购和开封分开记录。'], ['旧批用完，换新的一批', '确认结束时间；可补充损耗与备注。']].map(([t, p], n) => (
              <div key={t} className="flex gap-3 py-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#eeeee5] text-xs text-[#68775f]">{n + 1}</span><div><b className="text-sm">{t}</b><p className="mt-1 text-xs text-ink-2">{p}</p></div></div>
            ))}
          </Panel>
          <Panel title="一批食材的故事" sub={story ? `${story.ingredientName} · 最近用完的一批` : '用完第一批后，这里显示真实周期'}>
            {story ? <Story b={story} tz={tz} /> : <p className="text-sm text-ink-2">还没有用完的批次。正在使用的批次不会提前显示最终日成本。</p>}
          </Panel>
        </aside>
      </div>
    </>
  );
}

function IngredientCard({ ing, batches, tz, nowMs, open }: { ing: Ingredient; batches: BatchDoc[]; tz: string; nowMs: number; open: TabProps['open'] }) {
  const inUse = batches.filter((b) => b.status === 'in_use').sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
  const stocked = batches.filter((b) => b.status === 'stocked');
  const lastDone = batches.filter((b) => b.status === 'finished').sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0))[0];
  const cur = inUse[inUse.length - 1];
  const pending = batches.some((b) => b.costSen === null);
  const t = (ms: number | null) => (ms ? msToZonedLocal(ms, tz).slice(5).replace('-', '/').replace('T', ' ') : '—');
  const status = inUse.length ? (inUse.length > 1 ? `${inUse.length} 批同时在用` : '使用中 · 余量待盘点') : stocked.length ? '库存待启用' : lastDone ? '已用完 · 待换新批' : '待录入';
  const lastPeriod = lastDone ? batchPeriod(lastDone) : null;
  return (
    <article className="border-b border-line px-5 py-5 last:border-0 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <IconTile name={CAT_ICON[ing.category]} tone="warm" />
          <div className="min-w-0"><h4 className="font-bold">{ing.name}</h4><small className="text-xs text-ink-2">{cur ? `当前批次 · ${cur.quantity} ${cur.unit}` : stocked.length ? `库存 ${stocked.length} 批` : '首次录入后开始追踪'}</small></div>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          <Tag tone={inUse.length ? 'green' : stocked.length || !batches.length ? 'gold' : 'plain'}>{status}</Tag>
          {pending && <Tag tone="red">成本待补</Tag>}
        </div>
      </div>
      {cur && (
        <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
          <div><dt className="text-ink-2">这一批成本</dt><dd className="mt-1 text-sm font-semibold">{cur.costSen === null ? '待补' : formatRM(cur.costSen)}</dd></div>
          <div><dt className="text-ink-2">开始使用</dt><dd className="mt-1 text-sm font-semibold">{t(cur.startedAtMs)}</dd></div>
          <div><dt className="text-ink-2">最终日成本</dt><dd className="mt-1 text-sm font-semibold text-ink-2">用完后核算</dd></div>
        </dl>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line pt-3">
        <small className="text-xs text-ink-2">
          {stocked.length ? `新货已买入 · 库存有 ${stocked.length} 批待启用` : lastPeriod ? `上一批 ${formatDays(lastPeriod.days)}${lastPeriod.avgDailySen !== null ? ` · 平均 ${formatRM(lastPeriod.avgDailySen)} / 天` : ''}` : cur ? '换批时确认旧批是否已用完' : '录入数量、整批成本及开始使用时间'}
        </small>
        <div className="flex flex-wrap gap-2">
          {batches.length > 0 && <Btn small tone="ghost" onClick={() => open({ kind: 'history', ingredientId: ing.id })}>用料记录</Btn>}
          {stocked.length > 0 ? <Btn small onClick={() => open({ kind: 'start', ingredientId: ing.id })}><Icon name="refresh" size={16} />{inUse.length ? '换批 · 启用库存新批' : '启用库存批'}</Btn>
            : cur ? <>
              <Btn small onClick={() => open({ kind: 'finish', batch: cur })}>用完了</Btn>
              <Btn small onClick={() => open({ kind: 'purchase', ingredientId: ing.id })}><Icon name="plus" size={16} />记新进货</Btn>
            </> : <Btn small onClick={() => open({ kind: 'existing', ingredientId: ing.id })}><Icon name="plus" size={16} />录入这一批</Btn>}
        </div>
      </div>
    </article>
  );
}

function Story({ b, tz }: { b: BatchDoc; tz: string }) {
  const p = batchPeriod(b);
  const t = (ms: number | null) => (ms ? msToZonedLocal(ms, tz).slice(5).replace('-', '/').replace('T', ' ') : '—');
  return (
    <>
      <ol className="relative ml-1 border-l border-[#d4dbcd]">
        {b.purchasedDate && <li className="relative mb-5 pl-5 text-xs"><span className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-[#9aa88d]" /><b className="block text-sm">{b.purchasedDate.slice(5).replace('-', '/')} · 买入</b><p className="mt-1 text-ink-2">{b.quantity} {b.unit} / 整批 {b.costSen === null ? '成本待补' : formatRM(b.costSen)}</p></li>}
        <li className="relative mb-5 pl-5 text-xs"><span className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-[#9aa88d]" /><b className="block text-sm">{t(b.startedAtMs)} · 开始使用</b></li>
        <li className="relative pl-5 text-xs"><span className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full bg-ok" /><b className="block text-sm">{t(b.endedAtMs)} · 确认用完</b><p className="mt-1 text-ink-2">用了 {formatDays(p.days)}{b.wastageQuantity !== null ? ` · 损耗 ${b.wastageQuantity} ${b.unit}` : ''}</p></li>
      </ol>
      <div className="mt-4 flex items-center justify-between border-t border-dashed border-line pt-4 text-xs">
        <span>该批平均成本<br /><small className="text-ink-2">整批成本 ÷ {formatDays(p.days)}</small></span>
        <strong className="text-2xl text-ok">{p.avgDailySen === null ? '待补' : formatRM(p.avgDailySen)}<small className="text-xs font-normal"> / 天</small></strong>
      </div>
      <p className="mt-2 text-xs text-ink-2">周期平均值，不是逐日实际用量。{BATCH_STATUS_ZH[b.status]}。</p>
    </>
  );
}

const WASTE_ZH = { overcooked: '煮烂', dropped: '掉落', leftover: '剩余', other: '其他' } as const;

/** 沿用原有的份量损耗（按 BOM 估成本，关联已计成本的取消单时不重复扣）。默认折叠。 */
function WastagePanel({ today, run, busy, data, open }: { today: string; run: TabProps['run']; busy: boolean; data: TabProps['data']; open: TabProps['open'] }) {
  const [balls, setBalls] = useState(0);
  const [wantons, setWantons] = useState(0);
  const [charSiew, setCharSiew] = useState(0);
  const [reason, setReason] = useState<keyof typeof WASTE_ZH>('dropped');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState('');
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const half = Math.round(balls * 2);
  const cost = wastageCostUnits(BOM_V1, { noodleHalfUnits: half, wantonCount: wantons, charSiewPortions: charSiew });
  const todays = data.wastage.filter((w) => w.businessDate === today);
  const step = (label: string, value: number, set: (v: number) => void, by: number) => (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-sm">{label}</span>
      <span className="flex items-center rounded-xl border border-control">
        <button type="button" aria-label={`${label}减`} onClick={() => set(Math.max(0, value - by))} className="h-12 w-12 text-xl">−</button>
        <span className="w-12 text-center font-bold tabular-nums">{value}</span>
        <button type="button" aria-label={`${label}加`} onClick={() => set(value + by)} className="h-12 w-12 text-xl">＋</button>
      </span>
    </div>
  );
  return (
    <details className="rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-bold">记份量损耗（面球 / 云吞 / 叉烧）<span className="text-xs font-normal text-ink-2">今日 {todays.length} 条</span></summary>
      <div className="mt-3 grid gap-5 md:grid-cols-2">
        <div>
          {step('面球', balls, setBalls, 0.5)}
          {step('云吞（粒）', wantons, setWantons, 1)}
          {step('叉烧（份）', charSiew, setCharSiew, 1)}
          <select aria-label="损耗原因" value={reason} onChange={(e) => setReason(e.target.value as keyof typeof WASTE_ZH)} className={`${inputCls} mt-2`}>
            {Object.entries(WASTE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input aria-label="说明" placeholder="说明（可选）" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={`${inputCls} mt-2`} />
          <input aria-label="关联订单票号" placeholder="关联订单票号（已制作后取消的单，可选）" value={receipt} onChange={(e) => setReceipt(e.target.value.trim())} className={`${inputCls} mt-2`} />
          {linkErr && <p role="alert" className="mt-2 text-sm text-danger">{linkErr}</p>}
          <p className="mt-2 text-xs text-ink-2">估算成本 {formatCostRM(cost)}（理论单价）。关联了已计入订单成本的取消单时，只记数量、不重复扣款。</p>
          <Btn tone="primary" className="mt-3 w-full" disabled={busy || half + wantons + charSiew === 0} onClick={async () => {
            setLinkErr(null);
            let linkedOrderId: string | null = null;
            if (receipt) {
              const snap = await getDocs(query(collection(db, storePath('orders')), where('receiptNumber', '==', receipt), limit(1)));
              if (snap.empty) { setLinkErr(`找不到票号 ${receipt}`); return; }
              linkedOrderId = snap.docs[0].id;
            }
            if (await run('recordWastage', { noodleHalfUnits: half, wantonCount: wantons, charSiewPortions: charSiew, reason, note, businessDate: today, linkedOrderId }, '损耗已记录')) {
              setBalls(0); setWantons(0); setCharSiew(0); setNote(''); setReceipt('');
            }
          }}>保存损耗</Btn>
        </div>
        <ul className="divide-y divide-line">
          {!todays.length && <li className="text-sm text-ink-2">今天还没有损耗记录。</li>}
          {todays.map((w) => (
            <li key={w.id} className={`flex flex-wrap items-center gap-2 py-2 text-sm ${w.status === 'voided' ? 'opacity-50' : ''}`}>
              <Tag>{WASTE_ZH[w.reason as keyof typeof WASTE_ZH] ?? w.reason}</Tag>
              <span className="min-w-0 flex-1">{w.noodleHalfUnits / 2} 面球 · {w.wantonCount} 云吞 · {w.charSiewPortions} 叉烧
                <span className="block text-xs text-ink-2">{w.alreadyAllocated ? '已在订单成本中：只记数量' : `成本 ${formatCostRM(w.costUnits)}`}{w.note ? ` · ${w.note}` : ''}</span></span>
              {w.status === 'voided' ? <span className="text-xs">已作废</span> : <Btn small tone="ghost" onClick={() => open({ kind: 'voidWastage', id: w.id, label: `${w.noodleHalfUnits / 2} 面球 · ${w.wantonCount} 云吞 · ${w.charSiewPortions} 叉烧` })}>作废</Btn>}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * 成本核算范围：老板勾选「经营利润必须覆盖」的食材并确认。实际启用过的食材自动纳入。
 * 没确认、或有必需食材缺批次 / 有缺口 / 成本待补 / 仍在用时，经营利润保持「待核算」。
 */
function CoveragePanel({ data, today, nowMs, policy, run, busy }: Pick<TabProps, 'data' | 'today' | 'nowMs' | 'policy' | 'run' | 'busy'>) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(data.coverage.requiredIngredientIds));
  const enabled = new Set(data.batches.filter((b) => b.status !== 'voided' && b.startedAtMs !== null).map((b) => b.ingredientId));
  const yesterday = addDays(today, -1);
  const { startMs, endMs } = businessRangeMs({ start: yesterday, endExclusive: today }, policy);
  const cov = coverageInRange(data.batches, data.coverage, startMs, endMs, nowMs);
  const changed = [...picked].sort().join() !== [...data.coverage.requiredIngredientIds].sort().join();
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Panel title="成本核算范围" sub="勾选经营利润必须覆盖的食材；已启用过的食材自动纳入"
      actions={data.coverage.confirmedAtMs ? <Tag tone="green">已确认</Tag> : <Tag tone="gold">未确认</Tag>}>
      <p className="mb-3 text-xs text-ink-2">{data.coverage.confirmedAtMs ? `上次确认 ${new Date(data.coverage.confirmedAtMs).toLocaleDateString('zh-CN')}。` : '预选的是按菜单配方建议的主料与配料，只是建议。'}未勾选、也从未启用的食材不要求录入，但它们的成本不在利润里。</p>
      {INGREDIENT_CATEGORIES.map((c) => (
        <fieldset key={c.id} className="mb-2">
          <legend className="text-xs font-semibold text-ink-2">{c.nameZh}</legend>
          <div className="flex flex-wrap gap-1.5">
            {data.ingredients.filter((i) => i.category === c.id).map((i) => {
              const auto = enabled.has(i.id);
              const on = auto || picked.has(i.id);
              return (
                <label key={i.id} className={`flex min-h-10 items-center gap-1.5 rounded-lg border px-2.5 text-sm ${on ? 'border-[#afc4a4] bg-ok-bg' : 'border-line'}`}>
                  <input type="checkbox" checked={on} disabled={auto} onChange={() => toggle(i.id)} className="h-4 w-4 accent-[#28644c]" />{i.name}{auto && <small className="text-[10px] text-ink-2">已启用</small>}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <Btn tone="dark" small className="mt-2 w-full" disabled={busy || (!changed && data.coverage.confirmedAtMs !== null)}
        onClick={() => void run('setCostCoverage', { ingredientIds: [...picked] }, '核算范围已确认')}>{data.coverage.confirmedAtMs ? '保存核算范围' : '确认核算范围'}</Btn>
      <div className="mt-4 border-t border-dashed border-line pt-3 text-xs">
        <b className="text-sm">昨天（{yesterday}）的覆盖情况：{cov.state === 'complete' ? '完整' : cov.state === 'unconfirmed' ? '范围未确认' : '不完整'}</b>
        <ul className="mt-1.5 space-y-0.5 text-ink-2">
          {cov.required.map((r) => <li key={r.ingredientId} className={r.state === 'covered' ? '' : 'text-warn'}>{r.name}：{COVERAGE_STATE_ZH[r.state]}</li>)}
          {!cov.required.length && <li>还没有任何必需食材。</li>}
        </ul>
        <p className="mt-2 text-ink-2">即使完整，得到的也是按批次起止时间的周期平均分摊，不是逐日真实用量。</p>
      </div>
    </Panel>
  );
}
