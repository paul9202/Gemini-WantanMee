/**
 * Service Worker 注册：有新版本只提示；本机仍有未同步记录时不允许刷新，避免营业中丢失状态。
 */
import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

let needRefresh = false;
let offlineReady = false;
let update: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

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
  });
}

export function useSwState() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => (needRefresh ? 'update' : offlineReady ? 'ready' : 'none'),
  );
}

export const applyUpdate = () => update?.(true);
