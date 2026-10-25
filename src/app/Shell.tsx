import { createContext, ReactNode, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { businessDateOf } from '../domain/businessDay';
import { useNow, useOnline } from '../data/firebase/live';
import { USE_EMULATORS } from '../data/firebase/client';
import { Icon } from '../ui/visual';
import type { IconName } from '../ui/iconSymbols';
import { navigate, Route } from './router';
import { Role, useSession } from './session';
import { applyUpdate, useSwState } from './swUpdate';
import { useLang, useT } from './i18n';
import { unsyncedEvents, useOfflineRuntime } from '../data/offline/runtime';

const NAV: { route: Route; label: string; en: string; icon: IconName; roles: Role[] }[] = [
  { route: '/pos', label: '点餐', en: 'Order', icon: 'bowl', roles: ['cashier', 'owner'] },
  { route: '/orders', label: '订单', en: 'Orders', icon: 'list', roles: ['cashier', 'owner'] },
  { route: '/kitchen', label: '后厨', en: 'Kitchen', icon: 'cook', roles: ['kitchen', 'owner'] },
  { route: '/owner', label: '经营', en: 'Owner', icon: 'chart', roles: ['owner'] },
  { route: '/sync', label: '同步', en: 'Sync', icon: 'refresh', roles: ['cashier', 'owner'] },
  { route: '/training', label: '图卡', en: 'Cards', icon: 'help', roles: ['cashier', 'owner', 'kitchen'] },
  { route: '/device', label: '设备', en: 'Device', icon: 'sliders', roles: ['cashier', 'owner', 'kitchen'] },
];

/** 页头标题。老板子页共用「经营」导航，但标题各自不同。 */
const TITLES: Record<string, { zh: string; en: string; subZh: string; subEn: string }> = {
  '/pos': { zh: '新的一单，好好做。', en: 'New order', subZh: '', subEn: '' },
  '/orders': { zh: '今日订单', en: 'Orders today', subZh: '每一单的进度，都看得见。', subEn: 'Every order, step by step.' },
  '/sync': { zh: '同步中心', en: 'Sync', subZh: '本机记录与云端核对。', subEn: 'Local records and the cloud.' },
  '/owner': { zh: '经营概览', en: 'Business overview', subZh: '把时间留给好好做面。', subEn: '' },
  '/owner/finance': { zh: '收支与目标', en: 'Money & goals', subZh: '收支、食材用料、日常开支、开档成本与经营目标。', subEn: '' },
  '/owner/review': { zh: '待核对', en: 'To review', subZh: '离线记录逐条处理。', subEn: '' },
  '/owner/close': { zh: '日结关账', en: 'Close day', subZh: '核对现金、QR 与差额。', subEn: '' },
  '/owner/settings': { zh: '设置', en: 'Settings', subZh: '成员、菜单与成本。', subEn: '' },
  '/training': { zh: '员工图卡', en: 'Training cards', subZh: '前台与后厨使用相同图示。', subEn: 'Same pictures at the counter and in the kitchen.' },
  '/device': { zh: '连接与设备', en: 'Connection & device', subZh: '营业状态，一眼放心。', subEn: 'Business status at a glance.' },
};

const ROLE_ZH: Record<Role, string> = { owner: '老板', cashier: '收银', kitchen: '后厨' };
const ROLE_EN: Record<Role, string> = { owner: 'Owner', cashier: 'Cashier', kitchen: 'Kitchen' };

/** 页面可以把操作放进页头右侧（例如点餐页的堂食/打包与餐牌）。 */
const HeaderSlot = createContext<HTMLElement | null>(null);
export function ShellHeaderActions({ children }: { children: ReactNode }) {
  const el = useContext(HeaderSlot);
  return el ? createPortal(children, el) : null;
}

/** 前台各页的外壳：桌面左侧岗位导航，手机底部导航。后厨页使用独立全屏，不走这里。 */
export function Shell({ route, title, children }: { route: Route; title?: Route; children: ReactNode }) {
  const { member, config, user, signOut } = useSession();
  const online = useOnline();
  const now = useNow(30_000);
  const sw = useSwState();
  const tr = useT();
  const lang = useLang();
  const rt = useOfflineRuntime();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const unsynced = unsyncedEvents(rt).length;
  const date = config ? businessDateOf(now, { timeZone: config.timeZone, cutoverMinutes: config.cutoverMinutes }) : '';
  const nav = NAV.filter((n) => member && n.roles.includes(member.role));
  const head = TITLES[title ?? route] ?? TITLES['/pos'];
  const sub = lang === 'en' ? head.subEn : head.subZh;
  const dateLabel = date ? new Intl.DateTimeFormat(lang === 'en' ? 'en-MY' : 'zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) : '';

  return (
    <div className="flex h-[100dvh] bg-canvas print:block print:h-auto print:bg-white">
      <aside className="hidden w-[76px] shrink-0 flex-col items-center border-r border-line bg-[#fbfaf6] py-3 md:flex xl:w-[92px] xl:py-5 print:hidden" aria-label={tr('岗位导航', 'Navigation')}>
        <span className="mb-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand text-2xl font-black text-[#fff8e8] xl:mb-6">豪</span>
        <nav className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto px-2" aria-label={tr('主要页面', 'Main pages')}>
          {nav.map((n) => {
            const active = route === n.route;
            return (
              <button key={n.route} type="button" onClick={() => navigate(n.route)} aria-current={active ? 'page' : undefined}
                className={`flex min-h-14 w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl py-1.5 text-[13px] ${active ? 'bg-brand-soft font-bold text-brand' : 'text-ink-2 hover:bg-subtle hover:text-ink'}`}>
                <Icon name={n.icon} size={24} />{tr(n.label, n.en)}
              </button>
            );
          })}
        </nav>
        <div className="mt-2 flex shrink-0 flex-col items-center gap-1">
          <span title={user?.email ?? ''} className="hidden h-10 w-10 items-center [@media(min-height:700px)]:flex justify-center rounded-full bg-subtle text-[13px] font-bold">{member ? tr(ROLE_ZH[member.role], ROLE_EN[member.role].slice(0, 4)) : ''}</span>
          <button type="button" onClick={() => void signOut()} className="min-h-14 w-14 rounded-lg text-xs text-ink-2 hover:text-ink">{tr('退出', 'Sign out')}</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-card px-4 py-2.5 md:flex-nowrap md:px-5 xl:gap-x-4 xl:px-8 xl:py-4 print:hidden">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-xl font-black text-[#fff8e8] md:hidden">豪</span>
          <div className="shell-title min-w-0 flex-1 xl:flex-none">
            <div className="hidden text-[11px] font-semibold tracking-[0.2em] text-ink-2 sm:block">HAO WANTAN MEE</div>
            <h1 className="truncate text-xl font-bold leading-tight lg:text-[26px]">{tr(head.zh, head.en)}</h1>
            {sub && <p className="hidden text-[13px] text-ink-2 sm:block">{sub}</p>}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3 md:order-last">
            {USE_EMULATORS && <span className="hidden rounded-md bg-warn-bg px-2 py-1 text-xs font-semibold text-warn sm:inline">{tr('测试环境', 'Test env')}</span>}
            <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold ${online ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>
              <span className={`h-2 w-2 rounded-full ${online ? 'bg-ok' : 'bg-danger'}`} />
              <span className="sr-only sm:not-sr-only">{online ? tr('门店在线', 'Online') : tr('已断网', 'Offline')}</span>
            </span>
            {dateLabel && <span className="hidden text-[13px] text-ink-2 xl:inline" title={tr('营业日', 'Business day')}>{dateLabel}</span>}
            <button type="button" onClick={() => void signOut()} title={user?.email ?? ''} className="flex h-14 items-center rounded-lg border border-line px-3 text-sm text-ink-2 hover:text-ink md:hidden">
              {tr('退出', 'Sign out')}
            </button>
          </div>
          <div ref={setSlot} className="shell-slot order-last flex w-full flex-wrap items-center gap-2 empty:hidden md:order-none md:w-auto md:flex-nowrap xl:gap-3" />
        </header>
        {!online && (
          <div role="status" className="flex items-center gap-3 border-b border-warn/40 bg-warn-bg px-4 py-2 font-semibold text-warn md:px-5 xl:px-8 print:hidden">
            <Icon name="wifi-off" size={22} />
            {tr('网络已断开 · 只有指定主收银机可以离线接单（仅本机保存），后厨屏不会自动收到，请人工传单。', 'Offline · only the main register can take orders (saved on this device). The kitchen screen will not receive them — hand the ticket over.')}
          </div>
        )}
        {sw === 'update' && (
          <div role="status" className="flex flex-wrap items-center gap-3 border-b border-line bg-subtle px-4 py-2 lg:px-8 print:hidden">
            <span>{tr('有新版本可用。', 'A new version is available. ')}{unsynced ? tr(`本机还有 ${unsynced} 条未同步，请先完成同步再更新。`, `${unsynced} record(s) not synced yet — sync first.`) : tr('方便时（不忙时）再更新。', 'Update when not busy.')}</span>
            <button type="button" disabled={unsynced > 0} onClick={() => void applyUpdate()} className="ml-auto h-10 rounded-lg border border-control bg-card px-3 font-semibold disabled:opacity-40">{tr('更新并重新载入', 'Update & reload')}</button>
          </div>
        )}
        <HeaderSlot.Provider value={slot}>
          <main className="min-h-0 flex-1 overflow-y-auto print:overflow-visible">{children}</main>
        </HeaderSlot.Provider>
        <nav aria-label={tr('主要页面', 'Main pages')} className="flex shrink-0 border-t border-line bg-[#fbfaf6] pb-[env(safe-area-inset-bottom)] md:hidden print:hidden">
          {nav.map((n) => {
            const active = route === n.route;
            return (
              <button key={n.route} type="button" onClick={() => navigate(n.route)} aria-current={active ? 'page' : undefined}
                className={`mx-0.5 my-1 flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[12px] ${active ? 'bg-brand-soft font-bold text-brand' : 'text-ink-2'}`}>
                <Icon name={n.icon} size={22} /><span className="max-w-full truncate px-0.5">{tr(n.label, n.en)}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
