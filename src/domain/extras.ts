/**
 * 下单后加料（加叉烧、加云吞）：一份加料是同一桌账单上的一张小单，有自己的票号和厨单，原单金额不变。
 * 这里是 POS 和服务器共用的规则：哪一碗能加什么、加料行长什么样、厨房怎么知道给哪一碗。
 */
import { LineConfig, lineNameZh } from './lineItem';
import { AddOnId, MenuVersion, NOODLE_TYPE_NAMES, productOf, ServiceMode, SERVICE_MODE_NAMES, Spice } from './menu';
import { PICTOGRAMS } from './pictograms';

/** 一份加料的单行配置：不含面和酱，只有一个加料。 */
export function extraConfig(addOn: AddOnId): LineConfig {
  return {
    productKind: 'extra', size: 'one', noodleType: null, sauce: null, spice: null, lard: null,
    scallion: 'normal', isKosong: false, addOns: [addOn], note: '',
  };
}

export type ExtraBlock = 'kosong' | 'not_on_product' | 'is_extra';

/** 这一碗能不能加这种料；不能时说明原因（规则和下单时一样：净面不加肉，每种餐品只配自己的加料）。 */
export function extraBlockReason(menu: MenuVersion, bowl: Pick<LineConfig, 'productKind' | 'isKosong'>, addOn: AddOnId): ExtraBlock | null {
  if (bowl.productKind === 'extra') return 'is_extra';
  if (bowl.isKosong && menu.addOns[addOn].isMeat) return 'kosong';
  if (!productOf(menu, bowl.productKind).addOns.includes(addOn)) return 'not_on_product';
  return null;
}

/** 厨房看的「给哪一碗」。Firestore 里存的就是这句话，所以不随界面语言变化。 */
export function extraNote(menu: MenuVersion, bowl: LineConfig & { serviceMode?: ServiceMode }): string {
  const spice = bowl.spice as Spice | null;
  const parts = [
    lineNameZh(menu, bowl),
    bowl.noodleType ? NOODLE_TYPE_NAMES[bowl.noodleType].zh : null,
    spice ? PICTOGRAMS[`spice:${spice}`].zh : null,
    bowl.note || null,
    bowl.serviceMode === 'takeaway' ? SERVICE_MODE_NAMES.takeaway.zh : null,
  ];
  return `给 ${parts.filter(Boolean).join(' · ')}`.slice(0, 80);
}
