/**
 * DeepSeek 备用验收模式（受限、限时）：指定老板账号的 AI 识别 / 解读请求跳过 Claude，直接走 DeepSeek。
 * 不改动 ANTHROPIC_API_KEY；只影响名单内的账号、只在这一家门店，到期自动失效（最长 120 分钟），可随时清除。
 * 使用本机 Application Default Credentials（gcloud auth application-default login），不读取任何私钥文件。
 *
 * 用法：
 *   npm --prefix functions run ai:acceptance -- --project wantan-staging --uid <老板UID> --minutes 30 --reason "DeepSeek 备用验收"
 *   npm --prefix functions run ai:acceptance -- --project wantan-staging --status
 *   npm --prefix functions run ai:acceptance -- --project wantan-staging --clear
 * 本机演练：在 Emulator 运行时加 --emulator（只接受 demo- 项目）。
 */
import { userInfo } from 'node:os';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ACCEPTANCE_MAX_MS, activeAcceptance, clearAcceptance, setAcceptance } from '../src/aiCost/acceptance';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const projectId = arg('project');
const storeId = arg('store') ?? 'hao-pontian-main';
const emulator = flag('emulator');

if (!projectId) {
  console.error('缺少参数：--project <项目ID>');
  process.exit(1);
}
const emulatorEnv = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
if (emulator !== emulatorEnv || emulator !== projectId.startsWith('demo-')) {
  console.error('拒绝执行：真实项目不能带 --emulator 或 Emulator 环境变量；本机演练必须同时使用 --emulator、Emulator 与 demo- 项目。');
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();

async function main() {
  const ref = db.doc(`stores/${storeId}/config/aiCost`);
  if (flag('status')) {
    const a = (await ref.get()).data()?.acceptance;
    const now = Date.now();
    if (!a) console.log(`${projectId} / ${storeId}：没有备用验收设置，按正常主备（Claude → DeepSeek）运行。`);
    else console.log(`${projectId} / ${storeId}：${a.untilMs > now ? `备用验收中，剩 ${Math.ceil((a.untilMs - now) / 60_000)} 分钟` : '已过期（按正常主备运行）'}；账号 ${a.uids.join(', ')}；原因：${a.reason}`);
    return;
  }
  if (flag('clear')) {
    await clearAcceptance(db, storeId);
    console.log(`${projectId} / ${storeId}：已清除备用验收设置，恢复正常主备。`);
    return;
  }
  const uid = arg('uid');
  const minutes = Number(arg('minutes') ?? 30);
  const reason = arg('reason') ?? '';
  if (!uid) {
    console.error(`缺少参数：--uid <老板UID>（可选 --minutes，最长 ${ACCEPTANCE_MAX_MS / 60_000}；--reason 必填）`);
    process.exit(1);
  }
  const a = await setAcceptance(db, { storeId, uids: [uid], minutes, reason, setBy: `script:${userInfo().username}`, nowMs: Date.now() });
  if (!activeAcceptance(a, Date.now(), uid)) throw new Error('写入后校验失败');
  console.log(`${projectId} / ${storeId}：账号 ${uid} 的 AI 请求在 ${new Date(a.untilMs).toISOString()} 之前跳过 Claude、直接走 DeepSeek。验收完请运行 --clear。`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
