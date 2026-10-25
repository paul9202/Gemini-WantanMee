/**
 * 备用服务验收模式（受限、限时）：让指定老板账号的识别 / 解读请求跳过 Claude、直接走 DeepSeek，用来验收备用链路。
 * - 不需要改动真实 ANTHROPIC_API_KEY；只影响 config/aiCost.acceptance.uids 里的账号、只在这一家门店、最长 2 小时后自动失效。
 * - 只能由维护者用 functions/scripts/ai-acceptance.ts（本机 gcloud 凭据）写入；Rules 禁止客户端写 config，Callable 也不会改它。
 */
import { Firestore } from 'firebase-admin/firestore';
import { storeRefs } from '../core/command';

export const ACCEPTANCE_MAX_MS = 2 * 60 * 60_000;

export interface AcceptanceSetting {
  mode: 'backup_only';
  uids: string[];
  untilMs: number;
  reason: string;
  setAtMs: number;
  setBy: string;
}

/** 当前请求是否处于验收模式：模式正确、未过期、期限不超过上限、调用者在名单内；任何一项不符都按正常主备处理。 */
export function activeAcceptance(raw: unknown, nowMs: number, uid: string | undefined): AcceptanceSetting | null {
  if (!raw || typeof raw !== 'object' || !uid) return null;
  const a = raw as Partial<AcceptanceSetting>;
  if (a.mode !== 'backup_only' || typeof a.untilMs !== 'number' || !Array.isArray(a.uids)) return null;
  if (a.untilMs <= nowMs || a.untilMs - nowMs > ACCEPTANCE_MAX_MS) return null;
  return a.uids.includes(uid) ? (a as AcceptanceSetting) : null;
}

/** 维护脚本与测试共用：开启（校验对象必须是本店有效老板）或清除验收模式。 */
export async function setAcceptance(db: Firestore, p: { storeId: string; uids: string[]; minutes: number; reason: string; setBy: string; nowMs: number }) {
  if (!p.uids.length) throw new Error('至少指定一个老板 UID');
  if (!(p.minutes > 0) || p.minutes * 60_000 > ACCEPTANCE_MAX_MS) throw new Error(`时长须为 1–${ACCEPTANCE_MAX_MS / 60_000} 分钟`);
  if (p.reason.trim().length < 2) throw new Error('请写明验收原因');
  const store = storeRefs(db, p.storeId);
  for (const uid of p.uids) {
    const m = (await store.member(uid).get()).data();
    if (!m || m.active !== true || m.role !== 'owner') throw new Error(`${uid} 不是这家门店的有效老板`);
  }
  const acceptance: AcceptanceSetting = { mode: 'backup_only', uids: p.uids, untilMs: p.nowMs + p.minutes * 60_000, reason: p.reason.trim(), setAtMs: p.nowMs, setBy: p.setBy };
  await store.configAiCost.set({ acceptance }, { merge: true });
  return acceptance;
}

export async function clearAcceptance(db: Firestore, storeId: string) {
  await storeRefs(db, storeId).configAiCost.set({ acceptance: null }, { merge: true });
}
