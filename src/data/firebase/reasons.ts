/** 服务器 reasonCode → 员工可读的中文说明（不展示堆栈或技术细节）。 */
const REASONS: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，请重新登录',
  NOT_A_MEMBER: '当前账号不是本店成员或已停用',
  FORBIDDEN: '当前账号没有这个操作的权限',
  INVALID_ARGUMENT: '提交内容不完整，请重试',
  INVALID_MODIFIER: '餐品配置不符合菜单规则',
  TOKEN_OCCUPIED: '这个餐牌仍被占用，请核对实体牌或换一个',
  TOKEN_NOT_HELD_BY_ORDER: '餐牌不属于这张订单',
  TOKEN_NOT_AWAITING_RETURN: '这张餐牌还没出餐，不能回收',
  STALE_VERSION: '订单刚被其他设备更新，画面已刷新，请再确认',
  MENU_CHANGED: '菜单已更新，请重新确认价格',
  PRICE_MISMATCH: '金额与服务器不一致，请重新确认',
  PAYMENT_NOT_CONFIRMED: '收款尚未确认',
  REGISTER_REVOKED: '这台设备不是当前主收银机',
  SEQUENCE_GAP: '本机记录顺序不连续，请先处理待核对的单',
  SHIFT_NOT_OPEN: '尚未开班',
  SHIFT_ALREADY_OPEN: '已经开班',
  DAY_CLOSED: '营业日已关账',
  OPERATION_CONFLICT: '同一请求内容不一致，已阻止',
  ORDER_ID_CONFLICT: '这张订单已经存在，未重复收款',
  NOT_FOUND: '找不到这张单',
  INVALID_TRANSITION: '订单当前状态不能这样操作',
  UNDO_WINDOW_EXPIRED: '已超过 30 秒，不能撤回',
  TOKEN_REASSIGNED: '餐牌已回收或给了别的单，不能撤回',
  REASON_REQUIRED: '请选择原因',
  REFUND_MUST_BE_FULL: '首版只支持整单退款',
  ALREADY_REFUNDED: '这张单已经退款',
  OFFLINE_REVIEW_REQUIRED: '人工单需要先核对',
  STORE_NOT_CONFIGURED: '门店尚未初始化',
  UNKNOWN_RESULT: '网络不稳定，结果未确认',
  CLOSE_EXCEPTIONS: '还有未处理事项，请确认并写明原因后再关账',
  NOT_CLOSED: '该营业日尚未关账',
  REVIEW_NOT_ALLOWED: '这条记录不能这样处理',
};

export function reasonText(code: string): string {
  return REASONS[code] ?? `操作失败（${code}）`;
}
