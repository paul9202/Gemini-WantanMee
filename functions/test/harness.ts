/**
 * Emulator 集成测试工具：用 Admin SDK 初始化门店与核对数据，用客户端 SDK 以真实身份调用 Callable。
 * 只连接本地 Emulator（demo- 项目），测试账号仅存在于 Auth Emulator。
 */
import { randomUUID } from 'node:crypto';
import { initializeApp as adminInit, getApps as adminApps } from 'firebase-admin/app';
import { getFirestore as adminFirestore, Firestore } from 'firebase-admin/firestore';
import { deleteApp, FirebaseApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { bootstrapStore } from '../src/admin/bootstrap';
import { defaultConfig, LineConfig, MENU_V1, normalizeConfig } from '../../src/domain';

export const PROJECT_ID = 'demo-hao-wantan';
export const REGION = 'asia-southeast1';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('只能在 firebase emulators:exec 中运行（缺少 Emulator 环境变量）');
}

export function admin(): Firestore {
  if (!adminApps().length) adminInit({ projectId: PROJECT_ID });
  return adminFirestore();
}

const apps: FirebaseApp[] = [];

export async function cleanupClients() {
  await Promise.all(apps.splice(0).map((a) => deleteApp(a)));
}

export interface Client {
  uid: string;
  app: FirebaseApp;
  db: ReturnType<typeof getFirestore>;
  call: <T = any>(name: string, data: unknown) => Promise<T>;
  /** 调用并返回错误 reasonCode；成功则返回 'OK'。 */
  code: (name: string, data: unknown) => Promise<string>;
}

function hostPort(env: string): [string, number] {
  const [h, p] = process.env[env]!.split(':');
  return [h === '0.0.0.0' ? '127.0.0.1' : h, Number(p)];
}

export async function newClient(label: string, signIn = true): Promise<Client> {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key', appId: 'demo' }, `${label}-${randomUUID()}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const db = getFirestore(app);
  const [fh, fp] = hostPort('FIRESTORE_EMULATOR_HOST');
  connectFirestoreEmulator(db, fh, fp);
  const functions = getFunctions(app, REGION);
  const fnHost = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
  const [nh, np] = fnHost.replace(/^https?:\/\//, '').split(':');
  connectFunctionsEmulator(functions, nh === '0.0.0.0' ? '127.0.0.1' : nh, Number(np));
  let uid = '';
  if (signIn) {
    const cred = await createUserWithEmailAndPassword(auth, `${label}-${randomUUID().slice(0, 8)}@test.local`, `pw-${randomUUID()}`);
    uid = cred.user.uid;
  }
  const call = async <T>(name: string, data: unknown): Promise<T> => (await httpsCallable(functions, `${name}Cmd`)(data)).data as T;
  const code = async (name: string, data: unknown) => {
    try {
      await call(name, data);
      return 'OK';
    } catch (e: any) {
      return e?.details?.reasonCode ?? e?.code ?? String(e);
    }
  };
  return { uid, app, db, call, code };
}

export interface StoreFixture {
  storeId: string;
  owner: Client;
  cashier: Client;
  kitchen: Client;
  claim: { deviceId: string; registerId: string; registerEpoch: number };
  shiftId: string;
  seq: { value: number };
  nextSeq: () => number;
}

/** 新门店：bootstrap owner → 邀请收银/后厨 → 指定主收银机 → 开班（不录备用金）。每组测试独立门店，避免互相影响。 */
export async function setupStore(qrPayee: string | null = 'HAO PONTIAN WANTAN'): Promise<StoreFixture> {
  const storeId = `t-${randomUUID().slice(0, 12)}`;
  const [owner, cashier, kitchen] = await Promise.all([newClient('owner'), newClient('cashier'), newClient('kitchen')]);
  await bootstrapStore(admin(), { storeId, name: '豪云吞面', ownerUid: owner.uid, ownerDisplayName: '老板', qrPayee });
  for (const [c, role] of [[cashier, 'cashier'], [kitchen, 'kitchen']] as const) {
    await owner.call('manageMember', { storeId, operationId: randomUUID(), memberUid: c.uid, role, active: true, displayName: role, reason: '入职' });
  }
  const deviceId = `pos-${randomUUID().slice(0, 8)}`;
  const reg = await owner.call<{ epoch: number }>('assignRegister', { storeId, operationId: randomUUID(), registerId: 'front-01', deviceId, reason: '开店' });
  const claim = { deviceId, registerId: 'front-01', registerEpoch: reg.epoch };
  const shift = await cashier.call<{ shiftId: string }>('openShift', { storeId, operationId: randomUUID(), ...claim });
  const seq = { value: 0 };
  return { storeId, owner, cashier, kitchen, claim, shiftId: shift.shiftId, seq, nextSeq: () => ++seq.value };
}

export function noodle(patch: Partial<LineConfig> = {}): LineConfig {
  return normalizeConfig(MENU_V1, { ...defaultConfig(MENU_V1, 'dry_noodle', 'black'), ...patch });
}

export interface OrderOptions {
  tokenNumber?: number;
  lines?: { config: unknown; quantity: number; lineId?: string; serviceMode?: unknown }[];
  serviceMode?: 'dine_in' | 'takeaway';
  expectedTotalSen?: number;
  /** 下单后立即登记全额收款（另一条命令，下单本身不收款）。 */
  paid?: boolean;
  sequence?: number;
  operationId?: string;
  clientOrderId?: string;
  menuVersion?: string;
  addOnToOrderId?: string;
}

export function orderPayload(f: StoreFixture, o: OrderOptions = {}) {
  const lines = (o.lines ?? [{ config: noodle(), quantity: 1 }]).map((l) => ({
    lineId: l.lineId ?? randomUUID(), config: l.config, quantity: l.quantity, ...(l.serviceMode === undefined ? {} : { serviceMode: l.serviceMode }),
  }));
  return {
    storeId: f.storeId,
    operationId: o.operationId ?? randomUUID(),
    ...f.claim,
    sequence: o.sequence ?? f.seq.value + 1,
    shiftId: f.shiftId,
    order: {
      clientOrderId: o.clientOrderId ?? randomUUID(),
      tokenNumber: o.tokenNumber ?? 1,
      serviceMode: o.serviceMode ?? 'dine_in',
      menuVersion: o.menuVersion ?? MENU_V1.version,
      lines,
      expectedTotalSen: o.expectedTotalSen ?? 700,
      deviceAcceptedAtMs: Date.now(),
      ...(o.addOnToOrderId ? { addOnToOrderId: o.addOnToOrderId } : {}),
    },
  };
}

/** 成功创建订单并推进本机序号；paid=true 时随后登记全额收款。 */
export async function placeOrder(f: StoreFixture, o: OrderOptions = {}) {
  const payload = orderPayload(f, o);
  const result = await f.cashier.call<{ orderId: string; receiptNumber: string; totalSen: number; businessDate: string; paymentState: string; fulfillmentStatus: string }>('createOrder', payload);
  f.seq.value = payload.sequence;
  if (o.paid) await pay(f, result.orderId, result.totalSen);
  return { payload, result };
}

export function payPayload(f: StoreFixture, orderId: string, amountSen: number, operationId: string = randomUUID()) {
  return { storeId: f.storeId, operationId, ...f.claim, orderId, amountSen };
}

/** 主收银机确认整单已收款（不分渠道）。 */
export async function pay(f: StoreFixture, orderId: string, amountSen: number, operationId?: string) {
  return f.cashier.call<{ paymentId: string; businessDate: string; orderBusinessDate: string }>('recordPayment', payPayload(f, orderId, amountSen, operationId));
}

export async function countDocs(storeId: string, collection: string, field?: string, value?: unknown): Promise<number> {
  let q: FirebaseFirestore.Query = admin().collection(`stores/${storeId}/${collection}`);
  if (field) q = q.where(field, '==', value);
  return (await q.count().get()).data().count;
}

export const uuid = randomUUID;
