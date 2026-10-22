/**
 * 出餐时效。全部用原始毫秒判断，不先把分钟四舍五入再分档。
 * 后厨：正常 <8 分、提醒 8≤t<12、超时 t≥12。
 * 分析：极速 <4、正常 4≤t<8、偏慢 8≤t<12、超时 t≥12；达标 = t < 480000ms。
 */
import type { ServiceMode } from './menu';
import type { TimeQuality } from './kitchen';

export const MINUTE_MS = 60_000;
export const LIGHTNING_MS = 4 * MINUTE_MS;
export const ON_TIME_MS = 8 * MINUTE_MS;
export const OVERDUE_MS = 12 * MINUTE_MS;

export type KitchenUrgency = 'normal' | 'warning' | 'overdue';
export type SpeedBucket = 'lightning' | 'normal' | 'slow' | 'overdue';

export function kitchenUrgency(elapsedMs: number): KitchenUrgency {
  if (elapsedMs >= OVERDUE_MS) return 'overdue';
  if (elapsedMs >= ON_TIME_MS) return 'warning';
  return 'normal';
}

export function speedBucket(durationMs: number): SpeedBucket {
  if (durationMs < LIGHTNING_MS) return 'lightning';
  if (durationMs < ON_TIME_MS) return 'normal';
  if (durationMs < OVERDUE_MS) return 'slow';
  return 'overdue';
}

export function isOnTime(durationMs: number): boolean {
  return durationMs < ON_TIME_MS;
}

/** 计时显示 mm:ss（KDS），超过 1 小时显示 h:mm:ss。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface ServiceSampleSource {
  orderId: string;
  serviceMode: ServiceMode;
  fulfillmentStatus: string;
  acceptedAtEffectiveMs: number | null;
  servedAtMs: number | null;
  timeQuality: TimeQuality;
}

export interface ServiceSample {
  orderId: string;
  serviceMode: ServiceMode;
  durationMs: number;
}

/**
 * 有效样本：实际已出餐、有接单与出餐时间、时间质量合格（设备估计且未复核的离线单排除）。
 * 退款但已出餐的订单仍是服务样本（fulfillmentStatus 仍为 served）。
 */
export function eligibleSamples(orders: ServiceSampleSource[]): { samples: ServiceSample[]; excluded: number } {
  const samples: ServiceSample[] = [];
  let excluded = 0;
  for (const o of orders) {
    if (o.fulfillmentStatus !== 'served') continue;
    if (o.acceptedAtEffectiveMs === null || o.servedAtMs === null || o.timeQuality === 'device_estimated') {
      excluded++;
      continue;
    }
    const d = o.servedAtMs - o.acceptedAtEffectiveMs;
    if (d < 0) {
      excluded++;
      continue;
    }
    samples.push({ orderId: o.orderId, serviceMode: o.serviceMode, durationMs: d });
  }
  return { samples, excluded };
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** P90 nearest-rank：第 ceil(0.9n) 个。 */
export function p90(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

export interface ServiceStats {
  count: number;
  excluded: number;
  avgMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** 0–1；无样本为 null（UI 显示「—」，不显示 100%）。 */
  onTimeRate: number | null;
  distribution: Record<SpeedBucket, number>;
  dineIn: { count: number; avgMs: number | null };
  takeaway: { count: number; avgMs: number | null };
}

export function serviceStats(orders: ServiceSampleSource[]): ServiceStats {
  const { samples, excluded } = eligibleSamples(orders);
  const d = samples.map((s) => s.durationMs);
  const distribution: Record<SpeedBucket, number> = { lightning: 0, normal: 0, slow: 0, overdue: 0 };
  for (const x of d) distribution[speedBucket(x)]++;
  const dine = samples.filter((s) => s.serviceMode === 'dine_in').map((s) => s.durationMs);
  const take = samples.filter((s) => s.serviceMode === 'takeaway').map((s) => s.durationMs);
  return {
    count: d.length,
    excluded,
    avgMs: mean(d),
    medianMs: median(d),
    p90Ms: p90(d),
    minMs: d.length ? Math.min(...d) : null,
    maxMs: d.length ? Math.max(...d) : null,
    onTimeRate: d.length ? d.filter(isOnTime).length / d.length : null,
    distribution,
    dineIn: { count: dine.length, avgMs: mean(dine) },
    takeaway: { count: take.length, avgMs: mean(take) },
  };
}

export const WAIT_ESTIMATE_ALGORITHM = 'wait-v1';

/**
 * 预计等待范围（分钟）。c = 最近 20 笔有效出餐间隔中位数（0.5–5，少于 5 笔用 2）；
 * p = 待做+制作中单数；E = max(3, 2 + c·p)；范围 [max(2,⌊0.8E⌋), ⌈1.3E⌉]。
 * 厨房离线、人工单未确认或时间异常时返回 null（「暂无法估计」）。
 */
export function estimateWaitRange(input: {
  servedAtMsRecent: number[];
  openOrders: number;
  blocked: boolean;
}): { minMinutes: number; maxMinutes: number; algorithm: string } | null {
  if (input.blocked) return null;
  const served = [...input.servedAtMsRecent].sort((a, b) => a - b).slice(-21);
  const intervals: number[] = [];
  for (let i = 1; i < served.length; i++) intervals.push((served[i] - served[i - 1]) / MINUTE_MS);
  const recent = intervals.slice(-20);
  let c = recent.length < 5 ? 2 : (median(recent) as number);
  c = Math.min(5, Math.max(0.5, c));
  const e = Math.max(3, 2 + c * input.openOrders);
  return { minMinutes: Math.max(2, Math.floor(0.8 * e)), maxMinutes: Math.ceil(1.3 * e), algorithm: WAIT_ESTIMATE_ALGORITHM };
}
