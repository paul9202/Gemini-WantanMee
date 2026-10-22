/**
 * 设备与连接（替代原型的 Firebase 配置弹窗）：岗位、本机 ID、主收银机、连接与待核对数。
 * 员工界面不显示项目 ID、API Key 或部署按钮。
 */
import { useEffect, useState } from 'react';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { reasonText } from '../../data/firebase/reasons';
import { listPendingOps } from '../../data/local/idb';
import { useOnline } from '../../data/firebase/live';
import { useRegister } from '../../data/register';
import { useSession } from '../../app/session';
import { PHOTO_CATALOG_VERSION } from '../../ui/visual';
import manifest from '../../ui/photoManifest.json';
import { useOfflineRuntime } from '../../data/offline/runtime';
import { setLang, useLang, useT } from '../../app/i18n';

export function DevicePage() {
  const { member, deviceId, config } = useSession();
  const reg = useRegister();
  const online = useOnline();
  const [pending, setPending] = useState<number | null>(null);
  const rt = useOfflineRuntime();
  const tr = useT();
  const lang = useLang();
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
    listPendingOps().then((ops) => setPending(ops.filter((o) => o.status === 'submitting' || o.status === 'unknown_result' || o.status === 'not_found').length)).catch(() => setPending(null));
  }, []);

  const isThisRegister = reg.status === 'ready' || reg.status === 'no_shift';
  const rows: [string, string][] = [
    [tr('岗位', 'Role'), member ? tr({ owner: '老板', cashier: '收银', kitchen: '后厨' }[member.role], { owner: 'Owner', cashier: 'Cashier', kitchen: 'Kitchen' }[member.role]) : '—'],
    [tr('本机设备 ID', 'Device ID'), deviceId ?? '—'],
    [tr('主收银机', 'Main register'), config?.activeRegisterId ? `${config.activeRegisterId}${isThisRegister ? tr('（就是本机）', ' (this device)') : tr('（不是本机）', ' (another device)')}` : tr('尚未指定', 'Not set')],
    [tr('设备 epoch', 'Device epoch'), reg.claim ? String(reg.claim.registerEpoch) : '—'],
    [tr('班次', 'Shift'), reg.shift?.status === 'open' ? `${tr('营业中', 'Open')} · ${reg.shift.businessDate}` : tr('未开班', 'Not open')],
    [tr('网络', 'Network'), online ? tr('正常', 'Online') : tr('已断网', 'Offline')],
    [tr('本机待核对收款', 'Payments to check'), pending === null ? tr('无法读取本机存储', 'Cannot read local storage') : tr(`${pending} 单`, String(pending))],
    [tr('菜单版本', 'Menu version'), config?.activeMenuVersion ?? '—'],
    [tr('图片素材', 'Photos'), `${PHOTO_CATALOG_VERSION}${tr('（演示生成图，未经实店审核）', ' (generated demo images, not shop-approved)')}`],
    [tr('离线可用检查', 'Offline readiness'), !check ? tr('检查中…', 'Checking…') : [
      check.sw ? tr('✓ 离线应用壳已就绪', '✓ Offline app ready') : tr('✕ 离线应用壳未就绪（需联网打开一次正式版本）', '✕ Offline app not ready (open the live version online once)'),
      check.photos === check.total ? tr(`✓ 营业照片 ${check.total} 张已缓存`, `✓ ${check.total} photos cached`) : tr(`✕ 营业照片只缓存了 ${check.photos}/${check.total} 张`, `✕ Only ${check.photos}/${check.total} photos cached`),
      rt.snapshot ? `${tr('✓ 离线营业快照', '✓ Offline snapshot')} ${new Date(rt.snapshot.savedAtMs).toLocaleString('zh-CN', { hour12: false })}` : tr('✕ 尚无离线营业快照（开班并在点单页联网一次）', '✕ No offline snapshot yet (open a shift and visit Order online once)'),
    ].join(' · ')],
  ];

  return (
    <div className="mx-auto max-w-2xl p-4">
      <h1 className="mb-4 text-2xl font-bold">{tr('设备与连接', 'Device & connection')}</h1>
      <div className="mb-4 flex items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3">
        <span className="w-36 shrink-0 text-ink-2">{tr('界面语言', 'Language')}</span>
        <div role="radiogroup" aria-label={tr('界面语言', 'Language')} className="flex gap-2">
          {(['zh', 'en'] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={lang === l} onClick={() => setLang(l)}
              className={`h-12 rounded-lg border-2 px-5 text-lg font-semibold ${lang === l ? 'border-brand bg-brand text-white' : 'border-line bg-card'}`}>
              {l === 'zh' ? '中文' : 'English'}
            </button>
          ))}
        </div>
        <span className="text-sm text-ink-2">{tr('只影响本机；老板报表仍为中文。', 'This device only. Owner reports stay in Chinese.')}</span>
      </div>
      <dl className="overflow-hidden rounded-2xl border border-line bg-card">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-4 border-b border-line px-4 py-3 last:border-0">
            <dt className="w-36 shrink-0 text-ink-2">{k}</dt><dd className="min-w-0 break-all font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {member?.role === 'owner' && !isThisRegister && (
        <div className="mt-4 rounded-2xl border border-warn bg-warn-bg p-4">
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
  );
}
