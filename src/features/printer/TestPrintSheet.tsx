/**
 * 试打印（2026-11-16）：打印机到货后，不下真单把打印机试透。从设备页（全店总开关关着也有）和打印机面板打开。
 * ① 测试条 + 4 个问题（答错了直接给办法）② 9 张样单 ③ 连打 5 张 ④ 断开再连；试打清单 7 项都过了再去设置里打开。
 * 样单和真单同一套排版、同一个打印队列，但不建订单、不占牌号、不记打印次数（domain/sampleSlips、printerManager.enqueueTest）。
 * 开店中（总开关打开）也能打测试条和单张样单；连打和断开演练会挡住真单，只在总开关关着时能用。
 */
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../app/session';
import { navigate } from '../../app/router';
import { useLang, useT } from '../../app/i18n';
import { useMenu } from '../../data/menu';
import { MENU_V1, MenuVersion } from '../../domain/menu';
import { buildSampleSlip, SAMPLE_SLIPS, sampleDef, SampleSlipId } from '../../domain/sampleSlips';
import { layoutRunnerSlip, PaperWidth } from '../../data/printer/escpos';
import { printer, slipPrintingOn, usePrinter } from '../../data/printer/printer';
import { SlipJob, testPageLines, TestPrintResult } from '../../data/printer/printerManager';
import { emptyTrial, loadTrial, saveTrial, TRIAL_CHECKS, TrialCheckId, trialChecks, TrialRecord, trialPassedCount, withSample } from '../../data/printer/trial';
import { Choice, linkErrorText } from './PrinterPanel';
import { PrinterGuideDialog } from './PrinterGuide';
import { PaperPreview } from './PaperPreview';

type Tr = ReturnType<typeof useT>;
type Text = { zh: string; en: string };

/** 连打的 5 张：短的、黑底的、折行的、最长的、带说明框的。 */
const RUSH: SampleSlipId[] = ['dine_in', 'takeaway', 'many', 'big', 'shared'];
/** 断开演练排的那张。 */
const DRILL_SAMPLE: SampleSlipId = 'dine_in';
/** 断开演练等这么久还没连回，给「连接打印机」按钮。 */
const DRILL_MANUAL_AFTER_MS = 60_000;

const sampleOfKey = (key: string) => key.split(':')[1] as SampleSlipId;
const sec = (ms: number) => (ms / 1000).toFixed(1);

type Drill = { phase: 'wait_off' } | { phase: 'wait_back'; key: string; startedAt: number; manual: boolean };

export function TestPrintSheet({ onClose }: { onClose: () => void }) {
  const s = usePrinter();
  const tr = useT();
  const lang = useLang();
  const txt = (t: Text) => (lang === 'en' ? t.en : t.zh);
  const { config, member } = useSession();
  const menu = useMenu(config?.activeMenuVersion) ?? MENU_V1;
  const timeZone = config?.timeZone ?? 'Asia/Kuala_Lumpur';
  const storeOn = slipPrintingOn(config);
  const isOwner = member?.role === 'owner';

  const [view, setView] = useState<'main' | 'strip'>('main');
  const [guide, setGuide] = useState(false);
  const [selected, setSelected] = useState<SampleSlipId>('dine_in');
  /** 这次打开排的测试单。 */
  const [mine, setMine] = useState<string[]>([]);
  const [rushKeys, setRushKeys] = useState<string[] | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [strip, setStrip] = useState<'printing' | TestPrintResult | null>(null);
  const [trial, setTrial] = useState<TrialRecord>(() => loadTrial(s.settings.deviceId));
  const [, setTick] = useState(0);

  const update = (fn: (r: TrialRecord) => TrialRecord) => setTrial((prev) => {
    const next = fn(prev);
    if (next !== prev) saveTrial(next);
    return next;
  });

  // 换了打印机：从头试。
  useEffect(() => {
    setTrial((prev) => (prev.printerId === s.settings.deviceId ? prev : loadTrial(s.settings.deviceId)));
  }, [s.settings.deviceId]);

  // 打出来的样单记进清单。
  useEffect(() => {
    const done = s.jobs.filter((j) => j.status === 'done' && mine.includes(j.key)).map((j) => sampleOfKey(j.key));
    if (done.length) update((r) => done.reduce(withSample, r));
  }, [s.jobs, mine]);

  const linked = s.link === 'ready' || s.link === 'lost';
  const canPrint = s.supported && linked;
  const myJobs = s.jobs.filter((j) => mine.includes(j.key));
  const busy = (id: SampleSlipId) => myJobs.some((j) => sampleOfKey(j.key) === id && (j.status === 'waiting' || j.status === 'printing'));

  function enqueue(id: SampleSlipId): string {
    const key = printer.enqueueTest(id, buildSampleSlip(menu, id, { nowMs: Date.now(), timeZone }), `样单 · ${sampleDef(id).title.zh}`);
    setMine((m) => [...m, key]);
    return key;
  }

  async function printStrip() {
    setStrip('printing');
    setStrip(await printer.testPrint());
  }

  // ---- 连打 ----
  const rushJobs = rushKeys?.map((k) => s.jobs.find((j) => j.key === k)) ?? null;
  const rushAllDone = rushJobs !== null && rushJobs.every((j) => j?.status === 'done');
  const rushFailed = rushJobs !== null && rushJobs.some((j) => !j || j.status === 'failed');
  const rushTimes = rushAllDone ? jobDurations(rushJobs as SlipJob[]) : null;
  useEffect(() => {
    if (!rushTimes) return;
    const totalMs = rushTimes.total;
    const maxMs = Math.max(...rushTimes.each.values());
    update((r) => (r.rush && r.rush.totalMs === totalMs && r.rush.maxMs === maxMs ? r : { ...r, rush: { totalMs, maxMs } }));
  }, [rushAllDone]);

  // ---- 断开再连 ----
  const drillJob = drill?.phase === 'wait_back' ? s.jobs.find((j) => j.key === drill.key) : undefined;
  const drillWaitMs = drill?.phase === 'wait_back' ? Date.now() - drill.startedAt : 0;
  useEffect(() => {
    if (drill?.phase !== 'wait_back' || drillJob?.status !== 'done') return;
    update((r) => ({ ...r, drill: { ms: (drillJob.doneAtMs ?? Date.now()) - drillJob.createdAtMs, manual: drill.manual } }));
  }, [drillJob?.status]);
  const drillOver = drillJob?.status === 'done' || drillJob?.status === 'failed';
  // 等打印机连回时每秒刷新一次，超过一分钟给手动连接的按钮。
  const waitingBack = drill?.phase === 'wait_back' && !drillOver;
  useEffect(() => {
    if (!waitingBack) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waitingBack]);

  const checks = trialChecks(trial);
  const passed = trialPassedCount(trial);
  // 断开演练等连回时，「连不上」是故意的，不报错。
  const err = waitingBack ? null : linkErrorText(s.error, tr);

  return (
    <div role="dialog" aria-modal="true" aria-label={tr('试打印', 'Test printing')} className="fixed inset-0 z-[55] flex flex-col bg-canvas" onKeyDown={(e) => e.key === 'Escape' && (view === 'strip' ? setView('main') : onClose())}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-card px-4 py-3">
        <button type="button" autoFocus onClick={view === 'strip' ? () => setView('main') : onClose} className="h-12 rounded-xl border border-line px-3 font-semibold text-ink-2">
          {view === 'strip' ? tr('← 试打印', '← Test printing') : tr('← 返回', '← Back')}
        </button>
        <h2 className="mr-auto text-xl font-bold">{view === 'strip' ? tr('① 测试条', '① Test strip') : tr('试打印', 'Test printing')}</h2>
        <LinkChip tr={tr} />
        <Choice label={tr('纸宽', 'Paper width')} value={s.settings.width} onChange={(w) => printer.setWidth(w)} options={[[58, '58mm'], [80, '80mm']]} />
        <Choice label={tr('切纸', 'Cutting')} value={s.settings.cut} onChange={(c) => printer.setCut(c)} options={[['tear', tr('手撕', 'Tear')], ['auto', tr('自动切刀', 'Auto cutter')]]} />
        <button type="button" onClick={() => setGuide(true)} className="h-12 rounded-xl px-2 font-semibold text-ink-2 underline underline-offset-4">{tr('连接说明', 'How to connect')}</button>
      </header>
      {guide && <PrinterGuideDialog onClose={() => setGuide(false)} />}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-8">
        <div className="mx-auto max-w-6xl">
          <p className="flex items-start gap-2.5 rounded-xl border border-dashed border-warn/50 bg-warn-bg px-3.5 py-3 text-sm text-warn">
            <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-warn text-xs font-black text-white">{tr('试', 'T')}</span>
            <span><b>{tr('这里打的都是测试单。', 'Everything printed here is a test slip.')}</b>{tr('不进订单、不算营业额、不占牌号，后厨屏看不到。纸上印着「测试 · 不用做」，牌号用 81–89。', ' No orders, no sales, no tokens used, nothing on the kitchen screen. The paper says “测试 · 不用做” (test, don’t make) and uses tokens 81–89.')}</span>
          </p>
          {!s.supported && <p className="mt-3 rounded-xl bg-warn-bg p-3 text-warn">{linkErrorText('UNSUPPORTED', tr)} {tr('下面的样单照样能在屏幕上看。', 'You can still preview the slips below.')}</p>}
          {err && <p role="alert" className="mt-3 rounded-xl bg-danger-bg p-3 text-sm text-danger">{err}</p>}

          {view === 'strip' ? (
            <StripView tr={tr} strip={strip} canPrint={canPrint} onPrint={() => void printStrip()} trial={trial} update={update} />
          ) : (
            <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
              <div className="space-y-2.5">
                <Item no={1} done={checks.chinese && checks.width && checks.tail && checks.received}
                  title={tr('① 测试条', '① Test strip')}
                  sub={tr(`中文、纸宽、切纸、距离 · ${['chinese', 'width', 'tail', 'received'].filter((k) => checks[k as TrialCheckId]).length} / 4 通过`, `Chinese, width, cutting, range · ${['chinese', 'width', 'tail', 'received'].filter((k) => checks[k as TrialCheckId]).length} / 4 passed`)}
                  action={<button type="button" onClick={() => setView('strip')} className="h-12 rounded-lg border border-line px-3 font-semibold">{trial.chinese ? tr('再看', 'Open') : tr('打测试条', 'Print strip')}</button>} />

                <Item no={2} done={checks.samples} open
                  title={tr(`② 样单 ${SAMPLE_SLIPS.length} 张`, `② ${SAMPLE_SLIPS.length} sample slips`)}
                  sub={tr(`每种送餐单打一张，看排版 · 已打 ${trial.samples.length} / ${SAMPLE_SLIPS.length}`, `One of each kind, check the layout · ${trial.samples.length} / ${SAMPLE_SLIPS.length} printed`)}>
                  <ul className="mt-2 border-t border-line">
                    {SAMPLE_SLIPS.map((d) => {
                      const state = busy(d.id) ? 'busy' : trial.samples.includes(d.id) ? 'done' : 'todo';
                      return (
                        <li key={d.id}>
                          <button type="button" aria-pressed={selected === d.id} onClick={() => setSelected(d.id)}
                            className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left ${selected === d.id ? 'bg-subtle' : ''}`}>
                            <b className="w-9 text-center text-lg tabular-nums">{d.token}</b>
                            <span className="min-w-0 flex-1"><span className="block font-semibold">{txt(d.title)}</span><span className="block text-xs text-ink-2">{txt(d.check)}</span></span>
                            <Tick state={state} tr={tr} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Item>

                <Item no={3} done={checks.rush} title={tr('③ 连打 5 张', '③ 5 in a row')}
                  sub={tr('像中午高峰：一张接一张，到出餐口数一数有没有少', 'Like the lunch rush: one after another, then count them at the pass')}
                  action={<button type="button" disabled={storeOn || !canPrint || (rushJobs !== null && !rushAllDone && !rushFailed)} onClick={() => setRushKeys(RUSH.map(enqueue))}
                    className="h-12 rounded-lg border border-line px-3 font-semibold disabled:text-control">{rushKeys ? tr('再来一次', 'Again') : tr('开始', 'Start')}</button>}>
                  {storeOn ? <Locked tr={tr} text={tr('全店已经打开送餐单打印：开店中连打 5 张会排在真单前面，送面的人会等。', 'Slip printing is on for the shop: 5 test slips would hold up real ones.')} /> : rushJobs && (
                    <div className="mt-2 border-t border-line">
                      {rushJobs.map((j, i) => (
                        <div key={rushKeys![i]} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
                          <b className="w-9 text-center text-lg tabular-nums">{sampleDef(RUSH[i]).token}</b>
                          <span className="flex-1 font-semibold">{txt(sampleDef(RUSH[i]).title)}</span>
                          <span className="text-sm text-ink-2 tabular-nums">{jobNote(j, rushTimes?.each.get(rushKeys![i]), s.link, tr)}</span>
                          <Tick state={!j || j.status === 'failed' ? 'failed' : j.status === 'done' ? 'done' : 'busy'} tr={tr} />
                        </div>
                      ))}
                      {rushFailed && <p className="mt-2 rounded-lg bg-danger-bg p-2.5 text-sm text-danger">{tr('有一张没打出来：看一下打印机的电和纸，按「再来一次」。', 'One did not print: check power and paper, then tap Again.')}</p>}
                      {rushTimes && (
                        <div className="mt-2">
                          <p className="rounded-lg bg-ok-bg p-2.5 text-sm font-semibold text-ok">{tr(`5 张都传过去了 · 一共 ${sec(rushTimes.total)} 秒，最慢一张 ${sec(Math.max(...rushTimes.each.values()))} 秒`, `All 5 sent · ${sec(rushTimes.total)} s in total, slowest ${sec(Math.max(...rushTimes.each.values()))} s`)}</p>
                          <Question q={tr('出餐口是不是 5 张，每张都完整？', 'Are there 5 slips at the pass, each complete?')} value={trial.rush?.whole === undefined ? undefined : trial.rush.whole ? 'ok' : 'bad'}
                            options={[['ok', tr('是，5 张都完整', 'Yes, all 5 complete')], ['bad', tr('少了 / 有一张缺一截', 'Missing / one is cut off')]]}
                            onPick={(v) => update((r) => (r.rush ? { ...r, rush: { ...r.rush, whole: v === 'ok' } } : r))}
                            fix={trial.rush?.whole === false ? <p>{tr('多半是蓝牙传得太快，打印机来不及。拍照发给开发，把传输调慢一点。', 'Probably Bluetooth is sending too fast for the printer. Send a photo to the developer to slow it down.')}</p> : null} />
                        </div>
                      )}
                    </div>
                  )}
                </Item>

                <Item no={4} done={checks.drill} title={tr('④ 断开再连', '④ Disconnect and reconnect')}
                  sub={tr('关掉打印机再开，看会不会自动补打', 'Turn the printer off and on: does it reprint by itself?')}
                  action={<button type="button" disabled={storeOn || s.link !== 'ready' || (drill !== null && !drillOver)} onClick={() => setDrill({ phase: 'wait_off' })}
                    className="h-12 rounded-lg border border-line px-3 font-semibold disabled:text-control">{drill ? tr('再来一次', 'Again') : tr('开始', 'Start')}</button>}>
                  {storeOn ? <Locked tr={tr} text={tr('全店已经打开送餐单打印：断开期间真单也会排着。', 'Slip printing is on for the shop: real slips would wait too.')} /> : drill && (
                    <ol className="mt-2 border-t border-line">
                      <DrillStep n={1} state={drill.phase === 'wait_back' || s.link !== 'ready' ? 'done' : 'now'}
                        title={tr('关掉打印机电源', 'Turn the printer off')}
                        sub={s.link !== 'ready' || drill.phase === 'wait_back' ? tr('平板发现断开了', 'The tablet sees it is off') : tr('关了 10 秒还没变：按一下打印机开关，确认真的关了', 'Still not changed after 10 s: press the power button to be sure it is off')} />
                      <DrillStep n={2} state={drill.phase === 'wait_back' ? 'done' : s.link !== 'ready' ? 'now' : 'todo'}
                        title={tr('按「打一张」', 'Tap “Print one”')}
                        sub={tr(`样单 ${sampleDef(DRILL_SAMPLE).token} 排着等，不会丢`, `Sample ${sampleDef(DRILL_SAMPLE).token} waits in line, not lost`)}
                        action={drill.phase === 'wait_off' && s.link !== 'ready' ? (
                          <button type="button" onClick={() => setDrill({ phase: 'wait_back', key: enqueue(DRILL_SAMPLE), startedAt: Date.now(), manual: false })} className="h-12 rounded-lg bg-ink px-3 font-bold text-white">{tr('打一张', 'Print one')}</button>
                        ) : undefined} />
                      <DrillStep n={3} state={drillJob?.status === 'done' ? 'done' : drill.phase === 'wait_back' ? 'now' : 'todo'}
                        title={tr('打开打印机', 'Turn the printer on')}
                        sub={drillJob?.status === 'failed' ? tr('没有自动补打。按「再来一次」重试，还是不行就联系开发。', 'It did not reprint. Tap Again; if it still fails, contact the developer.')
                          : tr(`不用点任何东西，平板 15 秒内会自己连回去${drill.phase === 'wait_back' && drillJob?.status !== 'done' ? ` · 已等 ${Math.round(drillWaitMs / 1000)} 秒` : ''}`, `No need to tap anything; the tablet reconnects within 15 s${drill.phase === 'wait_back' && drillJob?.status !== 'done' ? ` · waited ${Math.round(drillWaitMs / 1000)} s` : ''}`)}
                        action={waitingBack && drillWaitMs > DRILL_MANUAL_AFTER_MS && s.link !== 'connecting' ? (
                          <button type="button" onClick={() => { setDrill({ ...drill, manual: true }); void printer.connect(); }} className="h-12 rounded-lg bg-ok px-3 font-bold text-white">{tr('连接打印机', 'Connect printer')}</button>
                        ) : undefined} />
                      <DrillStep n={4} state={drillJob?.status === 'done' ? 'done' : 'todo'}
                        title={tr(`出餐口自动打出 ${sampleDef(DRILL_SAMPLE).token}`, `${sampleDef(DRILL_SAMPLE).token} prints at the pass by itself`)}
                        sub={drillJob?.status === 'done' ? tr(`连回来补打了 · 用了 ${sec(drillJob.doneAtMs! - drillJob.createdAtMs)} 秒${drill.phase === 'wait_back' && drill.manual ? ' · 中间手动连了一次' : ''}`, `Reprinted after reconnecting · ${sec(drillJob.doneAtMs! - drillJob.createdAtMs)} s${drill.phase === 'wait_back' && drill.manual ? ' · connected by hand once' : ''}`) : tr('连回来后自动补打', 'Reprints automatically after reconnecting')} />
                    </ol>
                  )}
                </Item>

                <Checklist tr={tr} trial={trial} checks={checks} passed={passed} width={s.settings.width} storeOn={storeOn} isOwner={isOwner}
                  onGoSettings={() => { onClose(); navigate('/owner/settings'); }} onReset={() => update(() => emptyTrial(s.settings.deviceId))} />
              </div>

              <SamplePane id={selected} tr={tr} txt={txt} menu={menu} timeZone={timeZone} width={s.settings.width} canPrint={canPrint} busy={busy(selected)}
                remaining={SAMPLE_SLIPS.filter((d) => !trial.samples.includes(d.id)).map((d) => d.id)}
                onPrint={(ids) => ids.forEach(enqueue)} onConnect={s.supported && !linked && s.link !== 'connecting' ? () => void printer.connect() : null} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 每张从排上（或上一张打完）到打完用了多久，和一共用了多久。 */
function jobDurations(jobs: SlipJob[]): { total: number; each: Map<string, number> } {
  const start = Math.min(...jobs.map((j) => j.createdAtMs));
  const each = new Map<string, number>();
  let prev = start;
  for (const j of [...jobs].sort((a, b) => (a.doneAtMs ?? 0) - (b.doneAtMs ?? 0))) {
    const done = j.doneAtMs ?? prev;
    each.set(j.key, done - Math.max(prev, j.createdAtMs));
    prev = done;
  }
  return { total: prev - start, each };
}

function jobNote(j: SlipJob | undefined, ms: number | undefined, link: string, tr: Tr): string {
  if (!j || j.status === 'failed') return tr('没打出来', 'Not printed');
  if (j.status === 'done') return ms !== undefined ? tr(`${sec(ms)} 秒`, `${sec(ms)} s`) : tr('打好了', 'Printed');
  if (j.status === 'printing') return tr('正在打…', 'Printing…');
  return link === 'ready' ? tr('排队中', 'Queued') : tr('等打印机', 'Waiting for printer');
}

function LinkChip({ tr }: { tr: Tr }) {
  const s = usePrinter();
  const waiting = s.jobs.filter((j) => j.status === 'waiting').length;
  const base = 'inline-flex min-h-12 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-semibold';
  if (s.link === 'ready') return <span className={`${base} bg-ok-bg text-ok`}><span className="h-2 w-2 rounded-full bg-current" />{tr('已连接', 'Connected')} · {s.settings.deviceName ?? tr('蓝牙打印机', 'Bluetooth printer')}</span>;
  if (s.link === 'lost') return <span className={`${base} bg-danger-bg text-danger`}><span className="h-2 w-2 rounded-full bg-current" />{waiting ? tr(`打印机断开 · ${waiting} 张待打`, `Printer off · ${waiting} waiting`) : tr('打印机断开', 'Printer off')}</span>;
  if (s.link === 'connecting') return <span className={`${base} bg-subtle text-ink-2`}>{tr('正在连接…', 'Connecting…')}</span>;
  if (!s.supported) return null;
  return <button type="button" onClick={() => void printer.connect()} className="h-12 rounded-xl bg-ok px-4 font-bold text-white">{tr('连接打印机', 'Connect printer')}</button>;
}

function Item({ no, done, open, title, sub, action, children }: { no: number; done: boolean; open?: boolean; title: string; sub: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className={`rounded-2xl border bg-card px-3.5 py-3 ${open ? 'border-ink shadow-[0_0_0_1px_var(--color-ink)]' : 'border-line'}`}>
      <div className="flex items-center gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-bold ${done ? 'bg-ok text-white' : 'bg-subtle'}`}>{done ? '✓' : no}</span>
        <div className="min-w-0 flex-1"><h3 className="font-bold">{title}</h3><p className="text-[13px] text-ink-2">{sub}</p></div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Tick({ state, tr }: { state: 'todo' | 'busy' | 'done' | 'failed'; tr: Tr }) {
  if (state === 'done') return <span aria-label={tr('打好了', 'Printed')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok text-[13px] font-black text-white">✓</span>;
  if (state === 'busy') return <span aria-label={tr('正在打', 'Printing')} className="h-6 w-6 shrink-0 animate-spin rounded-full border-[3px] border-ok-bg border-t-ok" />;
  if (state === 'failed') return <span aria-label={tr('没打出来', 'Not printed')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger-bg text-[13px] font-black text-danger">✕</span>;
  return <span aria-label={tr('还没打', 'Not yet')} className="h-6 w-6 shrink-0 rounded-full border-2 border-line" />;
}

function Locked({ text, tr }: { text: string; tr: Tr }) {
  return <p className="mt-2 rounded-lg bg-subtle p-2.5 text-sm text-ink-2"><b className="text-ink">{tr('开店中不能用。', 'Not while open. ')}</b>{text}</p>;
}

function DrillStep({ n, state, title, sub, action }: { n: number; state: 'todo' | 'now' | 'done'; title: string; sub: string; action?: ReactNode }) {
  return (
    <li className={`flex items-center gap-3 border-b border-line px-1 py-2.5 last:border-0 ${state === 'now' ? 'rounded-lg bg-subtle' : ''}`}>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-bold ${state === 'done' ? 'bg-ok text-white' : state === 'now' ? 'bg-ink text-white' : 'bg-subtle'}`}>{state === 'done' ? '✓' : n}</span>
      <div className="min-w-0 flex-1"><b className="block">{title}</b><span className="block text-[13px] text-ink-2">{sub}</span></div>
      {action}
    </li>
  );
}

function Question<T extends string>({ q, value, options, onPick, fix, disabled }: { q: string; value: T | undefined; options: [T, string][]; onPick: (v: T) => void; fix?: ReactNode; disabled?: boolean }) {
  return (
    <div className="border-b border-line py-3 last:border-0">
      <b className="mb-2 block">{q}</b>
      <div role="radiogroup" aria-label={q} className="flex flex-wrap gap-2">
        {options.map(([v, text], i) => {
          const on = value === v;
          const bad = on && i > 0;
          return (
            <button key={v} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onPick(v)}
              className={`h-12 rounded-xl border-2 px-4 font-semibold disabled:opacity-50 ${on ? (bad ? 'border-danger bg-danger-bg text-danger' : 'border-ok bg-ok-bg text-ok') : 'border-line bg-card'}`}>{text}</button>
          );
        })}
      </div>
      {fix && <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl bg-danger-bg p-3 text-sm text-danger">{fix}</div>}
    </div>
  );
}

function StripView({ tr, strip, canPrint, onPrint, trial, update }: {
  tr: Tr; strip: 'printing' | TestPrintResult | null; canPrint: boolean; onPrint: () => void; trial: TrialRecord; update: (fn: (r: TrialRecord) => TrialRecord) => void;
}) {
  const s = usePrinter();
  const lines = useMemo(() => testPageLines(s.settings, Date.now()), [s.settings]);
  const answered = trial.chinese || trial.width || trial.tail || trial.received;
  const ask = (strip !== null && strip !== 'printing' && strip.ok) || Boolean(answered);
  /** 改了设置再打一张：那一题重新答。 */
  const fixAndReprint = (apply: () => void, clear: 'width' | 'tail') => {
    apply();
    update((r) => ({ ...r, [clear]: undefined }));
    onPrint();
  };
  const fixBtn = (label: string, run: () => void) => <button type="button" onClick={run} className="h-11 rounded-lg bg-ok px-3 font-bold text-white">{label}</button>;
  const w = s.settings.width;
  const widthFix = trial.width === 'two_lines'
    ? (w === 80 ? <><p className="min-w-[200px] flex-1"><b>{tr('纸宽选错了。', 'Wrong paper width.')}</b>{tr('纸卷是 58mm，现在选的是 80mm。', ' The roll is 58mm but 80mm is selected.')}</p>{fixBtn(tr('改成 58mm，再打一张', 'Use 58mm and print again'), () => fixAndReprint(() => printer.setWidth(58), 'width'))}</>
      : <p>{tr('已经是 58mm 还断成两行：打印机比 58mm 还窄，拍照发给开发。', 'Already 58mm and still broken: the printer is narrower than 58mm. Send a photo to the developer.')}</p>)
    : trial.width === 'two_thirds'
      ? (w === 58 ? <><p className="min-w-[200px] flex-1"><b>{tr('纸宽选错了。', 'Wrong paper width.')}</b>{tr('这是 80mm 的打印机，现在选的是 58mm。', ' This is an 80mm printer but 58mm is selected.')}</p>{fixBtn(tr('改成 80mm，再打一张', 'Use 80mm and print again'), () => fixAndReprint(() => printer.setWidth(80), 'width'))}</>
        : <p>{tr('已经是 80mm 还只到三分之二：拍照发给开发。', 'Already 80mm and still two-thirds: send a photo to the developer.')}</p>)
      : null;
  const tailFix = trial.tail === 'junk'
    ? (s.settings.cut === 'auto' ? <><p className="min-w-[200px] flex-1">{tr('打印机没有切刀，却选了「自动切刀」。', 'The printer has no cutter but Auto cutter is selected.')}</p>{fixBtn(tr('改成手撕，再打一张', 'Use Tear and print again'), () => fixAndReprint(() => printer.setCut('tear'), 'tail'))}</>
      : <p>{tr('选的是手撕还多出怪字母：拍照发给开发。', 'Tear is selected and there is still junk: send a photo to the developer.')}</p>)
    : null;

  return (
    <div className="mt-3 grid items-start gap-5 rounded-2xl border border-line bg-card p-4 md:grid-cols-[auto_minmax(0,1fr)]">
      <div className="flex justify-center overflow-x-auto rounded-xl bg-subtle p-5">
        <PaperPreview lines={lines} width={w} label={tr('测试条预览', 'Test strip preview')} />
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={!canPrint || strip === 'printing'} onClick={onPrint} className="h-14 rounded-xl bg-ok px-5 font-bold text-white disabled:bg-control">
            {strip === 'printing' ? tr('打印中…', 'Printing…') : strip ? tr('再打一张', 'Print again') : tr('打测试条', 'Print test strip')}
          </button>
          {strip && strip !== 'printing' && (strip.ok
            ? <span className="font-semibold text-ok">{tr(`✓ 打出来了 · 用了 ${sec(strip.ms)} 秒`, `✓ Sent · ${sec(strip.ms)} s`)}</span>
            : <span className="font-semibold text-danger">{linkErrorText(strip.code, tr)}</span>)}
          {!canPrint && <span className="text-sm text-ink-2">{tr('先在页头连接打印机', 'Connect the printer at the top first')}</span>}
        </div>
        <p className="mt-2 text-[13px] text-ink-2">{tr('打完到出餐口拿纸，和左边比一比，回答下面 4 个问题。', 'Fetch the strip at the pass, compare it with the preview, and answer the 4 questions.')}</p>
        <div className="mt-2">
          <Question disabled={!ask} q={tr('1. 纸上的中文清楚吗？', '1. Is the Chinese text clear?')} value={trial.chinese}
            options={[['ok', tr('清楚', 'Clear')], ['bad', tr('变成问号 / 乱码', 'Question marks / garbage')]]} onPick={(v) => update((r) => ({ ...r, chinese: v }))}
            fix={trial.chinese === 'bad' ? <p>{tr('打印机没有中文字库：先别打开送餐单打印，联系开发改成图片打印。这一项不过，后面都不用试。', 'The printer has no Chinese font: keep slip printing off and ask the developer for image printing. Nothing else matters until this passes.')}</p> : null} />
          <Question disabled={!ask} q={tr('2. 上下两条虚线是什么样？', '2. What do the two dashed lines look like?')} value={trial.width}
            options={[['ok', tr('正好一整行', 'Exactly one full line')], ['two_lines', tr('断成两行', 'Broken onto two lines')], ['two_thirds', tr('只到纸的三分之二', 'Only two-thirds across')]]}
            onPick={(v) => update((r) => ({ ...r, width: v }))} fix={widthFix} />
          <Question disabled={!ask} q={tr('3. 纸的最后一截？', '3. The end of the paper?')} value={trial.tail}
            options={[['ok', s.settings.cut === 'auto' ? tr('自动切开了', 'Cut automatically') : tr('好撕，没多东西', 'Easy to tear, nothing extra')], ['junk', tr('多出几个怪字母', 'A few odd letters')]]}
            onPick={(v) => update((r) => ({ ...r, tail: v }))} fix={tailFix} />
          <Question disabled={!ask} q={tr('4. 在出餐口拿到了吗？', '4. Did it come out at the pass?')} value={trial.received}
            options={[['ok', tr('拿到了', 'Yes')], ['no', tr('没看到', 'No')]]} onPick={(v) => update((r) => ({ ...r, received: v }))}
            fix={trial.received === 'no' ? <p>{tr('看纸卷装反没有（热敏面朝外）、有没有纸；把打印机拿近一点再打一张。还是不行，多半是蓝牙太远或被不锈钢柜挡住。', 'Check the roll is not upside down (heat side out) and has paper; move the printer closer and print again. If it still fails, Bluetooth is too far or blocked by steel.')}</p> : null} />
        </div>
      </div>
    </div>
  );
}

function SamplePane({ id, tr, txt, menu, timeZone, width, canPrint, busy, remaining, onPrint, onConnect }: {
  id: SampleSlipId; tr: Tr; txt: (t: Text) => string; menu: MenuVersion; timeZone: string; width: PaperWidth;
  canPrint: boolean; busy: boolean; remaining: SampleSlipId[]; onPrint: (ids: SampleSlipId[]) => void; onConnect: (() => void) | null;
}) {
  const d = sampleDef(id);
  const lines = useMemo(() => layoutRunnerSlip(buildSampleSlip(menu, id, { nowMs: Date.now(), timeZone }), width), [menu, id, timeZone, width]);
  const rest = remaining.length > 0 ? remaining : SAMPLE_SLIPS.map((x) => x.id);
  return (
    <section className="flex flex-col rounded-2xl border border-line bg-card p-4 lg:sticky lg:top-0 lg:self-start" aria-label={tr('纸上预览', 'Paper preview')}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-lg font-bold">{d.token} · {txt(d.title)}</h3>
        <span className="text-sm text-ink-2">{tr('看：', 'Check: ')}{txt(d.check)}</span>
      </div>
      <div className="my-3 flex justify-center overflow-x-auto rounded-xl bg-subtle px-3 pt-6 pb-8">
        <PaperPreview lines={lines} width={width} label={tr(`${d.token} 号样单预览`, `Preview of sample ${d.token}`)} />
      </div>
      <div className="flex flex-wrap gap-2.5">
        {canPrint ? (
          <>
            <button type="button" disabled={busy} onClick={() => onPrint([id])} className="h-14 flex-1 rounded-xl bg-ok px-4 font-bold text-white disabled:bg-control">{busy ? tr('正在打…', 'Printing…') : tr('打这一张', 'Print this one')}</button>
            <button type="button" onClick={() => onPrint(rest)} className="h-14 flex-1 rounded-xl border border-line px-4 font-bold">
              {remaining.length > 0 && remaining.length < SAMPLE_SLIPS.length ? tr(`剩下 ${remaining.length} 张全打`, `Print the other ${remaining.length}`) : tr(`${SAMPLE_SLIPS.length} 张全打`, `Print all ${SAMPLE_SLIPS.length}`)}
            </button>
          </>
        ) : (
          <button type="button" disabled={!onConnect} onClick={onConnect ?? undefined} className="h-14 flex-1 rounded-xl bg-ok px-4 font-bold text-white disabled:bg-control">{tr('先连接打印机', 'Connect the printer first')}</button>
        )}
      </div>
      <p className="mt-2 text-[13px] text-ink-2">{tr('纸上和这里不一样（缺字、断行、太淡）？拍张照发给开发。', 'Paper looks different from this (missing text, broken lines, too faint)? Send a photo to the developer.')}</p>
    </section>
  );
}

const CHECK_LABEL: Record<TrialCheckId, Text> = {
  chinese: { zh: '中文清楚', en: 'Chinese is clear' },
  width: { zh: '纸宽对', en: 'Paper width is right' },
  tail: { zh: '纸尾对', en: 'Paper end is right' },
  received: { zh: '出餐口收得到', en: 'Reaches the pass' },
  samples: { zh: `${SAMPLE_SLIPS.length} 张样单都打过`, en: `All ${SAMPLE_SLIPS.length} samples printed` },
  rush: { zh: '连打 5 张没少', en: '5 in a row, none missing' },
  drill: { zh: '断开后自动补打', en: 'Reprints after reconnecting' },
};

function Checklist({ tr, trial, checks, passed, width, storeOn, isOwner, onGoSettings, onReset }: {
  tr: Tr; trial: TrialRecord; checks: Record<TrialCheckId, boolean>; passed: number; width: number; storeOn: boolean; isOwner: boolean; onGoSettings: () => void; onReset: () => void;
}) {
  const lang = useLang();
  const detail: Partial<Record<TrialCheckId, string>> = {
    width: checks.width ? `${width}mm` : undefined,
    samples: `${trial.samples.length} / ${SAMPLE_SLIPS.length}`,
    rush: trial.rush ? tr(`最慢一张 ${sec(trial.rush.maxMs)} 秒`, `slowest ${sec(trial.rush.maxMs)} s`) : undefined,
    drill: trial.drill ? (trial.drill.manual ? tr('要手动连一次', 'needed a manual connect') : tr(`连回用了 ${sec(trial.drill.ms)} 秒`, `back in ${sec(trial.drill.ms)} s`)) : undefined,
  };
  const all = passed === TRIAL_CHECKS.length;
  return (
    <details className="group rounded-2xl border border-line bg-card px-3.5 py-3" open={all || undefined}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3">
        <b>{tr('试打清单', 'Trial checklist')}</b>
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-subtle"><span className="block h-full rounded-full bg-ok" style={{ width: `${(passed / TRIAL_CHECKS.length) * 100}%` }} /></span>
        <span className="tabular-nums">{passed} / {TRIAL_CHECKS.length}</span>
        <span className="text-sm text-ink-2 underline underline-offset-4 group-open:hidden">{tr('展开', 'Show')}</span>
      </summary>
      <ul className="mt-1">
        {TRIAL_CHECKS.map((id) => (
          <li key={id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
            <Tick state={checks[id] ? 'done' : 'todo'} tr={tr} />
            <span className="flex-1 font-semibold">{lang === 'en' ? CHECK_LABEL[id].en : CHECK_LABEL[id].zh}</span>
            {detail[id] && <span className="text-sm text-ink-2">{detail[id]}</span>}
          </li>
        ))}
      </ul>
      {storeOn ? (
        <p className="mt-2 rounded-lg bg-subtle p-2.5 text-sm text-ink-2">{tr('全店已经打开送餐单打印，真单照常打印。连打和断开演练要先在设置里关掉才能试。', 'Slip printing is on for the shop; real slips print as usual. Turn it off in Settings to try the rush and disconnect drills.')}</p>
      ) : all ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-ok p-3.5 text-white">
          <p className="min-w-[200px] flex-1"><b className="block text-lg">{tr('7 项都过了', 'All 7 passed')}</b>{tr('打印机可以用了。打开以后，每下一张真单，出餐口就打一张送餐单。', 'The printer is ready. Once switched on, every real order prints a slip at the pass.')}</p>
          {isOwner
            ? <button type="button" onClick={onGoSettings} className="h-12 rounded-xl bg-white px-4 font-bold text-ok">{tr('去打开送餐单打印 →', 'Turn on slip printing →')}</button>
            : <span className="font-semibold">{tr('请老板在「设置 → 送餐单打印」打开。', 'Ask the owner to turn it on in Settings → Slip printing.')}</span>}
        </div>
      ) : null}
      <button type="button" onClick={onReset} className="mt-2 h-11 text-sm font-semibold text-ink-2 underline underline-offset-4">{tr('清单清空，重新试', 'Clear the checklist and start over')}</button>
    </details>
  );
}
