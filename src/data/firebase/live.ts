/**
 * 受 Rules 限制的只读实时订阅。返回数据同时带「是否来自缓存」，
 * 界面据此提示「画面可能过期」，不把缓存当成服务器确认。
 */
import { useEffect, useState } from 'react';
import { doc, DocumentData, onSnapshot, Query } from 'firebase/firestore';
import { db } from './client';

export interface Live<T> {
  data: T;
  loading: boolean;
  fromCache: boolean;
  error: string | null;
}

export function useLiveDoc<T = DocumentData>(path: string | null): Live<(T & { id: string }) | null> {
  const [state, setState] = useState<Live<(T & { id: string }) | null>>({ data: null, loading: Boolean(path), fromCache: true, error: null });
  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, fromCache: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      doc(db, path),
      { includeMetadataChanges: true },
      (snap) => setState({ data: snap.exists() ? ({ id: snap.id, ...(snap.data() as T) }) : null, loading: false, fromCache: snap.metadata.fromCache, error: null }),
      (err) => {
        console.warn(`订阅失败 ${path}: ${err.code}`);
        setState({ data: null, loading: false, fromCache: true, error: err.code });
      },
    );
  }, [path]);
  return state;
}

export function useLiveQuery<T = DocumentData>(q: Query | null, key: string): Live<(T & { id: string })[]> & { pendingIds: Set<string> } {
  const [state, setState] = useState<Live<(T & { id: string })[]> & { pendingIds: Set<string> }>({ data: [], loading: Boolean(q), fromCache: true, error: null, pendingIds: new Set() });
  useEffect(() => {
    if (!q) return;
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) =>
        setState({
          data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) })),
          loading: false,
          fromCache: snap.metadata.fromCache,
          error: null,
          pendingIds: new Set(snap.docs.filter((d) => d.metadata.fromCache).map((d) => d.id)),
        }),
      (err) => {
        console.warn(`订阅失败 ${key}: ${err.code}`);
        setState((s) => ({ ...s, loading: false, error: err.code }));
      },
    );
    // key 代表查询条件；Query 对象每次渲染都是新的，不能直接做依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
