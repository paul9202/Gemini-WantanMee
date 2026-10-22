/** 极简路由：只用 History API，避免为几个固定页面引入路由框架。 */
import { useEffect, useState } from 'react';

export type Route = '/login' | '/pos' | '/orders' | '/sync' | '/kitchen' | '/device' | '/owner' | '/owner/finance' | '/owner/review' | '/owner/close';
const ROUTES: Route[] = ['/login', '/pos', '/orders', '/sync', '/kitchen', '/device', '/owner', '/owner/finance', '/owner/review', '/owner/close'];

function current(): Route | null {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  return (ROUTES as string[]).includes(p) ? (p as Route) : null;
}

export function navigate(to: Route, replace = false) {
  if (location.pathname === to) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route | null {
  const [route, setRoute] = useState(current());
  useEffect(() => {
    const on = () => setRoute(current());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return route;
}
