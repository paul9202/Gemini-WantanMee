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

export function DevicePage() {
  const { member, deviceId, config } = useSession();
  const reg = useRegister();
  const online = useOnline();
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    listPendingOps().then((ops) => setPending(ops.filter((o) => o.status === 'submitting' || o.status === 'unknown_result').length)).catch(() => setPending(null));
  }, []);

  const isThisRegister = reg.status === 'ready' || reg.status === 'no_shift';
  const rows: [string, string][] = [
    ['岗位', member ? { owner: '老板', cashier: '收银', kitchen: '后厨' }[member.role] : '—'],
    ['本机设备 ID', deviceId ?? '—'],
    ['主收银机', config?.activeRegisterId ? `${config.activeRegisterId}${isThisRegister ? '（就是本机）' : '（不是本机）'}` : '尚未指定'],
    ['设备 epoch', reg.claim ? String(reg.claim.registerEpoch) : '—'],
    ['班次', reg.shift?.status === 'open' ? `营业中 · ${reg.shift.businessDate}` : '未开班'],
    ['网络', online ? '正常' : '已断网'],
    ['本机待核对收款', pending === null ? '无法读取本机存储' : `${pending} 单`],
    ['菜单版本', config?.activeMenuVersion ?? '—'],
    ['图片素材', `${PHOTO_CATALOG_VERSION}（演示生成图，未经实店审核）`],
  ];

  return (
    <div className="mx-auto max-w-2xl p-4">
      <h1 className="mb-4 text-2xl font-bold">设备与连接</h1>
      <dl className="overflow-hidden rounded-2xl border border-line bg-card">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-4 border-b border-line px-4 py-3 last:border-0">
            <dt className="w-36 shrink-0 text-ink-2">{k}</dt><dd className="min-w-0 break-all font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {member?.role === 'owner' && !isThisRegister && (
        <div className="mt-4 rounded-2xl border border-warn bg-warn-bg p-4">
          <b>把这台设备设为主收银机</b>
          <p className="mt-1 text-sm text-warn">原主收银机会立即失去接单资格（epoch +1）。原机上未同步的记录以后只能进入待核对。</p>
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
            className="mt-3 h-14 rounded-xl bg-brand px-6 text-lg font-bold text-white disabled:bg-control">{busy ? '处理中…' : '设为主收银机'}</button>
        </div>
      )}
    </div>
  );
}
