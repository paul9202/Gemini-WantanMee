/**
 * 后厨改单（2026-11-16）：老板就是厨师，客人到窗口说「一碗不要了」「不要辣」「换细面」，或者面薄卖完了，
 * 在后厨屏上点卡片右上角「改单」，整个屏幕给这一张单：加减碗数、换面 / 酱 / 大小 / 辣度 / 油渣 / 葱 / 加料、堂食打包，
 * 删一碗、加一碗；「其中 1 碗不一样」把 ×2 拆开只改一碗；单里有面薄时一键全换细面。
 * 按钮都是手指大小，不用打字。按「改好了」交给服务器（amendOrder），金额由服务器按当前菜单重算，这里算的只用来显示和比对。
 * 删光不是改单：提示改按「取消整单」（KitchenCancelDialog，问为什么、做了没有）。
 */
import { useMemo, useState } from 'react';
import { AmendLine, diffAmend, amendSettlement } from '../../domain/amend';
import { addOnCount, defaultConfig, LineConfig, lineName, linePhotoId, MAX_ADD_ON_COUNT, normalizeConfig, unitPriceSen, withAddOnCount } from '../../domain/lineItem';
import { AddOnId, ENTRY_TILES, Level, MenuVersion, NOODLE_TYPE_NAMES, productOf, Sauce, SAUCE_NAMES, ServiceMode, SERVICE_MODE_NAMES, Spice } from '../../domain/menu';
import type { KitchenLine, KitchenTicket } from '../../domain/kitchen';
import { kitchenRM } from '../../domain/kitchen';
import { useLang, useT } from '../../app/i18n';
import { Icon, Photo } from '../../ui/visual';

const CONFIG_KEYS: (keyof LineConfig)[] = ['productKind', 'size', 'noodleType', 'sauce', 'spice', 'lard', 'scallion', 'isKosong', 'addOns', 'note'];
const SPICE: [Spice, string, string][] = [['none', '不辣', 'No chili'], ['less', '少辣', 'Less'], ['normal', '辣', 'Spicy'], ['extra', '加辣', 'Extra']];
const LARD: [Level, string, string][] = [['none', '无', 'None'], ['normal', '正常', 'Normal'], ['extra', '多', 'Extra']];
const SCALLION: [Level, string, string][] = [['none', '走青', 'None'], ['normal', '正常', 'Normal'], ['extra', '多', 'Extra']];

type Row = AmendLine & { removed?: boolean };

export function ticketLines(t: Pick<KitchenTicket, 'lines' | 'serviceMode'>): AmendLine[] {
  return t.lines.map((l: KitchenLine) => ({
    lineId: l.lineId, quantity: l.quantity,
    serviceMode: l.serviceMode ?? (t.serviceMode === 'takeaway' ? 'takeaway' : 'dine_in'),
    config: Object.fromEntries(CONFIG_KEYS.map((k) => [k, k === 'addOns' ? [...l.addOns] : l[k as keyof KitchenLine]])) as unknown as LineConfig,
  }));
}

export const linesTotalSen = (menu: MenuVersion, lines: readonly AmendLine[]) => lines.reduce((s, l) => s + unitPriceSen(menu, l.config) * l.quantity, 0);

const newLineId = () => (globalThis.crypto?.randomUUID?.() ?? `l-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function AmendSheet({ ticket, menu, busy, disabled, onClose, onSubmit, onCancelOrder }: {
  ticket: KitchenTicket & { id: string; priorPaidSen?: number | null };
  menu: MenuVersion;
  busy: boolean;
  /** 断网 / 画面过期：只能看，不能交。 */
  disabled: boolean;
  onClose: () => void;
  onSubmit: (lines: AmendLine[], totalSen: number) => void;
  onCancelOrder: () => void;
}) {
  const tr = useT();
  const lang = useLang();
  const original = useMemo(() => ticketLines(ticket), [ticket]);
  const [rows, setRows] = useState<Row[]>(original);
  const live = rows.filter((r) => !r.removed);
  const diff = diffAmend(menu, original, live);
  const removedCount = diff.changes.filter((c) => c.kind === 'remove').length;
  const changed = diff.changes.length > 0;
  const total = linesTotalSen(menu, live);
  const fromTotal = ticket.totalSen ?? linesTotalSen(menu, original);
  const defaultMode: ServiceMode = original[0]?.serviceMode ?? 'dine_in';
  const hasPok = live.some((r) => r.config.noodleType === 'mee_poh');
  // 钱：已在前台付了（厨单「已付」或之前改单留下的已付金额）。
  const paidSen = ticket.paidBeforeServe ? fromTotal : (ticket.priorPaidSen ?? 0);
  const settle = paidSen > 0 && total !== paidSen ? amendSettlement(total, paidSen) : null;

  const update = (lineId: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.lineId === lineId ? { ...r, ...patch } : r)));
  const setConfig = (r: Row, patch: Partial<LineConfig>) => update(r.lineId, { config: normalizeConfig(menu, { ...r.config, ...patch }) });
  const split = (r: Row) => setRows((rs) => rs.flatMap((x) => (x.lineId === r.lineId ? [{ ...x, quantity: x.quantity - 1 }, { ...x, lineId: newLineId(), quantity: 1 }] : [x])));
  const add = (productKind: LineConfig['productKind'], sauce: Sauce | null) =>
    setRows((rs) => [...rs, { lineId: newLineId(), config: defaultConfig(menu, productKind, sauce), quantity: 1, serviceMode: defaultMode }]);
  const allThin = () => setRows((rs) => rs.map((r) => (r.config.noodleType === 'mee_poh' ? { ...r, config: normalizeConfig(menu, { ...r.config, noodleType: 'thin_egg' }) } : r)));

  return (
    <div role="dialog" aria-modal="true" aria-label={tr(`改 ${ticket.tokenNumber} 号`, `Edit No. ${ticket.tokenNumber}`)}
      className="fixed inset-0 z-50 flex flex-col bg-kds text-kds-text" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-kds-warning-bg px-4 py-3 text-kds-warning sm:px-7">
        <Icon name="edit" size={28} />
        <b className="text-2xl font-black text-kds-text">{tr(`改 ${ticket.tokenNumber} 号`, `Edit No. ${ticket.tokenNumber}`)}</b>
        <span className="text-base font-semibold">
          {paidSen > 0 ? tr(`前台已收 ${kitchenRM(paidSen)}`, `Paid ${kitchenRM(paidSen)} at front`) : tr('还没付钱', 'Not paid yet')}
        </span>
        <button type="button" onClick={onClose} disabled={busy} className="ml-auto flex h-14 items-center gap-2 rounded-xl bg-kds-soft px-4 text-lg font-bold text-kds-text disabled:opacity-50">
          <Icon name="close" size={22} />{tr('不改了', 'Discard')}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-7 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="min-w-0" aria-label={tr('这张单', 'This order')}>
          <h2 className="mb-2 text-sm font-bold text-kds-muted">
            {tr('这张单', 'This order')}{changed ? tr(` · 改了 ${diff.changes.length} 处`, ` · ${diff.changes.length} change(s)`) : ''}
          </h2>
          <ul className="space-y-3">
            {rows.map((r) => (
              <LineEditor key={r.lineId} r={r} menu={menu} lang={lang} mark={r.removed ? 'del' : diff.marks[r.lineId] ?? null}
                onQty={(n) => update(r.lineId, { quantity: n })} onConfig={(p) => setConfig(r, p)} onMode={(m) => update(r.lineId, { serviceMode: m })}
                onRemove={() => update(r.lineId, { removed: true })} onRestore={() => update(r.lineId, { removed: false })} onSplit={() => split(r)} />
            ))}
          </ul>
        </section>

        <aside className="min-w-0" aria-label={tr('加一碗', 'Add a bowl')}>
          <h2 className="mb-2 text-sm font-bold text-kds-muted">{tr('加一碗', 'Add a bowl')}</h2>
          <div className="grid grid-cols-3 gap-2">
            {ENTRY_TILES.map((tile) => {
              const out = menu.soldOut.includes(tile.productKind);
              return (
                <button key={tile.id} type="button" disabled={out} onClick={() => add(tile.productKind, tile.sauce)}
                  className="flex min-w-0 flex-col items-center gap-1 rounded-2xl border-2 border-kds-line bg-kds-card p-2 text-center active:translate-y-px disabled:opacity-40">
                  <Photo id={tile.photoId} size={88} rounded={10} fluid />
                  <b className="text-base leading-tight">{tr(tile.nameZh, tile.nameEn)}</b>
                  <span className="text-xs text-kds-muted">{out ? tr('卖完了', 'Sold out') : tr(`${kitchenRM(defaultPrice(menu, tile.productKind, tile.sauce))} 起`, `from ${kitchenRM(defaultPrice(menu, tile.productKind, tile.sauce))}`)}</span>
                </button>
              );
            })}
          </div>
          {hasPok && (
            <div className="mt-4 rounded-2xl border-2 border-dashed border-kds-line p-3">
              <b className="block">{tr('面薄卖完了？', 'Out of mee pok?')}</b>
              <button type="button" onClick={allThin} className="mt-2 h-14 w-full rounded-xl bg-kds-soft text-lg font-bold">{tr('这张单的面薄全部换细面', 'Switch all mee pok to thin')}</button>
            </div>
          )}
        </aside>
      </div>

      <footer className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-kds-line bg-kds-card px-4 py-3 sm:px-7">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3">
            {total !== fromTotal && <s className="text-lg tabular-nums text-kds-muted">{kitchenRM(fromTotal)}</s>}
            <b className="text-[34px] font-black leading-none tabular-nums">{kitchenRM(total)}</b>
          </div>
          <p className="mt-1 text-sm font-semibold text-kds-muted">
            {live.length === 0 ? tr('全删了？请按「取消整单」', 'Removed everything? Use “Cancel order”')
              : settle?.refundSen ? <span className="text-kds-danger">{tr(`收银机会提示退 ${kitchenRM(settle.refundSen)} 给客人`, `Front will refund ${kitchenRM(settle.refundSen)}`)}</span>
                : settle?.collectSen ? <span className="text-kds-warning">{tr(`收银机会提示补收 ${kitchenRM(settle.collectSen)}`, `Front will collect ${kitchenRM(settle.collectSen)} more`)}</span>
                  : paidSen > 0 ? tr('金额没变，钱不用动', 'Same amount — no money change')
                    : total !== fromTotal ? tr(`收银机会改成收 ${kitchenRM(total)}`, `Front will collect ${kitchenRM(total)}`) : tr('金额没变', 'Same amount')}
            {removedCount > 0 && live.length > 0 && <span className="ml-2">{tr('· 删掉的碗按「还没做」算', '· removed bowls count as not cooked')}</span>}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-3">
          <button type="button" onClick={onCancelOrder} disabled={busy || disabled}
            className="flex h-14 items-center gap-2 rounded-xl border-2 border-kds-danger px-4 text-lg font-bold text-kds-danger disabled:opacity-50">
            <Icon name="trash" size={22} />{tr('取消整单', 'Cancel order')}
          </button>
          <button type="button" onClick={() => onSubmit(live.map(({ removed: _r, ...l }) => l), total)} disabled={busy || disabled || !changed || live.length === 0}
            className="flex h-16 min-w-[180px] items-center justify-center gap-2 rounded-xl bg-kds-action px-6 text-xl font-black text-kds-action-ink disabled:opacity-45">
            <Icon name="check" size={26} />{busy ? tr('正在改…', 'Saving…') : tr('改好了', 'Done')}
          </button>
        </div>
      </footer>
    </div>
  );
}

function defaultPrice(menu: MenuVersion, kind: LineConfig['productKind'], sauce: Sauce | null) {
  return unitPriceSen(menu, defaultConfig(menu, kind, sauce));
}

function LineEditor({ r, menu, lang, mark, onQty, onConfig, onMode, onRemove, onRestore, onSplit }: {
  r: Row; menu: MenuVersion; lang: 'zh' | 'en'; mark: 'mod' | 'add' | 'del' | null;
  onQty: (n: number) => void; onConfig: (p: Partial<LineConfig>) => void; onMode: (m: ServiceMode) => void;
  onRemove: () => void; onRestore: () => void; onSplit: () => void;
}) {
  const tr = useT();
  const c = r.config;
  const product = productOf(menu, c.productKind);
  const border = mark === 'add' ? 'border-kds-live' : mark === 'mod' ? 'border-kds-action' : 'border-kds-line';
  const badge = mark === 'add' ? <span className="rounded-md bg-kds-live/20 px-2 py-0.5 text-sm font-black text-kds-live">{tr('新加', 'New')}</span>
    : mark === 'mod' ? <span className="rounded-md bg-kds-warning-bg px-2 py-0.5 text-sm font-black text-kds-warning">{tr('改', 'Changed')}</span>
      : mark === 'del' ? <span className="rounded-md bg-kds-danger-bg px-2 py-0.5 text-sm font-black text-kds-danger">{tr('删掉', 'Removed')}</span> : null;

  if (r.removed) {
    return (
      <li className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-dashed border-kds-line bg-kds-card p-3 opacity-70">
        <Photo id={linePhotoId(c)} size={48} rounded={10} />
        <b className="text-lg line-through">{lineName(menu, c, lang)} ×{r.quantity}</b>{badge}
        <button type="button" onClick={onRestore} className="ml-auto h-12 rounded-xl bg-kds-soft px-4 font-bold">{tr('恢复', 'Restore')}</button>
      </li>
    );
  }
  const seg = <T extends string | null>(value: T, opts: [T, string, string][], set: (v: T) => void, pok = false) => (
    <div className="flex flex-wrap gap-1.5">
      {opts.map(([v, zh, en]) => {
        const on = value === v;
        const pokOn = pok && on && v === 'mee_poh';
        return (
          <button key={String(v)} type="button" aria-pressed={on} onClick={() => set(v)}
            className={`h-12 min-w-16 rounded-xl border-2 px-3 text-base font-bold ${pokOn ? 'border-kds-pok bg-kds-pok text-kds-pok-ink' : on ? 'border-kds-text bg-kds-text text-kds' : 'border-kds-line'}`}>
            {tr(zh, en)}
          </button>
        );
      })}
    </div>
  );
  const row = (label: string, body: React.ReactNode) => (
    <div className="contents">
      <span className="pt-3 text-sm font-bold text-kds-muted">{label}</span>
      {body}
    </div>
  );
  return (
    <li className={`rounded-2xl border-2 bg-kds-card p-3 ${border}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Photo id={linePhotoId(c)} size={56} rounded={10} />
        <b className="min-w-0 text-xl font-black leading-tight">{lineName(menu, c, lang)}</b>
        {badge}
        <span className="text-base font-bold tabular-nums text-kds-muted">{kitchenRM(unitPriceSen(menu, c) * r.quantity)}</span>
        <div className="ml-auto inline-flex items-center overflow-hidden rounded-xl border-2 border-kds-line">
          <button type="button" aria-label={tr('少一碗', 'One less')} disabled={r.quantity <= 1} onClick={() => onQty(r.quantity - 1)} className="h-14 w-14 text-3xl font-black disabled:opacity-30">−</button>
          <span className="w-12 border-x-2 border-kds-line text-center text-2xl font-black tabular-nums" aria-live="polite">{r.quantity}</span>
          <button type="button" aria-label={tr('多一碗', 'One more')} disabled={r.quantity >= 20} onClick={() => onQty(r.quantity + 1)} className="h-14 w-14 text-3xl font-black disabled:opacity-30">+</button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-2">
        {product.sauces.length > 1 && row(tr('酱', 'Sauce'), seg(c.sauce, product.sauces.map((s) => [s, SAUCE_NAMES[s].zh, SAUCE_NAMES[s].en] as [Sauce | null, string, string]), (v) => onConfig({ sauce: v })))}
        {product.hasNoodle && row(tr('面', 'Noodle'), seg(c.noodleType, (['thin_egg', 'mee_poh'] as const).map((n) => [n, NOODLE_TYPE_NAMES[n].zh, NOODLE_TYPE_NAMES[n].en] as [LineConfig['noodleType'], string, string]), (v) => onConfig({ noodleType: v }), true))}
        {product.sizes.length > 1 && row(tr('大小', 'Size'), seg(c.size, product.sizes.map((s) => [s.id, s.nameZh, s.nameEn] as [LineConfig['size'], string, string]), (v) => onConfig({ size: v })))}
        {product.allowsSpiceAndLard && row(tr('辣', 'Chili'), seg(c.spice, SPICE as [Spice | null, string, string][], (v) => onConfig({ spice: v })))}
        {product.allowsSpiceAndLard && row(tr('油渣', 'Lard'), seg(c.lard, LARD as [Level | null, string, string][], (v) => onConfig({ lard: v })))}
        {row(tr('葱', 'Scallion'), seg(c.scallion, SCALLION, (v) => onConfig({ scallion: v })))}
        {product.addOns.length > 0 && row(tr('加料', 'Extras'), (
          <div className="flex flex-wrap gap-1.5">
            {product.addOns.map((id: AddOnId) => {
              const n = addOnCount(c, id);
              const blocked = c.isKosong && menu.addOns[id].isMeat;
              const name = tr(menu.addOns[id].nameZh, menu.addOns[id].nameEn);
              const setN = (v: number) => onConfig({ addOns: withAddOnCount(c.addOns, id, v) });
              // 没加时整个按钮加一份；加了以后变成 − 份数 +，一碗可以加好几份。
              if (n === 0 || blocked) {
                return (
                  <button key={id} type="button" aria-pressed={false} disabled={blocked} onClick={() => setN(1)}
                    className="h-12 rounded-xl border-2 border-kds-line px-3 text-base font-bold disabled:opacity-35">
                    {name} +{kitchenRM(menu.addOns[id].priceSen)}
                  </button>
                );
              }
              return (
                <div key={id} className="inline-flex h-12 items-center overflow-hidden rounded-xl border-2 border-kds-text bg-kds-text text-kds">
                  <button type="button" aria-label={tr(`${name} 少一份`, `${name}: one less`)} onClick={() => setN(n - 1)} className="h-full w-12 text-2xl font-black">−</button>
                  <span className="px-1 text-base font-bold">{name} <b className="tabular-nums" aria-live="polite">×{n}</b></span>
                  <button type="button" aria-label={tr(`${name} 多一份`, `${name}: one more`)} disabled={n >= MAX_ADD_ON_COUNT} onClick={() => setN(n + 1)} className="h-full w-12 text-2xl font-black disabled:opacity-30">+</button>
                </div>
              );
            })}
          </div>
        ))}
        {row(tr('送法', 'Serve'), seg(r.serviceMode, (['dine_in', 'takeaway'] as const).map((m) => [m, SERVICE_MODE_NAMES[m].zh, SERVICE_MODE_NAMES[m].en] as [ServiceMode, string, string]), onMode))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {r.quantity > 1 && (
          <button type="button" onClick={onSplit} className="flex h-12 items-center gap-2 rounded-xl bg-kds-soft px-4 font-bold">
            <Icon name="plus" size={18} />{tr('其中 1 碗不一样', 'Make 1 bowl different')}
          </button>
        )}
        <button type="button" onClick={onRemove} className="flex h-12 items-center gap-2 rounded-xl border-2 border-kds-danger px-4 font-bold text-kds-danger">
          <Icon name="trash" size={18} />{r.quantity > 1 ? tr(`删掉这 ${r.quantity} 碗`, `Remove all ${r.quantity}`) : tr('删掉这碗', 'Remove')}
        </button>
      </div>
    </li>
  );
}

const CANCEL_REASONS: [string, string][] = [['客人不要了', 'Customer left'], ['点错了', 'Wrong order'], ['重复下单', 'Duplicate'], ['卖完了', 'Sold out'], ['等太久', 'Waited too long'], ['其他', 'Other']];

/** 后厨直接取消：一个窗口问完「为什么」「做了没有」，按了就取消（kitchenCancelOrder）。 */
export function KitchenCancelDialog({ ticket, busy, disabled, onClose, onConfirm }: {
  ticket: KitchenTicket & { priorPaidSen?: number | null };
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
  onConfirm: (reason: string, consumed: boolean) => void;
}) {
  const tr = useT();
  const [reason, setReason] = useState<string | null>(null);
  const [consumed, setConsumed] = useState<boolean | null>(null);
  const paid = ticket.paidBeforeServe === true;
  const choice = (on: boolean) => `min-h-14 rounded-xl border-2 px-3 py-2 text-lg font-bold ${on ? 'border-kds-text bg-kds-text text-kds' : 'border-kds-line'}`;
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 sm:p-6" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
      <div className="max-h-full w-full max-w-xl overflow-y-auto rounded-2xl border-2 border-kds-line bg-kds-card p-5 text-kds-text">
        <h2 className="text-2xl font-black">{tr(`取消 ${ticket.tokenNumber} 号？`, `Cancel No. ${ticket.tokenNumber}?`)}
          {ticket.totalSen != null && <span className="ml-2 text-base font-bold text-kds-muted">{kitchenRM(ticket.totalSen)}</span>}
        </h2>
        <p className="mt-4 text-sm font-bold text-kds-muted">{tr('为什么', 'Why')}</p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CANCEL_REASONS.map(([zh, en]) => <button key={zh} type="button" aria-pressed={reason === zh} onClick={() => setReason(zh)} className={choice(reason === zh)}>{tr(zh, en)}</button>)}
        </div>
        <p className="mt-4 text-sm font-bold text-kds-muted">{tr('做了没有', 'Cooked yet?')}</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={consumed === false} onClick={() => setConsumed(false)} className={choice(consumed === false)}>
            {tr('还没做', 'Not cooked')}<small className="block text-xs font-semibold opacity-75">{tr('材料不算成本', 'no ingredient cost')}</small>
          </button>
          <button type="button" aria-pressed={consumed === true} onClick={() => setConsumed(true)} className={choice(consumed === true)}>
            {tr('已经下锅了', 'Already cooked')}<small className="block text-xs font-semibold opacity-75">{tr('材料成本照算', 'cost still counts')}</small>
          </button>
        </div>
        <p className={`mt-4 rounded-xl px-3 py-2 font-bold ${paid ? 'bg-kds-danger-bg text-kds-danger' : 'bg-kds-soft'}`}>
          {paid ? tr('这单已经在前台付了钱：取消后请老板在「订单」页退款给客人。', 'Already paid at the front: after cancelling, the owner refunds it on the Orders page.')
            : tr('还没付钱：取消后收银机上这张单直接拿掉，不用收。', 'Not paid: it disappears from the front, nothing to collect.')}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button type="button" onClick={onClose} disabled={busy} className="h-14 rounded-xl bg-kds-soft text-lg font-bold disabled:opacity-50">{tr('先不取消', 'Keep it')}</button>
          <button type="button" disabled={busy || disabled || !reason || consumed === null} onClick={() => reason && consumed !== null && onConfirm(reason, consumed)}
            className="flex h-14 items-center justify-center gap-2 rounded-xl bg-[#e0735c] text-lg font-black text-[#2a120c] disabled:opacity-45">
            <Icon name="trash" size={22} />{busy ? tr('正在取消…', 'Cancelling…') : tr('确认取消', 'Cancel order')}
          </button>
        </div>
      </div>
    </div>
  );
}
