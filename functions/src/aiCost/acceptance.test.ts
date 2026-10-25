import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPTANCE_MAX_MS, activeAcceptance } from './acceptance';
import { runCostAi } from './router';
import type { AiProvider } from './types';

const NOW = 1_800_000_000_000;
const ok = { mode: 'backup_only', uids: ['owner-a'], untilMs: NOW + 30 * 60_000, reason: '验收', setAtMs: NOW, setBy: 'script:test' };

test('备用验收模式：只对名单内账号、未过期、不超过 2 小时生效；其余情况一律按正常主备', () => {
  assert.ok(activeAcceptance(ok, NOW, 'owner-a'));
  assert.equal(activeAcceptance(ok, NOW, 'owner-b'), null, '名单外账号不受影响');
  assert.equal(activeAcceptance(ok, NOW, undefined), null);
  assert.equal(activeAcceptance({ ...ok, untilMs: NOW - 1 }, NOW, 'owner-a'), null, '已过期');
  assert.equal(activeAcceptance({ ...ok, untilMs: NOW + ACCEPTANCE_MAX_MS + 1 }, NOW, 'owner-a'), null, '期限超过上限视为无效');
  assert.equal(activeAcceptance({ ...ok, mode: 'primary_off' }, NOW, 'owner-a'), null);
  assert.equal(activeAcceptance({ ...ok, uids: 'owner-a' }, NOW, 'owner-a'), null);
  assert.equal(activeAcceptance(null, NOW, 'owner-a'), null);
});

test('验收模式下 Claude 不被调用，直接由 DeepSeek 处理，并记录主服务是被有意跳过', async () => {
  const seen: string[] = [];
  const fake = (name: 'claude' | 'deepseek'): AiProvider => ({
    name, modelFor: () => `${name}-model`,
    extract: async () => { seen.push(name); return { value: { lines: [] } as never, usage: { inputTokens: 0, outputTokens: 0 }, model: `${name}-model` }; },
    explain: async () => { throw new Error('unused'); },
  });
  const r = await runCostAi('extract', false, (p, s) => p.extract({} as never, s), { primary: null, backup: fake('deepseek'), primarySkipped: 'acceptance_skip' });
  assert.deepEqual(seen, ['deepseek']);
  assert.equal(r.ok && r.primaryIssue, 'acceptance_skip');
});
