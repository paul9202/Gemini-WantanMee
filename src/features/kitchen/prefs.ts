/**
 * 后厨屏的本机偏好与设备能力：深浅色、新单提示音、屏幕常亮。只存本机，不影响其他设备。
 * 提示音用 WebAudio 合成，不需要额外音频文件（离线可用）。浏览器要求用户先点一下页面才允许出声，
 * 平板休眠后音频上下文还可能被挂起，所以「已开启但现在响不了」会单独显示，不能假装已经能响；
 * 挂起后员工再点一下页面就恢复。
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

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
const emit = () => listeners.forEach((l) => l());

export function useKdsTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, () => prefs.theme);
  const toggle = useCallback(() => {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    write(THEME_KEY, prefs.theme);
    emit();
  }, []);
  return [theme, toggle];
}

let ctx: AudioContext | null = null;

/** 只能在用户手势里调用：创建或恢复音频上下文。 */
function unlockAudio(): boolean {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      ctx.addEventListener('statechange', emit);
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => undefined);
    emit();
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

/** 响一声：上下文被挂起时先试着恢复。没有用户手势时 resume 可能一直不返回，所以只等一小会儿；恢复不了就不响。 */
async function ring() {
  if (!ctx) return;
  if (ctx.state !== 'running') {
    await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 300))]);
  }
  chime();
}

/** 同牌加单共响 3 次（含新单那一声），间隔 8 秒；之后只留横幅。 */
const ADD_ON_RINGS = 3;
const ADD_ON_RING_GAP_MS = 8_000;

export type SoundState = 'off' | 'on' | 'needs_tap';

/**
 * 新单提示音。首次收到服务器数据时只记录已有单，不响；之后出现新的制作中电子单才响
 * （新单接单即制作中，传入的是全部未出餐、无取消申请的电子单 ID）。
 * 来自缓存的数据不算新单（断网恢复时不把旧单当新单）。
 * repeatIds：还没点「知道了」的同牌加单。新单属于其中才接着重复响；移出名单（知道了 / 已出餐 / 取消申请）或静音后不再响。
 */
export function useNewTicketChime(queuedIds: string[], fromServer: boolean, repeatIds: string[]): { state: SoundState; toggle: () => void; unlock: () => void } {
  const enabled = useSyncExternalStore(subscribe, () => prefs.sound);
  const running = useSyncExternalStore(subscribe, () => ctx?.state === 'running');
  const seen = useRef<Set<string> | null>(null);
  const repeating = useRef(repeatIds);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    repeating.current = repeatIds;
  }, [repeatIds]);

  useEffect(() => {
    if (!fromServer) return;
    if (seen.current === null) {
      seen.current = new Set(queuedIds);
      return;
    }
    const fresh = queuedIds.filter((id) => !seen.current!.has(id));
    for (const id of queuedIds) seen.current.add(id);
    if (!fresh.length || !enabled) return;
    void ring();
    const repeat = (ids: string[], left: number) => {
      if (!ids.length || left <= 0) return;
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        const live = ids.filter((id) => repeating.current.includes(id));
        if (!prefs.sound || !live.length) return;
        void ring();
        repeat(live, left - 1);
      }, ADD_ON_RING_GAP_MS);
      timers.current.add(timer);
    };
    repeat(fresh.filter((id) => repeatIds.includes(id)), ADD_ON_RINGS - 1);
  }, [queuedIds, fromServer, enabled, repeatIds]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  // 已开启时一直监听：点页面任何位置都能解锁；上下文之后被挂起（平板休眠等）也靠下一次点击恢复。
  useEffect(() => {
    if (!enabled) return;
    const onTap = () => {
      if (ctx?.state !== 'running') unlockAudio();
    };
    window.addEventListener('pointerdown', onTap);
    return () => window.removeEventListener('pointerdown', onTap);
  }, [enabled]);

  const unlock = useCallback(() => {
    unlockAudio();
  }, []);

  const toggle = useCallback(() => {
    prefs.sound = !prefs.sound;
    write(SOUND_KEY, prefs.sound ? 'on' : 'off');
    if (prefs.sound && unlockAudio()) void ring(); // 试听一声，确认设备有声音
    emit();
  }, []);

  return { state: !enabled ? 'off' : running ? 'on' : 'needs_tap', toggle, unlock };
}

/** 后厨页打开期间保持屏幕常亮；切到后台时浏览器会自动释放，回到前台再申请。不支持或被拒绝时不影响营业。 */
export function useScreenWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let requesting = false;
    let stopped = false;
    const acquire = async () => {
      if (requesting || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      requesting = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (stopped) s.release().catch(() => undefined);
        else lock = s;
      } catch {
        // 不支持（navigator.wakeLock 不存在）、低电量或系统拒绝：屏幕按系统设置熄灭。
      } finally {
        requesting = false;
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', acquire);
      lock?.release().catch(() => undefined);
    };
  }, []);
}
