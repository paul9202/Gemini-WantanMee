/**
 * 试打清单：8 项各自什么时候算过；样单记一次；换了打印机从头来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_SLIPS } from '../../domain/sampleSlips';
import { emptyTrial, loadTrial, saveTrial, TRIAL_CHECKS, trialChecks, trialPassed, trialPassedCount, withSample } from './trial';
import type { TrialRecord } from './trial';

test('什么都没试：8 项都没过', () => {
  const r = emptyTrial('dev-1');
  assert.equal(TRIAL_CHECKS.length, 8);
  assert.equal(trialPassedCount(r), 0);
  assert.equal(trialPassed(r), false);
});

test('测试条的答案：只有「好的那个答案」才算过', () => {
  const c = trialChecks({ ...emptyTrial('dev-1'), chinese: 'ok', width: 'two_lines', spacing: 'overlap', tail: 'ok', received: 'no' });
  assert.equal(c.chinese, true);
  assert.equal(c.width, false, '断成两行不算过');
  assert.equal(c.spacing, false, '大字压住下一行不算过');
  assert.equal(c.tail, true);
  assert.equal(c.received, false);
});

test('样单要 9 张都打过；同一张记一次', () => {
  let r = emptyTrial('dev-1');
  r = withSample(withSample(r, 'dine_in'), 'dine_in');
  assert.deepEqual(r.samples, ['dine_in']);
  assert.equal(withSample(r, 'dine_in'), r, '已经有了就不变');
  for (const s of SAMPLE_SLIPS) r = withSample(r, s.id);
  assert.equal(trialChecks(r).samples, true);
});

test('连打要老板确认 5 张都完整才算过；断开演练做完就算过', () => {
  const base = emptyTrial('dev-1');
  assert.equal(trialChecks({ ...base, rush: { totalMs: 7000, maxMs: 2000 } }).rush, false, '只传过去了还不算');
  assert.equal(trialChecks({ ...base, rush: { totalMs: 7000, maxMs: 2000, whole: false } }).rush, false);
  assert.equal(trialChecks({ ...base, rush: { totalMs: 7000, maxMs: 2000, whole: true } }).rush, true);
  assert.equal(trialChecks({ ...base, drill: { ms: 9000, manual: true } }).drill, true);
});

test('全部过了', () => {
  let r: TrialRecord = { ...emptyTrial('dev-1'), chinese: 'ok', width: 'ok', spacing: 'ok', tail: 'ok', received: 'ok', rush: { totalMs: 1, maxMs: 1, whole: true }, drill: { ms: 1, manual: false } };
  for (const s of SAMPLE_SLIPS) r = withSample(r, s.id);
  assert.equal(trialPassed(r), true);
});

test('记在本机：同一台打印机读回来；换了一台从头来', () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  const before = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  try {
    saveTrial({ ...emptyTrial('dev-1'), chinese: 'ok', samples: ['dine_in'] });
    assert.equal(loadTrial('dev-1').chinese, 'ok');
    assert.deepEqual(loadTrial('dev-2'), emptyTrial('dev-2'));
  } finally {
    g.localStorage = before;
  }
});
