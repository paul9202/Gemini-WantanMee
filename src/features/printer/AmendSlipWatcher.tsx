/**
 * 后厨改单后补打（2026-11-16）：连着送餐单打印机的这台平板，不管停在哪一页（点餐、后厨、订单……）都看着厨单，
 * 发现改单就按订单现在的内容再打一张「改单 · 以这张为准」。
 * 原来只在点餐页里看：一台平板同时当收银和后厨时，在后厨页改单就没打（实机 2026-11-16）。
 * - 只在全店送餐单打印打开、这台设备连过打印机、登录的是老板或收银时才看。
 * - 只补打 10 分钟以内的改动；同一次改单只打一次（这次打开里记一下，页面重开后靠本机打印记录）。
 * - 订单已经又改了一次（厨单还没跟上）就不打这一张，等下一次。打印出任何问题都不影响别的功能。
 */
import { useEffect, useRef } from 'react';
import { collection, doc, getDoc, query, where } from 'firebase/firestore';
import { useSession } from '../../app/session';
import { db, storePath } from '../../data/firebase/client';
import { useLiveQuery } from '../../data/firebase/live';
import { menuForVersion, useMenu } from '../../data/menu';
import { printer, slipPrintingOn, usePrinter } from '../../data/printer/printer';
import type { MenuVersion } from '../../domain/menu';
import { amendSlipKey, amendSlipSource, AmendedOrderView, AmendedTicketView, buildRunnerSlip, printsAmendSlip } from '../../domain/runnerSlip';

export function AmendSlipWatcher() {
  const { user, member, config } = useSession();
  const slipOn = slipPrintingOn(config);
  const front = member?.role === 'owner' || member?.role === 'cashier';
  const s = usePrinter(Boolean(user) && slipOn && front);
  const active = Boolean(user) && slipOn && front && s.settings.enabled;
  const menu = useMenu(config?.activeMenuVersion);
  const tickets = useLiveQuery<Partial<AmendedTicketView>>(
    active ? query(collection(db, storePath('kitchenTickets')), where('kitchenRouting', '==', 'digital'), where('fulfillmentStatus', 'in', ['queued', 'preparing'])) : null,
    active ? 'amend-slip-watch' : 'amend-slip-watch-off',
  );
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!active || !config) return;
    const now = Date.now();
    for (const t of tickets.data) {
      if (!printsAmendSlip(t, now)) continue;
      const key = amendSlipKey(t.id, t.amendCount!);
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      void queueAmendSlip(t.id, t as AmendedTicketView, menu, config.timeZone);
    }
  }, [tickets.data, active, config, menu]);

  return null;
}

async function queueAmendSlip(orderId: string, t: AmendedTicketView, current: MenuVersion | undefined, timeZone: string) {
  try {
    const snap = await getDoc(doc(db, storePath(`orders/${orderId}`)));
    const o = snap.data() as (AmendedOrderView & { amendCount?: number; menuVersion: string }) | undefined;
    if (!o || (o.amendCount ?? 0) !== t.amendCount) return;
    const menu = current?.version === o.menuVersion ? current : (await menuForVersion(o.menuVersion)) ?? current;
    if (!menu) return;
    const n = t.amendCount;
    const slip = buildRunnerSlip(menu, amendSlipSource(o, t), { timeZone, printIndex: 0 });
    const label = `${o.receiptNumber ? `#${o.receiptNumber}` : `${o.tokenNumber} 号`} · ${t.amendUndo ? '撤回改单' : '改单'}${n > 1 ? ` ${n}` : ''}`;
    await printer.enqueue(amendSlipKey(orderId, n), slip, { label });
  } catch {
    // 打印不影响别的功能
  }
}
