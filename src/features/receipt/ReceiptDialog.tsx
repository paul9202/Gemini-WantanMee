/**
 * 收据（02 §6、O13）：58/80mm 预览与系统打印。
 * - 打印调用系统对话框；浏览器不能保证热敏机自动切纸/直连，打印失败不影响已保存的订单。
 * - 第一次之后的打印都标「副本」（本机记录次数），不是新交易。
 */
import { ReactNode, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { doc, getDoc } from 'firebase/firestore';
import { LineConfig, unitPriceSen } from '../../domain/lineItem';
import { MENU_V1, MenuVersion } from '../../domain/menu';
import { useMenu } from '../../data/menu';
import { buildReceipt, ReceiptSource } from '../../domain/receipt';
import { db, storePath } from '../../data/firebase/client';
import { kvGet, kvSet, LocalOrder } from '../../data/local/idb';
import { Icon } from '../../ui/visual';

type Width = 58 | 80;

const CONFIG_KEYS = ['productKind', 'size', 'noodleType', 'sauce', 'spice', 'lard', 'scallion', 'isKosong', 'addOns', 'note'] as const;

/** 从云端订单文档（收银可读，无成本）组装收据数据。 */
export async function receiptFromOrder(orderId: string, storeName: string): Promise<ReceiptSource> {
  const snap = await getDoc(doc(db, storePath(`orders/${orderId}`)));
  const o = snap.data();
  if (!o) throw new Error('找不到这张订单');
  return {
    storeName, receiptNumber: o.receiptNumber, offlineReceiptNumber: o.offlineReceiptNumber ?? null, tokenNumber: o.tokenNumber,
    serviceMode: o.serviceMode, source: o.source, acceptedAtMs: o.acceptedAtEffectiveMs, timeQuality: o.timeQuality,
    fulfillmentStatus: o.fulfillmentStatus, servedAtMs: o.servedAtMs ?? null, paymentState: o.paymentState,
    lines: (o.items as Record<string, unknown>[]).map((i) => ({
      config: Object.fromEntries(CONFIG_KEYS.map((k) => [k, i[k]])) as unknown as LineConfig,
      quantity: i.quantity as number, unitPriceSen: i.unitPriceSen as number,
    })),
    totalSen: o.totalSen, paymentMethod: o.paymentMethod ?? null, tenderedSen: o.cashTenderedSen ?? null, changeSen: o.changeSen ?? null, synced: true,
  };
}

/** 本机离线单（补同步前也能打印，标明尚未同步）。 */
/** menu 须为该离线单成交时的菜单版本（单价按它计算）。 */
export function receiptFromLocal(o: LocalOrder, menu: MenuVersion, storeName: string, sync: { synced: boolean; receiptNumber: string | null; served: boolean; paid: boolean }): ReceiptSource {
  return {
    storeName, receiptNumber: sync.receiptNumber, offlineReceiptNumber: o.offlineReceiptNumber, tokenNumber: o.tokenNumber,
    serviceMode: o.serviceMode, source: 'offline', acceptedAtMs: o.createdAtMs, timeQuality: 'device_estimated',
    // 人工出餐时间只在本机日志里，不在收据上编造具体时刻。
    // 新格式离线单下单未付款；只有本机确有收款确认事件（或旧格式下单即收款）才标已收款。
    fulfillmentStatus: sync.served ? 'served' : 'queued', servedAtMs: null, paymentState: sync.paid ? 'paid' : 'unpaid',
    lines: o.lines.map((l) => ({ config: l.config, quantity: l.quantity, unitPriceSen: priceOf(menu, l.config) })),
    totalSen: o.totalSen, paymentMethod: o.payment?.method ?? (sync.paid ? 'unspecified' : null), tenderedSen: o.payment?.tenderedSen ?? null, changeSen: o.changeSen, synced: sync.synced,
  };
}

const priceOf = (menu: MenuVersion, c: LineConfig) => unitPriceSen(menu, c);

export function ReceiptDialog({ receiptKey, load, menuVersion, timeZone, onClose }: {
  /** 用于记录打印次数的稳定 ID（订单 UUID）。 */
  receiptKey: string;
  load: () => Promise<ReceiptSource>;
  menuVersion: string;
  timeZone: string;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<ReceiptSource | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [width, setWidth] = useState<Width>(80);
  const [printCount, setPrintCount] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    load().then(setSrc).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    void kvGet<number>(`printCount:${receiptKey}`).then((n) => setPrintCount(n ?? 0));
    void kvGet<Width>('receiptWidth').then((w) => w && setWidth(w));
    // load 每次渲染都是新函数；只按收据 ID 加载一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptKey]);

  const menu = useMenu(menuVersion) ?? MENU_V1;
  const receipt = src ? buildReceipt(menu, src, { printIndex: printCount, timeZone }) : null;

  function print() {
    setMsg(null);
    try {
      window.print();
      const n = printCount + 1;
      setPrintCount(n);
      void kvSet(`printCount:${receiptKey}`, n);
    } catch {
      setMsg('打印没有成功。订单已经保存，可以稍后重印。');
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="收据" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      {receipt && <PrintPortal width={width}><ReceiptPaper receipt={receipt} width={width} /></PrintPortal>}
      <div className="flex max-h-full w-full max-w-md flex-col rounded-2xl bg-card p-4 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-xl font-bold">收据</h2>
          <div className="ml-auto flex rounded-lg bg-subtle p-1" role="group" aria-label="纸宽">
            {([58, 80] as Width[]).map((w) => (
              <button key={w} type="button" aria-pressed={width === w} onClick={() => { setWidth(w); void kvSet('receiptWidth', w); }}
                className={`h-12 rounded-md px-4 font-semibold ${width === w ? 'bg-card shadow' : 'text-ink-2'}`}>{w}mm</button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-subtle p-3">
          {err && <p role="alert" className="text-danger">{err}</p>}
          {!receipt && !err && <p className="text-ink-2">正在载入…</p>}
          {receipt && <ReceiptPaper receipt={receipt} width={width} />}
        </div>
        {msg && <p role="alert" className="mt-2 text-warn">{msg}</p>}
        <p className="mt-2 text-xs text-ink-2">使用系统打印对话框；热敏机能否自动切纸取决于打印机设置。已打印 {printCount} 次{printCount > 0 ? '，再次打印将标「副本」' : ''}。</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onClose} className="h-14 flex-1 rounded-xl border border-control font-semibold" autoFocus>关闭</button>
          <button type="button" disabled={!receipt} onClick={print} className="flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-brand font-bold text-white disabled:bg-control">
            <Icon name="list" size={22} />{printCount > 0 ? '打印副本' : '打印'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReceiptPaper({ receipt, width }: { receipt: ReturnType<typeof buildReceipt>; width: Width }) {
  return (
    <div className="print-receipt mx-auto bg-white p-2 font-mono text-black" style={{ width: `${width}mm`, fontSize: width === 58 ? 11 : 13, boxSizing: 'border-box' }}>
      <div className="text-center text-base font-bold">{receipt.title}</div>
      {receipt.copyLabel && <div className="my-1 border border-black text-center font-bold">{receipt.copyLabel}</div>}
      {receipt.badges.map((b) => <div key={b} className="my-1 border border-dashed border-black text-center">{b}</div>)}
      <div className="my-1 border-t border-dashed border-black" />
      {receipt.rows.map((r, i) => (
        <div key={i} className={`flex justify-between gap-2 ${r.strong ? 'font-bold' : ''} ${r.small ? 'text-[0.85em]' : ''} ${r.left === '合计' ? 'mt-1 border-t border-dashed border-black pt-1' : ''}`}>
          <span className="whitespace-pre-wrap">{r.left}</span>{r.right && <span className="shrink-0 text-right">{r.right}</span>}
        </div>
      ))}
      <div className="mt-2 text-center text-[0.85em]">谢谢光临</div>
    </div>
  );
}

/**
 * 打印专用节点：挂在 body 下，打印时只有它参与排版。
 * 纸高按收据实际高度设置，避免热敏纸吐出整页空白。
 */
function PrintPortal({ width, children }: { width: Width; children: ReactNode }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [heightMm, setHeightMm] = useState(120);
  useEffect(() => {
    let el = document.getElementById('print-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'print-root';
      document.body.appendChild(el);
    }
    setRoot(el);
  }, []);
  useLayoutEffect(() => {
    // 屏幕上 #print-root 隐藏，量不到高度；用预览同尺寸估算：1px = 25.4/96 mm。
    const preview = document.querySelector('[aria-label="收据"] .print-receipt') as HTMLElement | null;
    if (preview) setHeightMm(Math.ceil((preview.offsetHeight * 25.4) / 96) + 4);
  });
  if (!root) return null;
  return createPortal(
    <div>
      <style>{`@media print { @page { size: ${width}mm ${heightMm}mm; margin: 0; } }`}</style>
      {children}
    </div>,
    root,
  );
}
