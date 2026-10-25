// 无依赖的 Chrome DevTools Protocol 小工具：启动无头 Chrome、执行脚本、截图、导出打印 PDF。
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export const HELPERS = `window.__click = (t, n = 0) => { const bs = [...document.querySelectorAll('button')].filter(b => !b.disabled && b.innerText.replace(/\\s+/g,'').includes(t)); if (!bs[n]) throw new Error('no button ' + t); bs[n].click(); };
  window.__has = (t) => document.body.innerText.replace(/\\s+/g,'').includes(t);
  window.__sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.__waitFor = async (t, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (__has(t)) return true; await __sleep(250); } return false; };`;

export async function openChrome(origin, { width = 1366, height = 900 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'hao-cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await pause(100); }
  }
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    send, evaluate,
    page: (expr) => evaluate(`${HELPERS}(async () => { ${expr} })()`),
    goto: async (path, waitMs = 3000) => { await send('Page.navigate', { url: origin + path }); await pause(waitMs); },
    screenshot: async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    pdf: async (opts) => Buffer.from((await send('Page.printToPDF', opts)).data, 'base64'),
    close: async () => {
      ws.close();
      chrome.kill();
      await pause(300);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 读取种子文件里的 Emulator 测试账号，避免在多处重复。 */
export async function account(role) {
  const seed = await readFile('functions/scripts/seed-emulator.ts', 'utf8');
  const m = seed.match(new RegExp(`email: '([^']+)', password: '([^']+)', role: '${role}'`));
  return { email: m[1], password: m[2] };
}

export async function login(tab, role) {
  const a = await account(role);
  return tab.page(`
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('#email'), ${JSON.stringify(a.email)});
    set(document.querySelector('#password'), ${JSON.stringify(a.password)});
    document.querySelector('form').requestSubmit();
    await __sleep(4000);
    return location.pathname;`);
}

// Emulator 地址默认与 firebase.json 一致；同机跑第二套 Emulator 验收时用 E2E_FIRESTORE / E2E_AUTH / E2E_FUNCTIONS 覆盖（host:port）。
const FS = `http://${process.env.E2E_FIRESTORE ?? '127.0.0.1:8080'}/v1/projects/demo-hao-wantan/databases/(default)/documents/stores/hao-pontian-main`;
// Firestore REST 值 → JS 值；嵌套的 map / array 递归解码（例如 cancelRejection、writeOff）。
const decode = (v) => {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(decode);
  return v;
};

/** Emulator REST（owner 令牌绕过 Rules，仅本机测试用）。 */
export async function fsList(collection) {
  const r = await (await fetch(`${FS}/${collection}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })).json();
  return (r.documents ?? []).map((d) => ({ _id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decode(v)])) }));
}

export async function fsPatch(path, fields) {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&');
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }])) };
  const r = await fetch(`${FS}/${path}?${mask}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`patch ${path}: ${r.status}`);
}

const AUTH = `http://${process.env.E2E_AUTH ?? '127.0.0.1:9099'}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`;
const FN = `http://${process.env.E2E_FUNCTIONS ?? '127.0.0.1:5001'}/demo-hao-wantan/asia-southeast1`;

/** 以测试账号在 Auth Emulator 登录，取得 ID token。 */
export async function idToken(role) {
  const a = await account(role);
  const r = await (await fetch(AUTH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: a.email, password: a.password, returnSecureToken: true }) })).json();
  if (!r.idToken) throw new Error(`登录失败 ${role}`);
  return r.idToken;
}

/** 按 Callable 协议直接调用 Functions Emulator（与浏览器 SDK 走同一套认证与校验）。 */
export async function callable(name, data, token) {
  const r = await (await fetch(`${FN}/${name}Cmd`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ data: { storeId: 'hao-pontian-main', ...data } }) })).json();
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
}

export async function fsGet(path) {
  const r = await (await fetch(`${FS}/${path}`, { headers: { Authorization: 'Bearer owner' } })).json();
  return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, decode(v)])) : null;
}
