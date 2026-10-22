/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import {
  TrendingUp,
  DollarSign,
  PieChart,
  ShoppingBag,
  Utensils,
  Award,
  Calendar,
  Plus,
  Trash2,
  AlertCircle,
  FileSpreadsheet,
  Layers,
  ArrowUpRight,
  Flame,
  Check,
  Percent,
  Clock,
  Zap,
  Timer,
  CheckCircle2,
} from 'lucide-react';
import {
  DEFAULT_BOM,
  ExpenseRecord,
  Order,
  SAUCE_MAP,
  SauceType,
  WastageRecord,
} from '../types';
import {
  calculateAnalytics,
  calculateFulfillmentStats,
  calculateSingleOrderDuration,
  DAILY_FIXED_COST,
  filterOrdersByTimeframe,
  INITIAL_CAPITAL_INVESTMENT,
  MONTHLY_FIXED_COST,
  Timeframe,
} from '../utils/calculations';
import { Language, translations } from '../utils/i18n';

interface AnalyticsViewProps {
  orders: Order[];
  expenses: ExpenseRecord[];
  wastage: WastageRecord[];
  onAddExpense: (expense: ExpenseRecord) => void;
  onDeleteExpense: (id: string) => void;
  onAddWastage: (wastage: WastageRecord) => void;
  onOpenFirebase: () => void;
  language: Language;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  orders,
  expenses,
  wastage,
  onAddExpense,
  onDeleteExpense,
  onAddWastage,
  onOpenFirebase,
  language,
}) => {
  const t = translations[language];
  const [timeframe, setTimeframe] = useState<Timeframe>('daily');
  const [subTab, setSubTab] = useState<'pnl' | 'speed' | 'expenses' | 'wastage'>('pnl');

  // Filtered orders
  const filteredOrders = useMemo(() => {
    return filterOrdersByTimeframe(orders, timeframe);
  }, [orders, timeframe]);

  // Wastage total cost
  const totalWastageCost = useMemo(() => {
    return wastage.reduce((sum, w) => sum + w.costDeduction, 0);
  }, [wastage]);

  // Analytics KPIs
  const kpis = useMemo(() => {
    return calculateAnalytics(orders, filteredOrders, totalWastageCost, timeframe);
  }, [orders, filteredOrders, totalWastageCost, timeframe]);

  // Order Fulfillment & Kitchen Timing Algorithm KPIs
  const fulfillmentStats = useMemo(() => {
    return calculateFulfillmentStats(filteredOrders);
  }, [filteredOrders]);

  // Theoretical Usage Counters for Wastage Assistant
  const theoreticalUsage = useMemo(() => {
    let noodles = 0;
    let wantons = 0;
    for (const ord of filteredOrders) {
      if (ord.status !== 'cancelled') {
        noodles += ord.noodleBallsTotal;
        wantons += ord.wantonCountTotal;
      }
    }
    return {
      noodles: Number(noodles.toFixed(1)),
      wantons,
    };
  }, [filteredOrders]);

  // --- Sub-Tab B: Expense Form State ---
  const [expCategory, setExpCategory] = useState<string>('猪肉 (五花肉/瘦肉)');
  const [expAmount, setExpAmount] = useState<string>('');
  const [expDesc, setExpDesc] = useState<string>('');

  const expensePresets = [
    { label: '猪肉 RM450', category: '猪肉 (五花肉/瘦肉)', amount: 450, desc: '新鲜五花肉与叉烧瘦肉' },
    { label: '面条 RM115', category: '面条 (全蛋幼面)', amount: 115, desc: '笨珍制面厂直供 150粒' },
    { label: '酱料 RM500', category: '酱料与猪油', amount: 500, desc: '古早秘制黑酱油及自炸猪油板' },
    { label: '云吞皮 RM125', category: '云吞皮', amount: 125, desc: '超薄透光云吞皮 10包' },
    { label: '高汤鱼料 RM70', category: '高汤原料 (鸡骨/江鱼仔)', amount: 70, desc: '老母鸡与头级江鱼仔' },
    { label: '煤气/杂项 RM35', category: '煤气与杂项', amount: 35, desc: '石油气与打包盒袋补货' },
    { label: '还供应商旧账 RM500', category: '还供应商旧账', amount: 500, desc: '偿还老供应商物料旧账' },
  ];

  const handleApplyPreset = (preset: typeof expensePresets[0]) => {
    setExpCategory(preset.category);
    setExpAmount(preset.amount.toString());
    setExpDesc(preset.desc);
  };

  const handleCreateExpense = (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseFloat(expAmount);
    if (isNaN(num) || num <= 0) return;

    const newExp: ExpenseRecord = {
      id: 'exp-' + Date.now(),
      date: new Date().toISOString().split('T')[0],
      category: expCategory,
      amount: Number(num.toFixed(2)),
      description: expDesc || expCategory,
      createdAt: Date.now(),
    };

    onAddExpense(newExp);
    setExpAmount('');
    setExpDesc('');
  };

  // --- Sub-Tab C: Wastage Logger Form State ---
  const [wasteNoodles, setWasteNoodles] = useState<string>('');
  const [wasteWantons, setWasteWantons] = useState<string>('');
  const [wasteNote, setWasteNote] = useState<string>('');

  const computedWasteCost = useMemo(() => {
    const n = parseFloat(wasteNoodles) || 0;
    const w = parseFloat(wasteWantons) || 0;
    return Number((n * DEFAULT_BOM.noodleBall + w * DEFAULT_BOM.wanton).toFixed(2));
  }, [wasteNoodles, wasteWantons]);

  const handleLogWastage = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseFloat(wasteNoodles) || 0;
    const w = parseFloat(wasteWantons) || 0;
    if (n <= 0 && w <= 0) return;

    const newWastage: WastageRecord = {
      id: 'waste-' + Date.now(),
      date: new Date().toISOString().split('T')[0],
      noodleBalls: n,
      wantons: w,
      costDeduction: computedWasteCost,
      note: wasteNote || '收档损耗盘点',
      createdAt: Date.now(),
    };

    onAddWastage(newWastage);
    setWasteNoodles('');
    setWasteWantons('');
    setWasteNote('');
  };

  return (
    <div className="mx-auto max-w-7xl p-3 sm:p-6 space-y-6">
      {/* ======================================================== */}
      {/* HEADER CONTROLS (Timeframe + Title + Cloud Info)          */}
      {/* ======================================================== */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              老板与合伙人经营看板 (Boss Analytics)
            </h2>
            <span className="rounded-md bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-xs font-black text-indigo-700">
              实时核算
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            笨珍档口精细化成本与净利核算 · 涵盖 BOM 理论原料、损耗及 RM 5,500 初始本金回本周期
          </p>
        </div>

        {/* Timeframe Selector */}
        <div className="flex items-center gap-1.5 rounded-xl bg-slate-100 p-1.5 border border-slate-200">
          {(['daily', 'weekly', 'monthly'] as Timeframe[]).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition active:scale-95 ${
                timeframe === tf
                  ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-500/20'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tf === 'daily' ? '今日 (Daily)' : tf === 'weekly' ? '本周 (Weekly)' : '本月 (Monthly)'}
            </button>
          ))}
        </div>
      </div>

      {/* ======================================================== */}
      {/* EXECUTIVE BENTO GRID: 4 CORE KPI CARDS                  */}
      {/* ======================================================== */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI CARD 1: 总营业额与对账 */}
        <div className="rounded-2xl bg-white p-5 shadow-sm border border-slate-200/80 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-black uppercase tracking-wider">总营业额 (Revenue)</span>
              <DollarSign className="h-4 w-4 text-emerald-600" />
            </div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-3xl font-black text-slate-900 tabular-nums">
                RM {kpis.totalRevenue.toFixed(2)}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">已完成 {kpis.totalOrders} 单流水</p>
          </div>

          {/* Cash vs QR Split Bar */}
          <div className="mt-4 pt-3 border-t border-slate-100 space-y-1.5">
            <div className="flex justify-between text-xs text-slate-600 font-semibold">
              <span>💵 现金: RM {kpis.cashRevenue.toFixed(2)}</span>
              <span>📱 QR: RM {kpis.qrRevenue.toFixed(2)}</span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden flex">
              <div
                style={{ width: `${kpis.cashRatio}%` }}
                className="bg-emerald-500 transition-all"
                title={`现金 ${kpis.cashRatio}%`}
              />
              <div
                style={{ width: `${kpis.qrRatio}%` }}
                className="bg-sky-500 transition-all"
                title={`QR ${kpis.qrRatio}%`}
              />
            </div>
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>现金 {kpis.cashRatio}%</span>
              <span>DuitNow {kpis.qrRatio}%</span>
            </div>
          </div>
        </div>

        {/* KPI CARD 2: 真实净毛利 (Estimated Net Profit) */}
        <div className="rounded-2xl bg-white p-5 shadow-sm border border-slate-200/80 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-black uppercase tracking-wider">真实净毛利 (Net Profit)</span>
              <TrendingUp className="h-4 w-4 text-indigo-600" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span
                className={`text-3xl font-black tabular-nums ${
                  kpis.estimatedNetProfit >= 0 ? 'text-indigo-600' : 'text-rose-600'
                }`}
              >
                RM {kpis.estimatedNetProfit.toFixed(2)}
              </span>
              <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                毛利率 {kpis.grossMarginPct}%
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              扣减 BOM 食材、报废损耗及档口租金
            </p>
          </div>

          {/* Formula Mini Pills */}
          <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-3 gap-1 text-[10px] text-slate-500 text-center font-mono">
            <div className="bg-slate-50 p-1.5 rounded-lg border border-slate-200/60">
              <span className="block text-slate-500 font-semibold text-[10px]">食材BOM</span>
              <span className="font-bold text-slate-800">RM {kpis.totalBomCost.toFixed(1)}</span>
            </div>
            <div className="bg-slate-50 p-1.5 rounded-lg border border-slate-200/60">
              <span className="block text-slate-500 font-semibold text-[10px]">损耗报废</span>
              <span className="font-bold text-rose-600">RM {kpis.totalWastageCost.toFixed(1)}</span>
            </div>
            <div className="bg-slate-50 p-1.5 rounded-lg border border-slate-200/60">
              <span className="block text-slate-500 font-semibold text-[10px]">摊销租电</span>
              <span className="font-bold text-slate-800">RM {kpis.fixedRentCost.toFixed(1)}</span>
            </div>
          </div>
        </div>

        {/* KPI CARD 3: 出餐与口味结构 (Volume & Sauce Mix) */}
        <div className="rounded-2xl bg-white p-5 shadow-sm border border-slate-200/80 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-black uppercase tracking-wider">出餐与口味结构 (Mix)</span>
              <PieChart className="h-4 w-4 text-rose-600" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-black text-slate-900 tabular-nums">
                {kpis.totalBowls} <span className="text-base font-normal text-slate-500">碗</span>
              </span>
              <span className="text-xs font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                ⚡ 净面: {kpis.kosongBowls}碗
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              堂食 {kpis.dineInOrders} 单 · 打包 {kpis.takeawayOrders} 单
            </p>
          </div>

          {/* 4 Sauce Progress Bars */}
          <div className="mt-3 pt-2.5 border-t border-slate-100 space-y-1.5">
            <div className="grid grid-cols-4 gap-1 text-[10px] font-bold text-center">
              <span className="text-neutral-800">黑酱 {Math.round(kpis.saucePercentages.black)}%</span>
              <span className="text-rose-600">红酱 {Math.round(kpis.saucePercentages.red)}%</span>
              <span className="text-amber-700">白酱 {Math.round(kpis.saucePercentages.white)}%</span>
              <span className="text-sky-600">面汤 {Math.round(kpis.saucePercentages.soup)}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden flex">
              <div style={{ width: `${kpis.saucePercentages.black}%` }} className="bg-neutral-900" />
              <div style={{ width: `${kpis.saucePercentages.red}%` }} className="bg-rose-500" />
              <div style={{ width: `${kpis.saucePercentages.white}%` }} className="bg-amber-400" />
              <div style={{ width: `${kpis.saucePercentages.soup}%` }} className="bg-sky-400" />
            </div>
          </div>
        </div>

        {/* KPI CARD 4: RM 5,500 启动资金回本进度 (ROI Tracker) */}
        <div className="rounded-2xl bg-white p-5 shadow-sm border border-slate-200/80 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-xs font-black uppercase tracking-wider">
                RM 5,500 启动回本 (ROI)
              </span>
              <Award className="h-4 w-4 text-amber-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-black text-amber-600 tabular-nums">
                {kpis.roiPercentage}%
              </span>
              <span className="text-xs font-bold text-slate-500">已回本</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              累计净利: RM {kpis.cumulativeNetProfitAllTime.toFixed(2)}
            </p>
          </div>

          {/* Progress Bar & Target */}
          <div className="mt-4 pt-3 border-t border-slate-100 space-y-1.5">
            <div className="flex justify-between text-xs font-bold text-slate-700">
              <span>尚差: RM {kpis.remainingRoiAmount.toFixed(2)}</span>
              <span className="text-[11px] font-normal text-slate-400">本金 RM 5,500</span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                style={{ width: `${kpis.roiPercentage}%` }}
                className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all rounded-full"
              />
            </div>
            <p className="text-[10px] text-slate-400 text-center">
              按当前净利速率，预计约 15~18 个营业日完全回本
            </p>
          </div>
        </div>
      </div>

      {/* ======================================================== */}
      {/* OPERATIONS SUB-TABS NAVIGATION                           */}
      {/* ======================================================== */}
      <div className="rounded-2xl bg-white shadow-sm border border-slate-200/80 overflow-hidden">
        <div className="flex border-b border-slate-200 bg-slate-50/70 p-2 gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSubTab('pnl')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition active:scale-95 ${
              subTab === 'pnl'
                ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-500/20'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>明细 A · 利润与 BOM 成本明细表</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('expenses')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition active:scale-95 ${
              subTab === 'expenses'
                ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-500/20'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layers className="h-4 w-4" />
            <span>明细 B · 采购记账 (Supplier Expense)</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('wastage')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition active:scale-95 ${
              subTab === 'wastage'
                ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-500/20'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <AlertCircle className="h-4 w-4" />
            <span>明细 C · 收档损耗盘点 (Wastage Logger)</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('speed')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition active:scale-95 ${
              subTab === 'speed'
                ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-500/20'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Clock className="h-4 w-4 text-amber-500" />
            <span>明细 D · 出餐用时算法分析 (Fulfillment Time)</span>
          </button>
        </div>

        {/* SUB-TAB A: P&L & BOM BREAKDOWN TABLE */}
        {subTab === 'pnl' && (
          <div className="p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="text-sm font-black text-slate-900">
                  每单营业额与 BOM 理论食材成本拆解
                </h3>
                <p className="text-xs text-slate-500">
                  标准成本公式: 面条 RM0.85/粒, 鲜肉云吞 RM0.22/粒, 标准叉烧 RM1.20, 酱油葱菜猪油
                  RM0.50, 打包盒袋 RM0.20
                </p>
              </div>

              <div className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs text-slate-700 font-semibold flex items-center gap-2">
                <span>理论食材总成本:</span>
                <span className="font-black text-slate-900 tabular-nums">
                  RM {kpis.totalBomCost.toFixed(2)}
                </span>
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                  <tr>
                    <th className="p-3">订单单号</th>
                    <th className="p-3">类型</th>
                    <th className="p-3">餐品内容</th>
                    <th className="p-3 text-right">营业额 (Rev)</th>
                    <th className="p-3 text-right">理论 BOM</th>
                    <th className="p-3 text-right">毛利 (Profit)</th>
                    <th className="p-3 text-right">支付方式</th>
                    <th className="p-3">下单时间</th>
                    <th className="p-3 text-right">完成用时 (算法)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {filteredOrders.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-6 text-center text-slate-400">
                        当前时间筛选下无订单数据
                      </td>
                    </tr>
                  ) : (
                    filteredOrders.map((ord) => {
                      const profit = ord.totalAmount - ord.totalBomCost;
                      const dur = calculateSingleOrderDuration(ord);
                      return (
                        <tr key={ord.id} className="hover:bg-slate-50/70 transition">
                          <td className="p-3 font-black text-slate-900">{ord.orderNumber}</td>
                          <td className="p-3">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                ord.orderType === 'dine_in'
                                  ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                  : 'bg-amber-50 text-amber-800 border border-amber-200'
                              }`}
                            >
                              {ord.orderType === 'dine_in' ? '堂食' : '打包 (免汤)'}
                            </span>
                          </td>
                          <td className="p-3 max-w-xs truncate">
                            {ord.items.map((it, i) => (
                              <span key={i} className="mr-2">
                                {it.quantity}x {it.name}
                                {it.isKosong && (
                                  <span className="text-amber-600 font-bold ml-0.5">[半价]</span>
                                )}
                              </span>
                            ))}
                          </td>
                          <td className="p-3 text-right font-black tabular-nums text-slate-900">
                            RM {ord.totalAmount.toFixed(2)}
                          </td>
                          <td className="p-3 text-right tabular-nums text-slate-500 font-mono">
                            RM {ord.totalBomCost.toFixed(2)}
                          </td>
                          <td className="p-3 text-right tabular-nums font-bold text-emerald-700 font-mono">
                            RM {profit.toFixed(2)}
                          </td>
                          <td className="p-3 text-right font-semibold">
                            {ord.paymentMethod === 'cash' ? '💵 现金' : '📱 DuitNow'}
                          </td>
                          <td className="p-3 text-slate-400 tabular-nums">
                            {new Date(ord.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td className="p-3 text-right">
                            <span
                              className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                                ord.status === 'completed'
                                  ? dur.speedRating === 'lightning'
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                    : dur.speedRating === 'normal'
                                    ? 'bg-sky-50 text-sky-700 border border-sky-200'
                                    : 'bg-amber-50 text-amber-800 border border-amber-200'
                                  : 'bg-slate-100 text-slate-600 border border-slate-200'
                              }`}
                            >
                              {ord.status === 'completed' ? `⏱️ ${dur.durationFormatted}` : `⏳ 已等 ${dur.durationFormatted}`}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SUB-TAB D: ORDER FULFILLMENT DURATION ALGORITHM ANALYTICS */}
        {subTab === 'speed' && (
          <div className="p-5 space-y-6">
            {/* Header & Description */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                    <Clock className="h-5 w-5 text-amber-500" />
                    <span>出餐用时算法与厨房效率分析 (Order Duration & Speed Analytics)</span>
                  </h3>
                  <span className="rounded-full bg-amber-100 text-amber-800 text-[10px] font-black px-2 py-0.5">
                    实时算法
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  精确追踪每个订单从 POS 下单点选到头手煮面出餐的毫秒级用时差 (`completedAt - createdAt`)，监控高峰出餐节拍
                </p>
              </div>

              <div className="rounded-xl bg-slate-100 px-3.5 py-1.5 text-xs text-slate-700 font-semibold flex items-center gap-2">
                <span>预估新客等候时长:</span>
                <span className="font-black text-rose-600 tabular-nums">
                  ~{fulfillmentStats.estimatedNextOrderWaitMinutes} 分钟
                </span>
              </div>
            </div>

            {/* 4 Core Speed Metric Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Card 1: Average Duration */}
              <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4">
                <div className="flex items-center justify-between text-slate-500 text-xs font-bold">
                  <span>平均出餐用时</span>
                  <Timer className="h-4 w-4 text-indigo-600" />
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-black text-slate-900 tabular-nums">
                    {fulfillmentStats.averageDurationFormatted}
                  </span>
                  <span className="text-xs font-semibold text-slate-500">
                    ({fulfillmentStats.averageDurationMinutes} 分)
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  行业标准 ≤ 8.0 分钟 · {fulfillmentStats.totalCompletedOrders} 单已出餐
                </p>
              </div>

              {/* Card 2: On-Time Rate */}
              <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4">
                <div className="flex items-center justify-between text-slate-500 text-xs font-bold">
                  <span>8分钟出餐达标率</span>
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-black text-emerald-600 tabular-nums">
                    {fulfillmentStats.onTimeRate}%
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  8分钟内出餐合格率 · 超时自动触发急单标红
                </p>
              </div>

              {/* Card 3: Fastest & Slowest Orders */}
              <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4">
                <div className="flex items-center justify-between text-slate-500 text-xs font-bold">
                  <span>极速与最慢纪录</span>
                  <Zap className="h-4 w-4 text-amber-500" />
                </div>
                <div className="mt-2 space-y-1">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-emerald-700 font-bold flex items-center gap-1">
                      ⚡ 最快: {fulfillmentStats.fastestOrder ? fulfillmentStats.fastestOrder.durationFormatted : '-'}
                    </span>
                    <span className="text-slate-500 text-[11px] truncate max-w-[100px]">
                      {fulfillmentStats.fastestOrder?.orderNumber}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-rose-600 font-bold flex items-center gap-1">
                      🐢 最慢: {fulfillmentStats.slowestOrder ? fulfillmentStats.slowestOrder.durationFormatted : '-'}
                    </span>
                    <span className="text-slate-500 text-[11px] truncate max-w-[100px]">
                      {fulfillmentStats.slowestOrder?.orderNumber}
                    </span>
                  </div>
                </div>
              </div>

              {/* Card 4: Dine-In vs Takeaway Pace */}
              <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4">
                <div className="flex items-center justify-between text-slate-500 text-xs font-bold">
                  <span>堂食 vs 打包 均速</span>
                  <ShoppingBag className="h-4 w-4 text-rose-500" />
                </div>
                <div className="mt-2 space-y-1">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-700 font-semibold">🍽️ 堂食均速:</span>
                    <span className="font-black text-slate-900 tabular-nums">
                      {fulfillmentStats.dineInAvgMinutes} 分钟
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-700 font-semibold">🛍️ 打包均速:</span>
                    <span className="font-black text-slate-900 tabular-nums">
                      {fulfillmentStats.takeawayAvgMinutes} 分钟
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400 mt-1">打包免汤省去盛汤打包装袋时间</p>
              </div>
            </div>

            {/* Speed Range Breakdown & Algorithm Insights */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Speed Distribution Bars */}
              <div className="rounded-2xl border border-slate-200 p-4 space-y-3 bg-white">
                <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider">
                  出餐耗时区间分布 (Duration Distribution)
                </h4>

                <div className="space-y-2.5 text-xs">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="font-bold text-emerald-700 flex items-center gap-1">
                        ⚡ 极速出餐 (≤ 4 分钟)
                      </span>
                      <span className="font-black tabular-nums text-slate-900">
                        {fulfillmentStats.distribution.lightning} 单
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        style={{
                          width: `${
                            fulfillmentStats.totalCompletedOrders > 0
                              ? (fulfillmentStats.distribution.lightning /
                                  fulfillmentStats.totalCompletedOrders) *
                                100
                              : 0
                          }%`,
                        }}
                        className="h-full bg-emerald-500 rounded-full"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="font-bold text-sky-700 flex items-center gap-1">
                        🟢 正常标准 (4 ~ 8 分钟)
                      </span>
                      <span className="font-black tabular-nums text-slate-900">
                        {fulfillmentStats.distribution.normal} 单
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        style={{
                          width: `${
                            fulfillmentStats.totalCompletedOrders > 0
                              ? (fulfillmentStats.distribution.normal /
                                  fulfillmentStats.totalCompletedOrders) *
                                100
                              : 0
                          }%`,
                        }}
                        className="h-full bg-sky-500 rounded-full"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="font-bold text-amber-700 flex items-center gap-1">
                        🟡 稍慢提醒 (8 ~ 12 分钟)
                      </span>
                      <span className="font-black tabular-nums text-slate-900">
                        {fulfillmentStats.distribution.slow} 单
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        style={{
                          width: `${
                            fulfillmentStats.totalCompletedOrders > 0
                              ? (fulfillmentStats.distribution.slow /
                                  fulfillmentStats.totalCompletedOrders) *
                                100
                              : 0
                          }%`,
                        }}
                        className="h-full bg-amber-500 rounded-full"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="font-bold text-rose-700 flex items-center gap-1">
                        🔴 超时预警 (&gt; 12 分钟)
                      </span>
                      <span className="font-black tabular-nums text-slate-900">
                        {fulfillmentStats.distribution.overdue} 单
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        style={{
                          width: `${
                            fulfillmentStats.totalCompletedOrders > 0
                              ? (fulfillmentStats.distribution.overdue /
                                  fulfillmentStats.totalCompletedOrders) *
                                100
                              : 0
                          }%`,
                        }}
                        className="h-full bg-rose-500 rounded-full"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Algorithm Details Card */}
              <div className="rounded-2xl border border-slate-200 p-4 space-y-2 bg-slate-50/70">
                <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <Flame className="h-4 w-4 text-amber-500" />
                  <span>档口算法工作原理与出餐效率模型</span>
                </h4>
                <div className="space-y-2 text-xs text-slate-600">
                  <div className="bg-white p-2.5 rounded-xl border border-slate-200/80">
                    <span className="font-bold text-slate-900 block">1. 精确用时算法:</span>
                    <div className="text-[11px] text-indigo-700 font-semibold bg-indigo-50/60 rounded px-2 py-1 mt-1">
                      订单完成用时 = order.completedAt (头手点出餐) - order.createdAt (POS打单)
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      毫秒级换算为分钟和秒，无论堂食或打包，每单均有完整的耗时履历。
                    </p>
                  </div>
                  <div className="bg-white p-2.5 rounded-xl border border-slate-200/80">
                    <span className="font-bold text-slate-900 block">2. 动态预估等候时长算法:</span>
                    <div className="text-[11px] text-indigo-700 font-semibold bg-indigo-50/60 rounded px-2 py-1 mt-1">
                      预估时长 = Max(3, 2 + 当前待做面球总数 × 1.2 分钟)
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      根据头手抓面锅容积及下面烫水周期，自动推演下一位排队顾客需等候的分钟数。
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Comprehensive Order Timing Table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider">
                  各订单用时详细履历明细表 (Order Duration Log)
                </h4>
                <span className="text-xs text-slate-500 font-semibold">
                  共 {filteredOrders.length} 笔订单
                </span>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                    <tr>
                      <th className="p-3">订单单号</th>
                      <th className="p-3">类型</th>
                      <th className="p-3">餐品明细</th>
                      <th className="p-3">面球 / 云吞</th>
                      <th className="p-3">下单时间</th>
                      <th className="p-3">完成出餐时间</th>
                      <th className="p-3 text-right">出餐用时 (算法)</th>
                      <th className="p-3 text-right">时效评级</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {filteredOrders.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="p-6 text-center text-slate-400">
                          暂无订单数据
                        </td>
                      </tr>
                    ) : (
                      filteredOrders.map((ord) => {
                        const dur = calculateSingleOrderDuration(ord);
                        return (
                          <tr key={ord.id} className="hover:bg-slate-50/70 transition">
                            <td className="p-3 font-black text-slate-900">{ord.orderNumber}</td>
                            <td className="p-3">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                  ord.orderType === 'dine_in'
                                    ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                    : 'bg-amber-50 text-amber-800 border border-amber-200'
                                }`}
                              >
                                {ord.orderType === 'dine_in' ? '堂食' : '打包 (免汤)'}
                              </span>
                            </td>
                            <td className="p-3 max-w-xs truncate">
                              {ord.items.map((it, i) => (
                                <span key={i} className="mr-2">
                                  {it.quantity}x {it.name}
                                </span>
                              ))}
                            </td>
                            <td className="p-3 text-slate-700 font-medium">
                              {ord.noodleBallsTotal} 粒面 · {ord.wantonCountTotal} 粒云吞
                            </td>
                            <td className="p-3 text-slate-500 tabular-nums font-semibold">
                              {new Date(ord.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })}
                            </td>
                            <td className="p-3 text-slate-500 tabular-nums font-semibold">
                              {ord.completedAt
                                ? new Date(ord.completedAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                  })
                                : '厨房烹煮中...'}
                            </td>
                            <td className="p-3 text-right font-black tabular-nums">
                              <span
                                className={`${
                                  ord.status === 'completed'
                                    ? dur.speedRating === 'lightning'
                                      ? 'text-emerald-700'
                                      : dur.speedRating === 'normal'
                                      ? 'text-sky-700'
                                      : 'text-amber-700'
                                    : 'text-slate-400'
                                }`}
                              >
                                {ord.status === 'completed'
                                  ? dur.durationFormatted
                                  : `已等 ${dur.durationFormatted}`}
                              </span>
                            </td>
                            <td className="p-3 text-right">
                              <span
                                className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                                  ord.status === 'completed'
                                    ? dur.speedRating === 'lightning'
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : dur.speedRating === 'normal'
                                      ? 'bg-sky-50 text-sky-700 border border-sky-200'
                                      : dur.speedRating === 'slow'
                                      ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                      : 'bg-rose-50 text-rose-700 border border-rose-200'
                                    : 'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {ord.status === 'completed'
                                  ? dur.speedRating === 'lightning'
                                    ? '⚡ 极速'
                                    : dur.speedRating === 'normal'
                                    ? '🟢 正常'
                                    : dur.speedRating === 'slow'
                                    ? '🟡 偏慢'
                                    : '🔴 超时'
                                  : '⏳ 烹煮中'}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SUB-TAB B: SUPPLIER EXPENSE LOGGER */}
        {subTab === 'expenses' && (
          <div className="p-5 space-y-6">
            <div>
              <h3 className="text-sm font-black text-slate-900">采购记账与原料应付款项</h3>
              <p className="text-xs text-slate-500">
                点击快捷预设或手动输入当天猪肉、面条、酱油、煤气及还老供应商欠款
              </p>
            </div>

            {/* Quick Preset Buttons (1-Tap Fast Entry) */}
            <div>
              <span className="text-xs font-bold text-slate-500 block mb-2">快捷进货预设 (1-Tap Presets):</span>
              <div className="flex flex-wrap gap-2">
                {expensePresets.map((preset, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleApplyPreset(preset)}
                    className="rounded-xl border border-slate-200 bg-slate-50 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 px-3 py-2 text-xs font-bold text-slate-700 transition active:scale-95 shadow-2xs"
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Expense Form */}
            <form
              onSubmit={handleCreateExpense}
              className="rounded-2xl bg-slate-50 p-4 border border-slate-200/80 grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
            >
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">采购类别</label>
                <select
                  value={expCategory}
                  onChange={(e) => setExpCategory(e.target.value)}
                  className="w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs font-semibold focus:outline-hidden focus:border-indigo-500"
                >
                  <option value="猪肉 (五花肉/瘦肉)">猪肉 (五花肉/瘦肉)</option>
                  <option value="面条 (全蛋幼面)">面条 (全蛋幼面)</option>
                  <option value="酱料与猪油">酱料与猪油</option>
                  <option value="云吞皮">云吞皮</option>
                  <option value="高汤原料 (鸡骨/江鱼仔)">高汤原料 (鸡骨/江鱼仔)</option>
                  <option value="煤气与杂项">煤气与杂项</option>
                  <option value="还供应商旧账">还供应商旧账</option>
                  <option value="其他档口支出">其他档口支出</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">支出金额 (RM)</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={expAmount}
                  onChange={(e) => setExpAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs font-bold tabular-nums focus:outline-hidden focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">说明与备注</label>
                <input
                  type="text"
                  value={expDesc}
                  onChange={(e) => setExpDesc(e.target.value)}
                  placeholder="如：新山巴刹五花肉25kg"
                  className="w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs focus:outline-hidden focus:border-indigo-500"
                />
              </div>

              <div>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 text-xs shadow-md shadow-indigo-600/20 transition active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <Plus className="h-4 w-4" />
                  <span>记录采购支出</span>
                </button>
              </div>
            </form>

            {/* Expense History Table */}
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                  <tr>
                    <th className="p-3">日期</th>
                    <th className="p-3">项目类别</th>
                    <th className="p-3">详细说明</th>
                    <th className="p-3 text-right">支出金额</th>
                    <th className="p-3 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {expenses.map((exp) => (
                    <tr key={exp.id} className="hover:bg-slate-50/70 transition">
                      <td className="p-3 font-semibold text-slate-500">{exp.date}</td>
                      <td className="p-3 font-bold text-slate-900">{exp.category}</td>
                      <td className="p-3 text-slate-600">{exp.description}</td>
                      <td className="p-3 text-right font-black tabular-nums text-rose-600 font-mono">
                        RM {exp.amount.toFixed(2)}
                      </td>
                      <td className="p-3 text-center">
                        <button
                          type="button"
                          onClick={() => onDeleteExpense(exp.id)}
                          className="rounded p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SUB-TAB C: END-OF-DAY WASTAGE LOGGER */}
        {subTab === 'wastage' && (
          <div className="p-5 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-sm font-black text-slate-900">收档损耗盘点 (Wastage Logger)</h3>
                <p className="text-xs text-slate-500">
                  收档时盘点未用完变质破损的面条与云吞，直接计入损耗并扣减当天真实净利
                </p>
              </div>

              {/* Theoretical Usage Display */}
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-2 text-xs text-amber-900 flex items-center gap-3">
                <span className="font-bold">今日理论已煮消耗:</span>
                <span className="tabular-nums font-black text-amber-800">
                  {theoreticalUsage.noodles} 粒面 · {theoreticalUsage.wantons} 粒云吞
                </span>
              </div>
            </div>

            {/* Wastage Entry Form */}
            <form
              onSubmit={handleLogWastage}
              className="rounded-2xl bg-rose-50/50 p-4 border border-rose-200/80 grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
            >
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  报废面条 (粒数 × RM 0.85)
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={wasteNoodles}
                  onChange={(e) => setWasteNoodles(e.target.value)}
                  placeholder="0 粒"
                  className="w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs font-bold tabular-nums focus:outline-hidden focus:border-rose-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  报废云吞 (粒数 × RM 0.22)
                </label>
                <input
                  type="number"
                  step="1"
                  value={wasteWantons}
                  onChange={(e) => setWasteWantons(e.target.value)}
                  placeholder="0 粒"
                  className="w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs font-bold tabular-nums focus:outline-hidden focus:border-rose-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">损耗原因备注</label>
                <input
                  type="text"
                  value={wasteNote}
                  onChange={(e) => setWasteNote(e.target.value)}
                  placeholder="如：受潮结块或破皮"
                  className="w-full rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs focus:outline-hidden focus:border-rose-500"
                />
              </div>

              <div>
                <button
                  type="submit"
                  disabled={computedWasteCost <= 0}
                  className={`w-full rounded-xl font-bold py-2.5 text-xs shadow-md transition active:scale-95 flex items-center justify-center gap-1.5 ${
                    computedWasteCost > 0
                      ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/20'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <AlertCircle className="h-4 w-4" />
                  <span>记录损耗 (-RM {computedWasteCost.toFixed(2)})</span>
                </button>
              </div>
            </form>

            {/* Wastage Logs Table */}
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                  <tr>
                    <th className="p-3">日期</th>
                    <th className="p-3">报废面条</th>
                    <th className="p-3">报废云吞</th>
                    <th className="p-3">原因备注</th>
                    <th className="p-3 text-right">损耗扣减成本</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {wastage.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-400">
                        暂无报废损耗记录，档口原物料管理优秀！
                      </td>
                    </tr>
                  ) : (
                    wastage.map((w) => (
                      <tr key={w.id} className="hover:bg-slate-50/70 transition">
                        <td className="p-3 font-semibold text-slate-500">{w.date}</td>
                        <td className="p-3 font-bold text-slate-800">{w.noodleBalls} 粒面</td>
                        <td className="p-3 font-bold text-slate-800">{w.wantons} 粒云吞</td>
                        <td className="p-3 text-slate-600">{w.note || '收档损耗'}</td>
                        <td className="p-3 text-right font-black tabular-nums text-rose-600 font-mono">
                          - RM {w.costDeduction.toFixed(2)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
