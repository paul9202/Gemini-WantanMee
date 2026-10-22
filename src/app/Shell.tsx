import { ReactNode } from 'react';
import { businessDateOf } from '../domain/businessDay';
import { useNow, useOnline } from '../data/firebase/live';
import { USE_EMULATORS } from '../data/firebase/client';
import { Icon } from '../ui/visual';
import { navigate, Route } from './router';
import { Role, useSession } from './session';
import { applyUpdate, useSwState } from './swUpdate';
import { unsyncedEvents, useOfflineRuntime } from '../data/offline/runtime';

const NAV: { route: Route; label: string; roles: Role[] }[] = [
  { route: '/owner', label: '老板', roles: ['owner'] },
  { route: '/pos', label: '点单', roles: ['cashier', 'owner'] },
  { route: '/orders', label: '订单', roles: ['cashier', 'owner'] },
  { route: '/sync', label: '同步', roles: ['cashier', 'owner'] },
  { route: '/kitchen', label: '后厨', roles: ['kitchen', 'owner'] },
  { route: '/device', label: '设备', roles: ['cashier', 'owner', 'kitchen'] },
];

const ROLE_ZH: Record<Role, string> = { owner: '老板', cashier: '收银', kitchen: '后厨' };

/** POS/订单/设备页的暖色外壳。后厨页使用独立深色全屏，不走这里。 */
export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { member, config, user, signOut } = useSession();
  const online = useOnline();
  const now = useNow(30_000);
  const sw = useSwState();
  const rt = useOfflineRuntime();
  const unsynced = unsyncedEvents(rt).length;
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-card px-2 sm:gap-4 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-xl font-black text-white">豪</span>
          <div className="hidden leading-tight sm:block">
            <div className="font-bold">{config?.name ?? '豪云吞面'}</div>
            <div className="text-xs text-ink-2">{member ? ROLE_ZH[member.role] : ''}</div>
          </div>
        </div>
        <nav className="flex h-full min-w-0 items-stretch gap-1 overflow-x-auto whitespace-nowrap" aria-label="主要页面">
          {NAV.filter((n) => member && n.roles.includes(member.role)).map((n) => (
            <button key={n.route} onClick={() => navigate(n.route)} aria-current={route === n.route ? 'page' : undefined}
              className={`border-b-[3px] px-2 text-base font-semibold sm:min-w-16 sm:px-3 ${route === n.route ? 'border-brand text-brand' : 'border-transparent text-ink-2 hover:text-ink'}`}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm sm:gap-3">
          {USE_EMULATORS && <span className="hidden rounded bg-warn-bg px-2 py-1 text-xs font-semibold text-warn sm:inline">测试环境</span>}
          <span className={`inline-flex items-center gap-1.5 font-semibold ${online ? 'text-ok' : 'text-danger'}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-ok' : 'bg-danger'}`} />
            <span className="sr-only sm:not-sr-only">{online ? '网络正常' : '已断网'}</span>
          </span>
          <span className="hidden text-ink-2 lg:inline">营业日 {date}</span>
          <button onClick={() => void signOut()} title={user?.email ?? ''} className="flex h-10 items-center gap-1 rounded-lg border border-line px-2 text-ink-2 hover:text-ink sm:px-3">
            <Icon name="more" size={18} />退出
          </button>
        </div>
      </header>
      {!online && (
        <div role="status" className="border-b border-warn bg-warn-bg px-4 py-2 font-semibold text-warn">
          网络已断开 · 只有指定主收银机可以离线接单（仅本机保存），后厨屏不会自动收到，请人工传单。
        </div>
      )}
      {sw === 'update' && (
        <div role="status" className="flex flex-wrap items-center gap-3 border-b border-line bg-subtle px-4 py-2">
          <span>有新版本可用。{unsynced ? `本机还有 ${unsynced} 条未同步，请先完成同步再更新。` : '方便时（不忙时）再更新。'}</span>
          <button type="button" disabled={unsynced > 0} onClick={() => void applyUpdate()} className="ml-auto h-10 rounded-lg border border-control px-3 font-semibold disabled:opacity-40">更新并重新载入</button>
        </div>
      )}
      <main className="flex-1">{children}</main>
    </div>
  );
}
