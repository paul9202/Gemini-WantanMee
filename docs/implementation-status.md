# 实施状态（豪云吞面 OS）

最后更新：2026-10-22 · 会话 1（续）· 分支 `claude/phase-a-domain`

## 当前阶段

**阶段 A 已完成；阶段 C 的服务端部分（Firebase 配置、Rules、命令、Emulator 测试）已完成。尚未把前端接到云端。** 下一步：前端数据层 + 阶段 B 图片 POS/KDS，接入这些命令与实时厨房投影。

| 阶段 | 状态 |
|---|---|
| A 基线与领域 | ✅ 已提交 `3564375` |
| C 云端营业闭环 | 🟡 服务端完成并通过 Emulator 测试；前端接入、KDS 实时订阅、心跳、App Check、菜单发布未做 |
| B UI 与工作流程 | ⏳ 未开始（原型 UI 仅做价格/Kosong 止血修正） |
| D 离线单机营业 | ⏳ 未开始（服务端已预留 registerId/epoch/连续序号） |
| E 财务与关账 | 🟡 领域计算完成；关账命令、账本页面、CSV 导出未做；关账写屏障已在命令中生效 |
| F 测试云与试营业 | ⛔ 需用户提供 Google 项目 |
| G 生产切换 | ⛔ 需用户授权 |

## 仓库与交接差异（实际核对）

- 远端 `paul9202/Gemini-WantanMee` 只有 `main` 两个提交，HEAD = `dce0025`，与交接审计基线一致。
- 本地以 `git init + fetch + checkout -t origin/main` 取得源码，没有覆盖已有文件；交接 zip 写进了 `.git/info/exclude`。
- 原 `package.json` 无法安装（`esbuild@^0.25` 与 vite 8 peer 冲突）；未使用的 `esbuild/express/dotenv/@google/genai` 已移除，并生成 lockfile。
- 审计列出的原型问题都在代码中确认过。

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

未执行：前端接入、浏览器验证、五视口截图、离线测试、实机、性能/负载测试、真实云部署。

## 52 个验收场景进度

图例：✅E Emulator 命令层已验证 · ✅D 仅领域层测试 · 🟡 部分 · ⏳ 未实现

| 组 | 场景 |
|---|---|
| 领域 M01–M13 | ✅D 全部；M02/M11/M13 另有服务端拒绝的 ✅E |
| 在线 O01–O13 | ✅E O01、O02、O03、O05、O06、O07、O08；🟡 O04（服务端查询/重试已通，客户端 `unknown_result` 流程未做）、O09（撤回超时与关账只在领域层验证，牌被重新分配已 ✅E）、O10（✅D 合计；KDS 界面未做）；⏳ O11、O12、O13 |
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
```

## 下一步入口

1. 前端数据层 `src/data/firebase/`：初始化（读取 env、连接 Emulator）、Auth 登录、Callable 封装（带 operationId，超时后先 `getOperationResult` 再用同一请求重试）、KDS 实时订阅 `kitchenTickets`（routing=digital，按 FIFO）、`ackKitchenTicket`。
2. 阶段 B：按 02/06 重做 POS（6 张图片入口、面种原料图、份量图卡、图卡、收款抽屉、三段确认状态）和 KDS（细面/面薄分栏、待下锅/制作中）；删除 mockData 自动注入、FirebaseModal、localStorage 存单。
3. 补后厨心跳与 O11；补 O12/O13；然后进入阶段 D（IndexedDB outbox + PWA + offlineInbox 补同步）。
