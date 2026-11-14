/**
 * 送餐单打印机的界面：收银页头的状态（启用后才显示）、打印机面板（连接 / 测试 / 自动打印 / 纸宽 / 没打出来 / 最近）。
 * 设备页也从这里打开面板。连接必须在点击里发起（Chrome 规定），所以「点一下连接打印机」直接连，不先开面板。
 */
import { ReactNode, useState } from 'react';
import { printer, usePrinter } from '../../data/printer/printer';
import type { JobProblem, PrinterState, SlipJob } from '../../data/printer/printerManager';
import { useT } from '../../app/i18n';
import { PrinterGuideDialog } from './PrinterGuide';

type Tr = ReturnType<typeof useT>;

export function linkErrorText(code: string | null, tr: Tr): string | null {
  if (!code) return null;
  switch (code) {
    case 'CANCELLED': return tr('没有选打印机。', 'No printer was chosen.');
    case 'UNSUPPORTED': return tr('这台设备的浏览器连不了蓝牙打印机，请用安卓平板上的 Chrome。', 'This browser cannot use Bluetooth printers. Use Chrome on the Android tablet.');
    case 'NO_WRITABLE': return tr('选的设备不是打印机，或打印机不支持 BLE 蓝牙。', 'That device is not a printer, or the printer has no BLE Bluetooth.');
    case 'CONNECT_FAILED': return tr('连不上打印机：确认打印机开着、有电，靠近一点再试。', 'Could not reach the printer: check it is on and powered, move closer and try again.');
    default: return tr('打印中断了，可能只打出半张。', 'Printing was interrupted; maybe only half a slip came out.');
  }
}

function problemText(p: JobProblem | undefined, tr: Tr): string {
  if (p === 'LOST_TOO_LONG') return tr('打印机断开太久，没有自动补打', 'Printer was off too long; not reprinted automatically');
  if (p === 'RELOADED') return tr('页面重新打开前没打完', 'Not finished before the page reopened');
  return tr('打印中断，可能只打出半张', 'Interrupted; maybe half printed');
}

const waitingCount = (s: PrinterState) => s.jobs.filter((j) => j.status === 'waiting').length;
const failedJobs = (s: PrinterState) => s.jobs.filter((j) => j.status === 'failed');

/** 收银页头：在「后厨已连接」旁边。没启用打印机时不显示。 */
export function PrinterChip() {
  const s = usePrinter();
  const tr = useT();
  const [open, setOpen] = useState(false);
  if (!s.settings.enabled) return null;
  const printing = s.jobs.find((j) => j.status === 'printing');
  const waiting = waitingCount(s);
  const failed = failedJobs(s).length;
  const base = 'inline-flex min-h-14 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] font-semibold';
  let chip: { tone: string; text: string; tap?: () => void };
  if (s.link === 'needs_tap') chip = { tone: 'bg-warn-bg text-warn ring-2 ring-warn/30', text: tr('点一下连接打印机', 'Tap to connect printer'), tap: () => void printer.connect() };
  else if (s.link === 'connecting') chip = { tone: 'bg-subtle text-ink-2', text: tr('正在连接打印机…', 'Connecting printer…') };
  else if (s.link === 'lost') chip = { tone: 'bg-danger-bg text-danger', text: waiting ? tr(`打印机断开 · ${waiting} 张待打`, `Printer off · ${waiting} waiting`) : tr('打印机断开', 'Printer off') };
  else if (failed) chip = { tone: 'bg-danger-bg text-danger', text: tr(`${failed} 张没打出来`, `${failed} not printed`) };
  else if (printing) chip = { tone: 'bg-ok-bg text-ok', text: tr(`正在打 ${printing.token} 号…`, `Printing No. ${printing.token}…`) };
  else chip = { tone: 'bg-ok-bg text-ok', text: tr('打印机', 'Printer') };
  return (
    <>
      <button type="button" onClick={chip.tap ?? (() => setOpen(true))} className={`${base} ${chip.tone}`} aria-haspopup={chip.tap ? undefined : 'dialog'}>
        <span className="h-2 w-2 rounded-full bg-current" />{chip.text}
      </button>
      {open && <PrinterSheet onClose={() => setOpen(false)} />}
    </>
  );
}

export function PrinterSheet({ onClose }: { onClose: () => void }) {
  const s = usePrinter();
  const tr = useT();
  const [testing, setTesting] = useState(false);
  const [guide, setGuide] = useState(false);
  const failed = failedJobs(s);
  const recent = s.jobs.filter((j) => j.status !== 'failed').slice(0, 10);
  const ready = s.link === 'ready';
  const status = !s.settings.enabled ? tr('还没连接过打印机', 'No printer yet')
    : ready ? tr('已连接', 'Connected')
    : s.link === 'connecting' ? tr('正在连接…', 'Connecting…')
    : s.link === 'lost' ? tr('断开了，会自动重连', 'Disconnected; retrying')
    : tr('没连接', 'Not connected');
  const err = linkErrorText(s.error, tr);

  return (
    <div role="dialog" aria-modal="true" aria-label={tr('送餐单打印机', 'Order slip printer')} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 className="flex-1 text-xl font-bold">{tr('送餐单打印机', 'Order slip printer')}</h2>
          <button type="button" onClick={() => setGuide(true)} className="h-14 rounded-xl px-3 font-semibold text-ink-2 underline underline-offset-4">{tr('连接说明', 'How to connect')}</button>
          <button type="button" onClick={onClose} autoFocus className="h-14 rounded-xl border border-line px-4 font-semibold">{tr('关闭', 'Close')}</button>
        </div>
        {guide && <PrinterGuideDialog onClose={() => setGuide(false)} />}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {!s.supported ? (
            <p className="mt-4 rounded-xl bg-warn-bg p-3 text-warn">{linkErrorText('UNSUPPORTED', tr)}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-line py-4">
                <div className="min-w-0 flex-1">
                  <b className="block">{s.settings.deviceName ?? tr('蓝牙打印机', 'Bluetooth printer')}</b>
                  <span className={`text-sm ${ready ? 'text-ok' : s.link === 'lost' ? 'text-danger' : 'text-ink-2'}`}>
                    {status}{ready && s.lastWriteMs !== null ? tr(` · 上一张 ${(s.lastWriteMs / 1000).toFixed(1)} 秒`, ` · last ${(s.lastWriteMs / 1000).toFixed(1)} s`) : ''}
                  </span>
                </div>
                {ready ? (
                  <>
                    <button type="button" disabled={testing} onClick={async () => { setTesting(true); await printer.testPrint(); setTesting(false); }}
                      className="h-14 rounded-xl border border-line px-4 font-semibold disabled:text-ink-2">{testing ? tr('打印中…', 'Printing…') : tr('测试打印', 'Test print')}</button>
                    <button type="button" onClick={() => printer.disconnect()} className="h-14 rounded-xl border border-line px-4 font-semibold">{tr('断开', 'Disconnect')}</button>
                  </>
                ) : (
                  <button type="button" disabled={s.link === 'connecting'} onClick={() => void printer.connect()}
                    className="h-14 rounded-xl bg-ok px-4 font-bold text-white disabled:bg-control">{s.settings.enabled ? tr('连接打印机', 'Connect printer') : tr('连接蓝牙打印机', 'Connect Bluetooth printer')}</button>
                )}
              </div>
              {err && <p role="alert" className="mt-3 rounded-xl bg-danger-bg p-3 text-sm text-danger">{err}</p>}
              <p className="mt-3 text-[13px] text-ink-2">{tr('下单后在出餐口打一张送餐单：牌号、堂食 / 打包、每碗是什么、金额。只有主收银平板会打印；页面重新打开后可能要再点一下「连接打印机」。', 'After each order a slip prints at the pass: token, dine-in / takeaway, each bowl, amounts. Only the main register prints; after the page reopens you may need to tap Connect printer again.')}</p>

              {s.settings.enabled && (
                <>
                  <div className="mt-2 flex items-center gap-3 border-b border-line py-4">
                    <div className="min-w-0 flex-1"><b>{tr('下单自动打印', 'Print on every order')}</b><p className="text-[13px] text-ink-2">{tr('关掉后只记下来，要打时在下面点「打印」', 'When off, slips are only listed; tap Print below')}</p></div>
                    <button type="button" role="switch" aria-checked={s.settings.autoPrint} onClick={() => printer.setAutoPrint(!s.settings.autoPrint)}
                      className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${s.settings.autoPrint ? 'bg-ok' : 'bg-control'}`}>
                      <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${s.settings.autoPrint ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 border-b border-line py-4">
                    <div className="min-w-0 flex-1"><b>{tr('纸宽', 'Paper width')}</b><p className="text-[13px] text-ink-2">{tr('测试条的虚线断成两行、或只到纸的三分之二，就是选错了', 'If the test strip’s dashed line breaks onto two lines or covers only two-thirds of the paper, this is wrong')}</p></div>
                    <Choice label={tr('纸宽', 'Paper width')} value={s.settings.width} onChange={(w) => printer.setWidth(w)}
                      options={[[58, '58mm'], [80, '80mm']]} />
                  </div>
                  <div className="flex items-center gap-3 border-b border-line py-4">
                    <div className="min-w-0 flex-1"><b>{tr('切纸', 'Cutting')}</b><p className="text-[13px] text-ink-2">{tr('便携机多半没有切刀，选「手撕」', 'Most portable printers have no cutter: choose Tear')}</p></div>
                    <Choice label={tr('切纸', 'Cutting')} value={s.settings.cut} onChange={(c) => printer.setCut(c)}
                      options={[['tear', tr('手撕', 'Tear')], ['auto', tr('自动切刀', 'Auto cutter')]]} />
                  </div>

                  {failed.length > 0 && (
                    <>
                      <h3 className="mt-4 text-sm font-bold text-danger">{tr(`没打出来（${failed.length}）`, `Not printed (${failed.length})`)}</h3>
                      <ul>{failed.map((j) => <JobRow key={j.key} job={j} note={problemText(j.problem, tr)} actions={
                        <>
                          <button type="button" onClick={() => printer.reprint(j.key)} className="h-12 rounded-lg bg-ok px-3 font-bold text-white">{tr('补打', 'Reprint')}</button>
                          <button type="button" onClick={() => printer.dismiss(j.key)} className="h-12 rounded-lg border border-line px-3 font-semibold">{tr('不打了', 'Skip')}</button>
                        </>
                      } />)}</ul>
                    </>
                  )}

                  {recent.length > 0 && (
                    <>
                      <h3 className="mt-4 text-sm font-bold text-ink-2">{tr('最近', 'Recent')}</h3>
                      <ul>{recent.map((j) => <JobRow key={j.key} job={j} note={jobStatusText(j, s, tr)} actions={
                        j.status === 'done' || j.status === 'skipped'
                          ? <button type="button" onClick={() => printer.reprint(j.key)} className="h-12 rounded-lg border border-line px-3 font-semibold">{j.prints > 0 ? tr('补打', 'Reprint') : tr('打印', 'Print')}</button>
                          : null
                      } />)}</ul>
                    </>
                  )}

                  <button type="button" onClick={() => { printer.remove(); onClose(); }} className="mt-5 h-12 text-sm font-semibold text-ink-2 underline underline-offset-4">{tr('这台设备不用打印机了', 'Stop using a printer on this device')}</button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function jobStatusText(j: SlipJob, s: PrinterState, tr: Tr): string {
  if (j.status === 'printing') return tr('正在打印…', 'Printing…');
  if (j.status === 'waiting') return s.link === 'ready' ? tr('排队中', 'Queued') : tr('等打印机连上', 'Waiting for printer');
  if (j.status === 'skipped') return j.prints > 0 ? tr(`已打印 ${j.prints} 次`, `Printed ${j.prints}×`) : tr('没有打印', 'Not printed');
  return j.prints > 1 ? tr(`已打印 ${j.prints} 次`, `Printed ${j.prints}×`) : tr('已打印', 'Printed');
}

/** 两三个选项的分段按钮（纸宽、切纸）。 */
function Choice<T extends string | number>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex shrink-0 rounded-xl bg-subtle p-1" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={`h-12 rounded-lg px-4 font-semibold ${value === v ? 'bg-card shadow' : 'text-ink-2'}`}>{text}</button>
      ))}
    </div>
  );
}

function JobRow({ job, note, actions }: { job: SlipJob; note: string; actions: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0">
      <b className="w-10 text-center text-2xl tabular-nums">{job.token}</b>
      <div className="min-w-0 flex-1">
        <span className="block font-semibold">{job.label}</span>
        <span className="block text-[13px] text-ink-2">{job.slip.time} · {note}</span>
      </div>
      {actions}
    </li>
  );
}

/** 下单结果第四步：打印机启用时才有。 */
export function slipStep(job: SlipJob | null | undefined, s: PrinterState, offline: boolean, tr: Tr): { label: string; done: boolean; warn: boolean; action?: { label: string; run: () => void } } | null {
  if (!s.settings.enabled) return null;
  const printed = offline ? tr('断网单已打印', 'Offline slip printed') : tr('已打印', 'Printed');
  if (!job) return { label: tr('正在打印…', 'Printing…'), done: false, warn: false };
  if (job.status === 'done') return { label: printed, done: true, warn: false, action: { label: tr('补打', 'Reprint'), run: () => printer.reprint(job.key) } };
  if (job.status === 'failed') return { label: tr('没打出来', 'Not printed'), done: false, warn: true, action: { label: tr('补打', 'Reprint'), run: () => printer.reprint(job.key) } };
  if (job.status === 'skipped') return { label: tr('没有自动打印', 'Not auto-printed'), done: false, warn: false, action: { label: tr('打印', 'Print'), run: () => printer.reprint(job.key) } };
  if (job.status === 'waiting' && s.link !== 'ready') {
    return { label: tr('等打印机', 'Waiting for printer'), done: false, warn: true, ...(s.link === 'needs_tap' ? { action: { label: tr('连接打印机', 'Connect printer'), run: () => void printer.connect() } } : {}) };
  }
  return { label: tr('正在打印…', 'Printing…'), done: false, warn: false };
}

