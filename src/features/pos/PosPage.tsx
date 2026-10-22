/**
 * POS 点单页：同一画布完成常规点单（02 §4）。
 * 接单进度只显示有依据的事实：本机已记录 → 云端已接单 → 后厨已收到。
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { BOM_V1 } from '../../domain/bom';
import { addLine, Cart, computeTotals, emptyCart, setLineQuantity, setServiceMode, updateLineConfig } from '../../domain/cart';
import { defaultConfig, LineConfig } from '../../domain/lineItem';
import { MENU_VERSIONS } from '../../domain/menu';
import { formatRM, parseRMInput } from '../../domain/money';
import { createTokenBoard, countTokens, suggestNextToken, TokenBoard, TokenStateName } from '../../domain/tokens';
import { formatClock } from '../../domain/timing';
import { db, storePath } from '../../data/firebase/client';
import { CommandFailure, newOperationId, reconcile, submit } from '../../data/firebase/commands';
import { useLiveDoc, useLiveQuery, useNow, useOnline } from '../../data/firebase/live';
import { reasonText } from '../../data/firebase/reasons';
import { kvGet, kvSet, listPendingOps, PendingOp, putPendingOp } from '../../data/local/idb';
import { useRegister } from '../../data/register';
import { navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { Icon } from '../../ui/visual';
import { CartPanel } from './CartPanel';
import { PaymentDrawer, PaymentInput } from './PaymentDrawer';
import { ProductPanel } from './ProductPanel';
import { TokenPicker } from './TokenPicker';

interface CreateOrderResult {
  orderId: string;
  receiptNumber: string;
  tokenNumber: number;
  totalSen: number;
  changeSen: number | null;
  replayed?: boolean;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'submitting' }
  | { kind: 'accepted'; result: CreateOrderResult; method: string }
  | { kind: 'rejected'; reason: string; code: string }
  | { kind: 'unknown'; operationId: string }
  | { kind: 'local_failed'; message: string };

export function PosPage() {
  const { config, member } = useSession();
  const reg = useRegister();
  const online = useOnline();
  const menu = config ? MENU_VERSIONS[config.activeMenuVersion] : undefined;

  const tokensQ = useLiveQuery<{ number: number; state: TokenStateName; orderId: string | null; version: number }>(collection(db, storePath('tokens')), 'tokens');
  const board: TokenBoard = useMemo(() => {
    const b = createTokenBoard();
    for (const t of tokensQ.data) b[t.number] = { number: t.number, state: t.state, orderId: t.orderId, version: t.version };
    return b;
  }, [tokensQ.data]);
  const queueQ = useLiveQuery<{ fulfillmentStatus: string; acceptedAtEffectiveMs: number }>(
    query(collection(db, storePath('kitchenTickets')), where('kitchenRouting', '==', 'digital'), where('fulfillmentStatus', 'in', ['queued', 'preparing'])),
    'pos-queue',
  );

  const [cart, setCart] = useState<Cart>(emptyCart());
  const [draft, setDraft] = useState<LineConfig | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ cart: Cart; label: string } | null>(null);
  const [token, setToken] = useState<number | null>(null);
  const [lastIssued, setLastIssued] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 窄屏（<1024）本单收起为底部条，点开后全屏显示。
  const [cartOpen, setCartOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [pending, setPending] = useState<PendingOp[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (menu && !draft) setDraft(defaultConfig(menu, 'dry_noodle', 'black'));
  }, [menu, draft]);
  const refreshPending = () => listPendingOps().then((ops) => setPending(ops.filter((o) => o.status === 'submitting' || o.status === 'unknown_result')));
  useEffect(() => void refreshPending(), []);
  // 上一次发出的牌号存本机，页面切换或刷新后仍按顺序循环建议。
  useEffect(() => {
    void kvGet<number>('lastIssuedToken').then((n) => {
      if (!n) return;
      setLastIssued(n);
      setToken(null); // 重新按上次牌号之后建议
    });
  }, []);
  const rememberIssued = (n: number) => {
    setLastIssued(n);
    void kvSet('lastIssuedToken', n);
  };
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);

  // 当前牌失效（被占用）或未选时，循环建议下一个可用牌；只建议，不抢占。
  useEffect(() => {
    if (tokensQ.loading) return;
    if (token === null || board[token]?.state !== 'available') setToken(suggestNextToken(board, lastIssued));
  }, [board, token, lastIssued, tokensQ.loading]);

  const lastOrder = useLiveDoc<{ kitchenAckAtMs: number | null; fulfillmentStatus: string }>(
    stage.kind === 'accepted' ? storePath(`orders/${stage.result.orderId}`) : null,
  );

  if (!menu || !config || !draft) return <p className="p-6">正在载入菜单…</p>;
  if (reg.status !== 'ready') return <RegisterGate status={reg.status} isOwner={member?.role === 'owner'} />;

  const totals = computeTotals(menu, BOM_V1, cart);
  const counts = countTokens(board);
  const unresolved = pending.length > 0;
  const busy = stage.kind === 'saving' || stage.kind === 'submitting';

  const payDisabledReason = cart.lines.length === 0 ? '先加入餐品'
    : token === null ? '没有可用餐牌，请先回收餐牌'
    : unresolved ? '有收款结果待核对，请先处理上方提示'
    : !online ? '已断网：离线接单尚未开放'
    : null;

  function addOrSave() {
    if (!draft || !menu) return;
    if (editingLineId) {
      setCart(updateLineConfig(menu, cart, editingLineId, draft));
      setEditingLineId(null);
    } else {
      setUndo({ cart, label: '已加入本单' });
      setCart(addLine(menu, cart, draft, crypto.randomUUID()));
    }
    // 每次加入后特殊选项归默认，防止上一位顾客的走青或 Kosong 残留；保留所选餐品与面种。
    const keep = defaultConfig(menu, draft.productKind, draft.sauce);
    setDraft({ ...keep, noodleType: keep.noodleType ? draft.noodleType : null });
    if (stage.kind !== 'idle' && !busy) setStage({ kind: 'idle' });
  }

  function changeQuantity(lineId: string, q: number) {
    if (q > 50) return;
    if (q === 0) setUndo({ cart, label: '已移除一行' });
    setCart(setLineQuantity(cart, lineId, q));
    if (q === 0 && editingLineId === lineId) setEditingLineId(null);
  }

  async function confirmPayment(p: PaymentInput) {
    if (!menu || !reg.claim || !reg.shiftId || token === null) return;
    const sequence = reg.nextSequence();
    const operationId = newOperationId();
    const payload = {
      operationId, ...reg.claim, sequence, shiftId: reg.shiftId,
      order: {
        clientOrderId: crypto.randomUUID(), tokenNumber: token, serviceMode: cart.serviceMode, menuVersion: menu.version,
        lines: cart.lines.map((l) => ({ lineId: l.lineId, config: l.config, quantity: l.quantity })),
        expectedTotalSen: totals.totalSen, deviceAcceptedAtMs: Date.now(),
      },
      payment: { method: p.method, tenderedSen: p.tenderedSen, qrConfirmed: p.qrConfirmed },
    };
    const op: PendingOp = {
      operationId, name: 'createOrder', payload, status: 'submitting', createdAtMs: Date.now(), updatedAtMs: Date.now(),
      summary: { tokenNumber: token, totalSen: totals.totalSen, method: p.method, tenderedSen: p.tenderedSen },
    };
    setStage({ kind: 'saving' });
    try {
      await putPendingOp(op);
    } catch (e) {
      setStage({ kind: 'local_failed', message: e instanceof Error ? e.message : String(e) });
      return; // 不清空购物车，不声称成功
    }
    setStage({ kind: 'submitting' });
    try {
      const result = await submit<CreateOrderResult>('createOrder', payload);
      await putPendingOp({ ...op, status: 'accepted', result: { ...result }, updatedAtMs: Date.now() });
      await reg.markApplied(sequence);
      setStage({ kind: 'accepted', result, method: p.method });
      rememberIssued(result.tokenNumber);
      setToken(null);
      setCart(emptyCart(cart.serviceMode));
      setEditingLineId(null);
      setUndo(null);
      setPayOpen(false);
    } catch (e) {
      const f = e instanceof CommandFailure ? e : new CommandFailure('unknown', 'UNKNOWN_RESULT', String(e));
      if (f.kind === 'rejected') {
        await putPendingOp({ ...op, status: 'rejected', reasonCode: f.reasonCode, updatedAtMs: Date.now() });
        setStage({ kind: 'rejected', code: f.reasonCode, reason: reasonText(f.reasonCode) });
      } else {
        await putPendingOp({ ...op, status: 'unknown_result', updatedAtMs: Date.now() });
        setStage({ kind: 'unknown', operationId });
        setPayOpen(false);
      }
    }
    void refreshPending();
  }

  async function reconcileOp(op: PendingOp) {
    try {
      const result = await reconcile<CreateOrderResult>('createOrder', op.payload);
      await putPendingOp({ ...op, status: 'accepted', result: { ...result }, updatedAtMs: Date.now() });
      await reg.markApplied(op.payload.sequence as number);
      setNotice(`已核对：${result.tokenNumber}号 ${formatRM(result.totalSen)} 云端已接单（票号 ${result.receiptNumber}）。未重复收款。`);
      if (stage.kind === 'unknown' && stage.operationId === op.operationId) {
        setStage({ kind: 'accepted', result, method: String(op.summary.method) });
        setCart(emptyCart(cart.serviceMode));
        setToken(null);
        rememberIssued(result.tokenNumber);
      }
    } catch (e) {
      const f = e instanceof CommandFailure ? e : null;
      if (f?.kind === 'rejected') {
        await putPendingOp({ ...op, status: 'rejected', reasonCode: f.reasonCode, updatedAtMs: Date.now() });
        setNotice(`${op.summary.tokenNumber}号 ${formatRM(op.summary.totalSen)}：云端未接单（${reasonText(f.reasonCode)}）。钱已收时请勿再次收钱，修正后用这笔钱重新提交，或按退款处理。`);
      } else {
        setNotice('仍无法连接云端核对，请稍后再试。请勿再次收钱。');
      }
    }
    void refreshPending();
  }

  async function releaseTokenCmd(n: number, orderId: string): Promise<string | null> {
    if (!reg.claim) return '收银机未就绪';
    const sequence = reg.nextSequence();
    try {
      await submit('releaseToken', { operationId: newOperationId(), ...reg.claim, sequence, tokenNumber: n, orderId });
      await reg.markApplied(sequence);
      return null;
    } catch (e) {
      return e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e);
    }
  }

  const oldest = queueQ.data.reduce((m, t) => Math.min(m, t.acceptedAtEffectiveMs), Infinity);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas px-4 py-2">
        <div className="flex rounded-xl bg-subtle p-1" role="group" aria-label="就餐方式">
          {(['dine_in', 'takeaway'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={cart.serviceMode === m} onClick={() => setCart(setServiceMode(cart, m))}
              className={`flex h-12 items-center gap-2 rounded-lg px-4 text-lg font-bold ${cart.serviceMode === m ? 'bg-card shadow' : 'text-ink-2'}`}>
              <Icon name={m === 'dine_in' ? 'table' : 'bag'} size={30} />{m === 'dine_in' ? '堂食' : '打包'}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setPickerOpen(true)} className="flex h-14 items-center gap-3 rounded-xl border-2 border-control bg-card px-4">
          <span className="text-lg">餐牌</span><b className="text-3xl tabular-nums">{token ?? '满'}</b><span aria-hidden>▾</span>
        </button>
        <span className="rounded-lg bg-ok-bg px-2 py-1 text-sm font-semibold text-ok">{counts.available}个可用</span>
        {counts.awaiting_return > 0 && (
          <button type="button" onClick={() => setPickerOpen(true)} className="rounded-lg bg-warn-bg px-2 py-1 text-sm font-semibold text-warn">
            {counts.awaiting_return}个待回收
          </button>
        )}
        {tokensQ.fromCache && <span className="text-sm text-warn">餐牌状态可能过期</span>}
      </div>

      {(pending.length > 0 || notice) && (
        <div className="space-y-2 border-b border-warn bg-warn-bg px-4 py-2" role="alert">
          {pending.map((op) => (
            <div key={op.operationId} className="flex flex-wrap items-center gap-3 text-warn">
              <b>{op.summary.tokenNumber}号 · {formatRM(op.summary.totalSen)}：已记录收款，正在核对订单；请勿再次收钱。</b>
              <button type="button" onClick={() => void reconcileOp(op)} className="h-11 rounded-lg bg-warn px-4 font-bold text-white">核对结果</button>
            </div>
          ))}
          {notice && (
            <div className="flex items-center gap-3 text-ink"><span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="ml-auto h-10 rounded-lg border border-control px-3">知道了</button>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="min-h-0 flex-1 lg:flex-[62] lg:border-r lg:border-line">
          <ProductPanel menu={menu} config={draft} onChange={setDraft} editing={Boolean(editingLineId)} onSubmit={addOrSave}
            onCancelEdit={() => { setEditingLineId(null); setDraft(defaultConfig(menu, draft.productKind, draft.sauce)); }} />
        </section>
        <aside className={`${cartOpen ? 'fixed inset-x-0 top-16 bottom-0 z-30 flex' : 'hidden'} min-h-0 flex-col bg-card lg:static lg:z-auto lg:flex lg:max-w-[560px] lg:min-w-[340px] lg:flex-[38]`}>
          {cartOpen && (
            <button type="button" onClick={() => setCartOpen(false)} className="h-12 border-b border-line font-semibold text-ink-2 lg:hidden">▼ 收起本单，继续点餐</button>
          )}
          <div className="min-h-0 flex-1">
            <CartPanel menu={menu} cart={cart} totals={totals} tokenNumber={token} editingLineId={editingLineId}
              onEdit={(id) => { const l = cart.lines.find((x) => x.lineId === id); if (l) { setEditingLineId(id); setDraft(l.config); setCartOpen(false); } }}
              onQuantity={changeQuantity} onPay={() => setPayOpen(true)} payDisabledReason={payDisabledReason}>
              <SubmitSteps stage={stage} kitchenAck={Boolean(lastOrder.data?.kitchenAckAtMs)} />
            </CartPanel>
          </div>
        </aside>
      </div>

      <div className="flex items-center gap-2 border-t border-line bg-card p-2 lg:hidden">
        <button type="button" onClick={() => setCartOpen(true)} aria-expanded={cartOpen} className="flex h-14 min-w-0 flex-1 items-center gap-2 rounded-xl border-2 border-control px-3 text-left">
          <span className="text-lg font-bold">本单 · {token ?? '—'}</span>
          <span className="text-ink-2">{totals.portionCount}份</span>
          {stage.kind === 'accepted' && totals.portionCount === 0 && <span className="truncate text-sm text-ok">✓ {stage.result.tokenNumber}号已接单</span>}
          <span className="ml-auto text-sm text-ink-2">查看 ▲</span>
        </button>
        <button type="button" onClick={() => setPayOpen(true)} disabled={Boolean(payDisabledReason)}
          className="h-14 shrink-0 rounded-xl bg-brand px-4 text-lg font-bold text-white disabled:bg-control">收款 {formatRM(totals.totalSen)}</button>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-card px-4 py-2 text-base">
        <Icon name="clock" size={20} />
        <span>厨房待做 <b>{queueQ.data.length}</b> 单</span>
        {Number.isFinite(oldest) && <QueueClock since={oldest} />}
        {undo && (
          <span className="ml-auto flex items-center gap-2 rounded-lg bg-subtle px-3 py-1">
            {undo.label}
            <button type="button" onClick={() => { setCart(undo.cart); setUndo(null); setEditingLineId(null); }} className="h-10 rounded-lg border border-control px-3 font-semibold">撤销</button>
          </span>
        )}
      </footer>

      {pickerOpen && <TokenPicker board={board} current={token} onPick={setToken} onRelease={releaseTokenCmd} onClose={() => setPickerOpen(false)} />}
      {payOpen && token !== null && (
        <PaymentDrawer dueSen={totals.totalSen} tokenNumber={token} portions={totals.portionCount} serviceMode={cart.serviceMode}
          qrPayee={config.qrPayee} online={online} busy={busy}
          onConfirm={(p) => void confirmPayment(p)} onClose={() => { setPayOpen(false); if (stage.kind === 'rejected') setStage({ kind: 'idle' }); }} />
      )}
      {payOpen && stage.kind === 'rejected' && (
        <div role="alert" className="fixed bottom-28 right-4 z-50 max-w-[440px] rounded-xl border-2 border-danger bg-danger-bg p-4 text-danger shadow-xl">
          <b>云端未接单：{stage.reason}</b>
          <p className="text-sm">这次没有生成订单。若已收钱，请勿再次收钱，修正后再提交。</p>
        </div>
      )}
    </div>
  );
}

function QueueClock({ since }: { since: number }) {
  const now = useNow();
  return <span>· 最久 <b>{formatClock(now - since)}</b></span>;
}

/** 三个事实分别有依据才点亮：本机已记录（IndexedDB 写入完成）、云端已接单（事务提交）、后厨已收到（KDS 回执）。 */
function SubmitSteps({ stage, kitchenAck }: { stage: Stage; kitchenAck: boolean }) {
  if (stage.kind === 'idle') return null;
  const local = stage.kind !== 'saving' && stage.kind !== 'local_failed';
  const cloud = stage.kind === 'accepted';
  const steps: { label: string; done: boolean; icon: 'register' | 'cloud' | 'cook' }[] = [
    { label: '本机已记录', done: local, icon: 'register' },
    { label: '云端已接单', done: cloud, icon: 'cloud' },
    { label: kitchenAck ? '后厨已收到' : '等待厨房确认', done: cloud && kitchenAck, icon: 'cook' },
  ];
  return (
    <div className="mt-3 rounded-xl bg-subtle p-3" aria-live="polite">
      <div className="flex items-center justify-between">
        {steps.map((s, i) => (
          <div key={s.label} className="flex flex-1 items-center">
            <div className={`flex flex-col items-center text-center text-sm ${s.done ? 'text-ok' : 'text-ink-2 opacity-60'}`}>
              <Icon name={s.icon} size={34} />
              <span className="font-semibold">{s.done ? '✓ ' : ''}{s.label}</span>
            </div>
            {i < 2 && <span className="mx-1 flex-1 text-center text-ink-2">→</span>}
          </div>
        ))}
      </div>
      {stage.kind === 'accepted' && (
        <p className="mt-2 text-center font-semibold">
          {stage.result.tokenNumber}号 · 票号 {stage.result.receiptNumber} · {formatRM(stage.result.totalSen)}
          {stage.result.changeSen !== null && stage.result.changeSen > 0 && <> · 找零 <span className="text-xl">{formatRM(stage.result.changeSen)}</span></>}
        </p>
      )}
      {stage.kind === 'submitting' && <p className="mt-2 text-center text-warn">正在提交，请勿重复收钱或重复点击。</p>}
      {stage.kind === 'unknown' && <p className="mt-2 text-center font-semibold text-warn">已记录收款，正在核对订单；请勿再次收钱。</p>}
      {stage.kind === 'local_failed' && <p className="mt-2 text-center font-semibold text-danger">本机保存失败，订单尚未确认（{stage.message}）。购物车已保留。</p>}
      {stage.kind === 'rejected' && <p className="mt-2 text-center font-semibold text-danger">云端未接单：{stage.reason}</p>}
    </div>
  );
}

/** 不是主收银机 / 未开班时的说明页。 */
function RegisterGate({ status, isOwner }: { status: string; isOwner: boolean }) {
  const reg = useRegister();
  const [floatText, setFloatText] = useState('100');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (status === 'loading') return <p className="p-6">正在检查收银机…</p>;
  if (status === 'not_configured' || status === 'not_this_device') {
    return (
      <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-line bg-card p-6">
        <Icon name="register" size={56} />
        <h2 className="mt-2 text-2xl font-bold">这台设备不是主收银机</h2>
        <p className="mt-2 text-ink-2">首版只允许一台指定收银设备接单。{isOwner ? '老板可以在「设备」页把这台设备设为主收银机。' : '请老板在这台设备上登录并指定。'}</p>
        {isOwner && <button type="button" onClick={() => navigate('/device')} className="mt-4 h-14 rounded-xl bg-brand px-6 text-lg font-bold text-white">去设备页</button>}
      </div>
    );
  }
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-line bg-card p-6">
      <Icon name="cash" size={56} />
      <h2 className="mt-2 text-2xl font-bold">开班</h2>
      <p className="mt-1 text-ink-2">点清钱箱里的备用金后开班。</p>
      <label className="mt-4 block font-semibold" htmlFor="float">备用金 (RM)</label>
      <input id="float" inputMode="decimal" value={floatText} onChange={(e) => setFloatText(e.target.value)} className="mt-1 h-14 w-full rounded-lg border border-control px-3 text-2xl tabular-nums" />
      {err && <p role="alert" className="mt-2 text-danger">{err}</p>}
      <button type="button" disabled={busy || parseRMInput(floatText) === null || !reg.claim}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await submit('openShift', { operationId: newOperationId(), ...reg.claim!, openingFloatSen: parseRMInput(floatText)! });
          } catch (e) {
            setErr(e instanceof CommandFailure ? reasonText(e.reasonCode) : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-4 h-14 w-full rounded-xl bg-brand text-lg font-bold text-white disabled:bg-control">{busy ? '正在开班…' : '确认开班'}</button>
    </div>
  );
}
