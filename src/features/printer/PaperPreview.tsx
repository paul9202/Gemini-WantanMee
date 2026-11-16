/**
 * 纸上预览：把要发给打印机的那几行（PrintLine）按格子画出来——和真打印机同一份排版，不是另画一套。
 * 每个半角字占 1 格、中文占 2 格；放大的字按倍数占格子（w 横向、h 纵向），黑底就是黑底。
 */
import { COLUMNS, displayWidth, PaperWidth, PrintLine, Segment } from '../../data/printer/escpos';

const CELL = 7; // 一格多宽（px）
const ROW = 17; // 一行多高（px）
const clamp = (n: number | undefined) => Math.min(8, Math.max(1, n ?? 1));

export function PaperPreview({ lines, width, label }: { lines: PrintLine[]; width: PaperWidth; label: string }) {
  const cols = COLUMNS[width];
  return (
    <div role="img" aria-label={label} className="relative bg-white px-4 pt-4 pb-6 text-black shadow-[0_1px_1px_rgba(0,0,0,.06),0_14px_28px_-14px_rgba(0,0,0,.3)]" style={{ width: cols * CELL + 32 }}>
      {lines.map((l, i) => {
        const h = Math.max(1, ...l.segs.map((s) => clamp(s.h)));
        const justify = l.align === 'center' ? 'center' : l.align === 'right' ? 'flex-end' : 'flex-start';
        return (
          <div key={i} className="flex items-end overflow-visible whitespace-pre" style={{ height: ROW * h, justifyContent: justify }}>
            {l.segs.map((s, j) => <Seg key={j} seg={s} />)}
          </div>
        );
      })}
      <div aria-hidden className="absolute inset-x-0 -bottom-2 h-2" style={{ background: 'linear-gradient(-45deg,transparent 5px,#fff 0) 0 0/10px 8px repeat-x,linear-gradient(45deg,transparent 5px,#fff 0) 0 0/10px 8px repeat-x' }} />
    </div>
  );
}

function Seg({ seg }: { seg: Segment }) {
  const w = clamp(seg.w);
  const h = clamp(seg.h);
  return (
    <span className="inline-flex" style={{ height: ROW * h, background: seg.inv ? '#000' : undefined, color: seg.inv ? '#fff' : undefined, fontWeight: seg.bold ? 800 : 400 }}>
      {[...seg.text].map((ch, k) => {
        const ascii = ch.codePointAt(0)! < 0x80;
        return (
          <span key={k} className="inline-flex items-center justify-center overflow-visible" style={{ width: displayWidth(ch) * w * CELL, height: ROW * h }}>
            <span style={{
              fontSize: (ascii ? 12.5 : 13.5) * h,
              lineHeight: 1,
              fontFamily: ascii ? 'ui-monospace, Consolas, monospace' : '"SimSun","NSimSun","Songti SC","Noto Sans SC",sans-serif',
              transform: w !== h ? `scaleX(${w / h})` : undefined,
            }}>{ch}</span>
          </span>
        );
      })}
    </span>
  );
}
