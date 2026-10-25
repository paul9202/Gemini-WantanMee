/**
 * AI 记成本的私有资料规则：Storage 收据图片（只本店老板、只可新建、只限可上传草稿、类型与大小）与 Firestore 草稿读取矩阵。
 * 运行：firebase emulators:exec --only firestore,storage（见根目录 npm run test:rules）。
 */
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { deleteObject, getBytes, listAll, ref, uploadBytes } from 'firebase/storage';

const STORE = 'rules-ai-store';
const OTHER = 'rules-ai-other';
const ID = '0b0e7a52-6f53-4c43-9d43-6a5d4f8a1c11';
let env: RulesTestEnvironment;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-hao-wantan',
    firestore: { rules: readFileSync(resolve(import.meta.dirname, '../../firestore.rules'), 'utf8') },
    storage: { rules: readFileSync(resolve(import.meta.dirname, '../../storage.rules'), 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const s = (p: string) => doc(db, `stores/${STORE}/${p}`);
    await setDoc(s('members/owner'), { role: 'owner', active: true });
    await setDoc(s('members/cashier'), { role: 'cashier', active: true });
    await setDoc(s('members/fired'), { role: 'owner', active: false });
    await setDoc(doc(db, `stores/${OTHER}/members/outsider`), { role: 'owner', active: true });
    await setDoc(s('costDrafts/cd-open'), { source: 'receipt', status: 'created' });
    await setDoc(s('costDrafts/cd-review'), { source: 'receipt', status: 'review' });
    await setDoc(s('costDrafts/cd-committed'), { source: 'receipt', status: 'committed' });
    await setDoc(s('costDrafts/cd-text'), { source: 'text', status: 'created' });
    for (const c of ['costReceipts', 'purchaseDetails', 'costAnalysis', 'aiUsage']) await setDoc(s(`${c}/x`), { v: 1 });
    await setDoc(s('costDrafts/cd-open/attempts/a1'), { provider: 'claude' });
    await setDoc(s('config/aiCost'), { enabled: true });
    await uploadBytes(ref(ctx.storage(), `stores/${STORE}/ai-cost-drafts/cd-review/${ID}.jpg`), new Uint8Array([0xff, 0xd8, 0xff, 1]), { contentType: 'image/jpeg' });
  });
});

after(async () => {
  await env?.cleanup();
});

const as = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext());
const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const put = (uid: string | null, path: string, data: Uint8Array = img, contentType = 'image/jpeg') => uploadBytes(ref(as(uid).storage(), path), data, { contentType });
const p = (draft: string, name = `${crypto.randomUUID()}.jpg`, store = STORE) => `stores/${store}/ai-cost-drafts/${draft}/${name}`;

test('收据上传：只有本店有效老板、只能传进仍可上传的收据草稿', async () => {
  await assertSucceeds(put('owner', p('cd-open')));
  await assertSucceeds(put('owner', p('cd-review')));
  for (const who of [null, 'cashier', 'fired', 'outsider']) await assertFails(put(who, p('cd-open')));
  await assertFails(put('owner', p('cd-committed')));
  await assertFails(put('owner', p('cd-text')));
  await assertFails(put('owner', p('cd-missing')));
  await assertFails(put('outsider', p('cd-open', undefined, OTHER)));
  await assertFails(put('owner', `stores/${STORE}/other/${crypto.randomUUID()}.jpg`));
});

test('收据上传：格式、扩展名、大小必须合规；HEIC / PDF / 超 10 MB / 乱名都拒绝', async () => {
  await assertSucceeds(put('owner', p('cd-open', `${crypto.randomUUID()}.png`), img, 'image/png'));
  await assertSucceeds(put('owner', p('cd-open', `${crypto.randomUUID()}.webp`), img, 'image/webp'));
  await assertFails(put('owner', p('cd-open', `${crypto.randomUUID()}.jpg`), img, 'image/png'));
  await assertFails(put('owner', p('cd-open', `${crypto.randomUUID()}.heic`), img, 'image/heic'));
  await assertFails(put('owner', p('cd-open', `${crypto.randomUUID()}.pdf`), img, 'application/pdf'));
  await assertFails(put('owner', p('cd-open', 'receipt.jpg')));
  await assertFails(put('owner', p('cd-open'), new Uint8Array(10 * 1024 * 1024 + 1)));
});

test('已上传的收据不能覆盖、删除或列目录；只有本店老板能读', async () => {
  const path = p('cd-review', `${ID}.jpg`);
  await assertSucceeds(getBytes(ref(as('owner').storage(), path)));
  await assertFails(put('owner', path));
  await assertFails(deleteObject(ref(as('owner').storage(), path)));
  await assertFails(listAll(ref(as('owner').storage(), `stores/${STORE}/ai-cost-drafts/cd-review`)));
  for (const who of [null, 'cashier', 'fired', 'outsider']) await assertFails(getBytes(ref(as(who).storage(), path)));
});

test('AI 资料（草稿、识别尝试、凭证、采购明细、解读缓存、用量、开关）只有本店老板能读，任何人都不能直接写', async () => {
  const paths = ['costDrafts/cd-open', 'costDrafts/cd-open/attempts/a1', 'costReceipts/x', 'purchaseDetails/x', 'costAnalysis/x', 'aiUsage/x', 'config/aiCost'];
  for (const path of paths) {
    await assertSucceeds(getDoc(doc(as('owner').firestore(), `stores/${STORE}/${path}`)));
    for (const who of [null, 'cashier', 'fired', 'outsider']) await assertFails(getDoc(doc(as(who).firestore(), `stores/${STORE}/${path}`)));
    await assertFails(setDoc(doc(as('owner').firestore(), `stores/${STORE}/${path}`), { status: 'committed' }));
  }
});
