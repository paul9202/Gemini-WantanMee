/**
 * 经营改版第二阶段的账务命令（老板权限、幂等、审计，走 runCommand）：
 * - acceptUnitCosts：老板按「对」/ 改一个数 / 用收据价。发布新的 BOM 版本（只影响之后的新订单），并记下每个单价的来源。
 * - setCostConversions：确认或修改换算（1 kg 肉碎几粒云吞等），只影响剩余与收据价的估算，不动账。
 * - recordStockCount：收档时点数（可不填），剩余从这个数重新算。
 * - estimateUnitCosts / getDailySummary：AI 用途，见 aiCost/ownerAi。
 */
import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import { applyBomChanges } from '../../../src/domain/catalog';
import { bomChangesFor, bomValueOf, ConversionKey, CONVERSION_ZH, isValidConversion, isValidUnitCost, MATERIAL_KEYS, normalizeUnitCost, PriceKind } from '../../../src/domain/costSources';
import { BUILT_IN_BY_ID } from '../../../src/domain/costing';
import type { MaterialKey } from '../../../src/domain/usage';
import { loadBom } from '../core/catalog';
import { runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, bool, obj, oneOf, optStr, storeId, str, uuid } from '../core/input';
import { loadStoreConfig } from '../core/store';
import { estimateUnitCosts as estimate, getDailySummary as summary } from '../aiCost/ownerAi';
import { isDateString } from '../../../src/domain/businessDay';

function versionId(date: string, seq: number) {
  return `bom-${date.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`;
}

export async function acceptUnitCosts(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'baseVersion', 'items']);
  if (!Array.isArray(o.items) || !o.items.length || o.items.length > MATERIAL_KEYS.length) throw bad(`items 为 1–${MATERIAL_KEYS.length} 项`);
  const seen = new Set<string>();
  const items = (o.items as unknown[]).map((r, i) => {
    const x = obj(r, ['key', 'unitCostUnits', 'kind', 'basis', 'ref'], `items[${i}]`);
    const key = oneOf(x, 'key', MATERIAL_KEYS);
    if (seen.has(key)) throw bad(`${key} 重复`);
    seen.add(key);
    if (!isValidUnitCost(x.unitCostUnits)) throw bad(`items[${i}].unitCostUnits 必须是 1–20000 的整数（0.1 sen）`);
    return { key: key as MaterialKey, unitCostUnits: normalizeUnitCost(key as MaterialKey, x.unitCostUnits as number), kind: oneOf(x, 'kind', ['ai', 'receipt', 'owner'] as const) as PriceKind, basis: str(x, 'basis', 120, 0), ref: optStr(x, 'ref', 120) ?? null };
  });
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), baseVersion: str(o, 'baseVersion', 64), items };
  return runCommand(db, {
    type: 'acceptUnitCosts', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      if (input.baseVersion !== config.activeBomVersion) throw new CommandError('STALE_VERSION', '成本表已被更新，请刷新后再确认');
      const base = await loadBom(tx, store, input.baseVersion);
      if (!base) throw new CommandError('STORE_NOT_CONFIGURED', '找不到当前成本版本');
      const pub = (await tx.get(store.configPublic)).data();
      const changed = input.items.filter((it) => it.unitCostUnits !== bomValueOf(base, it.key) || (it.key === 'dry_base' && it.unitCostUnits !== base.base.dry_wanton) || (it.key === 'soup_base' && it.unitCostUnits !== base.base.soup_noodle));
      const changes = bomChangesFor(input.items);
      const needsCalibration = (changes.calibrated ?? []).some((c) => base.pendingCalibration.includes(c));
      let version = base.version;
      if (changed.length || needsCalibration) {
        const seq = ((pub?.bomSeq as number) ?? 0) + 1;
        version = versionId(businessDateOf(nowMs, config.businessDay), seq);
        const r = applyBomChanges(base, changes, version);
        if (!r.ok) throw new CommandError('INVALID_ARGUMENT', r.issues.map((i) => `${i.field}：${i.message}`).join('；'), { issues: r.issues });
        const note = `经营 · 成本：${input.items.map((it) => `${it.key}=${it.unitCostUnits}（${it.kind}）`).join('，')}`.slice(0, 200);
        tx.create(store.root.collection('bomVersions').doc(version), { bom: r.bom, basedOn: base.version, note, publishedAtMs: nowMs, publishedBy: actor.uid, source: 'acceptUnitCosts' });
        tx.update(store.configPublic, { activeBomVersion: version, bomSeq: seq });
      }
      const prices: Record<string, unknown> = {};
      const suggestions: Record<string, unknown> = {};
      for (const it of input.items) {
        prices[it.key] = { kind: it.kind, unitCostUnits: it.unitCostUnits, basis: it.basis, atMs: nowMs, ref: it.ref, by: actor.uid };
        suggestions[it.key] = FieldValue.delete();
      }
      tx.set(store.configCostSources, { prices, suggestions, updatedAtMs: nowMs }, { merge: true });
      return {
        result: { version, published: version !== base.version, keys: input.items.map((i) => i.key) },
        audit: { entityId: `bom-${version}`, before: { version: base.version }, after: { version, items: input.items } },
      };
    },
  });
}

export async function setCostConversions(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'values']);
  const v = obj(o.values, Object.keys(CONVERSION_ZH), 'values');
  const keys = Object.keys(v) as ConversionKey[];
  if (!keys.length) throw bad('至少确认一项');
  for (const k of keys) if (!isValidConversion(k, v[k])) throw bad(`${CONVERSION_ZH[k].label} 应在 ${CONVERSION_ZH[k].min}–${CONVERSION_ZH[k].max} 之间`);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), values: Object.fromEntries(keys.map((k) => [k, Math.round(v[k] as number)])) as Record<ConversionKey, number> };
  return runCommand(db, {
    type: 'setCostConversions', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const before = (await tx.get(store.configCostSources)).data()?.conversions ?? {};
      const conversions = Object.fromEntries(keys.map((k) => [k, { value: input.values[k], kind: 'owner', basis: '你确认的', atMs: nowMs, by: actor.uid }]));
      tx.set(store.configCostSources, { conversions, updatedAtMs: nowMs }, { merge: true });
      return { result: { keys }, audit: { entityId: 'config/costSources', before: Object.fromEntries(keys.map((k) => [k, before[k]?.value ?? null])), after: input.values } };
    },
  });
}

const STOCK_UNITS: Record<string, string> = { 'ing-thin-noodle': '粒', 'ing-mee-poh': '粒', 'ing-minced-pork': 'kg', 'ing-wanton-skin': '张' };

export async function recordStockCount(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'counts']);
  if (!Array.isArray(o.counts) || !o.counts.length || o.counts.length > 10) throw bad('counts 为 1–10 项');
  const counts = (o.counts as unknown[]).map((r, i) => {
    const x = obj(r, ['ingredientId', 'quantity'], `counts[${i}]`);
    const ingredientId = str(x, 'ingredientId', 80);
    if (!STOCK_UNITS[ingredientId]) throw bad(`${ingredientId} 不能点数`);
    const q = x.quantity;
    if (typeof q !== 'number' || !Number.isFinite(q) || q < 0 || q > 100_000 || Math.abs(Math.round(q * 1000) - q * 1000) > 1e-6) throw bad(`counts[${i}].quantity 必须是 0 以上、最多 3 位小数`);
    return { ingredientId, quantity: q, unit: STOCK_UNITS[ingredientId] };
  });
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), counts };
  return runCommand(db, {
    type: 'recordStockCount', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const businessDate = businessDateOf(nowMs, config.businessDay);
      const ids = input.counts.map((c, i) => {
        const id = `sc-${input.operationId}-${i}`;
        tx.create(store.stockCount(id), { id, ...c, name: BUILT_IN_BY_ID.get(c.ingredientId)?.name ?? c.ingredientId, businessDate, atMs: nowMs, by: actor.uid });
        return id;
      });
      return { result: { ids, businessDate }, audit: { entityId: ids[0], after: { counts: input.counts, businessDate } } };
    },
  });
}

export async function estimateUnitCosts(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId']);
  return estimate(db, uid, { storeId: storeId(o) });
}

export async function getDailySummary(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'date', 'generate']);
  if (!isDateString(o.date)) throw bad('date 必须是 YYYY-MM-DD');
  return summary(db, uid, { storeId: storeId(o), date: o.date as string, generate: o.generate === undefined ? false : bool(o, 'generate') });
}
