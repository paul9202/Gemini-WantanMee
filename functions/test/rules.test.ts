/**
 * Firestore Rules 读取矩阵（04 §6）：匿名、他店、停用成员、kitchen、cashier、owner。
 * 运行：firebase emulators:exec --only firestore（见根目录 npm run test:rules）。
 */
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const STORE = 'rules-store';
const OTHER = 'other-store';
let env: RulesTestEnvironment;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-hao-wantan',
    firestore: { rules: readFileSync(resolve(import.meta.dirname, '../../firestore.rules'), 'utf8') },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const s = (p: string) => doc(db, `stores/${STORE}/${p}`);
    await setDoc(s('members/owner'), { role: 'owner', active: true });
    await setDoc(s('members/cashier'), { role: 'cashier', active: true });
    await setDoc(s('members/kitchen'), { role: 'kitchen', active: true });
    await setDoc(s('members/fired'), { role: 'cashier', active: false });
    await setDoc(doc(db, `stores/${OTHER}/members/outsider`), { role: 'owner', active: true });
    await setDoc(s('config/public'), { name: '豪云吞面' });
    await setDoc(s('config/finance'), { initialCapitalSen: 550000 });
    for (const c of ['orders', 'kitchenTickets', 'tokens', 'registers', 'shifts', 'orderCosts', 'payments', 'refunds', 'expenses',
      'wastage', 'cashMovements', 'dailyStats', 'businessDays', 'auditEvents', 'operations', 'bomVersions', 'devices', 'offlineInbox', 'operationsStatus']) {
      await setDoc(s(`${c}/x`), { v: 1 });
    }
  });
});

after(async () => {
  await env?.cleanup();
});

const db = (uid: string | null) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const path = (p: string) => `stores/${STORE}/${p}`;

type Who = 'anon' | 'outsider' | 'fired' | 'kitchen' | 'cashier' | 'owner';
const WHO: Who[] = ['anon', 'outsider', 'fired', 'kitchen', 'cashier', 'owner'];

/** 读取矩阵：每个路径允许哪些身份读取。 */
const MATRIX: Record<string, Who[]> = {
  'config/public': ['kitchen', 'cashier', 'owner'],
  'config/finance': ['owner'],
  'kitchenTickets/x': ['kitchen', 'cashier', 'owner'],
  'operationsStatus/x': ['kitchen', 'cashier', 'owner'],
  'orders/x': ['cashier', 'owner'],
  'tokens/x': ['cashier', 'owner'],
  'registers/x': ['cashier', 'owner'],
  'shifts/x': ['cashier', 'owner'],
  'orderCosts/x': ['owner'],
  'payments/x': ['owner'],
  'refunds/x': ['owner'],
  'expenses/x': ['owner'],
  'wastage/x': ['owner'],
  'cashMovements/x': ['owner'],
  'dailyStats/x': ['owner'],
  'businessDays/x': ['owner'],
  'auditEvents/x': ['owner'],
  'operations/x': ['owner'],
  'bomVersions/x': ['owner'],
  'devices/x': ['owner'],
  'offlineInbox/x': ['owner'],
  'members/cashier': ['cashier', 'owner'],
};

for (const [p, allowed] of Object.entries(MATRIX)) {
  test(`读取 ${p}：仅 ${allowed.join('/')}`, async () => {
    for (const who of WHO) {
      const ref = doc(db(who === 'anon' ? null : who), path(p));
      if (allowed.includes(who)) await assertSucceeds(getDoc(ref));
      else await assertFails(getDoc(ref));
    }
  });
}

test('他店成员不能读本店任何文档', async () => {
  await assertFails(getDoc(doc(db('outsider'), path('config/public'))));
  await assertFails(getDocs(collection(db('outsider'), path('kitchenTickets'))));
});

test('后厨不能列出订单/支付/成本集合（查询也受规则约束）', async () => {
  await assertSucceeds(getDocs(collection(db('kitchen'), path('kitchenTickets'))));
  for (const c of ['orders', 'payments', 'orderCosts', 'refunds']) {
    await assertFails(getDocs(collection(db('kitchen'), path(c))));
  }
});

test('收银只能读自己的成员文档，不能列出全部成员', async () => {
  await assertSucceeds(getDoc(doc(db('cashier'), path('members/cashier'))));
  await assertFails(getDoc(doc(db('cashier'), path('members/owner'))));
  await assertFails(getDocs(collection(db('cashier'), path('members'))));
  await assertSucceeds(getDocs(collection(db('owner'), path('members'))));
});

test('任何人（包括 owner）都不能从客户端直接写交易与配置', async () => {
  for (const who of WHO) {
    const d = db(who === 'anon' ? null : who);
    for (const p of ['orders/new', 'payments/new', 'tokens/x', 'kitchenTickets/x', 'config/public', 'members/cashier', 'orderCosts/x', 'auditEvents/x']) {
      await assertFails(setDoc(doc(d, path(p)), { hacked: true }));
    }
    await assertFails(updateDoc(doc(d, path('tokens/x')), { v: 2 }));
    await assertFails(deleteDoc(doc(d, path('orders/x'))));
  }
  // 自我提权：把自己写成 owner
  await assertFails(setDoc(doc(db('cashier'), path('members/cashier')), { role: 'owner', active: true }));
});

test('门店根与门店外路径默认拒绝', async () => {
  await assertFails(getDoc(doc(db('owner'), `stores/${STORE}`)));
  await assertFails(getDoc(doc(db('owner'), 'anything/else')));
  await assertFails(getDoc(doc(db('owner'), path('unknownCollection/x'))));
});
