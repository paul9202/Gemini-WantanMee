/**
 * Firebase Web 初始化。Web 配置是公开配置，不是授权；授权由 Auth + Rules + Functions 决定。
 * 开发模式默认连接本机 Emulator（demo- 项目，不触达任何真实云资源）。
 */
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

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
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, REGION);

if (USE_EMULATORS) {
  // 与页面同主机，便于用 localhost / 127.0.0.1 两个源分别登录不同岗位。
  const host = location.hostname;
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
}

export const storePath = (sub: string) => `stores/${STORE_ID}/${sub}`;
