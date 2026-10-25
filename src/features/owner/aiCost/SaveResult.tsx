/** 记一笔 · 保存成功：金额、项目数与去向；没有数量的说明「用量可稍后补」，不显示假的库存数量。 */
import type { CostPostingReceipt } from '../../../data/firebase/aiCost';
import { Icon } from '../../../ui/visual';
import { Btn } from '../finance/ui';
import { Steps } from './DraftReview';
import { rm } from './model';

export function SaveResult({ receipt, onNext, onView }: { receipt: CostPostingReceipt; onNext: () => void; onView: () => void }) {
  const parts = [receipt.foodCount ? `${receipt.foodCount} 项食材采购` : '', receipt.dailyCount ? `${receipt.dailyCount} 项日常开支` : ''].filter(Boolean);
  return (
    <section className="mx-auto max-w-xl rounded-3xl border border-line bg-card p-6 text-center shadow-card sm:p-10" aria-live="polite">
      <div className="mb-6 flex justify-center"><Steps at={3} /></div>
      <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-ok-bg text-ok"><Icon name="check" size={32} /></span>
      <h2 className="text-2xl font-bold">这笔记好了</h2>
      <p className="mt-2 text-[34px] font-semibold tabular-nums text-ok">{rm(receipt.totalSen)}</p>
      <p className="mt-1 text-sm text-ink-2">{receipt.businessDate} · {parts.join(' / ') || '已入账'}{receipt.excludedCount ? ` · ${receipt.excludedCount} 项不计入营业（凭证已保留）` : ''}</p>
      {receipt.pendingUsageCount > 0 && <p className="mx-auto mt-4 max-w-sm rounded-xl bg-[#f7f3e8] px-4 py-3 text-[13px] text-[#786541]">采购已记账，{receipt.pendingUsageCount} 项用量可稍后补；补数量不会再记一次钱。</p>}
      {receipt.batchIds.length > 0 && <p className="mx-auto mt-2 max-w-sm text-xs text-ink-2">{receipt.batchIds.length} 项有明确数量，已放入库存待启用（没有开封，也没有结束旧批）。</p>}
      {receipt.alreadyCommitted && <p className="mt-2 text-xs text-ink-2">这份草稿之前已经保存过，这是原来的回执，没有重复记账。</p>}
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        <Btn tone="primary" onClick={onNext}><Icon name="plus" size={18} />继续记一笔</Btn>
        <Btn onClick={onView}>查看这笔记录 <Icon name="arrow" size={16} /></Btn>
      </div>
      <p className="mt-4 text-xs text-ink-2">已保存的账目不能直接删除；需要更正请在采购记录里作废后重新记录。</p>
    </section>
  );
}
