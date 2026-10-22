/**
 * 理论食材成本（BOM），单位为 0.1 sen 的整数成本单位。
 * 只给老板读取；收银与后厨文档不得包含这些字段。
 */
import { linePortions, LineConfig } from './lineItem';
import type { MenuVersion, NoodleType, ProductKind } from './menu';
import type { CostUnits } from './money';

export interface BomVersion {
  version: string;
  /** 每「半个面球」的成本：1 面球 850 单位 = RM0.85。 */
  noodleHalfBall: Record<NoodleType, CostUnits>;
  wanton: CostUnits;
  charSiewPortion: CostUnits;
  /** 每份综合底料（酱、葱、油渣/汤底）。 */
  base: Record<ProductKind, CostUnits>;
  packagingPerPortion: CostUnits;
  /** 尚未实店校准、需在老板成本页标注的项目。 */
  pendingCalibration: string[];
}

export const BOM_V1: BomVersion = {
  version: 'bom-2026-10-v1',
  // 面薄暂无独立报价，沿用细面估值并标注待校准。
  noodleHalfBall: { thin_egg: 425, mee_poh: 425 },
  wanton: 220,
  charSiewPortion: 1200,
  base: {
    dry_noodle: 500,
    // 汤面首版沿用原型「综合底料 50 sen」估值，独立汤底以后按配方修订。
    soup_noodle: 500,
    dry_wanton: 500,
    wanton_soup: 600,
  },
  packagingPerPortion: 200,
  pendingCalibration: ['noodleHalfBall.mee_poh', 'base.soup_noodle', 'scallion_lard_extra'],
};

export const BOM_VERSIONS: Record<string, BomVersion> = { [BOM_V1.version]: BOM_V1 };

/** 单份成本（不含包装）。加叉烧/加云吞各只计一次。 */
export function unitCostUnits(menu: MenuVersion, bom: BomVersion, cfg: LineConfig): CostUnits {
  const p = linePortions(menu, cfg);
  const noodle = cfg.noodleType ? p.noodleHalfUnits * bom.noodleHalfBall[cfg.noodleType] : 0;
  return noodle + p.wantonCount * bom.wanton + p.charSiewPortions * bom.charSiewPortion + bom.base[cfg.productKind];
}
