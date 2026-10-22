/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  UtensilsCrossed,
  ChefHat,
  TrendingUp,
  Volume2,
  VolumeX,
  RotateCcw,
  Flame,
  Store,
  Clock,
  Sparkles,
  Globe,
} from 'lucide-react';
import { Order } from '../types';
import { Language, translations } from '../utils/i18n';

interface NavbarProps {
  activeView: 'pos' | 'kds' | 'analytics';
  onViewChange: (view: 'pos' | 'kds' | 'analytics') => void;
  pendingOrders: Order[];
  soundEnabled: boolean;
  onToggleSound: () => void;
  onResetDemo: () => void;
  onOpenFirebase: () => void;
  language: Language;
  onToggleLanguage: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeView,
  onViewChange,
  pendingOrders,
  soundEnabled,
  onToggleSound,
  onResetDemo,
  onOpenFirebase,
  language,
  onToggleLanguage,
}) => {
  const t = translations[language];
  const pendingCount = pendingOrders.length;
  // Check if any order waiting > 8 mins
  const hasUrgentOrder = pendingOrders.some((o) => Date.now() - o.createdAt > 8 * 60 * 1000);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-200/80 bg-white/90 backdrop-blur-md shadow-xs transition-colors">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-3 py-2 sm:px-6">
        {/* Brand / Stall Info */}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-tr from-rose-600 to-amber-500 text-white shadow-md shadow-rose-500/20">
            <Store className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black tracking-tight text-slate-900 sm:text-lg">
                {t.appName}
              </h1>
              <span className="hidden rounded-md bg-rose-100 px-1.5 py-0.5 text-[11px] font-extrabold text-rose-700 sm:inline-block">
                {t.brandTag}
              </span>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                {t.statusOpen}
              </span>
            </div>
            <p className="hidden text-[11px] text-slate-500 font-medium sm:block">
              {t.appSubtitle}
            </p>
          </div>
        </div>

        {/* 3 Main View Switchers - Touch Ergonomics */}
        <nav className="flex items-center gap-1.5 rounded-2xl bg-slate-100/90 p-1.5 border border-slate-200/80 shadow-inner">
          {/* POS View */}
          <button
            onClick={() => onViewChange('pos')}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs sm:text-sm font-bold transition-all active:scale-95 ${
              activeView === 'pos'
                ? 'bg-white text-rose-700 shadow-md ring-2 ring-rose-500/30'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <UtensilsCrossed className="h-4 w-4 text-rose-600" />
            <span>{t.navPos}</span>
          </button>

          {/* KDS View */}
          <button
            onClick={() => onViewChange('kds')}
            className={`relative flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs sm:text-sm font-bold transition-all active:scale-95 ${
              activeView === 'kds'
                ? 'bg-slate-900 text-white shadow-md ring-2 ring-slate-700'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <ChefHat className={`h-4 w-4 ${activeView === 'kds' ? 'text-amber-400' : 'text-slate-600'}`} />
            <span>{t.navKds}</span>
            {pendingCount > 0 && (
              <span
                className={`ml-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-black text-white tabular-nums ${
                  hasUrgentOrder ? 'bg-rose-600 animate-pulse' : 'bg-amber-500'
                }`}
              >
                {pendingCount}
              </span>
            )}
          </button>

          {/* Admin Analytics View */}
          <button
            onClick={() => onViewChange('analytics')}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs sm:text-sm font-bold transition-all active:scale-95 ${
              activeView === 'analytics'
                ? 'bg-indigo-600 text-white shadow-md ring-2 ring-indigo-500/30'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <TrendingUp className="h-4 w-4" />
            <span className="hidden sm:inline">{t.navAnalytics}</span>
            <span className="sm:hidden">{t.navAnalyticsShort}</span>
          </button>
        </nav>

        {/* Right Tools (Language, Sound, Firebase, Demo Reset) */}
        <div className="flex items-center gap-2">
          {/* Bilingual Toggle Button (中文 / EN) */}
          <button
            onClick={onToggleLanguage}
            title={language === 'zh' ? 'Switch to English' : '切换至中文界面'}
            className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 transition active:scale-95 shadow-2xs"
          >
            <Globe className="h-4 w-4 text-rose-600" />
            <span className="font-extrabold uppercase">{language === 'zh' ? 'EN' : '中文'}</span>
          </button>

          {/* Audio Chime Toggle */}
          <button
            onClick={onToggleSound}
            title={soundEnabled ? t.soundOnTitle : t.soundOffTitle}
            className={`rounded-xl p-2.5 transition active:scale-90 border ${
              soundEnabled
                ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                : 'bg-slate-100 text-slate-400 border-slate-200 hover:bg-slate-200'
            }`}
          >
            {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </button>

          {/* Firebase Modal Button */}
          <button
            onClick={onOpenFirebase}
            title="Firebase 云端数据库配置"
            className="hidden sm:flex items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-xs font-bold text-amber-800 hover:bg-amber-100 transition active:scale-95"
          >
            <Flame className="h-3.5 w-3.5 text-amber-600" />
            <span className="text-[11px]">{t.cloudConfig}</span>
          </button>

          {/* Reset Demo Data Button */}
          <button
            onClick={onResetDemo}
            title={t.resetDemo}
            className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-2 sm:px-2.5 sm:py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition active:scale-95"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden md:inline text-[11px]">{t.resetDemo}</span>
          </button>
        </div>
      </div>
    </header>
  );
};

