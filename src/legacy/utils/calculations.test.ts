import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateItemFinancials,
  calculateSingleOrderDuration,
  calculateFulfillmentStats,
  formatDurationMs,
} from './calculations';
import { Order } from '../types';

test('加叉烧价格已调整为 2块 (RM 2.00)', () => {
  // 餐牌（2026-10-22 用户确认）：小碗面 RM 7.00，替代原型 RM 8.00
  const regular = calculateItemFinancials('noodle', 'small', undefined, false, {
    extraCharSiew: false,
    extraWanton: false,
    spiciness: 'normal',
    lard: 'normal',
    scallion: 'normal',
  });
  assert.equal(regular.unitPrice, 7.0);

  // 加叉烧后价格应为 7.0 + 2.0 = 9.0
  const withCharSiew = calculateItemFinancials('noodle', 'small', undefined, false, {
    extraCharSiew: true,
    extraWanton: false,
    spiciness: 'normal',
    lard: 'normal',
    scallion: 'normal',
  });
  assert.equal(withCharSiew.unitPrice, 9.0, '加叉烧必须严格增加 RM 2.00');

  // Kosong 净面不能加叉烧
  const kosongWithCharSiew = calculateItemFinancials('noodle', 'small', undefined, true, {
    extraCharSiew: true,
    extraWanton: false,
    spiciness: 'normal',
    lard: 'normal',
    scallion: 'normal',
  });
  assert.equal(kosongWithCharSiew.unitPrice, 3.5, 'Kosong 净面严格半价且不能加叉烧');

  // 新规格：Kosong 同样禁止加云吞（原型会 +RM2 并加 3 粒，与厨房「严禁云吞」冲突）
  const kosongWithWanton = calculateItemFinancials('noodle', 'small', undefined, true, {
    extraCharSiew: false,
    extraWanton: true,
    spiciness: 'normal',
    lard: 'normal',
    scallion: 'normal',
  });
  assert.equal(kosongWithWanton.unitPrice, 3.5, 'Kosong 不能加云吞');
  assert.equal(kosongWithWanton.wantons, 0);
});

test('时间格式化算法 formatDurationMs', () => {
  assert.equal(formatDurationMs(45 * 1000), '45秒');
  assert.equal(formatDurationMs(5 * 60 * 1000 + 6 * 1000), '5分06秒');
  assert.equal(formatDurationMs(12 * 60 * 1000 + 40 * 1000), '12分40秒');
});

test('单订单用时算法 calculateSingleOrderDuration', () => {
  const baseTime = 1700000000000;
  const completedOrder: Order = {
    id: 'ord-test-1',
    orderNumber: '堂食 餐牌10号',
    orderType: 'dine_in',
    status: 'completed',
    createdAt: baseTime,
    completedAt: baseTime + 5.5 * 60 * 1000, // 5分30秒
    items: [],
    subtotal: 10,
    packagingFee: 0,
    totalAmount: 10,
    totalBomCost: 3.5,
    paymentMethod: 'cash',
    noodleBallsTotal: 1,
    wantonCountTotal: 3,
  };

  const dur = calculateSingleOrderDuration(completedOrder);
  assert.equal(dur.isCompleted, true);
  assert.equal(dur.durationMinutes, 5.5);
  assert.equal(dur.durationFormatted, '5分30秒');
  assert.equal(dur.speedRating, 'normal');
});

test('全局出餐效率与时效统计算法 calculateFulfillmentStats', () => {
  const baseTime = 1700000000000;
  const orders: Order[] = [
    {
      id: 'ord-1',
      orderNumber: '堂食 餐牌1号',
      orderType: 'dine_in',
      status: 'completed',
      createdAt: baseTime,
      completedAt: baseTime + 3 * 60 * 1000, // 3 分钟 (极速)
      items: [],
      subtotal: 10,
      packagingFee: 0,
      totalAmount: 10,
      totalBomCost: 3,
      paymentMethod: 'cash',
      noodleBallsTotal: 1,
      wantonCountTotal: 3,
    },
    {
      id: 'ord-2',
      orderNumber: '打包 餐牌2号',
      orderType: 'takeaway',
      status: 'completed',
      createdAt: baseTime,
      completedAt: baseTime + 7 * 60 * 1000, // 7 分钟 (正常)
      items: [],
      subtotal: 10,
      packagingFee: 0,
      totalAmount: 10,
      totalBomCost: 3,
      paymentMethod: 'qr',
      noodleBallsTotal: 1,
      wantonCountTotal: 3,
    },
  ];

  const stats = calculateFulfillmentStats(orders);
  assert.equal(stats.totalCompletedOrders, 2);
  assert.equal(stats.averageDurationMinutes, 5.0);
  assert.equal(stats.minDurationMinutes, 3.0);
  assert.equal(stats.maxDurationMinutes, 7.0);
  assert.equal(stats.fastestOrder?.orderNumber, '堂食 餐牌1号');
  assert.equal(stats.slowestOrder?.orderNumber, '打包 餐牌2号');
  assert.equal(stats.dineInAvgMinutes, 3.0);
  assert.equal(stats.takeawayAvgMinutes, 7.0);
  assert.equal(stats.onTimeRate, 100);
});

test('干捞云吞价格与食材成本计算', () => {
  // 10粒装 基础价 RM 7.00
  const dry10 = calculateItemFinancials('dry_wanton', undefined, '10pcs');
  assert.equal(dry10.unitPrice, 7.0);
  assert.equal(dry10.wantons, 10);
  assert.equal(dry10.noodleBalls, 0);

  // 15粒装 基础价 RM 10.00
  const dry15 = calculateItemFinancials('dry_wanton', undefined, '15pcs');
  assert.equal(dry15.unitPrice, 10.0);
  assert.equal(dry15.wantons, 15);

  // 加云吞 +3粒 +RM 2.00
  const dryWithExtra = calculateItemFinancials('dry_wanton', undefined, '10pcs', false, {
    extraCharSiew: false,
    extraWanton: true,
    spiciness: 'normal',
    lard: 'normal',
    scallion: 'normal',
  });
  assert.equal(dryWithExtra.unitPrice, 9.0);
  assert.equal(dryWithExtra.wantons, 13);
});

