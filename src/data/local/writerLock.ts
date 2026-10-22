/**
 * 跨标签单写端：同一浏览器只允许一个收银标签页写本机日志（Web Locks）。
 * 这只是防误开第二个标签，不是安全边界；不支持 Web Locks 的浏览器视为单标签。
 */
import { useEffect, useState } from 'react';

const LOCK_NAME = 'hao-pos-writer';

export function useWriterLock(enabled: boolean): 'pending' | 'held' | 'busy' {
  const [state, setState] = useState<'pending' | 'held' | 'busy'>('pending');
  useEffect(() => {
    if (!enabled) return;
    if (!('locks' in navigator)) {
      setState('held');
      return;
    }
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    let cancelled = false;
    void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (cancelled) return;
      if (!lock) {
        setState('busy');
        // 等原标签关闭后接手。
        void navigator.locks.request(LOCK_NAME, async () => {
          if (cancelled) return;
          setState('held');
          await hold;
        });
        return;
      }
      setState('held');
      await hold;
    });
    return () => {
      cancelled = true;
      release();
    };
  }, [enabled]);
  return state;
}
