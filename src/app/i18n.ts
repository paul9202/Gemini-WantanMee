/**
 * 员工界面语言：中文为主，英文为本机可选设置（02 §3）。
 * 不在按钮上并排双语；图卡位置与含义在两种语言下完全一致。老板财务页保留完整中文。
 */
import { useSyncExternalStore } from 'react';

export type Lang = 'zh' | 'en';
const KEY = 'hao-lang';

function read(): Lang {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

let current: Lang = read();
const listeners = new Set<() => void>();

export function setLang(lang: Lang) {
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // 存储不可用时只在本次会话生效
  }
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hans';
  listeners.forEach((l) => l());
}

export function useLang(): Lang {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current);
}

export const currentLang = (): Lang => current;

/** tr('中文', 'English')：按本机语言选择。 */
export function useT() {
  const lang = useLang();
  return (zh: string, en: string) => (lang === 'en' ? en : zh);
}
