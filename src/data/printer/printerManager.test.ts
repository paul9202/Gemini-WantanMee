/**
 * 送餐单打印队列：只自动打一次；补打写次数；打印机断开时排着、连回来补打；排太久的不自动补打；页面重开不自动补打旧单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, MENU_V1, normalizeConfig, unitPriceSen } from '../../domain/index';
import { buildRunnerSlip } from '../../domain/runnerSlip';
import { PrinterLink, PrinterLinkError } from './ble';
import { createPrinterManager, DEFAULT_SETTINGS, PrinterDeps, PrinterSettings, SlipJob } from './printerManager';

const menu = MENU_V1;
const config = normalizeConfig(menu, defaultConfig(menu, 'dry_noodle', 'black'));
const slip = (token: number) => buildRunnerSlip(menu, {
  tokenNumber: token, serviceMode: 'dine_in', acceptedAtMs: Date.UTC(2026, 10, 12, 6, 32), receiptNumber: `261112-0${token}`, offlineReceiptNumber: null,
  source: 'online', lines: [{ config, quantity: 1, unitPriceSen: unitPriceSen(menu, config) }], totalSen: 700,
}, { timeZone: 'Asia/Kuala_Lumpur', printIndex: 0 });

class FakeLink implements PrinterLink {
  id = 'dev-1';
  name = 'XP-N160II';
  printed: string[][] = [];
  bytes: Uint8Array[] = [];
  failNext: 'connect' | 'write' | null = null;
  private cbs: (() => void)[] = [];
  connected = () => true;
  async write(bytes: Uint8Array, preview?: string[]) {
    const f = this.failNext;
    this.failNext = null;
    if (f === 'connect') throw new PrinterLinkError('CONNECT_FAILED');
    if (f === 'write') throw new PrinterLinkError('WRITE_FAILED');
    this.printed.push(preview ?? []);
    this.bytes.push(bytes);
  }
  disconnect() {}
  onDisconnect(cb: () => void) {
    this.cbs.push(cb);
  }
  drop() {
    this.cbs.forEach((c) => c());
  }
}

function setup(opts: { settings?: Partial<PrinterSettings>; prints?: Record<string, number>; jobs?: SlipJob[]; restore?: boolean } = {}) {
  const link = new FakeLink();
  let settings: PrinterSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const prints = new Map(Object.entries(opts.prints ?? {}));
  let saved: SlipJob[] = opts.jobs ?? [];
  const clock = { now: 1_000_000 };
  const deps: PrinterDeps = {
    supported: true,
    pick: async () => link,
    restore: async () => (opts.restore ? link : null),
    loadSettings: () => settings,
    saveSettings: (s) => { settings = s; },
    getPrints: async (k) => prints.get(k) ?? 0,
    setPrints: async (k, n) => { prints.set(k, n); },
    loadJobs: async () => saved,
    saveJobs: async (j) => { saved = j; },
    now: () => clock.now,
    retryMs: null,
  };
  const m = createPrinterManager(deps);
  return { m, link, prints, clock, settingsNow: () => settings, savedJobs: () => saved };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const job = (m: ReturnType<typeof setup>['m'], key: string) => m.getState().jobs.find((j) => j.key === key);

test('没启用打印机：下单不登记任务', async () => {
  const { m, link } = setup();
  await m.enqueue('order:a', slip(12), { label: '#a' });
  assert.equal(m.getState().jobs.length, 0);
  assert.equal(link.printed.length, 0);
});

test('连上后：下单马上打一次；同一张单不会自动打第二次', async () => {
  const { m, link, prints, settingsNow } = setup();
  await m.connect();
  assert.equal(m.getState().link, 'ready');
  assert.equal(settingsNow().enabled, true, '连上一次就启用');
  assert.equal(settingsNow().deviceName, 'XP-N160II');
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(link.printed.length, 1);
  assert.ok(link.printed[0].includes('12'), link.printed[0].join('\n'));
  assert.equal(job(m, 'order:a')?.status, 'done');
  assert.equal(prints.get('order:a'), 1);
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(link.printed.length, 1);
});

test('本机记录里已经打过（页面重开前打的）：不再自动打', async () => {
  const { m, link } = setup({ prints: { 'order:a': 1 } });
  await m.connect();
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(link.printed.length, 0);
});

test('补打：最上面写「补打 2」；核对后才确认接单的第一次写「核对后补打」', async () => {
  const { m, link } = setup();
  await m.connect();
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await m.enqueue('order:b', slip(15), { label: '#b', reconciled: true });
  await flush();
  assert.equal(link.printed[0][0].trim() === '补打 2', false);
  assert.equal(link.printed[1][0].trim(), '核对后补打');
  m.reprint('order:a');
  await flush();
  assert.equal(link.printed[2][0].trim(), '补打 2');
  assert.equal(job(m, 'order:a')?.prints, 2);
});

test('自动打印关着：任务记下但不打，可以手动打（第一次不写补打）', async () => {
  const { m, link } = setup();
  await m.connect();
  m.setAutoPrint(false);
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(link.printed.length, 0);
  assert.equal(job(m, 'order:a')?.status, 'skipped');
  m.reprint('order:a');
  await flush();
  assert.equal(link.printed.length, 1);
  assert.notEqual(link.printed[0][0].trim(), '补打 2');
});

test('打印机断开：单排着；连回来按先后补打', async () => {
  const { m, link } = setup();
  await m.connect();
  link.drop();
  assert.equal(m.getState().link, 'lost');
  link.failNext = 'connect';
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(job(m, 'order:a')?.status, 'waiting', '连不上就继续排着');
  await m.enqueue('order:b', slip(15), { label: '#b' });
  await flush();
  assert.deepEqual(link.printed.map((p) => p.find((l) => /^\d+$/.test(l))), ['12', '15'], '先来的先打');
  assert.equal(m.getState().link, 'ready');
});

test('断开超过 10 分钟才连回来：不自动补打，标没打出来；收银可以补打或不打了', async () => {
  const { m, link, clock } = setup();
  await m.connect();
  m.disconnect();
  assert.equal(m.getState().link, 'needs_tap');
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(job(m, 'order:a')?.status, 'waiting');
  clock.now += 11 * 60_000;
  await m.connect();
  await flush();
  assert.equal(link.printed.length, 0);
  assert.equal(job(m, 'order:a')?.status, 'failed');
  assert.equal(job(m, 'order:a')?.problem, 'LOST_TOO_LONG');
  m.dismiss('order:a');
  assert.equal(job(m, 'order:a')?.status, 'skipped');
  m.reprint('order:a');
  await flush();
  assert.equal(link.printed.length, 1, '收银点补打照样能打');
});

test('写到一半出错：这张标没打出来（可能打出半张），后面的继续排着', async () => {
  const { m, link } = setup();
  await m.connect();
  link.failNext = 'write';
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(job(m, 'order:a')?.status, 'failed');
  assert.equal(job(m, 'order:a')?.problem, 'WRITE_FAILED');
  assert.equal(m.getState().link, 'lost');
});

const hasCut = (b: Uint8Array) => [...b].some((x, i) => x === 0x1d && b[i + 1] === 0x56);

test('默认 58mm、手撕：送餐单按 32 格排、不发切纸指令；改成 80mm、自动切刀后照新设置打', async () => {
  const { m, link, settingsNow } = setup();
  assert.deepEqual([DEFAULT_SETTINGS.width, DEFAULT_SETTINGS.cut], [58, 'tear']);
  await m.connect();
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.ok(link.printed[0].includes('-'.repeat(32)), '58mm 一行 32 格');
  assert.equal(hasCut(link.bytes[0]), false);
  m.setWidth(80);
  m.setCut('auto');
  assert.deepEqual([settingsNow().width, settingsNow().cut], [80, 'auto'], '设置存回本机');
  await m.enqueue('order:b', slip(15), { label: '#b' });
  await flush();
  assert.ok(link.printed[1].includes('-'.repeat(48)), '80mm 一行 48 格');
  assert.equal(hasCut(link.bytes[1]), true);
});

test('测试打印按当前纸宽和切纸方式打', async () => {
  const { m, link } = setup();
  await m.connect();
  await m.testPrint();
  assert.ok(link.printed[0].some((l) => l.includes('手撕')));
  assert.equal(hasCut(link.bytes[0]), false);
});

test('旧版存下的设置没有切纸字段：照手撕打，不发切纸指令；纸宽照旧', async () => {
  const { m, link } = setup({ settings: { enabled: true, deviceId: 'dev-1', deviceName: 'XP', width: 80, cut: undefined as unknown as 'tear' } });
  await m.connect();
  await m.enqueue('order:a', slip(12), { label: '#a' });
  await flush();
  assert.equal(hasCut(link.bytes[0]), false);
  assert.ok(link.printed[0].includes('-'.repeat(48)), '存下的 80mm 不被默认值盖掉');
});

test('页面重开：没打完的旧任务标没打出来，不自动补打；能连回上次的打印机就直接连上', async () => {
  const old: SlipJob = { key: 'order:old', token: 9, label: '#old', slip: slip(9), reconciled: false, createdAtMs: 999_000, status: 'waiting', prints: 0 };
  const { m, link } = setup({ settings: { enabled: true, deviceId: 'dev-1', deviceName: 'XP' }, jobs: [old], restore: true });
  await m.init();
  await flush();
  assert.equal(m.getState().link, 'ready');
  assert.equal(job(m, 'order:old')?.status, 'failed');
  assert.equal(job(m, 'order:old')?.problem, 'RELOADED');
  assert.equal(link.printed.length, 0);
});

test('页面重开、连不回去：要员工点一下', async () => {
  const { m } = setup({ settings: { enabled: true, deviceId: 'dev-1', deviceName: 'XP' } });
  await m.init();
  assert.equal(m.getState().link, 'needs_tap');
});

test('不用打印机了：停用后下单不再登记', async () => {
  const { m, settingsNow } = setup();
  await m.connect();
  m.remove();
  assert.equal(settingsNow().enabled, false);
  assert.equal(m.getState().link, 'off');
  await m.enqueue('order:a', slip(12), { label: '#a' });
  assert.equal(m.getState().jobs.length, 0);
});

test('测试打印：打出测试条，记下用时', async () => {
  const { m, link } = setup();
  await m.connect();
  await m.testPrint();
  assert.ok(link.printed[0].some((l) => l.includes('打印测试')));
  assert.equal(typeof m.getState().lastWriteMs, 'number');
});
