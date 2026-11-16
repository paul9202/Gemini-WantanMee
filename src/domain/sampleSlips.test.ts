/**
 * 试打印的样单：用当前菜单都能建出来；牌号不和实体牌重叠；都带测试标记、不写票号；每种单的写法和真单一样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MENU_V1, TOKEN_MAX } from './index';
import { buildSampleSlip, SAMPLE_REF, SAMPLE_SLIPS, sampleSource } from './sampleSlips';
import type { SampleSlipId } from './sampleSlips';

const menu = MENU_V1;
const at = Date.UTC(2026, 10, 16, 2, 5); // 吉隆坡 10:05
const build = (id: SampleSlipId) => buildSampleSlip(menu, id, { nowMs: at, timeZone: 'Asia/Kuala_Lumpur' });

test('9 张样单：牌号 81–89，不重复，都比实体牌大', () => {
  assert.equal(SAMPLE_SLIPS.length, 9);
  const tokens = SAMPLE_SLIPS.map((s) => s.token);
  assert.equal(new Set(tokens).size, tokens.length);
  assert.deepEqual(tokens, [81, 82, 83, 84, 85, 86, 87, 88, 89]);
  assert.ok(tokens.every((t) => t > TOKEN_MAX), '店里的牌只有 1–50');
});

test('每张都带测试标记，单号写「测试单 · 不是真单」，金额 = 每行加起来', () => {
  for (const d of SAMPLE_SLIPS) {
    const s = build(d.id);
    assert.equal(s.test, true, d.id);
    assert.equal(s.ref, SAMPLE_REF, d.id);
    assert.equal(s.token, d.token, d.id);
    assert.equal(s.time, '10:05', d.id);
    assert.ok(s.lines.length > 0, d.id);
    assert.equal(s.totalSen, s.lines.reduce((n, l) => n + l.amountSen, 0), d.id);
    assert.ok(!s.ref.startsWith('#') && !s.ref.includes('临时号'), '不写真的票号');
  }
});

test('每种单的写法和真单一样：打包、混合、断网、加料、同牌加单、补打', () => {
  assert.deepEqual(build('dine_in').header, { label: '堂食 DINE IN', inverse: false });
  assert.deepEqual(build('takeaway').header, { label: '打包 TAKEAWAY', inverse: true });
  const mixed = build('mixed');
  assert.equal(mixed.header.label, '堂食 + 打包');
  assert.deepEqual(mixed.lines[1].tags, [{ text: '打包' }]);
  assert.deepEqual(build('offline').header, { label: '断网单 · 后厨屏上没有', inverse: true });
  const extra = build('extra');
  assert.equal(extra.header.label, '加料 EXTRA');
  assert.ok(extra.lines[0].detail[0].text.startsWith('给 '), '加料写给哪一碗');
  assert.equal(build('shared').flag, '同牌加单 · 和前面的 85 号一起送');
  assert.equal(build('reprint').mark, '补打 2');
  assert.equal(build('dine_in').mark, null);
  assert.equal(build('big').count, 6);
});

test('要求很多那张：净面加框、面薄强调、要求够多（排版时会折行）', () => {
  const s = build('many');
  assert.deepEqual(s.lines[0].tags, [{ text: '净面', outline: true }]);
  assert.deepEqual(s.lines[1].detail[0], { text: '面薄', strong: true });
  assert.ok(s.lines[1].detail.length >= 6, s.lines[1].detail.map((d) => d.text).join(' · '));
});

test('样单不写云端单号、不是断网单的就当云端单（只影响表头）', () => {
  const src = sampleSource(menu, 'dine_in', at);
  assert.equal(src.receiptNumber, null);
  assert.equal(src.offlineReceiptNumber, null);
  assert.equal(sampleSource(menu, 'offline', at).source, 'offline');
});
