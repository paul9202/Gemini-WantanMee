/**
 * 连接与设备（替代原型的 Firebase 配置弹窗；2026-10-23 新版布局）：
 * 本机 → 云端 → 后厨三处分别判断，常用状态在前，技术详情收进「高级设备信息」。
 * 员工界面不显示项目 ID、API Key 或部署按钮。
 */
import { ReactNode, useEffect, useState } from 'react';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { reasonText } from '../../data/firebase/reasons';
import { exportRecoveryPackage, listPendingOps } from '../../data/local/idb';
import { useLiveDoc, useNow, useOnline } from '../../data/firebase/live';
import { useRegister } from '../../data/register';
import { useSession } from '../../app/session';
import { navigate } from '../../app/router';
import { storePath } from '../../data/firebase/client';
import { kitchenHealth } from '../../domain/kitchenLink';
import { formatClock } from '../../domain/timing';
import { Icon, PHOTO_CATALOG_VERSION } from '../../ui/visual';
import type { IconName } from '../../ui/iconSymbols';
import manifest from '../../ui/photoManifest.json';
import { serverNow, unsyncedEvents, useOfflineRuntime } from '../../data/offline/runtime';
import { setLang, useLang, useT } from '../../app/i18n';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';
const TONE: Record<Tone, string> = { ok: 'bg-ok-bg text-ok', warn: 'bg-warn-bg text-warn', bad: 'bg-danger-bg text-danger', idle: 'bg-subtle text-ink-2' };

export function DevicePage() {
  const { member, deviceId, config } = useSession();
  const reg = useRegister();
  const online = useOnline();
  const [pending, setPending] = useState<number | null>(null);
  const rt = useOfflineRuntime();
  const tr = useT();
  const lang = useLang();
  useNow(5000);
  const ops = useLiveDoc<{ kitchenLastSeenAtMs?: number }>(storePath('operationsStatus/current'));
  const [check, setCheck] = useState<{ sw: boolean; photos: number; total: number } | null>(null);
  useEffect(() => {
    // 离线可用检查：Service Worker 已接管页面、营业照片全部在缓存里。
    void (async () => {
      const sw = Boolean(navigator.serviceWorker?.controller);
      let photos = 0;
      // Workbox 预缓存的 URL 带版本参数，匹配时忽略查询串。
      if ('caches' in window) for (const p of manifest.photos) if (await caches.match(p.path, { ignoreSearch: true })) photos++;
      setCheck({ sw, photos, total: manifest.photos.length });
    })();
  }, []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    listPendingOps().then((o) => setPending(o.filter((x) => x.status === 'submitting' || x.status === 'unknown_result' || x.status === 'not_found').length)).catch(() => setPending(null));
  }, []);

  const role = member?.role;
  const front = role === 'owner' || role === 'cashier';
  const isThisRegister = reg.status === 'ready' || reg.status === 'no_shift';
  const unsynced = unsyncedEvents(rt).length;
  const kh = kitchenHealth(ops.data?.kitchenLastSeenAtMs ?? null, serverNow(rt));
  const seenAgo = ops.data?.kitchenLastSeenAtMs ? formatClock(serverNow(rt) - ops.data.kitchenLastSeenAtMs) : null;

  const local: Node = isThisRegister
    ? { tone: pending ? 'warn' : 'ok', title: tr('主收银机（本机）', 'Main register (this device)'), sub: pending ? tr(`${pending} 单收款待核对`, `${pending} payment(s) to check`) : tr('本机订单已保存', 'Local orders saved') }
    : { tone: 'idle', title: tr('本机', 'This device'), sub: config?.activeRegisterId ? tr('不是主收银机', 'Not the main register') : tr('尚未指定主收银机', 'No main register yet') };
  const cloud: Node = !online
    ? { tone: 'bad', title: tr('云端', 'Cloud'), sub: tr('已断网，记录保存在本机', 'Offline — kept on this device') }
    : unsynced
      ? { tone: 'warn', title: tr('云端', 'Cloud'), sub: tr(`${unsynced} 条待同步`, `${unsynced} to sync`) }
      : { tone: 'ok', title: tr('云端', 'Cloud'), sub: tr('没有待同步订单', 'Nothing waiting to sync') };
  const kitchen: Node = kh === 'online'
    ? { tone: 'ok', title: tr('后厨屏', 'Kitchen screen'), sub: tr(`${seenAgo} 前在线`, `seen ${seenAgo} ago`) }
    : kh === 'stale'
      ? { tone: 'bad', title: tr('后厨屏', 'Kitchen screen'), sub: tr(`可能离线（${seenAgo} 前）`, `may be offline (${seenAgo} ago)`) }
      : { tone: 'idle', title: tr('后厨屏', 'Kitchen screen'), sub: tr('尚未连接', 'Not connected yet') };
  const allOk = local.tone === 'ok' && cloud.tone === 'ok' && kitchen.tone === 'ok';
  const offlineReady = check && check.sw && check.photos === check.total && Boolean(rt.snapshot);

  const advanced: [string, string][] = [
    [tr('本机设备 ID', 'Device ID'), deviceId ?? '—'],
    [tr('主收银机', 'Main register'), config?.activeRegisterId ? `${config.activeRegisterId}${isThisRegister ? tr('（就是本机）', ' (this device)') : tr('（不是本机）', ' (another device)')}` : tr('尚未指定', 'Not set')],
    [tr('设备 epoch', 'Device epoch'), reg.claim ? String(reg.claim.registerEpoch) : '—'],
    [tr('班次', 'Shift'), reg.shift?.status === 'open' ? `${tr('营业中', 'Open')} · ${reg.shift.businessDate}` : tr('未开班', 'Not open')],
    [tr('本机待核对收款', 'Payments to check'), pending === null ? tr('无法读取本机存储', 'Cannot read local storage') : tr(`${pending} 单`, String(pending))],
    [tr('图片素材', 'Photos'), `${PHOTO_CATALOG_VERSION}${tr('（演示生成图，未经实店审核）', ' (generated demo images, not shop-approved)')}`],
    [tr('离线可用检查', 'Offline readiness'), !check ? tr('检查中…', 'Checking…') : [
      check.sw ? tr('✓ 离线应用壳已就绪', '✓ Offline app ready') : tr('✕ 离线应用壳未就绪（需联网打开一次正式版本）', '✕ Offline app not ready (open the live version online once)'),
      check.photos === check.total ? tr(`✓ 营业照片 ${check.total} 张已缓存`, `✓ ${check.total} photos cached`) : tr(`✕ 营业照片只缓存了 ${check.photos}/${check.total} 张`, `✕ Only ${check.photos}/${check.total} photos cached`),
      rt.snapshot ? `${tr('✓ 离线营业快照', '✓ Offline snapshot')} ${new Date(rt.snapshot.savedAtMs).toLocaleString('zh-CN', { hour12: false })}` : tr('✕ 尚无离线营业快照（开班并在点单页联网一次）', '✕ No offline snapshot yet (open a shift and visit Order online once)'),
    ].join(' · ')],
  ];

  return (
    <div className="mx-auto max-w-[1440px] p-4 pb-8 lg:p-8">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-2xl font-bold lg:text-[28px]">{allOk ? tr('一切就绪，安心营业。', 'All set. Open for business.') : tr('先看看哪里需要处理。', 'A few things need attention.')}</h2>
          <p className="text-sm text-ink-2">{tr('常用状态放在前面，技术详情按需查看。', 'Everyday status first; technical details on demand.')}</p>
        </div>
        <span className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${allOk ? TONE.ok : TONE.warn}`}>
          <span className={`h-2 w-2 rounded-full ${allOk ? 'bg-ok' : 'bg-warn'}`} />{allOk ? tr('全部连接正常', 'All connected') : tr('有连接需要关注', 'Check connections')}
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <div className="flex items-start">
              <div>
                <h3 className="text-lg font-bold">{tr('订单传递状态', 'Order delivery')}</h3>
                <p className="text-[13px] text-ink-2">{tr('本机、云端、后厨，三处分别确认。', 'This device, cloud and kitchen are checked separately.')}</p>
              </div>
              <span className={`ml-auto rounded-lg px-2.5 py-1 text-sm font-semibold ${cloud.tone === 'ok' ? TONE.ok : TONE[cloud.tone]}`}>{cloud.tone === 'ok' ? tr('已同步', 'Synced') : cloud.sub}</span>
            </div>
            <div className="mt-6 flex items-start">
              <Pipe node={local} icon="register" />
              <Link tone={cloud.tone} />
              <Pipe node={cloud} icon="cloud" />
              <Link tone={kitchen.tone} />
              <Pipe node={kitchen} icon="cook" />
            </div>
            <p className={`mt-6 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${offlineReady ? 'border-ok/30 bg-ok-bg text-ok' : 'border-warn/30 bg-warn-bg text-warn'}`}>
              <Icon name={offlineReady ? 'check' : 'help'} size={18} />
              {!check ? tr('正在检查离线准备…', 'Checking offline readiness…')
                : front ? <span>{offlineReady ? tr(`离线应用与 ${check.total} 张营业图片已准备好。`, `Offline app and ${check.total} photos are ready.`) : tr('离线营业还没准备好。', 'Offline mode is not ready yet.')}<span className="block text-xs">{advanced[advanced.length - 1][0]}：{advanced[advanced.length - 1][1]}</span></span>
                : tr(`营业图片已缓存 ${check.photos}/${check.total} 张。`, `${check.photos}/${check.total} photos cached.`)}
            </p>
          </Card>

          {front && (
            <Card>
              <div className="flex flex-wrap items-center gap-4">
                <Icon name="handoff" size={36} />
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold">{tr('断网时怎么做？', 'What to do when offline?')}</h3>
                  <p className="text-[13px] text-ink-2">{tr('主收银机的订单保存在本机，改用纸单交给厨房。恢复后在同步中心核对人工单，避免重复做餐。', 'The main register keeps orders locally; hand paper tickets to the kitchen. After reconnecting, check paper tickets in Sync to avoid cooking twice.')}</p>
                </div>
                <button type="button" onClick={() => navigate('/sync')} className="flex h-12 items-center gap-2 rounded-xl border border-line px-4 font-bold">{tr('打开同步中心', 'Open Sync')}<Icon name="arrow" size={18} /></button>
              </div>
            </Card>
          )}

          {front && (
            <Card>
              <div className="flex flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold">{tr('资料备份与交接', 'Backup & hand-over')}</h3>
                  <p className="text-[13px] text-ink-2">{tr('导出本机恢复包（离线订单、事件与待核对收款），换机或交班时使用；导入在同步中心。', 'Export this device’s recovery package (offline orders, events, pending payments). Import it in Sync.')}</p>
                </div>
                <button type="button" onClick={async () => {
                  const pkg = await exportRecoveryPackage();
                  const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }));
                  const a = Object.assign(document.createElement('a'), { href: url, download: `hao-pos-recovery-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json` });
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }} className="flex h-12 items-center gap-2 rounded-xl border border-line px-4 font-bold"><Icon name="download" size={18} />{tr('导出恢复包', 'Export package')}</button>
              </div>
            </Card>
          )}

          <details className="group px-1">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-sm text-ink-2"><Icon name="chevron-right" size={16} className="transition-transform group-open:rotate-90" />{tr('高级设备信息', 'Advanced device info')}</summary>
            <dl className="mt-2 overflow-hidden rounded-2xl border border-line bg-card">
              {advanced.map(([k, v]) => (
                <div key={k} className="flex gap-4 border-b border-line px-4 py-3 text-sm last:border-0">
                  <dt className="w-32 shrink-0 text-ink-2">{k}</dt><dd className="min-w-0 break-all font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>

        <div className="space-y-4">
          <Card>
            <Row title={tr('界面语言', 'Language')} sub={tr('只影响这台设备；老板报表仍为中文', 'This device only; owner reports stay in Chinese')}>
              <div role="radiogroup" aria-label={tr('界面语言', 'Language')} className="flex rounded-xl bg-subtle p-1">
                {(['zh', 'en'] as const).map((l) => (
                  <button key={l} type="button" role="radio" aria-checked={lang === l} onClick={() => setLang(l)}
                    className={`h-10 rounded-lg px-4 font-semibold ${lang === l ? 'bg-card shadow' : 'text-ink-2'}`}>{l === 'zh' ? '中文' : 'English'}</button>
                ))}
              </div>
            </Row>
            <Row title={tr('当前岗位', 'Role')} sub={tr('按岗位显示常用功能', 'Features shown by role')}>
              <span className="rounded-lg bg-subtle px-3 py-1.5 font-bold">{role ? tr({ owner: '老板', cashier: '收银', kitchen: '后厨' }[role], { owner: 'Owner', cashier: 'Cashier', kitchen: 'Kitchen' }[role]) : '—'}</span>
            </Row>
            <Row title={tr('主收银机', 'Main register')} sub={tr('指定设备负责接单与收款', 'The device that takes orders and payments')}>
              <b>{config?.activeRegisterId ? `${config.activeRegisterId}${isThisRegister ? tr('（就是本机）', ' (this device)') : tr('（不是本机）', ' (another device)')}` : tr('尚未指定', 'Not set')}</b>
            </Row>
            {(role === 'owner' || role === 'kitchen') && (
              <Row title={tr('后厨显示', 'Kitchen display')} sub={tr('大字与高对比，方便远距离查看', 'Large, high-contrast text for distance viewing')}>
                <button type="button" onClick={() => navigate('/kitchen')} className="flex h-11 items-center gap-2 rounded-xl border border-line px-4 font-bold">{tr('打开', 'Open')}<Icon name="arrow" size={18} /></button>
              </Row>
            )}
            <Row title={tr('菜单与图片', 'Menu & photos')} sub={`${tr('菜单版本', 'Menu version')} ${config?.activeMenuVersion ?? '—'}`}>
              <span className={`rounded-lg px-2.5 py-1 text-sm font-semibold ${check && check.photos === check.total ? TONE.ok : TONE.warn}`}>
                {check && check.photos === check.total ? tr('已就绪', 'Ready') : tr('图片未缓存完', 'Photos not cached')}
              </span>
            </Row>
          </Card>

          <Card>
            <div className="flex items-start gap-3">
              <Icon name="help" size={24} />
              <div className="min-w-0 flex-1">
                <h3 className="font-bold">{tr('新员工快速上手', 'New staff quick start')}</h3>
                <p className="text-[13px] text-ink-2">{tr('餐品、配料和操作图卡，在前台与后厨使用相同图示。', 'Dish, topping and action cards use the same pictures at the counter and in the kitchen.')}</p>
                <button type="button" onClick={() => navigate('/training')} className="mt-3 h-12 rounded-xl border border-line px-4 font-bold">{tr('查看操作图卡', 'Open training cards')}</button>
              </div>
            </div>
          </Card>

          {role === 'owner' && !isThisRegister && (
            <div className="rounded-2xl border border-warn/40 bg-warn-bg p-5">
              <b>{tr('把这台设备设为主收银机', 'Make this the main register')}</b>
              <p className="mt-1 text-sm text-warn">{tr('原主收银机会立即失去接单资格（epoch +1）。原机上未同步的记录以后只能进入待核对。', 'The old register stops taking orders at once (epoch +1). Its unsynced records will need owner review.')}</p>
              {msg && <p role="alert" className="mt-2 text-danger">{msg}</p>}
              <button type="button" disabled={busy || !deviceId}
                onClick={async () => {
                  setBusy(true);
                  setMsg(null);
                  try {
                    await submit('assignRegister', { operationId: newOperationId(), registerId: config?.activeRegisterId ?? 'front-01', deviceId, reason: '老板在设备页指定主收银机' });
                  } catch (e) {
                    setMsg(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
                className="mt-3 h-14 rounded-xl bg-brand px-6 text-lg font-bold text-white disabled:bg-control">{busy ? tr('处理中…', 'Working…') : tr('设为主收银机', 'Set as main register')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface Node { tone: Tone; title: string; sub: string }

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-2xl border border-line bg-card p-5 shadow-card lg:p-6">{children}</section>;
}

function Row({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-4 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0 flex-1"><b>{title}</b><p className="text-[13px] text-ink-2">{sub}</p></div>
      {children}
    </div>
  );
}

function Pipe({ node, icon }: { node: Node; icon: IconName }) {
  return (
    <div className="flex w-24 shrink-0 flex-col items-center text-center sm:w-32">
      <span className={`flex h-16 w-16 items-center justify-center rounded-2xl ${TONE[node.tone]}`}><Icon name={icon} size={36} /></span>
      <b className="mt-2 text-sm sm:text-base">{node.title}</b>
      <span className={`text-xs ${node.tone === 'bad' ? 'text-danger' : node.tone === 'warn' ? 'text-warn' : 'text-ink-2'}`}>{node.sub}</span>
    </div>
  );
}

function Link({ tone }: { tone: Tone }) {
  const c = tone === 'ok' ? 'bg-ok/50' : tone === 'bad' ? 'bg-danger/60' : tone === 'warn' ? 'bg-warn/60' : 'bg-line';
  return (
    <div className="mt-8 flex flex-1 items-center" aria-hidden>
      <span className={`h-0.5 flex-1 ${c} ${tone === 'bad' ? 'opacity-60 [background-image:repeating-linear-gradient(90deg,transparent_0_6px,#fff_6px_10px)]' : ''}`} />
      <span className={`h-2 w-2 rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'bad' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-control'}`} />
      <span className={`h-0.5 flex-1 ${c}`} />
    </div>
  );
}
