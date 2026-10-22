/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type SauceType = 'black' | 'white' | 'red' | 'soup';

export interface SauceInfo {
  id: SauceType;
  name: string;
  chinese: string;
  badgeClass: string;
  borderClass: string;
  bgSoft: string;
  desc: string;
}

export const SAUCE_MAP: Record<SauceType, SauceInfo> = {
  black: {
    id: 'black',
    name: '黑酱 (Black Soy)',
    chinese: '黑酱',
    badgeClass: 'bg-neutral-900 text-white border-neutral-700',
    borderClass: 'border-neutral-900',
    bgSoft: 'bg-neutral-100 text-neutral-900 border-neutral-300',
    desc: '秘制古早黑酱油，咸香浓郁',
  },
  white: {
    id: 'white',
    name: '白酱 (White Pork Lard)',
    chinese: '白酱',
    badgeClass: 'bg-amber-100 text-amber-950 border-amber-400 font-bold',
    borderClass: 'border-amber-500',
    bgSoft: 'bg-amber-50 text-amber-900 border-amber-200',
    desc: '香脆新鲜猪油渣+纯白胡椒葱油',
  },
  red: {
    id: 'red',
    name: '红酱 (Pontian Chili Tomato)',
    chinese: '红酱',
    badgeClass: 'bg-rose-600 text-white border-rose-500 font-bold',
    borderClass: 'border-rose-600',
    bgSoft: 'bg-rose-50 text-rose-900 border-rose-200',
    desc: '笨珍正宗招牌番茄甜辣红酱',
  },
  soup: {
    id: 'soup',
    name: '面汤 (Clear Soup)',
    chinese: '面汤',
    badgeClass: 'bg-sky-500 text-white border-sky-400 font-bold',
    borderClass: 'border-sky-500',
    bgSoft: 'bg-sky-50 text-sky-900 border-sky-200',
    desc: '老母鸡江鱼仔慢火熬制清甜大骨汤',
  },
};

export type NoodleSize = 'small' | 'medium' | 'large';

export interface NoodleSizeOption {
  id: NoodleSize;
  name: string;
  noodleBalls: number; // e.g. 1, 1.5, 2
  price: number;
  kosongPrice: number;
  defaultWantons: number;
  desc: string;
}

export const NOODLE_SIZES: Record<NoodleSize, NoodleSizeOption> = {
  small: {
    id: 'small',
    name: '小碗 (Small)',
    noodleBalls: 1,
    price: 8.0,
    kosongPrice: 4.0,
    defaultWantons: 3,
    desc: '1 粒面 · 标准叉烧 · 3 粒云吞',
  },
  medium: {
    id: 'medium',
    name: '中碗 (Medium)',
    noodleBalls: 1.5,
    price: 10.0,
    kosongPrice: 5.0,
    defaultWantons: 3,
    desc: '1.5 粒面 · 标准叉烧 · 3 粒云吞',
  },
  large: {
    id: 'large',
    name: '大碗 (Large)',
    noodleBalls: 2,
    price: 12.0,
    kosongPrice: 6.0,
    defaultWantons: 4,
    desc: '2 粒面 · 标准叉烧 · 4 粒云吞',
  },
};

export type WantonSoupSize = '10pcs' | '15pcs';

export interface WantonSoupOption {
  id: WantonSoupSize;
  name: string;
  wantons: number;
  price: number;
}

export const WANTON_SOUP_OPTIONS: Record<WantonSoupSize, WantonSoupOption> = {
  '10pcs': {
    id: '10pcs',
    name: '云吞汤 (10粒)',
    wantons: 10,
    price: 7.0,
  },
  '15pcs': {
    id: '15pcs',
    name: '云吞汤 (15粒)',
    wantons: 15,
    price: 10.0,
  },
};

export const DRY_WANTON_OPTIONS: Record<WantonSoupSize, WantonSoupOption> = {
  '10pcs': {
    id: '10pcs',
    name: '招牌干捞云吞 (10粒)',
    wantons: 10,
    price: 7.0,
  },
  '15pcs': {
    id: '15pcs',
    name: '招牌干捞云吞 (15粒)',
    wantons: 15,
    price: 10.0,
  },
};

export type ItemType = 'noodle' | 'soup' | 'dry_wanton';

export type SpicinessLevel = 'none' | 'less' | 'normal' | 'extra'; // 不辣, 少辣, 普通辣, 加辣

export type LardOption = 'normal' | 'extra' | 'none'; // 正常猪油渣, 加多猪油渣, 不要猪油渣
export type ScallionOption = 'normal' | 'extra' | 'none'; // 正常葱花, 多葱, 走青(不要葱)

export type SpeedRating = 'lightning' | 'normal' | 'slow' | 'overdue';

export interface OrderDurationInfo {
  orderId: string;
  orderNumber: string;
  orderType: OrderType;
  durationMs: number;
  durationMinutes: number;
  durationFormatted: string;
  isCompleted: boolean;
  speedRating: SpeedRating;
  ratingLabel: string;
  createdAt: number;
  completedAt?: number;
}

export interface FulfillmentStats {
  totalCompletedOrders: number;
  totalPendingOrders: number;
  averageDurationMinutes: number;
  averageDurationFormatted: string;
  medianDurationMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  fastestOrder: { id: string; orderNumber: string; durationFormatted: string; minutes: number } | null;
  slowestOrder: { id: string; orderNumber: string; durationFormatted: string; minutes: number } | null;
  dineInAvgMinutes: number;
  takeawayAvgMinutes: number;
  targetThresholdMinutes: number;
  onTimeRate: number;
  distribution: {
    lightning: number;
    normal: number;
    slow: number;
    overdue: number;
  };
  estimatedNextOrderWaitMinutes: number;
}

export interface OrderItemModifier {
  extraCharSiew: boolean; // +RM 2.00
  extraWanton: boolean; // +RM 2.00 (3 pcs)
  spiciness: SpicinessLevel; // 必选: 不辣 / 少辣 / 普通辣 / 加辣
  lard: LardOption; // 猪油渣定制
  scallion: ScallionOption; // 葱花定制
}

export interface CartItem {
  id: string;
  type: ItemType;
  name: string;
  size?: NoodleSize;
  soupSize?: WantonSoupSize;
  sauce?: SauceType; // for noodle
  isKosong?: boolean; // 净面 (半价)
  modifiers: OrderItemModifier;
  unitPrice: number;
  quantity: number;
  noodleBallsPerItem: number;
  wantonCountPerItem: number;
  bomCostPerItem: number;
  note?: string;
}

export type OrderType = 'dine_in' | 'takeaway';
export type PaymentMethod = 'cash' | 'qr';
export type OrderStatus = 'pending' | 'completed' | 'cancelled';

export interface Order {
  id: string;
  orderNumber: string; // e.g. 堂食 餐牌8号 or 打包 餐牌15号
  orderType: OrderType;
  tokenNumber?: number; // 顾客餐牌号 (1 - 50，堂食与打包均发放餐牌)
  takeawayCode?: string; // 打包编号
  items: CartItem[];
  subtotal: number;
  packagingFee: number;
  totalAmount: number;
  totalBomCost: number;
  paymentMethod: PaymentMethod;
  status: OrderStatus;
  createdAt: number; // timestamp
  completedAt?: number;
  noodleBallsTotal: number;
  wantonCountTotal: number;
}

export interface BOMUnitCosts {
  noodleBall: number; // RM 0.85 per ball
  wanton: number; // RM 0.22 per pc
  charSiewPortion: number; // RM 1.20 per portion
  sauceGreensLard: number; // RM 0.50 per bowl
  packaging: number; // RM 0.20 per takeaway container
  extraCharSiewCost: number; // RM 1.20
  extraWantonCost: number; // RM 0.66 (3 pcs * 0.22)
}

export const DEFAULT_BOM: BOMUnitCosts = {
  noodleBall: 0.85,
  wanton: 0.22,
  charSiewPortion: 1.20,
  sauceGreensLard: 0.50,
  packaging: 0.20,
  extraCharSiewCost: 1.20,
  extraWantonCost: 0.66,
};

export interface ExpenseRecord {
  id: string;
  date: string; // YYYY-MM-DD
  category: string;
  amount: number;
  description: string;
  createdAt: number;
}

export interface WastageRecord {
  id: string;
  date: string; // YYYY-MM-DD
  noodleBalls: number; // count
  wantons: number; // count
  costDeduction: number;
  note?: string;
  createdAt: number;
}

export interface AppState {
  orders: Order[];
  expenses: ExpenseRecord[];
  wastage: WastageRecord[];
  activeView: 'pos' | 'kds' | 'analytics';
  soundEnabled: boolean;
}
