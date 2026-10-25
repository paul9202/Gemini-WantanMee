/** 一行明细：主字段只有名称、分类、金额；数量 / 单位 / 食材 / 付款 / 备注 / 不计入营业放在「补充资料」里。 */
import { useEffect, useId, useState } from 'react';
import { addMonths, CostDraftLine, CostPayment, DraftIssue, Ingredient, ingredientCategoryOf, isFoodCategory, parseRMInput } from '../../../domain';
import { Icon } from '../../../ui/visual';
import { inputCls } from '../finance/ui';
import { CATEGORY_GROUPS, categoryLabel, kindHint, senText } from './model';

export function AmountInput({ value, onChange, label, invalid, describedBy }: { value: number | null; onChange: (sen: number | null) => void; label: string; invalid?: boolean; describedBy?: string }) {
  const [text, setText] = useState(senText(value));
  useEffect(() => {
    if (parseRMInput(text) !== value) setText(senText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span className={`flex min-h-12 items-center rounded-xl border bg-[#fffefa] pl-3 ${invalid ? 'border-danger' : 'border-[#cfd4c5]'} focus-within:border-ok`}>
      <small className="text-xs text-ink-2">RM</small>
      <input inputMode="decimal" aria-label={label} aria-invalid={invalid || undefined} aria-describedby={describedBy} value={text} placeholder="0.00"
        onChange={(e) => { setText(e.target.value); onChange(e.target.value.trim() ? parseRMInput(e.target.value) : null); }}
        className="min-w-0 flex-1 bg-transparent px-2 text-right text-base font-semibold tabular-nums outline-none" />
    </span>
  );
}

export function LineEditor({ line, index, issues, ingredients, purchaseMonth, onChange, onRemove }: {
  line: CostDraftLine; index: number; issues: DraftIssue[]; ingredients: Ingredient[]; purchaseMonth: string; onChange: (l: CostDraftLine) => void; onRemove: () => void;
}) {
  const id = useId();
  const set = (patch: Partial<CostDraftLine>) => onChange({ ...line, ...patch });
  const err = (field: string) => issues.find((i) => i.field === field);
  const food = isFoodCategory(line.category);
  const ingCat = food ? ingredientCategoryOf(line.category as Exclude<CostDraftLine['category'], 'unknown'>) : null;
  const ingOptions = ingredients.filter((i) => i.category === ingCat);
  const monthOptions = [-2, -1, 0, 1].map((n) => addMonths(purchaseMonth, n));
  const extras = !line.includeInBusiness || line.payment !== 'inherit' || issues.some((i) => ['quantity', 'unit', 'excludeReason'].includes(i.field));
  return (
    <article className={`border-b border-line px-5 py-5 last:border-b-0 sm:px-6 ${line.includeInBusiness ? '' : 'bg-[#f7f5ef]'}`} aria-labelledby={`${id}-t`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1fr)_180px_140px_auto] md:items-end">
        <label className="block text-[13px] text-ink-2">
          <span id={`${id}-t`} className="mb-1 block">项目 {String(index + 1).padStart(2, '0')}{!line.includeInBusiness && <b className="ml-2 text-warn">不计入营业成本</b>}</span>
          <input value={line.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} aria-invalid={Boolean(err('name')) || undefined} placeholder="例如：葱"
            className={`${inputCls} ${err('name') ? '!border-danger' : ''}`} />
        </label>
        <div className="row-span-1 flex items-end md:order-last">
          <button type="button" onClick={onRemove} aria-label={`删除项目 ${index + 1}`} className="grid h-12 w-12 place-items-center rounded-xl text-ink-2 hover:bg-danger-bg hover:text-danger"><Icon name="trash" size={19} /></button>
        </div>
        <label className="col-span-2 block text-[13px] text-ink-2 md:col-span-1">
          <span className="mb-1 block">分类</span>
          <select value={line.category} onChange={(e) => set({ category: e.target.value as CostDraftLine['category'], ingredientId: null, periodMonth: null, workDays: null })}
            aria-invalid={Boolean(err('category')) || undefined} className={`${inputCls} ${err('category') ? '!border-danger' : ''}`}>
            <option value="unknown" disabled>请选择分类</option>
            {CATEGORY_GROUPS.map((g) => <optgroup key={g.label} label={g.label}>{g.items.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</optgroup>)}
          </select>
        </label>
        <label className="col-span-2 block text-[13px] text-ink-2 md:col-span-1">
          <span className="mb-1 block">金额</span>
          <AmountInput value={line.grossSen} onChange={(grossSen) => set({ grossSen })} label={`项目 ${index + 1} 金额`} invalid={Boolean(err('grossSen'))} />
        </label>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-2"><Icon name="check" size={14} />{kindHint(line.category)}</p>
      {(line.category === 'rent' || line.category === 'fridge_power') && (
        <label className="mt-3 block text-[13px] text-ink-2"><span className="mb-1 block">属于哪个月</span>
          <select value={line.periodMonth ?? ''} onChange={(e) => set({ periodMonth: e.target.value || null })} className={inputCls}>
            <option value="">请选择月份</option>{monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      {line.category === 'wage' && (
        <label className="mt-3 block text-[13px] text-ink-2"><span className="mb-1 block">出勤天数</span>
          <input type="number" min={1} max={31} value={line.workDays ?? ''} onChange={(e) => set({ workDays: e.target.value ? Number(e.target.value) : null })} className={inputCls} />
        </label>
      )}
      <details open={extras} className="group mt-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-ok">
          <Icon name="chevron-right" size={16} className="transition group-open:rotate-90" />
          {line.quantity !== null && line.unit ? `${line.quantity} ${line.unit} · 修改数量或备注` : '补充数量、单位或备注（可选）'}
        </summary>
        <div className="grid gap-3 pt-2 sm:grid-cols-2">
          <label className="block text-[13px] text-ink-2"><span className="mb-1 block">数量（不记得可以空着）</span>
            <input inputMode="decimal" value={line.quantity ?? ''} onChange={(e) => { const v = e.target.value.trim(); set({ quantity: v ? Number(v) : null }); }} className={inputCls} placeholder="例如 1.5" />
          </label>
          <label className="block text-[13px] text-ink-2"><span className="mb-1 block">单位</span>
            <input value={line.unit ?? ''} maxLength={10} onChange={(e) => set({ unit: e.target.value || null })} className={inputCls} placeholder="kg / 包 / 瓶" />
          </label>
          {food && (
            <label className="block text-[13px] text-ink-2 sm:col-span-2"><span className="mb-1 block">对应食材（有数量时会放入库存待启用，不会开封或结束旧批）</span>
              <select value={line.ingredientId ?? ''} onChange={(e) => set({ ingredientId: e.target.value || null })} className={inputCls}>
                <option value="">不指定（只记采购）</option>{ingOptions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
          )}
          <label className="block text-[13px] text-ink-2"><span className="mb-1 block">这一项的付款</span>
            <select value={line.payment} onChange={(e) => set({ payment: e.target.value as CostPayment | 'inherit' })} aria-invalid={Boolean(err('payment')) || undefined} className={inputCls}>
              <option value="inherit">跟随整单</option><option value="paid">已付</option><option value="unpaid">待付（赊账）</option><option value="unknown">还不确定</option>
            </select>
          </label>
          <label className="block text-[13px] text-ink-2"><span className="mb-1 block">备注</span>
            <input value={line.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} className={inputCls} />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={!line.includeInBusiness} onChange={(e) => set({ includeInBusiness: !e.target.checked, excludeReason: e.target.checked ? line.excludeReason : null })} className="h-4 w-4 accent-[#28644c]" />
            不计入营业成本（私人 / 家用物品；保留在收据凭证里，折扣按整张收据分摊）
          </label>
          {!line.includeInBusiness && (
            <label className="block text-[13px] text-ink-2 sm:col-span-2"><span className="mb-1 block">原因（必填）</span>
              <input value={line.excludeReason ?? ''} maxLength={200} onChange={(e) => set({ excludeReason: e.target.value })} aria-invalid={Boolean(err('excludeReason')) || undefined} className={inputCls} placeholder="例如：家里用的洗发水" />
            </label>
          )}
        </div>
      </details>
      {issues.length > 0 && <ul className="mt-2 space-y-0.5 text-xs text-danger">{issues.map((i) => <li key={i.code + i.field}>{i.message}</li>)}</ul>}
    </article>
  );
}
