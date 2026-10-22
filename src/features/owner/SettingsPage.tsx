/**
 * 老板设置：成员（邀请 / 改岗位 / 停用）、菜单价格与售罄、单位成本（BOM）。
 * 价格与成本每次保存都发布一个新的不可变版本；旧版本保留给历史订单与离线单核对。
 */
import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { BOM_VERSIONS, BomVersion } from '../../domain/bom';
import { MenuVersion, PRODUCT_KINDS, ProductKind } from '../../domain/menu';
import { formatCostRMPrecise, formatRM, parseRMInput } from '../../domain/money';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, submit } from '../../data/firebase/commands';
import { reasonText } from '../../data/firebase/reasons';
import { useMenu } from '../../data/menu';
import { useSession } from '../../app/session';
import { useLoad } from './data';
import { OwnerTabs, Section } from './ui';

const ROLE_ZH = { owner: '老板', cashier: '收银', kitchen: '后厨' } as const;
type Role = keyof typeof ROLE_ZH;
const PRODUCT_ZH: Record<ProductKind, string> = { dry_noodle: '干捞面', soup_noodle: '云吞汤面', dry_wanton: '干捞云吞', wanton_soup: '云吞汤' };
const field = 'h-11 rounded-lg border border-control px-2';

type Msg = { ok: boolean; text: string } | null;

async function run<T>(name: Parameters<typeof submit>[0], payload: Record<string, unknown>, setMsg: (m: Msg) => void): Promise<T | null> {
  setMsg(null);
  try {
    return await submit<T>(name, { operationId: newOperationId(), ...payload });
  } catch (e) {
    setMsg({ ok: false, text: e instanceof CommandFailure ? `${reasonText(e.reasonCode)}${e.reasonCode === 'INVALID_ARGUMENT' ? `：${e.message}` : ''}` : String(e) });
    return null;
  }
}

export function SettingsPage() {
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <div className="mx-auto max-w-[1100px] space-y-4 p-4 pb-24 md:pb-6">
      <OwnerTabs current="/owner/settings" />
      <h1 className="text-2xl font-bold">设置</h1>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`rounded-lg px-3 py-2 ${msg.ok ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>{msg.text}</p>}
      <Members setMsg={setMsg} />
      <MenuEditor setMsg={setMsg} />
      <BomEditor setMsg={setMsg} />
    </div>
  );
}

// ---------- 成员 ----------

interface MemberRow { id: string; role: Role; active: boolean; displayName: string; email?: string }

function Members({ setMsg }: { setMsg: (m: Msg) => void }) {
  const { user } = useSession();
  const members = useLoad(async () => (await getDocs(collection(db, storePath('members')))).docs.map((d) => ({ id: d.id, ...d.data() }) as MemberRow), 'members');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function invite() {
    setBusy(true);
    const r = await run<{ setupLink: string; created: boolean }>('inviteMember', { email, displayName: name, role }, setMsg);
    setBusy(false);
    if (!r) return;
    setLink(r.setupLink);
    setMsg({ ok: true, text: `${r.created ? '已创建账号并加入' : '账号已存在，已加入'}：${email}（${ROLE_ZH[role]}）` });
    setEmail('');
    setName('');
    members.refresh();
  }

  async function update(m: MemberRow, patch: Partial<Pick<MemberRow, 'role' | 'active'>>, reason: string) {
    setBusy(true);
    const r = await run('manageMember', { memberUid: m.id, role: patch.role ?? m.role, active: patch.active ?? m.active, displayName: m.displayName, reason }, setMsg);
    setBusy(false);
    if (r) {
      setMsg({ ok: true, text: `${m.displayName}：已更新` });
      members.refresh();
    }
  }

  return (
    <Section title="成员" hint="员工账号由老板邀请；没有公开注册">
      <ul className="divide-y divide-line">
        {(members.data ?? []).sort((a, b) => Number(b.active) - Number(a.active) || a.role.localeCompare(b.role)).map((m) => (
          <li key={m.id} className={`flex flex-wrap items-center gap-2 py-2 ${m.active ? '' : 'opacity-60'}`}>
            <span className="min-w-0 flex-1"><b>{m.displayName}</b>{m.id === user?.uid ? '（我）' : ''}<span className="block text-xs text-ink-2">{m.email ?? m.id}</span></span>
            <select aria-label={`${m.displayName} 的岗位`} value={m.role} disabled={busy || m.id === user?.uid}
              onChange={(e) => void update(m, { role: e.target.value as Role }, '老板调整岗位')} className={field}>
              {Object.entries(ROLE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {m.id !== user?.uid && (
              <button type="button" disabled={busy} onClick={() => void update(m, { active: !m.active }, m.active ? '老板停用' : '老板恢复')}
                className={`h-11 rounded-lg border px-3 font-semibold ${m.active ? 'border-danger text-danger' : 'border-control'}`}>{m.active ? '停用' : '恢复'}</button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 rounded-xl bg-subtle p-3 sm:grid-cols-[1fr_1fr_auto_auto]">
        <input aria-label="员工邮箱" type="email" placeholder="员工邮箱" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
        <input aria-label="称呼" placeholder="称呼（例如：二厨）" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className={field} />
        <select aria-label="新成员岗位" value={role} onChange={(e) => setRole(e.target.value as Role)} className={field}>
          {Object.entries(ROLE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button type="button" disabled={busy || !email.includes('@') || !name.trim()} onClick={() => void invite()} className="h-11 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">邀请</button>
      </div>
      {link && (
        <div className="mt-3 rounded-xl border-2 border-warn bg-warn-bg p-3 text-sm">
          <b className="text-warn">设置密码链接（只给这位员工本人，不要发到群里）</b>
          <div className="mt-1 flex gap-2">
            <input readOnly value={link} aria-label="设置密码链接" className="h-10 min-w-0 flex-1 rounded border border-control bg-card px-2 text-xs" />
            <button type="button" onClick={() => void navigator.clipboard?.writeText(link)} className="h-10 rounded-lg border border-control bg-card px-3 font-semibold">复制</button>
          </div>
          <p className="mt-1 text-ink-2">停用成员会立即让该账号失去权限。</p>
        </div>
      )}
    </Section>
  );
}

// ---------- 菜单 ----------

const rm = (sen: number) => (sen / 100).toFixed(2);

function MenuEditor({ setMsg }: { setMsg: (m: Msg) => void }) {
  const { config } = useSession();
  const menu = useMenu(config?.activeMenuVersion);
  const history = useLoad(async () => (await getDocs(query(collection(db, storePath('menuVersions')), orderBy('publishedAtMs', 'desc')))).docs.map((d) => ({ id: d.id, ...(d.data() as { basedOn: string; note: string; publishedAtMs: number }) })), `menu-history-${config?.activeMenuVersion}`);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [soldOut, setSoldOut] = useState<ProductKind[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const d: Record<string, string> = {};
    for (const s of menu.products.dry_noodle.sizes) d[`noodle.${s.id}`] = rm(s.priceSen);
    for (const k of ['dry_wanton', 'wanton_soup'] as const) for (const s of menu.products[k].sizes) d[`${k}.${s.id}`] = rm(s.priceSen);
    for (const a of Object.values(menu.addOns)) d[`addon.${a.id}`] = rm(a.priceSen);
    setDraft(d);
    setSoldOut(menu.soldOut);
  }, [menu]);

  if (!menu) return <Section title="菜单与价格"><p className="text-ink-2">正在载入…</p></Section>;
  const sen = (k: string) => parseRMInput(draft[k] ?? '');
  const invalid = Object.keys(draft).some((k) => sen(k) === null);

  async function publish(m: MenuVersion) {
    const prices: Record<string, Record<string, number>> = { dry_noodle: {}, soup_noodle: {}, dry_wanton: {}, wanton_soup: {} };
    for (const s of m.products.dry_noodle.sizes) {
      // 餐牌：干捞面与汤面统一售价
      prices.dry_noodle[s.id] = sen(`noodle.${s.id}`)!;
      prices.soup_noodle[s.id] = sen(`noodle.${s.id}`)!;
    }
    for (const k of ['dry_wanton', 'wanton_soup'] as const) for (const s of m.products[k].sizes) prices[k][s.id] = sen(`${k}.${s.id}`)!;
    const addOnPrices = Object.fromEntries(Object.keys(m.addOns).map((id) => [id, sen(`addon.${id}`)!]));
    setBusy(true);
    const r = await run<{ version: string }>('publishMenu', { baseVersion: m.version, prices, addOnPrices, soldOut, note }, setMsg);
    setBusy(false);
    if (r) {
      setMsg({ ok: true, text: `已发布菜单版本 ${r.version}。收银机会自动改用新价格；离线期间按旧版本成交的单仍按旧价入账。` });
      setNote('');
      history.refresh();
    }
  }

  const priceInput = (k: string, label: string, kosong?: boolean) => (
    <label key={k} className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        RM<input aria-label={label} inputMode="decimal" value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
          className={`${field} w-24 text-right tabular-nums ${sen(k) === null ? 'border-danger' : ''}`} />
        {kosong && <span className="w-28 text-xs text-ink-2">净面 {sen(k) !== null ? formatRM(Math.floor(sen(k)! / 2)) : '—'}{sen(k) !== null && sen(k)! % 2 ? '（须偶数 sen）' : ''}</span>}
      </span>
    </label>
  );

  return (
    <Section title="菜单与价格" hint={`当前版本 ${menu.version}`}>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <div className="font-semibold">面条（干捞 / 汤面统一售价）</div>
          {menu.products.dry_noodle.sizes.map((s) => priceInput(`noodle.${s.id}`, `${s.nameZh}（${s.badge} 面球）`, true))}
        </div>
        <div className="space-y-2">
          <div className="font-semibold">云吞</div>
          {(['dry_wanton', 'wanton_soup'] as const).flatMap((k) => menu.products[k].sizes.map((s) => priceInput(`${k}.${s.id}`, `${PRODUCT_ZH[k]} ${s.nameZh}`)))}
        </div>
        <div className="space-y-2">
          <div className="font-semibold">加料</div>
          {Object.values(menu.addOns).map((a) => priceInput(`addon.${a.id}`, a.nameZh))}
          <div className="pt-2 font-semibold">售罄</div>
          {PRODUCT_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={soldOut.includes(k)} onChange={(e) => setSoldOut(e.target.checked ? [...soldOut, k] : soldOut.filter((x) => x !== k))} />
              {PRODUCT_ZH[k]}
            </label>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="发布说明（例如：叉烧涨价）" className={`${field} min-w-[240px] flex-1`} />
        <button type="button" disabled={busy || invalid} onClick={() => void publish(menu)} className="h-11 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">发布新菜单版本</button>
      </div>
      <p className="mt-2 text-xs text-ink-2">Kosong 净面严格半价，由系统自动计算。发布后正在点单的收银机会自动重算；仍按旧价提交的单会被要求重新确认价格。</p>
      {(history.data ?? []).length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold">历史版本（{history.data!.length}）</summary>
          <ul className="mt-1 space-y-1">
            {history.data!.map((h) => <li key={h.id}>{h.id} · 基于 {h.basedOn} · {new Date(h.publishedAtMs).toLocaleString('zh-CN', { hour12: false })}{h.note ? ` · ${h.note}` : ''}</li>)}
          </ul>
        </details>
      )}
    </Section>
  );
}

// ---------- 成本（BOM） ----------

/** 成本输入：RM，最多 3 位小数（0.1 sen 精度）→ 成本单位。 */
function parseCostRM(s: string): number | null {
  const c = s.replace(/rm/i, '').trim();
  if (!/^\d{1,4}(\.\d{0,3})?$/.test(c)) return null;
  const [w, f = ''] = c.split('.');
  return Number(w) * 1000 + Number(f.padEnd(3, '0'));
}
const costText = (units: number) => formatCostRMPrecise(units).replace('RM', '');

const CALIBRATION_ZH: Record<string, string> = {
  'noodleHalfBall.mee_poh': '面薄单位成本', 'base.soup_noodle': '汤面汤底成本', scallion_lard_extra: '多葱 / 多油渣成本',
};

function BomEditor({ setMsg }: { setMsg: (m: Msg) => void }) {
  const { config } = useSession();
  const version = config?.activeBomVersion;
  const bomQ = useLoad(async () => {
    if (!version) return null;
    if (BOM_VERSIONS[version]) return BOM_VERSIONS[version];
    return ((await getDoc(doc(db, storePath(`bomVersions/${version}`)))).data()?.bom as BomVersion | undefined) ?? null;
  }, `bom-${version}`);
  const bom = bomQ.data;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [calibrated, setCalibrated] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bom) return;
    setDraft({
      'ball.thin_egg': costText(bom.noodleHalfBall.thin_egg * 2), 'ball.mee_poh': costText(bom.noodleHalfBall.mee_poh * 2),
      wanton: costText(bom.wanton), charSiewPortion: costText(bom.charSiewPortion), packagingPerPortion: costText(bom.packagingPerPortion),
      ...Object.fromEntries(PRODUCT_KINDS.map((k) => [`base.${k}`, costText(bom.base[k])])),
    });
    setCalibrated([]);
  }, [bom]);

  if (!bom) return <Section title="单位成本（BOM）"><p className="text-ink-2">{bomQ.loading ? '正在载入…' : '找不到成本版本'}</p></Section>;
  const u = (k: string) => parseCostRM(draft[k] ?? '');
  const invalid = Object.keys(draft).some((k) => u(k) === null) || [u('ball.thin_egg'), u('ball.mee_poh')].some((v) => v !== null && v % 2 !== 0);
  const input = (k: string, label: string) => (
    <label key={k} className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="flex items-center gap-1">RM<input aria-label={label} inputMode="decimal" value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
        className={`${field} w-24 text-right tabular-nums ${u(k) === null ? 'border-danger' : ''}`} /></span>
    </label>
  );

  async function publish(b: BomVersion) {
    setBusy(true);
    const r = await run<{ version: string }>('publishBom', {
      baseVersion: b.version,
      noodleBall: { thin_egg: u('ball.thin_egg'), mee_poh: u('ball.mee_poh') },
      wanton: u('wanton'), charSiewPortion: u('charSiewPortion'), packagingPerPortion: u('packagingPerPortion'),
      base: Object.fromEntries(PRODUCT_KINDS.map((k) => [k, u(`base.${k}`)])), calibrated,
    }, setMsg);
    setBusy(false);
    if (r) setMsg({ ok: true, text: `已发布成本版本 ${r.version}，只影响之后的新订单。` });
  }

  return (
    <Section title="单位成本（BOM）" hint={`当前版本 ${bom.version} · 只影响之后的新订单`}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          {input('ball.thin_egg', '细面 每面球')}
          {input('ball.mee_poh', '面薄 每面球')}
          {input('wanton', '云吞 每粒')}
          {input('charSiewPortion', '叉烧 每份')}
          {input('packagingPerPortion', '打包 每份')}
        </div>
        <div className="space-y-2">
          {PRODUCT_KINDS.map((k) => input(`base.${k}`, `${PRODUCT_ZH[k]} 底料`))}
        </div>
      </div>
      {bom.pendingCalibration.length > 0 && (
        <div className="mt-3 rounded-lg bg-warn-bg p-2 text-sm text-warn">
          <b>待实店校准：</b>
          {bom.pendingCalibration.map((k) => (
            <label key={k} className="ml-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={calibrated.includes(k)} onChange={(e) => setCalibrated(e.target.checked ? [...calibrated, k] : calibrated.filter((x) => x !== k))} />
              {CALIBRATION_ZH[k] ?? k} 已核对
            </label>
          ))}
        </div>
      )}
      <button type="button" disabled={busy || invalid} onClick={() => void publish(bom)} className="mt-3 h-11 rounded-lg bg-brand px-4 font-bold text-white disabled:bg-control">发布新成本版本</button>
      <p className="mt-2 text-xs text-ink-2">成本精确到 0.1 sen（例如 0.85 = RM0.85）；面球成本须为偶数个 0.1 sen，以便半面球计算。</p>
    </Section>
  );
}
