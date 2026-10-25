/**
 * AI 记成本 Callable 边界：只做身份与输入的严格解析，业务规则在 aiCost/*。
 * 普通账务命令走 runCommand；识别是专用长请求（事务外调用模型），按 requestId 去重，不经 15 秒的通用 submit/reconcile。
 */
import { Firestore } from 'firebase-admin/firestore';
import { isUuid } from '../../../src/domain/idempotency';
import { COST_CATEGORIES, CostDraftLine, EditedCostDraft, MAX_DRAFT_LINES, MAX_DRAFT_TEXT, MAX_RECEIPT_IMAGES } from '../../../src/domain/aiCost';
import { isQuantity } from '../../../src/domain/costing';
import { runCommand } from '../core/command';
import { bad, bool, int, obj, oneOf, optStr, Raw, str, storeId, uuid } from '../core/input';
import { loadStoreConfig } from '../core/store';
import { analyzeDraft, DraftEdit, newDraftDoc, updateDraft } from '../aiCost/drafts';
import { commitCostDraft as commit, completePurchaseUsage as complete } from '../aiCost/posting';
import { uploadPrefix } from '../aiCost/receiptStorage';
import { getCostAnalysis as analysis } from '../aiCost/analysis';
import { isDateString, rangeLength } from '../../../src/domain/businessDay';

const DRAFT_ID = /^cd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SEN = 100_000_000;

function draftId(o: Raw): string {
  if (typeof o.draftId !== 'string' || !DRAFT_ID.test(o.draftId)) throw bad('draftId 非法');
  return o.draftId;
}

const nullable = <T>(o: Raw, k: string, f: () => T): T | null => (o[k] === null ? null : f());
const nullableStr = (o: Raw, k: string, max: number) => {
  if (!(k in o)) throw bad(`缺少 ${k}`);
  return nullable(o, k, () => str(o, k, max, 0));
};

const LINE_KEYS = ['lineId', 'name', 'category', 'grossSen', 'quantity', 'unit', 'note', 'ingredientId', 'payment', 'includeInBusiness', 'excludeReason', 'periodMonth', 'workDays'];
const DRAFT_KEYS = ['purchaseDate', 'currency', 'payment', 'paymentSource', 'supplier', 'receiptNumber', 'discountSen', 'taxSen', 'printedTotalSen', 'difference', 'lines'];

/** 老板编辑后的草稿：结构必须完整、类型正确；业务合法性由 validateCostDraft 判断（保存草稿时只提示，确认时拒绝）。 */
export function parseEdited(raw: unknown): EditedCostDraft {
  const o = obj(raw, DRAFT_KEYS, 'edited');
  for (const k of DRAFT_KEYS) if (!(k in o)) throw bad(`edited 缺少 ${k}`);
  if (!Array.isArray(o.lines) || o.lines.length > MAX_DRAFT_LINES) throw bad(`lines 最多 ${MAX_DRAFT_LINES} 项`);
  const lines = (o.lines as unknown[]).map((r, i): CostDraftLine => {
    const l = obj(r, LINE_KEYS, `lines[${i}]`);
    for (const k of LINE_KEYS) if (!(k in l)) throw bad(`lines[${i}] 缺少 ${k}`);
    if (l.quantity !== null && !isQuantity(l.quantity)) throw bad(`lines[${i}].quantity 必须是大于 0、最多 3 位小数的数量`);
    return {
      lineId: str(l, 'lineId', 20), name: str(l, 'name', 60, 0), category: oneOf(l, 'category', [...COST_CATEGORIES, 'unknown'] as const),
      grossSen: nullable(l, 'grossSen', () => int(l, 'grossSen', 0, MAX_SEN)), quantity: l.quantity as number | null, unit: nullableStr(l, 'unit', 10),
      note: str(l, 'note', 200, 0), ingredientId: nullableStr(l, 'ingredientId', 80), payment: oneOf(l, 'payment', ['inherit', 'paid', 'unpaid', 'unknown'] as const),
      includeInBusiness: bool(l, 'includeInBusiness'), excludeReason: nullableStr(l, 'excludeReason', 200), periodMonth: nullableStr(l, 'periodMonth', 7),
      workDays: nullable(l, 'workDays', () => int(l, 'workDays', 1, 31)),
    };
  });
  const diff = o.difference === null ? null : (() => {
    const x = obj(o.difference, ['acceptedTotalSen', 'reason'], 'difference');
    return { acceptedTotalSen: int(x, 'acceptedTotalSen', 0, MAX_SEN), reason: str(x, 'reason', 200, 0) };
  })();
  return {
    purchaseDate: str(o, 'purchaseDate', 10, 10), currency: str(o, 'currency', 3, 3), payment: oneOf(o, 'payment', ['paid', 'unpaid', 'unknown'] as const),
    paymentSource: oneOf(o, 'paymentSource', ['drawer', 'bank', 'owner', 'unspecified'] as const), supplier: nullableStr(o, 'supplier', 80), receiptNumber: nullableStr(o, 'receiptNumber', 60),
    discountSen: int(o, 'discountSen', 0, MAX_SEN), taxSen: int(o, 'taxSen', 0, MAX_SEN), printedTotalSen: nullable(o, 'printedTotalSen', () => int(o, 'printedTotalSen', 0, MAX_SEN)),
    difference: diff, lines,
  };
}

export async function createCostDraft(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'source', 'text']);
  const source = oneOf(o, 'source', ['text', 'receipt', 'manual'] as const);
  if (typeof o.text === 'string' && o.text.length > MAX_DRAFT_TEXT) throw bad(`原话超过 ${MAX_DRAFT_TEXT} 字，请分开记录`);
  const text = source === 'text' ? str(o, 'text', MAX_DRAFT_TEXT).trim() : source === 'receipt' ? optStr(o, 'text', 500)?.trim() || null : null;
  if (source === 'text' && !text) throw bad('请先说说买了什么');
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), source, text };
  return runCommand(db, {
    type: 'createCostDraft', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const id = `cd-${input.operationId}`;
      const doc = newDraftDoc({ id, source, text, nowMs, uid: actor.uid, timeZone: config.businessDay.timeZone, cutoverMinutes: config.businessDay.cutoverMinutes });
      tx.create(store.costDraft(id), doc);
      return {
        result: { draftId: id, revision: doc.revision, inputRevision: doc.inputRevision, status: doc.status, businessDate: doc.businessDate, uploadPrefix: source === 'receipt' ? uploadPrefix(input.storeId, id) : null },
        audit: { entityId: id, after: { source } },
      };
    },
  });
}

export async function updateCostDraft(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'draftId', 'expectedRevision', 'edited', 'text', 'attachments', 'replaceSource', 'applyCandidate', 'discard']);
  const kinds = ['edited', 'text', 'attachments', 'applyCandidate', 'discard'].filter((k) => o[k] !== undefined);
  if (kinds.length !== 1) throw bad('一次只能做一种修改');
  let edit: DraftEdit;
  switch (kinds[0]) {
    case 'edited': edit = { kind: 'edited', edited: parseEdited(o.edited) }; break;
    case 'text': {
      if (typeof o.text === 'string' && o.text.length > MAX_DRAFT_TEXT) throw bad(`原话超过 ${MAX_DRAFT_TEXT} 字，请分开记录`);
      edit = { kind: 'text', text: str(o, 'text', MAX_DRAFT_TEXT).trim() };
      if (!edit.text) throw bad('原话不能为空');
      break;
    }
    case 'attachments': {
      if (!Array.isArray(o.attachments) || !o.attachments.length || o.attachments.length > MAX_RECEIPT_IMAGES) throw bad(`每次 1–${MAX_RECEIPT_IMAGES} 张图片`);
      const paths = (o.attachments as unknown[]).map((a, i) => str(obj(a, ['path'], `attachments[${i}]`), 'path', 200));
      edit = { kind: 'attachments', paths, replaceSource: o.replaceSource === undefined ? false : bool(o, 'replaceSource') };
      break;
    }
    case 'applyCandidate': edit = { kind: 'applyCandidate', attemptId: str(obj(o.applyCandidate, ['attemptId'], 'applyCandidate'), 'attemptId', 60) }; break;
    default:
      if (o.discard !== true) throw bad('discard 必须是 true');
      edit = { kind: 'discard' };
  }
  if (edit.kind !== 'attachments' && o.replaceSource !== undefined) throw bad('replaceSource 只用于更换图片');
  return updateDraft(db, uid, storeId(o), draftId(o), int(o, 'expectedRevision', 1, 1_000_000), edit);
}

export async function analyzeCostDraft(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'draftId', 'inputRevision', 'requestId']);
  if (!isUuid(o.requestId)) throw bad('requestId 必须是 UUID');
  return analyzeDraft(db, uid, storeId(o), draftId(o), int(o, 'inputRevision', 1, 1_000_000), o.requestId as string);
}

export async function commitCostDraft(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'draftId', 'expectedRevision', 'duplicateAcknowledgement']);
  const ack = o.duplicateAcknowledgement === undefined || o.duplicateAcknowledgement === null ? null : (() => {
    const x = obj(o.duplicateAcknowledgement, ['candidateId', 'reason'], 'duplicateAcknowledgement');
    return { candidateId: str(x, 'candidateId', 80), reason: str(x, 'reason', 200, 2) };
  })();
  return commit(db, uid, { storeId: storeId(o), operationId: uuid(o, 'operationId'), draftId: draftId(o), expectedRevision: int(o, 'expectedRevision', 1, 1_000_000), duplicateAcknowledgement: ack });
}

export async function completePurchaseUsage(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'purchaseId', 'expectedRevision', 'ingredientId', 'quantity', 'unit', 'startUsingAtMs']);
  if (!isQuantity(o.quantity)) throw bad('quantity 必须是大于 0、最多 3 位小数的数量');
  const unit = str(o, 'unit', 10).trim();
  if (!unit) throw bad('请填写单位');
  return complete(db, uid, {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), purchaseId: str(o, 'purchaseId', 120), expectedRevision: int(o, 'expectedRevision', 1, 1_000_000),
    ingredientId: str(o, 'ingredientId', 80), quantity: o.quantity as number, unit,
    startUsingAtMs: o.startUsingAtMs === undefined || o.startUsingAtMs === null ? null : int(o, 'startUsingAtMs', Date.UTC(2024, 0, 1), 4_102_444_800_000),
  });
}

/** 按店开关 AI 整理与解读（关闭后手动录入、已保存账目都不受影响）。 */
export async function setAiCostEnabled(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'enabled']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), enabled: bool(o, 'enabled') };
  return runCommand(db, {
    type: 'setAiCostEnabled', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const before = (await tx.get(store.configAiCost)).data();
      tx.set(store.configAiCost, { enabled: input.enabled, updatedAtMs: nowMs, updatedBy: actor.uid }, { merge: true });
      return { result: { enabled: input.enabled }, audit: { entityId: 'config/aiCost', before: { enabled: before?.enabled ?? false }, after: { enabled: input.enabled } } };
    },
  });
}

/** 开销分析：统计总是返回；explain=true 才请模型解释（问题最长 300 字，区间最长 366 天）。 */
export async function getCostAnalysis(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'range', 'question', 'explain']);
  const r = obj(o.range, ['start', 'endExclusive'], 'range');
  if (!isDateString(r.start) || !isDateString(r.endExclusive) || r.start >= r.endExclusive) throw bad('统计区间不正确');
  const range = { start: r.start as string, endExclusive: r.endExclusive as string };
  if (rangeLength(range) > 366) throw bad('统计区间最长 366 天');
  return analysis(db, uid, { storeId: storeId(o), range, question: optStr(o, 'question', 300), explain: bool(o, 'explain') });
}
