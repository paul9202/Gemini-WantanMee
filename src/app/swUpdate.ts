/**
 * Service Worker 注册：有新版本只提示；本机仍有未同步记录时不允许刷新，避免营业中丢失状态。
 * 平板可能整天不关页面，所以定时并在页面回到前台时检查新版本（只检查，不自动刷新）。
 */
import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

let needRefresh = false;
let offlineReady = false;
let update: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const UPDATE_CHECK_MS = 30 * 60_000;

export function startServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  update = registerSW({
    onNeedRefresh() {
      needRefresh = true;
      emit();
    },
    onOfflineReady() {
      offlineReady = true;
      emit();
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // 断网或正在安装时 update() 会失败，下次再查即可。
      const check = () => {
        if (navigator.onLine) registration.update().catch(() => undefined);
      };
      setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });
}

export function useSwState() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => (needRefresh ? 'update' : offlineReady ? 'ready' : 'none'),
  );
}

export const applyUpdate = () => update?.(true);
