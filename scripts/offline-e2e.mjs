// 真断网端到端验证（04 §4 + 2026-10-23 运营改版 §9/§11-12）：断网下单（不收款）→ 离线确认收款 → 人工出餐 → 刷新 → 补同步 → 重复补同步不重复入账。
// 正式构建 + Service Worker + 本机 Emulator，用 CDP 切断页面网络（不是改布尔值）。
// 前提：Emulator 已启动并执行过 npm run emulators:seed；用 VITE_USE_EMULATORS=true 构建 dist，并在 4173 端口 vite preview。
// 用法：node scripts/offline-e2e.mjs
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callable, fsList, idToken } from './lib/cdp.mjs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.E2E_ORIGIN || 'http://localhost:4173';
const OUT = 'docs/screenshots/offline';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const check = (name, ok, detail = '') => {
  log.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const seed = await readFile('functions/scripts/seed-emulator.ts', 'utf8');
const account = (role) => {
  const m = seed.match(new RegExp(`email: '([^']+)', password: '([^']+)', role: '${role}'`));
  return { email: m[1], password: m[2] };
};

// Emulator REST 读取用 lib/cdp.mjs 的 fsList（含文档 ID _id）。

const profile = await mkdtemp(join(tmpdir(), 'hao-offline-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws;
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await pause(100); }
  }
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const HELPERS = `window.__click = (t, n = 0) => { const bs = [...document.querySelectorAll('button')].filter(b => !b.disabled && b.innerText.replace(/\\s+/g,'').includes(t)); if (!bs[n]) throw new Error('no button ' + t); bs[n].click(); };
    window.__has = (t) => document.body.innerText.replace(/\\s+/g,'').includes(t);
    window.__sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.__waitFor = async (t, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (__has(t)) return true; await __sleep(200); } return false; };`;
  const page = async (expr) => evaluate(`${HELPERS}(async () => { ${expr} })()`);
  const goto = async (path) => { await send('Page.navigate', { url: ORIGIN + path }); await pause(3000); };
  const offline = (on) => send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const shot = async (name) => {
    await mkdir(OUT, { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  };
  const login = async (who) => page(`
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('#email'), ${JSON.stringify(account(who).email)});
    set(document.querySelector('#password'), ${JSON.stringify(account(who).password)});
    document.querySelector('form').requestSubmit();
    await __sleep(4000);
    return location.pathname;`);
  const logout = async () => { await page(`__click('退出'); await __sleep(2000);`); };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });

  // ---- 开档准备（联网） ----
  await goto('/login');
  check('老板登录（进入老板概览）', (await login('owner')) === '/owner');
  await goto('/device');
  await page(`await __waitFor('设为主收银机'); for (let i = 0; i < 60 && ![...document.querySelectorAll('button')].some((b) => !b.disabled && b.innerText.includes('设为主收银机')); i++) await __sleep(250); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await logout();
  check('收银登录', (await login('cashier')) === '/pos');
  await page(`if (await __waitFor('确认开班', 8000)) { __click('确认开班'); } await __waitFor('看图选餐', 25000);`);
  // 让 Service Worker 接管页面，并保存离线快照
  await goto('/pos');
  await page(`await __waitFor('看图选餐', 20000); await __sleep(3000);`);
  await goto('/device');
  const ready = await page(`await __waitFor('离线可用检查', 10000); await __sleep(2000); return document.querySelector('main').innerText;`);
  check('离线可用检查：应用壳、照片、快照', ready.includes('✓ 离线应用壳已就绪') && ready.includes('张已缓存') && ready.includes('✓ 离线营业快照'), ready.match(/离线可用检查\s*([^\n]+)/)?.[1]);
  await goto('/pos');
  await page(`await __waitFor('看图选餐', 20000);`);

  // ---- 真断网 ----
  await offline(true);
  await pause(1500);
  check('断网后显示离线营业横条', await page(`return await __waitFor('离线营业·仅本机保存', 8000);`));
  // 下单送厨（2026-10-23 起下单不收款）：只点本单里的「下单送厨」。
  const SEND = `[...document.querySelectorAll('aside[aria-label="本单"] button')].find((b) => b.innerText.includes('下单送厨')).click();`;
  const RESULT = `(document.querySelector('[role=dialog]') ?? document.querySelector('aside')).innerText`;
  const order1 = await page(`
    __click('红酱面'); await __sleep(150); __click('加入本单'); await __sleep(200);
    const token = Number(document.querySelector('aside [aria-label^="餐牌"]').getAttribute('aria-label').match(/(\\d+)/)[1]);
    ${SEND} await __sleep(1500);
    return { token, text: ${RESULT} };`);
  check('D01 断网下单：本机已接单、显示临时号与人工传单、待收款（不经收款步骤）', order1.text.includes('本机已接单') && /O-F\d+-\d{4}/.test(order1.text) && order1.text.includes('请人工传单') && order1.text.includes('待收款'), `餐牌 ${order1.token}`);
  await shot('offline-pos-accepted');
  await page(`__click('我已把单交给厨师'); await __sleep(800);`);
  check('人工交接已记录', await page(`return __has('已人工交接');`));
  await page(`__click('下一单'); await __sleep(300);`);

  // 断网刷新（模拟关闭浏览器后重开）
  await send('Page.reload', { ignoreCache: false });
  await pause(6000);
  const afterReload = await page(`await __waitFor('离线营业', 20000); return document.body.innerText;`);
  check('D01 断网刷新：应用从 Service Worker 载入，仍为离线营业', afterReload.includes('离线营业') && afterReload.includes('看图选餐'));
  await goto('/sync');
  const syncText = await page(`await __waitFor('本机离线单', 15000); return document.querySelector('main').innerText;`);
  check('D01 刷新后本机订单与日志都在，订单为未收款', syncText.includes(`未同步 2 条`) && /O-F\d+-\d{4}/.test(syncText) && syncText.includes('未收款'), syncText.match(/未同步 \d+ 条/)?.[0]);
  await shot('offline-sync-center');

  // 回柜台确认已收款（离线人工全额确认）→ 人工出餐（自动释放餐牌）；各自形成本机事件，先落盘再显示成功
  await page(`__click('确认已收款RM7.00'); await __sleep(1000); __click('已人工出餐'); await __sleep(1000);`);
  const steps = await page(`return { text: document.querySelector('main').innerText, again: [...document.querySelectorAll('button')].some((b) => !b.disabled && b.innerText.replace(/\\s+/g, '').includes('确认已收款RM7.00')), returnStep: __has('实体牌已收回') };`);
  check('离线确认收款、人工出餐：本机记录 4 条、收款按钮不能再点、没有「实体牌已收回」步骤', steps.text.includes('未同步 4 条') && steps.text.includes('已登记收款') && !steps.again && !steps.returnStep, steps.text.match(/未同步 \d+ 条/)?.[0]);
  await send('Page.reload', { ignoreCache: false });
  await pause(6000);
  const afterReload2 = await page(`await __waitFor('本机离线单', 20000); return document.querySelector('main').innerText;`);
  check('D12 再次断网刷新：收款与出餐记录仍在（原子落盘）', afterReload2.includes('未同步 4 条') && afterReload2.includes('已登记收款') && afterReload2.includes('已确认收款'), afterReload2.match(/未同步 \d+ 条/)?.[0]);
  await shot('offline-sync-paid-served');

  // 人工出餐即释放餐牌 → 同牌新单（D03）
  await goto('/pos');
  await page(`await __waitFor('看图选餐', 20000);`);
  const order2 = await page(`
    [...document.querySelectorAll('button')].find((b) => b.innerText.includes('个可用')).click(); await __sleep(400);
    const btn = document.querySelector('button[aria-label^="${order1.token}号"]');
    const state = btn.getAttribute('aria-label');
    btn.click(); await __sleep(300);
    __click('云吞汤'); await __sleep(150); __click('加入本单'); await __sleep(200);
    ${SEND} await __sleep(1500);
    const text = ${RESULT}; __click('下一单'); await __sleep(300);
    return { state, text };`);
  check('D03 人工出餐后同一张牌可再离线接单（无人工回收）', order2.state.includes('可用') && order2.text.includes('本机已接单'), order2.state);
  const order3 = await page(`
    __click('白酱面'); await __sleep(150); __click('加入本单'); await __sleep(200);
    ${SEND} await __sleep(1500);
    return ${RESULT}.match(/(\\d+)号 · 临时号/)?.[1];`);
  check('第三张离线单（尚未制作、未收款）', Boolean(order3), `餐牌 ${order3}`);
  // 收款码原图离线可用（Service Worker 缓存）；打开 / 关闭不登记收款
  const qrOffline = await page(`
    __click('显示收款码'); await __sleep(1200);
    const img = document.querySelector('[role=dialog][aria-label="收款码"] img'); await img.decode().catch(() => {});
    const loaded = img.naturalWidth > 0;
    __click('关闭（订单仍待收款）'); await __sleep(500);
    const text = ${RESULT}; __click('下一单'); await __sleep(300);
    return { loaded, unpaid: text.includes('待收款') && !text.includes('已登记收款') };`);
  check('D11 断网时收款码原图仍可显示，关闭后订单仍待收款', qrOffline.loaded && qrOffline.unpaid, JSON.stringify(qrOffline));

  const ordersBefore = await fsList('orders');
  check('断网期间云端没有任何订单', ordersBefore.length === 0, `${ordersBefore.length} 单`);

  // ---- 恢复网络 → 自动补同步 ----
  await offline(false);
  await goto('/sync');
  await page(`await __sleep(2000); if (__has('立即同步')) { try { __click('立即同步'); } catch {} } await __waitFor('未同步0条', 40000);`);
  const synced = await page(`return document.querySelector('main').innerText;`);
  check('联网后补同步完成（逐条云端已接纳）', synced.includes('未同步 0 条') && !synced.includes('待老板核对'), synced.match(/未同步 \d+ 条/)?.[0]);
  await shot('offline-sync-done');

  const orders = await fsList('orders');
  const tickets = await fsList('kitchenTickets');
  const inbox = await fsList('offlineInbox');
  const tokens = await fsList('tokens');
  const payments = await fsList('payments');
  const o1 = orders.find((o) => o.tokenNumber === order1.token && o.fulfillmentStatus === 'served');
  check('D04 云端 3 张离线单、无重复', orders.length === 3 && orders.every((o) => o.source === 'offline'), `${orders.length} 单`);
  check('补同步不送厨：电子厨单为 0', tickets.filter((t) => t.kitchenRouting === 'digital').length === 0);
  check('已人工出餐的单导入为已出餐 + 已收款', orders.filter((o) => o.fulfillmentStatus === 'served').length === 1 && o1?.paymentState === 'paid' && o1.paidSen === 700, `${o1?.fulfillmentStatus}/${o1?.paymentState}`);
  check('D12 只有 1 笔收款（属于第一张单），其余两单仍未收款', payments.length === 1 && payments[0].orderId === o1?._id && orders.filter((o) => o.paymentState === 'unpaid').length === 2, `${payments.length} 笔`);
  check('离线日志全部接纳（3 单 + 交接 + 收款 + 出餐 = 6 条）', inbox.length === 6 && inbox.every((x) => x.status === 'accepted'), inbox.map((x) => x.status).join(','));
  const t1 = tokens.find((t) => t.number === order1.token);
  check('同一张牌最终属于第二张离线单（第一张出餐已释放）', t1?.state === 'held' && t1.orderId !== o1?._id && orders.some((o) => o._id === t1.orderId), JSON.stringify({ state: t1?.state }));

  // 重复补同步：UI 再点一次，并把本机全部离线日志原样重传给服务器 → 不重复入账
  await page(`if ([...document.querySelectorAll('button')].some((b) => !b.disabled && b.innerText.includes('立即同步'))) __click('立即同步'); await __sleep(4000);`);
  const events = await page(`
    const db = await new Promise((r, j) => { const q = indexedDB.open('hao-pos'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    const all = await new Promise((r, j) => { const q = db.transaction('outbox').objectStore('outbox').getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    db.close(); return all.sort((a, b) => a.sequence - b.sequence).map((x) => x.event);`);
  const resend = await callable('syncOfflineEvents', { events }, await idToken('cashier')).catch((e) => ({ error: String(e.message) }));
  const [orders2, payments2, inbox2] = [await fsList('orders'), await fsList('payments'), await fsList('offlineInbox')];
  check('D12 重复补同步（UI 再同步 + 原样重传 6 条）：订单、收款、日志都不增加', !resend.error && orders2.length === 3 && payments2.length === 1 && inbox2.length === 6,
    resend.error ?? `${orders2.length} 单 · ${payments2.length} 笔 · ${inbox2.length} 条 · ${(resend.results ?? []).map((r) => r.status).join(',')}`);

  // D05：尚未制作的离线单由收银核实后转电子厨单
  const routed = await page(`__click('厨师确认没做→转电子厨单'); await __waitFor('已转为电子厨单', 30000); return document.querySelector('[role=alert]')?.innerText ?? '';`);
  const tickets2 = await fsList('kitchenTickets');
  check('D05 收银核实后才转电子厨单（1 张）', tickets2.filter((t) => t.kitchenRouting === 'digital').length === 1, routed);

  // 恢复在线后可以继续在线接单（同一序号流）
  await goto('/pos');
  const online = await page(`
    await __waitFor('看图选餐', 15000);
    __click('黑酱面'); await __sleep(150); __click('加入本单'); await __sleep(200);
    ${SEND} await __waitFor('✓云端已接单', 40000);
    return document.body.innerText;`);
  check('补同步后在线接单正常（序号连续、待收款）', online.includes('✓ 云端已接单') && online.includes('待收款'), online.includes('✓ 云端已接单') ? '' : online.slice(0, 600).replace(/\s+/g, ' '));
} catch (e) {
  check('脚本异常', false, String(e?.stack ?? e));
} finally {
  ws?.close();
  chrome.kill();
  await pause(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/offline-e2e.json`, JSON.stringify({ ranAt: new Date().toISOString(), origin: ORIGIN, environment: '正式构建（Service Worker）+ 本机 Firebase Emulator，CDP 断网', results: log }, null, 2) + '\n');
  const failed = log.filter((x) => !x.ok).length;
  console.log(`\n${log.length - failed}/${log.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
