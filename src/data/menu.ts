/**
 * 按版本读取菜单：随代码发布的版本直接返回；老板发布的版本从 menuVersions 读取（收银/老板可读），
 * 并缓存到本机 IndexedDB，断网重开时仍能按启用版本点单。
 */
import { useEffect, useState } from 'react';
import { MENU_VERSIONS, MenuVersion } from '../domain/menu';
import { storePath } from './firebase/client';
import { useLiveDoc } from './firebase/live';
import { kvGet, kvSet } from './local/idb';

export function useMenu(version: string | null | undefined): MenuVersion | undefined {
  const builtIn = version ? MENU_VERSIONS[version] : undefined;
  const live = useLiveDoc<{ menu: MenuVersion }>(version && !builtIn ? storePath(`menuVersions/${version}`) : null);
  const [cached, setCached] = useState<MenuVersion | undefined>();

  useEffect(() => {
    setCached(undefined);
    if (!version || builtIn) return;
    void kvGet<MenuVersion>(`menu:${version}`).then((m) => m && setCached(m)).catch(() => undefined);
  }, [version, builtIn]);

  const fromServer = live.data?.menu;
  useEffect(() => {
    if (fromServer && version) void kvSet(`menu:${version}`, fromServer).catch(() => undefined);
  }, [fromServer, version]);

  return builtIn ?? fromServer ?? cached;
}

/** 按版本取菜单（非 Hook）：随代码发布的版本或本机缓存；用于按成交版本重建离线单收据。 */
export async function menuForVersion(version: string): Promise<MenuVersion | undefined> {
  return MENU_VERSIONS[version] ?? (await kvGet<MenuVersion>(`menu:${version}`).catch(() => undefined));
}
