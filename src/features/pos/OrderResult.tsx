/**
 * 下单结果：三个事实分别有依据才点亮——本机已记录（IndexedDB 事务完成）、云端已接单（服务器事务提交）、
 * 后厨已收到（KDS 回执）。断网接单只点亮第一步，后厨一步改为人工传单。绝不在下单后立即全部打勾。
 * 收款是独立的第四件事：默认待收款，可立即确认或之后在「待登记收款」补登记；下单成功不等于已付。
 */
import { ReactNode } from 'react';
import { AckState, ackState } from '../../domain/kitchenLink';
import { OrderServiceMode, SERVICE_MODE_NAMES } from '../../domain/menu';
import { formatRM, Sen } from '../../domain/money';
import { useNow } from '../../data/firebase/live';
import { Icon } from '../../ui/visual';
import type { IconName } from '../../ui/iconSymbols';
import { useT } from '../../app/i18n';

export interface ResultSummary {
  serviceMode: OrderServiceMode;
  firstItem: string;
}

export type ResultStage =
  | { kind: 'accepted'; orderId: string; receiptNumber: string; tokenNumber: number; totalSen: Sen; acceptedAtMs: number; summary: ResultSummary }
  | { kind: 'local_accepted'; clientOrderId: string; offlineReceiptNumber: string; tokenNumber: number; totalSen: Sen; summary: ResultSummary };

interface Facts {
  ack: AckState | null;
  steps: { label: string; done: boolean; icon: IconName; warn?: boolean }[];
}

function useFacts(stage: ResultStage, kitchenAckAtMs: number | null, kitchenLastSeenMs: number | null, offsetMs: number, handedOff: boolean): Facts {
  const now = useNow(1000);
  const tr = useT();
  if (stage.kind === 'local_accepted') {
    return {
      ack: null,
      steps: [
        { label: tr('本机已接单', 'Saved here'), done: true, icon: 'register' },
        { label: tr('云端未同步（断网）', 'Not synced (offline)'), done: false, icon: 'cloud', warn: true },
        { label: handedOff ? tr('已人工交接', 'Handed over') : tr('请人工传单', 'Hand ticket over'), done: handedOff, icon: 'handoff', warn: !handedOff },
      ],
    };
  }
  const ack = ackState({ acceptedAtMs: stage.acceptedAtMs, kitchenAckAtMs, nowServerMs: now + offsetMs, kitchenLastSeenMs });
  return {
    ack,
    steps: [
      { label: tr('本机已记录', 'Saved here'), done: true, icon: 'register' },
      { label: tr('云端已接单', 'Accepted online'), done: true, icon: 'cloud' },
      {
        label: ack === 'acked' ? tr('后厨已收到', 'Kitchen got it') : ack === 'alarm' ? tr('后厨屏可能离线', 'Kitchen may be offline') : ack === 'waiting' ? tr('等待厨房确认', 'Waiting for kitchen') : tr('正在送到后厨', 'Sending to kitchen'),
        done: ack === 'acked', icon: 'cook', warn: ack === 'waiting' || ack === 'alarm',
      },
    ],
  };
}

interface Props {
  stage: ResultStage;
  kitchenAckAtMs: number | null;
  kitchenLastSeenMs: number | null;
  offsetMs: number;
  handedOff: boolean;
  onlineHandoffAtMs: number | null;
  onHandoff: () => void;
  onOnlineHandoff: () => void;
  onReceipt: () => void;
  /** 订单是否已登记收款（云端订单或本机收款事件）。 */
  paid: boolean;
}

function Steps({ steps, offline }: { steps: Facts['steps']; offline: boolean }) {
  return (
    <ol className="flex flex-wrap items-center justify-center gap-2" aria-label="接单进度">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2">
          <span className={`flex min-h-14 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold ${s.done ? 'border-ok/30 bg-ok-bg text-ok' : s.warn ? 'border-warn/40 bg-warn-bg text-warn' : 'border-line bg-canvas text-ink-2'}`}>
            <Icon name={s.icon} size={28} />
            <span>{s.done ? '✓ ' : s.warn ? '! ' : ''}{s.label}</span>
          </span>
          {i < steps.length - 1 && <span aria-hidden className={offline && i === 0 ? 'text-warn' : 'text-ink-2'}>{offline && i === 0 ? '✕' : <Icon name="arrow" size={18} />}</span>}
        </li>
      ))}
    </ol>
  );
}

function Alerts({ stage, facts, handedOff, onlineHandoffAtMs, onHandoff, onOnlineHandoff }: Props & { facts: Facts }) {
  const tr = useT();
  const offline = stage.kind === 'local_accepted';
  return (
    <>
      {facts.ack === 'alarm' && (
        <div role="alert" className="mt-4 rounded-xl border-2 border-danger bg-danger-bg p-3 text-center text-danger">
          <b>{tr('已超过 15 秒没有后厨回执，后厨屏可能离线。请把纸单递给厨师。', 'No kitchen receipt after 15 s — the kitchen screen may be offline. Hand the paper ticket to the cook.')}</b>
          {onlineHandoffAtMs
            ? <p className="mt-1 font-semibold">✓ {tr('已登记人工传单；后厨屏恢复后会看到提示，避免做两份。', 'Hand-over recorded; the kitchen screen will show it to avoid cooking twice.')}</p>
            : <button type="button" onClick={onOnlineHandoff} className="mt-2 inline-flex h-12 items-center gap-2 rounded-xl bg-danger px-4 font-bold text-white"><Icon name="handoff" size={26} />{tr('我已递纸单给厨师', 'I gave the ticket to the cook')}</button>}
        </div>
      )}
      {offline && (
        <div className="mt-4 rounded-xl border border-warn/40 bg-warn-bg p-3 text-center text-warn">
          <p className="text-sm font-semibold">{tr('已保存在本机；后厨屏不会收到。请把纸单递给厨师。', 'Saved on this device; the kitchen screen will not get it. Hand the ticket to the cook.')}</p>
          {!handedOff && (
            <button type="button" onClick={onHandoff} className="mt-2 inline-flex h-12 items-center gap-2 rounded-xl bg-warn px-4 font-bold text-white">
              <Icon name="handoff" size={26} />{tr('我已把单交给厨师', 'I handed it to the cook')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** 下单完成后的弹窗（餐牌大字、三个独立事实、人工交接入口、独立的收款区）。 */
export function OrderResultDialog(props: Props & { onClose: () => void; extra?: ReactNode }) {
  const { stage, onClose, onReceipt } = props;
  const tr = useT();
  const facts = useFacts(stage, props.kitchenAckAtMs, props.kitchenLastSeenMs, props.offsetMs, props.handedOff);
  const offline = stage.kind === 'local_accepted';
  const title = offline ? tr('订单已保存在本机 · 请人工传单', 'Order saved on this device · hand the ticket over')
    : facts.ack === 'acked' ? tr('订单已保存，后厨已收到', 'Order saved — the kitchen has it')
    : facts.ack === 'alarm' ? tr('订单已保存，后厨还没确认', 'Order saved — kitchen has not confirmed')
    : tr('订单已保存，正在送到后厨', 'Order saved — sending to the kitchen');
  const s = stage.summary;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1d2420]/55 p-4" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="max-h-[94dvh] w-full max-w-[720px] overflow-y-auto overscroll-contain rounded-3xl bg-card px-6 py-6 text-center shadow-2xl sm:px-10 [@media(min-height:700px)]:py-8">
        <span className={`mx-auto flex h-20 w-20 items-center justify-center rounded-full ${offline || facts.ack === 'alarm' ? 'bg-warn-bg text-warn' : 'bg-ok-bg text-ok'}`}>
          <Icon name={offline ? 'handoff' : 'check'} size={offline ? 44 : 38} />
        </span>
        <h2 className="mt-4 text-2xl font-bold sm:text-[28px]" aria-live="polite">{title}</h2>
        <p className="mt-1 text-ink-2">
          {tr(SERVICE_MODE_NAMES[s.serviceMode].zh, SERVICE_MODE_NAMES[s.serviceMode].en)} · {formatRM(stage.totalSen)} · {props.paid ? tr('已收款', 'Paid') : tr('待收款', 'Unpaid')}
        </p>
        <div className="mt-5 text-7xl font-black tabular-nums text-ok">{stage.tokenNumber}</div>
        <p className="mt-1 font-semibold">{tr('把这张餐牌交给客人', 'Give this token to the customer')}</p>
        <p className="text-xs text-ink-2">
          {stage.kind === 'accepted' ? tr(`${stage.tokenNumber}号 · 票号 ${stage.receiptNumber}`, `No. ${stage.tokenNumber} · receipt ${stage.receiptNumber}`) : tr(`${stage.tokenNumber}号 · 临时号 ${stage.offlineReceiptNumber}`, `No. ${stage.tokenNumber} · temp ${stage.offlineReceiptNumber}`)}
        </p>
        <div className="mt-6"><Steps steps={facts.steps} offline={offline} /></div>
        <Alerts {...props} facts={facts} />
        {props.extra}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button type="button" onClick={onReceipt} className="h-14 rounded-xl border border-line px-6 font-bold">{tr('收据', 'Receipt')}</button>
          <button type="button" onClick={onClose} autoFocus className="flex h-14 items-center gap-2 rounded-xl bg-ok px-7 font-bold text-white">{tr('下一单', 'Next order')}<Icon name="arrow" size={20} /></button>
        </div>
      </div>
    </div>
  );
}

/** 第一栏底部「刚刚送到后厨」：弹窗关闭后继续显示真实进度，可重新打开。 */
export function RecentOrder(props: Props & { onOpen: () => void }) {
  const { stage, onOpen } = props;
  const tr = useT();
  const facts = useFacts(stage, props.kitchenAckAtMs, props.kitchenLastSeenMs, props.offsetMs, props.handedOff);
  const last = facts.steps[2];
  return (
    <section className="mt-6 border-t border-line pt-4" aria-label={tr('刚刚送出的订单', 'Last order')}>
      <h3 className="mb-2 text-sm text-ink-2">{stage.kind === 'local_accepted' ? tr('刚刚本机接单', 'Just saved here') : tr('刚刚送到后厨', 'Just sent to the kitchen')}</h3>
      <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-1 py-2 text-left hover:bg-subtle">
        <b className="text-xl tabular-nums">{stage.tokenNumber}</b>
        <span className="min-w-0 flex-1 truncate text-sm">{stage.summary.firstItem}</span>
        <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold ${last.done ? 'bg-ok-bg text-ok' : last.warn ? 'bg-warn-bg text-warn' : 'bg-subtle text-ink-2'}`}>
          {last.done ? <Icon name="check" size={16} /> : null}{last.label}
        </span>
      </button>
      {(facts.ack === 'alarm' || (stage.kind === 'local_accepted' && !props.handedOff)) && <Alerts {...props} facts={facts} />}
    </section>
  );
}
