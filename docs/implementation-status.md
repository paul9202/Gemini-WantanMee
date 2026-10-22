# 实施状态（豪云吞面 OS）

最后更新：2026-10-22 · 会话 1 · 分支 `claude/phase-a-domain`（未提交）

## 当前阶段

**阶段 A（基线与领域）— 本会话已完成领域层；下一步进入阶段 C 的 Emulator 云端营业闭环，再并行推进 B（图片 UI）。**

| 阶段 | 状态 |
|---|---|
| A 基线与领域 | ✅ 可重复安装、领域纯函数、48 项测试通过（见下） |
| B UI 与工作流程 | ⏳ 未开始（原型 UI 仅做价格/Kosong 止血修正） |
| C 云端营业闭环 | ⏳ 未开始 |
| D 离线单机营业 | ⏳ 未开始 |
| E 财务与关账 | 🟡 领域计算已完成；账本、页面、关账未开始 |
| F 测试云与试营业 | ⛔ 需用户提供 Google 项目 |
| G 生产切换 | ⛔ 需用户授权 |

## 仓库与交接差异（实际核对）

- 远端 `paul9202/Gemini-WantanMee` 只有 `main` 两个提交，HEAD = `dce0025`，**与交接审计基线一致**，无其他分支。
- 本地原只有 `docs/claude-handoff` 与交接 zip；以 `git init + fetch + checkout -t origin/main` 方式取得源码，未覆盖任何已有文件。zip 已加入 `.git/info/exclude`，不入库。
- **原 `package.json` 无法安装**：`esbuild@^0.25` 与 `vite@8.3.5` 的 peer `esbuild ^0.27||^0.28` 冲突（ERESOLVE）。源码实际只使用 `react`、`react-dom`、`lucide-react`；`esbuild`/`express`/`dotenv`/`@google/genai`/`@types/express` 均未被引用，已移除。交接文档未记录此问题。
- 无 lockfile → 已生成 `package-lock.json`。TypeScript 解析为 7.0.2。
- `FirebaseModal.tsx` 中的 `firebase/*` import 只是展示用字符串，项目实际没有 Firebase 依赖（与审计一致）。
- 审计列出的原型问题全部在当前代码中复现（价格 RM8/10/12、Kosong 可加云吞、写死 RM1,920、`max(0, …)` 吞亏损、Date.now ID、简单 +1 餐牌、公开读写 Rules 示例）。

## 已完成

### 1. 可重复安装与检查基线
- `package.json`：移除未用依赖，`engines.node >=22`，新增 `typecheck` / `check` 脚本，`test` 改为运行 `src/**/*.test.ts`。
- 原型修正前的基线（修复依赖后）：`tsc` 退出码 0；原 5 项测试 5/5 通过；`vite build` 成功。

### 2. 领域层 `src/domain/`（纯 TS，无浏览器/Firebase 依赖，供前端与 Functions 共用）
| 文件 | 内容 |
|---|---|
| `money.ts` | 整数 sen；0.1 sen 成本单位；half-up；RM 格式化与输入解析 |
| `menu.ts` | 菜单版本 `menu-2026-10-v1`：4 个 productKind、餐牌价 700/900/1100、Kosong 350/450/550、云吞 700/1000、加料 200；6 张图片入口 → 4 类；干捞云吞仅红/黑 |
| `lineItem.ts` | 默认配置、UI 规范化（汤品字段 null、Kosong 清肉类加料、无面 noodleType=null）、服务端严格解析（未知字段/枚举/类型/80 字备注）、定价、份量、合并键、Kosong 熟净面图 ID |
| `pictograms.ts` | 06 §4 图卡语义表；行项目图卡序列（汤品无辣/油渣；干捞打包「不附送清汤」） |
| `bom.ts` | BOM `bom-2026-10-v1`（半面球 425 单位，面薄待校准） |
| `cart.ts` | 加入/合并/编辑/数量；整单合计；打包每份包装成本、默认不收费 |
| `payment.ts` | 现金找零、少收阻止；QR 必须人工确认；离线 QR 需外部核实说明 |
| `tokens.ts` | 餐牌 1–50 状态机：占用、待回收、确认回收释放、撤回恢复、版本检查、循环建议 |
| `orderLifecycle.ts` | 制作/付款分离的状态机：开始、出餐、30 秒撤回、取消（待做反转成本/制作中需后厨确认且保留成本）、仅老板整单退款 |
| `kitchen.ts` | 厨房投影（白名单字段、无金额成本）、FIFO、待下锅/制作中分开合计、细面/面薄分栏、Kosong 标记不重复计份、人工单不进主队列 |
| `timing.ts` | 毫秒阈值分档、有效样本筛选、均值/中位/P90 nearest-rank/达标率（无样本 null）、预计等待 wait-v1 |
| `businessDay.ts` | Asia/Kuala_Lumpur + 04:00 切点；半开区间；7/30 天与对比期 |
| `finance.ts` | 日历日固定费用分摊（余数前置）；经营视角 vs 现金视角；钱箱应有；回本进度（允许负值/超 100%） |
| `csv.ts` | UTF-8 BOM、转义、公式注入防护 |
| `idempotency.ts` | 稳定 JSON、SHA-256 payload hash、operation 重放/冲突判定、UUID 校验 |

### 3. 原型止血修正（避免营业界面与已确认规则冲突；阶段 B 将整体替换）
- `src/types.ts`：面价 7/9/11，Kosong 3.5/4.5/5.5。
- `src/utils/calculations.ts`：Kosong 禁止加云吞；期初利润 1920 → 0；移除 `Math.max(0, …)` 吞亏损。
- `src/components/PosView.tsx`：开启 Kosong 同时清除加云吞，加云吞按钮在 Kosong 下禁用。
- `src/utils/calculations.test.ts`：旧期望 RM8/10/4 改为餐牌价，新增 Kosong 禁云吞断言。
- **仍保留**（下一阶段处理）：`mockData.ts` 演示数据自动注入、旧价格演示订单、FirebaseModal、localStorage 存单、旧分档逻辑。

## 修改文件

```
M package.json
A package-lock.json
M src/types.ts
M src/utils/calculations.ts
M src/utils/calculations.test.ts
M src/components/PosView.tsx
A src/domain/{index,money,menu,lineItem,pictograms,bom,cart,payment,tokens,orderLifecycle,kitchen,timing,businessDay,finance,csv,idempotency}.ts
A src/domain/{menu,operations,finance}.test.ts
A .claude/launch.json            # 本地预览配置（npm run dev，端口 3000）
A docs/implementation-status.md
```

## 实际验证结果（2026-10-22，Windows 11，Node v22.14.0，npm 10.9.2）

| 命令 | 结果 |
|---|---|
| `npm install`（原 package.json） | ❌ ERESOLVE，退出码 1 |
| `npm install`（修正后） | ✅ 退出码 0，62 个包 |
| `npm run typecheck`（tsc 7.0.2） | ✅ 退出码 0 |
| `npm test` | ✅ 48 项通过 / 0 失败（原 5 + 领域 43） |
| `npm run build`（vite 8.3.5） | ✅ 退出码 0 |
| 浏览器（内置浏览器，`localhost:3000` 开发服务器，原型 UI） | ✅ 开启 Kosong 后小份显示 RM3.50，加叉烧/加云吞均禁用；仅此一项手工检查 |

未执行：Emulator、Rules 测试、E2E、离线测试、五视口截图、实机、性能测试——相关功能尚未实现。

## 52 个验收场景进度

图例：✅ 领域层自动测试通过（仍需在命令/E2E 层复验）· ⏳ 未实现 · 🟡 部分

| 组 | 场景 |
|---|---|
| 领域 M01–M13 | ✅ 全部 13 项（`menu.test.ts`） |
| 在线 O01–O13 | ✅ O01、O02、O06、O07、O08、O09、O10；🟡 O03（hash/重放判定，未接服务端）、O05（餐牌层，未测并发事务）；⏳ O04、O11、O12、O13 |
| 离线 D01–D14 | 🟡 D11（收款核对规则）；⏳ 其余 13 项 |
| 财务 F01–F12 | ✅ F01–F10、F12；⏳ F11（关账写屏障） |

## 待用户配置（真实云操作前需要）

1. Google 账号与 Firebase **dev/staging 项目 ID**、**prod 项目 ID**（建议分开）。
2. Blaze 计费开通权限（Functions 2nd gen 需要）；预算告警金额。
3. Firestore / Functions 区域确认：建议 `asia-southeast1`（待实现时以官方文档复核）。
4. 首个 owner 的 Google 邮箱；员工账号方式（邀请邮箱或专用后厨账号）。
5. 档口 DuitNow QR 图片与收款人名称；收据抬头。
6. Hosting 自定义域名（可选）。
7. 实拍素材：6 餐品、细面/面薄、**熟净面（Kosong，当前图谱缺）**、叉烧、独立云吞、葱、油渣、辣椒；生成图仅为演示。
8. 面薄单位成本、汤面汤底配方成本（当前沿用估值，标注待校准）。

## 下一步入口（会话 2）

1. 阶段 C 基础：加入 `firebase`、`firebase-tools`（devDep）、`functions/`（firebase-functions v2 + firebase-admin），`firebase.json`（Hosting `dist`、SPA rewrite、Emulator 端口）、`.firebaserc.example`、`.env.example`（替换 AI Studio 变量）。Functions 通过 esbuild/tsc 打包引用 `src/domain`。
2. `firestore.rules`：默认拒绝；按 03 §3.1 读取矩阵；所有交易客户端写拒绝。用 `@firebase/rules-unit-testing` 在 Emulator 测匿名/他店/kitchen/cashier/owner/停用成员。
3. 命令：`createOrder`（operation + order + payment + orderCosts + token + kitchenTicket + audit 同事务）、`getOperationResult`、`ackKitchenTicket`、`startOrder`、`serveOrder`、`undoServe`、`requestCancel`、`confirmKitchenCancel`、`releaseToken`、`confirmFullRefund`；直接调用测试越权与 O03/O04/O05/O07。
4. 随后阶段 B：按 02/06 重做 POS/KDS（图片入口、面种原料图、图卡、收款抽屉、三段确认状态），删除 mockData 自动注入与 FirebaseModal。
5. 阶段 D：IndexedDB outbox（`idb`）、PWA 预缓存（`vite-plugin-pwa`）、补同步。

## 已做的设计判断（可调整）

- `updateLineConfig`：编辑后与另一行完全相同则并入该行（数量相加），不修改其他行配置。
- 退款只允许在已出餐或已取消订单上；待做/制作中订单须先取消。
- 撤回出餐：原操作者或老板，30 秒内（`< 30000ms`），营业日未关账，原订单仍持有原牌。
- CSV 公式防护前缀集合：`= + - @ \t \r`；数值列保持数字不加前缀。
