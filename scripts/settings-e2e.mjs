// 设置与培训端到端：邀请成员 → 设置密码链接 → 员工登录；发布菜单价/售罄 → 收银机按新价收款；
// 英文可选设置（POS/KDS）；培训图卡截图与 A4 打印 PDF；停用成员。
// 前提：干净的 Emulator 已启动并 seed；VITE_USE_EMULATORS=true 构建后在 4173 端口 vite preview。
import { mkdir, writeFile } from 'node:fs/promises';
import { fsGet, fsList, login, openChrome } from './lib/cdp.mjs';

const OUT = 'docs/screenshots/settings';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
await mkdir(OUT, { recursive: true });

const SET = `const set = (el, v) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';

const boss = await openChrome('http://127.0.0.1:4173');
const pos = await openChrome('http://localhost:4173');
const staff = await openChrome('http://localhost:4173', { width: 1366, height: 900 });
const save = async (tab, name) => writeFile(`${OUT}/${name}.png`, await tab.screenshot());
const staffEmail = `erchu-${Date.now()}@example.test`;
const staffPassword = `Kds-${crypto.randomUUID().slice(0, 8)}`;

try {
  // ---- 老板：设置页 ----
  await boss.goto('/login');
  await login(boss, 'owner');
  await boss.goto('/owner/settings');
  check('设置页显示成员、菜单、成本三部分', await boss.page(`return (await __waitFor('发布新菜单版本', 15000)) && __has('成员') && __has('发布新成本版本');`));

  // ---- 邀请后厨成员 → 设置密码链接 ----
  const link = await boss.page(`${SET}
    set(document.querySelector('[aria-label="员工邮箱"]'), ${JSON.stringify(staffEmail)});
    set(document.querySelector('[aria-label="称呼"]'), '二厨');
    set(document.querySelector('[aria-label="新成员岗位"]'), 'kitchen');
    await __sleep(200); __click('邀请');
    const end = Date.now() + 20000;
    while (Date.now() < end) { const el = document.querySelector('[aria-label="设置密码链接"]'); if (el?.value) return el.value; await __sleep(250); }
    return null;`);
  check('邀请成员后得到设置密码链接', link && link.includes('oobCode='), link?.slice(0, 60));
  await save(boss, 'members-1366');
  const members = await fsList('members');
  check('成员文档：后厨岗位、启用', members.some((m) => m.email === staffEmail && m.role === 'kitchen' && m.active === true));

  // 员工打开链接设置密码（Auth Emulator 的 resetPassword 接口与真实链接同一 oobCode）
  const oobCode = new URL(link).searchParams.get('oobCode');
  const reset = await (await fetch(`${AUTH}/accounts:resetPassword?key=demo-api-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode, newPassword: staffPassword }) })).json();
  check('设置密码链接可用', reset.email === staffEmail, reset.error?.message);

  await staff.goto('/login');
  const staffPath = await staff.page(`${SET}
    set(document.querySelector('#email'), ${JSON.stringify(staffEmail)});
    set(document.querySelector('#password'), ${JSON.stringify(staffPassword)});
    document.querySelector('form').requestSubmit(); await __sleep(4000); return location.pathname;`);
  check('新员工登录后进入后厨', staffPath === '/kitchen', staffPath);

  // ---- 后厨切换英文 ----
  await staff.goto('/device');
  await staff.page(`await __waitFor('设备与连接'); __click('English'); await __sleep(500);`);
  check('设备页切换英文', await staff.page(`return __has('Device&connection') && __has('Language');`));
  await save(staff, 'device-en-1366');

  // ---- 收银开班 ----
  await pos.goto('/login');
  await login(pos, 'owner');
  await pos.goto('/device');
  await pos.page(`await __waitFor('设为主收银机'); __click('设为主收银机'); await __waitFor('就是本机', 25000);`);
  await pos.page(`__click('退出'); await __sleep(2000);`);
  await login(pos, 'cashier');
  await pos.page(`if (await __waitFor('确认开班', 8000)) __click('确认开班'); await __waitFor('看图选餐', 25000);`);
  check('发布前：红酱面 RM7 起', await pos.page(`return __has('RM7起');`));

  // ---- 老板发布菜单：小份面 RM8（净面 RM4）、干捞云吞售罄 ----
  const before = (await fsGet('config/public')).activeMenuVersion;
  const pub = await boss.page(`${SET}
    set(document.querySelector('[aria-label="小（1 面球）"]'), '8.00');
    await __sleep(200);
    const box = [...document.querySelectorAll('label')].find((l) => l.innerText.trim() === '干捞云吞' && l.querySelector('input[type=checkbox]'));
    box.querySelector('input').click();
    set(document.querySelector('input[placeholder^="发布说明"]'), 'E2E：小份涨价、云吞售罄');
    await __sleep(200); __click('发布新菜单版本');
    await __waitFor('已发布菜单版本', 20000);
    return document.querySelector('main').innerText.match(/已发布菜单版本 (menu-[\\w-]+)/)?.[1];`);
  const cfg = await fsGet('config/public');
  check('发布新菜单版本', pub && cfg.activeMenuVersion === pub && cfg.activeMenuVersion !== before, `${before} → ${cfg.activeMenuVersion}`);
  await save(boss, 'menu-published-1366');

  // ---- 收银机自动改用新价、售罄入口不可点 ----
  const posState = await pos.page(`
    await __waitFor('RM8起', 20000);
    const wanton = [...document.querySelectorAll('button[aria-label="干捞云吞"]')][0];
    return { price: __has('RM8起'), soldOut: __has('已售罄'), disabled: wanton?.disabled ?? null };`);
  check('收银机自动显示新价 RM8 起', posState.price);
  check('售罄入口显示「已售罄」并不可点', posState.soldOut && posState.disabled === true, JSON.stringify(posState));

  // ---- 收银切换英文后按新价收款 ----
  await pos.goto('/device');
  await pos.page(`await __waitFor('设备与连接'); __click('English'); await __sleep(400);`);
  await pos.goto('/pos');
  const en = await pos.page(`await __waitFor('Pickthedish', 15000); return { sold: __has('Soldout'), from: __has('fromRM8'), pay: __has('Pay') };`);
  check('POS 英文：Sold out / from RM8 / Pay', en.sold && en.from && en.pay, JSON.stringify(en));
  await pos.page(`__click('RedSauce'); await __sleep(200);`);
  await save(pos, 'pos-en-1366');
  await pos.page(`__click('Add'); await __sleep(300); __click('PayRM8'); await __sleep(400); __click('Exact'); await __sleep(200); __click('Confirmpayment&send'); await __waitFor('Acceptedonline', 90000);`);
  let o;
  for (let i = 0; i < 30 && !o; i++) { o = (await fsList('orders')).find((x) => x.menuVersion === cfg.activeMenuVersion); if (!o) await new Promise((r) => setTimeout(r, 1000)); }
  check('新单按新菜单版本 RM8 成交', o && o.totalSen === 800, o ? `${o.menuVersion} ${o.totalSen}` : 'none');
  await save(pos, 'pos-en-accepted-1366');

  // ---- 后厨英文 KDS ----
  await staff.goto('/kitchen', 5000);
  const kds = await staff.page(`await __waitFor('Start', 20000); return { start: __has('Start'), name: __has('RedSauceNoodles·Small'), noodle: __has('Tocook·Thinegg') };`);
  check('KDS 英文：菜名、待下锅、开始制作', kds.start && kds.name && kds.noodle, JSON.stringify(kds));
  await save(staff, 'kds-en-1366');

  // ---- 培训图卡 ----
  await pos.goto('/training');
  check('图卡页（英文）显示 6 种餐品与图卡含义', await pos.page(`await __waitFor('Sixdishes', 10000); return __has('Twonoodles') && __has('Whatthecardsmean') && __has('Kosong');`));
  await save(pos, 'training-en-1366');
  await pos.goto('/device');
  await pos.page(`await __waitFor('Device'); __click('中文'); await __sleep(400);`);
  await pos.goto('/training');
  const zh = await pos.page(`await __waitFor('六种餐品', 10000); await __sleep(1500); return { noodles: __has('细面') && __has('面薄'), price: __has('RM8.00'), kosong: __has('半价·不能加肉') };`);
  check('图卡页（中文）：面条、当前价格、净面规则', zh.noodles && zh.price && zh.kosong, JSON.stringify(zh));
  await save(pos, 'training-zh-1366');
  await pos.send('Emulation.setEmulatedMedia', { media: 'print' });
  const printView = await pos.page(`return { header: getComputedStyle(document.querySelector('header')).display, sheet: getComputedStyle(document.querySelector('.training-sheet')).display };`);
  check('打印样式：隐藏顶部导航、保留图卡', printView.header === 'none' && printView.sheet !== 'none', JSON.stringify(printView));
  await save(pos, 'training-print-preview');
  await pos.send('Emulation.setEmulatedMedia', { media: '' });
  const pdf = await pos.pdf({ preferCSSPageSize: true, printBackground: true });
  await writeFile(`${OUT}/training-a4.pdf`, pdf);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check('A4 打印 PDF 为单页', pdf.length > 20000 && pages === 1, `${pages} 页 · ${pdf.length} bytes`);

  // ---- 手机宽度 ----
  const phone = await openChrome('http://localhost:4173', { width: 390, height: 844 });
  await phone.goto('/login');
  await login(phone, 'cashier');
  await phone.goto('/training');
  const overflow = await phone.page(`await __waitFor('六种餐品', 10000); return document.documentElement.scrollWidth - innerWidth;`);
  check('手机宽度图卡页无横向溢出', overflow <= 0, `${overflow}px`);
  await save(phone, 'training-390');
  await phone.close();

  // ---- 停用成员 ----
  await boss.goto('/owner/settings');
  await boss.page(`
    await __waitFor('二厨', 15000);
    const row = [...document.querySelectorAll('li')].find((el) => el.innerText.includes(${JSON.stringify(staffEmail)}));
    [...row.querySelectorAll('button')].find((b) => b.innerText.includes('停用')).click();
    await __sleep(3000);`);
  let m2;
  for (let i = 0; i < 20 && m2?.active !== false; i++) { m2 = (await fsList('members')).find((m) => m.email === staffEmail); if (m2?.active !== false) await new Promise((r) => setTimeout(r, 1000)); }
  check('停用成员', m2 && m2.active === false);
  await staff.goto('/kitchen', 6000);
  const blocked = await staff.page(`return document.body.innerText.slice(0, 200);`);
  check('停用后员工不能进入后厨（成员错误页或被登出）', /不是本店成员或已停用/.test(blocked) || /Staff sign-in|店内工作台登录/.test(blocked), blocked.replace(/\s+/g, ' ').slice(0, 120));
  await save(staff, 'staff-deactivated');
} catch (e) {
  check('脚本未中断', false, e.message);
} finally {
  await Promise.all([boss.close(), pos.close(), staff.close()]);
}
await writeFile(`${OUT}/settings-e2e.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
