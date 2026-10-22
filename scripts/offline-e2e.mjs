// 真断网端到端验证（04 §4）：正式构建 + Service Worker + 本机 Emulator，用 CDP 切断页面网络（不是改布尔值）。
// 前提：Emulator 已启动并执行过 npm run emulators:seed；用 VITE_USE_EMULATORS=true 构建 dist，并在 4173 端口 vite preview。
// 用法：node scripts/offline-e2e.mjs
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.E2E_ORIGIN || 'http://localhost:4173';
const OUT = 'docs/screenshots/offline';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-hao-wantan/databases/(default)/documents/stores/hao-pontian-main';
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

// Emulator REST（owner 令牌在 Emulator 中绕过 Rules，仅本机测试用）
async function fsList(collection) {
  const r = await (await fetch(`${FS}/${collection}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })).json();
  return (r.documents ?? []).map((d) => {
    const out = {};
    for (const [k, v] of Object.entries(d.fields ?? {})) out[k] = v.stringValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : v.booleanValue ?? v.nullValue ?? v);
    return out;
  });
}

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
  check('老板登录', (await login('owner')) === '/pos');
  await goto('/device');
  await page(`await __waitFor('设为主收银机'); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
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
  const order1 = await page(`
    __click('红酱面'); await __sleep(150); __click('加入本单'); await __sleep(200);
    const token = Number(document.querySelector('aside h2').innerText.match(/(\\d+)/)[1]);
    __click('收款RM'); await __sleep(400); __click('刚好'); await __sleep(200); __click('确认收款·本机接单'); await __sleep(1500);
    return { token, text: document.querySelector('aside').innerText };`);
  check('D01 断网现金接单：本机已接单、显示临时号与人工传单', order1.text.includes('本机已接单') && /O-F\d+-\d{4}/.test(order1.text) && order1.text.includes('请人工传单'), `餐牌 ${order1.token}`);
  await shot('offline-pos-accepted');
  await page(`__click('我已把单交给厨师'); await __sleep(800);`);
  check('人工交接已记录', await page(`return __has('已人工交接');`));

  // 断网刷新（模拟关闭浏览器后重开）
  await send('Page.reload', { ignoreCache: false });
  await pause(6000);
  const afterReload = await page(`await __waitFor('离线营业', 20000); return document.body.innerText;`);
  check('D01 断网刷新：应用从 Service Worker 载入，仍为离线营业', afterReload.includes('离线营业') && afterReload.includes('看图选餐'));
  await goto('/sync');
  const syncText = await page(`await __waitFor('本机离线单', 15000); return document.querySelector('main').innerText;`);
  check('D01 刷新后本机订单与日志都在', syncText.includes(`未同步 2 条`) && /O-F\d+-\d{4}/.test(syncText), syncText.match(/未同步 \d+ 条/)?.[0]);
  await shot('offline-sync-center');

  // 人工出餐 → 实体牌收回 → 同牌新单（D03）
  await page(`__click('已人工出餐'); await __sleep(800); __click('实体牌已收回'); await __sleep(800);`);
  await goto('/pos');
  await page(`await __waitFor('看图选餐', 20000);`);
  const order2 = await page(`
    document.querySelector('button[aria-label^="${order1.token}号"]') || null;
    __click('餐牌'); await __sleep(400);
    const btn = document.querySelector('button[aria-label^="${order1.token}号"]');
    const state = btn.getAttribute('aria-label');
    btn.click(); await __sleep(300);
    __click('云吞汤'); await __sleep(150); __click('加入本单'); await __sleep(200);
    __click('收款RM'); await __sleep(400); __click('刚好'); await __sleep(200); __click('确认收款·本机接单'); await __sleep(1500);
    return { state, text: document.querySelector('aside').innerText };`);
  check('D03 回收后同一张牌可再离线接单', order2.state.includes('可用') && order2.text.includes('本机已接单'), order2.state);
  const order3 = await page(`
    __click('白酱面'); await __sleep(150); __click('加入本单'); await __sleep(200);
    __click('收款RM'); await __sleep(400); __click('刚好'); await __sleep(200); __click('确认收款·本机接单'); await __sleep(1500);
    return document.querySelector('aside').innerText.match(/(\\d+)号 · 临时号/)?.[1];`);
  check('第三张离线单（尚未制作）', Boolean(order3), `餐牌 ${order3}`);
  const qrBlocked = await page(`
    __click('黑酱面'); await __sleep(150); __click('加入本单'); await __sleep(200);
    __click('收款RM'); await __sleep(400); __click('DuitNowQR'); await __sleep(200);
    document.querySelector('[aria-label="收款"] input[type=checkbox]').click(); await __sleep(200);
    const disabled = [...document.querySelectorAll('button')].find(b => b.innerText.includes('确认收款')).disabled;
    __click('返回'); await __sleep(200);
    return disabled;`);
  check('D11 断网 QR 无外部核实说明不能确认', qrBlocked === true);

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
  check('D04 云端 3 张离线单、无重复', orders.length === 3 && orders.every((o) => o.source === 'offline'), `${orders.length} 单`);
  check('补同步不送厨：电子厨单为 0', tickets.filter((t) => t.kitchenRouting === 'digital').length === 0);
  check('已人工出餐的单导入为已出餐', orders.filter((o) => o.fulfillmentStatus === 'served').length === 1);
  check('离线日志全部接纳（3 单 + 交接 + 出餐 + 回收 = 6 条）', inbox.length === 6 && inbox.every((x) => x.status === 'accepted'), inbox.map((x) => x.status).join(','));
  const t1 = tokens.find((t) => t.number === order1.token);
  check('同一张牌最终属于第二张离线单', t1?.state === 'held' && orders.some((o) => o.id === t1.orderId && o.items), JSON.stringify({ state: t1?.state }));

  // D05：尚未制作的离线单由收银核实后转电子厨单
  const routed = await page(`__click('厨师确认没做→转电子厨单'); await __waitFor('已转为电子厨单', 30000); return document.querySelector('[role=alert]')?.innerText ?? '';`);
  const tickets2 = await fsList('kitchenTickets');
  check('D05 收银核实后才转电子厨单（1 张）', tickets2.filter((t) => t.kitchenRouting === 'digital').length === 1, routed);

  // 恢复在线后可以继续在线接单（同一序号流）
  await goto('/pos');
  const online = await page(`
    await __waitFor('看图选餐', 15000);
    __click('黑酱面'); await __sleep(150); __click('加入本单'); await __sleep(200);
    __click('收款RM'); await __sleep(400); __click('刚好'); await __sleep(200); __click('确认收款并接单'); await __waitFor('✓云端已接单', 40000);
    return document.body.innerText;`);
  check('补同步后在线接单正常（序号连续）', online.includes('✓ 云端已接单'), online.includes('✓ 云端已接单') ? '' : online.slice(0, 600).replace(/\s+/g, ' '));
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
