/**
 * 本机屏幕测量（DEVICE-BASELINE）：记录 CSS 视口、可视视口、DPR、方向、是否 PWA 独立窗口。
 * 硬件分辨率不等于 CSS 视口；平板到货后在 Chrome 与已安装 PWA、横竖屏、键盘展开时分别测量，
 * 结果作为自动化测试的设备 profile。这里只读取浏览器报告的数值，不推算。
 */
import { useEffect, useState } from 'react';

export interface ViewportProfile {
  measuredAt: string;
  userAgent: string;
  screen: { width: number; height: number; availWidth: number; availHeight: number };
  viewport: { width: number; height: number };
  visualViewport: { width: number; height: number; scale: number; offsetTop: number; offsetLeft: number } | null;
  dpr: number;
  orientation: string | null;
  standalone: boolean;
  pointerCoarse: boolean;
  maxTouchPoints: number;
}

export function measureViewport(): ViewportProfile {
  const vv = window.visualViewport;
  return {
    measuredAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
    viewport: { width: innerWidth, height: innerHeight },
    visualViewport: vv ? { width: Math.round(vv.width), height: Math.round(vv.height), scale: vv.scale, offsetTop: Math.round(vv.offsetTop), offsetLeft: Math.round(vv.offsetLeft) } : null,
    dpr: devicePixelRatio,
    orientation: screen.orientation?.type ?? null,
    standalone: matchMedia('(display-mode: standalone)').matches,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

/** 随窗口、可视视口（软键盘、工具栏）和方向变化实时更新。 */
export function useViewportProfile(): ViewportProfile {
  const [p, setP] = useState(measureViewport);
  useEffect(() => {
    const update = () => setP(measureViewport());
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    screen.orientation?.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      screen.orientation?.removeEventListener('change', update);
    };
  }, []);
  return p;
}
