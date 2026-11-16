/**
 * 送餐单 ESC/POS 文字模式：中文按 GB18030；每行不超宽、金额靠右；黑底、放大、切纸的控制码都在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, MENU_V1, normalizeConfig, unitPriceSen } from '../../domain/index';
import type { LineConfig } from '../../domain/index';
import { extraConfig, extraNote } from '../../domain/extras';
import { buildRunnerSlip, RunnerSlipSource } from '../../domain/runnerSlip';
import { buildSampleSlip, SAMPLE_REF, SAMPLE_SLIPS } from '../../domain/sampleSlips';
import { COLUMNS, displayWidth, encodeGb18030, encodeLines, encodeRunnerSlip, layoutRunnerSlip, layoutTestPage, PrintLine, previewLines, TEST_BANNER, TEST_FOOTER } from './escpos';

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

test('牌号放大 8 倍居中；面薄和细面一样普通字（不黑底）；没有付款字样', () => {
  const lines = layoutRunnerSlip(slip(), 80);
  const token = lines.find((l) => l.segs.some((s) => s.text === '12' && s.w === 8));
  assert.ok(token && token.align === 'center');
  const meePoh = lines.flatMap((l) => l.segs).find((s) => s.text.trim() === '面薄');
  assert.ok(meePoh && !meePoh.inv, '面薄不黑底：小字黑底在实机上糊成一块');
  const text = previewLines(lines).join('\n');
  assert.ok(text.includes('   面薄 · 少辣 · 走青 · 加叉烧'), text);
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

for (const paper of [58, 80] as const) {
  test(`${paper}mm 加料单：「给哪一碗」比一行还长也整句印出，从「·」处折行`, () => {
    const bowl = { ...cfg({ productKind: 'dry_noodle', size: 'medium', noodleType: 'mee_poh', spice: 'less', note: '不要番茄酱' }, 'red'), serviceMode: 'takeaway' as const };
    const note = extraNote(menu, bowl);
    const extra = { ...extraConfig('char_siew'), note };
    const lines = layoutRunnerSlip(slip({ extraOnly: true, lines: [{ config: extra, quantity: 1, unitPriceSen: 200 }] }), paper);
    const text = previewLines(lines);
    const detail = text.filter((t) => t.startsWith('   '));
    assert.ok(detail.length >= 2, text.join('\n'));
    assert.equal(detail.map((d) => d.trim()).join(' · '), note, '一个字都不少');
    for (const d of detail) assert.ok(!d.trimStart().startsWith('·'), d);
    for (const l of lines) assert.ok(width(l) <= COLUMNS[paper], `${previewLines([l])[0]} 宽 ${width(l)}`);
  });
}

test('一个词比一行还长：逐字折开，一个字都不少', () => {
  const base = slip();
  const long = '客人说面要煮软一点汤要另外装不要放葱花';
  const lines = layoutRunnerSlip({ ...base, lines: [{ ...base.lines[0], detail: [{ text: long }] }] }, 58);
  const detail = previewLines(lines).filter((t) => t.startsWith('   '));
  assert.equal(detail.length, 2, detail.join('\n'));
  assert.equal(detail.map((d) => d.trim()).join(''), long);
  for (const l of lines) assert.ok(width(l) <= 32);
});

test('补打写在最上面；同牌加单的说明在牌号下面', () => {
  const text = previewLines(layoutRunnerSlip(slip({ sharedToken: true }, 1), 80));
  assert.equal(text[0].trim(), '补打 2');
  const tokenAt = text.findIndex((t) => t === '12');
  assert.equal(text[tokenAt + 1], '同牌加单 · 和前面的 12 号一起送');
});

test('字节：初始化、中文模式、黑底表头、牌号放大、中文编码；自动切刀时走纸切纸', () => {
  const bytes = encodeRunnerSlip(slip({ serviceMode: 'takeaway' }), 80, 'auto');
  assert.deepEqual([...bytes.slice(0, 4)], [0x1b, 0x40, 0x1c, 0x26]);
  assert.ok(has(bytes, [0x1d, 0x42, 1]), '黑底开');
  assert.ok(has(bytes, [0x1d, 0x42, 0]), '黑底关');
  assert.ok(has(bytes, [0x1d, 0x21, 0x77]), '牌号 8 倍');
  assert.ok(has(bytes, [0xba, 0xda, 0xbd, 0xb4, 0xc3, 0xe6]), '黑酱面');
  assert.deepEqual([...bytes.slice(-7)], [0x1b, 0x64, 4, 0x1d, 0x56, 66, 0]);
  assert.ok(bytes.length < 2000, `数据量小，蓝牙很快传完：${bytes.length} 字节`);
});

test('手撕（默认）：不发切纸指令，多走几行纸', () => {
  for (const bytes of [encodeRunnerSlip(slip(), 58), encodeRunnerSlip(slip(), 58, 'tear')]) {
    assert.ok(!has(bytes, [0x1d, 0x56]), '没有切纸指令：没切刀的便宜机器不认会印乱码');
    assert.deepEqual([...bytes.slice(-3)], [0x1b, 0x64, 5]);
  }
});

for (const paper of [80, 58] as const) {
  test(`测试条 ${paper}mm：中文样字、纸宽、切纸、整行虚线和提示都在，每行不超宽`, () => {
    for (const cut of ['tear', 'auto'] as const) {
      const lines = layoutTestPage({ width: paper, cut, at: '14:30', deviceName: 'XP-N160II' });
      const text = previewLines(lines);
      const all = text.join('\n');
      assert.ok(all.includes('打印测试') && all.includes('干捞面 面薄 走青 不要番茄酱') && all.includes(`${paper}mm`) && all.includes('XP-N160II'));
      assert.equal(text.filter((t) => t === '-'.repeat(COLUMNS[paper])).length, 2, '两条正好一行宽的虚线');
      assert.ok(all.includes('虚线断成两行 = 纸宽选错了'));
      assert.ok(all.includes(cut === 'auto' ? '自动切刀' : '手撕'));
      assert.ok(all.includes(cut === 'auto' ? '下面应该自动切开' : '从这里撕下'));
      for (const l of lines) assert.ok(width(l) <= COLUMNS[paper], `${previewLines([l])[0]} 宽 ${width(l)}`);
      const bytes = encodeLines(lines, cut);
      assert.equal(has(bytes, [0x1d, 0x56, 66, 0]), cut === 'auto');
    }
  });
}

// ---- 试打印的样单 ----

for (const paper of [58, 80] as const) {
  test(`${paper}mm 样单：最上面整行黑底「测试 · 不用做」，最后一行再写一次；9 张每行都不超宽`, () => {
    for (const d of SAMPLE_SLIPS) {
      const lines = layoutRunnerSlip(buildSampleSlip(menu, d.id, { nowMs: Date.UTC(2026, 10, 16, 2, 5), timeZone: 'Asia/Kuala_Lumpur' }), paper);
      const text = previewLines(lines);
      assert.equal(text[0].trim(), TEST_BANNER, d.id);
      assert.equal(width(lines[0]), COLUMNS[paper], '黑底占满一整行');
      assert.ok(lines[0].segs[0].inv && lines[0].segs[0].h === 2, '黑底、两倍高');
      assert.equal(text.at(-1), TEST_FOOTER, d.id);
      assert.ok(text.some((t) => t.includes(SAMPLE_REF)), '单号位置写测试单');
      assert.ok(lines.some((l) => l.segs.some((s) => s.text === String(d.token) && s.w === 8)), '牌号照样放大');
      for (const l of lines) assert.ok(width(l) <= COLUMNS[paper], `${d.id}: ${previewLines([l])[0]} 宽 ${width(l)}`);
    }
  });
}

test('补打那张样单：测试横条在最上面，补打标记紧跟着', () => {
  const text = previewLines(layoutRunnerSlip(buildSampleSlip(menu, 'reprint', { nowMs: 0, timeZone: 'Asia/Kuala_Lumpur' }), 58));
  assert.equal(text[0].trim(), TEST_BANNER);
  assert.equal(text[2].trim(), '补打 2');
});

test('真单没有测试字样', () => {
  const all = previewLines(layoutRunnerSlip(slip(), 58)).join('\n');
  assert.ok(!all.includes('测试') && !all.includes('不用做'), all);
});

// ---- 行距（2026-11-16 实机：大字的下一行压在大字下半截上） ----

/** 每个换行前最近一次 ESC 3 设的行距。 */
function feeds(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let cur = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x33) { cur = bytes[i + 2]; i += 2; continue; }
    if (bytes[i] === 0x1b || bytes[i] === 0x1d || bytes[i] === 0x1c) { i += 2; continue; } // 其余三字节指令（ESC a / ESC E / GS B / FS ! / ESC d …）
    if (bytes[i] === 0x0a) out.push(cur);
  }
  return out;
}

test('每行换行前写明行距：两倍高的行走 56 点，普通行 30 点；加大分别是 68 / 36', () => {
  const lines: PrintLine[] = [
    { segs: [{ text: '1  黑酱面 · 中', bold: true, h: 2 }] },
    { segs: [{ text: '   细面 · 辣' }] },
    { segs: [{ text: '合计', h: 2 }, { text: ' RM 7.00', w: 2, h: 2 }] },
    { segs: [{ text: '#261116-001' }] },
  ];
  assert.deepEqual(feeds(encodeLines(lines)), [56, 30, 56, 30]);
  assert.deepEqual(feeds(encodeLines(lines, 'tear', 'wide')), [68, 36, 68, 36]);
});

test('送餐单：品名、合计这些大字行都多走，最后走纸按普通行距', () => {
  const lines = layoutRunnerSlip(slip(), 58);
  const bytes = encodeLines(lines);
  const f = feeds(bytes);
  assert.equal(f.length, lines.length);
  lines.forEach((l, i) => assert.equal(f[i], l.segs.some((s) => (s.h ?? 1) >= 2) ? 56 : 30, previewLines([l])[0]));
  assert.equal(f.at(-1), 30, '最后一行是小字（单号）：走纸前已经是普通行距，不用再发');
  const endsTall = encodeLines([{ segs: [{ text: '合计', h: 2 }] }]);
  assert.deepEqual([...endsTall.slice(-6)], [0x1b, 0x33, 30, 0x1b, 0x64, 5], '最后一行是大字：走纸前改回普通行距，撕纸口长短不变');
  assert.deepEqual([...bytes.slice(-3)], [0x1b, 0x64, 5], '手撕走纸不变');
});

test('改单补打：「改单 · 以这张为准」在最上面，「改了：…」在牌号下面整句印出，每行不超宽', () => {
  for (const paper of [58, 80] as const) {
    const base = slip();
    const s = { ...base, mark: '改单 · 以这张为准', amendNo: 1, amendNote: '改了：黑酱面 · 中 2→1 碗 面薄→细面 不加叉烧；加 干捞云吞 · 10粒', lines: [{ ...base.lines[0], tags: [{ text: '改', outline: true }] }] };
    const lines = layoutRunnerSlip(s, paper);
    const text = previewLines(lines);
    assert.equal(text[0].trim(), '改单 · 以这张为准');
    const tokenAt = text.findIndex((t) => t === '12');
    const note = text.slice(tokenAt + 1, text.findIndex((t, i) => i > tokenAt && t.startsWith('---')));
    assert.ok(note.join('').replace(/\s|·/g, '').includes('改了：黑酱面中2→1碗面薄→细面不加叉烧；加干捞云吞10粒'), note.join('\n'));
    assert.ok(text.some((t) => t.startsWith('1  [改] 黑酱面')), text.join('\n'));
    for (const t of note) assert.ok(!t.trimStart().startsWith('·'), t);
    for (const l of lines) assert.ok(width(l) <= COLUMNS[paper], `${previewLines([l])[0]} 宽 ${width(l)}`);
  }
});
