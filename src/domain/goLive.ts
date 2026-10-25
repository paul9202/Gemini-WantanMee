/**
 * 开业前一次性清空测试数据：清空哪些集合（按界面分组）、保留什么。前端展示与后端删除共用这一份清单。
 * 保留的设置类数据（菜单、配方、食材清单、成员、设备、收银机、门店设置、开档成本、经营目标）绝不在清单里。
 */
export type GoLiveStatus = 'testing' | 'resetting' | 'live';

export const GO_LIVE_RESET_GROUPS = [
  { id: 'orders', label: '订单与后厨单', collections: ['orders', 'kitchenTickets', 'orderCosts'] },
  { id: 'payments', label: '收款、退款与坏账', collections: ['payments', 'refunds', 'paymentWriteOffs'] },
  { id: 'shifts', label: '班次、钱箱、营业日与日结', collections: ['shifts', 'cashMovements', 'businessDays', 'dailyReports', 'offlineInbox'] },
  { id: 'costs', label: '成本记录与损耗', collections: ['costEvents', 'wastage'] },
  { id: 'expenses', label: '日常开支与固定费用付款', collections: ['expenses', 'expenseLinks', 'recurringSlots'] },
  { id: 'ingredients', label: '食材批次与采购记录', collections: ['ingredientBatches', 'purchaseDetails'] },
  { id: 'aiCost', label: 'AI 记成本草稿、收据与解读', collections: ['costDrafts', 'costReceipts', 'costAnalysis', 'aiUsage'] },
  { id: 'logs', label: '操作与审计记录', collections: ['operations', 'auditEvents'] },
] as const;

export const GO_LIVE_RESET_COLLECTIONS: readonly string[] = GO_LIVE_RESET_GROUPS.flatMap((g) => g.collections);

/** 永远不清空的集合（设置与账号）。 */
export const GO_LIVE_KEPT_COLLECTIONS = [
  'config', 'members', 'devices', 'registers', 'tokens', 'menuVersions', 'visualCatalogs', 'bomVersions',
  'ingredients', 'startupCosts', 'goals', 'operationsStatus',
] as const;

export const GO_LIVE_KEPT_LABELS = ['菜单与价格', '配方（BOM）', '食材清单', '员工账号、设备与收银机', '门店设置', '开档成本', '经营目标'] as const;

export const GO_LIVE_MAX_FAILED_ATTEMPTS = 5;
export const GO_LIVE_LOCKOUT_MS = 30 * 60_000;
