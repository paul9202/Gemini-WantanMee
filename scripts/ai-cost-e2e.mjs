// AI 记成本端到端（真实 React 应用 + Emulator；供应商为 Emulator 模拟传输，不调用真实 Claude / DeepSeek）：
// 文字整理 → 改金额 → 未保存前零入账 → 确认整单入账；未知付款不能保存；私人行不计入；
// 收据照片私有上传 → 差额提示 → 改正后入账；采购记录回看与补用量（不新增支出）；开销分析统计与解读；
// 两家都失败保留原话、可手动填写；主服务失败由备用接手；刷新后草稿恢复；桌面 / 手机截图与无横向溢出。
// 前提：Emulator 已启动并 seed；前端以 VITE_USE_EMULATORS=true 运行。端口可用环境变量覆盖：
//   E2E_ORIGIN（默认 http://127.0.0.1:4173）、E2E_FIRESTORE（默认 127.0.0.1:8080）。
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { login, openChrome, pause } from './lib/cdp.mjs';

const ORIGIN = process.env.E2E_ORIGIN ?? 'http://127.0.0.1:4173';
const FS = `http://${process.env.E2E_FIRESTORE ?? '127.0.0.1:8080'}/v1/projects/demo-hao-wantan/databases/(default)/documents/stores/hao-pontian-main`;
const OUT = 'docs/ai-cost-assistant-2026-10-25/app-screenshots';
const RECEIPT = resolve(process.env.E2E_RECEIPT ?? `${OUT}/../e2e-receipt.jpg`);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
await mkdir(OUT, { recursive: true });

const decode = (v) => v.stringValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : v.doubleValue ?? v.booleanValue ?? (v.nullValue !== undefined ? null : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)])) : v.arrayValue ? (v.arrayValue.values ?? []).map(decode) : v));
async function fsList(collection) {
  const r = await (await fetch(`${FS}/${collection}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })).json();
  return (r.documents ?? []).map((d) => ({ _id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decode(v)])) }));
}
// 只看本次脚本新增的记录（Emulator 里可能已有之前的数据）。
const baseline = new Set((await fsList('expenses')).map((e) => e._id));
const aiExpenses = async () => (await fsList('expenses')).filter((e) => e.costDraftId && !baseline.has(e._id));

// 测试用收据照片：由原型的示例收据 SVG 转成 JPEG（模拟识别不读取图片内容，只验证上传、私有读取与流程）。
await writeFile(RECEIPT, await sharp(resolve('docs/ai-cost-assistant-2026-10-25/mockup/sample-receipt.svg')).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer());

const SET = `const set = (el, v) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const q = (s) => document.querySelector(s);
  const byLabel = (t) => [...document.querySelectorAll('label')].find((l) => l.innerText.replace(/\\s+/g, '').startsWith(t));`;

const desk = await openChrome(ORIGIN, { width: 1440, height: 1000 });
const shot = async (tab, name) => writeFile(`${OUT}/${name}.png`, await tab.screenshot());
const fullShot = async (tab, name) => {
  const h = await tab.evaluate('Math.max(document.querySelector("main")?.scrollHeight ?? 0, document.body.scrollHeight)');
  const w = await tab.evaluate('window.innerWidth');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: Math.min(h + 120, 4000), deviceScaleFactor: 1, mobile: w < 768 });
  await pause(500);
  await shot(tab, name);
  await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 768 ? 844 : 1000, deviceScaleFactor: 1, mobile: w < 768 });
};
const textFlow = (tab, text) => tab.page(`${SET}
  await __waitFor('今天花了什么', 20000);
  [...document.querySelectorAll('[role=tab]')].find((b) => b.innerText.includes('说一句'))?.click(); await __sleep(200);
  set(q('textarea'), ${JSON.stringify(text)}); await __sleep(200); __click('帮我整理');
  for (let i = 0; i < 120; i++) { if (__has('帮你整理好了') || __has('这次没能整理出来')) return document.body.innerText.includes('帮你整理好了') ? 'review' : 'failed'; await __sleep(250); }
  return 'timeout';`);
const lineNames = (tab) => tab.page(`return [...document.querySelectorAll('article input[placeholder="例如：葱"]')].map((i) => i.value);`);
const saveBtn = (tab) => tab.page(`const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('确认保存')); return b ? { text: b.innerText.replace(/\\s+/g, ''), disabled: b.disabled } : null;`);
const confirmSave = async (tab) => {
  const ok = await tab.page(`for (let i = 0; i < 20; i++) { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('确认保存') && !x.disabled); if (b) { b.click(); break; } await __sleep(250); }
    return await __waitFor('这笔记好了', 30000);`);
  if (!ok) console.log('  保存未完成，页面提示：', await tab.page(`return [...document.querySelectorAll('[role=alert]')].map((a) => a.innerText).join(' / ');`));
  return ok;
};
const next = (tab) => tab.page(`__click('继续记一笔'); await __sleep(600);`);

try {
  await desk.goto('/login');
  await login(desk, 'owner');
  await desk.goto('/owner/finance/ingredients', 4000);
  check('入口：AI 记成本页（原食材与用料路径）', await desk.page(`return await __waitFor('今天花了什么，告诉我就好', 15000) && __has('详细用料管理');`));
  if (await desk.page(`return __has('AI整理尚未开启');`)) {
    await desk.page(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('开启 AI 整理')).click(); for (let i = 0; i < 120 && __has('AI整理尚未开启'); i++) await __sleep(250);`);
  }
  check('AI 已开启（按店开关）', await desk.page(`return !__has('AI整理尚未开启');`));
  await shot(desk, '01-desktop-entry');

  // ---- A：文字整理 → 改金额 → 未保存零入账 → 确认整单入账 ----
  check('文字：整理出结果', (await textFlow(desk, '今天买了葱10块、肉碎32块、煤气35块，都付了')) === 'review');
  check('文字：三项 葱 / 肉碎 / 煤气', JSON.stringify(await lineNames(desk)) === JSON.stringify(['葱', '肉碎', '煤气']), JSON.stringify(await lineNames(desk)));
  check('文字：模拟识别标明（不冒充真实模型）', await desk.page(`return __has('Claude·模拟');`));
  check('整理后、保存前：账本零新增', (await aiExpenses()).length === 0);
  await fullShot(desk, '02-desktop-text-review');
  await desk.page(`${SET} set(q('[aria-label="项目 2 金额"]'), '30'); await __sleep(400);`);
  const btn = await saveBtn(desk);
  check('肉碎 32 → 30：合计实时变成 RM75.00', btn?.text.includes('RM75.00') && !btn.disabled, btn?.text);
  await pause(1600); // 自动保存
  check('改金额后仍未入账', (await aiExpenses()).length === 0);
  check('确认保存：显示「这笔记好了」', await confirmSave(desk));
  const exps = await aiExpenses();
  check('入账结果严格等于最终内容：3 笔共 RM75.00、已付、来源未说明', exps.length === 3 && exps.reduce((s, e) => s + e.amountSen, 0) === 7500 && exps.every((e) => e.paidSen === e.amountSen && e.paymentSource === 'unspecified'), JSON.stringify(exps.map((e) => [e.description, e.amountSen])));
  check('缺数量也能保存，提示用量可稍后补', await desk.page(`return __has('用量可稍后补');`));
  await shot(desk, '03-desktop-saved');
  const firstDraft = exps[0].costDraftId;

  // ---- 未知付款不能保存；改为待付后可以 ----
  await next(desk);
  check('未知付款：整理出结果', (await textFlow(desk, '买了面薄45块')) === 'review');
  const b2 = await saveBtn(desk);
  check('未知付款：保存按钮不可用并就近说明', b2?.disabled && await desk.page(`return __has('请确认这一项是否已付款');`));
  await shot(desk, '04-desktop-unknown-payment');
  await desk.page(`${SET} set(byLabel('这笔是否已付款？').querySelector('select'), 'unpaid'); await __sleep(300);`);
  check('选择待付后可以保存', await confirmSave(desk));
  check('待付：入账但已付为 0', (await aiExpenses()).some((e) => e.description === '面薄' && e.amountSen === 4500 && e.paidSen === 0));

  // ---- 私人行：标记不计入营业，凭证保留 ----
  await next(desk);
  await textFlow(desk, '葱10块、洗发水12块，都付了');
  await desk.page(`${SET}
    const art = [...document.querySelectorAll('article')].find((a) => a.querySelector('input[placeholder="例如：葱"]')?.value === '洗发水');
    art.querySelector('details').open = true; await __sleep(100);
    [...art.querySelectorAll('label')].find((l) => l.innerText.includes('不计入营业成本')).querySelector('input').click(); await __sleep(200);
    set(art.querySelector('input[placeholder="例如：家里用的洗发水"]'), '家里用的洗发水'); await __sleep(300);`);
  check('私人行：营业合计只算葱 RM10.00', (await saveBtn(desk))?.text.includes('RM10.00'));
  check('私人行：保存', await confirmSave(desk));
  const rcpts = await fsList('costReceipts');
  const batchesBase = (await fsList('ingredientBatches')).length;
  check('私人行：只写营业支出，凭证保留排除原因', !(await aiExpenses()).some((e) => e.description === '洗发水') && rcpts.some((r) => (r.excluded ?? []).some((x) => x.name === '洗发水' && x.reason === '家里用的洗发水')));

  // ---- B：收据照片 → 私有上传 → 差额 → 改正后入账 ----
  await next(desk);
  await desk.page(`[...document.querySelectorAll('[role=tab]')].find((b) => b.innerText.includes('拍照')).click(); await __sleep(300);`);
  const { root } = await desk.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await desk.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[aria-label="选择收据图片"]' });
  await desk.send('DOM.setFileInputFiles', { nodeId, files: [RECEIPT] });
  check('收据：本机预览第 1 页', await desk.page(`return await __waitFor('第1页', 5000);`));
  await desk.page(`__click('识别这张收据');`);
  check('收据：识别出结果', await desk.page(`return await __waitFor('帮你整理好了', 40000);`));
  check('收据：私有图片已载入来源区', await desk.page(`for (let i = 0; i < 40; i++) { const img = document.querySelector('#cost-source img'); if (img?.complete && img.naturalWidth > 0) return true; await __sleep(250); } return false;`));
  check('收据：与收据原总额相差 RM3.00，保存不可用', await desk.page(`return __has('与收据原总额相差RM3.00');`) && (await saveBtn(desk))?.disabled);
  await fullShot(desk, '05-desktop-receipt-difference');
  await desk.page(`${SET} set(q('[aria-label="项目 2 金额"]'), '32'); await __sleep(400);`);
  check('收据：改正后差额消失，确认保存 RM52.00', !(await desk.page(`return __has('与收据原总额相差');`)) && (await saveBtn(desk))?.text.includes('RM52.00'));
  check('收据：保存', await confirmSave(desk));
  const receiptRows = (await aiExpenses()).filter((e) => e.costReceiptId && rcpts.every((r) => r._id !== e.costReceiptId));
  check('收据：折扣只记一次，三笔合计 RM52.00；找零不成支出', receiptRows.length === 3 && receiptRows.reduce((s, e) => s + e.amountSen, 0) === 5200, JSON.stringify(receiptRows.map((e) => [e.description, e.amountSen])));
  await desk.page(`__click('查看这笔记录'); await __sleep(1500);`);
  check('采购记录：打开这张收据的详情并显示原图', await desk.page(`return await __waitFor('来源·AI·收据', 8000) && !!document.querySelector('[role=dialog] img');`));
  await shot(desk, '06-desktop-record-detail');
  await desk.page(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === '关闭').click(); await __sleep(300);`);

  // ---- 补用量：不新增支出 ----
  const beforeCount = (await fsList('expenses')).length;
  const batchesBefore = (await fsList('ingredientBatches')).length;
  await desk.page(`const row = [...document.querySelectorAll('li button')].find((b) => b.innerText.includes('用量待补') && b.innerText.includes('葱')); row.click(); await __sleep(500); __click('补数量'); await __sleep(400);`);
  await desk.page(`${SET} set(byLabel('数量').querySelector('input'), '1'); await __sleep(150); __click('保存数量'); await __waitFor('数量已补上', 15000);`);
  check('补用量：多一个库存批次，支出数不变', (await fsList('ingredientBatches')).length === batchesBefore + 1 && (await fsList('expenses')).length === beforeCount);
  await fullShot(desk, '07-desktop-history');

  // ---- C：开销分析 ----
  await desk.page(`[...document.querySelectorAll('[role=tab]')].find((b) => b.innerText.includes('开销分析')).click();`);
  check('分析：先显示账本统计', await desk.page(`return await __waitFor('花在哪里', 20000);`));
  const month = new Date().toISOString().slice(0, 7);
  const total = (await fsList('expenses')).filter((e) => e.status === 'active' && !e.settlesExpenseId && e.category !== 'capital' && e.businessDate.startsWith(month)).reduce((s, e) => s + e.amountSen, 0);
  check('分析：发生额与账本逐项合计一致', await desk.page(`return __has(${JSON.stringify(`RM${(total / 100).toFixed(2)}`.replace('RM', ''))});`), `账本 ${total}`);
  await desk.page(`__click('生成解读');`);
  check('分析：生成解读并附可点开的记录', await desk.page(`return await __waitFor('AI开销解读', 40000) && [...document.querySelectorAll('section button')].some((b) => /RM\\d/.test(b.innerText));`));
  await fullShot(desk, '08-desktop-analysis');

  // ---- 两家都失败 / 备用接手 ----
  await desk.page(`[...document.querySelectorAll('[role=tab]')].find((b) => b.innerText.includes('记一笔')).click(); await __sleep(500);`);
  check('两家都失败：显示失败并保留原话', (await textFlow(desk, '葱10块 #mock:all-down')) === 'failed' && await desk.page(`return __has('原话和图片都已保留');`));
  await shot(desk, '09-desktop-provider-failure');
  await desk.page(`__click('手动填写'); await __sleep(800);`);
  check('失败后可以手动填写', await desk.page(`return __has('帮你整理好了') && !!document.querySelector('article input[placeholder="例如：葱"]');`));
  await desk.page(`__click('先放着，记新的一笔'); await __sleep(600);`);
  check('主服务失败：备用 DeepSeek 接手', (await textFlow(desk, '葱10块 #mock:claude-down')) === 'review' && await desk.page(`return __has('DeepSeek（备用）');`));
  await shot(desk, '10-desktop-backup');

  // ---- 刷新恢复 ----
  const current = await desk.evaluate(`localStorage.getItem('hao.aiCost.currentDraft')`);
  const attemptsBefore = (await fsList(`costDrafts/${current}/attempts`)).length;
  await desk.goto('/owner/finance/ingredients', 4000);
  check('刷新后恢复同一份草稿', await desk.page(`return await __waitFor('帮你整理好了', 15000) && __has('DeepSeek（备用）');`) && (await desk.evaluate(`localStorage.getItem('hao.aiCost.currentDraft')`)) === current);
  check('刷新没有再次调用模型', (await fsList(`costDrafts/${current}/attempts`)).length === attemptsBefore, `${attemptsBefore} 次尝试`);

  // ---- 响应式：无横向溢出 ----
  for (const [w, h] of [[375, 812], [390, 844], [768, 1024], [1024, 768], [1440, 1000]]) {
    await desk.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
    await pause(600);
    const o = await desk.evaluate('(() => { const m = document.querySelector("main"); return { doc: document.documentElement.scrollWidth, main: m ? m.scrollWidth - m.clientWidth : 0, w: window.innerWidth }; })()');
    check(`${w}px 核对页无横向溢出`, o.doc <= o.w && o.main <= 1, JSON.stringify(o));
  }
  await desk.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  check('未保存的草稿（失败 / 备用 / 恢复）都没有入账', !(await aiExpenses()).some((e) => e.costDraftId === current) && Boolean(firstDraft));
} catch (e) {
  check('脚本异常', false, e?.stack ?? String(e));
} finally {
  await desk.close();
}

// ---- 手机 ----
const phone = await openChrome(ORIGIN, { width: 390, height: 844 });
try {
  await phone.goto('/login');
  await login(phone, 'owner');
  await phone.goto('/owner/finance/ingredients', 4000);
  await phone.page(`if (__has('帮你整理好了')) { __click('先放着，记新的一笔'); await __sleep(600); }`);
  await shot(phone, 'phone-entry');
  check('手机：文字整理', (await textFlow(phone, '今天买了葱10块、肉碎32块，都付了')) === 'review');
  check('手机：保存条在可视区底部', await phone.page(`const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('确认保存')); const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && r.top > innerHeight * 0.6;`));
  await shot(phone, 'phone-review');
  await phone.page(`[...document.querySelectorAll('[role=tab]')].find((b) => b.innerText.includes('开销分析')).click(); await __waitFor('花在哪里', 20000);`);
  await shot(phone, 'phone-analysis');
  await phone.page(`[...document.querySelectorAll('[role=tab]')].find((b) => b.innerText.includes('记一笔')).click(); await __sleep(500); __click('先放着，记新的一笔'); await __sleep(500); [...document.querySelectorAll('[role=tab]')].find((b) => b.innerText.includes('拍照')).click(); await __sleep(300);`);
  check('手机：拍照与相册分开入口', await phone.page(`return __has('拍照') && __has('从相册选') && !!document.querySelector('input[capture=environment]');`));
  await shot(phone, 'phone-receipt');
} catch (e) {
  check('手机脚本异常', false, e?.stack ?? String(e));
} finally {
  await phone.close();
}

await writeFile(`${OUT}/results.json`, JSON.stringify({ at: new Date().toISOString(), origin: ORIGIN, provider: 'Emulator 模拟传输（未调用真实 API）', results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
