/** 请人工钱：改工钱从某天起、之前照旧；按天只算开门且来了的日子；按月按日历日摊；换人、两个人、请假；账目工资不重复扣。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLaborOps, EMPTY_LABOR, LaborPlan, laborForDate, laborForRange, laborPlanOf, rateOn, splitWorkers, wageExpenseOverlapSen } from './labor';

const start = (): LaborPlan => {
  const r = applyLaborOps(EMPTY_LABOR, [{ op: 'add', id: 'w1', name: ' 阿明 ', from: '2026-11-05', kind: 'daily', amountSen: 7_000 }]);
  assert.ok(r.ok);
  return r.plan;
};
const open = () => true;

test('按天：开门的日子每天 RM70；没开门、开始前不算', () => {
  const p = start();
  assert.equal(p.workers[0].name, '阿明');
  assert.equal(laborForDate(p, '2026-11-05', true).totalSen, 7_000);
  assert.equal(laborForDate(p, '2026-11-04', true).totalSen, 0);
  assert.equal(laborForDate(p, '2026-11-09', false).totalSen, 0, '休息日不算');
  assert.equal(laborForRange(p, { start: '2026-11-05', endExclusive: '2026-11-15' }, (d) => d !== '2026-11-09'), 9 * 7_000);
});

test('改工钱从某天起，之前的日子还是旧工钱', () => {
  const r = applyLaborOps(start(), [{ op: 'rate', workerId: 'w1', from: '2026-12-01', kind: 'daily', amountSen: 8_000 }]);
  assert.ok(r.ok);
  assert.equal(laborForDate(r.plan, '2026-11-30', true).totalSen, 7_000);
  assert.equal(laborForDate(r.plan, '2026-12-01', true).totalSen, 8_000);
  assert.equal(rateOn(r.plan.workers[0], '2026-11-20')?.amountSen, 7_000);
  const early = applyLaborOps(r.plan, [{ op: 'rate', workerId: 'w1', from: '2026-11-01', kind: 'daily', amountSen: 1 }]);
  assert.equal(early.ok, false, '不能早于开始做的那天');
});

test('换人：旧的人做到 11/30，新的人 12/1 起；同时请两个人', () => {
  const r = applyLaborOps(start(), [
    { op: 'end', workerId: 'w1', lastDay: '2026-11-30' },
    { op: 'add', id: 'w2', name: '阿芳', from: '2026-12-01', kind: 'daily', amountSen: 7_500 },
    { op: 'add', id: 'w3', name: '周末帮手', from: '2026-12-05', kind: 'daily', amountSen: 6_000 },
  ]);
  assert.ok(r.ok);
  assert.equal(laborForDate(r.plan, '2026-11-30', true).totalSen, 7_000);
  assert.equal(laborForDate(r.plan, '2026-12-01', true).totalSen, 7_500);
  assert.equal(laborForDate(r.plan, '2026-12-05', true).totalSen, 13_500);
  const { current, past } = splitWorkers(r.plan, '2026-12-02');
  assert.deepEqual(current.map((w) => w.id), ['w2', 'w3']);
  assert.deepEqual(past.map((w) => w.id), ['w1']);
});

test('请假那天不算；撤销后又算', () => {
  const a = applyLaborOps(start(), [{ op: 'absent', workerId: 'w1', date: '2026-11-12', absent: true }]);
  assert.ok(a.ok);
  const day = laborForDate(a.plan, '2026-11-12', true);
  assert.equal(day.totalSen, 0);
  assert.equal(day.lines[0].absent, true);
  const b = applyLaborOps(a.plan, [{ op: 'absent', workerId: 'w1', date: '2026-11-12', absent: false }]);
  assert.ok(b.ok);
  assert.equal(laborForDate(b.plan, '2026-11-12', true).totalSen, 7_000);
  assert.equal(applyLaborOps(start(), [{ op: 'absent', workerId: 'w1', date: '2026-11-01', absent: true }]).ok, false, '还没开始做不能请假');
});

test('日薪改月薪：按日历日摊，休息日也算，请假不扣，整月加起来等于月薪', () => {
  const r = applyLaborOps(start(), [{ op: 'rate', workerId: 'w1', from: '2026-12-01', kind: 'monthly', amountSen: 180_000 }, { op: 'absent', workerId: 'w1', date: '2026-12-10', absent: true }]);
  assert.ok(r.ok);
  assert.equal(laborForRange(r.plan, { start: '2026-12-01', endExclusive: '2027-01-01' }, () => false), 180_000);
  assert.equal(laborForDate(r.plan, '2026-12-10', true).totalSen, laborForDate(r.plan, '2026-12-11', false).totalSen);
});

test('校验：名字、金额、找不到人', () => {
  assert.equal(applyLaborOps(EMPTY_LABOR, [{ op: 'add', id: 'x', name: '  ', from: '2026-11-05', kind: 'daily', amountSen: 7_000 }]).ok, false);
  assert.equal(applyLaborOps(EMPTY_LABOR, [{ op: 'add', id: 'x', name: 'A', from: '2026-11-05', kind: 'daily', amountSen: 0 }]).ok, false);
  assert.equal(applyLaborOps(EMPTY_LABOR, [{ op: 'add', id: 'x', name: 'A', from: '2026-11-05', kind: 'daily', amountSen: 100_001 }]).ok, false);
  assert.equal(applyLaborOps(start(), [{ op: 'rate', workerId: 'nope', from: '2026-12-01', kind: 'daily', amountSen: 1 }]).ok, false);
  const removed = applyLaborOps(start(), [{ op: 'remove', workerId: 'w1' }]);
  assert.ok(removed.ok);
  assert.equal(removed.plan.workers.length, 0);
});

test('账目里记的工资：这里有人的日子加回，没人的日子照扣', () => {
  const p = start();
  const e = (accrualDate: string, amountSen: number, planItem: string | null = 'wage') => ({ category: 'opex', status: 'active', accrualDate, planItem, amountSen });
  const list = [e('2026-11-03', 5_000), e('2026-11-10', 49_000), e('2026-11-10', 2_000, 'gas')];
  assert.equal(wageExpenseOverlapSen(p, list, { start: '2026-11-01', endExclusive: '2026-11-15' }, (x) => x.amountSen), 49_000);
  assert.equal(wageExpenseOverlapSen(EMPTY_LABOR, list, { start: '2026-11-01', endExclusive: '2026-11-15' }, (x) => x.amountSen), 0);
  assert.equal(laborPlanOf(undefined).workers.length, 0);
  assert.equal(laborPlanOf({ workers: [{ id: 'a', name: 'A', from: '2026-11-05', rates: [] }] }).workers[0].to, null);
  assert.equal(laborForRange(p, { start: '2026-11-05', endExclusive: '2026-11-06' }, open), 7_000);
});
