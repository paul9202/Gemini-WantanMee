# 实施状态（豪云吞面 OS）

最后更新：2026-10-22 · 会话 1（续 3）· 分支 `claude/phase-a-domain`

## 当前阶段

**阶段 A、C（服务端）完成；阶段 B 的 POS / KDS / 订单 / 设备页已接入云端；阶段 D 离线营业已实现，并通过真断网端到端验证（20/20）。** 下一步：后厨心跳（O11）、跨日未完成单（O12）、收据打印（O13），然后进入阶段 E 财务与日结。

| 阶段 | 状态 |
|---|---|
| A 基线与领域 | ✅ 已提交 `3564375` |
| C 云端营业闭环 | 🟡 服务端 ✅（`4e994dd`）；前端已接入命令与实时厨房；后厨心跳、App Check、菜单发布未做 |
| B UI 与工作流程 | 🟡 POS、KDS、订单、设备、登录已完成并经浏览器验证；老板报表页、收据打印、英文设置、员工培训卡页未做 |
| D 离线单机营业 | 🟡 已实现并通过 Emulator 与真断网 E2E；老板处理「待核对」离线记录的界面、实机/真实断网（拔网线）未做 |
| E 财务与关账 | 🟡 领域计算完成；关账命令、账本页面、CSV 导出未做；关账写屏障已在命令中生效 |
| F 测试云与试营业 | ⛔ 需用户提供 Google 项目 |
| G 生产切换 | ⛔ 需用户授权 |

## 仓库与交接差异（实际核对）

- 远端 `paul9202/Gemini-WantanMee` 只有 `main` 两个提交，HEAD = `dce0025`，与交接审计基线一致。
- 本地以 `git init + fetch + checkout -t origin/main` 取得源码，没有覆盖已有文件；交接 zip 写进了 `.git/info/exclude`。
- 原 `package.json` 无法安装（`esbuild@^0.25` 与 vite 8 peer 冲突）；未使用的 `esbuild/express/dotenv/@google/genai` 已移除，并生成 lockfile。
- 审计列出的原型问题都在代码中确认过。

## 阶段 D：离线营业（本次完成）

### 做法
- **同一个序号流**：在线命令与离线事件共用本机序号，序号在 IndexedDB 里原子分配（`allocateSequence`）。在线命令被明确拒绝时：如果其后还没分配新序号，就归还这个号；如果已经分配了，就写一条「作废序号」事件补位（`sequence_void`，不涉及账务），避免后面的离线日志被永远阻塞。
- **离线接单原子提交**（`commitOfflineOrder`）：本机订单、收款事实、占牌事件、序号在同一个 IndexedDB 事务里写入；任何一步失败整次回滚，购物车保留，不显示成功。
- **不可变事件**：`offline_order_created / manual_handoff / manual_served / token_returned / sequence_void`。临时展示号形如 `O-F01-0004`，与订单 UUID 分开。
- **本机餐牌视图** = 最后一次联网的服务器餐牌 + 尚未被服务器接纳的本机事件（`overlayLocalTokens`）。
- **离线营业快照**：联网且就绪时持续保存（成员、门店配置、收银机、班次、餐牌、服务器时间偏移）。断网重开时会话与收银机资格退回快照，仅在班次的 24 小时离线资格内有效；过期后提示改用纸单。
- **服务端 `syncOfflineEvents`**：
  - 每个事件一次事务，按 eventId 幂等收件到 `offlineInbox`，同设备按序号应用。
  - 缺号时本条及其后全部 `blocked`：保留收件，可重试。
  - 不能自动接纳的进入 `needs_review`：换机 epoch、时间异常（超过 5 分钟或在班次之前）、超出 24 小时资格、菜单未知、配置非法、价格不符、QR 无外部核实、餐牌冲突、关账后迟到、订单号冲突、依赖未入账、已转电子厨单后再报人工出餐。这些情况保留原金额与餐牌，序号照常前进。
  - 同批稍后已有回收事件的离线单，如果牌已被别的单占用，只补历史账（`tokenLock=history_only`），不抢占当前牌锁。
- **离线单一律 `kitchenRouting=manual`**：不进入后厨电子队列、不计入待下锅合计。已人工出餐的导入为已出餐；尚未制作的，只有收银向厨师核实后点「转电子厨单」（`routeManualOrderToKitchen`）才送厨，后厨卡片会显示「人工单转入」。
- **结果不明的在线收款**：联网后只自动**查询**原操作。查不到时由收银选择：
  - 「厨房没做：按原单重新提交」：同一 operationId 与订单号，用原序号；
  - 「已人工处理：转人工单补账」：原订单号与原序号转为离线人工单。

  两种做法都不换新 ID，不会重复收款。
- **补同步**：单飞；按序号每批最多 25 条；联网（online 事件、每 20 秒检查）时自动尝试；「已同步」只来自服务器逐条回复。新的在线命令发出前，会先补传本机日志。
- **单写端**：Web Locks 防止误开第二个收银标签页；只是防误操作，不是安全边界。
- **PWA**：vite-plugin-pwa 预缓存应用壳、9 张营业照片和图标（20 个文件，约 1.15MB）；不缓存 Firebase/Callable/Auth 请求；新版本只提示，本机有未同步记录时不允许更新刷新。设备页新增「离线可用检查」：应用壳、照片缓存、离线快照。
- **同步中心 `/sync`**：本机离线单的人工交接/出餐/回收、逐条同步状态与待核对原因、结果不明收款的处理、手动「改为离线营业 / 恢复在线」、恢复包导出与导入（同 eventId 不重复）。
- **POS 断网时**：
  - 醒目横条「离线营业 · 仅本机保存 · 未同步 N 条」。
  - 接单进度显示「本机已接单 ✕ 云端未同步 → 请人工传单」，附「我已把单交给厨师」按钮。
  - QR 需填写另一台联网收款端的核实说明。

### 新增 / 修改文件
```
A src/domain/offline.ts                       事件信封、本机餐牌叠加、临时号
A src/data/local/idb.test.ts                  D01/D02/D12 与序号（fake-indexeddb）
M src/data/local/idb.ts                       v2：localOrders / outbox，原子事务、序号、恢复包
A src/data/local/writerLock.ts                单写端
A src/data/offline/runtime.ts                 补同步、快照、结果不明核对、作废序号
M src/data/register.ts  src/app/session.tsx   断网重开退回快照
M src/features/pos/PosPage.tsx  PaymentDrawer.tsx   离线接单、人工交接、离线 QR 核实说明
A src/features/sync/SyncPage.tsx              同步中心
M src/features/kitchen/KitchenPage.tsx        人工单数量、人工单转入、离线时间标记
M src/features/device/DevicePage.tsx          离线可用检查
A src/app/swUpdate.ts  src/vite-env.d.ts  M vite.config.ts  index.html  src/main.tsx  src/app/Shell.tsx   PWA
A functions/src/commands/offline.ts  functions/src/core/orderWrites.ts  M createOrder.ts  index.ts  core/command.ts
A functions/test/offline.test.ts              9 项离线补同步 Emulator 测试
A scripts/offline-e2e.mjs                     真断网端到端脚本
A public/icons/*                              PWA 图标
A docs/screenshots/offline/*                  断网真实截图与 offline-e2e.json
```

## 阶段 B（前端）：本次完成内容

### 结构
| 位置 | 内容 |
|---|---|
| `src/app/` | `App`（按岗位路由：收银/老板 → `/pos`，后厨 → `/kitchen` 可直接收藏）、`session`（Auth + 成员角色 + 门店配置 + 本机设备 ID）、`Shell`（暖色页头：岗位、网络、营业日）、`Login`、极简 `router` |
| `src/data/firebase/` | `client`（开发模式默认连本机 Emulator，按页面主机名连接）、`commands`（Callable 封装；结果不明时先 `getOperationResult`，再用同一 operationId 重试，绝不复制成新单）、`live`（只读实时订阅，带「是否缓存」）、`reasons`（reasonCode → 中文） |
| `src/data/local/idb.ts` | 独立 IndexedDB `hao-pos`：设备 ID、待核对收款请求（`pendingOps`）、本机序号、上次发出的牌号；申请持久化存储 |
| `src/data/register.ts` | 主收银机资格（未指定 / 非本机 / 未开班 / 就绪）与本机序号 |
| `src/features/pos/` | 选餐画布、本单、餐牌选择器（含待回收牌的实体回收确认）、收款抽屉、三段接单状态 |
| `src/features/kitchen/` | 深色 KDS：细面/面薄分栏合计、云吞、口味份数、净面标记；待做 FIFO，制作中分栏；开始/出餐/30 秒撤回/确认停止制作；非缓存厨单自动回执；断网冻结操作 |
| `src/features/orders/` | 当日订单：制作与付款两种状态分开；收银请求取消（选原因）；老板登记整单退款（须勾选「钱已实际退给顾客」） |
| `src/features/device/` | 设备与连接页（替代原型的 Firebase 配置弹窗）；老板把本机设为主收银机 |
| `src/ui/` | 设计 Token（`index.css`）；`visual.tsx` 照片 / 图卡组件；`iconSymbols.ts` 从交接设计稿提取的同一套 SVG 图卡；`photoManifest.json` |
| `public/photos/` | 由 `scripts/build-photos.mjs` 从演示图谱切出的 9 张 WebP（共约 183KB），manifest 含 hash、`source: generated-demo`、`reviewedBy: null` |
| `src/legacy/` | 原型代码移入此处，**不再被入口引用、不打包**；保留到阶段 E 老板报表重做后删除 |

### 关键行为
- 6 张餐品照片对应 4 类餐品；面种用原料照片；份量用面团图（1 / 1½ / 2）加价格；Kosong 显示半价并锁定两种肉类加料；汤品不显示酱料、辣度、油渣。
- 每次加入本单后，特殊要求恢复默认（保留所选餐品和面种）；可撤销最近一次加入或删除；点本单的行可回到画布修改，按钮变为「保存修改」。
- 餐牌只做建议、不预占；按上次发出的牌号循环建议，存本机，切页或刷新不丢；占用中的牌不能选；待回收的牌要确认「实体牌已收回」才释放。
- 收款：现金按键盘与快捷金额（刚好 / RM10/20/50/100）输入，显示找零，少收不能确认；QR 必须勾选「我已在收款端看到到账」。
- **接单状态只显示有依据的事实**：「本机已记录」= IndexedDB 写入完成；「云端已接单」= 服务器事务已提交；「后厨已收到」= 订单上已有 KDS 回执。结果不明时显示「已记录收款，正在核对订单；请勿再次收钱」；有未核对的单时禁止再次收款。
- 断网时显示醒目横条；由于离线接单尚未实现，收款按钮会禁用并说明原因，**不假装能离线接单**。
- 窄屏（<1024）：菜单占满屏幕，本单收为底部条，点开后全屏显示；收款按钮一直可点。
- 移除了 Google Fonts（营业时不依赖外部字体），移除了 `user-scalable=no`（支持放大）。

### 本地开发方式

```bash
# 终端 1：Emulator（需 Java 21+；Windows 首次加载函数较慢，建议放宽发现超时）
FUNCTIONS_DISCOVERY_TIMEOUT=60 npm run emulators
# 终端 2：初始化门店与测试账号（只会连接本机 Emulator）
npm run emulators:seed
# 终端 3：前端
npm run dev
```
测试账号在 `functions/scripts/seed-emulator.ts`。流程：老板登录 → 「设备」页把本机设为主收银机 → 退出 → 收银登录 → 开班 → 点单。后厨可以在另一个源（例如 `http://127.0.0.1:3000`）登录，以免和收银共用登录状态。

## 阶段 C：已完成内容

### 配置
| 文件 | 内容 |
|---|---|
| `firebase.json` | Hosting `dist` + SPA rewrite + `/assets/**` 长缓存 + `index.html`/`sw.js` no-cache；Firestore rules/indexes；Functions `nodejs22`、build predeploy；Emulator 端口 auth 9099 / firestore 8080 / functions 5001 / hosting 5050 / UI 4000 |
| `firestore.rules` | 默认拒绝；按角色的读取矩阵；**所有客户端写入一律拒绝**；他店/门店根/未知集合拒绝 |
| `firestore.indexes.json` | 03 §8 所列复合索引（时间字段统一为 `*Ms` 数值），大字段豁免索引 |
| `.firebaserc.example` | `default=demo-hao-wantan`（Emulator），`staging`/`prod` 占位；真实 `.firebaserc` 已 gitignore |
| `.env.example` | 替换 AI Studio 变量为 Firebase Web 公开配置、区域、门店 ID、Emulator 开关；注明禁止存服务账号私钥 |

### Functions（`functions/`，Cloud Functions 2nd gen，`asia-southeast1`，`maxInstances 10`）
- 打包：`build.mjs` 用 esbuild 把 `functions/src` 和共享的 `src/domain` 打成 `lib/index.js`（CJS），firebase-admin/functions 作为外部依赖。
- `core/command.ts` — `runCommand`：
  - 一次事务里依次：读 operation（同 hash → 返回原结果；不同 hash 或不同操作者 → `OPERATION_CONFLICT`）→ 读成员（启用状态 + 角色）→ 业务读写 → 写 operation 和审计。
  - 事务回调里没有外部副作用。
- `core/store.ts`：主收银机资格检查（`activeRegisterId` + 设备 + epoch）、本机序号连续（`SEQUENCE_GAP`）、营业日写入屏障（`DAY_CLOSED`）。
- `core/input.ts`：严格解析，拒绝未知字段、错误类型、超长字符串。
- 命令（Callable 名称为 `<name>Cmd`）：

| 命令 | 角色 | 说明 |
|---|---|---|
| `createOrder` | 收银/老板 | 同一事务写入：订单、支付、私有成本、餐牌占用、厨房投影、序号、票号 `YYMMDD-NNN`、operation、审计。服务器按菜单版本重算，`expectedTotalSen` 只用于比对 |
| `getOperationResult` | 原操作者/老板 | 结果不明时查询，不写入 |
| `openShift` | 收银/老板 | 班次、备用金现金流水、24 小时离线资格期限 |
| `ackKitchenTicket` | 后厨/老板 | 只记录首次收到时间，不改变制作状态；更新后厨最近在线时间 |
| `startOrder` / `serveOrder` / `undoServe` | 后厨/老板 | 由领域状态机驱动，版本检查，餐牌与厨房投影同事务更新 |
| `requestCancel` / `confirmKitchenCancel` | 收银/老板，后厨/老板 | 待做取消时反转成本；制作中取消需后厨确认，成本保留 |
| `confirmFullRefund` | 仅老板 | 一单最多一条整单退款，计入退款当日营业日 |
| `releaseToken` | 收银/老板 | 只能回收待回收状态、且属于该订单的餐牌 |
| `manageMember` / `assignRegister` | 仅老板 | 成员角色/停用；更换主收银设备时 epoch +1 |

- `admin/bootstrap.ts`：用 Admin SDK 初始化门店配置、老板配置、第一个 owner、1–50 号餐牌；**不注入演示数据**，没有公开的「注册成为老板」接口。
- 错误码：用标准 HttpsError，`details.reasonCode` 为稳定码，供 UI 翻译。

## 已完成（阶段 A，摘要）

- 领域层 `src/domain/`：金额精度、菜单（餐牌价）、配置规范化与严格校验、BOM、购物车、收款、餐牌、制作/付款状态机、厨房投影、时效、营业日、财务、CSV、幂等。
- 原型止血：面价 7/9/11、Kosong 半价且禁云吞、移除 RM1,920、亏损不再被吞掉。

## 修改文件（阶段 C）

```
A firebase.json  firestore.rules  firestore.indexes.json  .firebaserc.example
M .env.example  .gitignore  package.json  package-lock.json  tsconfig.json（include 限定 src 与 vite.config.ts）
A functions/package.json  functions/package-lock.json  functions/tsconfig.json  functions/build.mjs
A functions/src/index.ts
A functions/src/core/{command,errors,input,store}.ts
A functions/src/commands/{createOrder,lifecycle,front,admin}.ts
A functions/src/admin/bootstrap.ts
A functions/test/{harness,rules.test,commands.test}.ts
M docs/implementation-status.md
```

## 实际验证结果（2026-10-22，Windows 11，Node v22.14.0，firebase-tools 15.34.1（项目锁定），JDK 25）

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（根） | ✅ 退出码 0 |
| `npm test`（根，领域 + 原型） | ✅ 48/48 |
| `npm run build`（根，vite） | ✅ |
| `npm run functions:typecheck` | ✅ 退出码 0 |
| `npm run functions:build` | ✅ `lib/index.js` 58.7 KB |
| `npm run test:rules`（Firestore Emulator + rules-unit-testing 5.0.2） | ✅ 27/27 |
| `npm run test:emulator`（Auth + Firestore + Functions Emulator，真实 Auth 身份调用 Callable） | ✅ 11/11，约 71 秒；Emulator 日志中没有未预期错误 |
| 本次前端改动后重跑上面全部命令 | ✅ typecheck 0、48/48、build 成功、functions typecheck 0、Rules 27/27、命令 11/11 |
| 阶段 D 完成后重跑 | ✅ typecheck 0、`npm test` 52/52（含 4 项 IndexedDB）、build 成功（PWA 预缓存 20 项）、functions typecheck 0、Rules 27/27、命令 + 离线 20/20 |
| `node scripts/offline-e2e.mjs`（正式构建 + Service Worker + 干净的 Emulator，CDP 真断网） | ✅ 20/20，结果在 `docs/screenshots/offline/offline-e2e.json` |

**真断网 E2E 步骤**：
1. 老板指定主收银机 → 收银开班 → 离线可用检查全部 ✓（应用壳、9 张照片已缓存、快照）。
2. 断网 → 出现离线横条 → 现金接单，显示临时号 `O-F01-0001` → 人工交接。
3. 断网刷新：应用从 Service Worker 载入，仍为离线营业；同步中心显示 2 条未同步。
4. 人工出餐 → 实体牌收回 → 同一张牌再接一单 → 第三张单不做。
5. 断网时 QR 不填核实说明不能确认；此期间云端 0 单。
6. 恢复网络 → 自动补同步：未同步 0 条，6 条日志全部接纳，云端 3 张离线单无重复，电子厨单 0 张，已人工出餐的单为 served，该餐牌最终属于第二张单。
7. 「厨师确认没做 → 转电子厨单」后电子厨单变为 1 张。
8. 继续在线接单，「✓ 云端已接单」，序号连续。

**E2E 首轮 16/20 的原因（已修复并重跑）**：
- 照片缓存检查没有忽略 Workbox 的版本参数（检查代码错误，照片其实已缓存）。
- 脚本把日志条数期望写成 7（实际应为 6）。
- 等待时间短于函数冷启动。

**验证中发现并修复的设计问题**：
- 在线单结果不明后若被拒，后续离线日志会被缺号永久阻塞 → 新增 `sequence_void`。
- 人工单转电子厨单后仍可补登人工出餐，可能导致重复制作 → 服务器改判 `needs_review ORDER_STATE`，并补了测试。

**环境注意**：本机 PATH 上默认是 JDK 17；所有 Emulator 测试都是把 `E:\DevTools\Java\jdk-25\bin` 放到 PATH 最前面运行的，JDK 17 下未测试。`@firebase/rules-unit-testing@6` 要求 Node ≥24.12，所以用 5.0.2（配 `firebase@12`）。

**命令集成测试覆盖**：
- C 闭环：现金接单 → 后厨确认（只记首次）→ 开始 → 出餐 → 牌待回收 → 同牌新单被拒 → 回收 → 同牌新单成功；同时核对后厨通过网络实际读到的厨单不含金额字段，且后厨不能读订单集合。
- O03：同一请求 5 次并发 + 5 次顺序，结果是 1 张订单、1 条支付、1 份成本、1 张厨单、1 个牌锁、1 条 operation、1 条审计。
- O04：用 `getOperationResult` 查回原单；同一 operationId 换内容 → 冲突；换新 operationId 但复用订单 ID → `ORDER_ID_CONFLICT`，支付仍只有 1 条。
- O05：两单并发争同一餐牌，只有一单成功。
- O07：两台 KDS 同版本同时出餐，一次成功、一次 `STALE_VERSION`。
- O08/O09：撤回恢复原开始时间与牌锁；牌已回收后撤回 → `TOKEN_REASSIGNED`；收银撤回 → `FORBIDDEN`。
- F03：取消与退款分离；待做取消成本归零；制作中取消保留 3210 单位成本；收银退款被拒；部分退款被拒；重复退款 → `ALREADY_REFUNDED`。
- 篡改：改总价、行内塞单价、Kosong 加云吞、干捞云吞白酱、数量 0/1.5、旧菜单版本、餐牌 51、顶层多余字段，全部被拒绝。
- 越权：匿名、非成员自封老板、他店、后厨下单、收银自我提权、序号缺号、换机后旧 epoch、停用成员。
- F11（部分）：营业日为 closed 时拒绝新单。

### 浏览器端到端验证（Claude 内置浏览器 + 本机 Emulator + Vite 开发服务器，测试数据）

在两个源分别登录：`localhost:3000` 为老板 → 收银，`127.0.0.1:3000` 为后厨。

1. 老板登录后 POS 显示「这台设备不是主收银机」→ 设备页「设为主收银机」→ 老板退出，收银登录 → 开班（备用金 RM100）。
2. 红酱面·面薄·中·少辣·走青 + 云吞汤 15 粒 + 净面汤面小：本单 RM22.50；汤面不出现辣度；净面状态下两个肉类加料按钮被禁用。
3. 现金：未输入时确认按钮不可点 → 快捷 RM50 → 找零 RM27.50 → 接单。POS 依次显示 ✓本机已记录 → ✓云端已接单 → ✓后厨已收到，票号 261022-001；下一张牌自动建议 2 号。
4. 后厨屏：细面 1 团 / 面薄 1.5 团 / 云吞 18 粒（3+15+净面 0），净面行有黄色条；Emulator 数据中写入了 kitchenAckAtMs。
5. 开始制作 → 卡片移到「制作中」，待下锅合计归零（没有重复计数）→ 完成出餐 → 出现撤回条（剩余约 27 秒）→ 撤回 → 回到制作中，等候时间仍从原接单时刻算 → 再次出餐。
6. POS 显示「1个待回收」→ 打开餐牌选择器 → 1 号显示「待回收」→ 确认「实体牌已收回」→ 1 号变为可用。订单页显示 已出餐 / 已收款 / 后厨已收到 / 餐牌已收回。
7. QR 单：未勾选「已在收款端看到到账」时确认按钮不可点；勾选后接单成功（RM31.00）。
8. 第三单 RM7+RM9=RM16，现金 RM20 找零 RM4；切到订单页再回来，建议牌号正确地从 3 号开始。

**验证中发现并修复**：
- 切页后餐牌建议回到 1 号 → 改为把上次发出的牌号存进 IndexedDB。
- 768 宽和 390 宽下，本单把选餐区挤得几乎看不到，页头横向溢出 66px → 改成窄屏底部本单条、照片随格子缩放、页头紧凑化；重新截图后各视口横向溢出均为 0。
- 云吞汤照片底部有相邻格子的黄边 → 加大裁切内缩，重新生成照片。

**出现过一次、未能复现**：老板第一次指定主收银机后，设备页一度没有显示「就是本机」，刷新后正常。之后在门店恢复为「未指定」的状态下复现，页面不刷新也立即更新，控制台无错误。推测是读取页面时命令尚未返回（首次调用有冷启动）；已为订阅加上错误日志。

### 真实页面截图（`docs/screenshots/app/`，由 `scripts/screenshot-app.mjs` 用无头 Chrome 生成）

环境：本机 Emulator + Vite 开发服务器，测试数据；截图是实现出来的页面，不是设计稿。`screenshots.json` 记录了每张图的横向溢出像素，全部为 0。

| 文件 | 视口 |
|---|---|
| `pos-1366x900.png`、`pos-1024x768.png`、`pos-768x1024.png`、`pos-390x844.png` | POS 桌面 / 横屏 / 竖屏平板 / 手机 |
| `pos-payment-1366x900.png`、`pos-payment-390x844.png` | 收款抽屉（现金 RM20，找零 RM7.50） |
| `orders-1366x900.png`、`orders-390x844.png` | 订单页 |
| `kds-1920x1080.png`、`kds-1366x900.png`、`kds-1024x768.png` | 后厨屏 |

未执行：离线测试、实机（平板 / 后厨屏 1.5 米辨认 / 触控 / 声音）、员工可用性测试、200% 缩放与读屏检查、性能与负载测试、真实云部署。

## 52 个验收场景进度

图例：✅E Emulator 命令层已验证 · ✅D 仅领域层测试 · 🟡 部分 · ⏳ 未实现

| 组 | 场景 |
|---|---|
| 领域 M01–M13 | ✅D 全部；M02/M11/M13 另有服务端拒绝的 ✅E |
| 在线 O01–O13 | ✅E O01、O02、O03、O05、O06、O07、O08；O01/O02/O06/O08/O10 另经浏览器验证；🟡 O04（服务端 ✅E；客户端已实现「核对结果」流程，但没有在浏览器中模拟响应丢失）、O09（撤回超时与关账只在领域层验证，牌被重新分配已 ✅E）、O10（✅D 合计 + 浏览器验证 KDS 界面）、O11（POS 显示「等待厨房确认」，后厨心跳未做）；⏳ O12、O13 |
| 离线 D01–D14 | ✅ D01（E2E 真断网刷新 + IndexedDB 测试）、D02（IndexedDB 原子回滚测试）、D03（E2E + ✅E）、D04（✅E 每条重复 10 次 + E2E）、D05（✅E + E2E）、D07（✅E）、D08（✅E）、D11（✅D + ✅E + E2E）、D13（✅E）、D14（✅E 作废序号；客户端处理流程已实现，未在浏览器模拟响应丢失）；🟡 D06（服务端按 eventId 幂等 ✅E；未专门模拟「上传成功但页面在收到响应前关闭」）、D09（未知菜单版本 ✅E；只有一个菜单版本，「旧但有效版本」未测）、D10（未来时间与超出 24 小时资格 ✅E；「回拨 10 分钟」「跨 04:00」未单独测）、D12（同 eventId 导入 ✅；单写端锁已实现，未做双标签自动化测试） |
| 财务 F01–F12 | ✅D F01–F10、F12；F03 另有 ✅E；🟡 F11（写屏障 ✅E，关账流程未做） |

## 已知限制 / 设计判断（可调整）

- 菜单与 BOM 版本目前随代码发布（`MENU_VERSIONS`/`BOM_VERSIONS`），门店配置只选择启用版本；`publishMenu/Bom` 命令和售罄配置未做。
- 本机序号严格连续，只对收银机产生的 `createOrder`、`releaseToken` 生效；被拒绝的命令不消耗序号。`requestCancel` 不走序号。阶段 D 需要把在线与离线日志统一到同一序号流。
- 在线收款被服务器明确拒绝（例如餐牌冲突）：没有生成订单，收银修正后重新提交，界面提示勿再次收钱；被拒命令的序号会归还或作废。
- 离线 `needs_review` 记录目前只在同步中心显示原因与未入账金额，老板处理（解决事件）的命令与界面尚未实现。
- 离线营业快照与本机日志保存在浏览器站点数据中：清除站点数据、私密模式或设备损坏时无法保证；请在交班时导出恢复包。
- 更换主收银设备时 `lastAppliedSequence` 归零，旧设备日志将来走 offlineInbox 待核对。
- App Check 暂未强制（`ENFORCE_APP_CHECK=false`），需在测试云项目上先监测再开启。
- 退款与取消写入当日营业日，受当日写屏障约束；撤回出餐检查订单所属营业日是否已关账。

## 待用户配置（真实云操作前需要）

1. Firebase **staging 项目 ID** 与 **prod 项目 ID**（分开）。
2. Blaze 计费（Functions 需要）与预算告警金额。
3. 确认 Firestore 数据库区域 `asia-southeast1`（创建数据库时选定，之后不能更改）。
4. 首个 owner 的 Google 账号邮箱；员工账号方式。
5. DuitNow QR 图片与收款人名称；收据抬头。
6. 实拍素材（含熟净面 Kosong 图）；面薄与汤底的实际成本。

## 本地运行方式

```bash
npm ci && npm --prefix functions ci
# Emulator 需要 Java 21+（本机测试用 JDK 25）
npm run test:rules
npm run test:emulator
npm run emulators   # UI: http://127.0.0.1:4000
npm run photos      # 重新从图谱生成照片
```
截图：Emulator、种子数据和 `npm run dev` 都在运行时执行 `REGISTER_DEVICE_ID=<设备页显示的 ID> node scripts/screenshot-app.mjs`。

## 下一步入口

1. 后厨心跳命令 + POS「等待厨房确认 5 秒 / 心跳过期 15 秒」提示（O11）；跨营业日未完成单（O12）；58/80mm 收据与重印副本（O13，离线收据标「本机接单 / 人工传单」）。
2. 阶段 E：老板「离线待核对」处理界面（解决事件，例如餐牌已回收只补历史账、价格差异确认）、关账命令与写屏障流程、迟到离线单的「关账后待调整」与更正版本、进货/损耗/资金往来、报表与 CSV。之后删除 `src/legacy/`。
3. 离线补测：D06 页面在收到响应前关闭、D09 旧但有效的菜单版本（需要第二个菜单版本）、D10 时钟回拨与跨 04:00、D12 双标签自动化测试；实机拔网线测试。
4. 英文可选设置、员工培训图卡打印页。
4. 性能：主包约 855KB（主要是 Firebase SDK），后续按页面拆分代码。
