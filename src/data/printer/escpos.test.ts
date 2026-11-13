/**
 * 送餐单 ESC/POS 文字模式：中文按 GB18030；每行不超宽、金额靠右；黑底、放大、切纸的控制码都在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, MENU_V1, normalizeConfig, unitPriceSen } from '../../domain/index';
import type { LineConfig } from '../../domain/index';
import { buildRunnerSlip, RunnerSlipSource } from '../../domain/runnerSlip';
import { COLUMNS, displayWidth, encodeGb18030, encodeLines, encodeRunnerSlip, layoutRunnerSlip, layoutTestPage, PrintLine, previewLines } from './escpos';

const menu = MENU_V1;
const cfg = (patch: Partial<LineConfig> & Pick<LineConfig, 'productKind'>, sauce: LineConfig['sauce'] = null) =>
  normalizeConfig(menu, { ...defaultConfig(menu, patch.productKind, sauce), ...patch });
const line = (config: LineConfig, quantity = 1) => ({ config, quantity, unitPriceSen: unitPriceSen(menu, config) });
const src = (patch: Partial<RunnerSlipSource> = {}): RunnerSlipSource => {
  const lines = patch.lines ?? [
    line(cfg({ productKind: 'dry_noodle', size: 'medium', noodleType: 'mee_poh', spice: 'less', scallion: 'none', addOns: ['char_siew'] }, 'black')),
    line(cfg({ productKind: 'soup_noodle' })),
  ];
  return {
    tokenNumber: 12, serviceMode: 'dine_in', acceptedAtMs: Date.UTC(2026, 10, 12, 6, 32), receiptNumber: '261112-037', offlineReceiptNumber: null,
    source: 'online', totalSen: lines.reduce((s, l) => s + l.unitPriceSen * l.quantity, 0), ...patch, lines,
  };
};
const slip = (patch: Partial<RunnerSlipSource> = {}, printIndex = 0) => buildRunnerSlip(menu, src(patch), { timeZone: 'Asia/Kuala_Lumpur', printIndex });
const width = (l: PrintLine) => l.segs.reduce((n, s) => n + displayWidth(s.text) * (s.w ?? 1), 0);
const has = (bytes: Uint8Array, seq: number[]) => {
  for (let i = 0; i + seq.length <= bytes.length; i++) if (seq.every((b, j) => bytes[i + j] === b)) return true;
  return false;
};

test('GB18030：中文两个字节，ASCII 原样，字库里没有的打成问号', () => {
  assert.deepEqual(encodeGb18030('黑酱面'), [0xba, 0xda, 0xbd, 0xb4, 0xc3, 0xe6]);
  assert.deepEqual(encodeGb18030('RM 7.00'), [...'RM 7.00'].map((c) => c.charCodeAt(0)));
  assert.deepEqual(encodeGb18030('·'), [0xa1, 0xa4]);
  assert.deepEqual(encodeGb18030('🍜'), [0x3f]);
});

test('宽度：ASCII 一格，中文两格', () => {
  assert.equal(displayWidth('RM 18.00'), 8);
  assert.equal(displayWidth('黑酱面 · 中'), 12, '黑酱面 6 + 空格 1 + · 2 + 空格 1 + 中 2');
});

for (const paper of [80, 58] as const) {
  test(`${paper}mm：每行都不超宽；表头、金额、合计、页脚两头对齐`, () => {
    const cols = COLUMNS[paper];
    const lines = layoutRunnerSlip(slip(), paper);
    for (const l of lines) assert.ok(width(l) <= cols, `${previewLines([l])[0]} 宽 ${width(l)} > ${cols}`);
    const text = previewLines(lines);
    const at = (s: string) => lines[text.findIndex((t) => t.includes(s))];
    assert.equal(width(at('堂食 DINE IN')), cols, '表头占满一行');
    assert.ok(at('堂食 DINE IN').segs.at(-1)!.text.includes('14:32'));
    assert.ok(text.some((t) => t.startsWith('1  黑酱面 · 中') && t.endsWith('11.00')), text.join('\n'));
    assert.ok(text.some((t) => t.startsWith('1  云吞汤面 · 小') && t.endsWith('7.00')));
    assert.equal(width(at('合计')), cols);
    assert.ok(at('合计').segs.at(-1)!.text === 'RM 18.00' && at('合计').segs.at(-1)!.w === 2, '合计金额放大');
    assert.equal(width(at('#261112-037')), cols);
    assert.ok(text.some((t) => t.endsWith('共 2 份')));
  });
}

test('牌号放大 8 倍居中；面薄黑底；没有付款字样', () => {
  const lines = layoutRunnerSlip(slip(), 80);
  const token = lines.find((l) => l.segs.some((s) => s.text === '12' && s.w === 8));
  assert.ok(token && token.align === 'center');
  const meePoh = lines.flatMap((l) => l.segs).find((s) => s.text.trim() === '面薄');
  assert.ok(meePoh?.inv, '面薄黑底');
  const text = previewLines(lines).join('\n');
  assert.ok(text.includes('   面薄  · 少辣 · 走青 · 加叉烧') || text.includes(' 面薄 '), text);
  assert.ok(!/要收|已付|不用收/.test(text));
});

test('要求太多时折行，下一行不以「·」开头', () => {
  const many = cfg({ productKind: 'dry_noodle', size: 'large', noodleType: 'mee_poh', spice: 'extra', scallion: 'extra', lard: 'extra', addOns: ['char_siew', 'wanton_3'], note: '不要番茄酱' }, 'red');
  const lines = layoutRunnerSlip(slip({ serviceMode: 'takeaway', lines: [line(many)] }), 58);
  const text = previewLines(lines);
  const detail = text.filter((t) => t.startsWith('   '));
  assert.ok(detail.length >= 2, text.join('\n'));
  for (const d of detail) assert.ok(!d.trimStart().startsWith('·'), d);
  for (const l of lines) assert.ok(width(l) <= 32);
});

test('补打写在最上面；同牌加单的说明在牌号下面', () => {
  const text = previewLines(layoutRunnerSlip(slip({ sharedToken: true }, 1), 80));
  assert.equal(text[0].trim(), '补打 2');
  const tokenAt = text.findIndex((t) => t === '12');
  assert.equal(text[tokenAt + 1], '同牌加单 · 和前面的 12 号一起送');
});

test('字节：初始化、中文模式、黑底表头、牌号放大、中文编码、走纸切纸', () => {
  const bytes = encodeRunnerSlip(slip({ serviceMode: 'takeaway' }), 80);
  assert.deepEqual([...bytes.slice(0, 4)], [0x1b, 0x40, 0x1c, 0x26]);
  assert.ok(has(bytes, [0x1d, 0x42, 1]), '黑底开');
  assert.ok(has(bytes, [0x1d, 0x42, 0]), '黑底关');
  assert.ok(has(bytes, [0x1d, 0x21, 0x77]), '牌号 8 倍');
  assert.ok(has(bytes, [0xba, 0xda, 0xbd, 0xb4, 0xc3, 0xe6]), '黑酱面');
  assert.deepEqual([...bytes.slice(-7)], [0x1b, 0x64, 4, 0x1d, 0x56, 66, 0]);
  assert.ok(bytes.length < 2000, `数据量小，蓝牙很快传完：${bytes.length} 字节`);
});

test('测试条：中文样字、纸宽、提示都在，也会切纸', () => {
  const lines = layoutTestPage({ width: 80, at: '14:30', deviceName: 'XP-N160II' });
  const text = previewLines(lines).join('\n');
  assert.ok(text.includes('打印测试') && text.includes('干捞面 面薄 走青 不要番茄酱') && text.includes('80mm') && text.includes('XP-N160II'));
  for (const l of lines) assert.ok(width(l) <= 48);
  const bytes = encodeLines(lines);
  assert.deepEqual([...bytes.slice(-4)], [0x1d, 0x56, 66, 0]);
});
