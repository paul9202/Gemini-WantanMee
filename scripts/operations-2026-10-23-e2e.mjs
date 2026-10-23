// 2026-10-23 运营改版端到端（DESIGN §11）：下单送厨与收款登记分离、出餐自动释放餐牌、无备用金开班。
// 两台独立无头 Chrome 分别扮演「前台点单平板」和「后厨平板」，以 tablet-preflight 的横屏候选视口（REDMI Pad，1280×800 DPR 1.6，
// 触控 + Android UA）真实点界面；服务器状态用 Emulator REST 核对。另开一台老板浏览器查看日结 / 概览。
// 覆盖 §11 中能在界面观察的场景：1、2、3/4、5、6、7、9、10（另附 14 的原图字节核对）。
// 不扫码、不转账：二维码只打开 / 关闭，检查是否被误标为已付款。
// 前提：干净的 Emulator 已启动并 seed；VITE_USE_EMULATORS=true 构建后在 4173 端口 vite preview。
// 用法：node scripts/operations-2026-10-23-e2e.mjs
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { callable, fsGet, fsList, idToken, login, openChrome, pause } from './lib/cdp.mjs';

const OUT = 'docs/screenshots/operations-2026-10-23';
const ORIGIN = 'http://localhost:4173';
await mkdir(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Linux; Android 15; 25040RP0AG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
/** 与 tablet-preflight 的 L1280x800 相同：横屏候选，DPR 1.6，PWA 全屏（不是实机测量）。 */
const TABLET = { id: 'L1280x800', w: 1280, h: 800, dpr: 1.6 };

const results = [];
const shots = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const setTablet = async (tab) => {
  await tab.send('Emulation.setDeviceMetricsOverride', { width: TABLET.w, height: TABLET.h, deviceScaleFactor: TABLET.dpr, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await tab.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
  await pause(600);
};
/** 截图并记录横向溢出（平板布局不得横向滚动）。 */
const save = async (tab, name) => {
  const overflow = await tab.page(`return document.documentElement.scrollWidth - document.documentElement.clientWidth;`);
  await writeFile(`${OUT}/${name}.png`, await tab.screenshot());
  shots.push({ name: `${OUT}/${name}.png`, overflow });
  if (overflow > 0) check(`截图 ${name} 无横向溢出`, false, `${overflow}px`);
};
const waitUntil = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await pause(500);
  }
};
const orderBy = async (receipt) => (await fsList('orders')).find((o) => o.receiptNumber === receipt);
const paymentsOf = async (orderId) => (await fsList('payments')).filter((p) => p.orderId === orderId);

// 页面内小工具：在某个容器里按文字找按钮。
const PH = `const btnIn = (root, t) => [...(root ?? document).querySelectorAll('button')].find((b) => b.innerText.replace(/\\s+/g, '').includes(t));
  const dlg = (label) => [...document.querySelectorAll('[role=dialog]')].find((d) => (d.getAttribute('aria-label') ?? '').includes(label) || d.innerText.includes(label));
  const card = (n) => document.querySelector('article[aria-label="' + n + '号"]');`;

const pos = await openChrome(ORIGIN, { width: TABLET.w, height: TABLET.h });
const kds = await openChrome('http://127.0.0.1:4173', { width: TABLET.w, height: TABLET.h });
let boss;

/** 前台下单：只点「下单送厨」，不经过任何收款步骤。返回结果弹窗的文字、餐牌和票号。 */
const placeOrder = (tile, token = null) => pos.page(`${PH}
  await __waitFor('看图选餐', 20000);
  if (${token ?? 'null'} !== null) {
    btnIn(document, '个可用').click(); await __sleep(400);
    const b = document.querySelector('button[aria-label="${token}号 可用"]');
    if (!b) throw new Error('餐牌 ${token} 不是可用状态');
    b.click(); await __sleep(300);
  }
  document.querySelector('button[aria-label="${tile}"]').click(); await __sleep(250);
  __click('加入本单'); await __sleep(300);
  const send = btnIn(document.querySelector('aside[aria-label="本单"]'), '下单送厨');
  const label = send.innerText.replace(/\\s+/g, ' ').trim();
  send.click();
  if (!(await __waitFor('把这张餐牌交给客人', 40000))) throw new Error('没有出现下单结果');
  await __sleep(500);
  const text = dlg('把这张餐牌交给客人').innerText;
  return { label, text, token: Number(text.match(/(\\d+)号 · 票号/)?.[1]), receipt: text.match(/票号 ([\\d-]+)/)?.[1] };`);
const nextOrder = () => pos.page(`__click('下一单'); await __sleep(400); return 1;`);
const openDrawer = () => pos.page(`${PH} btnIn(document, '待登记收款').click(); await __sleep(800); return dlg('待登记收款') ? 1 : 0;`);
const closeDrawer = () => pos.page(`${PH} btnIn(dlg('待登记收款'), '关闭').click(); await __sleep(400); return 1;`);
const kitchenServe = (token) => kds.page(`${PH}
  for (let i = 0; i < 80 && !(card(${token}) && btnIn(card(${token}), '完成出餐')); i++) await __sleep(250);
  btnIn(card(${token}), '完成出餐').click();
  for (let i = 0; i < 80 && card(${token}); i++) await __sleep(250);
  return !card(${token});`);

try {
  // QR 原图：预览服务器提供的字节与设计稿登记的 sha256 一致（§11-14；未扫码、未核对收款账户）。
  const img = Buffer.from(await (await fetch(`${ORIGIN}/payment/tng-receiving-original.jpg`)).arrayBuffer());
  check('14 收款码原图字节未改动（sha256）', createHash('sha256').update(img).digest('hex') === '08223503ac18f4345632311d6bd2ad8b02a155e8545329c16721c8034e7567fc', `${img.length} bytes`);

  await setTablet(pos);
  await setTablet(kds);
  // ---- 准备：老板指定主收银机；收银登录 ----
  await pos.goto('/login');
  await login(pos, 'owner');
  await pos.goto('/device');
  await pos.page(`await __waitFor('设为主收银机'); for (let i = 0; i < 60 && ![...document.querySelectorAll('button')].some((b) => !b.disabled && b.innerText.includes('设为主收银机')); i++) await __sleep(250); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await pos.page(`__click('退出'); await __sleep(2000);`);
  check('收银登录进入点餐页', (await login(pos, 'cashier')) === '/pos');

  // ---- 10：无备用金开班 ----
  const shiftForm = await pos.page(`await __waitFor('确认开班', 15000); return { text: document.querySelector('main')?.innerText ?? document.body.innerText, inputs: document.querySelectorAll('main input').length };`);
  check('10 开班页没有备用金输入框', shiftForm.inputs === 0 && shiftForm.text.includes('不需要输入备用金') && !/RM\s?100/.test(shiftForm.text), `输入框 ${shiftForm.inputs}`);
  await save(pos, 'pos-open-shift');
  await pos.page(`__click('确认开班'); await __waitFor('看图选餐', 25000); return 1;`);
  const shifts = await fsList('shifts');
  const moves = await fsList('cashMovements');
  check('10 开班成功：班次无备用金、未创建备用金流水', shifts.length === 1 && shifts[0].status === 'open' && shifts[0].openingFloatSen === null && moves.length === 0,
    JSON.stringify({ shifts: shifts.length, openingFloatSen: shifts[0]?.openingFloatSen, cashMovements: moves.length }));

  // ---- 1：无付款下单；后厨屏未登录时不伪造回执 ----
  const a = await placeOrder('红酱面');
  check('1 购物车主按钮为「下单送厨 · RM金额」', /^下单送厨 · RM7\.00/.test(a.label), a.label);
  check('1 结果：订单已保存、本机已记录、云端已接单、待收款', a.text.includes('订单已保存') && a.text.includes('✓ 本机已记录') && a.text.includes('✓ 云端已接单') && a.text.includes('待收款 RM7.00'), a.text.replace(/\s+/g, ' ').slice(0, 160));
  const noFakeAck = await pos.page(`await __sleep(2500); return !__has('✓后厨已收到');`);
  const oA = await orderBy(a.receipt);
  check('1 后厨屏未登录：不显示「后厨已收到」，订单无回执时间', noFakeAck && oA?.kitchenAckAtMs === null, `kitchenAckAtMs=${oA?.kitchenAckAtMs}`);
  check('1 订单待收款、paidSen=0、无付款记录', oA?.paymentState === 'unpaid' && oA.paidSen === 0 && (await paymentsOf(oA._id)).length === 0, `${oA?.paymentState} ${oA?.paidSen}`);
  const tA = await fsGet(`kitchenTickets/${oA._id}`);
  check('1 厨单直接为制作中（自动开始）', tA?.fulfillmentStatus === 'preparing' && oA.fulfillmentStatus === 'preparing', `${tA?.fulfillmentStatus} / ${oA.fulfillmentStatus}`);

  await kds.goto('/login');
  check('后厨登录直达后厨屏', (await login(kds, 'kitchen')) === '/kitchen');
  const k1 = await kds.page(`${PH}
    for (let i = 0; i < 80 && !card(${a.token}); i++) await __sleep(250);
    const work = document.querySelector('section[aria-label="制作中 / 待出餐"]');
    const totals = document.querySelector('section[aria-label="制作中合计"]').innerText;
    return { inWork: Boolean(work?.querySelector('article[aria-label="${a.token}号"]')), start: Boolean(btnIn(document, '开始制作')),
      serve: Boolean(btnIn(card(${a.token}), '完成出餐')), auto: card(${a.token}).innerText.includes('自动（接单即制作）'), totals, orders: Number(totals.match(/共 (\\d+) 单/)?.[1] ?? 0) };`);
  check('1 后厨：单一「制作中 / 待出餐」区、无开始制作按钮、可直接完成出餐', k1.inWork && !k1.start && k1.serve, JSON.stringify({ inWork: k1.inWork, start: k1.start, serve: k1.serve }));
  check('1 后厨：开始时间标为自动（接单即制作）', k1.auto);
  check('1 后厨顶部合计非零（计入制作中的单）', k1.orders === 1 && /红酱\s*1/.test(k1.totals), k1.totals.replace(/\s+/g, ' '));
  const acked = await pos.page(`return await __waitFor('✓后厨已收到', 30000);`);
  const oA2 = await orderBy(a.receipt);
  check('1 后厨真实回执后才显示「后厨已收到」', acked && oA2.kitchenAckAtMs > 0);
  await nextOrder();

  // ---- 2a：下单后立即在结果弹窗登记收款 ----
  const b = await placeOrder('黑酱面');
  await pos.page(`await __waitFor('✓后厨已收到', 30000); return 1;`);
  const quick = await pos.page(`${PH}
    const d = dlg('把这张餐牌交给客人');
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height >= 55.5; };
    d.querySelector('.overflow-y-auto, div')?.scrollTo?.(0, 9999); await __sleep(200);
    const pay = btnIn(d, '确认已收款'), qr = btnIn(d, '显示收款码');
    return { pay: pay && inView(pay), qr: qr && inView(qr), text: d.innerText };`);
  check('2 结果弹窗含 QuickPay：确认已收款 / 显示收款码可见且够大', quick.pay && quick.qr && quick.text.includes('待收款 RM7.00'), JSON.stringify({ pay: quick.pay, qr: quick.qr }));
  await save(pos, 'pos-result-quickpay');
  await pos.page(`${PH} btnIn(dlg('把这张餐牌交给客人'), '确认已收款').click(); return 1;`);
  const quickDone = await pos.page(`return await __waitFor('已登记收款RM7.00', 30000);`);
  const oB = await orderBy(b.receipt);
  const pB = await paymentsOf(oB._id);
  check('2 提前登记：订单已收款、仍在制作中，1 笔收款', quickDone && oB.paymentState === 'paid' && oB.paidSen === 700 && oB.fulfillmentStatus === 'preparing' && pB.length === 1, `${oB.paymentState}/${oB.fulfillmentStatus}/${pB.length}`);
  check('2 收款记录不分渠道、人工确认', pB[0]?.method === 'unspecified' && pB[0]?.confirmationMode === 'manual', `${pB[0]?.method}/${pB[0]?.confirmationMode}`);
  await save(pos, 'pos-result-paid');
  await nextOrder();
  check('2 提前收款的单出餐', await kitchenServe(b.token));
  const oB2 = await orderBy(b.receipt);
  const kB = (await fsList('kitchenTickets')).filter((t) => t._id === oB._id);
  check('2 出餐后：已出餐 + 已收款，仍只有 1 张厨单、1 笔收款', oB2.fulfillmentStatus === 'served' && oB2.paymentState === 'paid' && kB.length === 1 && (await paymentsOf(oB._id)).length === 1);

  // ---- 6：显示 / 关闭收款码不改变付款状态 ----
  const e = await placeOrder('云吞汤');
  await pos.page(`${PH} btnIn(dlg('把这张餐牌交给客人'), '显示收款码').click(); await __sleep(1200); return 1;`);
  const qrm = await pos.page(`${PH}
    const d = document.querySelector('[role=dialog][aria-label="收款码"]');
    const img = d.querySelector('img'); await img.decode().catch(() => {});
    const r = img.getBoundingClientRect(); const box = img.parentElement.getBoundingClientRect();
    const inView = (x) => x.top >= -0.5 && x.left >= -0.5 && x.bottom <= innerHeight + 0.5 && x.right <= innerWidth + 0.5;
    const close = btnIn(d, '关闭（订单仍待收款）');
    return { loaded: img.naturalWidth > 0, imgInView: inView(r), insideBox: r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
      ratio: Math.abs(r.width / r.height - img.naturalWidth / img.naturalHeight), fit: getComputedStyle(img).objectFit, size: Math.round(r.width) + 'x' + Math.round(r.height),
      closeInView: close && inView(close.getBoundingClientRect()) && close.getBoundingClientRect().height >= 55.5, amount: d.innerText.includes('RM') , payee: d.innerText.includes('TAN CHUN HAO') };`);
  check('6 收款码弹窗：原图完整在视口内、未裁切（等比、object-contain）', qrm.loaded && qrm.imgInView && qrm.insideBox && qrm.ratio < 0.02 && qrm.fit === 'contain', JSON.stringify(qrm));
  check('6 收款码弹窗：应收金额、图片标示收款人、关闭按钮可见', qrm.amount && qrm.payee && qrm.closeInView);
  await save(pos, 'pos-qr-dialog');
  await pos.page(`${PH} btnIn(document.querySelector('[role=dialog][aria-label="收款码"]'), '关闭').click(); await __sleep(2500); return 1;`);
  const afterQr = await pos.page(`${PH} return dlg('把这张餐牌交给客人').innerText;`);
  const oE = await orderBy(e.receipt);
  check('6 关闭收款码后订单仍待收款、无付款记录', afterQr.includes('待收款 RM') && !afterQr.includes('已登记收款') && oE.paymentState === 'unpaid' && (await paymentsOf(oE._id)).length === 0, oE.paymentState);
  await nextOrder();

  // ---- 3 / 4 / 9：出餐自动释放餐牌 → 同牌新单 → 撤回被拒 → 登记旧单不影响新单 ----
  check('3 出餐（未收款的 A 单）', await kitchenServe(a.token));
  const tokA = await waitUntil(async () => { const t = await fsGet(`tokens/${String(a.token).padStart(2, '0')}`); return t?.state === 'available' ? t : null; }, 15000);
  const oA3 = await orderBy(a.receipt);
  check('3 出餐即释放餐牌（无待回收），订单仍未收款', tokA?.state === 'available' && oA3.fulfillmentStatus === 'served' && oA3.paymentState === 'unpaid', JSON.stringify({ token: tokA?.state, f: oA3.fulfillmentStatus, p: oA3.paymentState }));
  check('3 前台没有「待回收」入口', await pos.page(`return !__has('待回收') && !__has('实体牌已收回');`));
  const c = await placeOrder('白酱面', a.token);
  check('4 同一张餐牌立即用于新单 C', c.token === a.token, `餐牌 ${c.token}`);
  await nextOrder();
  const undo = await kds.page(`${PH}
    const u = btnIn(document, '撤回'); if (!u) return { found: false };
    u.click(); await __waitFor('餐牌已给了新单', 15000);
    return { found: true, msg: document.querySelector('[role=alert]')?.innerText ?? '', cards: document.querySelectorAll('article[aria-label="${a.token}号"]').length };`);
  const oA4 = await orderBy(a.receipt);
  const tokA2 = await fsGet(`tokens/${String(a.token).padStart(2, '0')}`);
  const oC = await orderBy(c.receipt);
  check('9 30 秒内撤回、但餐牌已给新单：拒绝，不抢牌、不重复恢复厨单', undo.found && undo.msg.includes('餐牌已给了新单') && undo.cards === 1 && oA4.fulfillmentStatus === 'served' && tokA2.state === 'held' && tokA2.orderId === oC._id,
    JSON.stringify({ ...undo, a: oA4.fulfillmentStatus, token: tokA2.state, holder: tokA2.orderId === oC._id ? 'C' : tokA2.orderId }));

  await pos.page(`document.querySelector('button[aria-label="红酱面"]').click(); await __sleep(250); __click('加入本单'); await __sleep(300); return 1;`);
  const header = await pos.page(`${PH} const b = btnIn(document, '待登记收款'); const r = b.getBoundingClientRect(); return { text: b.innerText.replace(/\\s+/g, ' '), h: r.height, inView: r.top >= 0 && r.right <= innerWidth };`);
  check('前台页头常驻「待登记收款 N 单 · RM」', /待登记收款 3 单 · RM21\.00/.test(header.text) && header.h >= 55.5 && header.inView, JSON.stringify(header));
  await save(pos, 'pos-pending-button');
  await pos.page(`__click('清空本单'); await __sleep(300); return 1;`);

  await openDrawer();
  const drawer = await pos.page(`${PH}
    const d = dlg('待登记收款');
    const cards = [...d.querySelectorAll('li[data-order-id]')].map((li) => ({ id: li.dataset.orderId, text: li.innerText.replace(/\\s+/g, ' ') }));
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; };
    const btns = [...d.querySelectorAll('button')].filter((b) => !b.disabled && inView(b));
    return { cards, small: btns.filter((b) => b.getBoundingClientRect().height < 55.5).length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };`);
  const cardA = drawer.cards.find((x) => x.id === oA._id);
  const cardC = drawer.cards.find((x) => x.id === oC._id);
  check('3 待登记列表：旧单 A 仍可找到（原餐牌、票号、时间、餐品、已出餐·未收款），排在最前', drawer.cards[0]?.id === oA._id && cardA.text.includes(`原餐牌 ${a.token}`) && cardA.text.includes(a.receipt) && /\d{2}:\d{2}/.test(cardA.text) && cardA.text.includes('红酱面') && cardA.text.includes('已出餐 · 未收款'), cardA?.text);
  check('4 同牌新单 C 同时在列表（制作中·未收款）', cardC && cardC.text.includes(`原餐牌 ${a.token}`) && cardC.text.includes('制作中 · 未收款'), cardC?.text);
  check('待登记抽屉：触控目标 ≥56、无横向溢出', drawer.small === 0 && drawer.overflow === 0, JSON.stringify({ small: drawer.small, overflow: drawer.overflow }));
  await save(pos, 'pos-pending-drawer');
  await pos.page(`${PH} btnIn(document.querySelector('li[data-order-id="${oA._id}"]'), '确认已收款').click(); return 1;`);
  const paidA = await pos.page(`${PH} const li = () => document.querySelector('li[data-order-id="${oA._id}"]');
    for (let i = 0; i < 80 && li() && !li().querySelector('[role=status]'); i++) await __sleep(250); await __sleep(800);
    return li() ? li().innerText.replace(/\s+/g, ' ') : null;`);
  const oA5 = await orderBy(a.receipt);
  const oC2 = await orderBy(c.receipt);
  check('2 出餐后补登记：A 已收款、1 笔收款', oA5.paymentState === 'paid' && (await paymentsOf(oA._id)).length === 1, oA5.paymentState);
  check('2 待登记抽屉：登记成功的卡留在原位并显示「已登记收款」', paidA?.includes('已登记收款 RM7.00'), paidA === null ? '卡片在登记后立即从抽屉消失，没有成功反馈' : paidA);
  check('4 登记旧单 A 不影响同牌新单 C（REST：C 仍未收款、paidSen=0、无收款记录）', oC2.paymentState === 'unpaid' && oC2.paidSen === 0 && (await paymentsOf(oC._id)).length === 0, `${oC2.paymentState} ${oC2.paidSen}`);
  await save(pos, 'pos-pending-drawer-recorded');
  await closeDrawer();

  // ---- 5：连点 / 重试 / 并发只登记一次 ----
  const d5 = await placeOrder('云吞汤面');
  await nextOrder();
  const oD = await orderBy(d5.receipt);
  await openDrawer();
  const dbl = await pos.page(`${PH}
    const li = () => document.querySelector('li[data-order-id="${oD._id}"]');
    const b = btnIn(li(), '确认已收款'); b.click(); b.click(); b.click();
    for (let i = 0; i < 80 && li() && !li().querySelector('[role=status]'); i++) await __sleep(250);
    await __sleep(1500);
    return li() ? li().innerText : '(卡片已移出列表)';`);
  const pD = await waitUntil(async () => { const p = await paymentsOf(oD._id); return p.length ? p : null; }, 10000);
  await pause(2000);
  const pD2 = await paymentsOf(oD._id);
  check('5 连点三次「确认已收款」：只有 1 笔收款', pD && pD2.length === 1 && (await orderBy(d5.receipt)).paidSen === oD.totalSen, `${pD2.length} 笔 · ${dbl.replace(/\s+/g, ' ').slice(-30)}`);
  await closeDrawer();
  // 不同 operationId 并发 + 同 operationId 重试（直接走 Callable，与浏览器同一套认证和校验）
  const cfg = await fsGet('config/public');
  const reg = await fsGet(`registers/${cfg.activeRegisterId}`);
  const claim = { registerId: cfg.activeRegisterId, deviceId: reg.activeDeviceId, registerEpoch: reg.epoch };
  const token = await idToken('cashier');
  const op1 = crypto.randomUUID();
  const op2 = crypto.randomUUID();
  const settle = (p) => p.then((r) => ({ ok: true, r }), (err) => ({ ok: false, err: String(err.message) }));
  const [r1, r2] = await Promise.all([op1, op2].map((op) => settle(callable('recordPayment', { operationId: op, ...claim, orderId: oE._id, amountSen: oE.totalSen }, token))));
  const okCount = [r1, r2].filter((x) => x.ok).length;
  const loser = [r1, r2].find((x) => !x.ok);
  check('5 两个不同 operationId 并发确认同一订单：一次成功、另一次 ALREADY_PAID', okCount === 1 && /ALREADY_PAID/.test(loser?.err ?? ''), JSON.stringify([r1.ok, r2.ok, loser?.err?.slice(0, 80)]));
  const winOp = r1.ok ? op1 : op2;
  const retry = await settle(callable('recordPayment', { operationId: winOp, ...claim, orderId: oE._id, amountSen: oE.totalSen }, token));
  check('5 同 operationId 重试返回原结果', retry.ok && retry.r?.paymentId === (r1.ok ? r1 : r2).r?.paymentId, JSON.stringify(retry).slice(0, 120));
  check('5 并发 + 重试后订单 E 只有 1 笔收款', (await paymentsOf(oE._id)).length === 1);

  // ---- 7：取消未收款单 → 后厨确认「未做」→ 不退款、移出待登记 ----
  const f = await placeOrder('干捞云吞');
  await nextOrder();
  const oF = await orderBy(f.receipt);
  await pos.goto('/orders', 2500);
  await pos.page(`${PH}
    await __waitFor('掌握每一单的进度', 20000);
    for (let i = 0; i < 40 && !__has('${f.receipt}'); i++) await __sleep(250);
    const row = [...document.querySelectorAll('div.grid')].find((r) => r.innerText.includes('票号 ${f.receipt}') && r.querySelector('button'));
    btnIn(row, '取消').click(); await __sleep(400);
    const d = document.querySelector('[role=dialog]');
    btnIn(d, '顾客离开').click(); await __sleep(200);
    btnIn(d, '确认').click();
    for (let i = 0; i < 80 && document.querySelector('[role=dialog]'); i++) await __sleep(250);
    await __sleep(1500); return 1;`);
  const oF2 = await orderBy(f.receipt);
  const tokF = await fsGet(`tokens/${String(f.token).padStart(2, '0')}`);
  check('7 未收款单申请取消：等待后厨确认，期间仍占牌', oF2.kitchenCancelRequested === true && oF2.fulfillmentStatus === 'preparing' && tokF.state === 'held' && tokF.orderId === oF._id, JSON.stringify({ req: oF2.kitchenCancelRequested, f: oF2.fulfillmentStatus, token: tokF.state }));
  await pos.goto('/pos', 2500);
  await openDrawer();
  const fCard = await pos.page(`${PH} const li = document.querySelector('li[data-order-id="${oF._id}"]'); return li ? { text: li.innerText.replace(/\\s+/g, ' '), disabled: btnIn(li, '') && [...li.querySelectorAll('button')].find((b) => b.innerText.includes('确认已收款'))?.disabled } : null;`);
  check('7 取消待确认的单不能登记收款', fCard?.text.includes('取消待后厨确认') && fCard.disabled === true, JSON.stringify(fCard));
  await closeDrawer();
  const k7 = await kds.page(`${PH}
    for (let i = 0; i < 80 && !(card(${f.token}) && btnIn(card(${f.token}), '未做，确认取消')); i++) await __sleep(250);
    const cc = card(${f.token});
    return { notCooked: Boolean(btnIn(cc, '未做，确认取消')), consumed: Boolean(btnIn(cc, '已下锅/已用料，确认取消')), serve: Boolean(btnIn(cc, '完成出餐')),
      totals: document.querySelector('section[aria-label="制作中合计"]').innerText.replace(/\\s+/g, ' ') };`);
  check('7 后厨：取消申请卡片有「未做 / 已下锅已用料」两种确认，不能出餐', k7.notCooked && k7.consumed && !k7.serve, JSON.stringify(k7).slice(0, 200));
  check('后厨合计：计入全部制作中的单，取消待确认不计入', /共 3 单/.test(k7.totals) && k7.totals.includes('取消待确认 1 单，不计入合计'), k7.totals);
  // 取消待确认卡片在第二行：滚到页底，让两种取消确认按钮完整可见（顶部合计另见 kitchen-work-area 截图）。
  await kds.page(`${PH} window.scrollTo(0, document.documentElement.scrollHeight); await __sleep(500); return 1;`);
  await save(kds, 'kitchen-work-area-cancel-pending');
  await kds.page(`window.scrollTo(0, 0); return 1;`);
  await kds.page(`${PH} btnIn(card(${f.token}), '未做，确认取消').click(); for (let i = 0; i < 80 && card(${f.token}); i++) await __sleep(250); return 1;`);
  const oF3 = await waitUntil(async () => { const o = await orderBy(f.receipt); return o.fulfillmentStatus === 'cancelled' ? o : null; }, 15000);
  const refundsF = (await fsList('refunds')).filter((r) => r.orderId === oF._id);
  const tokF2 = await fsGet(`tokens/${String(f.token).padStart(2, '0')}`);
  check('7 后厨确认未做：订单取消、无需收款、不退款、无收款记录', oF3?.paymentState === 'not_due' && oF3.refundedSen === 0 && refundsF.length === 0 && (await paymentsOf(oF._id)).length === 0, JSON.stringify({ p: oF3?.paymentState, refunded: oF3?.refundedSen, refunds: refundsF.length }));
  check('3 取消最终成立自动释放餐牌', tokF2.state === 'available', tokF2.state);
  await openDrawer();
  const afterCancel = await pos.page(`${PH} return { f: Boolean(document.querySelector('li[data-order-id="${oF._id}"]')), text: dlg('待登记收款').innerText.replace(/\\s+/g, ' ').slice(0, 120) };`);
  check('7 取消后的单不再出现在待登记收款', !afterCancel.f, afterCancel.text);
  await closeDrawer();
  await kds.page(`await __sleep(1000); return 1;`);
  await save(kds, 'kitchen-work-area');


  // ---- 后厨「继续做，拒绝取消」：申请结束、通知前台；不释放牌、不标付款；之后正常出餐 ----
  await pos.goto('/pos', 2500);
  const g = await placeOrder('红酱面');
  await nextOrder();
  const oG = await orderBy(g.receipt);
  await pos.goto('/orders', 2500);
  await pos.page(`${PH}
    await __waitFor('掌握每一单的进度', 20000);
    for (let i = 0; i < 40 && !__has('${g.receipt}'); i++) await __sleep(250);
    const row = [...document.querySelectorAll('div.grid')].find((r) => r.innerText.includes('票号 ${g.receipt}') && r.querySelector('button'));
    btnIn(row, '取消').click(); await __sleep(400);
    const d = document.querySelector('[role=dialog]');
    btnIn(d, '顾客离开').click(); await __sleep(200);
    btnIn(d, '确认').click();
    for (let i = 0; i < 80 && document.querySelector('[role=dialog]'); i++) await __sleep(250);
    await __sleep(1000); return 1;`);
  const kR = await kds.page(`${PH}
    for (let i = 0; i < 80 && !(card(${g.token}) && btnIn(card(${g.token}), '继续做，拒绝取消')); i++) await __sleep(250);
    const cc = card(${g.token});
    btnIn(cc, '已送餐，顾客仍要').click(); await __sleep(200);
    btnIn(cc, '继续做，拒绝取消').click();
    for (let i = 0; i < 80 && !(card(${g.token}) && btnIn(card(${g.token}), '完成出餐')); i++) await __sleep(250);
    return { serve: Boolean(card(${g.token}) && btnIn(card(${g.token}), '完成出餐')) };`);
  const oG2 = await waitUntil(async () => { const o = await orderBy(g.receipt); return o.kitchenCancelRequested === false && o.cancelRejection ? o : null; }, 15000);
  const tokG = await fsGet(`tokens/${String(g.token).padStart(2, '0')}`);
  check('5 后厨拒绝取消：申请结束、留原因记录；仍占牌、未付款、无退款；卡片恢复「完成出餐」',
    kR.serve && oG2?.cancelRejection?.reason === '已送餐，顾客仍要' && oG2.paymentState === 'unpaid' && tokG.state === 'held' && tokG.orderId === oG._id && (await fsList('refunds')).filter((r) => r.orderId === oG._id).length === 0,
    JSON.stringify({ serve: kR.serve, rej: oG2?.cancelRejection?.reason, pay: oG2?.paymentState, token: tokG.state }));
  const ordersRej = await pos.page(`await __sleep(1500); return document.querySelector('main').innerText;`);
  check('5 前台订单页看到「后厨拒绝取消，继续制作」通知', ordersRej.includes('后厨拒绝取消，继续制作') && ordersRej.includes('已送餐，顾客仍要'));
  check('5 拒绝取消后可正常出餐并自动释放餐牌', await kitchenServe(g.token) && (await fsGet(`tokens/${String(g.token).padStart(2, '0')}`)).state === 'available');

  // ---- 订单页：制作状态与收款状态分开显示 ----
  await pos.goto('/orders', 3000);
  const ordersPage = await pos.page(`await __waitFor('掌握每一单的进度', 20000); await __sleep(1500); return document.querySelector('main').innerText;`);
  check('订单页：未收款 / 已收款 / 已取消·无需收款 分开显示，并有「确认已收款」', ordersPage.includes('未收款') && ordersPage.includes('已收款') && ordersPage.includes('已取消 · 无需收款') && ordersPage.includes('确认已收款 RM') && ordersPage.includes('已出餐 · 餐牌已释放'));
  await save(pos, 'orders-payment-badges');

  // ---- 老板：日结无钱箱 / QR 输入；概览为「净登记收款」 ----
  boss = await openChrome('http://127.0.0.1:4173', { width: TABLET.w, height: TABLET.h });
  await setTablet(boss);
  await boss.goto('/login');
  await login(boss, 'owner');
  await boss.goto('/owner', 3000);
  const ov = await boss.page(`await __waitFor('净登记收款', 20000); await __sleep(2500); return document.querySelector('main').innerText;`);
  check('概览显示「净登记收款」（不再是净收款）', ov.includes('净登记收款') && !/(^|[^登记])净收款/.test(ov.replace(/净登记收款/g, '')));
  await save(boss, 'owner-overview');

  // ---- 老板放弃追收：须原因；不计实收、退出待登记收款，日结单独显示未收回金额 ----
  await boss.goto('/orders', 3000);
  const wo = await boss.page(`${PH}
    await __waitFor('掌握每一单的进度', 20000);
    for (let i = 0; i < 40 && !__has('${g.receipt}'); i++) await __sleep(250);
    const row = [...document.querySelectorAll('div.grid')].find((r) => r.innerText.includes('票号 ${g.receipt}') && r.querySelector('button'));
    btnIn(row, '放弃追收').click(); await __sleep(400);
    const d = document.querySelector('[role=dialog]');
    const confirmBtn = () => btnIn(d, '确认');
    const disabledBefore = confirmBtn().disabled;
    const input = d.querySelector('input:not([type=checkbox])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '顾客未付款离开');
    input.dispatchEvent(new Event('input', { bubbles: true })); await __sleep(150);
    d.querySelector('input[type=checkbox]').click(); await __sleep(150);
    confirmBtn().click();
    for (let i = 0; i < 80 && document.querySelector('[role=dialog]'); i++) await __sleep(250);
    await __sleep(1500);
    return { disabledBefore, text: row.innerText.replace(/\\s+/g, ' ') };`);
  const oG3 = await waitUntil(async () => { const o = await orderBy(g.receipt); return o.paymentState === 'written_off' ? o : null; }, 15000);
  const wDocs = (await fsList('paymentWriteOffs')).filter((w) => w.orderId === oG._id);
  check('1 放弃追收：无原因不能确认；记录金额/原因/操作者；订单保留为已放弃、不计实收',
    wo.disabledBefore === true && oG3?.paidSen === 0 && wDocs.length === 1 && wDocs[0].amountSen === oG.totalSen && wDocs[0].reason === '顾客未付款离开' && Boolean(wDocs[0].recordedBy) && (await paymentsOf(oG._id)).length === 0,
    JSON.stringify({ before: wo.disabledBefore, state: oG3?.paymentState, docs: wDocs.length }));
  await pos.goto('/pos', 2500);
  await openDrawer();
  const woDrawer = await pos.page(`${PH} return Boolean(document.querySelector('li[data-order-id="${oG._id}"]'));`);
  check('1 放弃追收的单退出待登记收款列表', woDrawer === false);
  await closeDrawer();

  await boss.goto('/owner/close', 3000);
  const close = await boss.page(`await __waitFor('逐步核对', 20000); await __sleep(2000); return { text: document.querySelector('main').innerText, money: document.querySelectorAll('main input[inputmode="decimal"]').length };`);
  check('日结页：没有钱箱实点 / QR 输入与差额，显示待登记收款步骤', close.money === 0 && !close.text.includes('钱箱') && !close.text.includes('QR 差额') && close.text.includes('待登记收款'), `金额输入 ${close.money}`);
  check('1 日结单独显示「未收回金额」（放弃追收，不计实收）', close.text.includes('未收回金额'));
  await save(boss, 'owner-close');
} catch (err) {
  check('脚本异常', false, String(err?.stack ?? err));
  // 失败现场：保存两台平板的画面与可见文字，便于判断是脚本还是应用问题。
  for (const [tab, n] of [[pos, 'pos'], [kds, 'kds']]) {
    await writeFile(`${OUT}/failure-${n}.png`, await tab.screenshot()).catch(() => {});
    console.log(`[${n}] ` + (await tab.page(`return location.pathname + ' | ' + document.body.innerText.replace(/\s+/g, ' ').slice(0, 600);`).catch(() => '')));
  }
} finally {
  await pos.close().catch(() => {});
  await kds.close().catch(() => {});
  await boss?.close().catch(() => {});
  await writeFile(`${OUT}/operations-e2e.json`, JSON.stringify({ ranAt: new Date().toISOString(), viewport: TABLET, environment: '正式构建 + 本机 Firebase Emulator；前台 / 后厨 / 老板为三台独立无头 Chrome（触控 + Android UA，候选视口，非实机）；未扫码、未转账', results, shots }, null, 2) + '\n');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
