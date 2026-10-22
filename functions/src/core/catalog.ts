/**
 * 菜单 / BOM 版本读取：先查随代码发布的版本，再查老板发布到数据库的版本。
 * 历史版本永不删除，旧订单与离线单按成交时的版本校验。
 */
import type { Transaction } from 'firebase-admin/firestore';
import { BOM_VERSIONS, BomVersion } from '../../../src/domain/bom';
import { MENU_VERSIONS, MenuVersion } from '../../../src/domain/menu';
import type { StoreRefs } from './command';

export async function loadMenu(tx: Transaction, store: StoreRefs, version: string): Promise<MenuVersion | undefined> {
  if (MENU_VERSIONS[version]) return MENU_VERSIONS[version];
  return (await tx.get(store.root.collection('menuVersions').doc(version))).data()?.menu as MenuVersion | undefined;
}

export async function loadBom(tx: Transaction, store: StoreRefs, version: string): Promise<BomVersion | undefined> {
  if (BOM_VERSIONS[version]) return BOM_VERSIONS[version];
  return (await tx.get(store.root.collection('bomVersions').doc(version))).data()?.bom as BomVersion | undefined;
}
