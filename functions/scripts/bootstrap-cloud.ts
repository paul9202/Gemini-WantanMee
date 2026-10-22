/**
 * 真实云项目的门店初始化：门店配置、老板配置、第一个 owner、1–50 号餐牌（见 admin/bootstrap.ts）。
 * 使用本机 Application Default Credentials（gcloud auth application-default login），不读取任何私钥文件。
 * 老板账号须先在控制台 Authentication 中建好；本脚本只核对 UID，不创建账号、不接触密码。
 * 用法：npm --prefix functions run bootstrap:cloud -- --project wantan-staging --owner-uid <UID> [--owner-name 老板]
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { bootstrapStore } from '../src/admin/bootstrap';

const STORE_ID = 'hao-pontian-main';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const projectId = arg('project');
const ownerUid = arg('owner-uid');
const ownerName = arg('owner-name') ?? '老板';

if (!projectId || !ownerUid) {
  console.error('缺少参数：--project <项目ID> --owner-uid <老板UID>');
  process.exit(1);
}
if (projectId.startsWith('demo-') || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('拒绝执行：本脚本只用于真实云项目；Emulator 请用 npm run emulators:seed。');
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();

async function main() {
  const owner = await getAuth().getUser(ownerUid!);
  console.log(`老板账号：${owner.email ?? '(无邮箱)'} · ${owner.uid}`);
  const { created } = await bootstrapStore(db, { storeId: STORE_ID, name: '豪云吞面', ownerUid: owner.uid, ownerDisplayName: ownerName, qrPayee: null });
  console.log(`${projectId} / stores/${STORE_ID}：${created ? '已初始化' : '已存在，未改动'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
