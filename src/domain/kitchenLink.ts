/**
 * 前台对「后厨是否真的收到」的判断（01 §6）。阈值是产品默认值、可配置，不是 Firebase SLA。
 * - 云端接单后 5 秒仍无 KDS 回执：显示「等待厨房确认」。
 * - 15 秒仍无回执且后厨心跳过期：醒目异常，可选人工交接。
 * 所有时间都用服务器时间（本机时间 + 测得的偏移）比较。
 */

export interface KitchenLinkPolicy {
  ackWaitMs: number;
  ackAlarmMs: number;
  heartbeatIntervalMs: number;
  /** 超过这个时间没有心跳视为后厨屏离线。 */
  heartbeatStaleMs: number;
}

export const DEFAULT_KITCHEN_LINK: KitchenLinkPolicy = {
  ackWaitMs: 5_000,
  ackAlarmMs: 15_000,
  heartbeatIntervalMs: 20_000,
  heartbeatStaleMs: 45_000,
};

export type KitchenHealth = 'online' | 'stale' | 'unknown';

export function kitchenHealth(lastSeenMs: number | null, nowServerMs: number, p: KitchenLinkPolicy = DEFAULT_KITCHEN_LINK): KitchenHealth {
  if (lastSeenMs === null) return 'unknown';
  return nowServerMs - lastSeenMs > p.heartbeatStaleMs ? 'stale' : 'online';
}

export type AckState = 'acked' | 'sending' | 'waiting' | 'alarm';

/**
 * 单张云端订单的后厨确认状态。
 * 只有回执才算「后厨已收到」；没有回执时绝不显示成功，也不假装厨师已开始。
 */
export function ackState(input: {
  acceptedAtMs: number;
  kitchenAckAtMs: number | null;
  nowServerMs: number;
  kitchenLastSeenMs: number | null;
}, p: KitchenLinkPolicy = DEFAULT_KITCHEN_LINK): AckState {
  if (input.kitchenAckAtMs !== null) return 'acked';
  const waited = input.nowServerMs - input.acceptedAtMs;
  if (waited < p.ackWaitMs) return 'sending';
  if (waited >= p.ackAlarmMs && kitchenHealth(input.kitchenLastSeenMs, input.nowServerMs, p) !== 'online') return 'alarm';
  return 'waiting';
}
