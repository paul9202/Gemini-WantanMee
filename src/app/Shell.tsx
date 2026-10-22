import { ReactNode } from 'react';
import { businessDateOf } from '../domain/businessDay';
import { useNow, useOnline } from '../data/firebase/live';
import { USE_EMULATORS } from '../data/firebase/client';
import { Icon } from '../ui/visual';
import { navigate, Route } from './router';
import { Role, useSession } from './session';
import { applyUpdate, useSwState } from './swUpdate';
import { useT } from './i18n';
import { unsyncedEvents, useOfflineRuntime } from '../data/offline/runtime';

const NAV: { route: Route; label: string; en: string; roles: Role[] }[] = [
  { route: '/owner', label: '老板', en: 'Owner', roles: ['owner'] },
  { route: '/pos', label: '点单', en: 'Order', roles: ['cashier', 'owner'] },
  { route: '/orders', label: '订单', en: 'Orders', roles: ['cashier', 'owner'] },
  { route: '/sync', label: '同步', en: 'Sync', roles: ['cashier', 'owner'] },
  { route: '/kitchen', label: '后厨', en: 'Kitchen', roles: ['kitchen', 'owner'] },
  { route: '/training', label: '图卡', en: 'Cards', roles: ['cashier', 'owner', 'kitchen'] },
  { route: '/device', label: '设备', en: 'Device', roles: ['cashier', 'owner', 'kitchen'] },
];

const ROLE_ZH: Record<Role, string> = { owner: '老板', cashier: '收银', kitchen: '后厨' };
const ROLE_EN: Record<Role, string> = { owner: 'Owner', cashier: 'Cashier', kitchen: 'Kitchen' };

/** POS/订单/设备页的暖色外壳。后厨页使用独立深色全屏，不走这里。 */
export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { member, config, user, signOut } = useSession();
  const online = useOnline();
  const now = useNow(30_000);
  const sw = useSwState();
  const tr = useT();
  const rt = useOfflineRuntime();
  const unsynced = unsyncedEvents(rt).length;
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  return (
    <div className="flex min-h-screen flex-col bg-canvas print:min-h-0 print:bg-white">
      <header className="sticky top-0 z-30 flex h-16 print:hidden items-center gap-2 border-b border-line bg-card px-2 sm:gap-4 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-xl font-black text-white">豪</span>
          <div className="hidden leading-tight sm:block">
            <div className="font-bold">{config?.name ?? '豪云吞面'}</div>
            <div className="text-xs text-ink-2">{member ? tr(ROLE_ZH[member.role], ROLE_EN[member.role]) : ''}</div>
          </div>
        </div>
        <nav className="flex h-full min-w-0 items-stretch gap-1 overflow-x-auto whitespace-nowrap" aria-label={tr('主要页面', 'Main pages')}>
          {NAV.filter((n) => member && n.roles.includes(member.role)).map((n) => (
            <button key={n.route} onClick={() => navigate(n.route)} aria-current={route === n.route ? 'page' : undefined}
              className={`border-b-[3px] px-2 text-base font-semibold sm:min-w-16 sm:px-3 ${route === n.route ? 'border-brand text-brand' : 'border-transparent text-ink-2 hover:text-ink'}`}>
              {tr(n.label, n.en)}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm sm:gap-3">
          {USE_EMULATORS && <span className="hidden rounded bg-warn-bg px-2 py-1 text-xs font-semibold text-warn sm:inline">{tr('测试环境', 'Test env')}</span>}
          <span className={`inline-flex items-center gap-1.5 font-semibold ${online ? 'text-ok' : 'text-danger'}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-ok' : 'bg-danger'}`} />
            <span className="sr-only sm:not-sr-only">{online ? tr('网络正常', 'Online') : tr('已断网', 'Offline')}</span>
          </span>
          <span className="hidden text-ink-2 lg:inline">{tr('营业日', 'Business day')} {date}</span>
          <button onClick={() => void signOut()} title={user?.email ?? ''} className="flex h-10 items-center gap-1 rounded-lg border border-line px-2 text-ink-2 hover:text-ink sm:px-3">
            <Icon name="more" size={18} />{tr('退出', 'Sign out')}
          </button>
        </div>
      </header>
      {!online && (
        <div role="status" className="border-b border-warn bg-warn-bg px-4 py-2 font-semibold text-warn print:hidden">
          {tr('网络已断开 · 只有指定主收银机可以离线接单（仅本机保存），后厨屏不会自动收到，请人工传单。', 'Offline · only the main register can take orders (saved on this device). The kitchen screen will not receive them — hand the ticket over.')}
        </div>
      )}
      {sw === 'update' && (
        <div role="status" className="flex flex-wrap items-center gap-3 border-b border-line bg-subtle px-4 py-2 print:hidden">
          <span>{tr('有新版本可用。', 'A new version is available. ')}{unsynced ? tr(`本机还有 ${unsynced} 条未同步，请先完成同步再更新。`, `${unsynced} record(s) not synced yet — sync first.`) : tr('方便时（不忙时）再更新。', 'Update when not busy.')}</span>
          <button type="button" disabled={unsynced > 0} onClick={() => void applyUpdate()} className="ml-auto h-10 rounded-lg border border-control px-3 font-semibold disabled:opacity-40">{tr('更新并重新载入', 'Update & reload')}</button>
        </div>
      )}
      <main className="flex-1">{children}</main>
    </div>
  );
}
