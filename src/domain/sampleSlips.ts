/**
 * 试打印的样单（2026-11-16）：打印机到货后，不下真单也能把每种送餐单都打一张看排版。
 * - 内容拼自当前菜单（菜名、价钱跟着菜单走），走真单同一个 buildRunnerSlip，所以样单打得对，真单就对。
 * - 牌号 81–89：店里的实体牌只有 TOKEN_MIN–TOKEN_MAX（1–50），送面的人不会和真牌搞混。
 * - 不建订单、不占牌号、不进云端：单号位置写「测试单 · 不是真单」，纸上前后印「测试 · 不用做」（test 标记，排版在 escpos）。
 */
import { extraConfig, extraNote } from './extras';
import { defaultConfig, LineConfig, normalizeConfig, NOTE_NO_TOMATO, unitPriceSen } from './lineItem';
import type { LineKind, MenuVersion, Sauce, ServiceMode } from './menu';
import { buildRunnerSlip, RunnerSlip, RunnerSlipSource } from './runnerSlip';

export type SampleSlipId = 'dine_in' | 'takeaway' | 'mixed' | 'many' | 'shared' | 'extra' | 'offline' | 'reprint' | 'big';

export interface SampleSlipDef {
  id: SampleSlipId;
  token: number;
  title: { zh: string; en: string };
  /** 打出来看什么。 */
  check: { zh: string; en: string };
}

/** 试打印页上的顺序。 */
export const SAMPLE_SLIPS: readonly SampleSlipDef[] = [
  { id: 'dine_in', token: 81, title: { zh: '堂食 · 两碗', en: 'Dine-in · 2 bowls' }, check: { zh: '表头、金额靠右、合计放大', en: 'Header, amounts on the right, big total' } },
  { id: 'takeaway', token: 82, title: { zh: '打包', en: 'Takeaway' }, check: { zh: '整条黑底印得黑不黑', en: 'Is the black header bar solid?' } },
  { id: 'mixed', token: 83, title: { zh: '堂食 + 打包', en: 'Dine-in + takeaway' }, check: { zh: '行前面的黑底「打包」', en: 'Black “打包” tag before a line' } },
  { id: 'many', token: 84, title: { zh: '要求很多', en: 'Many requests' }, check: { zh: '面薄黑底、净面加框、长要求换行不丢字', en: 'Mee pok in black, kosong boxed, long requests wrap without losing words' } },
  { id: 'shared', token: 85, title: { zh: '同牌加单', en: 'Same-token add-on' }, check: { zh: '牌号下面的说明框', en: 'Note box under the token' } },
  { id: 'extra', token: 86, title: { zh: '加料', en: 'Extra' }, check: { zh: '很短的一张，撕纸口够不够', en: 'A very short slip: enough paper to tear?' } },
  { id: 'offline', token: 87, title: { zh: '断网单', en: 'Offline order' }, check: { zh: '整条黑底「后厨屏上没有」', en: 'Black “not on kitchen screen” bar' } },
  { id: 'reprint', token: 88, title: { zh: '补打', en: 'Reprint' }, check: { zh: '右上角「补打 2」', en: '“补打 2” at the top right' } },
  { id: 'big', token: 89, title: { zh: '一桌 6 碗', en: 'Table of 6 bowls' }, check: { zh: '长单一次传完，中间不断、不乱码', en: 'A long slip arrives whole: no breaks, no garbage' } },
];

/** 单号位置写的字。 */
export const SAMPLE_REF = '测试单 · 不是真单';

export const sampleDef = (id: SampleSlipId): SampleSlipDef => SAMPLE_SLIPS.find((s) => s.id === id)!;

type Line = RunnerSlipSource['lines'][number];

function sampleLines(menu: MenuVersion, id: SampleSlipId): Line[] {
  const cfg = (kind: LineKind, sauce: Sauce | null, patch: Partial<LineConfig> = {}) => normalizeConfig(menu, { ...defaultConfig(menu, kind, sauce), ...patch });
  const line = (config: LineConfig, quantity = 1, serviceMode?: ServiceMode): Line => ({ config, quantity, unitPriceSen: unitPriceSen(menu, config), ...(serviceMode ? { serviceMode } : {}) });
  const blackMeePoh = cfg('dry_noodle', 'black', { size: 'medium', noodleType: 'mee_poh', spice: 'less', scallion: 'none', addOns: ['char_siew'] });
  const soupSmall = cfg('soup_noodle', null);
  switch (id) {
    case 'dine_in':
      return [line(blackMeePoh), line(soupSmall)];
    case 'takeaway':
      return [line(cfg('dry_noodle', 'red', { note: NOTE_NO_TOMATO }), 2), line(cfg('dry_wanton', 'black'))];
    case 'mixed':
      return [line(cfg('dry_noodle', 'white', { size: 'large', lard: 'extra' }), 1, 'dine_in'), line(cfg('wanton_soup', null, { size: 'w15' }), 1, 'takeaway')];
    case 'many':
      return [
        line(cfg('dry_noodle', 'black', { isKosong: true })),
        line(cfg('dry_noodle', 'red', { size: 'large', noodleType: 'mee_poh', spice: 'extra', scallion: 'extra', lard: 'extra', addOns: ['char_siew', 'wanton_3'], note: NOTE_NO_TOMATO })),
      ];
    case 'shared':
      return [line(cfg('dry_noodle', 'black', { spice: 'none' }))];
    case 'extra': {
      const extra = { ...extraConfig('char_siew'), note: extraNote(menu, { ...blackMeePoh, addOns: [] }, 'char_siew') };
      return [line(extra)];
    }
    case 'offline':
      return [line(cfg('dry_noodle', 'black', { size: 'medium' })), line(cfg('wanton_soup', null))];
    case 'reprint':
      return [line(cfg('dry_noodle', 'white', { scallion: 'none' }))];
    case 'big':
      return [
        line(cfg('dry_noodle', 'black', { size: 'medium' }), 2),
        line(cfg('dry_noodle', 'red', { noodleType: 'mee_poh', spice: 'less', note: NOTE_NO_TOMATO })),
        line(cfg('dry_noodle', 'white', { size: 'large', lard: 'extra' })),
        line(soupSmall),
        line(cfg('wanton_soup', null, { size: 'w15' })),
      ];
  }
}

export function sampleSource(menu: MenuVersion, id: SampleSlipId, nowMs: number): RunnerSlipSource {
  const lines = sampleLines(menu, id);
  return {
    tokenNumber: sampleDef(id).token,
    serviceMode: id === 'takeaway' ? 'takeaway' : 'dine_in',
    acceptedAtMs: nowMs,
    receiptNumber: null,
    offlineReceiptNumber: null,
    source: id === 'offline' ? 'offline' : 'online',
    lines,
    totalSen: lines.reduce((s, l) => s + l.unitPriceSen * l.quantity, 0),
    ...(id === 'shared' ? { sharedToken: true } : {}),
    ...(id === 'extra' ? { extraOnly: true } : {}),
  };
}

/** 一张样单：真单的写法 + test 标记；「补打」那张当作第二次打。 */
export function buildSampleSlip(menu: MenuVersion, id: SampleSlipId, opts: { nowMs: number; timeZone: string }): RunnerSlip {
  const slip = buildRunnerSlip(menu, sampleSource(menu, id, opts.nowMs), { timeZone: opts.timeZone, printIndex: id === 'reprint' ? 1 : 0 });
  return { ...slip, ref: SAMPLE_REF, test: true };
}
