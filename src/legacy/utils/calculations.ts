/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CartItem,
  DEFAULT_BOM,
  FulfillmentStats,
  ItemType,
  NoodleSize,
  NOODLE_SIZES,
  Order,
  OrderDurationInfo,
  OrderItemModifier,
  OrderType,
  SauceType,
  SpeedRating,
  WANTON_SOUP_OPTIONS,
  DRY_WANTON_OPTIONS,
  WantonSoupSize,
} from '../types';

export const INITIAL_CAPITAL_INVESTMENT = 5500; // RM 5,500
export const DAILY_FIXED_COST = 34.6; // RM 34.60 / day (RM 900 / 26 days)
export const MONTHLY_FIXED_COST = 900; // RM 900

/**
 * Calculates item price and BOM cost dynamically
 */
export function calculateItemFinancials(
  type: ItemType,
  size?: NoodleSize,
  soupSize?: WantonSoupSize,
  isKosong = false,
  modifiers: OrderItemModifier = {
    extraCharSiew: false,
    extraWanton: false,
    spiciness: 'normal',
    lard: 'normal',
    scallion: 'normal',
  },
  orderType: OrderType = 'dine_in'
): {
  unitPrice: number;
  bomCost: number;
  noodleBalls: number;
  wantons: number;
} {
  let unitPrice = 0;
  let bomCost = 0;
  let noodleBalls = 0;
  let wantons = 0;

  if (type === 'noodle') {
    const sizeOption = NOODLE_SIZES[size || 'small'];
    noodleBalls = sizeOption.noodleBalls;

    // 1. Base Price
    if (isKosong) {
      unitPrice = sizeOption.kosongPrice; // Strictly 50%
      wantons = 0; // Kosong has 0 wantons
      // BOM: Noodle + Sauce/Greens only
      const noodleCost = noodleBalls * DEFAULT_BOM.noodleBall;
      const sauceCost = DEFAULT_BOM.sauceGreensLard;
      bomCost = noodleCost + sauceCost;
    } else {
      unitPrice = sizeOption.price;
      wantons = sizeOption.defaultWantons;
      // Standard BOM: Noodle + Char Siew + Wantons + Sauce/Greens
      const noodleCost = noodleBalls * DEFAULT_BOM.noodleBall;
      const wantonsCost = wantons * DEFAULT_BOM.wanton;
      const charSiewCost = DEFAULT_BOM.charSiewPortion;
      const sauceCost = DEFAULT_BOM.sauceGreensLard;
      bomCost = noodleCost + wantonsCost + charSiewCost + sauceCost;
    }

    // 2. Add-ons (Note: Extra Char Siew cannot be combined with Kosong)
    if (modifiers.extraCharSiew && !isKosong) {
      unitPrice += 2.0; // 加叉烧 2块 (RM 2.00)
      bomCost += DEFAULT_BOM.extraCharSiewCost;
    }

    if (modifiers.extraWanton && !isKosong) {
      unitPrice += 2.0; // +RM 2 for 3 wantons（Kosong 禁止所有肉类加料）
      wantons += 3;
      bomCost += DEFAULT_BOM.extraWantonCost;
    }
  } else if (type === 'soup') {
    const soupOption = WANTON_SOUP_OPTIONS[soupSize || '10pcs'];
    unitPrice = soupOption.price;
    wantons = soupOption.wantons;
    noodleBalls = 0;

    // Soup BOM: Wantons + Soup/Scallions base (RM 0.60)
    bomCost = wantons * DEFAULT_BOM.wanton + 0.6;

    if (modifiers.extraWanton) {
      unitPrice += 2.0;
      wantons += 3;
      bomCost += DEFAULT_BOM.extraWantonCost;
    }
  } else if (type === 'dry_wanton') {
    const dryOption = DRY_WANTON_OPTIONS[soupSize || '10pcs'];
    unitPrice = dryOption.price;
    wantons = dryOption.wantons;
    noodleBalls = 0;

    // Dry Wanton BOM: Wantons + Sauce/Lard/Greens base (RM 0.50)
    bomCost = wantons * DEFAULT_BOM.wanton + DEFAULT_BOM.sauceGreensLard;

    if (modifiers.extraWanton) {
      unitPrice += 2.0;
      wantons += 3;
      bomCost += DEFAULT_BOM.extraWantonCost;
    }
  }

  // Takeaway packaging fee & cost
  if (orderType === 'takeaway') {
    bomCost += DEFAULT_BOM.packaging; // RM 0.20 packaging cost
  }

  return {
    unitPrice: Number(unitPrice.toFixed(2)),
    bomCost: Number(bomCost.toFixed(2)),
    noodleBalls,
    wantons,
  };
}

/**
 * Summarizes the active kitchen queue for the Chef KDS Batching Assistant
 */
export function calculateKitchenBatchSummary(orders: Order[]): {
  totalNoodleBalls: number;
  totalWantons: number;
  pendingOrderCount: number;
  sauceBreakdown: Record<SauceType, number>;
  kosongBowlCount: number;
} {
  const pendingOrders = orders.filter((o) => o.status === 'pending');

  let totalNoodleBalls = 0;
  let totalWantons = 0;
  let kosongBowlCount = 0;
  const sauceBreakdown: Record<SauceType, number> = {
    black: 0,
    white: 0,
    red: 0,
    soup: 0,
  };

  for (const order of pendingOrders) {
    for (const item of order.items) {
      const qty = item.quantity;
      totalNoodleBalls += item.noodleBallsPerItem * qty;
      totalWantons += item.wantonCountPerItem * qty;

      if (item.isKosong) {
        kosongBowlCount += qty;
      }

      if ((item.type === 'noodle' || item.type === 'dry_wanton') && item.sauce) {
        sauceBreakdown[item.sauce] += qty;
      }
    }
  }

  return {
    totalNoodleBalls: Number(totalNoodleBalls.toFixed(1)),
    totalWantons,
    pendingOrderCount: pendingOrders.length,
    sauceBreakdown,
    kosongBowlCount,
  };
}

/**
 * Timeframe filtering
 */
export type Timeframe = 'daily' | 'weekly' | 'monthly';

export function filterOrdersByTimeframe(orders: Order[], timeframe: Timeframe): Order[] {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (timeframe === 'daily') {
    // Current 24 hours / today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return orders.filter((o) => o.createdAt >= startOfToday.getTime());
  } else if (timeframe === 'weekly') {
    const weekAgo = now - 7 * oneDayMs;
    return orders.filter((o) => o.createdAt >= weekAgo);
  } else {
    // Monthly (last 30 days)
    const monthAgo = now - 30 * oneDayMs;
    return orders.filter((o) => o.createdAt >= monthAgo);
  }
}

/**
 * Calculate Boss KPI metrics
 */
export interface AnalyticsKPIs {
  totalRevenue: number;
  cashRevenue: number;
  qrRevenue: number;
  cashRatio: number;
  qrRatio: number;
  totalBomCost: number;
  totalWastageCost: number;
  fixedRentCost: number;
  estimatedNetProfit: number;
  grossMarginPct: number;
  totalOrders: number;
  totalBowls: number;
  regularBowls: number;
  kosongBowls: number;
  dineInOrders: number;
  takeawayOrders: number;
  sauceCounts: Record<SauceType, number>;
  saucePercentages: Record<SauceType, number>;
  cumulativeNetProfitAllTime: number;
  roiPercentage: number;
  remainingRoiAmount: number;
}

export function calculateAnalytics(
  allOrders: Order[],
  filteredOrders: Order[],
  totalWastageCost: number,
  timeframe: Timeframe
): AnalyticsKPIs {
  const validOrders = filteredOrders.filter((o) => o.status !== 'cancelled');

  let totalRevenue = 0;
  let cashRevenue = 0;
  let qrRevenue = 0;
  let totalBomCost = 0;
  let totalBowls = 0;
  let regularBowls = 0;
  let kosongBowls = 0;
  let dineInOrders = 0;
  let takeawayOrders = 0;

  const sauceCounts: Record<SauceType, number> = {
    black: 0,
    white: 0,
    red: 0,
    soup: 0,
  };

  for (const order of validOrders) {
    totalRevenue += order.totalAmount;
    totalBomCost += order.totalBomCost;

    if (order.paymentMethod === 'cash') {
      cashRevenue += order.totalAmount;
    } else {
      qrRevenue += order.totalAmount;
    }

    if (order.orderType === 'dine_in') {
      dineInOrders++;
    } else {
      takeawayOrders++;
    }

    for (const item of order.items) {
      const qty = item.quantity;
      if (item.type === 'noodle') {
        totalBowls += qty;
        if (item.isKosong) {
          kosongBowls += qty;
        } else {
          regularBowls += qty;
        }

        if (item.sauce) {
          sauceCounts[item.sauce] += qty;
        }
      } else if (item.type === 'dry_wanton') {
        totalBowls += qty;
        regularBowls += qty;
        if (item.sauce) {
          sauceCounts[item.sauce] += qty;
        }
      } else {
        totalBowls += qty;
      }
    }
  }

  // Fixed rent calculation based on timeframe
  let fixedRentCost = DAILY_FIXED_COST;
  if (timeframe === 'weekly') {
    fixedRentCost = DAILY_FIXED_COST * 6; // 6 working days
  } else if (timeframe === 'monthly') {
    fixedRentCost = MONTHLY_FIXED_COST; // RM 900
  }

  // Net Profit = Revenue - BOM Cost - Wastage - Fixed Rent
  const estimatedNetProfit = totalRevenue - totalBomCost - totalWastageCost - fixedRentCost;
  const grossMarginPct = totalRevenue > 0 ? ((totalRevenue - totalBomCost) / totalRevenue) * 100 : 0;

  const cashRatio = totalRevenue > 0 ? (cashRevenue / totalRevenue) * 100 : 50;
  const qrRatio = totalRevenue > 0 ? (qrRevenue / totalRevenue) * 100 : 50;

  const totalSauceDishes =
    sauceCounts.black + sauceCounts.white + sauceCounts.red + sauceCounts.soup || 1;
  const saucePercentages: Record<SauceType, number> = {
    black: (sauceCounts.black / totalSauceDishes) * 100,
    white: (sauceCounts.white / totalSauceDishes) * 100,
    red: (sauceCounts.red / totalSauceDishes) * 100,
    soup: (sauceCounts.soup / totalSauceDishes) * 100,
  };

  // Cumulative all-time net profit for ROI tracker (RM 5,500 initial capital)
  const allValid = allOrders.filter((o) => o.status !== 'cancelled');
  let allTimeRev = 0;
  let allTimeBom = 0;
  for (const o of allValid) {
    allTimeRev += o.totalAmount;
    allTimeBom += o.totalBomCost;
  }
  // 期初累计经营结果默认 0（移除演示用 RM1,920）；亏损不被 max(0, …) 吞掉。
  const priorAccumulatedProfit = 0;
  const currentNet = allTimeRev - allTimeBom - totalWastageCost - DAILY_FIXED_COST;
  const cumulativeNetProfitAllTime = priorAccumulatedProfit + currentNet;
  const roiPercentage = Math.min(
    100,
    Number(((cumulativeNetProfitAllTime / INITIAL_CAPITAL_INVESTMENT) * 100).toFixed(1))
  );
  const remainingRoiAmount = Math.max(0, INITIAL_CAPITAL_INVESTMENT - cumulativeNetProfitAllTime);

  return {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    cashRevenue: Number(cashRevenue.toFixed(2)),
    qrRevenue: Number(qrRevenue.toFixed(2)),
    cashRatio: Number(cashRatio.toFixed(1)),
    qrRatio: Number(qrRatio.toFixed(1)),
    totalBomCost: Number(totalBomCost.toFixed(2)),
    totalWastageCost: Number(totalWastageCost.toFixed(2)),
    fixedRentCost: Number(fixedRentCost.toFixed(2)),
    estimatedNetProfit: Number(estimatedNetProfit.toFixed(2)),
    grossMarginPct: Number(grossMarginPct.toFixed(1)),
    totalOrders: validOrders.length,
    totalBowls,
    regularBowls,
    kosongBowls,
    dineInOrders,
    takeawayOrders,
    sauceCounts,
    saucePercentages,
    cumulativeNetProfitAllTime: Number(cumulativeNetProfitAllTime.toFixed(2)),
    roiPercentage,
    remainingRoiAmount: Number(remainingRoiAmount.toFixed(2)),
  };
}

/**
 * ========================================================
 * 订单用时与出餐耗时算法 (Order Fulfillment Time Algorithms)
 * ========================================================
 */

/**
 * 格式化毫秒为标准分钟秒数字符串，例如 "5分20秒" 或 "45秒"
 */
export function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSecs = Math.floor(safeMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins === 0) {
    return `${secs}秒`;
  }
  return `${mins}分${secs < 10 ? '0' : ''}${secs}秒`;
}

/**
 * 计算单个订单的精确完成用时或当前已等候用时
 * @param order 订单对象
 * @param currentTime 当前参考时间戳（默认 Date.now()）
 */
export function calculateSingleOrderDuration(
  order: Order,
  currentTime = Date.now()
): OrderDurationInfo {
  const isCompleted = order.status === 'completed' && typeof order.completedAt === 'number';
  const endTime = isCompleted ? (order.completedAt as number) : currentTime;
  const durationMs = Math.max(0, endTime - order.createdAt);
  const durationMinutes = Number((durationMs / 60000).toFixed(1));
  const durationFormatted = formatDurationMs(durationMs);

  let speedRating: SpeedRating = 'normal';
  let ratingLabel = '🟢 正常出餐 (4-8分)';

  if (durationMinutes <= 4.0) {
    speedRating = 'lightning';
    ratingLabel = '⚡ 极速出餐 (<4分)';
  } else if (durationMinutes <= 8.0) {
    speedRating = 'normal';
    ratingLabel = '🟢 正常出餐 (4-8分)';
  } else if (durationMinutes <= 12.0) {
    speedRating = 'slow';
    ratingLabel = '🟡 稍慢提醒 (8-12分)';
  } else {
    speedRating = 'overdue';
    ratingLabel = '🔴 严重超时 (>12分)';
  }

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    durationMs,
    durationMinutes,
    durationFormatted,
    isCompleted,
    speedRating,
    ratingLabel,
    createdAt: order.createdAt,
    completedAt: order.completedAt,
  };
}

/**
 * 全局出餐时效综合统计算法
 * 计算档口平均出餐时间、中位数、最快/最慢单、堂食vs打包对比、按时出餐率与新单预估等候时长
 */
export function calculateFulfillmentStats(
  orders: Order[],
  targetThresholdMinutes = 8
): FulfillmentStats {
  const completedOrders = orders.filter(
    (o) => o.status === 'completed' && typeof o.completedAt === 'number'
  );
  const pendingOrders = orders.filter((o) => o.status === 'pending');

  if (completedOrders.length === 0) {
    // 默认空状态
    return {
      totalCompletedOrders: 0,
      totalPendingOrders: pendingOrders.length,
      averageDurationMinutes: 0,
      averageDurationFormatted: '0秒',
      medianDurationMinutes: 0,
      minDurationMinutes: 0,
      maxDurationMinutes: 0,
      fastestOrder: null,
      slowestOrder: null,
      dineInAvgMinutes: 0,
      takeawayAvgMinutes: 0,
      targetThresholdMinutes,
      onTimeRate: 100,
      distribution: {
        lightning: 0,
        normal: 0,
        slow: 0,
        overdue: 0,
      },
      estimatedNextOrderWaitMinutes: Math.max(3, pendingOrders.length * 2),
    };
  }

  const durationList = completedOrders.map((ord) => {
    const durInfo = calculateSingleOrderDuration(ord);
    return {
      order: ord,
      ...durInfo,
    };
  });

  // 按用时升序排序
  durationList.sort((a, b) => a.durationMs - b.durationMs);

  const totalMs = durationList.reduce((acc, curr) => acc + curr.durationMs, 0);
  const avgMs = totalMs / durationList.length;
  const averageDurationMinutes = Number((avgMs / 60000).toFixed(1));
  const averageDurationFormatted = formatDurationMs(avgMs);

  // 中位数
  const mid = Math.floor(durationList.length / 2);
  const medianMs =
    durationList.length % 2 !== 0
      ? durationList[mid].durationMs
      : (durationList[mid - 1].durationMs + durationList[mid].durationMs) / 2;
  const medianDurationMinutes = Number((medianMs / 60000).toFixed(1));

  // 最快与最慢
  const fastest = durationList[0];
  const slowest = durationList[durationList.length - 1];

  // 堂食 vs 打包 分组用时统计
  const dineInList = durationList.filter((d) => d.orderType === 'dine_in');
  const takeawayList = durationList.filter((d) => d.orderType === 'takeaway');

  const dineInAvgMinutes =
    dineInList.length > 0
      ? Number(
          (
            dineInList.reduce((acc, c) => acc + c.durationMs, 0) /
            dineInList.length /
            60000
          ).toFixed(1)
        )
      : 0;

  const takeawayAvgMinutes =
    takeawayList.length > 0
      ? Number(
          (
            takeawayList.reduce((acc, c) => acc + c.durationMs, 0) /
            takeawayList.length /
            60000
          ).toFixed(1)
        )
      : 0;

  // 耗时区间分布统计
  const distribution = {
    lightning: 0,
    normal: 0,
    slow: 0,
    overdue: 0,
  };

  let onTimeCount = 0;
  for (const item of durationList) {
    distribution[item.speedRating]++;
    if (item.durationMinutes <= targetThresholdMinutes) {
      onTimeCount++;
    }
  }

  const onTimeRate = Number(((onTimeCount / durationList.length) * 100).toFixed(1));

  // 新订单预估等候时长算法：根据前面排队单数与面球总数动态推算
  let pendingNoodleBalls = 0;
  for (const p of pendingOrders) {
    pendingNoodleBalls += p.noodleBallsTotal || 1;
  }
  // 档口出餐节奏：基础底时 2 分钟 + 每粒面球约 1.2 分钟处理时间，最低保证 3 分钟
  const estimatedNextOrderWaitMinutes = Math.max(
    3,
    Math.round(2 + pendingNoodleBalls * 1.2)
  );

  return {
    totalCompletedOrders: completedOrders.length,
    totalPendingOrders: pendingOrders.length,
    averageDurationMinutes,
    averageDurationFormatted,
    medianDurationMinutes,
    minDurationMinutes: fastest.durationMinutes,
    maxDurationMinutes: slowest.durationMinutes,
    fastestOrder: {
      id: fastest.orderId,
      orderNumber: fastest.orderNumber,
      durationFormatted: fastest.durationFormatted,
      minutes: fastest.durationMinutes,
    },
    slowestOrder: {
      id: slowest.orderId,
      orderNumber: slowest.orderNumber,
      durationFormatted: slowest.durationFormatted,
      minutes: slowest.durationMinutes,
    },
    dineInAvgMinutes,
    takeawayAvgMinutes,
    targetThresholdMinutes,
    onTimeRate,
    distribution,
    estimatedNextOrderWaitMinutes,
  };
}
