/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExpenseRecord, LardOption, Order, ScallionOption, SpicinessLevel, WastageRecord } from '../types';
import { calculateItemFinancials } from '../utils/calculations';

const now = Date.now();
const m = 60 * 1000;

// Helper to make mock order item
function makeNoodleItem(
  id: string,
  size: 'small' | 'medium' | 'large',
  sauce: 'black' | 'white' | 'red' | 'soup',
  isKosong = false,
  extraCharSiew = false,
  extraWanton = false,
  spiciness: SpicinessLevel = 'normal',
  lard: LardOption = 'normal',
  scallion: ScallionOption = 'normal',
  qty = 1,
  orderType: 'dine_in' | 'takeaway' = 'dine_in'
) {
  const fin = calculateItemFinancials(
    'noodle',
    size,
    undefined,
    isKosong,
    { extraCharSiew, extraWanton, spiciness, lard, scallion },
    orderType
  );

  return {
    id,
    type: 'noodle' as const,
    name: isKosong ? '云吞面 (⚡ Kosong 净面)' : '招牌笨珍云吞面',
    size,
    sauce,
    isKosong,
    modifiers: {
      extraCharSiew,
      extraWanton,
      spiciness,
      lard,
      scallion,
    },
    unitPrice: fin.unitPrice,
    quantity: qty,
    noodleBallsPerItem: fin.noodleBalls,
    wantonCountPerItem: fin.wantons,
    bomCostPerItem: fin.bomCost,
  };
}

function makeSoupItem(
  id: string,
  soupSize: '10pcs' | '15pcs',
  extraWanton = false,
  spiciness: SpicinessLevel = 'none',
  lard: LardOption = 'normal',
  scallion: ScallionOption = 'normal',
  qty = 1,
  orderType: 'dine_in' | 'takeaway' = 'dine_in'
) {
  const fin = calculateItemFinancials(
    'soup',
    undefined,
    soupSize,
    false,
    {
      extraCharSiew: false,
      extraWanton,
      spiciness,
      lard,
      scallion,
    },
    orderType
  );

  return {
    id,
    type: 'soup' as const,
    name: soupSize === '10pcs' ? '鲜肉云吞汤 (10粒)' : '鲜肉云吞汤 (15粒)',
    soupSize,
    modifiers: {
      extraCharSiew: false,
      extraWanton,
      spiciness,
      lard,
      scallion,
    },
    unitPrice: fin.unitPrice,
    quantity: qty,
    noodleBallsPerItem: 0,
    wantonCountPerItem: fin.wantons,
    bomCostPerItem: fin.bomCost,
  };
}

// 4 Active Pending Orders in KDS
export const INITIAL_ORDERS: Order[] = [
  // 1. 堂食 餐牌8号 (Wait ~9.5 mins)
  {
    id: 'ord-pending-1',
    orderNumber: '堂食 餐牌8号',
    orderType: 'dine_in',
    tokenNumber: 8,
    status: 'pending',
    createdAt: now - 9.5 * m,
    paymentMethod: 'cash',
    items: [
      makeNoodleItem('item-1-1', 'medium', 'red', false, true, false, 'less', 'extra', 'normal', 1, 'dine_in'), // 中碗 1.5面 红酱 少辣 +叉烧 加多猪油渣
      makeNoodleItem('item-1-2', 'small', 'black', false, false, false, 'none', 'normal', 'none', 1, 'dine_in'), // 小碗 1面 黑酱 不辣 走青
    ],
    subtotal: 20.0,
    packagingFee: 0,
    totalAmount: 20.0,
    totalBomCost: 4.86 + 2.77,
    noodleBallsTotal: 2.5,
    wantonCountTotal: 6,
  },
  // 2. 打包 餐牌15号 (免汤) (Wait ~5.2 mins) - Contains Kosong & Soup
  {
    id: 'ord-pending-2',
    orderNumber: '打包 餐牌15号',
    orderType: 'takeaway',
    tokenNumber: 15,
    takeawayCode: '餐牌15号',
    status: 'pending',
    createdAt: now - 5.2 * m,
    paymentMethod: 'qr',
    items: [
      makeNoodleItem('item-2-1', 'large', 'black', true, false, false, 'normal', 'normal', 'normal', 1, 'takeaway'), // 大碗 2面 Kosong 半价 (RM6)
      makeSoupItem('item-2-2', '10pcs', false, 'none', 'normal', 'normal', 1, 'takeaway'), // 云吞汤 10粒 (RM7)
    ],
    subtotal: 13.0,
    packagingFee: 0,
    totalAmount: 13.0,
    totalBomCost: 2.40 + 3.0,
    noodleBallsTotal: 2.0,
    wantonCountTotal: 10,
  },
  // 3. 堂食 餐牌3号 (Wait ~2.5 mins)
  {
    id: 'ord-pending-3',
    orderNumber: '堂食 餐牌3号',
    orderType: 'dine_in',
    tokenNumber: 3,
    status: 'pending',
    createdAt: now - 2.5 * m,
    paymentMethod: 'cash',
    items: [
      makeNoodleItem('item-3-1', 'small', 'white', false, false, true, 'none', 'extra', 'normal', 1, 'dine_in'), // 小碗 1面 白酱 不辣 加云吞3粒 加多猪油渣
    ],
    subtotal: 10.0,
    packagingFee: 0,
    totalAmount: 10.0,
    totalBomCost: 3.43,
    noodleBallsTotal: 1.0,
    wantonCountTotal: 6,
  },
  // 4. 打包 餐牌22号 (Wait ~1.1 min)
  {
    id: 'ord-pending-4',
    orderNumber: '打包 餐牌22号',
    orderType: 'takeaway',
    tokenNumber: 22,
    takeawayCode: '餐牌22号',
    status: 'pending',
    createdAt: now - 1.1 * m,
    paymentMethod: 'qr',
    items: [
      makeNoodleItem('item-4-1', 'medium', 'red', false, false, false, 'extra', 'normal', 'normal', 1, 'takeaway'), // 中碗 1.5面 红酱 加辣
    ],
    subtotal: 10.0,
    packagingFee: 0,
    totalAmount: 10.0,
    totalBomCost: 3.84,
    noodleBallsTotal: 1.5,
    wantonCountTotal: 3,
  },

  // 8 Completed Orders Today
  {
    id: 'ord-comp-1',
    orderNumber: '堂食 餐牌1号',
    orderType: 'dine_in',
    tokenNumber: 1,
    status: 'completed',
    createdAt: now - 180 * m,
    completedAt: now - 172 * m,
    paymentMethod: 'cash',
    items: [
      makeNoodleItem('c1-1', 'medium', 'black', false, false, false, 'normal', 'normal', 'normal', 2, 'dine_in'),
    ],
    subtotal: 20.0,
    packagingFee: 0,
    totalAmount: 20.0,
    totalBomCost: 6.84,
    noodleBallsTotal: 3.0,
    wantonCountTotal: 6,
  },
  {
    id: 'ord-comp-2',
    orderNumber: '打包 餐牌7号',
    orderType: 'takeaway',
    tokenNumber: 7,
    takeawayCode: '餐牌7号',
    status: 'completed',
    createdAt: now - 150 * m,
    completedAt: now - 143 * m,
    paymentMethod: 'qr',
    items: [
      makeNoodleItem('c2-1', 'large', 'red', false, true, false, 'extra', 'normal', 'normal', 1, 'takeaway'),
    ],
    subtotal: 15.0,
    packagingFee: 0,
    totalAmount: 15.0,
    totalBomCost: 5.76,
    noodleBallsTotal: 2.0,
    wantonCountTotal: 4,
  },
  {
    id: 'ord-comp-3',
    orderNumber: '堂食 餐牌12号',
    orderType: 'dine_in',
    tokenNumber: 12,
    status: 'completed',
    createdAt: now - 120 * m,
    completedAt: now - 114 * m,
    paymentMethod: 'cash',
    items: [
      makeNoodleItem('c3-1', 'small', 'soup', false, false, false, 'none', 'normal', 'normal', 2, 'dine_in'),
      makeSoupItem('c3-2', '10pcs', false, 'none', 'normal', 'normal', 1, 'dine_in'),
    ],
    subtotal: 23.0,
    packagingFee: 0,
    totalAmount: 23.0,
    totalBomCost: 8.34,
    noodleBallsTotal: 2.0,
    wantonCountTotal: 16,
  },
  {
    id: 'ord-comp-4',
    orderNumber: '堂食 餐牌5号',
    orderType: 'dine_in',
    tokenNumber: 5,
    status: 'completed',
    createdAt: now - 95 * m,
    completedAt: now - 88 * m,
    paymentMethod: 'qr',
    items: [
      makeNoodleItem('c4-1', 'small', 'black', true, false, false, 'less', 'normal', 'normal', 2, 'dine_in'),
    ],
    subtotal: 8.0,
    packagingFee: 0,
    totalAmount: 8.0,
    totalBomCost: 2.70,
    noodleBallsTotal: 2.0,
    wantonCountTotal: 0,
  },
  {
    id: 'ord-comp-5',
    orderNumber: '打包 餐牌14号',
    orderType: 'takeaway',
    tokenNumber: 14,
    takeawayCode: '餐牌14号',
    status: 'completed',
    createdAt: now - 70 * m,
    completedAt: now - 62 * m,
    paymentMethod: 'cash',
    items: [
      makeNoodleItem('c5-1', 'medium', 'white', false, false, true, 'less', 'extra', 'none', 1, 'takeaway'),
    ],
    subtotal: 12.0,
    packagingFee: 0,
    totalAmount: 12.0,
    totalBomCost: 4.50,
    noodleBallsTotal: 1.5,
    wantonCountTotal: 6,
  },
  {
    id: 'ord-comp-6',
    orderNumber: '堂食 餐牌18号',
    orderType: 'dine_in',
    tokenNumber: 18,
    status: 'completed',
    createdAt: now - 50 * m,
    completedAt: now - 42 * m,
    paymentMethod: 'qr',
    items: [
      makeNoodleItem('c6-1', 'large', 'black', false, true, true, 'normal', 'normal', 'normal', 1, 'dine_in'),
      makeNoodleItem('c6-2', 'medium', 'red', false, false, false, 'less', 'normal', 'normal', 1, 'dine_in'),
    ],
    subtotal: 26.0,
    packagingFee: 0,
    totalAmount: 26.0,
    totalBomCost: 9.88,
    noodleBallsTotal: 3.5,
    wantonCountTotal: 10,
  },
  {
    id: 'ord-comp-7',
    orderNumber: '堂食 餐牌9号',
    orderType: 'dine_in',
    tokenNumber: 9,
    status: 'completed',
    createdAt: now - 35 * m,
    completedAt: now - 28 * m,
    paymentMethod: 'cash',
    items: [
      makeNoodleItem('c7-1', 'small', 'red', false, false, false, 'none', 'normal', 'normal', 1, 'dine_in'),
    ],
    subtotal: 8.0,
    packagingFee: 0,
    totalAmount: 8.0,
    totalBomCost: 2.77,
    noodleBallsTotal: 1.0,
    wantonCountTotal: 3,
  },
  {
    id: 'ord-comp-8',
    orderNumber: '堂食 餐牌6号',
    orderType: 'dine_in',
    tokenNumber: 6,
    status: 'completed',
    createdAt: now - 20 * m,
    completedAt: now - 13 * m,
    paymentMethod: 'qr',
    items: [
      makeNoodleItem('c8-1', 'medium', 'soup', false, false, false, 'none', 'normal', 'normal', 1, 'dine_in'),
      makeSoupItem('c8-2', '15pcs', false, 'none', 'normal', 'normal', 1, 'dine_in'),
    ],
    subtotal: 20.0,
    packagingFee: 0,
    totalAmount: 20.0,
    totalBomCost: 7.32,
    noodleBallsTotal: 1.5,
    wantonCountTotal: 18,
  },
];

export const INITIAL_EXPENSES: ExpenseRecord[] = [
  {
    id: 'exp-1',
    date: '2026-10-17',
    category: '猪肉 (五花肉/瘦肉)',
    amount: 450,
    description: '新山巴刹优质猪肉 25kg (叉烧肉与云吞馅料)',
    createdAt: now - 7 * 60 * 60 * 1000,
  },
  {
    id: 'exp-2',
    date: '2026-10-17',
    category: '面条 (全蛋幼面)',
    amount: 115,
    description: '笨珍制面厂直供新鲜全蛋幼面 150粒',
    createdAt: now - 6.5 * 60 * 60 * 1000,
  },
  {
    id: 'exp-3',
    date: '2026-10-17',
    category: '酱料与猪油',
    amount: 500,
    description: '古早秘制黑酱油 2大桶、红酱原料及自炸猪油板 1桶',
    createdAt: now - 6 * 60 * 60 * 1000,
  },
  {
    id: 'exp-4',
    date: '2026-10-17',
    category: '云吞皮',
    amount: 125,
    description: '超薄透光蛋香云吞皮 10大包',
    createdAt: now - 5 * 60 * 60 * 1000,
  },
  {
    id: 'exp-5',
    date: '2026-10-17',
    category: '高汤原料 (鸡骨/江鱼仔)',
    amount: 70,
    description: '熬汤老母鸡 2只、头级邦咯岛江鱼仔 1kg',
    createdAt: now - 4.5 * 60 * 60 * 1000,
  },
  {
    id: 'exp-6',
    date: '2026-10-17',
    category: '煤气与杂项',
    amount: 35,
    description: '石油气一桶及打包牛皮纸/塑料袋补货',
    createdAt: now - 3 * 60 * 60 * 1000,
  },
  {
    id: 'exp-7',
    date: '2026-10-16',
    category: '还供应商旧账',
    amount: 500,
    description: '偿还笨珍老供应商干货及原物料旧账结清',
    createdAt: now - 24 * 60 * 60 * 1000,
  },
];

export const INITIAL_WASTAGE: WastageRecord[] = [
  {
    id: 'w-1',
    date: '2026-10-16',
    noodleBalls: 4,
    wantons: 12,
    costDeduction: 6.04,
    note: '收档水气过潮结块面条4粒，破皮云吞12粒',
    createdAt: now - 20 * 60 * 60 * 1000,
  },
];
