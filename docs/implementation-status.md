# 实施状态（豪云吞面 OS）

最后更新：2026-10-22 · 会话 1（续 2）· 分支 `claude/phase-a-domain`

## 当前阶段

**阶段 A 完成；阶段 C 服务端完成；阶段 B 的图片 POS / KDS / 订单 / 设备页已接上 Emulator 云端命令，并在浏览器里跑通了完整营业闭环。** 下一步：后厨心跳（O11）、收据打印（O13）、英文可选设置，然后进入阶段 D 离线营业。

| 阶段 | 状态 |
|---|---|
| A 基线与领域 | ✅ 已提交 `3564375` |
| C 云端营业闭环 | 🟡 服务端 ✅（`4e994dd`）；前端已接入命令与实时厨房；后厨心跳、App Check、菜单发布未做 |
| B UI 与工作流程 | 🟡 POS、KDS、订单、设备、登录已完成并经浏览器验证；老板报表页、收据打印、英文设置、员工培训卡页未做 |
| D 离线单机营业 | ⏳ 未开始（服务端已预留 registerId/epoch/连续序号） |
| E 财务与关账 | 🟡 领域计算完成；关账命令、账本页面、CSV 导出未做；关账写屏障已在命令中生效 |
| F 测试云与试营业 | ⛔ 需用户提供 Google 项目 |
| G 生产切换 | ⛔ 需用户授权 |

## 仓库与交接差异（实际核对）

- 远端 `paul9202/Gemini-WantanMee` 只有 `main` 两个提交，HEAD = `dce0025`，与交接审计基线一致。
- 本地以 `git init + fetch + checkout -t origin/main` 取得源码，没有覆盖已有文件；交接 zip 写进了 `.git/info/exclude`。
- 原 `package.json` 无法安装（`esbuild@^0.25` 与 vite 8 peer 冲突）；未使用的 `esbuild/express/dotenv/@google/genai` 已移除，并生成 lockfile。
- 审计列出的原型问题都在代码中确认过。

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
| 离线 D01–D14 | 🟡 D11（✅D）；⏳ 其余 |
| 财务 F01–F12 | ✅D F01–F10、F12；F03 另有 ✅E；🟡 F11（写屏障 ✅E，关账流程未做） |

## 已知限制 / 设计判断（可调整）

- 菜单与 BOM 版本目前随代码发布（`MENU_VERSIONS`/`BOM_VERSIONS`），门店配置只选择启用版本；`publishMenu/Bom` 命令和售罄配置未做。
- 本机序号严格连续，只对收银机产生的 `createOrder`、`releaseToken` 生效；被拒绝的命令不消耗序号。`requestCancel` 不走序号。阶段 D 需要把在线与离线日志统一到同一序号流。
- 已收款但服务器拒绝（例如餐牌冲突）时的「已收款待核对」流程属于客户端/阶段 D，尚未实现；服务器只返回明确的 reasonCode。
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

1. 后厨心跳命令 + POS「等待厨房确认 5 秒 / 心跳过期 15 秒」提示（O11）；跨营业日未完成单（O12）；58/80mm 收据与重印副本（O13）。
2. 阶段 D：IndexedDB 原子写入 localOrders/outbox/localTokens/序号；PWA（vite-plugin-pwa）预缓存壳与照片；断网接单与人工传单；`syncOfflineEvents` + offlineInbox 补同步；D01–D14。
3. 英文可选设置（不在按钮上并排双语）、员工培训图卡打印页、老板报表与日结（阶段 E），之后删除 `src/legacy/`。
4. 性能：主包约 855KB（主要是 Firebase SDK），后续按页面拆分代码。
