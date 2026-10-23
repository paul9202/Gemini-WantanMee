// 档口平板到货前的预检（DEVICE-BASELINE）。以下视口全部是「候选」开发覆盖尺寸，不是 REDMI Pad 2 已测量的 CSS 视口：
// 2048×1280 是硬件像素，实际 viewport 取决于 DPR、系统显示大小、浏览器工具栏 / PWA 与键盘，到货后必须实测替换。
// 每个视口：触控模拟 + Android 平板 UA，真实下单 → 收款 → 后厨回执，截图并检查横向溢出、小于 56px 的触控目标、
// 本单是否可见、收款弹窗的实收 / 找零 / 确认 / 关闭是否在可见区域内。
// 前提：干净的 Emulator 已启动并 seed；VITE_USE_EMULATORS=true 构建后在 4173 端口 vite preview。
// 用法：node scripts/tablet-preflight.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { login, openChrome, pause } from './lib/cdp.mjs';

const OUT = 'docs/screenshots/tablet-preflight';
await mkdir(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Linux; Android 15; 25040RP0AG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** 候选 profile：label 说明来源假设；都需要实机测量后替换。 */
const PROFILES = [
  { id: 'L960x600', w: 960, h: 600, dpr: 2.133, label: '横屏候选：2048÷DPR 2.133，PWA 全屏' },
  { id: 'L960x536', w: 960, h: 536, dpr: 2.133, label: '横屏候选：同上，扣除 Chrome 地址栏约 64px' },
  { id: 'L1024x640', w: 1024, h: 640, dpr: 2, label: '横屏候选：DPR 2' },
  { id: 'L1280x800', w: 1280, h: 800, dpr: 1.6, label: '横屏候选：DPR 1.6，PWA 全屏' },
  { id: 'L1280x736', w: 1280, h: 736, dpr: 1.6, label: '横屏候选：同上，扣除地址栏' },
  { id: 'P600x960', w: 600, h: 960, dpr: 2.133, label: '竖屏候选：DPR 2.133' },
  { id: 'P800x1216', w: 800, h: 1216, dpr: 1.6, label: '竖屏候选：DPR 1.6，扣除地址栏' },
];
/** 软键盘展开（interactive-widget=resizes-content 时视口变矮）的近似高度。 */
const KEYBOARD = [
  { id: 'L960x600-kb', w: 960, h: 300, dpr: 2.133, label: '横屏键盘展开近似：可用高度约 300px' },
  { id: 'L1280x800-kb', w: 1280, h: 430, dpr: 1.6, label: '横屏键盘展开近似：可用高度约 430px' },
  { id: 'P600x960-kb', w: 600, h: 560, dpr: 2.133, label: '竖屏键盘展开近似' },
];

const results = [];
const setProfile = async (tab, p) => {
  await tab.send('Emulation.setDeviceMetricsOverride', { width: p.w, height: p.h, deviceScaleFactor: p.dpr, mobile: true, screenOrientation: p.w > p.h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await tab.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
  await pause(900);
};

/** 页面内检查：溢出、小触控目标（可见、可点击、未禁用，高 < 56 或宽 < 44）。 */
const MEASURE = `
  const de = document.documentElement;
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  const inView = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 && r.width > 0; };
  const targets = [...document.querySelectorAll('button, [role=radio], summary, input[type=checkbox], label:has(input[type=checkbox])')].filter((b) => !b.disabled && vis(b) && !b.closest('[aria-hidden=true]'));
  const small = targets.filter((b) => { const r = b.getBoundingClientRect(); return r.height < 55.5 || r.width < 44; })
    .map((b) => (b.innerText || b.getAttribute('aria-label') || b.tagName).replace(/\\s+/g, ' ').trim().slice(0, 24) + ' ' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height));
  const cart = document.querySelector('aside[aria-label="本单"]');
  return { overflow: de.scrollWidth - de.clientWidth, targets: targets.length, small: small.length, smallSamples: small.slice(0, 8),
    cartVisible: cart ? cart.getBoundingClientRect().width > 0 : null, cartEntry: [...document.querySelectorAll('button')].some((b) => /本单[\\s\\S]*查看/.test(b.innerText)),
    payConfirmInView: inView([...document.querySelectorAll('[role=dialog] button')].find((b) => /确认收款|Confirm payment/.test(b.innerText))),
    paySummaryInView: inView(document.querySelector('[data-testid=pay-summary]')),
    payCloseInView: inView(document.querySelector('[role=dialog] button')),
  };`;

async function shot(tab, profile, page) {
  const m = await tab.page(MEASURE);
  const name = `${profile.id}-${page}`;
  await writeFile(`${OUT}/${name}.png`, await tab.screenshot());
  results.push({ profile: profile.id, viewport: `${profile.w}x${profile.h}`, dpr: profile.dpr, assumption: profile.label, page, ...m });
  console.log(`${name} overflow=${m.overflow} small=${m.small}/${m.targets} cart=${m.cartVisible} entry=${m.cartEntry} pay=${m.payConfirmInView}/${m.paySummaryInView}/${m.payCloseInView}`);
}

const pos = await openChrome('http://localhost:4173', { width: 1280, height: 800 });
const kds = await openChrome('http://127.0.0.1:4173', { width: 1280, height: 800 });
try {
  await pos.goto('/login');
  await login(pos, 'owner');
  await pos.goto('/device');
  await pos.page(`await __waitFor('设为主收银机'); for (let i = 0; i < 60 && ![...document.querySelectorAll('button')].some((b) => !b.disabled && b.innerText.includes('设为主收银机')); i++) await __sleep(250); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await pos.goto('/pos');
  await pos.page(`if (await __waitFor('确认开班', 8000)) __click('确认开班'); await __waitFor('看图选餐', 25000);`);
  await kds.goto('/login');
  await login(kds, 'kitchen');

  const tile = (n) => `document.querySelector('button[aria-label="${n}"]').click(); await __sleep(200);`;
  const fillCart = () => pos.page(`
    ${tile('黑酱面')} __click('面薄'); await __sleep(120); __click('少辣'); await __sleep(120); __click('走青'); await __sleep(120); __click('加叉烧'); await __sleep(120); __click('加入本单'); await __sleep(250);
    ${tile('云吞汤')} __click('加入本单'); await __sleep(250);
    ${tile('红酱面')} __click('加3粒'); await __sleep(120); __click('无油渣'); await __sleep(120); __click('加入本单'); await __sleep(250);
    return document.querySelectorAll('aside[aria-label="本单"] li').length;`);

  let first = true;
  for (const p of PROFILES) {
    await setProfile(pos, p);
    await pos.goto('/pos', 3500);
    await pos.page(`await __waitFor('看图选餐', 20000); return 1;`);
    await fillCart();
    await shot(pos, p, 'pos');
    // 编辑一行：保持原行，取消后不变。
    const edit = await pos.page(`
      const before = document.querySelector('aside[aria-label="本单"] ul')?.innerText;
      const b = [...document.querySelectorAll('aside[aria-label="本单"] button')].find((x) => x.innerText.trim() === '编辑'); if (b) b.click(); await __sleep(300);
      ${tile('白酱面')} const mid = document.querySelector('aside[aria-label="本单"] ul')?.innerText;
      __click('取消修改'); await __sleep(300);
      const after = document.querySelector('aside[aria-label="本单"] ul')?.innerText;
      return { keptAfterCancel: before === after, unchangedWhileEditing: mid?.replace('正在修改…', '编辑') === before, editingSwitchedTile: true };`).catch((e) => ({ error: String(e) }));
    results.push({ profile: p.id, page: 'edit-cancel', ...edit });
    // 收款：现金 RM50 → 找零可见、确认可见。
    await pos.page(`__click('收款RM'); await __sleep(500); __click('RM50'); await __sleep(300); return 1;`);
    await shot(pos, p, 'payment');
    if (first) {
      // 只在第一个 profile 实际提交，验证前台→后厨回执（其余 profile 只看布局，避免产生过多订单）。
      await kds.goto('/kitchen', 3500);
      await pos.page(`__click('确认收款并接单'); await __waitFor('把这张餐牌交给客人', 40000); await __waitFor('✓后厨已收到', 25000); await __sleep(400); return 1;`);
      await shot(pos, p, 'result');
      await pos.page(`__click('下一单'); return 1;`);
      first = false;
    } else {
      await pos.page(`document.querySelector('[role=dialog] button').click(); await __sleep(300); __click('清空本单'); await __sleep(200); return 1;`);
    }
    await setProfile(kds, p);
    await kds.goto('/kitchen', 2000);
    await kds.page(`await __waitFor('待下锅', 25000); await __sleep(800); return 1;`);
    await shot(kds, p, 'kitchen');
    for (const [path, page, ready] of [['/orders', 'orders', '掌握每一单的进度'], ['/device', 'device', '订单传递状态'], ['/owner', 'owner', '收款走势']]) {
      await pos.goto(path, 2000);
      await pos.page(`await __waitFor(${JSON.stringify(ready)}, 25000); await __sleep(800); return 1;`);
      await shot(pos, p, page);
    }
  }

  // 键盘展开近似：收款弹窗在矮视口下仍能看到实收 / 找零 / 确认 / 关闭，并能滚动到输入框。
  for (const p of KEYBOARD) {
    await setProfile(pos, { ...p, h: 800 });
    await pos.goto('/pos', 3500);
    await pos.page(`await __waitFor('看图选餐', 20000); return 1;`);
    await fillCart();
    await pos.page(`__click('收款RM'); await __sleep(500); __click('RM50'); await __sleep(200); return 1;`);
    await setProfile(pos, p);
    const scroll = await pos.page(`const body = document.querySelector('[role=dialog] .overflow-y-auto'); const input = document.querySelector('#tendered'); input.focus(); input.scrollIntoView({ block: 'center' }); await __sleep(300);
      const r = input.getBoundingClientRect(); return { inputReachable: r.top >= 0 && r.bottom <= innerHeight, bodyScrollable: body.scrollHeight > body.clientHeight, inputMode: input.inputMode };`);
    results.push({ profile: p.id, page: 'keyboard-scroll', ...scroll });
    await shot(pos, p, 'payment-keyboard');
    await pos.page(`document.querySelector('[role=dialog] button').click(); await __sleep(300); __click('清空本单'); return 1;`);
  }

  // 英文：同一套布局，横屏候选 960×600。
  const en = PROFILES[0];
  await pos.page(`localStorage.setItem('hao-lang', 'en'); return 1;`);
  await setProfile(pos, en);
  await pos.goto('/pos', 3500);
  await pos.page(`await __waitFor('Pickthedish', 20000); return 1;`);
  await pos.page(`
    document.querySelector('button[aria-label="Black Sauce"]').click(); await __sleep(200); __click('Add'); await __sleep(250);
    document.querySelector('button[aria-label="Wantan Soup"]').click(); await __sleep(200); __click('Add'); await __sleep(250); return 1;`);
  await shot(pos, en, 'pos-en');
  await pos.page(`__click('paymentRM'); await __sleep(500); __click('Exact'); await __sleep(200); return 1;`);
  await shot(pos, en, 'payment-en');
  await pos.page(`document.querySelector('[role=dialog] button').click(); localStorage.setItem('hao-lang', 'zh'); return 1;`);
  await kds.page(`localStorage.setItem('hao-lang', 'en'); return 1;`);
  await setProfile(kds, en);
  await kds.goto('/kitchen', 3500);
  await shot(kds, en, 'kitchen-en');
  await kds.page(`localStorage.setItem('hao-lang', 'zh'); return 1;`);
} catch (e) {
  console.error('FAIL', e);
  results.push({ page: 'script-error', error: String(e) });
} finally {
  await writeFile(`${OUT}/tablet-preflight.json`, JSON.stringify({
    at: new Date().toISOString(),
    note: '浏览器模拟（CDP 设备模拟 + 触控 + Android UA），全部为候选视口，不是实机测量；不能据此声称已完全适配 REDMI Pad 2。',
    env: 'local Firebase Emulator + vite preview (VITE_USE_EMULATORS=true)',
    results,
  }, null, 2));
  await pos.close();
  await kds.close();
}
