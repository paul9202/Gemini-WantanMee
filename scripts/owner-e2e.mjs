// 阶段 E 端到端：老板处理离线待核对、收支损耗、关账、关账后迟到单与更正版本、CSV 导出。
// 前提：干净的 Emulator 已启动并 seed；VITE_USE_EMULATORS=true 构建后在 4173 端口 vite preview。
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

const pos = await openChrome('http://localhost:4173');
const boss = await openChrome('http://127.0.0.1:4173');
const save = async (tab, name) => writeFile(`${OUT}/${name}.png`, await tab.screenshot());

try {
  // ---- 收银开档并接 3 单（现金 7、QR 9、现金 11） ----
  await pos.goto('/login');
  await login(pos, 'owner');
  await pos.goto('/device');
  await pos.page(`await __waitFor('设为主收银机'); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await pos.page(`__click('退出'); await __sleep(2000);`);
  await login(pos, 'cashier');
  await pos.page(`if (await __waitFor('确认开班', 8000)) __click('确认开班'); await __waitFor('看图选餐', 25000);`);
  const sell = (setup, pay) => pos.page(`
    await __waitFor('看图选餐', 15000); ${setup}
    __click('加入本单'); await __sleep(200); __click('收款RM'); await __sleep(400); ${pay}
    await __waitFor('✓云端已接单', 40000); return document.querySelector('aside').innerText;`);
  await sell(`__click('红酱面'); await __sleep(150);`, `__click('刚好'); await __sleep(200); __click('确认收款并接单');`);
  await sell(`__click('黑酱面'); await __sleep(150); __click('1½'); await __sleep(150);`, `__click('DuitNowQR'); await __sleep(200); document.querySelector('[aria-label="收款"] input[type=checkbox]').click(); await __sleep(200); __click('确认收款并接单');`);
  await sell(`__click('白酱面'); await __sleep(150); __click('大RM11'); await __sleep(150);`, `__click('刚好'); await __sleep(200); __click('确认收款并接单');`);
  check('收银接 3 单', (await fsList('orders')).length === 3);

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
  const ov = await boss.page(`await __waitFor('净收款', 15000); await __sleep(2500); return document.querySelector('main').innerText;`);
  check('概览：净收款 RM27.00（未含待核对金额）', ov.includes('RM27.00'), ov.match(/净收款[^\n]*\n([^\n]+)/)?.[1]);
  check('概览：醒目提示 2 条待核对与未入账金额', ov.includes('离线记录待核对 2 条') && ov.includes('RM13.00'));
  check('概览：8 分钟达标率无样本显示「—」', /8 分钟内达标率\s*—/.test(ov));
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

  // ---- 收支：模板只预填；作废与更正；损耗；资金往来 ----
  await boss.goto('/owner/finance');
  await boss.page(`
    await __waitFor('记一笔支出', 15000);
    const set = (el, v) => { const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
    __click('面球'); await __sleep(200);
    if (document.querySelector('[aria-label="实际金额 RM"]').value !== '') throw new Error('模板不应预填金额');
    set(document.querySelector('[aria-label="实际金额 RM"]'), '300'); await __sleep(150);
    __click('保存RM300.00'); await __waitFor('支出已记录', 20000); await __sleep(1500);
    // 录错一笔再作废并更正
    __click('煤气'); await __sleep(150); set(document.querySelector('[aria-label="实际金额 RM"]'), '25'); await __sleep(150);
    __click('保存RM25.00'); await __sleep(2500);
    [...document.querySelectorAll('li')].find(li => li.innerText.includes('煤气') && li.innerText.includes('RM25.00')).querySelector('button').click(); await __sleep(200);
    const vi = document.querySelector('input[placeholder="作废原因"]'); set(vi, '金额打错'); await __sleep(150);
    [...document.querySelectorAll('button')].find(b => b.innerText === '确认').click(); await __waitFor('已作废', 20000); await __sleep(1500);
    document.querySelector('[aria-label="面球加"]').click(); await __sleep(80); document.querySelector('[aria-label="面球加"]').click(); await __sleep(150);
    __click('保存损耗'); await __waitFor('损耗已记录', 20000); await __sleep(1500);
    set(document.querySelector('[aria-label="往来类型"]'), 'bank_deposit');
    set(document.querySelector('[aria-label="金额 RM"]'), '10'); set(document.querySelector('[aria-label="往来原因"]'), '存银行'); await __sleep(150);
    [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === '保存').pop().click(); await __waitFor('资金往来已记录', 20000); await __sleep(1500);`);
  const exps = await fsList('expenses');
  const wst = await fsList('wastage');
  check('收支：进货 RM300 有效、录错的 RM25 已作废', exps.some((e) => e.amountSen === 30000 && e.status === 'active') && exps.some((e) => e.amountSen === 2500 && e.status === 'voided'));
  check('损耗：1 面球（0.5 步长两次）', wst.length === 1 && wst[0].noodleHalfUnits === 2);
  await save(boss, 'finance-1366');

  // ---- 日结：有例外须确认；关账后写屏障 ----
  await boss.goto('/owner/close');
  await boss.page(`await __waitFor('逐步核对', 15000); await __sleep(2000);`);
  // 钱箱应有 = 备用金100 + 现金(7+11+7+6) − 进货300（钱箱付）− 存银行10 = −179 → 用屏幕预览值作为实点（再少 RM1）
  const closeText = await boss.page(`
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const inputs = [...document.querySelectorAll('input[inputmode="decimal"]')];
    set(inputs[0], '0'); set(inputs[1], '9'); await __sleep(500);
    return document.querySelector('main').innerText;`);
  const expected = closeText.match(/钱箱应有\s*(-?RM[\d,.]+)/)?.[1];
  check('日结预览：钱箱应有可见、QR 差额一致', Boolean(expected) && /QR 差额\s*一致/.test(closeText), `钱箱应有 ${expected}`);
  await save(boss, 'close-before-1366');
  await boss.page(`
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    document.querySelector('input[type=checkbox]').click(); await __sleep(150);
    set(document.querySelector('input[placeholder="结转说明（必填）"]'), '3 单未出餐，明早继续'); await __sleep(150);
    __click('关账并冻结'); await __waitFor('已冻结', 30000); await __sleep(2500);`);
  const day = await fsGet(`businessDays/${(await fsList('orders'))[0].businessDate}`);
  check('关账：营业日 closed，版本 1', day?.state === 'closed' && day?.closedVersion === 1);
  const blocked = await pos.page(`
    __click('红酱面'); await __sleep(150); __click('加入本单'); await __sleep(200); __click('收款RM'); await __sleep(400); __click('刚好'); await __sleep(200); __click('确认收款并接单');
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
  const pend = await boss.page(`return await __waitFor('关账后待调整1项', 15000);`);
  check('日结页显示关账后待调整 1 项', pend);
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
  await boss.page(`await __waitFor('净收款', 15000); await __sleep(2500); __click('导出CSV'); await __sleep(4000);`);
  const files = await readdir(DL);
  check('CSV 下载：日结 + 汇总 + 订单 + 收款退款 + 支出 + 损耗', ['日结_', '汇总_', '订单_', '收款退款_', '支出_', '损耗_'].every((p) => files.some((f) => f.startsWith(p))), files.join(', '));
  const ordersCsv = files.find((f) => f.startsWith('订单_'));
  const csvText = ordersCsv ? await readFile(join(DL, ordersCsv), 'utf8') : '';
  check('订单 CSV：UTF-8 BOM 与时区', csvText.startsWith('﻿') && csvText.includes('(Asia/Kuala_Lumpur)'));

  // ---- 手机老板概览 ----
  await boss.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await boss.goto('/owner');
  const overflow = await boss.page(`await __waitFor('净收款', 15000); await __sleep(2500); return document.documentElement.scrollWidth - document.documentElement.clientWidth;`);
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
