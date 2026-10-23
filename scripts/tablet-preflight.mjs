// 档口平板到货前的预检（DEVICE-BASELINE）。以下视口全部是「候选」开发覆盖尺寸，不是 REDMI Pad 2 已测量的 CSS 视口：
// 2048×1280 是硬件像素，实际 viewport 取决于 DPR、系统显示大小、浏览器工具栏 / PWA 与键盘，到货后必须实测替换。
// 每个视口：触控模拟 + Android 平板 UA，真实「下单送厨」（2026-10-23 起不经收款弹窗）→ 后厨回执，截图并检查横向溢出、
// 小于 56px 的触控目标、本单与「下单送厨」按钮是否可见、结果弹窗的「确认已收款 / 显示收款码」是否完整在视口内、
// 收款码弹窗原图是否完整显示（未裁切）及关闭按钮可见、「待登记收款」抽屉是否可用。不扫码、不转账。
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
/** 软键盘展开（interactive-widget=resizes-content 时视口变矮）的近似高度。点餐页已没有输入框，改测订单页搜索框。 */
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
    sendInView: inView([...document.querySelectorAll('button')].find((b) => /下单送厨|Send/.test(b.innerText) && b.getBoundingClientRect().width > 0)),
    quickPayInView: inView([...document.querySelectorAll('[role=dialog] button')].find((b) => /确认已收款|Confirm received/.test(b.innerText))),
    quickQrInView: inView([...document.querySelectorAll('[role=dialog] button')].find((b) => /显示收款码|Show QR/.test(b.innerText))),
    resultNextInView: inView([...document.querySelectorAll('[role=dialog] button')].find((b) => /下一单|Next order/.test(b.innerText))),
    qr: (() => {
      const d = document.querySelector('[role=dialog][aria-label="收款码"], [role=dialog][aria-label="Payment QR"]'); if (!d) return null;
      const img = d.querySelector('img'); const r = img.getBoundingClientRect(); const box = img.parentElement.getBoundingClientRect();
      const close = [...d.querySelectorAll('button')].pop();
      return { loaded: img.naturalWidth > 0, imgInView: inView(img), notCropped: (Math.abs(r.width / r.height - img.naturalWidth / img.naturalHeight) < 0.02 || getComputedStyle(img).objectFit === 'contain')
        && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5, size: Math.round(r.width) + 'x' + Math.round(r.height), shown: (() => { const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight); return Math.round(img.naturalWidth * k) + 'x' + Math.round(img.naturalHeight * k); })(), closeInView: inView(close) };
    })(),
    drawer: (() => {
      const d = document.querySelector('[role=dialog][aria-label="待登记收款"]'); if (!d) return null;
      const first = d.querySelector('li[data-order-id]');
      const btns = first ? [...first.querySelectorAll('button')] : [];
      return { cards: d.querySelectorAll('li[data-order-id]').length, closeInView: inView([...d.querySelectorAll('header button')].pop()), firstCardButtonsInView: btns.length === 2 && btns.every(inView) };
    })(),
  };`;

async function shot(tab, profile, page) {
  const m = await tab.page(MEASURE);
  const name = `${profile.id}-${page}`;
  await writeFile(`${OUT}/${name}.png`, await tab.screenshot());
  results.push({ profile: profile.id, viewport: `${profile.w}x${profile.h}`, dpr: profile.dpr, assumption: profile.label, page, ...m });
  console.log(`${name} overflow=${m.overflow} small=${m.small}/${m.targets} cart=${m.cartVisible} entry=${m.cartEntry} send=${m.sendInView} quick=${m.quickPayInView}/${m.quickQrInView}/${m.resultNextInView} qr=${m.qr ? JSON.stringify(m.qr) : '-'} drawer=${m.drawer ? JSON.stringify(m.drawer) : '-'}`);
  return m;
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
    // 下单送厨：不经收款弹窗；每个视口真实下一单，检查结果弹窗里的收款区（QuickPay）与收款码弹窗。
    await kds.goto('/kitchen', 2500);
    await pos.page(`[...document.querySelectorAll('aside[aria-label="本单"] button')].find((b) => b.innerText.includes('下单送厨')).click();
      await __waitFor('把这张餐牌交给客人', 40000); await __waitFor('✓后厨已收到', 25000); await __sleep(400); return 1;`);
    await shot(pos, p, 'result');
    await pos.page(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.includes('显示收款码')).click(); await __sleep(900);
      await document.querySelector('[role=dialog][aria-label="收款码"] img').decode().catch(() => {}); return 1;`);
    await shot(pos, p, 'qr');
    await pos.page(`__click('关闭（订单仍待收款）'); await __sleep(300); __click('下一单'); await __sleep(400); return 1;`);
    // 待登记收款抽屉：卡片主按钮 / 收款码按钮 / 关闭可见可点。
    await pos.page(`__click('待登记收款'); await __sleep(900); return 1;`);
    await shot(pos, p, 'pending');
    await pos.page(`const li = document.querySelector('[role=dialog][aria-label="待登记收款"] li[data-order-id]');
      [...li.querySelectorAll('button')].find((b) => b.innerText.includes('显示收款码')).click(); await __sleep(900); return 1;`);
    await shot(pos, p, 'pending-qr');
    await pos.page(`__click('关闭（订单仍待收款）'); await __sleep(300); [...document.querySelectorAll('[role=dialog][aria-label="待登记收款"] header button')].pop().click(); await __sleep(300); return 1;`);
    await setProfile(kds, p);
    await kds.goto('/kitchen', 2000);
    await kds.page(`await __waitFor('制作中/待出餐', 25000); await __sleep(800); return 1;`);
    await shot(kds, p, 'kitchen');
    for (const [path, page, ready] of [['/orders', 'orders', '掌握每一单的进度'], ['/device', 'device', '订单传递状态'], ['/owner', 'owner', '收款走势']]) {
      await pos.goto(path, 2000);
      await pos.page(`await __waitFor(${JSON.stringify(ready)}, 25000); await __sleep(800); return 1;`);
      await shot(pos, p, page);
    }
  }

  // 键盘展开近似：点餐页已无输入框（下单不再输入实收）；改测订单页搜索框在矮视口下仍可滚动到并可见。
  for (const p of KEYBOARD) {
    await setProfile(pos, { ...p, h: 800 });
    await pos.goto('/orders', 3500);
    await pos.page(`await __waitFor('掌握每一单的进度', 20000); return 1;`);
    await setProfile(pos, p);
    const scroll = await pos.page(`const input = document.querySelector('input[aria-label="搜索订单"]'); input.focus(); input.scrollIntoView({ block: 'center' }); await __sleep(300);
      const r = input.getBoundingClientRect(); return { inputReachable: r.top >= 0 && r.bottom <= innerHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };`);
    results.push({ profile: p.id, page: 'keyboard-scroll', ...scroll });
    await shot(pos, p, 'orders-keyboard');
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
  await pos.page(`[...document.querySelectorAll('aside[aria-label="Order"] button')].find((b) => b.innerText.includes('Send to kitchen')).click();
    await __waitFor('Givethistoken', 40000); await __sleep(600); return 1;`);
  await shot(pos, en, 'result-en');
  await pos.page(`__click('Nextorder'); localStorage.setItem('hao-lang', 'zh'); return 1;`);
  await kds.page(`localStorage.setItem('hao-lang', 'en'); return 1;`);
  await setProfile(kds, en);
  await kds.goto('/kitchen', 3500);
  await shot(kds, en, 'kitchen-en');
  await kds.page(`localStorage.setItem('hao-lang', 'zh'); return 1;`);
  // 汇总：每张截图的通用要求 + 各页面的关键控件。
  const rules = [];
  for (const r of results) {
    if (r.page === 'edit-cancel') { rules.push([`${r.profile} 编辑取消保留原行`, r.keptAfterCancel && r.unchangedWhileEditing]); continue; }
    if (r.page === 'keyboard-scroll') { rules.push([`${r.profile} 键盘近似：订单搜索框可见、无溢出`, r.inputReachable && r.overflow === 0]); continue; }
    if (!('overflow' in r)) continue;
    const id = `${r.profile}-${r.page}`;
    rules.push([`${id} 无横向溢出`, r.overflow === 0, `${r.overflow}px`]);
    rules.push([`${id} 触控目标 ≥56`, r.small === 0, r.smallSamples?.join(' | ')]);
    if (r.page === 'pos' || r.page === 'pos-en') rules.push([`${id} 「下单送厨」按钮可见`, r.sendInView]);
    if (r.page === 'result' || r.page === 'result-en') rules.push([`${id} 结果弹窗：确认已收款 / 显示收款码 / 下一单完整可见`, r.quickPayInView && r.quickQrInView && r.resultNextInView]);
    if (r.page === 'qr' || r.page === 'pending-qr') rules.push([`${id} 收款码：原图完整在视口内、未裁切、关闭可见`, r.qr?.loaded && r.qr.imgInView && r.qr.notCropped && r.qr.closeInView, JSON.stringify(r.qr)]);
    if (r.page === 'pending') rules.push([`${id} 待登记抽屉：有卡片、卡片按钮与关闭可见`, r.drawer?.cards > 0 && r.drawer.firstCardButtonsInView && r.drawer.closeInView, JSON.stringify(r.drawer)]);
  }
  for (const [name, ok, detail] of rules) if (!ok) console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  const failed = rules.filter((x) => !x[1]).length;
  console.log(`
${rules.length - failed}/${rules.length} passed`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('FAIL', e);
  process.exitCode = 1;
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
