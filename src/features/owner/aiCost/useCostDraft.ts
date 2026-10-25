/**
 * 一份 AI 记成本草稿的界面状态：订阅服务端草稿，本地编辑带「基于哪个版本」，停手后自动保存，确认前先保存再按该版本入账。
 * - 别处改了同一份草稿：提示冲突，先载入最新或另存为新草稿，不做最后写入覆盖。
 * - 识别按 requestId 去重：结果不明时再点只会拿回原尝试；明确「再识别一次」才是新的请求。
 * - 当前草稿 ID 存在 localStorage（只是一个 ID），刷新后恢复；图片不进本地存储。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveDoc } from '../../../data/firebase/live';
import { storePath } from '../../../data/firebase/client';
import { CommandFailure, newOperationId } from '../../../data/firebase/commands';
import { analyzeDraft, commitDraft, CostPostingReceipt, createDraft, DraftChange, updateDraft, uploadReceiptImage } from '../../../data/firebase/aiCost';
import { EditedCostDraft, emptyEditedDraft, ExtractedCostDraft } from '../../../domain';
import { failureText } from '../finance/data';
import { sameDraft } from './model';

const KEY = 'hao.aiCost.currentDraft';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v: string | null) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* 隐私模式：只是不能恢复 */ } };

export interface Attachment { path: string; mime: string; bytes: number; sha256: string }
export interface DraftView {
  id: string;
  source: 'text' | 'receipt' | 'manual';
  status: 'created' | 'analyzing' | 'review' | 'failed' | 'committed' | 'discarded' | 'expired';
  revision: number;
  inputRevision: number;
  businessDate: string;
  input: { text: string | null; attachments: Attachment[] };
  extraction: ExtractedCostDraft | null;
  extractionMeta: { provider: string; model: string; atMs: number } | null;
  candidate: { attemptId: string; extraction: ExtractedCostDraft; provider: string; model: string; atMs: number } | null;
  edited: EditedCostDraft | null;
  warnings: string[];
  lastAttempt: { ok: boolean; reason: string | null; provider: string | null; primaryIssue: string | null; atMs: number } | null;
  receipt: CostPostingReceipt | null;
  updatedAtMs: number;
}

export type Phase = 'input' | 'analyzing' | 'review' | 'failed' | 'pending' | 'saved';

export function useCostDraft() {
  const [draftId, setDraftIdState] = useState<string | null>(read);
  const live = useLiveDoc<DraftView>(draftId ? storePath(`costDrafts/${draftId}`) : null);
  const d = live.data;
  const [local, setLocal] = useState<EditedCostDraft | null>(null);
  const [base, setBase] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<null | 'creating' | 'uploading' | 'analyzing' | 'saving' | 'committing'>(null);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<{ draftId: string; status: string }[]>([]);
  const [duplicate, setDuplicate] = useState<{ receiptId: string; businessDate: string; totalSen: number; supplier: string | null }[] | null>(null);
  const [receipt, setReceipt] = useState<CostPostingReceipt | null>(null);
  const saving = useRef(false);
  const editSeq = useRef(0);
  // 保存要串行：自动保存还在路上时点「确认保存」，先等它回来，再用新版本号继续，不能拿旧版本号再发一次。
  const inflight = useRef<Promise<number | null> | null>(null);
  const latest = useRef<{ local: EditedCostDraft | null; base: number; dirty: boolean }>({ local: null, base: 0, dirty: false });
  latest.current = { local, base, dirty };
  const requestIds = useRef(new Map<string, string>());
  const commitOp = useRef<{ key: string; id: string } | null>(null);

  const setDraftId = useCallback((id: string | null) => {
    write(id);
    setDraftIdState(id);
    setLocal(null); setBase(0); setDirty(false); setConflict(false); setError(null); setSimilar([]); setDuplicate(null); setReceipt(null);
  }, []);

  // 服务端版本 → 本地：没有未保存的修改就跟随；有修改且服务端被别处改过 → 冲突。
  // 读 latest 而不是本次渲染的 base / dirty：自己这次保存的快照可能先渲染、等保存返回后 effect 才执行，
  // 那时闭包里还是旧版本号和「有修改」，会把自己刚存的版本误判成别处修改（保存返回时已同步更新 latest）。
  useEffect(() => {
    if (!d) return;
    if (d.status === 'discarded' || d.status === 'expired') { setDraftId(null); return; }
    if (!d.edited) return;
    const cur = latest.current;
    if (!cur.dirty && !saving.current) {
      if (d.revision !== cur.base || !cur.local) { setLocal(d.edited); setBase(d.revision); }
    } else if (!saving.current && d.revision > cur.base) setConflict(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.revision, d?.status, d?.edited]);

  const edit = useCallback((next: EditedCostDraft) => {
    editSeq.current++;
    setLocal(next);
    setDirty(true);
  }, []);

  const save = useCallback(async (): Promise<number | null> => {
    if (inflight.current) await inflight.current;
    const cur = latest.current;
    if (!draftId || !cur.local || conflict) return null;
    if (!cur.dirty) return cur.base;
    const seq = editSeq.current;
    const body = cur.local;
    const run = (async () => {
      saving.current = true;
      try {
        const r = await updateDraft(draftId, latest.current.base, { edited: body });
        latest.current = { ...latest.current, base: r.revision, dirty: editSeq.current !== seq };
        setBase(r.revision);
        if (editSeq.current === seq) setDirty(false);
        return r.revision;
      } catch (e) {
        if (e instanceof CommandFailure && e.reasonCode === 'STALE_VERSION') setConflict(true);
        else setError(failureText(e));
        return null;
      } finally {
        saving.current = false;
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, [draftId, conflict]);

  // 停手 1.2 秒自动保存，刷新或换设备也能接着改。
  useEffect(() => {
    if (!dirty || conflict || busy) return;
    const t = setTimeout(() => { void save(); }, 1200);
    return () => clearTimeout(t);
  }, [local, dirty, conflict, busy, save]);

  async function analyze(id: string, inputRevision: number, fresh = false) {
    const key = `${id}#${inputRevision}`;
    let rid = requestIds.current.get(key);
    if (!rid || fresh) { rid = crypto.randomUUID(); requestIds.current.set(key, rid); }
    setBusy('analyzing');
    setError(null);
    try {
      const r = await analyzeDraft(id, inputRevision, rid);
      if (r.ok === false && r.reason && r.reason !== 'superseded') setError(null);
      return r;
    } catch (e) {
      // 结果不明：不自动重发，草稿订阅会显示最新状态；再点「重试」用同一个 requestId，不重复计费。
      setError(failureText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function startText(text: string) {
    setBusy('creating');
    setError(null);
    try {
      const c = await createDraft('text', text);
      setDraftId(c.draftId);
      await analyze(c.draftId, c.inputRevision);
    } catch (e) {
      setError(failureText(e));
      setBusy(null);
    }
  }

  async function startReceipt(files: File[], note: string) {
    setBusy('creating');
    setError(null);
    try {
      const c = await createDraft('receipt', note.trim() || undefined);
      setDraftId(c.draftId);
      setBusy('uploading');
      const paths: string[] = [];
      for (const f of files) paths.push(await uploadReceiptImage(c.uploadPrefix!, f));
      const r = await updateDraft(c.draftId, c.revision, { attachments: paths.map((path) => ({ path })) });
      const open = r.similarDrafts.filter((s) => !['committed', 'discarded', 'expired'].includes(s.status));
      setSimilar(r.similarDrafts);
      if (open.length) { setBusy(null); return; }
      await analyze(c.draftId, r.inputRevision);
    } catch (e) {
      setError(failureText(e));
      setBusy(null);
    }
  }

  async function startManual(seed?: EditedCostDraft) {
    setBusy('creating');
    setError(null);
    try {
      const c = await createDraft('manual');
      setDraftId(c.draftId);
      if (seed) {
        const r = await updateDraft(c.draftId, c.revision, { edited: seed });
        setLocal(seed); setBase(r.revision);
      }
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(null);
    }
  }

  async function change(ch: DraftChange) {
    if (!draftId || !d) return;
    setError(null);
    try {
      const r = await updateDraft(draftId, d.revision, ch);
      if ('applyCandidate' in ch) { setDirty(false); setLocal(null); }
      return r;
    } catch (e) {
      if (e instanceof CommandFailure && e.reasonCode === 'STALE_VERSION') setConflict(true);
      else setError(failureText(e));
      return null;
    }
  }

  /** 识别失败后手动填写：从空白草稿开始，原话 / 图片都保留在来源区。 */
  function fillManually() {
    if (!d) return;
    edit(emptyEditedDraft(d.businessDate));
    setBase(d.revision);
  }

  async function commit(ack?: { candidateId: string; reason: string }) {
    if (!draftId || !local) return;
    setBusy('saving');
    setError(null);
    setDuplicate(null);
    let rev = await save();
    // 保存途中又改了字段：再存一次，确认的一定是屏幕上的最终内容。
    for (let i = 0; i < 3 && rev !== null && latest.current.dirty; i++) rev = await save();
    if (rev === null || latest.current.dirty) { setBusy(null); return; }
    setBusy('committing');
    const key = `${draftId}#${rev}#${ack?.candidateId ?? ''}`;
    if (commitOp.current?.key !== key) commitOp.current = { key, id: newOperationId() };
    try {
      setReceipt(await commitDraft(draftId, rev, commitOp.current.id, ack));
    } catch (e) {
      if (e instanceof CommandFailure && e.reasonCode === 'DUPLICATE_RECEIPT') setDuplicate((e.details.candidates as typeof duplicate) ?? []);
      else if (e instanceof CommandFailure && e.reasonCode === 'STALE_VERSION') setConflict(true);
      else setError(failureText(e));
    } finally {
      setBusy(null);
    }
  }

  function reloadLatest() {
    if (!d?.edited) return;
    setLocal(d.edited); setBase(d.revision); setDirty(false); setConflict(false);
  }

  async function saveAsNew() {
    const mine = local;
    if (!mine) return;
    await startManual(mine);
  }

  const status = d?.status;
  const phase: Phase = !draftId || !d ? (busy === 'creating' || busy === 'uploading' ? 'analyzing' : 'input')
    : status === 'committed' ? 'saved'
    : busy === 'analyzing' || busy === 'uploading' || status === 'analyzing' ? (local ? 'review' : 'analyzing')
    : status === 'failed' && !local ? 'failed'
    : status === 'created' && !local ? 'pending'
    : 'review';

  return {
    draftId, draft: d, loading: live.loading, local, dirty, conflict, busy, error, similar, duplicate, receipt: receipt ?? d?.receipt ?? null, phase,
    setError, setDuplicate, edit, save, commit, startText, startReceipt, startManual, change, fillManually, reloadLatest, saveAsNew,
    analyze: (fresh = false) => (d && draftId ? analyze(draftId, d.inputRevision, fresh) : Promise.resolve(null)),
    reset: () => setDraftId(null),
    open: (id: string) => setDraftId(id),
  };
}

export type CostDraftState = ReturnType<typeof useCostDraft>;
