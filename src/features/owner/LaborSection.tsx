/**
 * 成本页「请人工钱」（2026-11-15）：老板自己填，改了从某天起算，之前的日子照旧。
 * 加人、改工钱、没来（请假）、不做了 / 换人、改名或删掉填错的。都走 updateLabor（domain/labor 同一套校验）。
 * isOpen：某天有没有开门（按订单算）；按天的工钱只算开门的日子。
 */
import { useState } from 'react';
import { collection, documentId, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { addDays, DateRange } from '../../domain/businessDay';
import { dayAfter, laborForDate, laborForRange, LaborWorker, nextRate, PAY_KIND_ZH, PayKind, payText, rateOn, splitWorkers } from '../../domain/labor';
import { formatRM } from '../../domain/money';
import { db, storePath } from '../../data/firebase/client';
import { Icon } from '../../ui/visual';
import { loadLaborPlan, useLoad } from './data';
import { useRunner } from './finance/data';
import { Btn, Dialog, Field, inputCls, Toast } from './finance/ui';

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
type DialogState =
  | { kind: 'add' } | { kind: 'rate'; w: LaborWorker } | { kind: 'absent'; w: LaborWorker } | { kind: 'end'; w: LaborWorker } | { kind: 'more'; w: LaborWorker };

export function LaborSection({ today, isOpen, onChanged }: { today: string; isOpen: (date: string) => boolean; onChanged?: () => void }) {
  const planQ = useLoad(loadLaborPlan, 'labor');
  const firstDayQ = useLoad(async () => (await getDocs(query(collection(db, storePath('businessDays')), orderBy(documentId()), limit(1)))).docs[0]?.id ?? null, 'first-business-day');
  const { busy, toast, clearToast, run } = useRunner(() => { planQ.refresh(); onChanged?.(); });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const plan = planQ.data;
  const save = async (ops: Record<string, unknown>[], ok: string) => { if (await run('updateLabor', { ops }, ok)) setDialog(null); };

  const { current, past } = plan ? splitWorkers(plan, today) : { current: [], past: [] };
  const todayLabor = plan ? laborForDate(plan, today, isOpen(today)) : null;
  const month: DateRange = { start: `${today.slice(0, 7)}-01`, endExclusive: addDays(today, 1) };
  const monthSen = plan ? laborForRange(plan, month, isOpen) : 0;

  return (
    <section id="labor" className="mb-5 min-w-0 rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold">请人工钱</h3>
          <p className="text-sm text-ink-2">你自己填。改工钱从你选的那天起算，之前的日子还按旧工钱，算过的「赚了多少」不会变。</p>
        </div>
        {plan && plan.workers.length > 0 && <Btn tone="dark" disabled={busy} onClick={() => setDialog({ kind: 'add' })}><Icon name="plus" size={18} />加一个人</Btn>}
      </div>
      {planQ.error && <p role="alert" className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-danger">读取失败：{planQ.error}</p>}
      {!plan ? <p className="py-6 text-center text-ink-2">正在载入…</p> : plan.workers.length === 0 ? (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-line px-4 py-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-subtle"><Icon name="users" size={24} /></span>
          <p className="min-w-[200px] flex-1 text-[15px]">还没填请人的工钱。填了以后，「今天」页的「赚了多少」会扣掉工钱，和租金电费一样单独一行。</p>
          <Btn tone="dark" onClick={() => setDialog({ kind: 'add' })}><Icon name="plus" size={18} />填工钱</Btn>
        </div>
      ) : (
        <>
          {current.length === 0 && <p className="rounded-xl bg-subtle px-4 py-3 text-[14px] text-ink-2">现在没有请人。按「加一个人」再填。</p>}
          <ul className="divide-y divide-line">
            {current.map((w) => <WorkerRow key={w.id} w={w} today={today} busy={busy} onOpen={(kind) => setDialog({ kind, w } as DialogState)} />)}
          </ul>
          {todayLabor && (
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-subtle px-4 py-3 text-[14px] tabular-nums">
              <span>今天工钱 <b>{formatRM(todayLabor.totalSen)}</b>{todayLabor.lines.some((l) => l.kind === 'daily' && l.closed) ? <span className="text-ink-2">（按天的开门做生意后才算）</span> : null}</span>
              <span>{Number(today.slice(5, 7))} 月到今天 <b>{formatRM(monthSen)}</b></span>
            </p>
          )}
          {past.length > 0 && (
            <details className="mt-3 rounded-xl border border-line px-4 py-2">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[14px] font-semibold"><Icon name="chevron-right" size={16} />以前请的人（{past.length}）</summary>
              <ul className="pb-2 text-[14px]">
                {past.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2">
                    <b>{w.name}</b><span className="text-ink-2">{md(w.from)}–{md(w.to!)}</span><span className="text-ink-2">{w.rates.map((r) => payText(r)).join(' → ')}</span>
                    <button type="button" disabled={busy} onClick={() => setDialog({ kind: 'more', w })} className="ml-auto h-10 rounded-lg border border-line px-3 text-[13px] font-semibold">改</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <p className="mt-3 text-[13px] text-ink-2">按天：开门做生意的日子才算，那天没来就点「没来」。按月：像租金一样每天摊，休息日也算，请假不扣（要扣就改成按天）。账目里已经记的工资付款，这里有人的日子不会再扣一次。</p>

      {dialog?.kind === 'add' && <PayDialog mode="add" today={today} firstDay={firstDayQ.data ?? null} busy={busy} onClose={() => setDialog(null)}
        onSave={(v) => void save([{ op: 'add', name: v.name, from: v.from, kind: v.kind, amountSen: v.amountSen }], `已加上${v.name}，${payText(v)}`)} />}
      {dialog?.kind === 'rate' && <PayDialog mode="rate" w={dialog.w} today={today} firstDay={null} busy={busy} onClose={() => setDialog(null)}
        onSave={(v) => void save([{ op: 'rate', workerId: dialog.w.id, from: v.from, kind: v.kind, amountSen: v.amountSen }], `${dialog.w.name} ${md(v.from)} 起${payText(v)}`)} />}
      {dialog?.kind === 'absent' && <AbsentDialog w={dialog.w} today={today} busy={busy} onClose={() => setDialog(null)}
        onSave={(date, absent) => void save([{ op: 'absent', workerId: dialog.w.id, date, absent }], absent ? `${dialog.w.name} ${md(date)} 没来，这天不算工钱` : `${dialog.w.name} ${md(date)} 改回有来`)} />}
      {dialog?.kind === 'end' && <EndDialog w={dialog.w} today={today} busy={busy} onClose={() => setDialog(null)}
        onSave={(lastDay, next) => void save([{ op: 'end', workerId: dialog.w.id, lastDay }, ...(next ? [{ op: 'add', name: next.name, from: dayAfter(lastDay), kind: next.kind, amountSen: next.amountSen }] : [])],
          next ? `${dialog.w.name}做到 ${md(lastDay)}，${next.name} ${md(dayAfter(lastDay))} 起接手` : `${dialog.w.name}做到 ${md(lastDay)}`)} />}
      {dialog?.kind === 'more' && <MoreDialog w={dialog.w} busy={busy} onClose={() => setDialog(null)}
        onRename={(name) => void save([{ op: 'rename', workerId: dialog.w.id, name }], '名字已改')}
        onUndoEnd={() => void save([{ op: 'end', workerId: dialog.w.id, lastDay: null }], `${dialog.w.name}改回还在做`)}
        onRemove={() => void save([{ op: 'remove', workerId: dialog.w.id }], `已删掉${dialog.w.name}`)} />}
      <Toast toast={toast} onClose={clearToast} />
    </section>
  );
}

function WorkerRow({ w, today, busy, onOpen }: { w: LaborWorker; today: string; busy: boolean; onOpen: (k: 'rate' | 'absent' | 'end' | 'more') => void }) {
  const r = rateOn(w, today) ?? w.rates[0];
  const next = nextRate(w, today);
  const notYet = w.from > today;
  const absentToday = w.absences.includes(today);
  const monthAbs = w.absences.filter((d) => d.slice(0, 7) === today.slice(0, 7));
  return (
    <li className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-3 py-4 sm:grid-cols-[44px_minmax(0,1fr)_auto]">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ok-bg text-ok"><Icon name="users" size={22} /></span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <b className="text-[16px]">{w.name}</b>
          <span className="text-[22px] font-black tabular-nums">{formatRM(r.amountSen)}</span><span className="text-[13px] text-ink-2">/ {r.kind === 'daily' ? '天' : '月'}</span>
          {notYet && <span className="rounded-full bg-subtle px-2 py-0.5 text-[12px] font-bold">{md(w.from)} 起</span>}
          {absentToday && <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[12px] font-bold text-warn">今天没来</span>}
          {w.to && <span className="rounded-full bg-subtle px-2 py-0.5 text-[12px] font-bold">做到 {md(w.to)}</span>}
        </div>
        <p className="mt-0.5 text-[13px] text-ink-2">{md(w.from)} 开始做 · {PAY_KIND_ZH[r.kind]}{r.kind === 'daily' ? '，开门的日子才算' : '，每天摊'}{w.rates.length > 1 && !next ? ` · ${md(r.from)} 起是这个数` : ''}</p>
        {next && <p className="mt-0.5 text-[13px] font-semibold text-ok">{md(next.from)} 起改成{payText(next)}</p>}
        {monthAbs.length > 0 && <p className="mt-0.5 text-[13px] text-ink-2">这个月没来 {monthAbs.length} 天：{monthAbs.map(md).join('、')}</p>}
      </div>
      <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-3 sm:self-center sm:justify-end">
        <button type="button" disabled={busy} onClick={() => onOpen('rate')} className="h-11 rounded-xl border border-line bg-card px-4 font-bold disabled:opacity-50">改工钱</button>
        <button type="button" disabled={busy || notYet} onClick={() => onOpen('absent')} className="h-11 rounded-xl border border-line bg-card px-4 font-bold disabled:opacity-50">没来</button>
        <button type="button" disabled={busy} onClick={() => onOpen('end')} className="h-11 rounded-xl border border-line bg-card px-4 font-bold disabled:opacity-50">{w.to ? '改最后一天' : '不做了 / 换人'}</button>
        <button type="button" disabled={busy} onClick={() => onOpen('more')} aria-label={`更多：${w.name}`} className="h-11 rounded-xl border border-line bg-card px-3 font-bold disabled:opacity-50">⋯</button>
      </div>
    </li>
  );
}

type PayValue = { name: string; kind: PayKind; amountSen: number; from: string };

function amountOf(text: string): number | null {
  return /^\d{1,5}(\.\d{1,2})?$/.test(text.trim()) ? Math.round(Number(text) * 100) : null;
}

function KindPicker({ kind, onChange }: { kind: PayKind; onChange: (k: PayKind) => void }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="怎么算">
      {(['daily', 'monthly'] as const).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => onChange(k)}
          className={`min-h-14 rounded-xl border-2 px-3 text-left ${kind === k ? 'border-ok bg-ok-bg/60' : 'border-line bg-card'}`}>
          <b className="block">{k === 'daily' ? '按天' : '按月'}</b><span className="text-[12px] text-ink-2">{k === 'daily' ? '开门的日子才算，没来不算' : '每天摊，请假不扣'}</span>
        </button>
      ))}
    </div>
  );
}

function PayDialog({ mode, w, today, firstDay, busy, onClose, onSave }: { mode: 'add' | 'rate'; w?: LaborWorker; today: string; firstDay: string | null; busy: boolean; onClose: () => void; onSave: (v: PayValue) => void }) {
  const cur = w ? rateOn(w, today) ?? w.rates[0] : null;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PayKind>(cur?.kind ?? 'daily');
  const [text, setText] = useState(cur ? (cur.amountSen / 100).toString() : '70');
  const [from, setFrom] = useState(mode === 'add' ? (firstDay ?? today) : w && w.from > today ? w.from : today);
  const amountSen = amountOf(text);
  const max = kind === 'daily' ? 100_000 : 2_000_000;
  const ok = amountSen !== null && amountSen > 0 && amountSen <= max && /^\d{4}-\d{2}-\d{2}$/.test(from) && (mode === 'rate' || name.trim().length > 0) && (!w || from >= w.from);
  return (
    <Dialog title={mode === 'add' ? '加一个人' : `改${w!.name}的工钱`} sub={mode === 'add' ? '一开始就请了的话，开始日期选开档那天。' : '从你选的那天起用新工钱；之前的日子还按旧工钱算。'} onClose={onClose}
      footer={<><Btn onClick={onClose}>取消</Btn><Btn tone="dark" disabled={!ok || busy} onClick={() => ok && onSave({ name: name.trim() || w?.name || '', kind, amountSen: amountSen!, from })}>保存</Btn></>}>
      {mode === 'add' && <Field label="叫什么（自己认得就好）"><input autoFocus value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="例如：阿明、帮手" className={inputCls} /></Field>}
      <KindPicker kind={kind} onChange={setKind} />
      <Field label={kind === 'daily' ? '每天多少钱（RM）' : '每月多少钱（RM）'} hint={amountSen !== null && amountSen > max ? `最多 RM${max / 100}` : undefined}>
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className={inputCls} />
      </Field>
      <Field label={mode === 'add' ? '从哪天开始做' : '从哪天起用新工钱'} hint={mode === 'add' ? (firstDay ? `开档那天是 ${md(firstDay)}。` : undefined) : cur ? `现在是${payText(cur)}。${from > today ? `${md(from)} 以前还按这个算。` : from < today ? `${md(from)} 到今天都会改用新工钱。` : '今天起用新工钱。'}` : undefined}>
        <input type="date" value={from} min={w?.from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
      </Field>
    </Dialog>
  );
}

function AbsentDialog({ w, today, busy, onClose, onSave }: { w: LaborWorker; today: string; busy: boolean; onClose: () => void; onSave: (date: string, absent: boolean) => void }) {
  const [date, setDate] = useState(today);
  const already = w.absences.includes(date);
  const inRange = date >= w.from && (w.to === null || date <= w.to);
  const r = rateOn(w, date);
  return (
    <Dialog title={`${w.name}哪天没来`} sub={r?.kind === 'monthly' ? '按月的请假不扣钱，只是记下来。要扣请把工钱改成按天。' : '记了没来的那天不算工钱。'} onClose={onClose}
      footer={<><Btn onClick={onClose}>关闭</Btn><Btn tone="dark" disabled={!inRange || busy} onClick={() => onSave(date, !already)}>{already ? '改回有来' : '这天没来'}</Btn></>}>
      <Field label="日期" hint={!inRange ? `${w.name}这天不在这里做` : already ? '这天已经记了没来。' : undefined}>
        <input type="date" value={date} min={w.from} max={w.to ?? undefined} onChange={(e) => setDate(e.target.value)} className={inputCls} />
      </Field>
      {w.absences.length > 0 && (
        <div className="text-[14px]">
          <b className="mb-1 block text-[13px]">记过没来的日子</b>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {[...w.absences].reverse().slice(0, 20).map((d) => (
              <li key={d} className="flex items-center gap-2 px-3 py-2"><span className="flex-1">{md(d)}</span>
                <button type="button" disabled={busy} onClick={() => onSave(d, false)} className="h-10 rounded-lg border border-line px-3 text-[13px] font-semibold">撤销</button></li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

function EndDialog({ w, today, busy, onClose, onSave }: { w: LaborWorker; today: string; busy: boolean; onClose: () => void; onSave: (lastDay: string, next: { name: string; kind: PayKind; amountSen: number } | null) => void }) {
  const cur = rateOn(w, today) ?? w.rates[w.rates.length - 1];
  const [lastDay, setLastDay] = useState(w.to ?? (w.from > today ? w.from : today));
  const [replace, setReplace] = useState(!w.to);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PayKind>(cur.kind);
  const [text, setText] = useState((cur.amountSen / 100).toString());
  const amountSen = amountOf(text);
  const okDay = /^\d{4}-\d{2}-\d{2}$/.test(lastDay) && lastDay >= w.from;
  const okNext = !replace || (name.trim().length > 0 && amountSen !== null && amountSen > 0 && amountSen <= (kind === 'daily' ? 100_000 : 2_000_000));
  return (
    <Dialog title={`${w.name}做到哪天`} sub="最后一天之后不再算工钱。之前的工钱照旧。" onClose={onClose}
      footer={<><Btn onClick={onClose}>取消</Btn><Btn tone="dark" disabled={!okDay || !okNext || busy} onClick={() => onSave(lastDay, replace ? { name: name.trim(), kind, amountSen: amountSen! } : null)}>保存</Btn></>}>
      <Field label="最后一天（这天还算）"><input type="date" value={lastDay} min={w.from} onChange={(e) => setLastDay(e.target.value)} className={inputCls} /></Field>
      <label className="mb-4 flex min-h-12 items-center gap-3 rounded-xl border border-line px-3 text-[15px] font-semibold">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="h-5 w-5" />有人接手（换人）{okDay && replace ? <span className="font-normal text-ink-2">· {md(dayAfter(lastDay))} 起</span> : null}
      </label>
      {replace && (
        <>
          <Field label="新的人叫什么"><input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="例如：阿芳" className={inputCls} /></Field>
          <KindPicker kind={kind} onChange={setKind} />
          <Field label={kind === 'daily' ? '每天多少钱（RM）' : '每月多少钱（RM）'}><input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className={inputCls} /></Field>
        </>
      )}
    </Dialog>
  );
}

function MoreDialog({ w, busy, onClose, onRename, onUndoEnd, onRemove }: { w: LaborWorker; busy: boolean; onClose: () => void; onRename: (name: string) => void; onUndoEnd: () => void; onRemove: () => void }) {
  const [name, setName] = useState(w.name);
  const [confirm, setConfirm] = useState(false);
  return (
    <Dialog title={`${w.name}：改名或删掉`} onClose={onClose}
      footer={<><Btn onClick={onClose}>关闭</Btn><Btn tone="dark" disabled={busy || !name.trim() || name.trim() === w.name} onClick={() => onRename(name)}>保存名字</Btn></>}>
      <Field label="名字"><input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
      <p className="mb-2 text-[13px] text-ink-2">工钱记录：{w.rates.map((r) => `${md(r.from)} 起${payText(r)}`).join('；')}{w.to ? `；做到 ${md(w.to)}` : ''}</p>
      {w.to && <Btn disabled={busy} onClick={onUndoEnd} className="mb-3 w-full">改回还在做</Btn>}
      <div className="rounded-xl border border-danger/30 bg-danger-bg/40 p-3">
        <p className="text-[13px]">填错了才删。删掉后这个人以前每天的工钱也一起不算了。换人请用「不做了 / 换人」。</p>
        {!confirm ? <Btn tone="danger" small disabled={busy} onClick={() => setConfirm(true)} className="mt-2">删掉这个人</Btn>
          : <Btn tone="danger" small disabled={busy} onClick={onRemove} className="mt-2">确定删掉{w.name}</Btn>}
      </div>
    </Dialog>
  );
}
