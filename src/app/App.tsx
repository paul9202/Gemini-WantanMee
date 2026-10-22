/**
 * 应用根：登录 → 按岗位进入对应页面。后厨可直接收藏 /kitchen。
 * 原型的演示数据注入、清空交易按钮、Firebase 配置弹窗都不再接入。
 */
import { useEffect } from 'react';
import { KitchenPage } from '../features/kitchen/KitchenPage';
import { OrdersPage } from '../features/orders/OrdersPage';
import { PosPage } from '../features/pos/PosPage';
import { DevicePage } from '../features/device/DevicePage';
import { SyncPage } from '../features/sync/SyncPage';
import { OverviewPage } from '../features/owner/OverviewPage';
import { FinancePage } from '../features/owner/FinancePage';
import { ReviewPage } from '../features/owner/ReviewPage';
import { ClosePage } from '../features/owner/ClosePage';
import { SettingsPage } from '../features/owner/SettingsPage';
import { TrainingPage } from '../features/training/TrainingPage';
import { IconSprite } from '../ui/visual';
import { Login } from './Login';
import { navigate, Route, useRoute } from './router';
import { Role, SessionProvider, useSession } from './session';
import { Shell } from './Shell';

const ALLOWED: Record<Exclude<Route, '/login'>, Role[]> = {
  '/pos': ['cashier', 'owner'],
  '/orders': ['cashier', 'owner'],
  '/sync': ['cashier', 'owner'],
  '/kitchen': ['kitchen', 'owner'],
  '/device': ['cashier', 'owner', 'kitchen'],
  '/owner': ['owner'],
  '/owner/finance': ['owner'],
  '/owner/review': ['owner'],
  '/owner/close': ['owner'],
  '/owner/settings': ['owner'],
  '/training': ['owner', 'cashier', 'kitchen'],
};
const HOME: Record<Role, Route> = { owner: '/owner', cashier: '/pos', kitchen: '/kitchen' };

function Routes() {
  const { ready, user, member, memberError, signOut } = useSession();
  const route = useRoute();

  useEffect(() => {
    if (!ready) return;
    if (!user) navigate('/login', true);
    else if (member && (route === null || route === '/login' || !ALLOWED[route].includes(member.role))) navigate(HOME[member.role], true);
  }, [ready, user, member, route]);

  if (!ready) return <p className="p-6 text-ink-2">正在载入…</p>;
  if (!user) return <Login />;
  if (memberError || !member) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-card p-6">
        <h1 className="text-xl font-bold">当前账号无法进入本店</h1>
        <p className="mt-2 text-ink-2">账号不是本店成员或已停用。请老板在成员管理中邀请。</p>
        <button type="button" onClick={() => void signOut()} className="mt-4 h-12 rounded-lg border border-control px-4 font-semibold">退出登录</button>
      </div>
    );
  }
  if (route === '/kitchen') return <KitchenPage />;
  if (route === '/orders') return <Shell route="/orders"><OrdersPage /></Shell>;
  if (route === '/sync') return <Shell route="/sync"><SyncPage /></Shell>;
  if (route === '/owner') return <Shell route="/owner"><OverviewPage /></Shell>;
  if (route === '/owner/finance') return <Shell route="/owner"><FinancePage /></Shell>;
  if (route === '/owner/review') return <Shell route="/owner"><ReviewPage /></Shell>;
  if (route === '/owner/close') return <Shell route="/owner"><ClosePage /></Shell>;
  if (route === '/owner/settings') return <Shell route="/owner"><SettingsPage /></Shell>;
  if (route === '/device') return <Shell route="/device"><DevicePage /></Shell>;
  if (route === '/training') return <Shell route="/training"><TrainingPage /></Shell>;
  return <Shell route="/pos"><PosPage /></Shell>;
}

export default function App() {
  return (
    <SessionProvider>
      <IconSprite />
      <Routes />
    </SessionProvider>
  );
}
