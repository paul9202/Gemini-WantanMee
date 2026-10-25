/**
 * 收据照片：手机「拍照」与「相册」分开入口，电脑可拖放。上传前在本机预览（页序、旋转、删除、看大图）。
 * 旋转只改预览，不改原图；离开时撤销本地 objectURL。图片不写入 localStorage。
 */
import { DragEvent, useEffect, useRef, useState } from 'react';
import { checkReceiptFiles } from '../../../data/firebase/aiCost';
import { MAX_RECEIPT_IMAGES } from '../../../domain';
import { Icon } from '../../../ui/visual';
import { Btn, Dialog, inputCls } from '../finance/ui';

export interface Picked { id: string; file: File; url: string; rotate: number }

export function ReceiptUpload({ picked, setPicked, disabled }: { picked: Picked[]; setPicked: (p: Picked[]) => void; disabled?: boolean }) {
  const camera = useRef<HTMLInputElement>(null);
  const album = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [zoom, setZoom] = useState<Picked | null>(null);
  const [over, setOver] = useState(false);
  const latest = useRef(picked);
  latest.current = picked;
  useEffect(() => () => latest.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  function add(files: File[]) {
    const { ok, errors } = checkReceiptFiles(picked.length, files);
    setErrors(errors);
    setPicked([...picked, ...ok.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), rotate: 0 }))]);
  }
  const move = (i: number, d: number) => {
    const next = [...picked];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setPicked(next);
  };
  const remove = (p: Picked) => { URL.revokeObjectURL(p.url); setPicked(picked.filter((x) => x.id !== p.id)); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (!disabled) add([...e.dataTransfer.files]); };

  return (
    <div>
      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        className={`rounded-2xl border border-dashed p-4 ${over ? 'border-brand bg-brand-soft' : 'border-[#d6d9cc] bg-[#fbfaf5]'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Btn onClick={() => camera.current?.click()} disabled={disabled || picked.length >= MAX_RECEIPT_IMAGES} className="sm:hidden"><Icon name="camera" size={18} />拍照</Btn>
          <Btn onClick={() => album.current?.click()} disabled={disabled || picked.length >= MAX_RECEIPT_IMAGES}><Icon name="image" size={18} /><span className="sm:hidden">从相册选</span><span className="hidden sm:inline">选择收据图片</span></Btn>
          <small className="text-xs text-ink-2">JPEG / PNG / WebP，每张 ≤10 MB，一张收据最多 {MAX_RECEIPT_IMAGES} 张（长收据可分段拍）<span className="hidden sm:inline">；也可以把图片拖到这里</span>。没保存的草稿图片 30 天后自动清理，已入账的收据会保留。</small>
        </div>
        <input ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} aria-label="拍照收据" />
        <input ref={album} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} aria-label="选择收据图片" />
        {picked.length > 0 && (
          <ol className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {picked.map((p, i) => (
              <li key={p.id} className="overflow-hidden rounded-xl border border-line bg-card">
                <button type="button" onClick={() => setZoom(p)} className="block aspect-[3/4] w-full overflow-hidden bg-[#efece3]" aria-label={`查看第 ${i + 1} 页大图`}>
                  <img src={p.url} alt={`收据第 ${i + 1} 页`} className="h-full w-full object-contain transition" style={{ transform: `rotate(${p.rotate}deg)` }} />
                </button>
                <div className="flex items-center justify-between gap-1 px-1.5 py-1 text-xs">
                  <b className="px-1">第 {i + 1} 页</b>
                  <span className="flex">
                    <button type="button" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-subtle disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="往前移">‹</button>
                    <button type="button" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-subtle disabled:opacity-30" disabled={i === picked.length - 1} onClick={() => move(i, 1)} aria-label="往后移">›</button>
                    <button type="button" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-subtle" onClick={() => setPicked(picked.map((x) => (x.id === p.id ? { ...x, rotate: (x.rotate + 90) % 360 } : x)))} aria-label="旋转预览"><Icon name="refresh" size={15} /></button>
                    <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-danger hover:bg-danger-bg" onClick={() => remove(p)} aria-label={`删除第 ${i + 1} 页`}><Icon name="trash" size={15} /></button>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {errors.length > 0 && <ul role="alert" className="mt-2 space-y-1 text-sm text-danger">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {zoom && (
        <Dialog title="收据大图" sub="旋转只影响预览，原图不会被改动。" wide onClose={() => setZoom(null)} footer={<Btn onClick={() => setZoom(null)} className="w-full sm:w-auto">关闭</Btn>}>
          <img src={zoom.url} alt="收据大图" className="mx-auto max-h-[70dvh] object-contain" style={{ transform: `rotate(${zoom.rotate}deg)` }} />
        </Dialog>
      )}
    </div>
  );
}

export function NoteInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input aria-label="收据补充说明（可选）" placeholder="补充说明（可选），例如：这张已付现金" value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} className={`${inputCls} mt-3`} />;
}
