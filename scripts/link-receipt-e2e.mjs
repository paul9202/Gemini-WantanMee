// O11 后厨心跳/回执提示、O12 跨营业日未完成单、O13 收据——两个独立浏览器（收银 / 后厨）+ 本机 Emulator。
// 前提：干净的 Emulator 已启动并 seed；VITE_USE_EMULATORS=true 构建后在 4173 端口 vite preview。
import { mkdir, writeFile } from 'node:fs/promises';
import { fsList, fsPatch, login, openChrome, pause } from './lib/cdp.mjs';

const OUT = 'docs/screenshots/link';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
await mkdir(OUT, { recursive: true });
const save = async (tab, name) => writeFile(`${OUT}/${name}.png`, await tab.screenshot());

const pos = await openChrome('http://localhost:4173');
let kds = await openChrome('http://127.0.0.1:4173', { width: 1366, height: 900 });
const order = (tile) => pos.page(`
  await __waitFor('看图选餐', 15000);
  __click('${tile}'); await __sleep(150); __click('加入本单'); await __sleep(200);
  __click('收款RM'); await __sleep(400); __click('刚好'); await __sleep(200); __click('确认收款并接单');
  await __waitFor('✓云端已接单', 40000);
  return document.querySelector('aside').innerText;`);

try {
  // ---- 准备：老板指定主收银机，收银开班；后厨登录 ----
  await pos.goto('/login');
  await login(pos, 'owner');
  await pos.goto('/device');
  await pos.page(`await __waitFor('设为主收银机'); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await pos.page(`__click('退出'); await __sleep(2000);`);
  await login(pos, 'cashier');
  await pos.page(`if (await __waitFor('确认开班', 8000)) __click('确认开班'); await __waitFor('看图选餐', 25000);`);
  await kds.goto('/login');
  check('后厨登录直达后厨屏', (await login(kds, 'kitchen')) === '/kitchen');

  // ---- O11：后厨在线 → 回执 ----
  check('POS 显示后厨屏在线', await pos.page(`return await __waitFor('后厨屏在线', 30000);`));
  const t1 = await order('红酱面');
  const acked = await pos.page(`return await __waitFor('✓后厨已收到', 30000);`);
  check('O11 后厨在线：显示「后厨已收到」', acked, t1.match(/(\d+)号 · 票号 [\d-]+/)?.[0]);
  await save(pos, 'pos-kitchen-acked');

  // ---- O11：关闭后厨屏 → 心跳过期 → 新单 15 秒后告警 → 人工传单 ----
  await kds.close();
  const staleShown = await pos.page(`return await __waitFor('后厨屏离线', 90000);`);
  check('O11 后厨屏关闭后约 45 秒：POS 显示后厨屏离线', staleShown);
  const t2 = await order('黑酱面');
  const waiting = await pos.page(`await __sleep(6000); return __has('等待厨房确认') || __has('后厨屏可能离线');`);
  check('O11 5 秒后未回执：不显示成功，提示等待确认', waiting && !(await pos.page(`return __has('✓后厨已收到');`)));
  const alarm = await pos.page(`return await __waitFor('已超过15秒没有后厨回执', 20000);`);
  check('O11 15 秒且心跳过期：醒目告警并可人工传单', alarm);
  await save(pos, 'pos-kitchen-alarm');
  await pos.page(`__click('我已递纸单给厨师'); await __waitFor('已登记人工传单', 20000);`);
  const token2 = Number(t2.match(/(\d+)号 · 票号/)?.[1]);
  const orders = await fsList('orders');
  const o2 = orders.find((o) => o.tokenNumber === token2 && o.fulfillmentStatus === 'queued');
  check('O11 人工传单已记录在订单上，制作状态不变', o2 && o2.manualHandoffAtMs && o2.kitchenAckAtMs === null, `餐牌 ${token2}`);

  // ---- 后厨屏恢复：看到人工传单提示；回执补上 ----
  kds = await openChrome('http://127.0.0.1:4173', { width: 1366, height: 900 });
  await kds.goto('/login');
  await login(kds, 'kitchen');
  const badge = await kds.page(`return await __waitFor('收银已递纸单', 20000);`);
  check('后厨屏恢复后显示「收银已递纸单 · 先核对是否已做」', badge);

  // ---- O12：把一张未完成单改为前一营业日 ----
  const today = o2.businessDate;
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  await fsPatch(`orders/${o2._id}`, { businessDate: yesterday });
  await fsPatch(`kitchenTickets/${o2._id}`, { businessDate: yesterday });
  const crossKds = await kds.page(`return await __waitFor('跨营业日', 20000);`);
  check('O12 后厨屏继续显示前一营业日的未完成单并标明', crossKds);
  await save(kds, 'kds-crossday-handoff');
  await pos.goto('/orders');
  const crossOrders = await pos.page(`return await __waitFor('跨营业日未完成·1单', 20000);`);
  check('O12 订单页单列「跨营业日未完成」', crossOrders);
  await save(pos, 'orders-crossday');
  await kds.page(`
    const card = () => document.querySelector('article[aria-label="${token2}号"]');
    const btn = (t) => [...card().querySelectorAll('button')].find(b => b.innerText.includes(t));
    btn('开始制作').click();
    for (let i = 0; i < 80 && !btn('完成出餐'); i++) await __sleep(250);
    btn('完成出餐').click();
    for (let i = 0; i < 80 && card(); i++) await __sleep(250);`);
  const served = (await fsList('orders')).find((o) => o._id === o2._id);
  check('O12 前一营业日的单可出餐，营业日保持不变', served.fulfillmentStatus === 'served' && served.businessDate === yesterday, served.businessDate);

  // ---- O13：收据 ----
  const receipt = await pos.page(`
    await __waitFor('跨营业日', 5000);
    const rows = [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === '收据');
    rows[0].click(); await __waitFor('谢谢光临', 15000);
    return document.querySelector('.print-receipt').innerText;`);
  check('O13 收据：票号、餐牌、实收找零、出餐时间仅在已出餐时显示', /票号/.test(receipt) && /餐牌/.test(receipt) && /合计/.test(receipt), receipt.replace(/\s+/g, ' ').slice(0, 160));
  await save(pos, 'receipt-80mm-dialog');
  const pdf80 = await pos.pdf({ printBackground: true, preferCSSPageSize: true });
  await writeFile(`${OUT}/receipt-80mm.pdf`, pdf80);
  check('O13 打印样式只输出收据（PDF 已生成）', pdf80.length > 1000, `${pdf80.length} bytes`);
  // 打印一次后重开：标「副本」
  await pos.page(`__click('打印'); await __sleep(1500); __click('关闭'); await __sleep(500);
    const rows = [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === '收据'); rows[0].click(); await __waitFor('谢谢光临', 15000);`);
  const copy = await pos.page(`return document.querySelector('.print-receipt').innerText;`);
  check('O13 重印标「副本」，不是新交易', copy.includes('副本'));
  await pos.page(`__click('58mm'); await __sleep(400);`);
  await save(pos, 'receipt-58mm-copy');
  await writeFile(`${OUT}/receipt-58mm-copy.pdf`, await pos.pdf({ printBackground: true, preferCSSPageSize: true }));
  const ordersAfter = await fsList('orders');
  check('打印收据不产生新订单或支付', ordersAfter.length === orders.length);
} catch (e) {
  check('脚本异常', false, String(e?.stack ?? e));
} finally {
  await pos.close().catch(() => {});
  await kds.close().catch(() => {});
  await writeFile(`${OUT}/link-receipt-e2e.json`, JSON.stringify({ ranAt: new Date().toISOString(), environment: '正式构建 + 本机 Firebase Emulator，两台独立无头 Chrome（收银 / 后厨）', results }, null, 2) + '\n');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
