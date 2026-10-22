/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Flame,
  Clock,
  RotateCcw,
  CheckCircle2,
  AlertOctagon,
  ShoppingBag,
  Utensils,
  Tag,
  Timer,
  Zap,
  X,
} from 'lucide-react';
import { Order, SAUCE_MAP, SpicinessLevel } from '../types';
import {
  calculateKitchenBatchSummary,
  calculateFulfillmentStats,
  calculateSingleOrderDuration,
} from '../utils/calculations';
import { soundFX } from '../utils/audio';
import { Language, translations } from '../utils/i18n';

interface KdsViewProps {
  orders: Order[];
  onCompleteOrder: (orderId: string) => void;
  onUndoLastCompleted: () => void;
  lastCompletedOrder: Order | null;
  soundEnabled: boolean;
  language: Language;
}

export const KdsView: React.FC<KdsViewProps> = ({
  orders,
  onCompleteOrder,
  onUndoLastCompleted,
  lastCompletedOrder,
  soundEnabled,
  language,
}) => {
  const t = translations[language];
  // Live ticker to update elapsed minutes/seconds every second
  const [, setTick] = useState(0);
  const [showCompletedModal, setShowCompletedModal] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Filter pending orders sorted oldest first
  const pendingOrders = useMemo(() => {
    return orders
      .filter((o) => o.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [orders]);

  // Completed orders sorted by most recent completion
  const completedOrders = useMemo(() => {
    return orders
      .filter((o) => o.status === 'completed' && typeof o.completedAt === 'number')
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  }, [orders]);

  // Batching Assistant Calculations
  const batchSummary = useMemo(() => {
    return calculateKitchenBatchSummary(orders);
  }, [orders]);

  // Kitchen Speed & Fulfillment Timing Algorithm
  const fulfillmentStats = useMemo(() => {
    return calculateFulfillmentStats(orders);
  }, [orders]);

  // Format Elapsed Time
  const getElapsedString = (createdAt: number) => {
    const diffSec = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    return {
      text: `${mins}分${secs < 10 ? '0' + secs : secs}秒`,
      isUrgent: mins >= 8,
      mins,
    };
  };

  const handleComplete = (orderId: string) => {
    if (soundEnabled) {
      soundFX.playOrderCompleted();
    }
    onCompleteOrder(orderId);
  };

  const handleUndo = () => {
    if (soundEnabled) {
      soundFX.playTap();
    }
    onUndoLastCompleted();
  };

  // Spiciness Badge in KDS
  const renderSpicinessBadge = (spiciness: SpicinessLevel) => {
    switch (spiciness) {
      case 'none':
        return (
          <span className="rounded-xl bg-emerald-950/90 border-2 border-emerald-500 px-3 py-1 text-xs font-black text-emerald-300">
            {language === 'zh' ? '🟢 不辣 (No Spicy)' : '🟢 Non-Spicy'}
          </span>
        );
      case 'less':
        return (
          <span className="rounded-xl bg-amber-950/90 border-2 border-amber-500 px-3 py-1 text-xs font-black text-amber-300">
            {language === 'zh' ? '🟡 少辣 (Less Spicy)' : '🟡 Mild Spicy'}
          </span>
        );
      case 'normal':
        return (
          <span className="rounded-xl bg-orange-950/90 border-2 border-orange-500 px-3 py-1 text-xs font-black text-orange-300">
            {language === 'zh' ? '🟠 普通辣 (Normal)' : '🟠 Regular Spicy'}
          </span>
        );
      case 'extra':
        return (
          <span className="rounded-xl bg-rose-600 border-2 border-rose-400 px-3 py-1 text-xs font-black text-white animate-pulse">
            {language === 'zh' ? '🔴 加辣 (Extra Spicy 🔥)' : '🔴 Extra Spicy 🔥'}
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-16 antialiased selection:bg-amber-400 selection:text-slate-950">
      {/* ======================================================== */}
      {/* TOP STICKY SUMMARY BAR: Batching Assistant (合单抓面助手) */}
      {/* ======================================================== */}
      <div className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur-md shadow-2xl px-3 py-3 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            {/* Title & Live Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40">
                  <Flame className="h-6 w-6 animate-pulse" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-black tracking-wide text-white">
                      {t.batchAssistantTitle}
                    </h2>
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-bold text-amber-400 border border-slate-700 tabular-nums">
                      {pendingOrders.length} {t.pendingOrdersCount}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    {t.batchSubtitle}
                  </p>
                </div>
              </div>

              {/* Undo Last Completed (Wet-hand Safety Button) */}
              {lastCompletedOrder && (
                <button
                  type="button"
                  onClick={handleUndo}
                  className="flex items-center gap-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-2 text-xs font-bold text-amber-300 transition active:scale-95 shadow-md"
                >
                  <RotateCcw className="h-4 w-4" />
                  <span>{t.undoLastOrder} ({lastCompletedOrder.orderNumber})</span>
                </button>
              )}
            </div>

            {/* TWO GIANT GLOWING BATCH COUNTERS (Readable from 1.5m away) */}
            <div className="flex items-center gap-3">
              {/* Counter 1: Total Noodle Balls */}
              <div className="flex-1 min-w-[150px] rounded-2xl bg-gradient-to-br from-amber-500/20 to-amber-950/40 border-2 border-amber-500/60 p-2.5 sm:px-4 shadow-lg shadow-amber-500/10">
                <span className="text-[10px] font-black uppercase tracking-wider text-amber-300 block">
                  {t.totalNoodleBallsToBoil}
                </span>
                <div className="flex items-baseline gap-1 mt-0.5">
                  <span className="text-3xl sm:text-4xl font-black text-amber-400 tabular-nums tracking-tight">
                    {batchSummary.totalNoodleBalls}
                  </span>
                  <span className="text-xs font-bold text-amber-200">{language === 'zh' ? '粒面' : 'balls'}</span>
                </div>
              </div>

              {/* Counter 2: Total Wantons (Strictly excludes Kosong) */}
              <div className="flex-1 min-w-[150px] rounded-2xl bg-gradient-to-br from-sky-500/20 to-sky-950/40 border-2 border-sky-500/60 p-2.5 sm:px-4 shadow-lg shadow-sky-500/10">
                <span className="text-[10px] font-black uppercase tracking-wider text-sky-300 block">
                  {t.totalWantonsToBoil}
                </span>
                <div className="flex items-baseline gap-1 mt-0.5">
                  <span className="text-3xl sm:text-4xl font-black text-sky-400 tabular-nums tracking-tight">
                    {batchSummary.totalWantons}
                  </span>
                  <span className="text-xs font-bold text-sky-200">{language === 'zh' ? '粒云吞' : 'wantons'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Sauce Distribution Strip */}
          <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400 text-[11px] font-semibold">口味汇总:</span>
            <span className="rounded bg-neutral-900 border border-neutral-700 px-2 py-0.5 text-white font-bold tabular-nums">
              黑酱: {batchSummary.sauceBreakdown.black}碗
            </span>
            <span className="rounded bg-rose-950/80 border border-rose-600 px-2 py-0.5 text-rose-300 font-bold tabular-nums">
              红酱: {batchSummary.sauceBreakdown.red}碗
            </span>
            <span className="rounded bg-amber-950/80 border border-amber-500 px-2 py-0.5 text-amber-200 font-bold tabular-nums">
              白酱: {batchSummary.sauceBreakdown.white}碗
            </span>
            <span className="rounded bg-sky-950/80 border border-sky-500 px-2 py-0.5 text-sky-300 font-bold tabular-nums">
              面汤: {batchSummary.sauceBreakdown.soup}碗
            </span>
            {batchSummary.kosongBowlCount > 0 && (
              <span className="rounded bg-amber-400 text-slate-950 font-black px-2 py-0.5 tabular-nums">
                ⚡ 净面 Kosong: {batchSummary.kosongBowlCount}碗
              </span>
            )}

            {/* Order Fulfillment Speed KPI */}
            <div className="ml-auto flex items-center gap-2">
              <span className="rounded-lg bg-indigo-950/80 border border-indigo-500/60 px-2.5 py-1 text-indigo-300 font-bold flex items-center gap-1.5 text-xs">
                <Timer className="h-3.5 w-3.5 text-indigo-400" />
                <span>均速 {fulfillmentStats.averageDurationFormatted}</span>
                <span className="text-slate-400 text-[10px]">· 达标率 {fulfillmentStats.onTimeRate}%</span>
              </span>

              {completedOrders.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowCompletedModal(true)}
                  className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 text-xs font-bold text-amber-300 transition active:scale-95 flex items-center gap-1"
                >
                  <Zap className="h-3.5 w-3.5 text-amber-400" />
                  <span>已出餐用时 ({completedOrders.length}单)</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ======================================================== */}
      {/* ORDER CARDS STREAM (High-Contrast Anti-Glare Bento Grid) */}
      {/* ======================================================== */}
      <div className="mx-auto max-w-7xl p-3 sm:p-6">
        {pendingOrders.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border-2 border-dashed border-slate-800 bg-slate-900/40 p-16 text-center">
            <CheckCircle2 className="h-16 w-16 text-emerald-500 mb-4 stroke-1" />
            <h3 className="text-xl font-bold text-white">所有待做订单已完成出餐！</h3>
            <p className="text-sm text-slate-400 mt-1 max-w-md">
              当前暂无待煮面条。新点单送达时，系统将发出清晰提示铃声并即时显示在屏幕上方。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {pendingOrders.map((order, orderIndex) => {
              const dur = calculateSingleOrderDuration(order);
              const isUrgent = dur.speedRating === 'slow' || dur.speedRating === 'overdue';

              return (
                <div
                  key={order.id}
                  className={`flex flex-col justify-between rounded-3xl border-2 transition-all shadow-xl ${
                    dur.speedRating === 'overdue'
                      ? 'border-rose-500 bg-gradient-to-b from-slate-900 via-rose-950/30 to-slate-900 ring-4 ring-rose-500/30'
                      : dur.speedRating === 'slow'
                      ? 'border-amber-500 bg-gradient-to-b from-slate-900 via-amber-950/20 to-slate-900 ring-2 ring-amber-500/20'
                      : orderIndex === 0
                      ? 'border-amber-400 bg-slate-900 ring-2 ring-amber-400/30'
                      : 'border-slate-800 bg-slate-900/90 hover:border-slate-700'
                  }`}
                >
                  {/* CARD HEADER: 按餐牌送餐 / 打包号 */}
                  <div className="border-b border-slate-800 p-4 bg-slate-950/60 rounded-t-3xl">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 text-xl font-black text-white tracking-wide">
                          {order.orderType === 'dine_in' ? (
                            <>
                              <Tag className="h-5 w-5 text-rose-500" />
                              <span>{order.orderNumber}</span>
                            </>
                          ) : (
                            <>
                              <ShoppingBag className="h-5 w-5 text-amber-500" />
                              <span>{order.orderNumber}</span>
                            </>
                          )}
                        </span>

                        {order.orderType === 'takeaway' && (
                          <span className="rounded-lg bg-rose-600/30 border border-rose-500 px-2 py-0.5 text-xs font-black text-rose-300">
                            免汤 (No Soup)
                          </span>
                        )}
                      </div>

                      {/* Live Timer Badge with Speed Rating */}
                      <div
                        className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-black tabular-nums border ${
                          dur.speedRating === 'overdue'
                            ? 'bg-rose-600 text-white border-rose-400 animate-pulse shadow-lg shadow-rose-600/40'
                            : dur.speedRating === 'slow'
                            ? 'bg-amber-600 text-white border-amber-400'
                            : dur.speedRating === 'lightning'
                            ? 'bg-emerald-950 text-emerald-300 border-emerald-500/80'
                            : 'bg-slate-800 text-slate-300 border-slate-700'
                        }`}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <span>已用时 {dur.durationFormatted}</span>
                      </div>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                      <span>本单共 {order.items.length} 碗餐品</span>
                      <span className="tabular-nums font-bold text-amber-400">
                        {order.noodleBallsTotal} 粒面 · {order.wantonCountTotal} 粒云吞
                      </span>
                    </div>
                  </div>

                  {/* CARD BODY: ITEMS LIST WITH STEAM-PROOF VISIBILITY */}
                  <div className="p-4 space-y-4 flex-1">
                    {order.items.map((item, idx) => {
                      const sauce = item.sauce ? SAUCE_MAP[item.sauce] : null;

                      return (
                        <div
                          key={idx}
                          className="rounded-2xl bg-slate-950/80 p-3.5 border border-slate-800 space-y-2.5"
                        >
                          {/* Item Title & Oversized Typography */}
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-2xl font-black text-white tabular-nums">
                                  {item.quantity} ×
                                </span>
                                <span className="text-xl font-black text-slate-100">
                                  {item.name}
                                </span>
                              </div>

                              {/* Size Details */}
                              {item.size && (
                                <p className="text-xs font-bold text-slate-400 mt-0.5">
                                  {item.size === 'small'
                                    ? '小碗 (1粒面)'
                                    : item.size === 'medium'
                                    ? '中碗 (1.5粒面)'
                                    : '大碗 (2粒面)'}
                                </p>
                              )}
                            </div>

                            {/* Huge Sauce Badge */}
                            {sauce && (
                              <div
                                className={`rounded-xl px-3 py-1.5 text-sm font-black border-2 shadow-sm ${sauce.badgeClass}`}
                              >
                                {sauce.chinese}
                              </div>
                            )}
                          </div>

                          {/* KOSONG RULE: High-visibility cyber-yellow banner */}
                          {item.isKosong && (
                            <div className="rounded-xl bg-gradient-to-r from-amber-400 to-amber-300 px-3 py-2 text-slate-950 font-black text-sm flex items-center gap-2 animate-pulse shadow-md">
                              <AlertOctagon className="h-5 w-5 stroke-[2.5]" />
                              <span>【⚡ KOSONG 净面 · 无叉烧 · 严禁放云吞！】</span>
                            </div>
                          )}

                          {/* Spiciness & Customizations Callouts (CRITICAL CHEF CHECKS) */}
                          <div className="flex flex-wrap gap-2 pt-1 items-center">
                            {/* Soup dishes (云吞汤 / 云吞汤面) have NO spicy and NO lard customization */}
                            {item.type === 'soup' || item.sauce === 'soup' ? (
                              <span className="rounded-xl bg-sky-950/90 border-2 border-sky-500 px-3 py-1 text-xs font-black text-sky-300">
                                🥣 {language === 'zh' ? '原汁骨汤 (Clear Soup Broth)' : 'Clear Soup Broth'}
                              </span>
                            ) : (
                              <>
                                {/* Spiciness Level - Mandatory Big Callout */}
                                {renderSpicinessBadge(item.modifiers.spiciness)}

                                {/* 猪油渣定制 */}
                                {item.modifiers.lard === 'extra' && (
                                  <span className="rounded-xl bg-amber-500/20 border border-amber-400 px-2.5 py-1 text-xs font-black text-amber-300">
                                    🥓 {language === 'zh' ? '加多猪油渣' : 'Extra Lard'}
                                  </span>
                                )}
                                {item.modifiers.lard === 'none' && (
                                  <span className="rounded-xl bg-rose-950 border border-rose-500 px-2.5 py-1 text-xs font-black text-rose-300">
                                    🚫 {language === 'zh' ? '不要猪油渣' : 'No Lard'}
                                  </span>
                                )}
                              </>
                            )}

                            {/* 葱花定制 */}
                            {item.modifiers.scallion === 'extra' && (
                              <span className="rounded-xl bg-emerald-950 border border-emerald-500 px-2.5 py-1 text-xs font-black text-emerald-300">
                                🌱 多葱花
                              </span>
                            )}
                            {item.modifiers.scallion === 'none' && (
                              <span className="rounded-xl bg-rose-950 border border-rose-500 px-2.5 py-1 text-xs font-black text-rose-300">
                                🚫 走青 (不要葱)
                              </span>
                            )}

                            {/* Paid Add-ons */}
                            {item.modifiers.extraCharSiew && (
                              <span className="rounded-xl bg-amber-500/20 border border-amber-400/80 px-2.5 py-1 text-xs font-black text-amber-300">
                                🥩 +加叉烧
                              </span>
                            )}
                            {item.modifiers.extraWanton && (
                              <span className="rounded-xl bg-sky-500/20 border border-sky-400/80 px-2.5 py-1 text-xs font-black text-sky-300">
                                🥟 +加云吞3粒
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* CARD FOOTER: 64px Tall Ergonomic Tap-to-Complete Button */}
                  <div className="p-4 pt-1">
                    <button
                      type="button"
                      onClick={() => handleComplete(order.id)}
                      className="w-full h-16 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-black text-base shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-3 transition-all active:scale-95 border border-emerald-400/40"
                    >
                      <CheckCircle2 className="h-6 w-6 stroke-[2.5]" />
                      <span>✅ 完成出餐 (Tap to Complete)</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* COMPLETED ORDERS TIMING MODAL (出餐用时履历)             */}
      {/* ======================================================== */}
      {showCompletedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-800 p-5 bg-slate-950/80">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40">
                  <Timer className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black text-white">
                    厨房今日已出餐用时清单 (Fulfillment Log)
                  </h3>
                  <p className="text-xs text-slate-400">
                    共 {completedOrders.length} 单 · 平均用时: {fulfillmentStats.averageDurationFormatted} · 8分钟达标率: {fulfillmentStats.onTimeRate}%
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowCompletedModal(false)}
                className="rounded-xl bg-slate-800 p-2 text-slate-400 hover:text-white hover:bg-slate-700 transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Quick KPI Row */}
            <div className="grid grid-cols-3 border-b border-slate-800 bg-slate-950/40 p-3 text-center text-xs">
              <div className="border-r border-slate-800">
                <span className="text-slate-400 block text-[11px]">平均出餐用时</span>
                <span className="text-base font-black text-amber-400 tabular-nums">
                  {fulfillmentStats.averageDurationFormatted}
                </span>
              </div>
              <div className="border-r border-slate-800">
                <span className="text-slate-400 block text-[11px]">最快出餐纪录</span>
                <span className="text-base font-black text-emerald-400 tabular-nums">
                  {fulfillmentStats.fastestOrder ? fulfillmentStats.fastestOrder.durationFormatted : '-'}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block text-[11px]">堂食 / 打包 均速</span>
                <span className="text-xs font-bold text-slate-300">
                  {fulfillmentStats.dineInAvgMinutes}分 / {fulfillmentStats.takeawayAvgMinutes}分
                </span>
              </div>
            </div>

            {/* Orders List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {completedOrders.length === 0 ? (
                <div className="py-12 text-center text-slate-500 text-sm">
                  暂无已出餐记录
                </div>
              ) : (
                completedOrders.map((ord) => {
                  const dur = calculateSingleOrderDuration(ord);
                  return (
                    <div
                      key={ord.id}
                      className="rounded-2xl bg-slate-950/70 border border-slate-800/90 p-3.5 flex items-center justify-between hover:border-slate-700 transition"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-white text-sm">
                            {ord.orderNumber}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              ord.orderType === 'dine_in'
                                ? 'bg-rose-950/80 text-rose-300 border border-rose-800'
                                : 'bg-amber-950/80 text-amber-300 border border-amber-800'
                            }`}
                          >
                            {ord.orderType === 'dine_in' ? '🍽️ 堂食' : '🛍️ 打包'}
                          </span>
                        </div>

                        <div className="text-xs text-slate-400">
                          {ord.items.map((it, idx) => (
                            <span key={idx} className="mr-2">
                              {it.quantity}x {it.name}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="text-right space-y-0.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="text-xs text-slate-400">用时:</span>
                          <span
                            className={`font-black text-base tabular-nums ${
                              dur.speedRating === 'lightning'
                                ? 'text-emerald-400'
                                : dur.speedRating === 'normal'
                                ? 'text-sky-400'
                                : dur.speedRating === 'slow'
                                ? 'text-amber-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {dur.durationFormatted}
                          </span>
                        </div>
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold ${
                            dur.speedRating === 'lightning'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : dur.speedRating === 'normal'
                              ? 'bg-sky-950 text-sky-300 border border-sky-800'
                              : dur.speedRating === 'slow'
                              ? 'bg-amber-950 text-amber-300 border border-amber-800'
                              : 'bg-rose-950 text-rose-300 border border-rose-800'
                          }`}
                        >
                          {dur.ratingLabel}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-950/80 text-right">
              <button
                type="button"
                onClick={() => setShowCompletedModal(false)}
                className="rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs px-5 py-2.5 transition active:scale-95"
              >
                关闭 (Close)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
