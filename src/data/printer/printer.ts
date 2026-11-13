/**
 * 本机的送餐单打印机（单例）+ React hook。
 * 设置存 localStorage（只在这台设备）；每张单打了几次、最近的任务存 IndexedDB（刷新后还在，不上云端）。
 * 本机开发 / 端到端测试：localStorage 里 hao-printer-fake=1 时用假打印机，内容记在 window.__haoPrinted。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { kvGet, kvSet } from '../local/idb';
import { bluetoothSupported, pickBlePrinter, PrinterLink, restoreBlePrinter } from './ble';
import { createPrinterManager, DEFAULT_SETTINGS, PrinterSettings, PrinterState, SlipJob } from './printerManager';

const SETTINGS_KEY = 'hao-printer';
const FAKE_KEY = 'hao-printer-fake';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function fakeEnabled(): boolean {
  if (typeof location === 'undefined') return false;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return (import.meta.env.DEV || local) && readLocal(FAKE_KEY) === '1';
}

declare global {
  interface Window {
    __haoPrinted?: string[][];
  }
}

function fakeLink(): PrinterLink {
  const cbs: (() => void)[] = [];
  return {
    id: 'fake-printer',
    name: '假打印机（测试）',
    connected: () => true,
    async write(_bytes, preview) {
      (window.__haoPrinted ??= []).push(preview ?? []);
    },
    disconnect() {},
    onDisconnect(cb) {
      cbs.push(cb);
    },
  };
}

export const printer = createPrinterManager({
  supported: fakeEnabled() || bluetoothSupported(),
  pick: async () => (fakeEnabled() ? fakeLink() : pickBlePrinter()),
  restore: async (id) => (fakeEnabled() ? (id === 'fake-printer' ? fakeLink() : null) : restoreBlePrinter(id)),
  loadSettings: () => {
    try {
      const raw = readLocal(SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<PrinterSettings>) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  },
  saveSettings: (s) => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      // 存不了只在本次打开有效
    }
  },
  getPrints: async (key) => (await kvGet<number>(`slipPrints:${key}`)) ?? 0,
  setPrints: (key, n) => kvSet(`slipPrints:${key}`, n),
  loadJobs: async () => (await kvGet<SlipJob[]>('slipJobs')) ?? [],
  saveJobs: (jobs) => kvSet('slipJobs', jobs),
  now: () => Date.now(),
  retryMs: 15_000,
});

/**
 * 打印机状态。active（门店总开关打开）时第一次用就读回本机记录、试着连回上次的打印机；
 * 总开关关着时只读状态，不去连打印机。
 */
export function usePrinter(active = true): PrinterState {
  useEffect(() => {
    if (active) void printer.init();
  }, [active]);
  return useSyncExternalStore(printer.subscribe, printer.getState);
}

/** 门店总开关（老板在设置里开）。 */
export const slipPrintingOn = (config: { slipPrinting?: boolean } | null | undefined) => config?.slipPrinting === true;
