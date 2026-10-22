/**
 * 老板发布菜单（价格、售罄）与 BOM（单位成本）新版本。
 * 新版本不可变；发布后立即成为启用版本，之前的版本保留供历史订单与离线单校验。
 * 收银端按启用版本自动重算；仍用旧版本提交的在线单会收到 MENU_CHANGED，需重新确认价格。
 */
import { Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import { applyBomChanges, applyMenuChanges, BomChanges, MenuChanges } from '../../../src/domain/catalog';
import { loadBom, loadMenu } from '../core/catalog';
import { runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, obj, optStr, storeId, str, uuid } from '../core/input';
import { loadStoreConfig } from '../core/store';

const record = (v: unknown, field: string): Record<string, unknown> => {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad(`${field} 必须是对象`);
  return v as Record<string, unknown>;
};

function versionId(prefix: string, date: string, seq: number) {
  return `${prefix}-${date.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`;
}

export async function publishMenu(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'baseVersion', 'prices', 'addOnPrices', 'soldOut', 'note']);
  if (o.soldOut !== undefined && (!Array.isArray(o.soldOut) || !o.soldOut.every((x) => typeof x === 'string'))) throw bad('soldOut 必须是字符串数组');
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), baseVersion: str(o, 'baseVersion', 64),
    changes: { prices: record(o.prices, 'prices'), addOnPrices: record(o.addOnPrices, 'addOnPrices'), soldOut: (o.soldOut as string[] | undefined) ?? [] } as MenuChanges,
    note: optStr(o, 'note', 200) ?? '',
  };
  return runCommand(db, {
    type: 'publishMenu', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      // 只允许在当前启用版本上修改，避免基于过期版本覆盖别人刚发布的改动。
      if (input.baseVersion !== config.activeMenuVersion) throw new CommandError('STALE_VERSION', '菜单已被更新，请刷新后再改');
      const base = await loadMenu(tx, store, input.baseVersion);
      if (!base) throw new CommandError('STORE_NOT_CONFIGURED', '找不到当前菜单版本');
      const seq = (((await tx.get(store.configPublic)).data()?.menuSeq as number) ?? 0) + 1;
      const version = versionId('menu', businessDateOf(nowMs, config.businessDay), seq);
      const r = applyMenuChanges(base, input.changes, version);
      if (!r.ok) throw new CommandError('INVALID_ARGUMENT', r.issues.map((i) => `${i.field}：${i.message}`).join('；'), { issues: r.issues });
      tx.create(store.root.collection('menuVersions').doc(version), { menu: r.menu, basedOn: base.version, note: input.note, publishedAtMs: nowMs, publishedBy: actor.uid });
      tx.update(store.configPublic, { activeMenuVersion: version, menuSeq: seq });
      return { result: { version, basedOn: base.version }, audit: { entityId: `menu-${version}`, before: { version: base.version }, after: { version, changes: input.changes } } };
    },
  });
}

export async function publishBom(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'baseVersion', 'noodleBall', 'wanton', 'charSiewPortion', 'base', 'packagingPerPortion', 'calibrated', 'note']);
  const num = (k: string) => (o[k] === undefined ? undefined : (o[k] as number));
  if (o.calibrated !== undefined && (!Array.isArray(o.calibrated) || !o.calibrated.every((x) => typeof x === 'string'))) throw bad('calibrated 必须是字符串数组');
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), baseVersion: str(o, 'baseVersion', 64),
    // 未提交的可选字段不写入（Firestore 不接受 undefined，审计里也只记实际改动）。
    changes: JSON.parse(JSON.stringify({
      noodleBall: record(o.noodleBall, 'noodleBall'), wanton: num('wanton'), charSiewPortion: num('charSiewPortion'),
      base: record(o.base, 'base'), packagingPerPortion: num('packagingPerPortion'), calibrated: (o.calibrated as string[] | undefined) ?? [],
    })) as BomChanges,
    note: optStr(o, 'note', 200) ?? '',
  };
  return runCommand(db, {
    type: 'publishBom', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      if (input.baseVersion !== config.activeBomVersion) throw new CommandError('STALE_VERSION', '成本表已被更新，请刷新后再改');
      const base = await loadBom(tx, store, input.baseVersion);
      if (!base) throw new CommandError('STORE_NOT_CONFIGURED', '找不到当前成本版本');
      const seq = (((await tx.get(store.configPublic)).data()?.bomSeq as number) ?? 0) + 1;
      const version = versionId('bom', businessDateOf(nowMs, config.businessDay), seq);
      const r = applyBomChanges(base, input.changes, version);
      if (!r.ok) throw new CommandError('INVALID_ARGUMENT', r.issues.map((i) => `${i.field}：${i.message}`).join('；'), { issues: r.issues });
      tx.create(store.root.collection('bomVersions').doc(version), { bom: r.bom, basedOn: base.version, note: input.note, publishedAtMs: nowMs, publishedBy: actor.uid });
      tx.update(store.configPublic, { activeBomVersion: version, bomSeq: seq });
      return { result: { version, basedOn: base.version }, audit: { entityId: `bom-${version}`, before: { version: base.version }, after: { version, changes: input.changes } } };
    },
  });
}
