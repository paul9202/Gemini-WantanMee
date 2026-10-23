// 2026-10-23 新版 UI 的真实应用截图与布局检查（不是设计稿）。
// 流程：老板指定主收银机并开班 → 通过点餐页真实下 6 单（含净面、多项特殊要求、打包）→ 后厨屏开始/出餐 →
// 在 390×844 ~ 1920×1080 的多个视口截图，检查横向溢出与主操作按钮是否同屏。
// 前提：干净的 Emulator 已启动并 seed；VITE_USE_EMULATORS=true 构建后在 4173 端口 vite preview。
// 用法：node scripts/ui-2026-10-23-shots.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { login, openChrome, pause } from './lib/cdp.mjs';

const OUT = 'docs/screenshots/ui-2026-10-23';
await mkdir(OUT, { recursive: true });
const results = [];
const VIEWPORTS = { phone: [390, 844], tablet: [768, 1024], tabletL: [1024, 768], laptop: [1366, 900], wide: [1600, 1120], fhd: [1920, 1080] };

async function shot(tab, name, [width, height]) {
  await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  await pause(900);
  const m = await tab.page(`
    const de = document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    // 后厨主操作：所有动作按钮是否完整位于视口内。
    const acts = [...document.querySelectorAll('article button')].filter((b) => /开始制作|完成出餐|Start|Served/.test(b.innerText));
    const visible = acts.filter((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }).length;
    return { overflow, actions: acts.length, actionsVisible: visible };`);
  await writeFile(`${OUT}/${name}.png`, await tab.screenshot());
  results.push({ name, width, height, ...m });
  console.log(`${name} ${width}x${height} overflow=${m.overflow}px actions=${m.actionsVisible}/${m.actions}`);
}

const pos = await openChrome('http://localhost:4173', { width: 1600, height: 1120 });
const kds = await openChrome('http://127.0.0.1:4173', { width: 1600, height: 1120 });
try {
  await pos.goto('/login');
  await login(pos, 'owner');
  await pos.goto('/device');
  await pos.page(`await __waitFor('设为主收银机'); for (let i = 0; i < 60 && ![...document.querySelectorAll('button')].some((b) => !b.disabled && b.innerText.includes('设为主收银机')); i++) await __sleep(250); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await pos.goto('/pos');
  await pos.page(`if (await __waitFor('确认开班', 8000)) __click('确认开班'); await __waitFor('看图选餐', 25000);`);
  await kds.goto('/login');
  await login(kds, 'kitchen');
  await pause(2000);

  // 真实下单：每一步都点界面按钮，收款走 createOrder 命令。
  const order = (steps, service) => pos.page(`
    const tile = (n) => document.querySelector('button[aria-label="' + n + '"]').click();
    __click(${JSON.stringify(service)}); await __sleep(150);
    for (const s of ${JSON.stringify(steps)}) { if (s.startsWith('tile:')) tile(s.slice(5)); else if (s.startsWith('exact:')) [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === s.slice(6)).click(); else if (s === 'MORE') { const b = [...document.querySelectorAll('button[aria-expanded]')].find((x) => x.innerText.includes('更多配料')); if (b.getAttribute('aria-expanded') === 'false') b.click(); } else if (s === 'ADD') { __click('加入本单'); } else __click(s); await __sleep(200); }
    __click('收款RM'); await __sleep(500); __click('刚好'); await __sleep(200); __click('确认收款并接单');
    await __waitFor('把这张餐牌交给客人', 40000); await __sleep(600);
    const t = document.querySelector('[role=dialog]').innerText; __click('下一单'); await __sleep(300); return t.split('\\n').slice(0, 3).join(' ');`);
  console.log(await order(['tile:黑酱面', '面薄', '1½', '少辣', '走青', 'ADD'], '堂食'));
  console.log(await order(['tile:红酱面', '细面', '加3粒', 'ADD'], '打包'));
  console.log(await order(['tile:云吞汤面', '细面', '2大', 'ADD'], '堂食'));
  console.log(await order(['tile:白酱面', '面薄', '无油渣', 'MORE', '多葱', 'ADD'], '打包'));
  console.log(await order(['tile:黑酱面', '细面', 'MORE', '净面·半价', '不辣', 'ADD'], '堂食'));
  console.log(await order(['tile:干捞云吞', 'exact:红酱', '加辣', 'ADD'], '打包'));

  // 后厨：开始 2 单，让「制作中」也有内容；待做 4 单。
  await kds.goto('/kitchen', 4000);
  await kds.page(`await __waitFor('开始制作', 20000); for (const n of [1, 2]) { const a = document.querySelector('article[aria-label="' + n + '号"]'); [...a.querySelectorAll('button')].pop().click(); for (let i = 0; i < 40 && !document.querySelector('section[aria-label="制作中"] article[aria-label="' + n + '号"]'); i++) await __sleep(250); await __sleep(800); } return 1;`);
  await pause(2500);
  for (const [k, v] of Object.entries(VIEWPORTS)) await shot(kds, `kitchen-${k}`, v);
  await kds.page(`document.querySelector('button[aria-label="切换浅色"]').click(); return 1;`);
  await shot(kds, 'kitchen-light-wide', VIEWPORTS.wide);
  await kds.page(`document.querySelector('button[aria-label="切换深色"]').click(); return 1;`);
  // 断网冻结：用 CDP 切断页面网络（真实断网，不是改布尔值）。
  await kds.send('Network.enable');
  await kds.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await pause(3000);
  await shot(kds, 'kitchen-offline-wide', VIEWPORTS.wide);
  const frozen = await kds.page(`return { banner: __has('厨房连接中断，操作已暂停'), allDisabled: [...document.querySelectorAll('article button')].every((b) => b.disabled) };`);
  results.push({ name: 'kitchen-offline-freeze', ...frozen });
  await kds.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // 补充场景：多餐品、多项特殊要求的单（超过 6 单时允许滚动）。
  console.log(await order(['tile:白酱面', '面薄', '无油渣', 'MORE', '多葱', 'ADD', 'tile:云吞汤', '15', 'ADD', 'tile:红酱面', '细面', '加3粒', '加叉烧', '走青', 'ADD'], '打包'));
  await pause(4000);
  await shot(kds, 'kitchen-busy-fhd', VIEWPORTS.fhd);

  // 前台：点餐（配置中途状态 + 本单有内容）、收款弹窗、结果弹窗。
  await pos.page(`document.querySelector('button[aria-label="黑酱面"]').click(); await __sleep(150); __click('面薄'); await __sleep(150); __click('少辣'); __click('加入本单'); await __sleep(200);
    document.querySelector('button[aria-label="云吞汤"]').click(); await __sleep(200); __click('加入本单'); await __sleep(200); document.querySelector('button[aria-label="红酱面"]').click(); await __sleep(200); return 1;`);
  for (const [k, v] of Object.entries(VIEWPORTS)) if (k !== 'fhd') await shot(pos, `pos-${k}`, v);
  await pos.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1120, deviceScaleFactor: 1, mobile: false });
  await pos.page(`__click('收款RM'); await __sleep(500); __click('RM20'); await __sleep(300); return 1;`);
  await shot(pos, 'payment-cash-wide', VIEWPORTS.wide);
  await shot(pos, 'payment-cash-phone', VIEWPORTS.phone);
  await pos.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1120, deviceScaleFactor: 1, mobile: false });
  await pos.page(`__click('确认收款并接单'); await __waitFor('把这张餐牌交给客人', 40000); await __waitFor('✓后厨已收到', 20000); await __sleep(500); return 1;`);
  await shot(pos, 'payment-result-wide', VIEWPORTS.wide);
  await pos.page(`__click('下一单'); return 1;`);

  for (const [path, name] of [['/orders', 'orders'], ['/owner', 'owner'], ['/device', 'device']]) {
    await pos.goto(path, 4500);
    await shot(pos, `${name}-wide`, VIEWPORTS.wide);
    await shot(pos, `${name}-phone`, VIEWPORTS.phone);
  }
  // 英文：同一套布局，一次只显示一种语言。
  await pos.page(`localStorage.setItem('hao-lang', 'en'); return 1;`);
  await pos.goto('/pos', 4500);
  await shot(pos, 'pos-en-laptop', VIEWPORTS.laptop);
  await kds.page(`localStorage.setItem('hao-lang', 'en'); return 1;`);
  await kds.goto('/kitchen', 5000);
  await shot(kds, 'kitchen-en-wide', VIEWPORTS.wide);
} catch (e) {
  console.error('FAIL', e);
  results.push({ name: 'script-error', error: String(e) });
} finally {
  await writeFile(`${OUT}/ui-shots.json`, JSON.stringify({ at: new Date().toISOString(), env: 'local Firebase Emulator + vite preview (VITE_USE_EMULATORS=true)', results }, null, 2));
  await pos.close();
  await kds.close();
}
