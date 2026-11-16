/**
 * 点单默认值（2026-11-16 店里要求）：每碗面默认细面；白酱面默认不辣，黑酱、红酱、干捞云吞默认辣。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, defaultSpice, MENU_V1 } from './index';

const menu = MENU_V1;

test('每碗面默认细面', () => {
  for (const sauce of ['black', 'white', 'red'] as const) assert.equal(defaultConfig(menu, 'dry_noodle', sauce).noodleType, 'thin_egg', sauce);
  assert.equal(defaultConfig(menu, 'soup_noodle').noodleType, 'thin_egg');
});

test('白酱面默认不辣；黑酱、红酱默认辣', () => {
  assert.equal(defaultConfig(menu, 'dry_noodle', 'white').spice, 'none');
  assert.equal(defaultConfig(menu, 'dry_noodle', 'black').spice, 'normal');
  assert.equal(defaultConfig(menu, 'dry_noodle', 'red').spice, 'normal');
  assert.equal(defaultConfig(menu, 'dry_wanton', 'black').spice, 'normal');
  assert.equal(defaultSpice('white'), 'none');
  assert.equal(defaultSpice(null), 'normal');
});

test('汤类没有辣度', () => {
  assert.equal(defaultConfig(menu, 'soup_noodle').spice, null);
  assert.equal(defaultConfig(menu, 'wanton_soup').spice, null);
});
