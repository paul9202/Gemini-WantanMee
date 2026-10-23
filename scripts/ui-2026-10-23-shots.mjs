// 2026-10-23 新版 UI 的真实应用截图与布局检查（不是设计稿）。
// 流程：老板指定主收银机并开班（无备用金）→ 通过点餐页真实「下单送厨」6 单（含净面、多项特殊要求、打包；不收款）→
// 后厨屏单一「制作中 / 待出餐」区（接单即制作，无开始制作）→ 结果弹窗收款区、收款码、待登记收款抽屉 →
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

  // 真实下单：每一步都点界面按钮，「下单送厨」走 createOrder 命令（不收款，订单待收款）。
  const order = (steps, service) => pos.page(`
    const tile = (n) => document.querySelector('button[aria-label="' + n + '"]').click();
    __click(${JSON.stringify(service)}); await __sleep(150);
    for (const s of ${JSON.stringify(steps)}) { if (s.startsWith('tile:')) tile(s.slice(5)); else if (s.startsWith('exact:')) [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === s.slice(6)).click(); else if (s === 'MORE') { const b = [...document.querySelectorAll('button[aria-expanded]')].find((x) => x.innerText.includes('更多配料')); if (b.getAttribute('aria-expanded') === 'false') b.click(); } else if (s === 'ADD') { __click('加入本单'); } else __click(s); await __sleep(200); }
    [...document.querySelectorAll('aside[aria-label="本单"] button')].find((b) => b.innerText.includes('下单送厨')).click();
    await __waitFor('把这张餐牌交给客人', 40000); await __sleep(600);
    const t = document.querySelector('[role=dialog]').innerText; __click('下一单'); await __sleep(300); return t.split('\\n').slice(0, 3).join(' ');`);
  console.log(await order(['tile:黑酱面', '面薄', '1½', '少辣', '走青', 'ADD'], '堂食'));
  console.log(await order(['tile:红酱面', '细面', '加3粒', 'ADD'], '打包'));
  console.log(await order(['tile:云吞汤面', '细面', '2大', 'ADD'], '堂食'));
  console.log(await order(['tile:白酱面', '面薄', '无油渣', 'MORE', '多葱', 'ADD'], '打包'));
  console.log(await order(['tile:黑酱面', '细面', 'MORE', '净面·半价', '不辣', 'ADD'], '堂食'));
  console.log(await order(['tile:干捞云吞', 'exact:红酱', '加辣', 'ADD'], '打包'));

  // 后厨：新单接单即制作中，单一「制作中 / 待出餐」工作区，没有「开始制作」。
  await kds.goto('/kitchen', 4000);
  const kInfo = await kds.page(`await __waitFor('完成出餐', 20000); await __sleep(800); return { cards: document.querySelectorAll('section[aria-label="制作中 / 待出餐"] article').length, start: [...document.querySelectorAll('button')].some((b) => b.innerText.includes('开始制作')) };`);
  results.push({ name: 'kitchen-single-work-area', ...kInfo });
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
  await pos.page(`__click('加入本单'); await __sleep(300); [...document.querySelectorAll('aside[aria-label="本单"] button')].find((b) => b.innerText.includes('下单送厨')).click();
    await __waitFor('把这张餐牌交给客人', 40000); await __waitFor('✓后厨已收到', 20000); await __sleep(500); return 1;`);
  // 结果弹窗：订单已保存 + 三个独立事实 + 待收款区（确认已收款 / 显示收款码）。
  await shot(pos, 'result-quickpay-wide', VIEWPORTS.wide);
  await shot(pos, 'result-quickpay-phone', VIEWPORTS.phone);
  await pos.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1120, deviceScaleFactor: 1, mobile: false });
  await pos.page(`__click('显示收款码'); await __sleep(1200); return 1;`);
  await shot(pos, 'qr-wide', VIEWPORTS.wide);
  await shot(pos, 'qr-phone', VIEWPORTS.phone);
  await pos.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1120, deviceScaleFactor: 1, mobile: false });
  await pos.page(`__click('关闭（订单仍待收款）'); await __sleep(300); __click('下一单'); await __sleep(300); __click('待登记收款'); await __sleep(1000); return 1;`);
  await shot(pos, 'pending-payments-wide', VIEWPORTS.wide);
  await shot(pos, 'pending-payments-phone', VIEWPORTS.phone);
  await pos.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1120, deviceScaleFactor: 1, mobile: false });
  await pos.page(`[...document.querySelectorAll('[role=dialog][aria-label="待登记收款"] header button')].pop().click(); await __sleep(300); return 1;`);

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
  // 汇总：每张截图无横向溢出；后厨单一工作区且无开始制作；断网冻结。
  const rules = [
    ...results.filter((r) => 'overflow' in r).map((r) => [`${r.name} 无横向溢出`, r.overflow === 0, `${r.overflow}px`]),
    ['后厨单一工作区、无「开始制作」', results.find((r) => r.name === 'kitchen-single-work-area')?.start === false],
    ['后厨断网：横条 + 全部按钮禁用', (() => { const f = results.find((r) => r.name === 'kitchen-offline-freeze'); return f?.banner && f.allDisabled; })()],
  ];
  for (const [name, ok, detail] of rules) if (!ok) console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  const failed = rules.filter((x) => !x[1]).length;
  console.log(`
${rules.length - failed}/${rules.length} passed`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('FAIL', e);
  process.exitCode = 1;
  results.push({ name: 'script-error', error: String(e) });
} finally {
  await writeFile(`${OUT}/ui-shots.json`, JSON.stringify({ at: new Date().toISOString(), env: 'local Firebase Emulator + vite preview (VITE_USE_EMULATORS=true)', results }, null, 2));
  await pos.close();
  await kds.close();
}
