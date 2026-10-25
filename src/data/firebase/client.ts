/**
 * Firebase Web 初始化。Web 配置是公开配置，不是授权；授权由 Auth + Rules + Functions 决定。
 * 开发模式默认连接本机 Emulator（demo- 项目，不触达任何真实云资源）。
 */
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

const env = import.meta.env;

export const PROJECT_ID: string = env.VITE_FIREBASE_PROJECT_ID ?? 'demo-hao-wantan';
export const STORE_ID: string = env.VITE_STORE_ID ?? 'hao-pontian-main';
export const REGION: string = env.VITE_FUNCTIONS_REGION ?? 'asia-southeast1';
export const USE_EMULATORS: boolean = (env.VITE_USE_EMULATORS ?? (env.DEV ? 'true' : 'false')) === 'true';

const app = initializeApp({
  projectId: PROJECT_ID,
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'demo-api-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? `${PROJECT_ID}.firebaseapp.com`,
  appId: env.VITE_FIREBASE_APP_ID ?? 'demo-app-id',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET ?? `${PROJECT_ID}.appspot.com`,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, REGION);
/** 私有收据图片（AI 记成本）；只能经 Storage Rules 由本店老板上传 / 读取，不生成公开链接。 */
export const storage = getStorage(app);

if (USE_EMULATORS) {
  // 与页面同主机，便于用 localhost / 127.0.0.1 两个源分别登录不同岗位。
  const host = location.hostname;
  // 端口可用 VITE_EMULATOR_*_PORT 覆盖（同一台机器跑第二套 Emulator 做验收时使用）。
  const port = (k: string, d: number) => Number(env[`VITE_EMULATOR_${k}_PORT`] ?? d);
  connectAuthEmulator(auth, `http://${host}:${port('AUTH', 9099)}`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, port('FIRESTORE', 8080));
  connectFunctionsEmulator(functions, host, port('FUNCTIONS', 5001));
  connectStorageEmulator(storage, host, port('STORAGE', 9199));
}

export const storePath = (sub: string) => `stores/${STORE_ID}/${sub}`;
