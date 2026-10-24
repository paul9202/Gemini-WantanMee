/**
 * Cloud Functions 2nd gen 入口。所有正式交易写入经这些受认证的 Callable 命令；
 * 处理函数自己检查门店成员与角色（Admin SDK 绕过 Rules）。
 * App Check：先在测试项目监测，确认合法设备后再把 ENFORCE_APP_CHECK 设为 true。
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
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

export const REGION = 'asia-southeast1';
const ENFORCE_APP_CHECK = false;

setGlobalOptions({ region: REGION, maxInstances: 10, memory: '256MiB' });
initializeApp();
const db = getFirestore();

type Handler = (db: ReturnType<typeof getFirestore>, uid: string | undefined, data: unknown) => Promise<unknown>;

function command(handler: Handler) {
  return onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (req: CallableRequest<unknown>) => {
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
