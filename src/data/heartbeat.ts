/**
 * 设备心跳（O11）：页面可见且联网时每 20 秒一次；切到后台或断网就停发，
 * 让前台能看出后厨屏可能已离线。同时测量服务器时间偏移。
 */
import { useEffect } from 'react';
import { DEFAULT_KITCHEN_LINK } from '../domain/kitchenLink';
import { call } from './firebase/commands';
import { recordServerOffset } from './offline/runtime';

export function useHeartbeat(deviceId: string | null, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !deviceId) return;
    let stopped = false;
    const beat = async () => {
      if (stopped || document.visibilityState !== 'visible' || !navigator.onLine) return;
      const t0 = Date.now();
      try {
        const r = await call<{ serverNowMs: number }>('heartbeatDevice', { deviceId, appVersion: import.meta.env.MODE });
        void recordServerOffset(r.serverNowMs - (t0 + Date.now()) / 2);
      } catch {
        // 心跳失败不影响营业；前台会因心跳过期而提示。
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), DEFAULT_KITCHEN_LINK.heartbeatIntervalMs);
    const onVisible = () => document.visibilityState === 'visible' && void beat();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [deviceId, enabled]);
}
