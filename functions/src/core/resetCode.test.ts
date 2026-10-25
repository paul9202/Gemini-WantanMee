import test from 'node:test';
import assert from 'node:assert/strict';
import { hashResetCode, normalizeResetCode, verifyResetCode } from './resetCode';

// 只用虚构号码；真实 IC 不进代码与测试。
const FAKE_IC = '000101-01-0001';

test('确认码：哈希可核对，带「-」或空格的写法与纯数字等价，输错不通过', () => {
  const stored = hashResetCode(FAKE_IC);
  assert.ok(!stored.includes('000101'), '哈希里不含原文');
  assert.equal(verifyResetCode('000101010001', stored), true);
  assert.equal(verifyResetCode(' 000101 01 0001 ', stored), true);
  assert.equal(verifyResetCode('000101010002', stored), false);
  assert.equal(verifyResetCode('', stored), false);
  assert.equal(normalizeResetCode('910101-01-0101'), '910101010101');
});

test('确认码：同一号码每次加盐不同；哈希格式不对视为未设置', () => {
  assert.notEqual(hashResetCode(FAKE_IC), hashResetCode(FAKE_IC));
  for (const bad of ['', 'unset', '000101010001', 'scrypt$1$1$1$x$y', 'bcrypt$16384$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', 'scrypt$999999999$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==']) {
    assert.equal(verifyResetCode(FAKE_IC, bad), null, bad);
  }
});
