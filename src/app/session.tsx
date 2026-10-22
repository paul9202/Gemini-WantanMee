/**
 * 会话：Auth 身份 + 门店成员角色 + 门店公开配置 + 本机设备 ID。
 * 角色只决定显示哪些页面；真正的授权在 Rules 与 Functions。
 */
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, User } from 'firebase/auth';
import { auth, storePath } from '../data/firebase/client';
import { useLiveDoc } from '../data/firebase/live';
import { getDeviceId, requestPersistence } from '../data/local/idb';
import { startAutoSync, useOfflineRuntime } from '../data/offline/runtime';

export type Role = 'owner' | 'cashier' | 'kitchen';

export interface Member {
  role: Role;
  active: boolean;
  displayName: string;
}

export interface StoreConfig {
  name: string;
  timeZone: string;
  cutoverMinutes: number;
  activeMenuVersion: string;
  activeRegisterId: string | null;
  qrPayee: string | null;
}

interface Session {
  ready: boolean;
  user: User | null;
  member: Member | null;
  memberError: string | null;
  config: StoreConfig | null;
  deviceId: string | null;
  /** 断网重开时使用的是最后一次联网保存的本机快照（不是服务器实时数据）。 */
  usingSnapshot: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(auth, (u) => {
    setUser(u);
    setAuthReady(true);
  }), []);
  useEffect(() => {
    getDeviceId().then(setDeviceId).catch(() => setDeviceId(null));
    void requestPersistence();
    startAutoSync();
  }, []);

  const rt = useOfflineRuntime();
  const snap = rt.snapshot && user && rt.snapshot.uid === user.uid ? rt.snapshot : null;
  const member = useLiveDoc<Member>(user ? storePath(`members/${user.uid}`) : null);
  // 服务器明确返回（非缓存）才算权威；只有拿不到服务器数据时才退回本机快照。
  const liveMember = member.data && member.data.active ? member.data : null;
  const memberFromSnap = !liveMember && member.fromCache && snap ? snap.member : null;
  const activeMember = liveMember ?? memberFromSnap;
  const config = useLiveDoc<StoreConfig>(activeMember ? storePath('config/public') : null);
  const configData = config.data ?? (config.fromCache && snap ? snap.config : null);

  const value: Session = {
    ready: authReady && rt.loaded && (!user || !member.loading) && (!activeMember || !config.loading || Boolean(configData)),
    user,
    member: activeMember,
    memberError: user && !member.loading && !activeMember ? member.error ?? 'NOT_A_MEMBER' : null,
    config: configData,
    deviceId,
    usingSnapshot: Boolean(memberFromSnap || (!config.data && configData)),
    signOut: () => fbSignOut(auth),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider 缺失');
  return s;
}
