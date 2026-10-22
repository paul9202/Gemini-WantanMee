/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Database, Check, Copy, Flame, ExternalLink, ShieldAlert } from 'lucide-react';

interface FirebaseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FirebaseModal: React.FC<FirebaseModalProps> = ({ isOpen, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'config' | 'code' | 'rules'>('config');

  const [projectId, setProjectId] = useState(localStorage.getItem('fb_project_id') || 'pontian-wanton-mee-pos');
  const [apiKey, setApiKey] = useState(localStorage.getItem('fb_api_key') || 'AIzaSyDemoKeyMockForHawkerPOS12345');
  const [isSaved, setIsSaved] = useState(false);

  if (!isOpen) return null;

  const handleSave = () => {
    localStorage.setItem('fb_project_id', projectId);
    localStorage.setItem('fb_api_key', apiKey);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  const firestoreCodeSnippet = `// src/firebase.ts - Google Firebase Free Tier Ready
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "${apiKey}",
  authDomain: "${projectId}.firebaseapp.com",
  projectId: "${projectId}",
  storageBucket: "${projectId}.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// 1. Real-time Kitchen Display Stream
export function subscribePendingOrders(callback: (orders: any[]) => void) {
  const q = collection(db, 'orders');
  return onSnapshot(q, (snapshot) => {
    const orders = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(orders);
  });
}

// 2. Add New Order from POS
export async function createOrder(orderData: any) {
  return await addDoc(collection(db, 'orders'), {
    ...orderData,
    createdAt: serverTimestamp()
  });
}

// 3. Complete Order on Chef KDS
export async function completeOrder(orderId: string) {
  const orderRef = doc(db, 'orders', orderId);
  return await updateDoc(orderRef, {
    status: 'completed',
    completedAt: serverTimestamp()
  });
}`;

  const rulesSnippet = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Hawker POS & Chef KDS Free Tier Simple Rules
    match /orders/{orderId} {
      allow read, write: if true; // Open within stall local LAN/tablets
    }
    match /expenses/{expenseId} {
      allow read, write: if true;
    }
    match /wastage/{wastageId} {
      allow read, write: if true;
    }
  }
}`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="relative w-full max-w-3xl rounded-3xl bg-slate-900 border border-slate-700 shadow-2xl text-slate-100 max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 p-6 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
              <Flame className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold flex items-center gap-2">
                Firebase Firestore 实时云端同步
                <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  永久免费配额可用
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                支持平板与头手手机多端实时同步（断网自动使用本地 LocalStorage 离线模式）
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab Controls */}
        <div className="flex border-b border-slate-800 bg-slate-950/30 px-6 pt-3 gap-2">
          <button
            onClick={() => setActiveTab('config')}
            className={`px-4 py-2.5 text-xs font-bold rounded-t-xl transition ${
              activeTab === 'config'
                ? 'bg-slate-800 text-amber-400 border-t-2 border-amber-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            1. 填入凭据 (Config)
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`px-4 py-2.5 text-xs font-bold rounded-t-xl transition ${
              activeTab === 'code'
                ? 'bg-slate-800 text-amber-400 border-t-2 border-amber-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            2. SDK 代码集成 (`onSnapshot`, `addDoc`)
          </button>
          <button
            onClick={() => setActiveTab('rules')}
            className={`px-4 py-2.5 text-xs font-bold rounded-t-xl transition ${
              activeTab === 'rules'
                ? 'bg-slate-800 text-amber-400 border-t-2 border-amber-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            3. 安全规则 (firestore.rules)
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {activeTab === 'config' && (
            <div className="space-y-4">
              <div className="rounded-xl bg-slate-800/60 p-4 border border-slate-700/60 text-xs text-slate-300 space-y-2">
                <div className="flex items-center gap-2 font-bold text-amber-400">
                  <Database className="h-4 w-4" />
                  当前模式：本地 LocalStorage + 模拟实时引擎
                </div>
                <p>
                  系统当前预装了真实的笨珍云吞面数据并保存在当前浏览器中，您在此处填入 Google Firebase Console 的专属 Project ID 与 Web API Key 即可一键升级为跨设备局域网/公网云端实时多终端。
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Firebase Project ID (项目标识):
                  </label>
                  <input
                    type="text"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-xs text-amber-300 focus:outline-hidden focus:border-amber-400"
                    placeholder="e.g. pontian-wanton-mee-1234"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Web API Key (网页密钥):
                  </label>
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-xs text-amber-300 focus:outline-hidden focus:border-amber-400 font-mono"
                    placeholder="AIzaSy..."
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={handleSave}
                  className="flex items-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-5 py-2.5 text-xs shadow-lg transition active:scale-95"
                >
                  {isSaved ? <Check className="h-4 w-4" /> : <Database className="h-4 w-4" />}
                  {isSaved ? '已保存至本地配置！' : '保存云端凭据配置'}
                </button>

                <a
                  href="https://console.firebase.google.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-amber-400 underline"
                >
                  打开 Firebase Console 创建免费项目 <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {activeTab === 'code' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400 font-mono">
                  使用 Firestore onSnapshot 监听头手 KDS 厨房出餐队列
                </span>
                <button
                  onClick={() => copyToClipboard(firestoreCodeSnippet)}
                  className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制代码' : '复制代码'}
                </button>
              </div>
              <pre className="rounded-xl bg-slate-950 p-4 font-mono text-[11px] text-emerald-400 overflow-x-auto border border-slate-800 leading-relaxed">
                {firestoreCodeSnippet}
              </pre>
            </div>
          )}

          {activeTab === 'rules' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400 font-mono">
                  档口轻量免密安全规则 (适用于局域网或固定档口平板)
                </span>
                <button
                  onClick={() => copyToClipboard(rulesSnippet)}
                  className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white transition"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制代码' : '复制代码'}
                </button>
              </div>
              <pre className="rounded-xl bg-slate-950 p-4 font-mono text-[11px] text-amber-400 overflow-x-auto border border-slate-800 leading-relaxed">
                {rulesSnippet}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 bg-slate-950/80 p-4 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-xl bg-slate-800 px-5 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-700 hover:text-white transition"
          >
            完成并关闭
          </button>
        </div>
      </div>
    </div>
  );
};
