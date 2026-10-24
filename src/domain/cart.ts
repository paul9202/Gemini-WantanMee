/**
 * 购物车与整单合计。纯函数：输入旧购物车，返回新购物车。
 * 价格、份量、成本永远由配置重算，不信任任何传入的单价或总价。
 */
import { BomVersion, unitCostUnits } from './bom';
import { isValidQuantity, LineConfig, lineMergeKey, linePortions, normalizeConfig, unitPriceSen } from './lineItem';
import { MenuVersion, OrderServiceMode, orderServiceMode, ServiceMode } from './menu';
import type { CostUnits, Sen } from './money';

export interface CartLine {
  lineId: string;
  config: LineConfig;
  quantity: number;
  /** 这一行堂食还是打包。同一单可以混合（店里吃完再打包，一次结账）。 */
  serviceMode: ServiceMode;
}

export interface Cart {
  /** 新加入餐品默认的就餐方式。 */
  serviceMode: ServiceMode;
  lines: CartLine[];
}

/**
 * 线上 / 离线日志里的行：旧客户端与旧日志没有行级 serviceMode，按整单的 serviceMode 补齐。
 */
export interface OrderLineInput {
  lineId: string;
  config: LineConfig;
  quantity: number;
  serviceMode?: ServiceMode;
}

export function resolveLines<L extends OrderLineInput>(lines: readonly L[], orderMode: ServiceMode): (L & { serviceMode: ServiceMode })[] {
  return lines.map((l) => ({ ...l, serviceMode: l.serviceMode ?? orderMode }));
}

export function cartServiceMode(cart: Cart): OrderServiceMode {
  return orderServiceMode(cart.lines.map((l) => l.serviceMode), cart.serviceMode);
}

const sameLine = (a: { config: LineConfig; serviceMode: ServiceMode }, key: string, mode: ServiceMode) =>
  a.serviceMode === mode && lineMergeKey(a.config) === key;

export function emptyCart(serviceMode: ServiceMode = 'dine_in'): Cart {
  return { serviceMode, lines: [] };
}

/** 加入一行（按购物车当前默认的就餐方式）；配置、备注与就餐方式都相同才合并数量。 */
export function addLine(menu: MenuVersion, cart: Cart, config: LineConfig, newLineId: string, quantity = 1): Cart {
  if (!isValidQuantity(quantity)) throw new RangeError(`数量非法：${quantity}`);
  const cfg = normalizeConfig(menu, config);
  const key = lineMergeKey(cfg);
  const existing = cart.lines.find((l) => sameLine(l, key, cart.serviceMode));
  if (existing) {
    return { ...cart, lines: cart.lines.map((l) => (l === existing ? { ...l, quantity: l.quantity + quantity } : l)) };
  }
  return { ...cart, lines: [...cart.lines, { lineId: newLineId, config: cfg, quantity, serviceMode: cart.serviceMode }] };
}

/** 编辑一行配置；若编辑后与另一行相同则并入那一行，不修改其他行的配置。 */
export function updateLineConfig(menu: MenuVersion, cart: Cart, lineId: string, config: LineConfig): Cart {
  const target = cart.lines.find((l) => l.lineId === lineId);
  if (!target) return cart;
  const cfg = normalizeConfig(menu, config);
  const key = lineMergeKey(cfg);
  return mergeInto(cart, target, cfg, key, target.serviceMode);
}

/** 把 target 改成 cfg / mode；若与另一行相同则并入那一行。 */
function mergeInto(cart: Cart, target: CartLine, cfg: LineConfig, key: string, mode: ServiceMode): Cart {
  const twin = cart.lines.find((l) => l.lineId !== target.lineId && sameLine(l, key, mode));
  if (twin) {
    return {
      ...cart,
      lines: cart.lines
        .filter((l) => l.lineId !== target.lineId)
        .map((l) => (l === twin ? { ...l, quantity: l.quantity + target.quantity } : l)),
    };
  }
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === target.lineId ? { ...l, config: cfg, serviceMode: mode } : l)) };
}

/** 单独改一行的就餐方式（例如这碗打包）；与另一行相同则合并。 */
export function setLineServiceMode(cart: Cart, lineId: string, serviceMode: ServiceMode): Cart {
  const target = cart.lines.find((l) => l.lineId === lineId);
  if (!target || target.serviceMode === serviceMode) return cart;
  return mergeInto(cart, target, target.config, lineMergeKey(target.config), serviceMode);
}

/** 设置数量；0 表示移除（UI 负责短暂撤销）。 */
export function setLineQuantity(cart: Cart, lineId: string, quantity: number): Cart {
  if (quantity === 0) return { ...cart, lines: cart.lines.filter((l) => l.lineId !== lineId) };
  if (!isValidQuantity(quantity)) throw new RangeError(`数量非法：${quantity}`);
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === lineId ? { ...l, quantity } : l)) };
}

/**
 * 页头的堂食/打包：设置之后新加餐品的默认方式。
 * 购物车还没有混合时（全部同一种）整单一起切换，与原来「整单堂食/打包」的用法一致；
 * 已经逐行混合时只改默认，不覆盖员工逐行选好的方式。
 */
export function setServiceMode(cart: Cart, serviceMode: ServiceMode): Cart {
  if (cartServiceMode(cart) === 'mixed') return { ...cart, serviceMode };
  return { serviceMode, lines: cart.lines.map((l) => ({ ...l, serviceMode })) };
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
  /** 打包的份数（只有这些份计包装成本）。 */
  takeawayPortionCount: number;
  /** 食材成本（不含包装）。 */
  ingredientCostUnits: CostUnits;
  packagingCostUnits: CostUnits;
  totalCostUnits: CostUnits;
  lines: LineTotals[];
}

/**
 * 整单合计。打包的每份计包装成本（混合单只算打包的行），默认不向客人收包装费。
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
  const takeawayPortionCount = cart.lines.reduce((s, l) => s + (l.serviceMode === 'takeaway' ? l.quantity : 0), 0);
  const packagingCostUnits = takeawayPortionCount * bom.packagingPerPortion;
  return {
    totalSen: lines.reduce((s, l) => s + l.lineTotalSen, 0),
    portionCount,
    takeawayPortionCount,
    noodleHalfUnits: lines.reduce((s, l) => s + l.noodleHalfUnits, 0),
    wantonCount: lines.reduce((s, l) => s + l.wantonCount, 0),
    ingredientCostUnits,
    packagingCostUnits,
    totalCostUnits: ingredientCostUnits + packagingCostUnits,
    lines,
  };
}
