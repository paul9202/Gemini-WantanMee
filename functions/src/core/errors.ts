/**
 * 命令错误：稳定 reasonCode 放在 HttpsError.details，UI 按码翻译，不展示堆栈。
 */
import { HttpsError, FunctionsErrorCode } from 'firebase-functions/v2/https';

export type ReasonCode =
  | 'UNAUTHENTICATED' | 'NOT_A_MEMBER' | 'FORBIDDEN' | 'INVALID_ARGUMENT' | 'INVALID_MODIFIER'
  | 'TOKEN_OCCUPIED' | 'TOKEN_NOT_HELD_BY_ORDER' | 'TOKEN_NOT_AWAITING_RETURN' | 'STALE_VERSION'
  | 'MENU_CHANGED' | 'PRICE_MISMATCH' | 'PAYMENT_NOT_CONFIRMED' | 'REGISTER_REVOKED' | 'SEQUENCE_GAP'
  | 'SHIFT_NOT_OPEN' | 'SHIFT_ALREADY_OPEN' | 'DAY_CLOSED' | 'OPERATION_CONFLICT' | 'ORDER_ID_CONFLICT'
  | 'NOT_FOUND' | 'INVALID_TRANSITION' | 'UNDO_WINDOW_EXPIRED' | 'TOKEN_REASSIGNED' | 'REASON_REQUIRED'
  | 'REFUND_MUST_BE_FULL' | 'ALREADY_REFUNDED' | 'OFFLINE_REVIEW_REQUIRED' | 'STORE_NOT_CONFIGURED'
  | 'CLOSE_EXCEPTIONS' | 'NOT_CLOSED' | 'REVIEW_NOT_ALLOWED'
  | 'ALREADY_PAID' | 'ORDER_CANCELLED' | 'CANCEL_PENDING' | 'AMOUNT_MISMATCH' | 'NOT_PAID' | 'WRITTEN_OFF' | 'NOT_UNPAID'
  | 'ADD_ON_NOT_ALLOWED'
  | 'LINK_REJECTED' | 'PERIOD_ALREADY_PAID' | 'COVERED_BY_STARTUP' | 'STAFF_NOT_ENABLED' | 'GOAL_NOT_REACHED' | 'BATCH_STATE' | 'LINKED_TO_BATCH' | 'ALREADY_SETTLED'
  | 'DRAFT_INVALID' | 'DRAFT_STATE' | 'DUPLICATE_RECEIPT' | 'ATTACHMENT_REJECTED' | 'AI_DISABLED' | 'AI_NOT_CONFIGURED' | 'AI_QUOTA_EXCEEDED'
  | 'WRONG_CONFIRM_CODE' | 'RESET_LOCKED_OUT' | 'RESET_IN_PROGRESS' | 'RESET_NOT_CONFIGURED';

const HTTP_CODE: Partial<Record<ReasonCode, FunctionsErrorCode>> = {
  UNAUTHENTICATED: 'unauthenticated',
  NOT_A_MEMBER: 'permission-denied',
  FORBIDDEN: 'permission-denied',
  REGISTER_REVOKED: 'permission-denied',
  INVALID_ARGUMENT: 'invalid-argument',
  INVALID_MODIFIER: 'invalid-argument',
  PRICE_MISMATCH: 'failed-precondition',
  NOT_FOUND: 'not-found',
  OPERATION_CONFLICT: 'already-exists',
  ORDER_ID_CONFLICT: 'already-exists',
  STALE_VERSION: 'aborted',
};

export class CommandError extends Error {
  constructor(public readonly reasonCode: ReasonCode, message?: string, public readonly extra?: Record<string, unknown>) {
    super(message ?? reasonCode);
  }
}

export function toHttpsError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err;
  if (err instanceof CommandError) {
    return new HttpsError(HTTP_CODE[err.reasonCode] ?? 'failed-precondition', err.message, { reasonCode: err.reasonCode, ...err.extra });
  }
  console.error('unexpected command error', err);
  return new HttpsError('internal', 'internal error', { reasonCode: 'INTERNAL' });
}
