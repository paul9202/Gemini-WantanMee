/**
 * 后厨屏的本机偏好：深浅色、新单提示音。只存本机，不影响其他设备。
 * 提示音用 WebAudio 合成，不需要额外音频文件（离线可用）。浏览器要求用户先点一下页面才允许出声，
 * 所以「已开启但还没获得权限」会单独显示，不能假装已经能响。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

type Theme = 'dark' | 'light';
const THEME_KEY = 'hao-kds-theme';
const SOUND_KEY = 'hao-kds-sound';

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存储不可用时只在本次会话生效
  }
}

const listeners = new Set<() => void>();
const prefs = { theme: (read(THEME_KEY, 'dark') === 'light' ? 'light' : 'dark') as Theme, sound: read(SOUND_KEY, 'on') !== 'off' };
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

export function useKdsTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, () => prefs.theme);
  const toggle = useCallback(() => {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    write(THEME_KEY, prefs.theme);
    listeners.forEach((l) => l());
  }, []);
  return [theme, toggle];
}

let ctx: AudioContext | null = null;

/** 只能在用户手势里调用：创建或恢复音频上下文。 */
function unlockAudio(): boolean {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

/** 两声上扬短音：与按钮音区分，在嘈杂厨房里也容易听到。 */
function chime() {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = t0 + i * 0.22;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.22);
  }
}

export type SoundState = 'off' | 'on' | 'needs_tap';

/**
 * 新单提示音。首次收到服务器数据时只记录已有单，不响；之后出现新的待做单才响。
 * 来自缓存的数据不算新单（断网恢复时不把旧单当新单）。
 */
export function useNewTicketChime(queuedIds: string[], fromServer: boolean): { state: SoundState; toggle: () => void } {
  const enabled = useSyncExternalStore(subscribe, () => prefs.sound);
  const [running, setRunning] = useState(() => ctx?.state === 'running');
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!fromServer) return;
    if (seen.current === null) {
      seen.current = new Set(queuedIds);
      return;
    }
    const fresh = queuedIds.filter((id) => !seen.current!.has(id));
    for (const id of queuedIds) seen.current.add(id);
    if (fresh.length && enabled) chime();
  }, [queuedIds, fromServer, enabled]);

  // 已开启时，员工第一次点页面任何位置就解锁声音。
  useEffect(() => {
    if (!enabled || running) return;
    const onTap = () => {
      if (unlockAudio()) setTimeout(() => setRunning(ctx?.state === 'running'), 50);
    };
    window.addEventListener('pointerdown', onTap);
    return () => window.removeEventListener('pointerdown', onTap);
  }, [enabled, running]);

  const toggle = useCallback(() => {
    prefs.sound = !prefs.sound;
    write(SOUND_KEY, prefs.sound ? 'on' : 'off');
    if (prefs.sound && unlockAudio()) {
      setTimeout(() => {
        setRunning(ctx?.state === 'running');
        chime(); // 试听一声，确认设备有声音
      }, 50);
    }
    listeners.forEach((l) => l());
  }, []);

  return { state: !enabled ? 'off' : running ? 'on' : 'needs_tap', toggle };
}
