/**
 * Cloud Functions 2nd gen 入口。所有正式交易写入经这些受认证的 Callable 命令；
 * 处理函数自己检查门店成员与角色（Admin SDK 绕过 Rules）。
 * App Check：先在测试项目监测，确认合法设备后再把 ENFORCE_APP_CHECK 设为 true。
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { CallableOptions, CallableRequest, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { toHttpsError } from './core/errors';
import { createOrder } from './commands/createOrder';
import { lifecycleCommand } from './commands/lifecycle';
import { ackKitchenTicket, openShift, releaseToken } from './commands/front';
import { assignRegister, getOperationResult, inviteMember, manageMember } from './commands/admin';
import { publishBom, publishMenu } from './commands/catalog';
import { routeManualOrderToKitchen, syncOfflineEvents } from './commands/offline';
import { resolveOfflineReview } from './commands/review';
import { recordGroupPayment, recordPayment, reinstateWrittenOff, reversePayment, writeOffPayment } from './commands/payment';
import { recordCashMovement, recordExpense, recordWastage, voidLedgerEntry } from './commands/ledger';
import { closeBusinessDay, restateBusinessDay } from './commands/close';
import { heartbeatDevice, recordManualHandoff } from './commands/kitchenLink';
import {
  addIngredient, addStartupCost, correctStartupCost, createNextGoal, finishBatch, recordExistingBatch, recordIngredientPurchase, recordPlanExpense,
  recordRecurringPayment, seedStartupCosts, linkExpense, unlinkExpense, setCostCoverage, completeGoal, archiveGoal, setBatchCost, setExpensePlan, setSalesTarget, setStartupPayment, settleExpense, splitStartupRent, startBatch, voidBatch,
} from './commands/costing';
import { analyzeCostDraft, commitCostDraft, completePurchaseUsage, createCostDraft, getCostAnalysis, setAiCostEnabled, updateCostDraft } from './commands/aiCost';
import { ANTHROPIC_API_KEY, DEEPSEEK_API_KEY } from './aiCost/config';
import { cleanupExpiredDrafts } from './aiCost/drafts';
import { deleteAttachments } from './aiCost/receiptStorage';
import { previewStoreReset, resetStoreForOpening } from './commands/goLive';
import { defineSecret } from 'firebase-functions/params';
import { getStorage } from 'firebase-admin/storage';

export const REGION = 'asia-southeast1';
const ENFORCE_APP_CHECK = false;

setGlobalOptions({ region: REGION, maxInstances: 10, memory: '256MiB' });
initializeApp();
const db = getFirestore();

type Handler = (db: ReturnType<typeof getFirestore>, uid: string | undefined, data: unknown) => Promise<unknown>;

function command(handler: Handler, opts: CallableOptions = {}) {
  return onCall({ ...opts, enforceAppCheck: ENFORCE_APP_CHECK }, async (req: CallableRequest<unknown>) => {
    try {
      const out = await handler(db, req.auth?.uid, req.data);
      // runCommand 的 {result, replayed} 展开为结果对象；replayed=true 表示返回的是原操作结果。
      if (out && typeof out === 'object' && 'result' in out && 'replayed' in out) {
        const { result, replayed } = out as { result: Record<string, unknown>; replayed: boolean };
        return { ...result, replayed };
      }
      return out;
    } catch (err) {
      throw toHttpsError(err);
    }
  });
}

export const createOrderCmd = command(createOrder);
export const getOperationResultCmd = command(getOperationResult);
export const openShiftCmd = command(openShift);
export const releaseTokenCmd = command(releaseToken);
export const ackKitchenTicketCmd = command(ackKitchenTicket);
export const startOrderCmd = command((d, u, x) => lifecycleCommand(d, 'startOrder', u, x));
export const serveOrderCmd = command((d, u, x) => lifecycleCommand(d, 'serveOrder', u, x));
export const undoServeCmd = command((d, u, x) => lifecycleCommand(d, 'undoServe', u, x));
export const requestCancelCmd = command((d, u, x) => lifecycleCommand(d, 'requestCancel', u, x));
export const confirmKitchenCancelCmd = command((d, u, x) => lifecycleCommand(d, 'confirmKitchenCancel', u, x));
export const confirmFullRefundCmd = command((d, u, x) => lifecycleCommand(d, 'confirmFullRefund', u, x));
export const recordPaymentCmd = command(recordPayment);
export const recordGroupPaymentCmd = command(recordGroupPayment);
export const reversePaymentCmd = command(reversePayment);
export const writeOffPaymentCmd = command(writeOffPayment);
export const reinstateWrittenOffCmd = command(reinstateWrittenOff);
export const rejectKitchenCancelCmd = command((d, u, x) => lifecycleCommand(d, 'rejectKitchenCancel', u, x));
export const manageMemberCmd = command(manageMember);
export const assignRegisterCmd = command(assignRegister);
export const inviteMemberCmd = command(inviteMember);
export const publishMenuCmd = command(publishMenu);
export const publishBomCmd = command(publishBom);
export const syncOfflineEventsCmd = command(syncOfflineEvents);
export const routeManualOrderToKitchenCmd = command(routeManualOrderToKitchen);
export const heartbeatDeviceCmd = command(heartbeatDevice);
export const recordManualHandoffCmd = command(recordManualHandoff);
export const resolveOfflineReviewCmd = command(resolveOfflineReview);
export const recordExpenseCmd = command(recordExpense);
export const voidLedgerEntryCmd = command(voidLedgerEntry);
export const recordWastageCmd = command(recordWastage);
export const recordCashMovementCmd = command(recordCashMovement);
export const closeBusinessDayCmd = command(closeBusinessDay);
export const restateBusinessDayCmd = command(restateBusinessDay);

// 2026-10-25 收支改版：食材批次、日常开支、开档成本、经营目标。
export const addIngredientCmd = command(addIngredient);
export const recordExistingBatchCmd = command(recordExistingBatch);
export const recordIngredientPurchaseCmd = command(recordIngredientPurchase);
export const startBatchCmd = command(startBatch);
export const finishBatchCmd = command(finishBatch);
export const setBatchCostCmd = command(setBatchCost);
export const voidBatchCmd = command(voidBatch);
export const setExpensePlanCmd = command(setExpensePlan);
export const recordRecurringPaymentCmd = command(recordRecurringPayment);
export const recordPlanExpenseCmd = command(recordPlanExpense);
export const settleExpenseCmd = command(settleExpense);
export const seedStartupCostsCmd = command(seedStartupCosts);
export const addStartupCostCmd = command(addStartupCost);
export const correctStartupCostCmd = command(correctStartupCost);
export const setStartupPaymentCmd = command(setStartupPayment);
export const splitStartupRentCmd = command(splitStartupRent);
export const setSalesTargetCmd = command(setSalesTarget);
export const createNextGoalCmd = command(createNextGoal);
export const linkExpenseCmd = command(linkExpense);
export const unlinkExpenseCmd = command(unlinkExpense);
export const setCostCoverageCmd = command(setCostCoverage);
export const completeGoalCmd = command(completeGoal);
export const archiveGoalCmd = command(archiveGoal);

// AI 记成本：草稿、识别（专用长请求，密钥只在后端）、整单确认入账、补用量、按店开关。
const AI_LONG: CallableOptions = { timeoutSeconds: 120, memory: '512MiB', secrets: [ANTHROPIC_API_KEY, DEEPSEEK_API_KEY] };
export const createCostDraftCmd = command(createCostDraft);
export const updateCostDraftCmd = command(updateCostDraft, { timeoutSeconds: 60, memory: '512MiB' });
export const analyzeCostDraftCmd = command(analyzeCostDraft, AI_LONG);
export const commitCostDraftCmd = command(commitCostDraft);
export const completePurchaseUsageCmd = command(completePurchaseUsage);
export const setAiCostEnabledCmd = command(setAiCostEnabled);
export const getCostAnalysisCmd = command(getCostAnalysis, AI_LONG);

// 开业前一次性清空测试数据：确认码（店主 IC）只以哈希存在 Secret Manager，只挂在清空这一个函数上。
const STORE_RESET_CODE_HASH = defineSecret('STORE_RESET_CODE_HASH');
function resetCodeHash(): string {
  try {
    return STORE_RESET_CODE_HASH.value() ?? '';
  } catch {
    return '';
  }
}
export const previewStoreResetCmd = command(previewStoreReset);
export const resetStoreForOpeningCmd = command((d, uid, data) => resetStoreForOpening(d, uid, data, {
  codeHash: resetCodeHash(),
  deleteStoragePrefix: (prefix) => getStorage().bucket().deleteFiles({ prefix, force: true }),
}), { timeoutSeconds: 540, memory: '512MiB', secrets: [STORE_RESET_CODE_HASH] });

/** 每天清理 30 天未动、未入账的草稿图片（已入账收据是凭证，保留）。 */
export const cleanupCostDraftsDaily = onSchedule({ schedule: 'every day 05:00', timeZone: 'Asia/Kuala_Lumpur' }, async () => {
  const stores = await db.collection('stores').listDocuments();
  for (const s of stores) {
    const r = await cleanupExpiredDrafts(db, s.id, Date.now(), deleteAttachments);
    if (r.expired) console.log(`cost draft cleanup ${s.id}: ${r.expired}`);
  }
});
