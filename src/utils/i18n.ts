/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Language = 'zh' | 'en';

export const translations = {
  zh: {
    // Brand & App
    appName: '笨珍云吞面',
    appSubtitle: '传统黑白红面 · 现炸猪油渣 · 智能档口运营系统',
    brandTag: 'PONTIAN',
    statusOpen: '营业中',

    // Navigation
    navPos: 'POS 点单端',
    navKds: '头手 KDS',
    navAnalytics: '老板财务',
    navAnalyticsShort: '看板',
    soundOnTitle: '已开启厨房出餐提铃声',
    soundOffTitle: '已静音',
    cloudConfig: '云端配置',
    resetDemo: '重置演示',

    // Order Mode
    step1Title: '步骤 1 · 就餐方式与餐牌号',
    dineIn: '🍽️ 堂食 (按餐牌)',
    takeaway: '🛍️ 打包 (按餐牌)',
    takeawayNoSoup: '打包免汤 (No Soup for Takeaway)',
    takeawayNoSoupNotice: '⚠️ 打包免汤 (No Soup Included)',
    tokenLabel: '发放餐牌号码 (1 ~ 50号，堂食与打包顾客均持牌):',
    mealTokenPrefix: '餐牌 #',
    numberUnit: '号',
    tokenStand: '餐牌',

    // Dish Category
    step2Title: '步骤 2 · 餐品与份量',
    catDryNoodle: '🍜 招牌干捞面',
    catSoupNoodle: '🥣 云吞汤面',
    catDryWanton: '🥢 招牌干捞云吞',
    catSoup: '🥟 鲜肉云吞汤',

    // Noodle Sizes
    noodleBalls: '粒面',
    sizeSmall: '小碗',
    sizeMedium: '中碗',
    sizeLarge: '大碗',
    size10pcs: '10 粒装',
    size15pcs: '15 粒装',
    freshWantonsDesc: '粒手工现包鲜肉云吞',
    noodleSmallDesc: '1 粒面 · 标准叉烧 · 3 粒云吞',
    noodleMediumDesc: '1.5 粒面 · 标准叉烧 · 3 粒云吞',
    noodleLargeDesc: '2 粒面 · 标准叉烧 · 4 粒云吞',

    // Sauces
    step3Title: '步骤 3 · 笨珍灵魂酱料 (Mandatory Sauce)',
    sauceBlack: '黑酱 (Black Soy)',
    sauceWhite: '白酱 (White Pork Lard)',
    sauceRed: '红酱 (Pontian Chili Tomato)',
    sauceSoup: '面汤 (Clear Soup)',
    sauceBlackDesc: '秘制古早黑酱油，咸香浓郁',
    sauceWhiteDesc: '香脆新鲜猪油渣+纯白胡椒葱油',
    sauceRedDesc: '笨珍正宗招牌番茄甜辣红酱',
    sauceSoupDesc: '老母鸡江鱼仔慢火熬制清甜大骨汤',

    // Soup notice for Step 4 & 5
    soupNotice: '🥣 老母鸡大骨高汤熬制 · 纯正清甜鲜味 · 自动免选辣度与猪油渣',

    // Spiciness
    step4Title: '步骤 4 · 辣度选择 (必问顾客口味)',
    currentSelection: '当前选择',
    spiceNone: '🟢 不辣',
    spiceLess: '🟡 少辣',
    spiceNormal: '🟠 普通辣',
    spiceExtra: '🔴 加辣 🔥',
    spiceNoneSub: '清香原味',
    spiceLessSub: '微提鲜味',
    spiceNormalSub: '笨珍招牌辣',
    spiceExtraSub: '香辣浓厚',

    // Modifiers & Add-ons
    step5Title: '步骤 5 · 猪油渣、葱花与加料 (Lard, Scallions & Add-ons)',
    kosongBanner: '⚡ Kosong 净面 (严格半价 50%)',
    kosongSub: '无叉烧 · 无云吞 · 省成本',
    kosongDesc: '头手抓面时不抓云吞；系统自动按半价结算并扣减肉类理论食材成本',
    kosongBadge: 'Kosong 净面',
    kosongKitchenWarning: '【⚡ KOSONG 净面 · 无叉烧 · 严禁放云吞！】',

    lardCustom: '🥓 猪油渣定制:',
    lardNormal: '正常猪油渣',
    lardExtra: '+ 加多猪油渣',
    lardNone: '🚫 走猪油渣 (不要油渣)',
    lardNormalFull: '正常现炸猪油渣',
    lardExtraFull: '🌟 加多猪油渣 (香脆满溢)',
    lardNoneFull: '🚫 走猪油渣 (不要油渣)',

    scallionCustom: '🌱 葱花定制:',
    scallionNormal: '正常葱花',
    scallionExtra: '+ 多葱花',
    scallionNone: '🚫 走青 (不要葱)',

    addonsTitle: '✨ 加料专区 (Add-ons):',
    addCharSiew: '🥩 +加叉烧 (+RM 2.00)',
    addCharSiewDesc: '柔佛传统红曲香烤叉烧',
    addWanton: '🥟 +加云吞 (+3粒 +RM 2.00)',
    addWantonDesc: '纯正新鲜前腿肉现包云吞',

    addToCart: '加入当前订单 (Add to Cart)',
    currentEstimate: '当前单品预估:',
    bomFoodCost: '理论食材成本',

    // Cart & Summary
    cartTitle: '当前点餐清单 (Cart)',
    cartEmpty: '购物车空空如也',
    cartEmptyDesc: '在左侧点击份量、酱汁与口味后，点击下方「加入当前订单」',
    cartTotalAmount: '应收总额 (Total)',
    itemsCount: '项餐品',
    clearCart: '清空',
    paymentMethod: '收款结算方式:',
    payCash: '💵 现金支付',
    payQr: '📱 DuitNow QR 转账',
    sendToKds: '⚡ 一键下单送后厨 (Send to KDS)',
    cartSummaryNoodles: '面球',
    cartSummaryWantons: '粒云吞',

    // KDS
    batchAssistantTitle: '合单抓面助手 (Batch Assistant)',
    pendingOrdersCount: '单待做',
    batchSubtitle: '大锅下水前快速看总数 · 云吞总数已自动剔除 Kosong 净面',
    undoLastOrder: '↩ 撤回上一单',
    totalNoodleBallsToBoil: '🔥 待下面条总数',
    totalWantonsToBoil: '🥟 待煮云吞总数',
    tasteSummary: '口味汇总:',
    blackSauceAbbr: '黑酱',
    redSauceAbbr: '红酱',
    whiteSauceAbbr: '白酱',
    soupSauceAbbr: '面汤',
    allOrdersCompleted: '所有待做订单已完成出餐！',
    allOrdersCompletedDesc: '当前暂无待煮面条。新点单送达时，系统将发出清晰提示铃声并即时显示在屏幕上方。',
    elapsedTime: '已用时',
    completeOrderBtn: '✅ 完成出餐 (Tap to Complete)',
    completedOrdersTiming: '已出餐用时',
    speedLightning: '⚡ 极速出餐 (<4分)',
    speedNormal: '🟢 正常出餐 (4-8分)',
    speedSlow: '🟡 稍慢提醒 (8-12分)',
    speedOverdue: '🔴 严重超时 (>12分)',
    avgSpeed: '均速',
    onTimeRate: '达标率',

    // Receipt
    receiptStallName: '笨珍传统云吞面',
    receiptSub: 'PONTIAN WANTON NOODLE STALL',
    receiptTagline: '柔佛笨珍老街坊 · 纯正猪油现炸香脆',
    orderDurationLabel: '⏱️ 出餐用时:',
    orderWaitingLabel: '⏳ 当前已等候:',
    subtotal: '小计',
    totalDue: '总额',
    printReceipt: '打印收据 (Print)',
    close: '关闭',
    thankYou: '多谢惠顾 · 欢迎下次光临！',

    // Analytics
    analyticsTitle: '老板经营财务与效率看板',
    timeframeDaily: '今日实况 (Daily)',
    timeframeWeekly: '近7天 (Weekly)',
    timeframeMonthly: '近30天 (Monthly)',
    tabPnl: '📊 损益与利润',
    tabSpeed: '⏱️ 出餐效率统计',
    tabExpenses: '📝 进货支出记录',
    tabWastage: '🗑️ 报损损耗',
    totalRevenue: '总营业额 (Revenue)',
    estimatedNetProfit: '预估净利润 (Net Profit)',
    grossMargin: '毛利率 (Margin)',
    totalBowlsSold: '总售出碗数',
    cashRatio: '现金占比',
    qrRatio: '电子钱包占比',
  },
  en: {
    // Brand & App
    appName: 'Pontian Wanton Mee',
    appSubtitle: 'Authentic Black, White & Red Sauce · Fresh Crispy Pork Lard · Smart Hawker Ops',
    brandTag: 'PONTIAN',
    statusOpen: 'OPEN',

    // Navigation
    navPos: 'POS Cashier',
    navKds: 'Chef KDS',
    navAnalytics: 'Boss Analytics',
    navAnalyticsShort: 'Analytics',
    soundOnTitle: 'Kitchen Chime Enabled',
    soundOffTitle: 'Muted',
    cloudConfig: 'Cloud Sync',
    resetDemo: 'Reset Demo',

    // Order Mode
    step1Title: 'STEP 1 · Dining Mode & Meal Token Stand',
    dineIn: '🍽️ Dine-In (Stand)',
    takeaway: '🛍️ Takeaway (Stand)',
    takeawayNoSoup: 'Takeaway: No Soup',
    takeawayNoSoupNotice: '⚠️ Takeaway: No Soup Included',
    tokenLabel: 'Assign Meal Token Number (1 - 50, for Dine-In & Takeaway):',
    mealTokenPrefix: 'Stand #',
    numberUnit: '',
    tokenStand: 'Stand',

    // Dish Category
    step2Title: 'STEP 2 · Dish Selection & Size',
    catDryNoodle: '🍜 Signature Dry Noodles',
    catSoupNoodle: '🥣 Wanton Soup Noodles',
    catDryWanton: '🥢 Dry Tossed Wantons',
    catSoup: '🥟 Fresh Wanton Soup',

    // Noodle Sizes
    noodleBalls: 'ball(s) of noodles',
    sizeSmall: 'Small',
    sizeMedium: 'Medium',
    sizeLarge: 'Large',
    size10pcs: '10 pcs',
    size15pcs: '15 pcs',
    freshWantonsDesc: 'handmade fresh pork wantons',
    noodleSmallDesc: '1 ball noodle · BBQ Char Siew · 3 wantons',
    noodleMediumDesc: '1.5 balls noodle · BBQ Char Siew · 3 wantons',
    noodleLargeDesc: '2 balls noodle · BBQ Char Siew · 4 wantons',

    // Sauces
    step3Title: 'STEP 3 · Pontian Signature Sauces',
    sauceBlack: 'Black Soy Sauce',
    sauceWhite: 'White Pork Lard',
    sauceRed: 'Red Chili Tomato',
    sauceSoup: 'Clear Soup Broth',
    sauceBlackDesc: 'Heritage dark aged soy, savory and aromatic',
    sauceWhiteDesc: 'Crisp lard crisps with pure shallot pepper oil',
    sauceRedDesc: 'Pontian signature sweet & spicy tomato chili',
    sauceSoupDesc: 'Slow-simmered chicken & anchovy broth',

    // Soup notice for Step 4 & 5
    soupNotice: '🥣 Pure slow-simmered bone broth · Natural umami · Chili & lard customization not needed',

    // Spiciness
    step4Title: 'STEP 4 · Spiciness Level (Ask Customer)',
    currentSelection: 'Selected',
    spiceNone: '🟢 Non-Spicy',
    spiceLess: '🟡 Mild Spicy',
    spiceNormal: '🟠 Regular Spicy',
    spiceExtra: '🔴 Extra Spicy 🔥',
    spiceNoneSub: 'Pure original',
    spiceLessSub: 'Gentle kick',
    spiceNormalSub: 'Pontian standard',
    spiceExtraSub: 'Rich & fiery',

    // Modifiers & Add-ons
    step5Title: 'STEP 5 · Pork Lard, Scallions & Add-ons',
    kosongBanner: '⚡ Kosong Plain (Strict 50% Off)',
    kosongSub: 'No Char Siew · No Wantons · Cost Efficient',
    kosongDesc: 'Chef skips wantons and meat; auto 50% price discount and deductions in BOM meat costs',
    kosongBadge: 'Kosong Plain',
    kosongKitchenWarning: '【⚡ KOSONG PLAIN · NO CHAR SIEW · DO NOT ADD WANTONS!】',

    lardCustom: '🥓 Pork Lard Customization:',
    lardNormal: 'Normal Lard',
    lardExtra: '+ Extra Lard',
    lardNone: '🚫 No Lard',
    lardNormalFull: 'Fresh Crispy Lard',
    lardExtraFull: '🌟 Extra Crispy Lard (Overflowing)',
    lardNoneFull: '🚫 No Lard (Healthier)',

    scallionCustom: '🌱 Scallions Customization:',
    scallionNormal: 'Normal Scallions',
    scallionExtra: '+ Extra Scallions',
    scallionNone: '🚫 No Scallions',

    addonsTitle: '✨ Paid Add-ons:',
    addCharSiew: '🥩 +Extra Char Siew (+RM 2.00)',
    addCharSiewDesc: 'Authentic Johor roasted red yeast pork',
    addWanton: '🥟 +Extra Wantons (+3 pcs +RM 2.00)',
    addWantonDesc: 'Handmade fresh pork filling',

    addToCart: 'Add to Order (Add to Cart)',
    currentEstimate: 'Item Cost Estimate:',
    bomFoodCost: 'Theoretical Food Cost',

    // Cart & Summary
    cartTitle: 'Current Order Cart',
    cartEmpty: 'Cart is empty',
    cartEmptyDesc: 'Select dish, size, sauce and modifiers, then tap "Add to Order"',
    cartTotalAmount: 'Total Due',
    itemsCount: 'items',
    clearCart: 'Clear',
    paymentMethod: 'Payment Method:',
    payCash: '💵 Cash Payment',
    payQr: '📱 DuitNow QR Transfer',
    sendToKds: '⚡ Send Order to Kitchen (KDS)',
    cartSummaryNoodles: 'noodle ball(s)',
    cartSummaryWantons: 'wantons',

    // KDS
    batchAssistantTitle: 'Chef Batching Assistant',
    pendingOrdersCount: 'pending orders',
    batchSubtitle: 'Quick glance before noodles hit the boiling pot · Wantons auto-exclude Kosong',
    undoLastOrder: '↩ Undo Last Order',
    totalNoodleBallsToBoil: '🔥 Total Noodle Balls',
    totalWantonsToBoil: '🥟 Total Wantons',
    tasteSummary: 'Flavor Breakdown:',
    blackSauceAbbr: 'Black',
    redSauceAbbr: 'Red',
    whiteSauceAbbr: 'White',
    soupSauceAbbr: 'Soup',
    allOrdersCompleted: 'All pending orders completed!',
    allOrdersCompletedDesc: 'No orders waiting in queue. Fresh incoming orders will sound an audible chime and appear at top.',
    elapsedTime: 'Elapsed',
    completeOrderBtn: '✅ Order Complete (Tap to Finish)',
    completedOrdersTiming: 'Completed Fulfillment Times',
    speedLightning: '⚡ Lightning (<4 min)',
    speedNormal: '🟢 On-Time (4-8 min)',
    speedSlow: '🟡 Slow Alert (8-12 min)',
    speedOverdue: '🔴 Overdue (>12 min)',
    avgSpeed: 'Avg Speed',
    onTimeRate: 'On-Time Rate',

    // Receipt
    receiptStallName: 'Pontian Traditional Wanton Mee',
    receiptSub: 'PONTIAN WANTON NOODLE STALL',
    receiptTagline: 'Johor Pontian Heritage · Authentic Pork Lard & Wantons',
    orderDurationLabel: '⏱️ Fulfillment Time:',
    orderWaitingLabel: '⏳ Current Wait:',
    subtotal: 'Subtotal',
    totalDue: 'Total Due',
    printReceipt: 'Print Receipt',
    close: 'Close',
    thankYou: 'Thank you for your visit · Please come again!',

    // Analytics
    analyticsTitle: 'Boss Financial & Efficiency Dashboard',
    timeframeDaily: 'Today (Daily)',
    timeframeWeekly: 'Past 7 Days (Weekly)',
    timeframeMonthly: 'Past 30 Days (Monthly)',
    tabPnl: '📊 P&L & Profit',
    tabSpeed: '⏱️ Fulfillment Speed',
    tabExpenses: '📝 Procurement Expenses',
    tabWastage: '🗑️ Wastage Logging',
    totalRevenue: 'Total Revenue',
    estimatedNetProfit: 'Est. Net Profit',
    grossMargin: 'Gross Margin',
    totalBowlsSold: 'Total Bowls Sold',
    cashRatio: 'Cash Share',
    qrRatio: 'QR Share',
  },
};
