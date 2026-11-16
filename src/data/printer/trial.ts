/**
 * 试打清单（2026-11-16）：打印机到货后在主收银平板上试打，8 项都过了再去设置里打开送餐单打印。
 * 只记在这台平板（localStorage），按打印机记：换了一台打印机（ID 不一样）就从头试。
 */
import { SAMPLE_SLIPS, SampleSlipId } from '../../domain/sampleSlips';

export interface TrialRecord {
  /** 试的是哪台打印机（蓝牙设备 ID）。 */
  printerId: string | null;
  /** 测试条的 5 个问题。 */
  chinese?: 'ok' | 'bad';
  width?: 'ok' | 'two_lines' | 'two_thirds';
  /** 大字的下一行有没有压在大字上（行距）。 */
  spacing?: 'ok' | 'overlap';
  tail?: 'ok' | 'junk';
  received?: 'ok' | 'no';
  /** 打出来过的样单。 */
  samples: SampleSlipId[];
  /** 连打 5 张：一共用了多久、最慢一张；whole 是老板到出餐口数过、5 张都完整。 */
  rush?: { totalMs: number; maxMs: number; whole?: boolean };
  /** 断开再连：从排上到自动补打出来用了多久；manual 是中间要手动点了连接。 */
  drill?: { ms: number; manual: boolean };
}

export type TrialCheckId = 'chinese' | 'width' | 'spacing' | 'tail' | 'received' | 'samples' | 'rush' | 'drill';
export const TRIAL_CHECKS: readonly TrialCheckId[] = ['chinese', 'width', 'spacing', 'tail', 'received', 'samples', 'rush', 'drill'];
/** 测试条那几题。 */
export const STRIP_CHECKS: readonly TrialCheckId[] = ['chinese', 'width', 'spacing', 'tail', 'received'];

export function trialChecks(r: TrialRecord): Record<TrialCheckId, boolean> {
  return {
    chinese: r.chinese === 'ok',
    width: r.width === 'ok',
    spacing: r.spacing === 'ok',
    tail: r.tail === 'ok',
    received: r.received === 'ok',
    samples: SAMPLE_SLIPS.every((s) => r.samples.includes(s.id)),
    rush: r.rush?.whole === true,
    drill: r.drill !== undefined,
  };
}

export const trialPassedCount = (r: TrialRecord) => Object.values(trialChecks(r)).filter(Boolean).length;
export const trialPassed = (r: TrialRecord) => trialPassedCount(r) === TRIAL_CHECKS.length;

export const emptyTrial = (printerId: string | null): TrialRecord => ({ printerId, samples: [] });

/** 打出来一张样单：记下来（重复的不重复记）。 */
export function withSample(r: TrialRecord, id: SampleSlipId): TrialRecord {
  return r.samples.includes(id) ? r : { ...r, samples: [...r.samples, id] };
}

const KEY = 'hao-printer-trial';

/** 读这台打印机的试打记录；记的是别的打印机就从头来。 */
export function loadTrial(printerId: string | null): TrialRecord {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as TrialRecord) : null;
    if (saved && saved.printerId === printerId && Array.isArray(saved.samples)) return saved;
  } catch {
    // 读不到就从头来
  }
  return emptyTrial(printerId);
}

export function saveTrial(r: TrialRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // 存不了只在本次打开有效
  }
}
