// 测试云冒烟检查（不登录、不写数据）：网站是新版本、全部 Callable 已上线且拒绝未登录调用、Rules 拒绝匿名读取。
// 用法：node scripts/staging-smoke.mjs <projectId> <期望的 JS 包文件名>
const [project = 'wantan-staging', bundle] = process.argv.slice(2);
const SITE = `https://${project}.web.app`;
const FN = `https://asia-southeast1-${project}.cloudfunctions.net`;
// 从入口读取全部 Callable，新增收支 / 批次 / 归属 / 目标命令也必须逐一检查上线。
const { readFile } = await import('node:fs/promises');
const entry = await readFile(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
const COMMANDS = [...entry.matchAll(/^export const (\w+)Cmd\s*=\s*command\(/gm)].map((m) => m[1]);
if (!COMMANDS.length) throw new Error('未找到待检查的 Callable，拒绝跳过后端验证');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const html = await (await fetch(`${SITE}/pos`, { cache: 'no-store' })).text();
const js = html.match(/assets\/(index-[\w-]+\.js)/)?.[1];
check('网站可访问，SPA 路由回落到 index.html', html.includes('<div id="root">'), js);
if (bundle) check('网站是本次构建的版本', js === bundle, `${js} / 期望 ${bundle}`);
const code = await (await fetch(`${SITE}/assets/${js}`)).text();
const q = (s) => ['`', '"', "'"].some((c) => code.includes(s.replaceAll('@', c)));
check('前端连接本项目且未连接 Emulator', q(`VITE_FIREBASE_PROJECT_ID:@${project}@`) && q('VITE_USE_EMULATORS:@false@'));
const sw = await fetch(`${SITE}/sw.js`);
check('Service Worker 可下载（离线营业）', sw.ok && (sw.headers.get('cache-control') ?? '').includes('no-cache'), sw.headers.get('cache-control'));
const photo = await fetch(`${SITE}/photos/dish.dry_noodle.red.v1.webp`);
check('营业照片可下载', photo.ok && photo.headers.get('content-type')?.includes('webp'));
// 收款码原图：线上提供的字节与用户原图一致（只下载比对，不扫码、不付款）。
const { createHash } = await import('node:crypto');
const qr = Buffer.from(await (await fetch(`${SITE}/payment/tng-receiving-original.jpg`)).arrayBuffer());
check('收款码原图字节未改动（sha256）', createHash('sha256').update(qr).digest('hex') === '08223503ac18f4345632311d6bd2ad8b02a155e8545329c16721c8034e7567fc', `${qr.length} bytes`);

const bad = [];
await Promise.all(COMMANDS.map(async (c) => {
  const r = await fetch(`${FN}/${c}Cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { storeId: 'hao-pontian-main' } }) });
  const body = await r.json().catch(() => ({}));
  // 未登录：要么先被输入校验拒绝，要么被身份检查拒绝；两者都说明函数已上线且没有执行业务。
  if (!['UNAUTHENTICATED', 'INVALID_ARGUMENT'].includes(body?.error?.status)) bad.push(`${c}:${r.status}:${body?.error?.status ?? 'no-json'}`);
}));
check(`${COMMANDS.length} 个 Callable 已上线，未登录调用被拒绝（无 404 / INTERNAL）`, bad.length === 0, bad.join(', '));

const FS = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/stores/hao-pontian-main`;
const denied = [];
for (const p of ['orders', 'payments', 'paymentWriteOffs', 'members', 'costEvents', 'menuVersions', 'bomVersions', 'dailyReports', 'config/public',
  'ingredients', 'ingredientBatches', 'recurringSlots', 'startupCosts', 'goals', 'expenseLinks']) {
  const r = await fetch(`${FS}/${p}`);
  if (r.status !== 403) denied.push(`${p}:${r.status}`);
}
check('Rules：匿名读取全部被拒绝（403）', denied.length === 0, denied.join(', '));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
