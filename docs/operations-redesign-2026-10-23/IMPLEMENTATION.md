# 营业流程改版：实施、兼容与验证记录

日期：2026-10-24。依据 `DESIGN.md` 与 `CLAUDE-FOLLOWUP.md`。所有改动只在本地，**未提交、未部署**，没有改动真实营业数据。

## 1. 实施要点

| 范围 | 改动 |
|---|---|
| 领域 `src/domain/orderLifecycle.ts` | `PaymentState` 增加 `unpaid`、`not_due`。新电子单直接 `preparing`，`startedSource:'auto'`。出餐和取消成立时释放餐牌（`token_release`）。撤回出餐会重新占回原牌，前提是原牌空闲、且最后一次由本单释放（`token_rehold`）。后厨确认取消时必须选「未做 / 已消耗」，未做反转成本，已消耗保留。收款用 `registerPayment` / `reversePayment` 处理，独立于制作状态，不改变制作版本号 |
| 餐牌 `tokens.ts` | 新增 `releaseHeldToken`：牌已不属于本单时返回 null，调用方不得改动牌。新增 `reholdToken` 和 `lastReleasedOrderId`。`awaiting_return` 只在旧数据中出现 |
| 收款 `payment.ts` | 新收款记为 `method:'unspecified'`、`confirmationMode:'manual'`。`checkPayment` 只用于旧格式离线日志。收款流水 ID 是确定的：`{orderId}-p{n}` |
| 厨房 `kitchen.ts` | `summarizeKitchen` 返回 `active`，即全部有效、未出餐、无取消申请的电子单。取消待确认的单计入 `cancelPending`，人工单计入 `manualPending`，都单独计数 |
| 财务 `finance.ts`、`ledger.ts` | 已登记收款是统一口径。现金 / QR 只来自旧记录，靠 `hasLegacyChannels` 标识。新增 `closeFiguresV2`，包含有效订单金额、已登记收款（含跨日、含更正）、退款、净登记收款、本日未登记、结转未登记清单，不再推算钱箱。旧的 `closeFigures` 只用于旧报表的查看和更正 |
| 服务端 `createOrder` | 下单不收款，不写付款流水。旧客户端如果带 `payment` 字段，返回 `INVALID_ARGUMENT` |
| 新命令 `recordPayment` / `reversePayment` | `recordPayment`：主收银机资格 + 整单金额 + 订单状态在事务内检查；收款计入登记日，`orderBusinessDate` 关联原单。`reversePayment`：仅老板可用，必须写原因；保留原收款，追加一笔负数调整 |
| `lifecycle` | 出餐和取消成立时自动释放牌，并记录 `tokenReleaseSource`。`confirmKitchenCancel` 必须带 `consumed`。退款不强制选渠道 |
| `openShift` | 不再要求备用金，也不写备用金流水。主设备、营业日、24 小时离线资格的校验不变 |
| `close` | 日结快照为 v2。例外项增加 `unpaidOrders`（包括之前营业日结转来的单），老板写原因后结转；快照里记录 `unpaidCarriedForward`。旧客户端的钱箱字段仍接受，但不使用。旧版报表更正时仍按旧口径计算 |
| 离线 | 新增事件 `offline_payment_recorded`，只关联订单，不占牌、不释放牌。人工出餐时同时释放牌。离线单 `payment:null`，表示未付款。旧格式日志（下单即收款、`token_returned`）照常接纳，且不会释放已属于新单的牌。重复收款、金额不符、原单待核对的收款事件都进入待核对 |
| 前台 | 主按钮改为「下单送厨 · RM」。新增常驻的「待登记收款 N 单 · RM」抽屉，已出餐的单排在前面，卡片按订单 ID 操作。下单结果页增加 QuickPay，可当场「确认已收款」。新增「显示收款码」（原图）。开班不再输入备用金。旧版待回收牌在列表中单独标出 |
| 后厨 | 合并为一个「制作中 / 待出餐」区，不再有「开始制作」。合计统计全部有效单。取消待确认的单冻结显示，提供两个按钮：未做 / 已下锅 |
| 订单 / 老板 | 付款状态单独显示，未收款不会显示成已收款。老板可以更正误登记的收款；登记退款时不选渠道。概览和日结只显示统一收款，旧记录的渠道拆分标为「旧版」 |
| 收款码 | `public/payment/tng-receiving-original.jpg` 与 `assets/` 中的原图 SHA-256 一致（`08223503…67fc`），并加入 PWA 预缓存，离线也能显示 |

## 2. 兼容方案

- **旧订单**（schemaVersion ≤ 2）：`paid`、`refund_due`、`refunded` 和真实的 cash / qr_manual 渠道都原样保留，不批量改写。补登记收款时，收款序号从 2 开始，避免和旧的 `p1` 冲突。
- **旧冻结报表**：没有 `schemaVersion:2` 的报表，仍按原样显示钱箱和 QR 字段。新营业日使用 v2。
- **旧待回收牌**：不会批量释放。前台在餐牌选择器里逐张确认后释放，并留审计记录。日结时仍列为例外。
- **旧离线日志**：可以解析，也可以补同步；`token_returned` 遇到已经释放的牌时只补记时间。
- **旧在线请求**：结果不明的旧 `createOrder` 请求在转为人工补账时，保留它原有的付款信息。

## 3. 测试结果（本机实际运行）

| 套件 | 结果 |
|---|---|
| `npm run check`（类型检查 + 领域 / IndexedDB 测试 + 构建） | 70/70 通过，构建成功 |
| `npm run functions:typecheck` | 0 错误 |
| Emulator 命令测试 `npm run test:emulator` | 38/38 |
| Firestore Rules `npm run test:rules` | 28/28 |
| 新增 `scripts/operations-2026-10-23-e2e.mjs`（真实前台 + 后厨页面） | 48/48 |
| `tablet-preflight`（包括竖屏，触控目标 ≥ 56px，无溢出） | 185/185 |
| `offline-e2e` 24/24 · `link-receipt-e2e` 17/17 · `owner-e2e` 19/19 · `settings-e2e` 20/20 · `ui-2026-10-23-shots` 30/30 | 全部通过 |

E2E 过程中发现并修复了 3 个问题：
- 待登记抽屉里登记成功后，卡片直接消失、没有成功提示；
- 600×960 竖屏下收款码边缘被裁掉几像素；
- 「刚刚送到后厨」按钮高 44px，低于 56px 的触控要求（这个问题改版前就存在）。

其中前两项修复后重跑了 operations E2E 和 tablet-preflight，结果见上表。`owner-e2e` 和 `settings-e2e` 的结果是第三项修复之前跑出的，之后没有重跑。

截图在 `docs/screenshots/operations-2026-10-23/`（Redmi Pad 横屏候选尺寸 1280×800、DPR 1.6），平板各视口的截图在 `docs/screenshots/tablet-preflight/`。

运行 Emulator 需要 JDK 21 以上（本机为 `E:/DevTools/Java/jdk-25`），并设置 `FUNCTIONS_DISCOVERY_TIMEOUT=60`。

## 4. 未执行 / 如实标注

- 没有在实体红米平板上测试，所有视口都是模拟的候选尺寸。
- 收款码没有扫码核对 payload，没有任何转账，也没有支付测试。没有接入任何支付或 TNG 回调。
- 没有部署到 staging 或云端，没有改写真实数据。
- `scripts/screenshot-app.mjs` 已更新，但没有运行（它需要开发服务器和设备 ID）。

## 5. 用户已决定的业务问题（2026-10-24）

1. **放弃追收：已实现。** 只有老板能操作，命令为 `writeOffPayment`，必须写原因。系统记录金额、操作者、时间和营业日，写入 `paymentWriteOffs`。
   - 订单状态变为 `paymentState:'written_off'`，退出待登记收款列表和日结例外，历史订单保留。
   - 日结和 CSV 单独列出「未收回金额」。这笔钱不算已付款，不计实收，不动已有食材成本。
   - 如果之后又收到钱：老板先 `reinstateWrittenOff`（追加反向记录、写原因），订单回到待收款，再由主点单平板正常登记。
   - 已放弃追收的单不能直接登记收款，离线补来的收款事件进入待核对。
2. **断网取消：本轮不做。** 断网时取消弹窗会说明「请口头通知厨房；联网后再完成系统取消；在此之前餐牌仍占用，后厨屏没有收到取消通知」，确认按钮不可用。
3. **换牌后恢复：本轮不做，列为后续增强。** 30 秒撤回保留；原牌已被新单占用时明确拒绝，不抢牌、不暗中换牌。
4. **登记收款仍只限主点单平板。** 老板手机可以查看待收款，也可以放弃追收、恢复、更正、退款。
5. **后厨「继续做，拒绝取消」：已实现。** 命令为 `rejectKitchenCancel`，只在有取消申请时显示，原因可选（「已送餐，顾客仍要」等）。
   - 拒绝后取消申请结束，订单写入 `cancelRejection` 记录，前台订单页会提示，订单恢复正常制作和出餐。
   - 不标已付款，不退款，不释放餐牌；出餐仍要点「完成出餐」。

## 6. 后续增强（未做）

- 「换可用牌后恢复」异常操作。
- 断网时的最终取消。
- 跨设备登记收款。
