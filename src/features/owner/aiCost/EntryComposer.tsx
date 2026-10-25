/** 记一笔 · 输入：一句话或收据照片。示例只填进输入框，不直接记账；也可以手动记一笔。 */
import { useState } from 'react';
import { formatRM, MAX_DRAFT_TEXT } from '../../../domain';
import { Icon } from '../../../ui/visual';
import { Btn, Note, Panel, Tag } from '../finance/ui';
import { NoteInput, Picked, ReceiptUpload } from './ReceiptUpload';
import type { CostDraftState } from './useCostDraft';

const EXAMPLES = ['今天买了葱10块、肉碎32块、煤气35块，都付了', '肉碎32块先欠着，月底结', '买了面薄45块，付款晚点确认'];

export function EntryComposer({ s, aiEnabled, todaySummary, onEnableAi }: {
  s: CostDraftState; aiEnabled: boolean | null; todaySummary: { count: number; totalSen: number; pendingUsage: number }; onEnableAi: () => void;
}) {
  const [mode, setMode] = useState<'text' | 'receipt'>('text');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [note, setNote] = useState('');
  const busy = s.busy !== null;
  const over = text.length > MAX_DRAFT_TEXT;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label="录入方式" className="flex gap-1 rounded-xl bg-subtle p-1">
            {([['text', '说一句', 'edit'], ['receipt', '拍照 / 上传收据', 'camera']] as const).map(([k, label, icon]) => (
              <button key={k} role="tab" type="button" aria-selected={mode === k} onClick={() => setMode(k)}
                className={`flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold ${mode === k ? 'bg-card text-brand shadow-card' : 'text-ink-2'}`}><Icon name={icon} size={17} />{label}</button>
            ))}
          </div>
          <Tag tone="green">整理后可修改</Tag>
        </div>
        {aiEnabled === false && (
          <div className="mb-3"><Note><b>AI 整理尚未开启。</b> 可以先手动记一笔；开启后才会调用 Claude（备用 DeepSeek）。<button type="button" className="ml-1 font-semibold underline" onClick={onEnableAi}>开启 AI 整理</button></Note></div>
        )}
        {mode === 'text' ? (
          <>
            <label className="block">
              <span className="sr-only">用一句话记成本</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} disabled={busy}
                placeholder="例如：今天买了葱10块、肉碎32块、煤气35块，都付了。"
                className="block w-full resize-y rounded-2xl border border-[#cfd4c5] bg-[#fbfaf5] p-4 text-base leading-relaxed focus:border-ok" />
            </label>
            <p className={`mt-2 flex items-center gap-1.5 text-xs ${over ? 'text-danger' : 'text-ink-2'}`}><Icon name="info" size={14} />{over ? `超过 ${MAX_DRAFT_TEXT} 字，请分开记录` : '默认令吉 RM · 数量不记得也能先记账 · 付款没说清楚会请你确认'}</p>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => <button key={ex} type="button" onClick={() => setText(ex)} className="min-h-11 rounded-full border border-line bg-[#f5f3ec] px-3 text-left text-[13px]">{ex.length > 14 ? `${ex.slice(0, 14)}…` : ex}</button>)}
              </div>
              <Btn tone="primary" disabled={busy || !text.trim() || over || aiEnabled !== true} onClick={() => void s.startText(text.trim())}><Icon name="sparkle" size={18} />{busy ? '正在整理…' : '帮我整理'}</Btn>
            </div>
          </>
        ) : (
          <>
            <ReceiptUpload picked={picked} setPicked={setPicked} disabled={busy} />
            <NoteInput value={note} onChange={setNote} />
            <div className="mt-4 flex justify-end">
              <Btn tone="primary" disabled={busy || !picked.length || aiEnabled !== true} onClick={() => void s.startReceipt(picked.map((p) => p.file), note)}>
                <Icon name="sparkle" size={18} />{s.busy === 'uploading' ? '正在上传…' : busy ? '正在识别…' : '识别这张收据'}
              </Btn>
            </div>
          </>
        )}
        {s.error && <p role="alert" className="mt-3 rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">{s.error}</p>}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-sm">
          <span className="text-ink-2">想直接填写？也可以。</span>
          <Btn small tone="ghost" disabled={busy} onClick={() => void s.startManual()}>手动记一笔 <Icon name="arrow" size={16} /></Btn>
        </div>
      </Panel>

      <aside className="grid content-start gap-5">
        <section className="rounded-2xl border border-[#dce4d5] bg-[#edf2e9] p-5">
          <div className="text-[11px] tracking-[0.16em] text-ink-2">TODAY'S PURCHASES / 今日采购</div>
          <div className="my-3 text-[34px] font-semibold tabular-nums text-ok"><span className="mr-1 text-sm">RM</span>{formatRM(todaySummary.totalSen).replace('RM', '')}</div>
          <div className="flex gap-8 border-t border-[#d4dccb] pt-3 text-sm">
            <span><b className="block text-lg">{todaySummary.count} 笔</b><small className="text-xs text-ink-2">已登记采购 / 支出</small></span>
            <span><b className="block text-lg">{todaySummary.pendingUsage} 项</b><small className="text-xs text-ink-2">用量资料可稍后补</small></span>
          </div>
        </section>
        <Panel title="简单记，也能记得清楚" sub="你的账，始终由你确认。">
          {[['camera', '拍清楚，就少打字', '一张收据可以拆成多个项目与分类。'], ['edit', '每个结果，都可以改', '名称、金额、分类，核对后再保存。'], ['leaf', '先记采购，后补用量', '没有数量也能记录真实支出，不会伪造库存。']].map(([icon, t, p]) => (
            <div key={t} className="flex gap-3 py-2.5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-subtle text-ok"><Icon name={icon as 'camera'} size={19} /></span>
              <div><b className="text-sm">{t}</b><p className="mt-0.5 text-xs text-ink-2">{p}</p></div>
            </div>
          ))}
        </Panel>
      </aside>
    </div>
  );
}
