/**
 * 本地 Emulator 种子：创建门店、老板/收银/后厨测试账号。只允许连接 Emulator 的 demo- 项目。
 * 测试账号只存在于本机 Auth Emulator，不是任何真实服务的密码。
 * 用法（Emulator 运行中）：npm run emulators:seed
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { bootstrapStore } from '../src/admin/bootstrap';

const PROJECT_ID = 'demo-hao-wantan';
const STORE_ID = 'hao-pontian-main';

export const EMULATOR_TEST_ACCOUNTS = [
  { email: 'owner@hao.test', password: 'owner-local-only', role: 'owner', displayName: '老板' },
  { email: 'cashier@hao.test', password: 'cashier-local-only', role: 'cashier', displayName: '收银' },
  { email: 'kitchen@hao.test', password: 'kitchen-local-only', role: 'kitchen', displayName: '头手' },
] as const;

// 始终指向本机 Emulator：未设置时使用 firebase.json 的默认端口，绝不连接真实项目。
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST) || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
  console.error('拒绝执行：种子脚本只能连接本机 Emulator。');
  process.exit(1);
}

initializeApp({ projectId: PROJECT_ID });
const auth = getAuth();
const db = getFirestore();

async function main() {
const uids: Record<string, string> = {};
for (const a of EMULATOR_TEST_ACCOUNTS) {
  const existing = await auth.getUserByEmail(a.email).catch(() => null);
  const user = existing ?? (await auth.createUser({ email: a.email, password: a.password, displayName: a.displayName }));
  uids[a.role] = user.uid;
}

const { created } = await bootstrapStore(db, { storeId: STORE_ID, name: '豪云吞面', ownerUid: uids.owner, ownerDisplayName: '老板', qrPayee: 'HAO PONTIAN WANTAN NOODLES' });
for (const a of EMULATOR_TEST_ACCOUNTS) {
  if (a.role === 'owner') continue;
  await db.doc(`stores/${STORE_ID}/members/${uids[a.role]}`).set({ role: a.role, active: true, displayName: a.displayName, updatedAtMs: Date.now(), updatedBy: 'emulator-seed' });
}
console.log(`门店 ${STORE_ID} ${created ? '已创建' : '已存在'}；测试账号：${EMULATOR_TEST_ACCOUNTS.map((a) => a.email).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
