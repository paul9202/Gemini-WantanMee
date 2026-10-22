// 测试云冒烟检查（不登录、不写数据）：网站是新版本、全部 Callable 已上线且拒绝未登录调用、Rules 拒绝匿名读取。
// 用法：node scripts/staging-smoke.mjs <projectId> <期望的 JS 包文件名>
const [project = 'wantan-staging', bundle] = process.argv.slice(2);
const SITE = `https://${project}.web.app`;
const FN = `https://asia-southeast1-${project}.cloudfunctions.net`;
const COMMANDS = ['createOrder', 'getOperationResult', 'openShift', 'releaseToken', 'ackKitchenTicket', 'startOrder', 'serveOrder', 'undoServe',
  'requestCancel', 'confirmKitchenCancel', 'confirmFullRefund', 'manageMember', 'assignRegister', 'inviteMember', 'publishMenu', 'publishBom',
  'syncOfflineEvents', 'routeManualOrderToKitchen', 'heartbeatDevice', 'recordManualHandoff', 'resolveOfflineReview', 'recordExpense',
  'voidLedgerEntry', 'recordWastage', 'recordCashMovement', 'closeBusinessDay', 'restateBusinessDay'];

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
for (const p of ['orders', 'payments', 'members', 'costEvents', 'menuVersions', 'bomVersions', 'dailyReports', 'config/public']) {
  const r = await fetch(`${FS}/${p}`);
  if (r.status !== 403) denied.push(`${p}:${r.status}`);
}
check('Rules：匿名读取全部被拒绝（403）', denied.length === 0, denied.join(', '));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
