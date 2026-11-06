/**
 * 更新记录：列出最近的功能和改动（按岗位过滤）。新内容在页面上方提示（UpdateNotice），不弹窗、不挡点单和出餐。
 * 「查看」在当前页面上打开面板（UpdatesDialog），不离开页面：收银的购物车、后厨的新单提示音和回执都不受影响。
 * 「看到哪一条」按账号记在这台设备上；存储不可用时只在内存里记，宁可多提示。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { entriesFor, unseenEntries } from '../../domain/changelog';
import { useSession } from '../../app/session';
import { useLang, useT } from '../../app/i18n';
import { Icon } from '../../ui/visual';

const keyOf = (uid: string) => `updatesSeen:${uid}`;
const memory = new Map<string, string>();
const listeners = new Set<() => void>();
/** 这次打开 app 以来标「新」的条目：列表重新挂载也不丢，刷新后才清掉。 */
const freshIds = new Set<string>();

function readSeen(uid: string): string | null {
  const inMemory = memory.get(uid);
  if (inMemory) return inMemory;
  try {
    return localStorage.getItem(keyOf(uid));
  } catch {
    return null;
  }
}

function markSeen(uid: string, latest: string | undefined) {
  if (!latest) return;
  memory.set(uid, latest);
  try {
    localStorage.setItem(keyOf(uid), latest);
  } catch {
    // 只记在内存里，下次打开再提示。
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 当前账号能看到的更新，以及其中还没看过的。 */
export function useUnseenUpdates() {
  const { member, user } = useSession();
  const uid = user?.uid ?? null;
  const seen = useSyncExternalStore(subscribe, () => (uid ? readSeen(uid) : null));
  const list = member ? entriesFor(member.role) : [];
  return { uid, list, unseen: uid ? unseenEntries(list, seen) : [] };
}

/** 页面上方的新内容提示。className 由所在页面给配色（前台 / 后厨）。 */
export function UpdateNotice({ className, primaryClassName }: { className: string; primaryClassName: string }) {
  const { uid, list, unseen } = useUnseenUpdates();
  const [open, setOpen] = useState(false);
  const tr = useT();
  const lang = useLang();
  if (open) return <UpdatesDialog onClose={() => setOpen(false)} />;
  if (!uid || unseen.length === 0) return null;
  const title = lang === 'en' ? unseen[0].title.en : unseen[0].title.zh;
  return (
    <div role="status" className={`flex flex-wrap items-center gap-3 print:hidden ${className}`}>
      <Icon name="sparkle" size={24} />
      <span className="min-w-0 flex-1 basis-56">
        <b>{tr('有新更新：', 'New: ')}</b>{title}
        {unseen.length > 1 && <span className="ml-2 text-sm">{tr(`还有 ${unseen.length - 1} 条`, `+${unseen.length - 1} more`)}</span>}
      </span>
      <button type="button" onClick={() => setOpen(true)} className={`h-14 rounded-xl px-4 font-bold ${primaryClassName}`}>{tr('查看', 'View')}</button>
      <button type="button" onClick={() => markSeen(uid, list[0]?.id)} className="h-14 rounded-xl border border-current px-4 font-semibold">{tr('知道了', 'Got it')}</button>
    </div>
  );
}

/** 更新列表。打开时记下哪些是新的（标「新」），然后全部算看过。 */
function UpdatesList() {
  const { uid, list } = useUnseenUpdates();
  const tr = useT();
  const lang = useLang();
  const latest = list[0]?.id;
  useEffect(() => {
    if (!uid) return;
    for (const e of unseenEntries(list, readSeen(uid))) freshIds.add(e.id);
    markSeen(uid, latest);
    // list 每次渲染都是新数组；只看最新一条有没有变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, latest]);
  const text = (t: { zh: string; en: string }) => (lang === 'en' ? t.en : t.zh);
  return (
    <div className="space-y-3">
      {list.map((e) => (
        <article key={e.id} className="rounded-2xl border border-line bg-card p-4 text-ink">
          <div className="flex flex-wrap items-center gap-2">
            <time dateTime={e.date} className="text-sm tabular-nums text-ink-2">{e.date}</time>
            {freshIds.has(e.id) && <span className="rounded bg-brand-soft px-1.5 text-xs font-semibold text-brand">{tr('新', 'New')}</span>}
          </div>
          <h2 className="mt-1 text-lg font-bold">{text(e.title)}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {e.items.map((item) => <li key={item.zh}>{text(item)}</li>)}
          </ul>
        </article>
      ))}
    </div>
  );
}

export function UpdatesPage() {
  return <div className="mx-auto max-w-3xl p-4 md:p-6"><UpdatesList /></div>;
}

/** 在当前页面上打开的更新面板：背后的页面继续运行。 */
export function UpdatesDialog({ onClose }: { onClose: () => void }) {
  const tr = useT();
  return (
    <div role="dialog" aria-modal="true" aria-label={tr('更新记录', 'Updates')} onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="fixed inset-0 z-50 flex justify-end bg-[#1d2420]/45 print:hidden">
      <div className="flex h-full w-full max-w-[640px] flex-col bg-canvas text-ink shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line bg-card px-4 py-3">
          <Icon name="sparkle" size={28} />
          <h2 className="min-w-0 flex-1 text-xl font-bold">{tr('更新记录', 'Updates')}</h2>
          <button type="button" onClick={onClose} autoFocus className="flex h-14 items-center gap-1 rounded-xl border border-line px-4 font-semibold"><Icon name="close" size={20} />{tr('关闭', 'Close')}</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4"><UpdatesList /></div>
      </div>
    </div>
  );
}
