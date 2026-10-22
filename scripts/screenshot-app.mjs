// 真实应用截图（不是设计稿）：无头 Chrome 登录本机 Emulator 测试账号，按多个视口截图并检查横向溢出。
// 前提：npm run emulators、npm run emulators:seed、npm run dev 已在运行，且已有一台主收银设备。
// 用法：REGISTER_DEVICE_ID=dev-... node scripts/screenshot-app.mjs
// 无 npm 依赖；Chrome 路径可用 CHROME_PATH 覆盖。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SHOT_OUT || 'docs/screenshots/app';
const PORT = process.env.APP_PORT || '3000';
const DEVICE_ID = process.env.REGISTER_DEVICE_ID;
if (!DEVICE_ID) throw new Error('需要 REGISTER_DEVICE_ID（设备页显示的主收银机设备 ID）');

// 测试账号只存在于本机 Auth Emulator，读取种子文件，避免在多处重复。
const seed = await readFile('functions/scripts/seed-emulator.ts', 'utf8');
const account = (role) => {
  const m = seed.match(new RegExp(`email: '([^']+)', password: '([^']+)', role: '${role}'`));
  if (!m) throw new Error(`种子文件中找不到 ${role}`);
  return { email: m[1], password: m[2] };
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(origin, fn) {
  const profile = await mkdtemp(join(tmpdir(), 'hao-shot-'));
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
    const goto = async (path) => { await send('Page.navigate', { url: origin + path }); await pause(2500); };
    const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    const shot = async (name, width, height) => {
      await viewport(width, height);
      await pause(900);
      const { scrollWidth, clientWidth } = await evaluate('({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})');
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
      return { name, width, height, horizontalOverflowPx: scrollWidth - clientWidth };
    };
    await send('Page.enable');
    await send('Runtime.enable');
    return await fn({ send, evaluate, goto, viewport, shot });
  } finally {
    ws?.close();
    chrome.kill();
    await pause(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

const LOGIN = (a) => `(async () => {
  const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  set(document.querySelector('#email'), ${JSON.stringify(a.email)});
  set(document.querySelector('#password'), ${JSON.stringify(a.password)});
  document.querySelector('form').requestSubmit();
  await new Promise((r) => setTimeout(r, 3500));
  return location.pathname;
})()`;

const CLICK = `window.__click = (t, n = 0) => { const bs = [...document.querySelectorAll('button')].filter(b => b.innerText.replace(/\\s+/g,'').includes(t)); if (!bs[n]) throw new Error('no button ' + t); bs[n].click(); };
window.__sleep = (ms) => new Promise(r => setTimeout(r, ms));`;

// 先让应用打开一次以完成数据库升级，再写入测试用的主收银设备 ID。
const SET_DEVICE = `(async () => {
  const db = await new Promise((r, j) => { const q = indexedDB.open('hao-pos'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  await new Promise((r, j) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(${JSON.stringify(DEVICE_ID)}, 'deviceId'); tx.oncomplete = r; tx.onerror = () => j(tx.error); });
  db.close();
  return true;
})()`;

await mkdir(OUT, { recursive: true });
const results = [];

await session(`http://localhost:${PORT}`, async ({ evaluate, goto, shot }) => {
  await goto('/login');
  await evaluate(SET_DEVICE); // 测试用：让无头浏览器使用已指定的主收银设备 ID
  await goto('/login');
  results.push({ step: 'cashier-login', path: await evaluate(LOGIN(account('cashier'))) });
  await goto('/pos');
  await evaluate(`${CLICK}(async () => {
    __click('红酱面'); await __sleep(80); __click('面薄'); await __sleep(80); __click('1½'); await __sleep(80); __click('少辣'); await __sleep(80);
    if (![...document.querySelectorAll('button')].some(b => b.innerText.includes('走青'))) { __click('其他要求'); await __sleep(120); }
    __click('走青'); await __sleep(80); __click('加入本单'); await __sleep(120);
    __click('云吞汤面'); await __sleep(80);
    if (![...document.querySelectorAll('button')].some(b => b.innerText.includes('净面'))) { __click('其他要求'); await __sleep(120); }
    __click('净面'); await __sleep(80); __click('加入本单'); await __sleep(120);
    __click('黑酱面'); await __sleep(80);
  })()`);
  for (const [w, h] of [[1366, 900], [1024, 768], [768, 1024], [390, 844]]) results.push(await shot(`pos-${w}x${h}`, w, h));
  await evaluate(`${CLICK}(async () => { __click('收款RM'); await __sleep(300); __click('RM20'); await __sleep(150); })()`);
  results.push(await shot('pos-payment-1366x900', 1366, 900));
  results.push(await shot('pos-payment-390x844', 390, 844));
  await goto('/orders');
  results.push(await shot('orders-1366x900', 1366, 900));
  results.push(await shot('orders-390x844', 390, 844));
});

await session(`http://127.0.0.1:${PORT}`, async ({ evaluate, goto, shot }) => {
  await goto('/login');
  results.push({ step: 'kitchen-login', path: await evaluate(LOGIN(account('kitchen'))) });
  await goto('/kitchen');
  for (const [w, h] of [[1920, 1080], [1366, 900], [1024, 768]]) results.push(await shot(`kds-${w}x${h}`, w, h));
});

await writeFile(`${OUT}/screenshots.json`, JSON.stringify({ capturedAt: new Date().toISOString(), environment: '本机 Firebase Emulator（demo-hao-wantan）+ Vite 开发服务器，测试数据', results }, null, 2) + '\n');
console.log(JSON.stringify(results, null, 1));
