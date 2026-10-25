// 阶段 E 端到端：老板处理离线待核对、收支、关账、关账后迟到单与更正版本、CSV 导出。
// 2026-10-23 起：下单送厨不收款，收款为不分渠道的人工全额登记（结果弹窗「确认已收款」）；日结不再输入钱箱实点 / QR，
// 概览与日结显示「净登记收款」。离线补同步仍用旧格式（含 cash 付款）的事件，验证旧日志兼容。
// 2026-10-25 收支改版：钱箱资金往来的录入已移除；改为验证「记一笔支出」的项目选择、食材进货入库、煤气记账与作废、
// 经营目标页、AI 记成本页里折叠的「详细用料管理」（批次与份量损耗）。
// 前提：干净的 Emulator 已启动并 seed；VITE_USE_EMULATORS=true 构建后在 4173 端口 vite preview（端口可用 E2E_PORT 覆盖）。
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { callable, fsGet, fsList, idToken, login, openChrome, pause } from './lib/cdp.mjs';

const OUT = 'docs/screenshots/owner';
const DL = resolve('docs/screenshots/owner/csv');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
await mkdir(OUT, { recursive: true });
await rm(DL, { recursive: true, force: true });
await mkdir(DL, { recursive: true });

const CONFIG = { productKind: 'dry_noodle', size: 'small', noodleType: 'thin_egg', sauce: 'black', spice: 'normal', lard: 'normal', scallion: 'normal', isKosong: false, addOns: [], note: '' };
async function offlineEvent(sequenceOffset, tokenNumber, extra = {}, atMs = Date.now()) {
  const cfg = await fsGet('config/public');
  const reg = await fsGet(`registers/${cfg.activeRegisterId}`);
  return {
    eventId: crypto.randomUUID(), registerId: cfg.activeRegisterId, deviceId: reg.activeDeviceId, registerEpoch: reg.epoch,
    sequence: reg.lastAppliedSequence + sequenceOffset, shiftId: reg.shiftId, type: 'offline_order_created', occurredAtDeviceMs: atMs, lastServerOffsetMs: 0,
    payload: {
      clientOrderId: crypto.randomUUID(), offlineReceiptNumber: `O-F01-9${tokenNumber}`, tokenNumber, serviceMode: 'dine_in', menuVersion: 'menu-2026-10-v1',
      lines: [{ lineId: crypto.randomUUID(), config: CONFIG, quantity: 1 }], totalSen: 700, payment: { method: 'cash', tenderedSen: 1000, qrExternalVerificationNote: null }, ...extra,
    },
  };
}

const PORT = process.env.E2E_PORT ?? '4173';
const pos = await openChrome(`http://localhost:${PORT}`);
const boss = await openChrome(`http://127.0.0.1:${PORT}`);
const save = async (tab, name) => writeFile(`${OUT}/${name}.png`, await tab.screenshot());

try {
  // ---- 收银开档并接 3 单（7、9、11），下单后在结果弹窗登记收款 ----
  await pos.goto('/login');
  await login(pos, 'owner');
  await pos.goto('/device');
  await pos.page(`await __waitFor('设为主收银机'); for (let i = 0; i < 60 && ![...document.querySelectorAll('button')].some((b) => !b.disabled && b.innerText.includes('设为主收银机')); i++) await __sleep(250); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await pos.page(`__click('退出'); await __sleep(2000);`);
  await login(pos, 'cashier');
  await pos.page(`if (await __waitFor('确认开班', 8000)) __click('确认开班'); await __waitFor('看图选餐', 25000);`);
  const SEND = `[...document.querySelectorAll('aside[aria-label="本单"] button')].find((b) => b.innerText.includes('下单送厨')).click();`;
  const sell = (setup) => pos.page(`
    await __waitFor('看图选餐', 15000); ${setup}
    __click('加入本单'); await __sleep(200); ${SEND}
    await __waitFor('✓云端已接单', 40000);
    [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.includes('确认已收款')).click();
    await __waitFor('已登记收款', 30000); await __sleep(300);
    const t = document.querySelector('[role=dialog]').innerText; __click('下一单'); await __sleep(300); return t;`);
  await sell(`__click('红酱面'); await __sleep(150);`);
  await sell(`__click('黑酱面'); await __sleep(150); __click('1½'); await __sleep(150);`);
  await sell(`__click('白酱面'); await __sleep(150); __click('大·RM11'); await __sleep(150);`);
  const sold = await fsList('orders');
  check('收银接 3 单并登记收款（不分渠道）', sold.length === 3 && sold.every((o) => o.paymentState === 'paid') && (await fsList('payments')).every((p) => p.method === 'unspecified'), sold.map((o) => o.paymentState).join(','));

  // ---- 收银机补同步两条会被判待核对的离线单：餐牌冲突、金额不符 ----
  const cashierToken = await idToken('cashier');
  const e1 = await offlineEvent(1, 1);
  const e2 = await offlineEvent(2, 20, { totalSen: 600, payment: { method: 'cash', tenderedSen: 600, qrExternalVerificationNote: null } });
  const sync1 = await callable('syncOfflineEvents', { events: [e1, e2] }, cashierToken);
  check('离线补同步产生 2 条待核对', sync1.results.map((r) => r.reasonCode).join(',') === 'TOKEN_CONFLICT,PRICE_MISMATCH', sync1.results.map((r) => r.reasonCode).join(','));

  // ---- 老板：概览 ----
  await boss.goto('/login');
  check('老板登录后进入概览', (await login(boss, 'owner')) === '/owner');
  await boss.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => boss.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }));
  const ov = await boss.page(`await __waitFor('净登记收款', 15000); await __sleep(2500); return document.querySelector('main').innerText;`);
  check('概览：净登记收款 RM27.00（未含待核对金额）', ov.includes('RM27.00') && !ov.replace(/净登记收款/g, '').includes('净收款'), ov.match(/净登记收款[^\n]*\n([^\n]+)/)?.[1]);
  check('概览：醒目提示 2 条待核对与未入账金额', ov.includes('离线记录待核对 2 条') && ov.includes('RM13.00'));
  check('概览：8 分钟达标率无样本显示「—」', /8 分钟内出餐率\s*—/.test(ov));
  await save(boss, 'overview-1366');

  // ---- 待核对：补入账 ----
  await boss.goto('/owner/review');
  await boss.page(`await __waitFor('餐牌与云端记录冲突', 15000);`);
  await save(boss, 'review-1366');
  const imported = await boss.page(`
    const cards = () => [...document.querySelectorAll('article')];
    for (const text of ['餐牌与云端记录冲突', '金额与菜单价格不符']) {
      const card = cards().find(c => c.innerText.includes(text));
      const input = card.querySelector('input[placeholder^="核对说明"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '已对过纸单和钱箱');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await __sleep(200);
      [...card.querySelectorAll('button')].find(b => b.innerText.includes('补入账')).click();
      await __waitFor('已补入账', 30000);
      await __sleep(2500);
    }
    return document.querySelector('main').innerText;`);
  check('待核对：两条补入账后清空；金额不符记录差额', imported.includes('没有待核对的记录'), imported.match(/已补入账[^\n]*/)?.[0]);
  const orders = await fsList('orders');
  const priceOrder = orders.find((o) => o.tokenNumber === 20);
  check('补入账：金额不符按实收 RM6 入账；餐牌冲突单只补历史账', priceOrder?.totalSen === 600 && orders.find((o) => o.tokenNumber === 1 && o.source === 'offline')?.tokenLock === 'history_only');

  // ---- 收支（2026-10-25 改版）：记一笔支出的项目选择；食材进货入库；煤气记账后作废；经营目标；AI 记成本里的详细用料管理与份量损耗 ----
  const FIN = `const set = (el, v) => { const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
    const field = (t) => [...document.querySelectorAll('[role=dialog] label')].find((l) => l.querySelector('span')?.innerText.trim() === t)?.querySelector('input,select,textarea');
    const dialogBtn = (t) => [...document.querySelectorAll('[role=dialog] button')].find((b) => !b.disabled && b.innerText.replace(/\\s+/g, '').includes(t));`;
  await boss.goto('/owner/finance');
  const chooser = await boss.page(`
    await __waitFor('今天的生意，一眼看清', 20000); await __waitFor('记一笔支出', 15000);
    __click('记一笔支出'); await __sleep(400);
    return document.querySelector('[role=dialog]')?.innerText ?? '';`);
  check('收支总览：「记一笔支出」列出 AI 记成本、食材进货、煤气、杂费、租金 / 冰箱电费', ['AI 记成本', '食材进货', '煤气', '杂费', '租金 / 冰箱电费'].every((t) => chooser.includes(t)), chooser.replace(/\s+/g, ' ').slice(0, 120));
  const purchase = await boss.page(`${FIN}
    dialogBtn('食材进货').click(); await __waitFor('记录新进货', 8000); await __sleep(300);
    const emptyAmount = field('整批金额 RM').value === '';
    set(document.querySelector('[role=dialog] select[aria-label="食材"]'), 'ing-minced-pork'); await __sleep(150);
    set(field('数量'), '2'); set(field('整批金额 RM'), '300'); await __sleep(200);
    const unit = field('单位').value;
    dialogBtn('保存RM300.00').click(); await __waitFor('进货已记录', 20000); await __sleep(1500);
    return { emptyAmount, unit };`);
  check('食材进货：金额不预填；选肉碎后单位自动为 kg', purchase.emptyAmount && purchase.unit === 'kg', JSON.stringify(purchase));
  await boss.page(`${FIN}
    __click('记一笔支出'); await __sleep(400); dialogBtn('煤气').click(); await __waitFor('换气记账', 8000); await __sleep(300);
    set(field('实际金额 RM'), '25'); await __sleep(200);
    dialogBtn('保存RM25.00').click(); await __waitFor('煤气已记录', 20000); await __sleep(1500);`);
  await boss.goto('/owner/finance/expenses');
  const voided = await boss.page(`${FIN}
    await __waitFor('这个月记过的开支', 20000); await __sleep(1500);
    const row = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '作废' && b.closest('div')?.parentElement?.innerText.includes('煤气'));
    row.click(); await __waitFor('作废原因', 8000); await __sleep(200);
    set(field('作废原因'), '金额打错'); await __sleep(200);
    dialogBtn('确认作废').click(); await __waitFor('已作废', 20000); await __sleep(2000);
    return __has('已作废：金额打错');`);
  const exps = await fsList('expenses');
  const batches = await fsList('ingredientBatches');
  check('收支：进货 RM300 有效、录错的煤气 RM25 已作废并保留原因', exps.some((e) => e.amountSen === 30000 && e.status === 'active' && e.category === 'purchase')
    && exps.some((e) => e.amountSen === 2500 && e.status === 'voided' && e.planItem === 'gas' && e.voidReason === '金额打错') && voided);
  check('食材进货：生成一批「库存待启用」的肉碎，关联这笔进货支出，不自动开始使用', batches.length === 1 && batches[0].ingredientId === 'ing-minced-pork' && batches[0].status === 'stocked'
    && batches[0].startedAtMs === null && exps.some((e) => e.id === batches[0].purchaseExpenseId && e.amountSen === 30000), JSON.stringify(batches.map((b) => [b.ingredientId, b.status])));
  await save(boss, 'finance-expenses-1366');

  await boss.goto('/owner/finance/goals');
  const goals = await boss.page(`await __waitFor('一家小档口，也有大目标', 20000); await __sleep(1500); return document.querySelector('main').innerText;`);
  check('经营目标：第一目标为收回开档投入，资料不足时显示待核算而不是虚假进度', goals.includes('一家小档口，也有大目标') && goals.includes('待核算') && goals.includes('开档成本尚未录入'), goals.match(/待核算[^\n]*\n?[^\n]*/)?.[0]);
  await save(boss, 'finance-goals-1366');

  await boss.goto('/owner/finance/ingredients');
  const advanced = await boss.page(`
    await __waitFor('今天花了什么，告诉我就好', 20000);
    const box = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.innerText.includes('详细用料管理'));
    if (!box) return { ok: false, text: 'no details' };
    box.open = true; await __waitFor('食材怎么用，慢慢算清楚', 10000); await __sleep(500);
    [...box.querySelectorAll('button[aria-pressed]')].find((b) => b.innerText.includes('云吞')).click(); await __sleep(400);
    const card = [...box.querySelectorAll('article')].find((a) => a.innerText.includes('肉碎'));
    return { ok: true, stocked: card?.innerText.includes('库存待启用') ?? false };`);
  check('AI 记成本页：「详细用料管理」折叠入口可展开，肉碎显示库存待启用', advanced.ok && advanced.stocked, JSON.stringify(advanced));
  await boss.page(`
    const box = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.innerText.includes('记份量损耗'));
    box.open = true; await __sleep(300);
    document.querySelector('[aria-label="面球加"]').click(); await __sleep(80); document.querySelector('[aria-label="面球加"]').click(); await __sleep(150);
    __click('保存损耗'); await __waitFor('损耗已记录', 20000); await __sleep(1500);`);
  const wst = await fsList('wastage');
  check('详细用料管理：份量损耗 1 面球（0.5 步长两次）', wst.length === 1 && wst[0].noodleHalfUnits === 2);
  check('钱箱资金往来已不再提供录入（改版后移除），没有新增资金往来记录', (await fsList('cashMovements')).length === 0 && !(await boss.page(`return __has('往来类型');`)));
  await save(boss, 'finance-ingredients-1366');

  // ---- 日结：不再输入钱箱实点 / QR；有例外须确认；关账后写屏障 ----
  await boss.goto('/owner/close');
  await boss.page(`await __waitFor('逐步核对', 15000); await __sleep(2000);`);
  const closeText = await boss.page(`return { text: document.querySelector('main').innerText, money: document.querySelectorAll('main input[inputmode="decimal"]').length };`);
  check('日结预览：没有钱箱实点 / QR 输入与差额，显示待登记收款与净登记收款', closeText.money === 0 && !closeText.text.includes('钱箱') && !closeText.text.includes('QR 差额') && closeText.text.includes('待登记收款') && closeText.text.includes('净登记收款'), `金额输入 ${closeText.money}`);
  await save(boss, 'close-before-1366');
  await boss.page(`
    const set = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    for (const box of document.querySelectorAll('main input[type=checkbox]')) if (!box.checked) { box.click(); await __sleep(150); }
    const other = document.querySelector('input[placeholder="结转说明（必填）"]'); if (other) set(other, '3 单未出餐，明早继续');
    const unpaid = document.querySelector('input[placeholder^="未登记结转原因"]'); if (unpaid) set(unpaid, '顾客明天来付');
    await __sleep(200);
    __click('关账并冻结'); await __waitFor('已冻结', 30000); await __sleep(2500);`);
  const day = await fsGet(`businessDays/${(await fsList('orders'))[0].businessDate}`);
  check('关账：营业日 closed，版本 1', day?.state === 'closed' && day?.closedVersion === 1);
  const blocked = await pos.page(`
    __click('红酱面'); await __sleep(150); __click('加入本单'); await __sleep(200); ${SEND}
    await __waitFor('营业日已关账', 30000); return __has('营业日已关账');`);
  check('关账后收银下单被拒绝（营业日已关账）', blocked);

  // ---- 关账后迟到的离线单 → 补入账 → 待调整 → 更正版本 2 ----
  const late = await offlineEvent(1, 30);
  const sync2 = await callable('syncOfflineEvents', { events: [late] }, cashierToken);
  check('迟到离线单进入「关账后待调整」', sync2.results[0].reasonCode === 'DAY_CLOSED_LATE');
  await boss.goto('/owner/review');
  await boss.page(`
    await __waitFor('营业日已关账后才同步', 15000);
    const card = [...document.querySelectorAll('article')][0];
    const input = card.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '断网时收的现金');
    input.dispatchEvent(new Event('input', { bubbles: true })); await __sleep(200);
    [...card.querySelectorAll('button')].find(b => b.innerText.includes('补入账')).click(); await __waitFor('请到日结页做更正版本', 30000);`);
  await boss.goto('/owner/close');
  const pend = await boss.page(`await __waitFor('已关账', 40000); return await __waitFor('关账后待调整1项', 20000);`);
  check('日结页显示关账后待调整 1 项', pend, pend ? '' : (await boss.page(`return location.pathname + ' | ' + document.body.innerText.replace(/\s+/g, ' ').slice(0, 400);`)));
  await boss.page(`
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[placeholder="更正原因（必填）"]'), '补入断网单 O-F01-930'); await __sleep(150);
    __click('生成更正版本'); await __waitFor('已生成更正版本2', 30000); await __sleep(2500);`);
  const date = (await fsList('orders'))[0].businessDate;
  const v1 = await fsGet(`dailyReports/${date}/versions/1`);
  const v2 = await fsGet(`dailyReports/${date}/versions/2`);
  check('更正版本 2 生成，版本 1 保留', Boolean(v1) && Boolean(v2) && v2.restates === 1);
  await save(boss, 'close-versions-1366');

  // ---- CSV 导出（真实下载到文件） ----
  await boss.page(`[...document.querySelectorAll('button')].filter(b => b.innerText.includes('导出 CSV'))[0].click(); await __sleep(2500);`);
  await boss.goto('/owner');
  await boss.page(`await __waitFor('净登记收款', 15000); await __sleep(2500); __click('导出CSV'); await __sleep(4000);`);
  const files = await readdir(DL);
  check('CSV 下载：日结 + 汇总 + 订单 + 收款退款 + 支出 + 损耗', ['日结_', '汇总_', '订单_', '收款退款_', '支出_', '损耗_'].every((p) => files.some((f) => f.startsWith(p))), files.join(', '));
  const ordersCsv = files.find((f) => f.startsWith('订单_'));
  const csvText = ordersCsv ? await readFile(join(DL, ordersCsv), 'utf8') : '';
  check('订单 CSV：UTF-8 BOM 与时区', csvText.startsWith('﻿') && csvText.includes('(Asia/Kuala_Lumpur)'));

  // ---- 手机老板概览 ----
  await boss.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await boss.goto('/owner');
  const overflow = await boss.page(`await __waitFor('净登记收款', 15000); await __sleep(2500); return document.documentElement.scrollWidth - document.documentElement.clientWidth;`);
  check('手机 390：老板概览无横向溢出、底部导航', overflow === 0 && (await boss.page(`return __has('概览') && __has('日结');`)), `溢出 ${overflow}px`);
  await save(boss, 'overview-390');
} catch (e) {
  check('脚本异常', false, String(e?.stack ?? e));
} finally {
  await pos.close().catch(() => {});
  await boss.close().catch(() => {});
  await pause(200);
  await writeFile(`${OUT}/owner-e2e.json`, JSON.stringify({ ranAt: new Date().toISOString(), environment: '正式构建 + 本机 Firebase Emulator；收银与老板为两台独立无头 Chrome；离线记录经真实补同步接口产生', results }, null, 2) + '\n');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
