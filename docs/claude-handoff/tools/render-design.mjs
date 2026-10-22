// Document rendering/QA only; Node 22+ and local Chrome, no npm dependencies.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = await mkdtemp(join(tmpdir(), 'wantan-design-'));
const chrome = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(r => setTimeout(r, ms));
let socket;
let nextId = 0;
const pending = new Map();
const events = new Map();
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await pause(100); }
  }
  if (!port) throw new Error('Chrome debugging port unavailable');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(x => x.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const wait = pending.get(message.id);
      if (!wait) return;
      clearTimeout(wait.timeout);
      pending.delete(message.id);
      message.error ? wait.reject(new Error(JSON.stringify(message.error))) : wait.resolve(message.result);
    } else if (events.has(message.method)) {
      for (const listener of events.get(message.method)) listener(message.params);
      events.delete(message.method);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const eventOnce = name => new Promise(resolve => events.set(name, [resolve]));
  await send('Page.enable');
  const checks = [];
  const scenarios = [
    { view: 'pos', width: 1456, height: 1100, file: 'pos.png' },
    { view: 'kds', width: 1456, height: 1100, file: 'kds.png' },
    { view: 'owner', width: 1456, height: 1100, file: 'owner.png' },
    { view: 'mobile', width: 390, height: 844, file: 'mobile.png' },
    { view: 'cards', width: 1456, height: 1100, file: 'cards.png' },
    { view: 'pos', width: 1024, height: 768, file: null },
    { view: 'pos', width: 768, height: 1024, file: null },
    { view: 'kds', width: 1920, height: 1080, file: null },
  ];
  for (const scenario of scenarios) {
    await send('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: scenario.view === 'mobile' });
    const ready = eventOnce('Page.loadEventFired');
    await send('Page.navigate', { url: pathToFileURL(join(root, 'visuals', '设计预览.html')).href + `?view=${scenario.view}` });
    await ready;
    await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
    await pause(180);
    const result = await send('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{const el=document.querySelector('#${scenario.view}');const r=el.getBoundingClientRect();return {view:document.documentElement.dataset.view,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,boardWidth:r.width,boardLeft:r.left,foodTiles:el.querySelectorAll('.food').length,unresolvedSymbols:[...el.querySelectorAll('use')].map(n=>n.getAttribute('href')).filter(h=>!document.querySelector(h))}})())`,
      returnByValue: true,
    });
    const check = JSON.parse(result.result.value);
    check.height = scenario.height;
    checks.push(check);
    if (check.scrollWidth > check.width) throw new Error(`Horizontal overflow: ${JSON.stringify(check)}`);
    if (check.unresolvedSymbols.length) throw new Error(`Missing SVG symbols: ${JSON.stringify(check)}`);
    if (scenario.file) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: scenario.width, height: check.pageHeight, scale: 1 } });
      await writeFile(join(root, 'visuals', scenario.file), Buffer.from(screenshot.data, 'base64'));
    }
  }
  await writeFile(join(root, 'visuals', 'render-checks.json'), JSON.stringify({ type: 'static-design-rendering-only', scenarios: checks }, null, 2));
  console.log(JSON.stringify(checks, null, 2));
} finally {
  for (const p of pending.values()) clearTimeout(p.timeout);
  if (socket) socket.close();
  chrome.kill();
}
