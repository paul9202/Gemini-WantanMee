/**
 * 送餐单 → ESC/POS 字节（文字模式）。纯函数，浏览器和 Node 测试都能跑。
 * - 中文按 GB18030 发送，用打印机自带的中文字库（数据量小，蓝牙一两秒内传完）；打印机没有中文字库时要改用图片模式（未做，到货后按测试条结果决定）。
 * - 宽度按半角计：ASCII 占 1 格，中文和全角符号占 2 格。80mm 一行 48 格，58mm 一行 32 格。
 * - 先排成「行 = 若干段文字 + 样式」，再分别编码成字节或预览文字；测试和假打印机看预览，真打印机收字节。
 */
import { RunnerSlip, slipAmount, slipTotal } from '../../domain/runnerSlip';

export type PaperWidth = 58 | 80;
export const COLUMNS: Record<PaperWidth, number> = { 58: 32, 80: 48 };

export interface Segment {
  text: string;
  /** 黑底白字。 */
  inv?: boolean;
  bold?: boolean;
  /** 放大倍数 1–8（中文最多 2 倍，超过按 2 倍）。 */
  w?: number;
  h?: number;
}
export interface PrintLine {
  segs: Segment[];
  align?: 'left' | 'center' | 'right';
}

// ---- GB18030 ----

let gbTable: Map<string, number> | null | undefined;

/** 用浏览器自带的 GB18030 解码器反查出双字节编码表（约 2.4 万字，第一次用时建，约 20ms）。 */
function table(): Map<string, number> | null {
  if (gbTable !== undefined) return gbTable;
  try {
    const d = new TextDecoder('gb18030');
    const map = new Map<string, number>();
    const pair = new Uint8Array(2);
    for (let a = 0x81; a <= 0xfe; a++) {
      for (let b = 0x40; b <= 0xfe; b++) {
        if (b === 0x7f) continue;
        pair[0] = a;
        pair[1] = b;
        const s = d.decode(pair);
        if (s.length === 1 && s !== '�' && !map.has(s)) map.set(s, (a << 8) | b);
      }
    }
    gbTable = map;
  } catch {
    gbTable = null;
  }
  return gbTable;
}

/** ASCII 原样；中文转 GB18030 双字节；打印机字库里没有的字打成「?」。 */
export function encodeGb18030(text: string): number[] {
  const out: number[] = [];
  const t = table();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const code = t?.get(ch);
    if (code === undefined) out.push(0x3f);
    else out.push(code >> 8, code & 0xff);
  }
  return out;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! < 0x80 ? 1 : 2;
  return w;
}

const segWidth = (s: Segment) => displayWidth(s.text) * (s.w ?? 1);
const lineWidth = (segs: Segment[]) => segs.reduce((n, s) => n + segWidth(s), 0);

/** 左右两头对齐：中间补空格。放不下时左边一行、右边另起一行靠右。 */
function spread(left: Segment[], right: Segment[], cols: number, style: Omit<Segment, 'text'> = {}): PrintLine[] {
  const gap = cols - lineWidth(left) - lineWidth(right);
  if (gap >= 1) return [{ segs: [...left, { ...style, text: ' '.repeat(gap) }, ...right] }];
  return [...wrapSegs(left, cols), { segs: right, align: 'right' }];
}

/**
 * 按宽度折行；一段太长时在段内按字折开。
 * lead 是段前的连接符（例如「 · 」），只在不是行首时才写，免得折行后一行以「·」开头。
 */
function wrapSegs(segs: (Segment & { lead?: string })[], cols: number, indent = ''): PrintLine[] {
  const lines: PrintLine[] = [];
  const base = displayWidth(indent);
  let cur: Segment[] = [];
  let width = 0;
  const reset = () => {
    cur = indent ? [{ text: indent }] : [];
    width = base;
  };
  const push = () => {
    if (width > base) lines.push({ segs: cur });
    reset();
  };
  reset();
  for (const { lead, ...seg } of segs) {
    const sw = segWidth(seg);
    const lw = lead && width > base ? displayWidth(lead) : 0;
    if (width + lw + sw <= cols) {
      if (lw) cur.push({ text: lead! });
      cur.push(seg);
      width += lw + sw;
      continue;
    }
    if (width > base && sw <= cols - base) {
      push();
      cur.push(seg);
      width += sw;
      continue;
    }
    // 段本身太长：逐字放。
    let piece = '';
    for (const ch of seg.text) {
      const cw = displayWidth(ch) * (seg.w ?? 1);
      if (width + displayWidth(piece) * (seg.w ?? 1) + cw > cols) {
        if (piece) cur.push({ ...seg, text: piece });
        push();
        piece = '';
      }
      piece += ch;
    }
    if (piece) {
      cur.push({ ...seg, text: piece });
      width += displayWidth(piece) * (seg.w ?? 1);
    }
  }
  push();
  return lines;
}

// ---- 排版 ----

export function layoutRunnerSlip(slip: RunnerSlip, width: PaperWidth): PrintLine[] {
  const cols = COLUMNS[width];
  const rule: PrintLine = { segs: [{ text: '-'.repeat(cols) }] };
  const out: PrintLine[] = [];
  if (slip.mark) out.push({ segs: [{ text: ` ${slip.mark} `, inv: true, bold: true }], align: 'right' });
  out.push(...spread([{ text: ` ${slip.header.label}`, inv: slip.header.inverse, bold: true }], [{ text: `${slip.time} `, inv: slip.header.inverse, bold: true }], cols, { inv: slip.header.inverse }));
  out.push({ segs: [{ text: '' }] });
  out.push({ segs: [{ text: String(slip.token), bold: true, w: 8, h: 8 }], align: 'center' });
  if (slip.flag) out.push(...wrapSegs([{ text: slip.flag, bold: true, h: 2 }], cols).map((l) => ({ ...l, align: 'center' as const })));
  out.push(rule);
  for (const l of slip.lines) {
    const qty = String(l.quantity).padEnd(3, ' ');
    const name: Segment[] = [{ text: qty, bold: true, h: 2 }];
    for (const t of l.tags) name.push({ text: t.outline ? `[${t.text}]` : ` ${t.text} `, inv: !t.outline, bold: true, h: 2 }, { text: ' ', h: 2 });
    name.push({ text: l.name, bold: true, h: 2 });
    out.push(...spread(name, [{ text: slipAmount(l.amountSen), bold: true, h: 2 }], cols, { h: 2 }));
    if (l.detail.length) {
      const segs = l.detail.map((d) => ({ lead: ' · ', ...(d.strong ? { text: ` ${d.text} `, inv: true, bold: true } : { text: d.text }) }));
      out.push(...wrapSegs(segs, cols, '   '));
    }
  }
  out.push(rule);
  out.push(...spread([{ text: '合计', bold: true, h: 2 }], [{ text: slipTotal(slip.totalSen), bold: true, w: 2, h: 2 }], cols, { h: 2 }));
  out.push(...spread([{ text: slip.ref }], [{ text: `共 ${slip.count} 份` }], cols));
  return out;
}

export function layoutTestPage(info: { width: PaperWidth; at: string; deviceName: string }): PrintLine[] {
  const cols = COLUMNS[info.width];
  const rule: PrintLine = { segs: [{ text: '-'.repeat(cols) }] };
  return [
    { segs: [{ text: ' 打印测试 TEST ', inv: true, bold: true }], align: 'center' },
    { segs: [{ text: '88', bold: true, w: 8, h: 8 }], align: 'center' },
    { segs: [{ text: '干捞面 面薄 走青 不要番茄酱', bold: true, h: 2 }], align: 'center' },
    rule,
    ...spread([{ text: '打印机' }], [{ text: info.deviceName }], cols),
    ...spread([{ text: '纸宽' }], [{ text: `${info.width}mm` }], cols),
    ...spread([{ text: '时间' }], [{ text: info.at }], cols),
    rule,
    { segs: [{ text: '在出餐口收到这张 = 蓝牙够远', bold: true }], align: 'center' },
    { segs: [{ text: '中文清楚 = 有中文字库' }], align: 'center' },
    { segs: [{ text: '下面应该自动切开' }], align: 'center' },
  ];
}

/** 不带控制码的预览（测试、假打印机用）：放大的字照原样写一次。 */
export function previewLines(lines: PrintLine[]): string[] {
  return lines.map((l) => l.segs.map((s) => s.text).join(''));
}

// ---- 编码 ----

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const ALIGN = { left: 0, center: 1, right: 2 } as const;

export function encodeLines(lines: PrintLine[]): Uint8Array {
  const out: number[] = [ESC, 0x40, FS, 0x26]; // 初始化；进入中文模式
  let align: keyof typeof ALIGN = 'left';
  let size = 0;
  let inv = false;
  let bold = false;
  const setSize = (w: number, h: number) => {
    const n = ((Math.min(8, Math.max(1, w)) - 1) << 4) | (Math.min(8, Math.max(1, h)) - 1);
    if (n === size) return;
    size = n;
    // GS ! 管字母数字；FS ! 管中文（只有 2 倍）。
    out.push(GS, 0x21, n, FS, 0x21, (w >= 2 ? 0x04 : 0) | (h >= 2 ? 0x08 : 0));
  };
  const setInv = (v: boolean) => {
    if (v !== inv) out.push(GS, 0x42, v ? 1 : 0);
    inv = v;
  };
  const setBold = (v: boolean) => {
    if (v !== bold) out.push(ESC, 0x45, v ? 1 : 0);
    bold = v;
  };
  for (const line of lines) {
    const a = line.align ?? 'left';
    if (a !== align) out.push(ESC, 0x61, ALIGN[a]);
    align = a;
    for (const s of line.segs) {
      setSize(s.w ?? 1, s.h ?? 1);
      setInv(Boolean(s.inv));
      setBold(Boolean(s.bold));
      out.push(...encodeGb18030(s.text));
    }
    setInv(false);
    out.push(0x0a);
    setSize(1, 1);
    setBold(false);
  }
  if (align !== 'left') out.push(ESC, 0x61, 0);
  out.push(ESC, 0x64, 4); // 走纸到切刀
  out.push(GS, 0x56, 66, 0); // 切纸
  return Uint8Array.from(out);
}

export const encodeRunnerSlip = (slip: RunnerSlip, width: PaperWidth) => encodeLines(layoutRunnerSlip(slip, width));
