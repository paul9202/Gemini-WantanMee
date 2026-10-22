/**
 * 购物车与整单合计。纯函数：输入旧购物车，返回新购物车。
 * 价格、份量、成本永远由配置重算，不信任任何传入的单价或总价。
 */
import { BomVersion, unitCostUnits } from './bom';
import { isValidQuantity, LineConfig, lineMergeKey, linePortions, normalizeConfig, unitPriceSen } from './lineItem';
import type { MenuVersion, ServiceMode } from './menu';
import type { CostUnits, Sen } from './money';

export interface CartLine {
  lineId: string;
  config: LineConfig;
  quantity: number;
}

export interface Cart {
  serviceMode: ServiceMode;
  lines: CartLine[];
}

export function emptyCart(serviceMode: ServiceMode = 'dine_in'): Cart {
  return { serviceMode, lines: [] };
}

/** 加入一行；完全相同的配置与备注合并数量。 */
export function addLine(menu: MenuVersion, cart: Cart, config: LineConfig, newLineId: string, quantity = 1): Cart {
  if (!isValidQuantity(quantity)) throw new RangeError(`数量非法：${quantity}`);
  const cfg = normalizeConfig(menu, config);
  const key = lineMergeKey(cfg);
  const existing = cart.lines.find((l) => lineMergeKey(l.config) === key);
  if (existing) {
    return { ...cart, lines: cart.lines.map((l) => (l === existing ? { ...l, quantity: l.quantity + quantity } : l)) };
  }
  return { ...cart, lines: [...cart.lines, { lineId: newLineId, config: cfg, quantity }] };
}

/** 编辑一行配置；若编辑后与另一行相同则并入那一行，不修改其他行的配置。 */
export function updateLineConfig(menu: MenuVersion, cart: Cart, lineId: string, config: LineConfig): Cart {
  const target = cart.lines.find((l) => l.lineId === lineId);
  if (!target) return cart;
  const cfg = normalizeConfig(menu, config);
  const key = lineMergeKey(cfg);
  const twin = cart.lines.find((l) => l.lineId !== lineId && lineMergeKey(l.config) === key);
  if (twin) {
    return {
      ...cart,
      lines: cart.lines
        .filter((l) => l.lineId !== lineId)
        .map((l) => (l === twin ? { ...l, quantity: l.quantity + target.quantity } : l)),
    };
  }
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === lineId ? { ...l, config: cfg } : l)) };
}

/** 设置数量；0 表示移除（UI 负责短暂撤销）。 */
export function setLineQuantity(cart: Cart, lineId: string, quantity: number): Cart {
  if (quantity === 0) return { ...cart, lines: cart.lines.filter((l) => l.lineId !== lineId) };
  if (!isValidQuantity(quantity)) throw new RangeError(`数量非法：${quantity}`);
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === lineId ? { ...l, quantity } : l)) };
}

export function setServiceMode(cart: Cart, serviceMode: ServiceMode): Cart {
  return { ...cart, serviceMode };
}

export interface LineTotals {
  lineId: string;
  unitPriceSen: Sen;
  lineTotalSen: Sen;
  unitCostUnits: CostUnits;
  lineCostUnits: CostUnits;
  noodleHalfUnits: number;
  wantonCount: number;
}

export interface OrderTotals {
  totalSen: Sen;
  portionCount: number;
  noodleHalfUnits: number;
  wantonCount: number;
  /** 食材成本（不含包装）。 */
  ingredientCostUnits: CostUnits;
  packagingCostUnits: CostUnits;
  totalCostUnits: CostUnits;
  lines: LineTotals[];
}

/**
 * 整单合计。打包每份计包装成本，默认不向客人收包装费。
 * 成本先按行「单份 × 数量」再求和，最后才由展示层舍入。
 */
export function computeTotals(menu: MenuVersion, bom: BomVersion, cart: Cart): OrderTotals {
  const lines: LineTotals[] = cart.lines.map((l) => {
    const price = unitPriceSen(menu, l.config);
    const cost = unitCostUnits(menu, bom, l.config);
    const p = linePortions(menu, l.config);
    return {
      lineId: l.lineId,
      unitPriceSen: price,
      lineTotalSen: price * l.quantity,
      unitCostUnits: cost,
      lineCostUnits: cost * l.quantity,
      noodleHalfUnits: p.noodleHalfUnits * l.quantity,
      wantonCount: p.wantonCount * l.quantity,
    };
  });
  const portionCount = cart.lines.reduce((s, l) => s + l.quantity, 0);
  const ingredientCostUnits = lines.reduce((s, l) => s + l.lineCostUnits, 0);
  const packagingCostUnits = cart.serviceMode === 'takeaway' ? portionCount * bom.packagingPerPortion : 0;
  return {
    totalSen: lines.reduce((s, l) => s + l.lineTotalSen, 0),
    portionCount,
    noodleHalfUnits: lines.reduce((s, l) => s + l.noodleHalfUnits, 0),
    wantonCount: lines.reduce((s, l) => s + l.wantonCount, 0),
    ingredientCostUnits,
    packagingCostUnits,
    totalCostUnits: ingredientCostUnits + packagingCostUnits,
    lines,
  };
}
