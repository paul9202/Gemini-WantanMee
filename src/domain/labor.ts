/**
 * 请人工钱（2026-11-15）：老板自己填，不是 AI 估。存在 config/labor，改动走服务器命令 updateLabor（同一套 applyLaborOp 校验）。
 *
 * - 每个人有「从哪天做起 / 做到哪天」和一串工钱（rates），每段工钱从某一天起生效。
 *   改工钱 = 加一段从那天起的新工钱；之前的日子仍按旧工钱算，过去算出来的「赚了多少」不会变。
 * - 按天：开门营业的日子才算（有订单或有收款），那天记了「没来」就不算。
 * - 按月：像租金一样按日历日摊（休息日也算），请假不扣；要扣就改成按天。
 * - 换人 = 旧的人「做到某天」+ 新的人「从下一天做起」；同时请两个人就加两个人。
 * - 账目里已经记的工资付款（日常开支 · 员工工资）在这里有人的日子不再重复扣，只当现金支出。
 */
import { addDays, DateRange, datesInRange, inRange, isDateString } from './businessDay';
import { allocateMonthlyFixedCost } from './finance';
import type { Sen } from './money';

export type PayKind = 'daily' | 'monthly';
export interface LaborRate { from: string; kind: PayKind; amountSen: Sen }
export interface LaborWorker { id: string; name: string; from: string; to: string | null; rates: LaborRate[]; absences: string[] }
export interface LaborPlan { workers: LaborWorker[] }

export const EMPTY_LABOR: LaborPlan = { workers: [] };
export const PAY_KIND_ZH: Record<PayKind, string> = { daily: '按天', monthly: '按月' };
export const LABOR_LIMITS = { workers: 12, rates: 40, absences: 400, nameLen: 20, dailyMaxSen: 100_000, monthlyMaxSen: 2_000_000 };

/** 某天这个人有没有在做（含首尾两天）。 */
export const employedOn = (w: LaborWorker, date: string) => date >= w.from && (w.to === null || date <= w.to);

/** 某天适用的工钱：from ≤ date 的最后一段。 */
export function rateOn(w: LaborWorker, date: string): LaborRate | null {
  let r: LaborRate | null = null;
  for (const x of w.rates) if (x.from <= date && (!r || x.from >= r.from)) r = x;
  return r;
}

export function payText(r: Pick<LaborRate, 'kind' | 'amountSen'>): string {
  return `${r.kind === 'daily' ? '每天' : '每月'} RM${(r.amountSen / 100).toFixed(r.amountSen % 100 ? 2 : 0)}`;
}

export interface LaborLine { workerId: string; name: string; kind: PayKind; sen: Sen; absent: boolean; closed: boolean }

/** 某一天的工钱。open：那天有没有开门（有订单或收款）。 */
export function laborForDate(plan: LaborPlan, date: string, open: boolean): { totalSen: Sen; lines: LaborLine[] } {
  const lines: LaborLine[] = [];
  for (const w of plan.workers) {
    if (!employedOn(w, date)) continue;
    const r = rateOn(w, date);
    if (!r) continue;
    const absent = w.absences.includes(date);
    let sen = 0;
    if (r.kind === 'monthly') {
      const [y, m, d] = date.split('-').map(Number);
      sen = allocateMonthlyFixedCost(r.amountSen, y, m)[d - 1];
    } else if (open && !absent) sen = r.amountSen;
    lines.push({ workerId: w.id, name: w.name, kind: r.kind, sen, absent, closed: !open });
  }
  return { totalSen: lines.reduce((s, l) => s + l.sen, 0), lines };
}

export function laborForRange(plan: LaborPlan, range: DateRange, isOpen: (date: string) => boolean): Sen {
  if (!plan.workers.length) return 0;
  return datesInRange(range).reduce((s, d) => s + laborForDate(plan, d, isOpen(d)).totalSen, 0);
}

/** 这天有没有人在这里登记工钱（有就不要再扣账目里的工资付款）。 */
export const laborCovers = (plan: LaborPlan, date: string) => plan.workers.some((w) => employedOn(w, date) && rateOn(w, date) !== null);

/**
 * 账目里记的员工工资（营业费用，按归属日），落在「这里有人」的日子里的部分。
 * 利润要加回这笔，免得同一份工钱扣两次。amountOf：该笔计入经营成本的金额（扣掉已归属到其他项目的部分）。
 */
export function wageExpenseOverlapSen<E extends { category: string; status: string; accrualDate: string; planItem?: string | null; settlesExpenseId?: string | null }>(
  plan: LaborPlan, expenses: E[], range: DateRange, amountOf: (e: E) => Sen,
): Sen {
  if (!plan.workers.length) return 0;
  return expenses
    .filter((e) => e.status === 'active' && e.category === 'opex' && e.planItem === 'wage' && !e.settlesExpenseId && inRange(e.accrualDate, range) && laborCovers(plan, e.accrualDate))
    .reduce((s, e) => s + amountOf(e), 0);
}

// ———— 改动（前端预览与服务器命令共用同一套校验） ————

export type LaborOp =
  | { op: 'add'; id: string; name: string; from: string; kind: PayKind; amountSen: Sen }
  | { op: 'rate'; workerId: string; from: string; kind: PayKind; amountSen: Sen }
  | { op: 'end'; workerId: string; lastDay: string | null }
  | { op: 'absent'; workerId: string; date: string; absent: boolean }
  | { op: 'rename'; workerId: string; name: string }
  | { op: 'remove'; workerId: string };

const validAmount = (kind: PayKind, sen: unknown) => Number.isSafeInteger(sen) && (sen as number) > 0 && (sen as number) <= (kind === 'daily' ? LABOR_LIMITS.dailyMaxSen : LABOR_LIMITS.monthlyMaxSen);
const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

export function applyLaborOp(plan: LaborPlan, op: LaborOp): { ok: true; plan: LaborPlan } | { ok: false; error: string } {
  const workers = plan.workers.map((w) => ({ ...w, rates: [...w.rates], absences: [...w.absences] }));
  const fail = (error: string) => ({ ok: false as const, error });
  if (op.op === 'add') {
    const name = cleanName(op.name);
    if (!name || name.length > LABOR_LIMITS.nameLen) return fail(`名字 1–${LABOR_LIMITS.nameLen} 个字`);
    if (!isDateString(op.from)) return fail('开始日期不对');
    if (!validAmount(op.kind, op.amountSen)) return fail(op.kind === 'daily' ? '每天工钱要在 RM0.01–RM1,000 之间' : '每月工钱要在 RM0.01–RM20,000 之间');
    if (workers.length >= LABOR_LIMITS.workers) return fail(`最多记 ${LABOR_LIMITS.workers} 个人`);
    if (workers.some((w) => w.id === op.id)) return fail('这个人已经加过了');
    workers.push({ id: op.id, name, from: op.from, to: null, rates: [{ from: op.from, kind: op.kind, amountSen: op.amountSen }], absences: [] });
    return { ok: true, plan: { workers } };
  }
  const w = workers.find((x) => x.id === op.workerId);
  if (!w) return fail('找不到这个人，请刷新');
  switch (op.op) {
    case 'rate': {
      if (!isDateString(op.from)) return fail('生效日期不对');
      if (op.from < w.from) return fail(`${w.name}是 ${w.from} 才开始做的，工钱不能早于这天`);
      if (w.to !== null && op.from > w.to) return fail(`${w.name}做到 ${w.to}，之后不用再改工钱`);
      if (!validAmount(op.kind, op.amountSen)) return fail(op.kind === 'daily' ? '每天工钱要在 RM0.01–RM1,000 之间' : '每月工钱要在 RM0.01–RM20,000 之间');
      w.rates = w.rates.filter((r) => r.from !== op.from);
      if (w.rates.length >= LABOR_LIMITS.rates) return fail('工钱改动太多次了');
      w.rates.push({ from: op.from, kind: op.kind, amountSen: op.amountSen });
      w.rates.sort((a, b) => a.from.localeCompare(b.from));
      break;
    }
    case 'end': {
      if (op.lastDay !== null) {
        if (!isDateString(op.lastDay)) return fail('最后一天日期不对');
        if (op.lastDay < w.from) return fail(`最后一天不能早于开始那天（${w.from}）`);
      }
      w.to = op.lastDay;
      // 做到某天以后的工钱段与请假不再有用。
      if (w.to !== null) {
        const last = w.to;
        w.rates = w.rates.filter((r) => r.from <= last);
        w.absences = w.absences.filter((d) => d <= last);
      }
      break;
    }
    case 'absent': {
      if (!isDateString(op.date)) return fail('日期不对');
      if (!employedOn(w, op.date)) return fail(`${op.date} ${w.name}不在这里做`);
      const has = w.absences.includes(op.date);
      if (op.absent && !has) {
        if (w.absences.length >= LABOR_LIMITS.absences) return fail('请假记录太多了');
        w.absences.push(op.date);
        w.absences.sort();
      } else if (!op.absent && has) w.absences = w.absences.filter((d) => d !== op.date);
      break;
    }
    case 'rename': {
      const name = cleanName(op.name);
      if (!name || name.length > LABOR_LIMITS.nameLen) return fail(`名字 1–${LABOR_LIMITS.nameLen} 个字`);
      w.name = name;
      break;
    }
    case 'remove':
      return { ok: true, plan: { workers: workers.filter((x) => x.id !== w.id) } };
  }
  return { ok: true, plan: { workers } };
}

export function applyLaborOps(plan: LaborPlan, ops: LaborOp[]): { ok: true; plan: LaborPlan } | { ok: false; error: string } {
  let cur = plan;
  for (const op of ops) {
    const r = applyLaborOp(cur, op);
    if (!r.ok) return r;
    cur = r.plan;
  }
  return { ok: true, plan: cur };
}

/** 读 config/labor（缺字段时当作没请人）。 */
export function laborPlanOf(raw: unknown): LaborPlan {
  const ws = (raw as { workers?: unknown } | undefined)?.workers;
  if (!Array.isArray(ws)) return EMPTY_LABOR;
  return {
    workers: ws.filter((w): w is LaborWorker => Boolean(w && typeof w.id === 'string' && isDateString(w.from) && Array.isArray(w.rates)))
      .map((w) => ({ ...w, to: w.to ?? null, absences: Array.isArray(w.absences) ? w.absences : [] })),
  };
}

/** 现在还在做（含以后才开始）的人与已经不做的人。 */
export function splitWorkers(plan: LaborPlan, today: string): { current: LaborWorker[]; past: LaborWorker[] } {
  return {
    current: plan.workers.filter((w) => w.to === null || w.to >= today).sort((a, b) => a.from.localeCompare(b.from)),
    past: plan.workers.filter((w) => w.to !== null && w.to < today).sort((a, b) => (b.to ?? '').localeCompare(a.to ?? '')),
  };
}

/** 下一段工钱（以后才生效的），给卡片显示「12/1 起改成…」。 */
export function nextRate(w: LaborWorker, today: string): LaborRate | null {
  return w.rates.find((r) => r.from > today) ?? null;
}

export const dayAfter = (date: string) => addDays(date, 1);
