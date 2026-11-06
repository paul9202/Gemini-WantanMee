import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGELOG, ChangelogEntry, entriesFor, unseenEntries } from './changelog';

test('更新记录：ID 不重复，最新在前，中英文都有内容', () => {
  assert.equal(new Set(CHANGELOG.map((e) => e.id)).size, CHANGELOG.length);
  const dates = CHANGELOG.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  for (const e of CHANGELOG) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.roles.length > 0, e.id);
    assert.ok(e.items.length > 0, e.id);
    for (const t of [e.title, ...e.items]) assert.ok(t.zh.trim() && t.en.trim(), e.id);
  }
});

test('更新记录：按岗位过滤，后厨看不到收款的改动，老板都能看到', () => {
  assert.equal(entriesFor('owner').length, CHANGELOG.length);
  assert.ok(!entriesFor('kitchen').some((e) => e.id === '2026-11-06-table-bill'));
  assert.ok(!entriesFor('cashier').some((e) => e.id === '2026-11-06-noodle-type'));
});

test('更新记录：只有比已看到那条新的才算新', () => {
  const e = (id: string): ChangelogEntry => ({ id, date: '2026-01-01', roles: ['owner'], title: { zh: id, en: id }, items: [{ zh: id, en: id }] });
  const list = [e('c'), e('b'), e('a')];
  assert.deepEqual(unseenEntries(list, null).map((x) => x.id), ['c', 'b', 'a'], '没看过：全部算新');
  assert.deepEqual(unseenEntries(list, 'b').map((x) => x.id), ['c']);
  assert.deepEqual(unseenEntries(list, 'c'), [], '都看过了');
  assert.deepEqual(unseenEntries(list, 'gone').map((x) => x.id), ['c', 'b', 'a'], '那条已不在列表里：全部算新');
});
