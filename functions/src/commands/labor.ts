/**
 * 请人工钱（2026-11-15）：老板改 config/labor（加人、改工钱从某天起、做到哪天、请假、改名、删掉填错的）。
 * 一次最多 5 个改动按顺序套用（换人 = 旧的做到某天 + 新的从下一天起，一次完成）。校验与前端共用 domain/labor.applyLaborOp。
 * 只记设定，不动账本；「赚了多少」由前端按设定算。老板权限、幂等、审计（runCommand）。
 */
import { Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { isDateString } from '../../../src/domain/businessDay';
import { applyLaborOps, LaborOp, laborPlanOf, PayKind } from '../../../src/domain/labor';
import { runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, bool, int, obj, oneOf, storeId, str, uuid } from '../core/input';

const KINDS = ['daily', 'monthly'] as const satisfies readonly PayKind[];
const date = (o: Record<string, unknown>, k: string) => {
  if (!isDateString(o[k])) throw bad(`${k} 必须是 YYYY-MM-DD`);
  return o[k] as string;
};

function parseOp(raw: unknown, i: number): LaborOp {
  const f = `ops[${i}]`;
  const op = obj(raw, ['op', 'workerId', 'name', 'from', 'kind', 'amountSen', 'lastDay', 'date', 'absent'], f).op;
  switch (op) {
    case 'add': {
      const o = obj(raw, ['op', 'name', 'from', 'kind', 'amountSen'], f);
      return { op, id: `w-${randomUUID().slice(0, 8)}`, name: str(o, 'name', 40), from: date(o, 'from'), kind: oneOf(o, 'kind', KINDS), amountSen: int(o, 'amountSen', 1, 2_000_000) };
    }
    case 'rate': {
      const o = obj(raw, ['op', 'workerId', 'from', 'kind', 'amountSen'], f);
      return { op, workerId: str(o, 'workerId', 40), from: date(o, 'from'), kind: oneOf(o, 'kind', KINDS), amountSen: int(o, 'amountSen', 1, 2_000_000) };
    }
    case 'end': {
      const o = obj(raw, ['op', 'workerId', 'lastDay'], f);
      return { op, workerId: str(o, 'workerId', 40), lastDay: o.lastDay === null ? null : date(o, 'lastDay') };
    }
    case 'absent': {
      const o = obj(raw, ['op', 'workerId', 'date', 'absent'], f);
      return { op, workerId: str(o, 'workerId', 40), date: date(o, 'date'), absent: bool(o, 'absent') };
    }
    case 'rename': {
      const o = obj(raw, ['op', 'workerId', 'name'], f);
      return { op, workerId: str(o, 'workerId', 40), name: str(o, 'name', 40) };
    }
    case 'remove': {
      const o = obj(raw, ['op', 'workerId'], f);
      return { op, workerId: str(o, 'workerId', 40) };
    }
    default:
      throw bad(`${f}.op 必须是 add/rate/end/absent/rename/remove`);
  }
}

export async function updateLabor(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'ops']);
  if (!Array.isArray(o.ops) || !o.ops.length || o.ops.length > 5) throw bad('ops 为 1–5 项');
  const ops = (o.ops as unknown[]).map(parseOp);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), ops };
  return runCommand(db, {
    type: 'updateLabor', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ref = store.root.collection('config').doc('labor');
      const before = laborPlanOf((await tx.get(ref)).data());
      const r = applyLaborOps(before, input.ops);
      if (!r.ok) throw new CommandError('INVALID_ARGUMENT', r.error);
      tx.set(ref, { workers: r.plan.workers, updatedAtMs: nowMs, updatedBy: actor.uid });
      const added = input.ops.flatMap((op) => (op.op === 'add' ? [op.id] : []));
      return {
        result: { workers: r.plan.workers.length, added },
        audit: { entityId: 'config/labor', before: { workers: before.workers }, after: { ops: input.ops, workers: r.plan.workers } },
      };
    },
  });
}
