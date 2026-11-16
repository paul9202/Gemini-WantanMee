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
    id: '2026-11-16-review-clears', date: '2026-11-16', roles: FRONT,
    title: { zh: '老板核对过的离线记录，收银机会自己清掉', en: 'Offline records the owner has reviewed now clear on the register' },
    items: [
      { zh: '以前老板在老板页把「待核对」处理完，收银机上还一直写「X 条待老板核对」。现在收银机每 5 分钟会问一次，按「立即同步」马上问，处理过的就不再算。', en: 'Before, the register kept showing “X need owner review” even after the owner handled them. It now checks every 5 minutes (or right away with Sync now) and drops the handled ones.' },
      { zh: '同步中心会写「老板已核对，已补入账」或「老板已核对，不入账」。', en: 'The sync center shows “reviewed, entered” or “reviewed, not entered”.' },
    ],
  },
  {
    id: '2026-11-16-slip-spacing', date: '2026-11-16', roles: FRONT,
    title: { zh: '送餐单大字不再压住下一行', en: 'Large text on order slips no longer overlaps the next line' },
    items: [
      { zh: '品名、合计这些大字的下一行，以前在有的打印机上会压在大字下半截，现在会多留一点空。', en: 'On some printers the line under large text (dish names, total) overlapped it; slips now leave more room.' },
      { zh: '还压着的话，在打印机面板或试打印页头把「行距」改成「加大」。测试条多了一个问题专门看这个。', en: 'If it still overlaps, set Line spacing to Wide in the printer panel or at the top of Test print. The test strip now has a question for this.' },
    ],
  },
  {
    id: '2026-11-16-printer-trial', date: '2026-11-16', roles: FRONT,
    title: { zh: '送餐单打印机可以先试打：打假单，不碰真单', en: 'Test the slip printer first: test slips only, no real orders' },
    items: [
      { zh: '主收银平板：设备 → 送餐单打印机 → 试打印。可以打测试条、9 种样单（堂食、打包、要求很多、断网单……）、连打 5 张、断开再连。屏幕上先看得到纸上会打成什么样。', en: 'Main register: Device → Order slip printer → Test print. Print a test strip, 9 kinds of sample slip (dine-in, takeaway, many requests, offline…), 5 in a row, and a disconnect drill. The screen shows what the paper will look like first.' },
      { zh: '打出来的都写着「测试 · 不用做」，牌号 81–89：不进订单、不算营业额、不占牌号，后厨屏看不到。设置里的「送餐单打印」还没打开也能试，收银下单不会打印。', en: 'Test slips say “测试 · 不用做” (test, don’t make) and use tokens 81–89: no orders, no sales, no tokens, nothing on the kitchen screen. Works before slip printing is switched on in Settings; real orders do not print.' },
      { zh: '测试条打完会问 5 个问题，纸宽、行距、切纸选错了一键改好再打。试打清单 8 项都过了，再去设置里打开送餐单打印。', en: 'After the test strip, 5 questions catch a wrong paper width, line spacing or cutter setting and fix it in one tap. When all 8 checklist items pass, switch slip printing on in Settings.' },
    ],
  },
  {
    id: '2026-11-16-kitchen-edit', date: '2026-11-16', roles: ALL,
    title: { zh: '后厨屏上可以直接改单、取消', en: 'Edit or cancel an order right on the kitchen screen' },
    items: [
      { zh: '还没出餐的单，卡片右上角有「改单」：加减碗数、换面、换酱、改大小、辣度、油渣、葱、加料、堂食打包，删一碗、加一碗都可以。改完卡片留在原来的位置，不会排到最后。30 秒内可以撤回。', en: 'Unserved tickets have an Edit button (top right): change bowl counts, noodles, sauce, size, chili, lard, scallion, extras, dine-in/takeaway, remove or add a bowl. The ticket keeps its place in the queue. Undo within 30 seconds.' },
      { zh: '「两碗里只改一碗」按「其中 1 碗不一样」；面薄卖完了，一下把这张单的面薄全换细面。', en: '“Make 1 bowl different” changes just one of two bowls; one tap switches all mee pok on the ticket to thin noodles.' },
      { zh: '改单页里有「取消整单」：选为什么、做了没有，按了就取消，不用等前台。没付钱的单不用收；已经付了的，请老板在订单页退款。', en: '“Cancel order” in the edit page asks why and whether it was cooked, then cancels right away. Unpaid orders need nothing more; paid ones are refunded by the owner on Orders.' },
      { zh: '收银机的待收款会自动换成新的金额，写着后厨几点改了什么。前台已经收了钱的单改了金额，会提示要退给客人或补收多少。', en: 'The front’s unpaid list updates to the new amount and shows what the kitchen changed. If the order was already paid, it shows how much to refund or collect.' },
    ],
  },
  {
    id: '2026-11-15-today-lighter', date: '2026-11-15', roles: ['owner'],
    title: { zh: '今天页打开更快、更省', en: 'Today page opens faster and reads less' },
    items: [
      { zh: '打开今天页只读最近两个星期的记录。近 30 天、收档小结、细账里的回本进度，要点一下才去读。', en: 'Today now reads only the last two weeks. The last 30 days, the closing summary and payback progress in Details load when you tap them.' },
    ],
  },
  {
    id: '2026-11-15-labor', date: '2026-11-15', roles: ['owner'],
    title: { zh: '成本里可以填请人的工钱，随时能改', en: 'Staff wages can now be set in Costs, and changed any time' },
    items: [
      { zh: '到「成本 · 请人工钱」填每天或每月多少钱。改工钱从你选的那天起算，之前的日子还按旧工钱，算过的「赚了多少」不会变。', en: 'Set a daily or monthly wage in Costs · Staff wages. A change starts from the day you pick; earlier days keep the old wage, so past profit does not change.' },
      { zh: '可以换人、同时请两个人、记某天没来（那天不算工钱），也可以从日薪改成月薪。', en: 'You can replace someone, have two helpers, mark a day someone did not come (no wage that day), or switch from daily to monthly pay.' },
      { zh: '「今天」页的「赚了多少」多一行「工钱」，和租金电费一样单独列出；近 7 天、近 30 天和账目也一起扣。', en: 'Profit on Today now has its own wages line, like rent and power; the 7- and 30-day cards and Accounts deduct it too.' },
    ],
  },
  {
    id: '2026-11-14-recent-days', date: '2026-11-14', roles: ['owner'],
    title: { zh: '今天页加了「最近的生意」：近 7 天和近 30 天', en: 'Today now shows recent business: last 7 and 30 days' },
    items: [
      { zh: '近 7 天、近 30 天各一张卡：收入、约赚、日均、单数碗数粒面、最好的一天、卖最多，还会和前一段比多了还是少了。', en: 'One card each for the last 7 and 30 days: income, estimated profit, daily average, orders, bowls and noodle balls, best day, top seller, and how it compares with the period before.' },
      { zh: '下面的柱子是每天收入，点卡片换 7 天或 30 天，点柱子就看那一天。开档前的日子不算。', en: 'The bars below show income per day. Tap a card to switch between 7 and 30 days, or tap a bar to open that day. Days before opening are not counted.' },
    ],
  },
  {
    id: '2026-11-14-auto-close', date: '2026-11-14', roles: ['owner'],
    title: { zh: '不用再手动日结，系统每天自动关账', en: 'No more manual day close — the system closes each day automatically' },
    items: [
      { zh: '每天凌晨 5 点，系统自动把前一天的账关掉。还没登记的收款、离线待核对会写明结转，之后补登记照样算。', en: 'Every day at 5 am the system closes the previous day. Unregistered payments and offline items to review are carried forward with a note, and later registrations still count.' },
      { zh: '今天页不再显示「收档日结」和日结提醒。想提前关账或做更正，还可以到「账目 · 日结（自动）」。', en: 'Today no longer shows the close-day button or reminder. To close early or make a correction, go to Accounts · Close day (auto).' },
    ],
  },
  {
    id: '2026-11-14-offline-renew', date: '2026-11-14', roles: FRONT,
    title: { zh: '断线时离线接的单，不会再被卡进「待老板核对」', en: 'Orders taken offline no longer get stuck in “To review”' },
    items: [
      { zh: '主收银机有网时会自动续期离线营业资格（每次续 24 小时），不用再重新开班。以前班次一直不关，资格过期后断线接的单都要老板逐条核对。', en: 'The main register now renews its offline allowance (24 hours) automatically while online — no need to reopen the shift. Before, if the shift stayed open for days, orders taken during an outage all needed the owner to review them.' },
      { zh: '真的断网超过 24 小时时，收银页会直接提示改用纸单，而不是照样接单、同步后才发现问题。', en: 'If the register really is offline for more than 24 hours, it now tells you to use paper tickets straight away instead of taking orders that fail later.' },
    ],
  },
  {
    id: '2026-11-14-owner-today', date: '2026-11-14', roles: ['owner'],
    title: { zh: '「经营」改成今天、用料、成本、账目四页', en: 'Owner pages are now Today, Ingredients, Costs and Accounts' },
    items: [
      { zh: '「今天」一打开就看到：卖了多少、大约赚了多少、用了多少料。赚多少下面写清楚收入减材料、减租金电费。', en: '“Today” shows at a glance how much you sold, roughly how much you made, and what you used. The profit card shows income minus ingredients minus rent and power.' },
      { zh: '每天卖了几粒面（细面 / 面薄 × 大中小）、几粒云吞、几份叉烧、几碗汤、几份打包，全部从订单算出来，不用另外记。「用料」页写着每样怎么算，还有近 7 天的面团粒数对比目标。', en: 'Noodle balls (thin / mee pok × size), wantons, char siew portions, soups and takeaways are all counted from orders — nothing extra to record. “Ingredients” shows how each is counted and the last 7 days of noodle balls against your target.' },
      { zh: '「成本」页列出每样材料的单价、今天的料花了多少，以及每个菜每个大小赚多少。改单价还是在设置里。', en: '“Costs” lists each ingredient’s unit cost, what today’s ingredients cost, and how much each dish and size earns. Unit costs are still changed in Settings.' },
      { zh: '日结和待核对移到「账目」里，今天页的提醒也能直接进去。', en: 'Close day and To review are now under “Accounts”, and Today’s reminders link straight to them.' },
      { zh: '没时间记成本？在「成本」页按「让 AI 估价」，AI 按收据价和柔佛一般批发价先估每样材料的单价。估的价钱标黄，按「对」或改一个数才会用；拍过的进货单会算出收据价，可以一键改用。', en: 'No time to track costs? On “Costs”, tap “Let AI estimate” and AI suggests each ingredient’s unit cost from your receipts and typical Johor wholesale prices. Suggestions are highlighted and only used after you tap “OK” or change the number; receipts you photographed give a receipt price you can switch to in one tap.' },
      { zh: '「用料」页会估面团、面薄、肉碎、云吞皮还剩多少、够不够明天，不够就在今天页提醒。收档时可以点一下实际剩多少，让剩余更准。', en: '“Ingredients” estimates how much noodle dough, mee pok, minced pork and wanton skin is left and whether it’s enough for tomorrow; Today warns you when it isn’t. Count what’s left at closing to make it more accurate.' },
      { zh: '今天页最下面有收档小结：今天卖得怎样、什么好卖、明天建议备多少。可以让 AI 写成白话，数字全部来自账本。', en: 'Today ends with a closing summary: how the day went, what sold best, and what to prepare tomorrow. AI can write it in plain words; all numbers come from your records.' },
    ],
  },
  {
    // 送餐单打印的开关还关着，只有老板会用到打印机面板。
    id: '2026-11-14-printer-58mm', date: '2026-11-14', roles: ['owner'],
    title: { zh: '送餐单打印支持 58mm 手撕的便携打印机', en: 'Order slips work with 58mm tear-off portable printers' },
    items: [
      { zh: '打印机面板多了「切纸：手撕 / 自动切刀」，纸宽和切纸默认是 58mm、手撕。用 80mm 带切刀的台式机，就在面板里改成 80mm、自动切刀。', en: 'The printer panel has a new “Cutting: Tear / Auto cutter” choice; paper width and cutting default to 58mm and Tear. For an 80mm desktop printer with a cutter, change them to 80mm and Auto cutter in the panel.' },
      { zh: '测试条上会印出纸宽和切纸方式，还有一句提示：虚线断成两行，就是纸宽选错了。连接说明也写上了便携机要一直插电、多备纸卷。', en: 'The test strip now prints the paper width and cutting mode, with a hint: if the dashed line breaks onto two lines, the paper width is wrong. “How to connect” now says to keep a portable printer plugged in and to keep spare rolls.' },
    ],
  },
  {
    // 总开关默认关着，收银现在看不到任何变化，所以先只给老板看；打开、员工要用时再补一条给收银。
    id: '2026-11-13-runner-slip', date: '2026-11-13', roles: ['owner'],
    title: { zh: '新增送餐单打印（默认关着）', en: 'New: order slip printing (off by default)' },
    items: [
      { zh: '设置里新增「送餐单打印」总开关，默认关着，关着时收银和后厨都没有任何变化。打印机到货后，先看设置里的「连接说明」，再打开开关，到主收银平板的「设备」页连接蓝牙打印机。', en: 'Settings has a new “Order slip printing” switch. It is off by default, and nothing changes for cashiers or the kitchen while it is off. When the printer arrives, read “How to connect” in Settings, turn the switch on, then connect the Bluetooth printer on the main register’s Device page.' },
      { zh: '连好后，每下一单，出餐口就打出一张送餐单：牌号、堂食或打包、每碗是什么、每行金额和合计。纸单不写付没付，客人付没付看后厨卡片。', en: 'Once connected, every order prints a slip at the pass: token, dine-in or takeaway, each bowl, line amounts and the total. The slip does not say whether it is paid — check the kitchen card for that.' },
      { zh: '同牌加单、吃完再加、加料各有一句说明；断网时打的是「断网单」，厨师照纸单做。', en: 'Same-token add-ons, later add-ons and extras each carry a note; when offline it prints an “offline slip” for the cook to work from.' },
      { zh: '打印机没连、断开或没纸都不影响下单。页头会显示打印机状态，没打出来的单可以在打印机面板里补打。', en: 'Ordering never waits for the printer. The header shows the printer status, and slips that did not print can be reprinted from the printer panel.' },
    ],
  },
  {
    id: '2026-11-12-no-char-siew', date: '2026-11-12', roles: ALL,
    title: { zh: '新增「不要叉烧」', en: 'New option: no char siew' },
    items: [
      { zh: '点干捞面或汤面时，「特别要求」里多了「不要叉烧」：云吞照放，价钱不变。可以和「不要番茄酱」一起选。', en: 'Dry and soup noodles have a new “No char siew” special request: wantan stay, the price is the same. It can be combined with “No tomato sauce”.' },
      { zh: '「不要叉烧」和「加叉烧」只能选一个，按了一个另一个自动取消；净面本来就没有叉烧，按钮会灰掉。', en: '“No char siew” and “Extra char siew” cancel each other; the button is greyed out for kosong, which has no char siew anyway.' },
      { zh: '后厨每碗用黄色大条写「不要叉烧 · 云吞照放」，顶部合计显示「其中不要叉烧 N 份」。', en: 'The kitchen shows a yellow “No char siew · wantan as usual” bar on the bowl and “incl. no char siew N” in the totals.' },
      { zh: '客人后来又要叉烧，照样可以下单后加叉烧，后厨的小单不会再写「不要叉烧」。', en: 'If the customer changes their mind, extra char siew can still be added after ordering; the kitchen slip will not say “no char siew”.' },
    ],
  },
  {
    id: '2026-11-12-kosong-price', date: '2026-11-12', roles: ALL,
    title: { zh: '净面价格可以自己改', en: 'Kosong prices can now be set' },
    items: [
      { zh: '老板在「设置 → 菜单与价格」可以单独设定净面价（小 / 中 / 大），不再固定半价。', en: 'In Settings → Menu & prices the owner can set the kosong price for small / medium / large; it is no longer fixed at half price.' },
      { zh: '只改正价时净面价不变；净面价不能高于同份量的正价。', en: 'Changing the normal price leaves the kosong price as it is; kosong cannot cost more than the normal price.' },
    ],
  },
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
