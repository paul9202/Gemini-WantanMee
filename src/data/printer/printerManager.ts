/**
 * 送餐单打印队列（只在主收银平板上用）。依赖从外面传进来，Node 测试里可以换成假的。
 * - 下单只登记任务，不等打印：任务排队、一张一张打，打印机没连、断开、出错都不影响下单。
 * - 同一张单只自动打一次（本机打印记录按单记次数）；收银手动补打写「补打 N」。
 * - 打印机断开时任务排着：同一个页面里连回来，只补打断开 10 分钟以内的；更早的标「没打出来」，由收银决定补打还是不打了。
 * - 页面重开后不自动补打旧任务，同样标「没打出来」。
 */
import { resumesOnReconnect, RunnerSlip, slipMark } from '../../domain/runnerSlip';
import { CutMode, encodeLines, layoutRunnerSlip, layoutTestPage, PaperWidth, previewLines } from './escpos';
import type { PrinterLink } from './ble';
import { PrinterLinkError } from './ble';

export interface PrinterSettings {
  /** 这台设备用不用送餐单打印机（第一次连上后打开；没开时页头不显示打印机）。 */
  enabled: boolean;
  deviceId: string | null;
  deviceName: string | null;
  autoPrint: boolean;
  width: PaperWidth;
  /** 有自动切刀就切；没有就手撕（不发切纸指令）。 */
  cut: CutMode;
}

/**
 * 默认 58mm、手撕：58mm 的排版放到 80mm 机上只是窄一点，80mm 的排版放到 58mm 机上每行都会断开；
 * 不发切纸指令对有切刀的机器只是不切，对没切刀的机器却可能多印出乱码。所以默认选两者里不会出错的那个，用 80mm 带切刀的机器再在面板里改。
 */
export const DEFAULT_SETTINGS: PrinterSettings = { enabled: false, deviceId: null, deviceName: null, autoPrint: true, width: 58, cut: 'tear' };

/** off：没启用；needs_tap：要员工点一下连接；connecting；ready；lost：断开了（同一页面里会自动重试）。 */
export type LinkState = 'off' | 'needs_tap' | 'connecting' | 'ready' | 'lost';

export type JobStatus = 'waiting' | 'printing' | 'done' | 'failed' | 'skipped';
/** 没打出来的原因：断开太久、页面重开、写入出错。 */
export type JobProblem = 'LOST_TOO_LONG' | 'RELOADED' | 'WRITE_FAILED';

export interface SlipJob {
  key: string;
  token: number;
  /** 打印记录里给收银看的一句，例如「#261112-037 · 同牌加单」。 */
  label: string;
  slip: RunnerSlip;
  reconciled: boolean;
  createdAtMs: number;
  status: JobStatus;
  problem?: JobProblem;
  doneAtMs?: number;
  /** 已经成功打了几次。 */
  prints: number;
}

export interface PrinterState {
  supported: boolean;
  settings: PrinterSettings;
  link: LinkState;
  /** 最近的任务，新的在前。 */
  jobs: SlipJob[];
  /** 最近一次连接或测试出错（错误码，界面翻译）。 */
  error: string | null;
  /** 上一张从开始写到写完用了多久。 */
  lastWriteMs: number | null;
}

export interface PrinterDeps {
  supported: boolean;
  pick(): Promise<PrinterLink>;
  restore(deviceId: string): Promise<PrinterLink | null>;
  loadSettings(): PrinterSettings;
  saveSettings(s: PrinterSettings): void;
  /** 某张单成功打了几次。 */
  getPrints(key: string): Promise<number>;
  setPrints(key: string, n: number): Promise<void>;
  loadJobs(): Promise<SlipJob[]>;
  saveJobs(jobs: SlipJob[]): Promise<void>;
  now(): number;
  /** 断开后隔多久自动重试；测试里传 null 不重试。 */
  retryMs: number | null;
}

const MAX_JOBS = 30;

export function createPrinterManager(deps: PrinterDeps) {
  let state: PrinterState = { supported: deps.supported, settings: deps.loadSettings(), link: 'off', jobs: [], error: null, lastWriteMs: null };
  let link: PrinterLink | null = null;
  let pumping = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let initDone: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((l) => l());
  const set = (patch: Partial<PrinterState>) => {
    state = { ...state, ...patch };
    emit();
  };
  const setSettings = (patch: Partial<PrinterSettings>) => {
    const settings = { ...state.settings, ...patch };
    deps.saveSettings(settings);
    set({ settings });
  };
  const persist = () => void deps.saveJobs(state.jobs).catch(() => undefined);
  const updateJob = (key: string, patch: Partial<SlipJob>) => {
    set({ jobs: state.jobs.map((j) => (j.key === key ? { ...j, ...patch } : j)) });
    persist();
  };

  function attach(l: PrinterLink) {
    link = l;
    l.onDisconnect(() => {
      if (link !== l) return;
      set({ link: 'lost' });
      scheduleRetry();
    });
    setSettings({ enabled: true, deviceId: l.id, deviceName: l.name });
    set({ link: 'ready', error: null });
    void pump();
  }

  function scheduleRetry() {
    if (deps.retryMs === null || retryTimer || !state.jobs.some((j) => j.status === 'waiting')) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (state.link === 'lost') void pump();
    }, deps.retryMs);
  }

  async function pump() {
    if (pumping || !link) return;
    pumping = true;
    try {
      for (;;) {
        // 排了太久（多半是断开期间的单，已经出餐了）：不自动补打，留给收银决定。
        const now = deps.now();
        for (const j of state.jobs) if (j.status === 'waiting' && !resumesOnReconnect(j, now)) updateJob(j.key, { status: 'failed', problem: 'LOST_TOO_LONG' });
        const job = [...state.jobs].reverse().find((j) => j.status === 'waiting'); // 先来的先打
        if (!job) break;
        updateJob(job.key, { status: 'printing' });
        const prints = await deps.getPrints(job.key).catch(() => job.prints);
        const lines = layoutRunnerSlip({ ...job.slip, mark: slipMark(prints, job.reconciled) }, state.settings.width);
        const started = deps.now();
        try {
          await link.write(encodeLines(lines, state.settings.cut), previewLines(lines));
        } catch (e) {
          // 连不上：任务放回去排着，等重连；写到一半出错：标没打出来，让收银决定要不要补打（可能已经打出半张）。
          const code = e instanceof PrinterLinkError ? e.code : 'WRITE_FAILED';
          if (code === 'CONNECT_FAILED') updateJob(job.key, { status: 'waiting' });
          else updateJob(job.key, { status: 'failed', problem: 'WRITE_FAILED' });
          // 后面的单继续排着，等连回来再打。
          set({ link: 'lost', error: code });
          scheduleRetry();
          break;
        }
        await deps.setPrints(job.key, prints + 1).catch(() => undefined);
        updateJob(job.key, { status: 'done', doneAtMs: deps.now(), prints: prints + 1 });
        set({ link: 'ready', lastWriteMs: deps.now() - started });
      }
    } finally {
      pumping = false;
    }
  }

  return {
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    /** 页面打开时调用一次：读回任务（重开前没打完的标「没打出来」），试着连回上次的打印机。 */
    init(): Promise<void> {
      initDone ??= (async () => {
        const saved = await deps.loadJobs().catch(() => []);
        set({ jobs: saved.map((j) => (j.status === 'waiting' || j.status === 'printing' ? { ...j, status: 'failed' as const, problem: 'RELOADED' as const } : j)) });
        if (!state.settings.enabled) return;
        set({ link: 'needs_tap' });
        if (!state.settings.deviceId || !deps.supported) return;
        const l = await deps.restore(state.settings.deviceId);
        if (l) attach(l);
      })();
      return initDone;
    },

    /** 员工点「连接打印机」：弹出选择框。 */
    async connect(): Promise<void> {
      set({ link: 'connecting', error: null });
      try {
        attach(await deps.pick());
      } catch (e) {
        set({ link: state.settings.enabled ? (link ? 'lost' : 'needs_tap') : 'off', error: e instanceof PrinterLinkError ? e.code : 'CONNECT_FAILED' });
      }
    },

    disconnect() {
      const l = link;
      link = null;
      l?.disconnect();
      set({ link: state.settings.enabled ? 'needs_tap' : 'off' });
    },

    /** 这台设备不用打印机了：页头不再显示。 */
    remove() {
      const l = link;
      link = null;
      l?.disconnect();
      setSettings({ enabled: false, deviceId: null, deviceName: null });
      set({ link: 'off' });
    },

    setAutoPrint(on: boolean) {
      setSettings({ autoPrint: on });
    },
    setWidth(width: PaperWidth) {
      setSettings({ width });
    },
    setCut(cut: CutMode) {
      setSettings({ cut });
    },

    /** 下单、加料、断网接单、核对确认后调用。同一张单打过就不再自动打。 */
    async enqueue(key: string, slip: RunnerSlip, opts: { label: string; reconciled?: boolean }): Promise<void> {
      if (!state.settings.enabled) return;
      if (state.jobs.some((j) => j.key === key)) return;
      const prints = await deps.getPrints(key).catch(() => 0);
      if (prints > 0 || state.jobs.some((j) => j.key === key)) return;
      const job: SlipJob = {
        key, token: slip.token, label: opts.label, slip, reconciled: Boolean(opts.reconciled), createdAtMs: deps.now(),
        status: state.settings.autoPrint ? 'waiting' : 'skipped', prints: 0,
      };
      set({ jobs: [job, ...state.jobs].slice(0, MAX_JOBS) });
      persist();
      if (job.status === 'waiting') {
        if (state.link === 'lost') scheduleRetry();
        void pump();
      }
    },

    /** 补打 / 没打出来的再打一次 / 自动打印关着时手动打。 */
    reprint(key: string) {
      const job = state.jobs.find((j) => j.key === key);
      if (!job || job.status === 'waiting' || job.status === 'printing') return;
      updateJob(key, { status: 'waiting', problem: undefined, createdAtMs: deps.now() });
      void pump();
    },

    /** 没打出来的单，收银决定不打了。 */
    dismiss(key: string) {
      updateJob(key, { status: 'skipped', problem: undefined });
    },

    async testPrint(): Promise<void> {
      if (!link) return;
      const lines = layoutTestPage({ width: state.settings.width, cut: state.settings.cut, at: new Date(deps.now()).toLocaleString('zh-CN', { hour12: false }), deviceName: state.settings.deviceName ?? '' });
      const started = deps.now();
      try {
        await link.write(encodeLines(lines, state.settings.cut), previewLines(lines));
        set({ link: 'ready', lastWriteMs: deps.now() - started, error: null });
      } catch (e) {
        set({ error: e instanceof PrinterLinkError ? e.code : 'WRITE_FAILED' });
      }
    },
  };
}

export type PrinterManager = ReturnType<typeof createPrinterManager>;
