import test from 'node:test';
import assert from 'node:assert/strict';
import { GO_LIVE_KEPT_COLLECTIONS, GO_LIVE_RESET_COLLECTIONS } from './goLive';

test('开业清空：清单里没有任何设置类集合，也没有重复项', () => {
  for (const kept of GO_LIVE_KEPT_COLLECTIONS) assert.ok(!GO_LIVE_RESET_COLLECTIONS.includes(kept), `${kept} 不能被清空`);
  assert.equal(new Set(GO_LIVE_RESET_COLLECTIONS).size, GO_LIVE_RESET_COLLECTIONS.length);
});
