/**
 * 更新记录：给员工和老板看的功能改动，随版本一起发布，断网也能看。每次上线用户能感知的改动都在最前面加一条。
 * 只写用户看得懂的话，不写技术细节；roles 决定谁看到（后厨不用看收款的改动）。
 */
export type ChangelogRole = 'owner' | 'cashier' | 'kitchen';

export interface ChangelogEntry {
  /** 稳定 ID，记录「看到哪一条」用，发布后不要改。 */
  id: string;
  /** 上线日期 YYYY-MM-DD。 */
  date: string;
  roles: ChangelogRole[];
  title: { zh: string; en: string };
  items: { zh: string; en: string }[];
}

const ALL: ChangelogRole[] = ['owner', 'cashier', 'kitchen'];
const FRONT: ChangelogRole[] = ['owner', 'cashier'];
const BACK: ChangelogRole[] = ['owner', 'kitchen'];

/** 最新的在最前面。 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-11-08-pay-on-serve', date: '2026-11-08', roles: ALL,
    title: { zh: '出餐即记收款，后厨显示每单金额', en: 'Payment recorded at serve; kitchen cards show each order’s amount' },
    items: [
      { zh: '老板在「设置」打开「出餐即记收款」后才生效：后厨按「完成出餐」，没收款的单自动记为已收款；30 秒内撤回出餐，收款也一起撤回。开关默认关着。', en: 'Takes effect only after the owner turns on “Record payment at serve” in Settings: when the kitchen taps Serve, an unpaid order is recorded as paid; undoing a serve within 30 seconds also undoes the payment. It is off by default.' },
      { zh: '后厨卡片在牌号旁写这张单要收多少钱，同一桌的框上写「合计」；客人先付了的写「已付 · 不用收」。', en: 'Kitchen cards show the amount to collect next to the token number, and a same-table frame shows the total. Orders already paid at the counter say “Paid · don’t collect”.' },
      { zh: '客人当场付钱，收银一定要点「确认已收款」；订单页分开显示「出餐已记收款」和「前台已确认收款」。', en: 'If the customer pays on the spot, the cashier must still tap Confirm received. The Orders page shows “Recorded at serve” and “Confirmed at counter” separately.' },
      { zh: '客人没付就走了：老板在订单页按一下，就把这笔收款撤回并记为放弃追收。', en: 'Customer left without paying: the owner taps one button on the Orders page to reverse the payment and write it off.' },
      { zh: '日结把前台确认和出餐自动记的收款分开显示，请和钱箱现金加 QR 到账对一下。', en: 'The daily close lists counter-confirmed and serve-recorded payments separately — check them against the cash drawer and QR receipts.' },
    ],
  },
  {
    id: '2026-11-06-extras', date: '2026-11-06', roles: ALL,
    title: { zh: '下单后也能加叉烧、加云吞', en: 'Add char siew or wantan after ordering' },
    items: [
      { zh: '收银点「＋加料」找到这桌，选给哪一碗；原单不变，加料算在同一桌的账上。', en: 'Tap + Extra, find the table and pick the bowl. The original order stays the same, and the extra goes on the same table’s bill.' },
      { zh: '后厨有横幅和提示音；那碗没出就放进碗里或小碟一起送，出了就小碟单独送。', en: 'The kitchen gets a banner and chime. If the bowl is not out yet, add it to the bowl or send a small plate with it; if it is out, send a small plate on its own.' },
      { zh: '净面不能加肉，断网时不能加料。', en: 'Kosong bowls cannot add meat, and extras cannot be added while offline.' },
    ],
  },
  {
    id: '2026-11-06-no-tomato', date: '2026-11-06', roles: ALL,
    title: { zh: '红酱可以「不要番茄酱」', en: 'Red sauce can be made without tomato sauce' },
    items: [
      { zh: '客人只要辣椒不要番茄酱：收银在「特别要求」点「不要番茄酱」。只有红酱能选，价钱不变。', en: 'For customers who want chili but no tomato sauce, tap No tomato sauce under Special requests. Red sauce only; the price stays the same.' },
      { zh: '后厨卡片上有黄色横幅「红酱 · 不要番茄酱」，顶部合计也写「其中不要番茄酱几份」。', en: 'Kitchen cards show a yellow banner, and the top totals show how many have no tomato sauce.' },
      { zh: '这是口味要求，不是过敏保证。', en: 'This is a taste preference, not an allergy promise.' },
    ],
  },
  {
    id: '2026-11-06-updates-page', date: '2026-11-06', roles: ALL,
    title: { zh: '新增「更新」页', en: 'New Updates page' },
    items: [
      { zh: '最新的功能和改动都列在这里。有新内容时页面上方会提示，点「知道了」就不再提示。', en: 'New features and changes are all listed here. A notice appears at the top when there is something new; tap Got it to dismiss it.' },
    ],
  },
  {
    id: '2026-11-06-noodle-type', date: '2026-11-06', roles: BACK,
    title: { zh: '后厨一眼分清细面和面薄', en: 'Thin noodles and mee pok are easy to tell apart' },
    items: [
      { zh: '每一行先显示面种：面薄是蓝底大字，细面是边框样式。', en: 'Each line starts with the noodle type: mee pok in big text on blue, thin noodles in an outlined box.' },
      { zh: '有面薄的卡片在号码旁标出「面薄 ×几碗」。', en: 'Cards with mee pok show “Mee pok ×n” next to the token number.' },
      { zh: '卡片底部的合计分开写细面和面薄；有面薄在做时，顶部的面薄统计变蓝。', en: 'Card totals list thin noodles and mee pok separately, and the top mee pok count turns blue while any is cooking.' },
    ],
  },
  {
    id: '2026-11-06-table-bill', date: '2026-11-06', roles: FRONT,
    title: { zh: '同一桌合并算钱', en: 'One bill per table' },
    items: [
      { zh: '同一张餐牌这一轮的单算一桌，一个按钮收齐，已收的不会再收。', en: 'Orders on one token in the same round count as one table. One button collects them all, and anything already paid is not collected again.' },
      { zh: '订单页显示这桌已收多少、还要收多少。', en: 'The Orders page shows how much this table has paid and how much is still due.' },
      { zh: '新增「整桌收据」，一张纸列出这桌所有的单。', en: 'New table receipt: every order for the table on one slip.' },
      { zh: '牌空出来 30 分钟内，在餐牌里手动选这个号时，如果上一桌还没收款会有提示：同一桌就点「并到一起算」，不点就当新客人。', en: 'Within 30 minutes of a token freeing up, hand-picking it shows a notice if the previous order is still unpaid. Tap Bill together if it is the same table; otherwise ignore it.' },
    ],
  },
  {
    id: '2026-11-06-queue-kitchen', date: '2026-11-06', roles: BACK,
    title: { zh: '加单排回原位，不重新排队', en: 'Add-ons keep the table’s place in the queue' },
    items: [
      { zh: '同一桌加的单直接排到这桌原来的位置，放在同一个框里，可以「全部出餐」和「全部撤回」。', en: 'An add-on joins its table’s original place in the same frame, with Serve all and Undo all.' },
      { zh: '有加单时页面上方有横幅，提示音响 3 次；这桌的单全部出餐后再加才排队尾。', en: 'A banner and three chimes announce an add-on. It only goes to the back of the queue if the table’s orders are all served.' },
      { zh: '修好提示音失效的问题，屏幕保持常亮，后厨屏也有「更新并重新载入」按钮了。', en: 'Fixed the chime going silent, the screen stays on, and the kitchen screen now has an Update & reload button.' },
    ],
  },
  {
    id: '2026-11-06-queue-register', date: '2026-11-06', roles: FRONT,
    title: { zh: '加单排回原位，不重新排队', en: 'Add-ons keep the table’s place in the queue' },
    items: [
      { zh: '点占用中的号加单，后厨会把这张单排到这桌原来的位置。', en: 'Adding on an occupied token puts the order in the table’s original place in the kitchen.' },
      { zh: '要换别的：先在这个号加新单，再取消旧单，新单才不会排到最后。取消原因多了「改单」。', en: 'To change an order, add the new one on the token first, then cancel the old one, so the new one keeps its place. Cancel reasons now include Changing order.' },
    ],
  },
  {
    id: '2026-11-05-same-token', date: '2026-11-05', roles: ALL,
    title: { zh: '同牌加单：不用另发号牌', en: 'Add on the same token without a new one' },
    items: [
      { zh: '客人还要加一碗，或朋友来了再点：在餐牌里点占用中的号，选「在 N 号加单」。', en: 'Customer wants one more bowl, or a friend joins: tap the occupied number in the token picker and choose Add on token N.' },
      { zh: '这张牌上的单全部出餐或取消后，牌才空出来给下一位客人。', en: 'A token frees up only after all its orders are served or cancelled.' },
    ],
  },
  {
    id: '2026-11-04-four-wontons', date: '2026-11-04', roles: ALL,
    title: { zh: '小、中、大云吞面都是 4 粒云吞', en: 'Small, medium and large all come with 4 wantan' },
    items: [
      { zh: '价钱不变，「加 3 粒」还是 3 粒。', en: 'Prices are unchanged, and the +3 wantan add-on is still 3.' },
    ],
  },
  {
    id: '2026-10-31-clear-data', date: '2026-10-31', roles: ['owner'],
    title: { zh: '清空测试数据可以多次使用', en: 'Clear test data can be used more than once' },
    items: [
      { zh: '没有时间限制，只要输入店主 IC。', en: 'No time limit; it only needs the owner’s IC.' },
    ],
  },
  {
    id: '2026-10-30-spice', date: '2026-10-30', roles: ALL,
    title: { zh: '干捞面和干捞云吞每碗都显示辣度，「普通」改叫「辣」', en: 'Spice shows on every dry bowl; Normal is now Spicy' },
    items: [
      { zh: '辣度选项是 不辣 / 少辣 / 辣 / 加辣。', en: 'Spice options are No chili, Less, Spicy and Extra.' },
      { zh: '后厨屏、订单页、购物车、收据都写清楚，默认的「辣」也写。汤类没有辣度。', en: 'The kitchen screen, Orders page, cart and receipt show it, including the default Spicy. Soups have no spice level.' },
    ],
  },
  {
    id: '2026-10-25-ai-cost', date: '2026-10-25', roles: ['owner'],
    title: { zh: 'AI 记成本', en: 'AI cost entry' },
    items: [
      { zh: '用文字或拍收据记一笔，先看可修改的草稿，确认后整单入账。', en: 'Record a cost by text or receipt photo, check an editable draft, then save the whole entry.' },
      { zh: '开销分析：统计来自账本记录，AI 只负责解释。', en: 'Spending analysis: the figures come from the ledger; AI only explains them.' },
    ],
  },
  {
    id: '2026-10-25-finance', date: '2026-10-25', roles: ['owner'],
    title: { zh: '收支改版', en: 'Money pages redesigned' },
    items: [
      { zh: '分成收支总览、食材与用料、日常开支、经营目标、开档成本五页。', en: 'Now five pages: overview, ingredients, daily expenses, goals and startup costs.' },
      { zh: '回本和经营目标按真实账目计算，资料不全时显示待核算。', en: 'Payback and goals use real records, and show as pending when data is incomplete.' },
    ],
  },
];

export function entriesFor(role: ChangelogRole, list: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  return list.filter((e) => e.roles.includes(role));
}

/** 比 seenId 新的条目（list 最新在前）。没看过或那条已不在列表里：全部算新。 */
export function unseenEntries(list: ChangelogEntry[], seenId: string | null): ChangelogEntry[] {
  const at = seenId === null ? -1 : list.findIndex((e) => e.id === seenId);
  return at < 0 ? list : list.slice(0, at);
}
