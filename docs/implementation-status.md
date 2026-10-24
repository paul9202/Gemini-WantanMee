# 实施状态（豪云吞面 OS）

最后更新：2026-10-24 · 堂食+打包混合单、吃完再加单一次结账，已部署 wantan-staging；平板实机未测 · 分支 `claude/phase-a-domain`

## 当前阶段

**阶段 A、C（服务端）完成；阶段 B 的 POS / KDS / 订单 / 设备页已接入云端；阶段 D 离线营业已实现，并通过真断网端到端验证（20/20）。** O11–O13 已完成（15/15）。**阶段 E 财务与日结已完成**：老板处理离线待核对、关账冻结与更正版本、进货/损耗/资金往来、经营报表与 CSV，经老板端端到端验证（19/19）。**英文可选设置、员工培训图卡、成员邀请/管理、菜单与成本发布已完成**（设置端到端 20/20）。**已部署到测试云 wantan-staging**（不登录的冒烟检查 7/7）。下一步：登录后的线上冒烟检查、实体设备联调与试营业。

| 阶段 | 状态 |
|---|---|
| A 基线与领域 | ✅ 已提交 `3564375` |
| C 云端营业闭环 | 🟡 服务端 ✅；前端已接入；后厨心跳 ✅、菜单/BOM 发布与成员邀请 ✅；App Check 未强制 |
| B UI 与工作流程 | ✅ POS、KDS、订单、同步、设备、登录、老板五页（含设置）、收据、英文可选、培训图卡，均经浏览器验证；**2026-10-23 新版 UI（后厨、点餐收款、订单、经营、设备）已落地并通过 4 套 E2E**，未部署；平板实机未测 |
| D 离线单机营业 | 🟡 已实现并通过 Emulator 与真断网 E2E；老板处理「待核对」离线记录的界面、实机/真实断网（拔网线）未做 |
| E 财务与关账 | ✅ 账本、关账快照、更正版本、离线待核对处理、报表、CSV；Emulator 与浏览器端到端验证 |
| F 测试云与试营业 | 🟡 `cc830b9` 已部署到 wantan-staging，不登录的冒烟检查 7/7；需要登录的线上流程、实体设备联调、试营业未做 |
| G 生产切换 | ⛔ 需用户授权 |

## 测试云部署：混合单与加单一次结账（wantan-staging，2026-10-24）

- 用户要求 push 并部署：把 `6bc85c7`（同一单堂食+打包；吃完再加单，与原单一次结账）部署到测试项目 `wantan-staging`（不是生产）。
- 命令：`npx vite build --mode staging`，然后 `firebase deploy --only functions,firestore:rules,hosting --project wantan-staging`，退出码 0。
  - Functions：新建 1 个（`recordGroupPayment`），更新 32 个，区域 asia-southeast1。
  - Rules：没有改动（上传时跳过，照常发布）。索引没有改动，未部署。
  - Hosting：https://wantan-staging.web.app ，包名 `index-DzcSBDKS.js`。
  - 没有改动门店数据，没有运行种子数据，没有迁移旧订单（旧订单、旧离线日志、旧厨单没有行级堂食/打包时按整单读取）。
- 部署前：领域测试 79/79、构建、服务端类型检查、Emulator 命令 43/43、Rules 28/28、本地 POS→后厨→加单→一次收款走查通过。
- **冒烟检查**（`node scripts/staging-smoke.mjs wantan-staging index-DzcSBDKS.js`，不登录、不写数据）：✅ 8/8；Callable 清单加入 `recordGroupPayment`，共 33 个。
- **未执行**：登录后的线上流程（没有测试云账号密码，也不代为输入）；红米平板实机测试；任何付款测试。

## 测试云部署：营业流程改版（wantan-staging，2026-10-24）

- 用户要求部署后，把 `8dac2d6`（营业流程改版，见 `docs/operations-redesign-2026-10-23/IMPLEMENTATION.md`）部署到测试项目 `wantan-staging`（不是生产）。
- 命令：`npx vite build --mode staging`，然后 `firebase deploy --only functions,firestore:rules,hosting --project wantan-staging`，退出码 0。
  - Functions：新建 5 个（`recordPayment`、`reversePayment`、`writeOffPayment`、`reinstateWrittenOff`、`rejectKitchenCancel`），更新 27 个，区域 asia-southeast1。
  - Rules：新增 `paymentWriteOffs` 只读给老板。索引没有改动，未部署。
  - Hosting：https://wantan-staging.web.app ，包名 `index-C0YUff8i.js`。
  - 没有改动门店数据，没有运行种子数据，没有迁移旧订单（旧订单按兼容规则读取）。
- 部署前：领域测试 72/72、构建、服务端类型检查、Emulator 命令 41/41、Rules 28/28、浏览器 E2E 全部通过。
- **冒烟检查**（`node scripts/staging-smoke.mjs wantan-staging index-C0YUff8i.js`，不登录、不写数据）：✅ 8/8。新增两项检查：32 个 Callable 全部上线；收款码原图的 sha256 与用户原图一致。
- 浏览器打开线上登录页：控制台没有错误。之前打开过旧版本的设备会先显示旧版本，新版本已下载、处于等待状态，需要登录后点「更新并重新载入」或完全关闭应用后重开。
- **未执行**：登录后的线上流程（没有测试云账号密码，也不代为输入）；红米平板实机测试；收款码扫码与任何付款测试。

## 测试云部署：新版 UI + 平板适配（wantan-staging，2026-10-23）

- 用户要求部署后，把 `48f8432` 部署到测试项目 `wantan-staging`（不是生产）。命令：`npx vite build --mode staging`，然后 `firebase deploy --only hosting --project wantan-staging`，退出码 0。
- 只部署 Hosting：从上次部署的 `cc830b9` 到现在，`functions/`、Rules、索引、`firebase.json` 都没有改动。
- 部署前：tsc 退出码 0，单元测试 60/60。
- 冒烟检查（`node scripts/staging-smoke.mjs wantan-staging index-D7w96uOK.js`，不登录、不写数据）：✅ 7/7，网站提供的是本次构建的版本，前端连接本项目、未连 Emulator，Callable 拒绝未登录调用，Rules 拒绝匿名读取。
- 浏览器打开线上登录页：载入新包，viewport 含 `interactive-widget=resizes-content`；没有登录。
- 曾打开过旧版本的设备，会先显示旧版本并提示「有新版本可用」，需要点「更新并重新载入」。
- **未执行**：登录后的线上流程（没有测试云账号密码，也不代为输入）；红米平板实机测试。

## 档口平板适配（2026-10-23，依据 `docs/ui-mockups-2026-10-23/DEVICE-BASELINE.md`）

目标设备：候选 REDMI Pad 2 9.7 英寸 4G（4GB＋128GB），**尚未确认购买，也没有实机**。2048×1280 是硬件像素，不是 CSS 视口；本次没有写死任何尺寸或 DPR，只用多组候选视口做到货前预检。**不能据此声称已完全适配该设备。** 仅本地开发，未部署。

### 改动
- 视口：`index.html` 加 `interactive-widget=resizes-content`，Android Chrome 弹出软键盘时布局视口随之变矮，固定栏和弹窗（`100dvh`）不会被键盘盖住。theme-color 同步为新砖红。
- 外壳：≥768px 显示左侧岗位导航（平板 76px、≥1280 92px，矮屏可滚动），手机才用底部导航；平板页头单行，点餐页在 <1280 时隐藏大标题，把一行留给堂食/打包、餐牌和后厨状态。
- 点餐（按方向而不是写死宽度）：
  - 横屏 ≥768：餐品为窄栏（2 列图片）、中间配置、右侧本单常驻（`clamp(300px,30vw,400px)`），不隐藏购物车。
  - 竖屏 ≥768：餐品在配置上方（容器宽度足够时 6 张一行），本单仍在右侧。
  - <768（例如候选竖屏 600 宽）：单栏，底部有「本单 N 份 · 查看 / 修改」显式入口与去收款，本单可全屏查看、改数量、编辑、删除。
  - 三栏只在 ≥1536 横屏使用（原 1280）。
  - 配置栏底部数量与「加入本单」在平板上同一行；本单每行的数量 / 编辑 / 删除占满整行，窄栏不换行。英文在 <1280 时按钮用短词（Add / Save）。
  - 加入后的「撤销」提示在平板上移到页头右侧，不盖住特别要求按钮。
- 触控尺寸：点餐、收款、结果、餐牌、订单、后厨、设备、老板概览与标签页的可点控件改为不低于 56 CSS px（步进器、编辑 / 删除、清空、快捷金额、数字键、关闭、筛选、导出、语言切换、退出等）。
- 收款弹窗：
  - 底部固定区始终显示「应收 · 实收 · 找零」与确认按钮；中间内容独立滚动（`overscroll-contain`），头部关闭按钮固定。
  - 触屏设备（`pointer: coarse`）上实收框 `inputMode="none"`，用弹窗内数字键输入，不弹系统键盘；接实体键盘仍可直接输入。
  - 断网 QR 的核实说明等文字框获得焦点后自动滚到可见处。
  - 现金不足、QR 未核实不能确认；提交中按钮锁定——规则与命令均未改动。
- 其他弹窗（餐牌、取消 / 退款、收据、结果）限制在可见高度内并可滚动，Esc 可关闭。
- 设备页「高级设备信息」新增**本机屏幕测量**：实时显示 CSS 视口、visualViewport、DPR、屏幕 / 可用尺寸、方向、是否 PWA、触控类型，可复制或下载 JSON（字段与 DEVICE-BASELINE 的测量脚本一致），用于到货后建立固定 profile。

### 预检（浏览器模拟，不是实机）
`scripts/tablet-preflight.mjs`：CDP 设备模拟 + 触控 + Android Chrome UA，干净 Emulator，界面真实下单。候选 profile（全部为假设，到货后替换）：

| profile | CSS 视口 | DPR | 假设 |
|---|---|---|---|
| L960x600 | 960×600 | 2.133 | 横屏，PWA 全屏 |
| L960x536 | 960×536 | 2.133 | 横屏，扣地址栏 |
| L1024x640 | 1024×640 | 2 | 横屏 |
| L1280x800 | 1280×800 | 1.6 | 横屏，PWA 全屏 |
| L1280x736 | 1280×736 | 1.6 | 横屏，扣地址栏 |
| P600x960 | 600×960 | 2.133 | 竖屏 |
| P800x1216 | 800×1216 | 1.6 | 竖屏，扣地址栏 |
| 键盘近似 | 960×300、1280×430、600×560 | — | 收款弹窗打开后视口变矮 |

结果（`docs/screenshots/tablet-preflight/`，49 张截图 + `tablet-preflight.json`）：
- 49 张截图全部横向溢出 0；可见可点控件中小于 56px（或宽 <44px）的为 0（覆盖点餐、收款、结果、后厨、订单、设备、老板概览、英文点餐 / 收款 / 后厨）。
- 横屏 5 组与竖屏 800 宽：本单栏常驻可见；竖屏 600 宽：有显式本单入口。
- 收款弹窗在 7 组视口和 3 组键盘近似高度下，确认按钮、应收 / 实收 / 找零、关闭按钮都在可见区域内；内容区可滚动，实收框可滚到可见处。
- 7 组视口编辑 → 换餐品 → 取消：编辑期间原行不变，取消后与编辑前一致。
- L960x600 下真实收款提交，结果弹窗显示「后厨已收到」（由后厨回执驱动）。
- 回归：`npm run check` 60/60；`link-receipt` 16/16、`offline` 20/20、`owner` 19/19、`settings` 20/20（各在干净 Emulator 上）；`ui-2026-10-23-shots` 桌面 / 手机 6 种视口仍无横向溢出，6 单在 1600×1120 / 1920×1080 主按钮仍全部同屏。

### 尚未执行的实机测试（到货后必须做，做完才可标注「已适配该设备」）
1. 确认最终型号与规格（9.7 英寸 4G 或 11 英寸 Wi-Fi）、HyperOS / Android 与 Chrome 版本、系统显示大小与字体设置。
2. 用设备页「本机屏幕测量」分别记录：Chrome 横屏 / 竖屏、已安装 PWA 横屏 / 竖屏、地址栏显隐、收款弹窗 QR 说明框键盘展开、横竖屏切换后；存成 profile，替换预检脚本里的候选值，重跑预检与截图。
3. 实机验证 `interactive-widget=resizes-content` 在该 Chrome / PWA 下确实缩小布局视口；若不生效，需改用 visualViewport 方案。
4. 实机点按：56px 目标、图片与金额清晰度、误触率；系统字体放大时的布局。
5. 实机营业链路：登录 / 开班 / 主收银机、连续点单、现金与 QR、结果不明重试、断网正式收款、关机重开恢复、联网补同步不重复送厨、人工交接、餐牌占用与回收、恢复包导出。
6. 切后台 / 返回、锁屏 / 唤醒、熄屏后重连、长时间营业的响应与内存表现（4GB RAM 不能凭规格判定通过）。
7. 新单提示音在平板与后厨设备上的实际音量与授权流程。
8. 打印（58 / 80mm 收据）从平板发起的实际效果。

## 新版 UI 落地（2026-10-23，依据 `docs/ui-mockups-2026-10-23/`）

只改界面与布局，沿用原有命令、权限、金额领域函数、离线与付款规则；没有改 Functions、Rules 或数据结构。仅本地开发，**未部署**。

### 共享视觉与导航
- `src/index.css`：换成原型的奶油白 / 砖红 / 松绿色板，沿用旧 token 名，未单独改版的页面（同步、收支、待核对、日结、设置、图卡、收据、登录）自动换新色。后厨深色变量另设一组，浅色由 `.kds-light` 覆盖。
- `src/app/Shell.tsx`：桌面左侧岗位导航（点餐 / 订单 / 后厨 / 经营 / 同步 / 图卡 / 设备，按岗位显示），手机底部导航；页头含标题、门店在线、营业日，页面可通过 `ShellHeaderActions` 把操作放进页头。原型顶部的「HAO / WORKSPACE / 设计提案」评审导航和「示例数据、模拟断网、重置演示」均未带入。
- 老板子页标签改为页内横排（原来手机上的固定底栏会和外壳底栏重叠）。
- `src/ui/iconSymbols.ts` 补入原型的线性图标（声音、主题、断网、刷新、搜索、下载、QR 等）。

### 后厨（`src/features/kitchen/`）
- 顶部四张合计卡：细面 / 面薄 / 云吞分别合计，只算待做（`summarizeKitchen` 不变，制作中与人工单不计）；口味卡含黑 / 红 / 白酱、汤面、云吞汤与净面份数。
- 左侧待做（FIFO）、右侧制作中；卡片固定位置：餐牌、堂食 / 打包、计时条（正常等候 / 等候较久 / 已超时·请优先处理，8 / 12 分钟，文字与颜色并用）、面种 + 每份团数、特殊要求图卡 + 短文字、打包说明（干捞不附送清汤 / 汤品保留原汤）、面团与云吞小计、主按钮。新增：干捞云吞在卡片上显示红 / 黑酱（原来只在合计里）。
- 开始制作、出餐、30 秒撤回、取消确认仍走原命令（版本校验、失败提示）；一次只处理一张单，防连点。
- 断网或数据来自缓存时冻结全部动作，横幅「厨房连接中断，操作已暂停」+「重新连接」（`disableNetwork`→`enableNetwork`，是否恢复以服务器快照为准）。Firestore 出餐后会短暂（<1 秒）标记 `fromCache`，原来会让横幅闪一下并让撤回按钮失效；现在缓存状态持续 1.5 秒才算过期，浏览器断网仍立即冻结。
- `prefs.ts`：深浅色为本机偏好；新单提示音用 WebAudio 合成（离线可用），首次收到服务器数据只记录不响，之后新待做单才响；浏览器未授权出声时按钮显示提醒点，员工点一下屏幕即解锁。
- 不显示售价、收款或利润（厨房投影本来就没有这些字段）。

### 点餐与收款（`src/features/pos/`）
- 桌面 ≥1280：选餐 / 当前配置 / 本单明细三栏；1024–1279：选餐与配置同一滚动栏、本单在右；<1024：单栏 + 底部「本单 · 查看 / 修改」和「去收款」，本单可全屏打开、改数量、编辑、删除。
- `Customizer.tsx`：面种、份量（价格来自当前菜单，净面显示半价）、辣度（汤品不显示）、常用特别要求（走青、无油渣、加 3 粒、加叉烧，价格取菜单）直接可见；葱 / 油渣多少与净面在「更多配料 / 净面」展开。组合仍由 `normalizeConfig` 收敛：净面清除并锁定肉类加料、照片换无肉碗图；干捞云吞只显示红 / 黑酱。新增「数量」步进器（`addLine` 原本支持数量）。
- 编辑：点「编辑」后原行保持不变，直到「保存修改」；「取消修改」恢复，不会先删后加。
- `PaymentDrawer.tsx` 改为居中弹窗：左边核对本单（应收、堂食·餐牌、明细与特别要求），右边现金（输入 + 快捷金额 + 数字键 + 找零）或 DuitNow QR（核对到账勾选；断网需外部核实说明）。现金不足、QR 未核实都不能确认（仍是 `checkPayment`）。本机保存失败的信息留在弹窗里。
- `OrderResult.tsx`：收款后弹窗显示餐牌大字和三个独立事实——本机已记录、云端已接单、后厨已收到（只有 KDS 回执才打勾；5 秒「等待厨房确认」、15 秒且心跳过期告警并可登记人工传单）；断网单显示「云端未同步」「请人工传单」。弹窗关闭后第一栏「刚刚送到后厨」继续显示实时进度，可重新打开。
- 主收银机、离线正式收款、IndexedDB 原子保存、unknown_result、幂等、餐牌锁与人工交接的代码未改动；餐牌仍取真实可用列表。

### 订单、经营、设备
- 订单：全部 / 待做 / 制作中 / 已出餐 / 已取消筛选（带数量）、按餐牌号 / 票号 / 餐品搜索、表格列「餐牌·时间 / 餐品 / 用餐方式 / 后厨进度 / 收款」，后厨进度下注明后厨已收到、已人工传单、待回收餐牌等；导出当前筛选结果 CSV（`toCsv`，防公式注入）。收据、取消、退款流程不变。
- 经营：问候 + 今日 / 近 7 天 / 近 30 天；净收款大卡（现金 / QR / 已扣退款）、估算经营利润、已出餐（附厨房处理中单数）、8 分钟内出餐率。新增领域函数 `receiptsTrend`（单日按门店时区整点、多日按营业日补零）与 `dishRanking`（按 6 张入口、只算已出餐），都有单元测试。「钱从哪里来」为经营估算，现金视角另行展开并注明不是钱箱金额。「营业小提醒」来自实时数据：超时单、待回收餐牌、离线待核对、应退款。原来的收款构成、出餐效率、酱料 / 面种、回本进度收进「细账」。无数据显示空态。
- 设备：本机 → 云端 → 后厨三段状态（主收银机待核对、未同步条数、后厨心跳），离线准备检查，断网说明（去同步中心）、导出正式恢复包（`exportRecoveryPackage`，导入仍在同步中心），语言、岗位、主收银机、后厨显示、菜单版本、图卡入口；技术信息收进「高级设备信息」。

### 测试与验证（本机 Emulator + `VITE_USE_EMULATORS=true` 构建 + `vite preview :4173`，测试账号来自种子文件）
- `npm run check`：tsc 退出码 0；单元测试 60/60（新增 2 项：收款走势、畅销品排行）；构建成功。
- 端到端（每个都在干净 Emulator 上跑）：
  - `link-receipt-e2e` 16/16（后厨在线回执、45 秒心跳过期、15 秒告警与人工传单、跨营业日、58mm 收据打印）。
  - `offline-e2e` 20/20（CDP 真断网、SW 载入、本机原子保存、人工交接 / 出餐 / 回收、补同步不重做、转电子厨单）。
  - `owner-e2e` 19/19（待核对、收支、关账、更正版本、CSV）。
  - `settings-e2e` 20/20（邀请、发布菜单价与售罄、英文 POS / KDS、图卡 A4 单页 PDF、停用）。
- 脚本只改了 DOM 选择器与改名后的文字（结果改从结果弹窗读取、餐牌号从本单芯片读取、「后厨已连接」「连接与设备」「8 分钟内出餐率」等），没有删除业务断言。另把注册按钮改为等待可点击后再点；设置脚本里图卡页的等待由 10 秒放宽到 30 秒（这台机器上切页后会话载入偶尔超过 10 秒，第一次失败时截图停在「正在载入…」）。
- 新增 `scripts/ui-2026-10-23-shots.mjs`：在 Emulator 里通过界面真实下 6 单（含净面、多项特殊要求、打包、干捞云吞红酱），后厨开始 2 单，然后截图并检查。结果在 `docs/screenshots/ui-2026-10-23/`（26 张 + `ui-shots.json`）：
  - 390×844、768×1024、1024×768、1366×900、1600×1120、1920×1080 全部无横向溢出。
  - 6 单（4 待做 + 2 制作中）在 1600×1120 与 1920×1080 下 6 个主按钮全部同屏；第 7 单（3 个餐品）加入后 1920 下 6/7，需要滚动。
  - 后厨真断网（CDP offline）：横幅出现、全部动作按钮禁用。
  - 前台→后厨：首单在后厨刚登录时显示「正在送到后厨」（未打勾），之后各单为「后厨已收到」——由真实回执驱动。
- 浏览器手动检查：编辑后取消保留原行；现金 RM10 不能确认、RM20 找零 RM6；QR 未勾选不能确认；汤品不显示辣度 / 油渣 / 净面；出餐→撤回回到制作中；双击开始制作只生成一次。

### 与 mockup 的主要差异
- 页头保留「测试环境」标记与退出；导航多了「同步」「图卡」（原有功能必须可达）。
- 收款保留数字键（平板上不弹系统键盘也能输入）；按钮文字沿用「确认收款并接单」。
- 1024–1279 宽度为两栏（配置在选餐下方），原型只画了三栏和手机。
- 后厨计时条在制作中显示「正在制作」；「返回前台」只对老板显示（后厨岗位不能进前台）。
- 订单页没有「示例收据」，收据用真实 `ReceiptDialog`；经营页没有示例数字，无数据显示空态。

### 未执行 / 未完成
- 未部署 wantan-staging；没有接触线上数据。
- 实体平板、厨房电视、真实打印机（58 / 80mm 收据、A3 图卡）未测；A4 图卡与 58mm 收据只验证了 PDF。
- 提示音：只确认了「未获浏览器出声权限」的提醒点会显示；没有实际听声音，也没在后厨设备上测音量。
- 员工可用性测试（看图辨认、找零正确率）未做。
- 英文：员工页面跟随设置；老板端、订单页仍为中文（与之前一致）。

## 仓库与交接差异（实际核对）

- 远端 `paul9202/Gemini-WantanMee` 只有 `main` 两个提交，HEAD = `dce0025`，与交接审计基线一致。
- 本地以 `git init + fetch + checkout -t origin/main` 取得源码，没有覆盖已有文件；交接 zip 写进了 `.git/info/exclude`。
- 原 `package.json` 无法安装（`esbuild@^0.25` 与 vite 8 peer 冲突）；未使用的 `esbuild/express/dotenv/@google/genai` 已移除，并生成 lockfile。
- 审计列出的原型问题都在代码中确认过。

## 测试云部署（wantan-staging，2026-10-22）

- 经用户同意，把 `cc830b9` 部署到测试项目 `wantan-staging`，命令为 `firebase deploy --only functions,firestore:rules,firestore:indexes,hosting`，退出码 0。
  - 前端用 `vite build --mode staging` 构建（`.env.staging`，`VITE_USE_EMULATORS=false`）。
  - Functions：新建 12 个（`heartbeatDevice`、`recordManualHandoff`、`resolveOfflineReview`、`recordExpense`、`voidLedgerEntry`、`recordWastage`、`recordCashMovement`、`closeBusinessDay`、`restateBusinessDay`、`inviteMember`、`publishMenu`、`publishBom`），更新 15 个，区域 asia-southeast1。
  - Rules 与索引已发布；Hosting 已发布到 https://wantan-staging.web.app 。
  - 没有改动门店数据，也没有运行种子或演示数据。
- 此前的部署（16:18，到阶段 D）由另一个会话完成，不是本会话。
- **冒烟检查**（`node scripts/staging-smoke.mjs wantan-staging <包名>`，不登录、不写数据）：✅ 7/7。
  1. 网站可访问，提供的是本次构建的包。
  2. 前端连接的是本项目，没有连接 Emulator。
  3. `sw.js` 不缓存；营业照片可以下载。
  4. 27 个 Callable 全部上线，未登录调用被拒绝（未登录时多数命令先做输入校验，返回 `INVALID_ARGUMENT`，`runCommand` 不会执行业务；没有 404 或 INTERNAL）。
  5. 匿名读取订单、收款、成员、成本、菜单/BOM 版本、日结、门店配置，全部返回 403。
- 浏览器（Claude 内置浏览器）：
  - 登录页正常显示，控制台没有错误，英文切换正常。
  - 曾经打开过旧版本的设备会先显示旧版本，新版本已下载、处于等待状态。登录后页头会提示「有新版本可用」；在登录页不会提示。
  - 实际营业设备需要登录后点「更新并重新载入」，或者完全关闭应用后重新打开。
- **未执行**：需要登录的线上流程，包括下单、后厨收单、老板设置页、邀请、发布菜单。原因是我没有测试云账号的密码，也不代为输入密码。

## 英文可选、培训图卡、成员管理、菜单与成本发布

### 英文可选设置
- 每台设备单独设置（`localStorage` 的 `hao-lang`），默认中文。在登录页或设备页的「界面语言」切换，不需要联网。
- 员工界面都已支持英文：登录、页头导航、POS（选餐、本单、收款、餐牌、提交步骤、开班、离线横幅）、KDS（待下锅合计、厨单、菜名、动作按钮）、设备页，以及服务器拒绝原因 `reasonText`。
- 一次只显示一种语言，按钮上没有中英并排。图卡文字使用 `PICTOGRAMS` 的 zh/en。KDS 菜名用 `lineNameEn` 根据厨单行配置生成（服务器只保存中文名）。
- 老板端（概览、收支、待核对、日结、设置）、订单页和同步页保持中文。收据保持中文。

### 员工培训图卡 `/training`（所有岗位可进入，导航「图卡 / Cards」）
- 上半部：6 张入口照片与当前生效菜单的价格，加上细面和面薄。下半部：辣度、葱、油渣、净面与加料、堂食/打包、后厨动作与餐牌回收。
- 照片和图形与 POS/KDS 共用同一套 `Photo`/`PictoArt`，文字随本机语言变化。
- 可以选择 A4 或 A3 后打印。打印时隐藏导航和横幅，A4 实测为 1 页。
- 原来打印时只保留 `#print-root`，这条规则对所有页面都生效。现在改为只在 `#print-root` 有内容时（也就是收据弹窗打开时）生效，其他页面正常打印。收据回归测试增加了「打印时隐藏应用、只显示收据」的断言。

### 成员管理（老板 → 设置）
- 新命令 `inviteMember`（只限老板）：按邮箱找到或创建 Auth 账号，写入成员文档（岗位、启用、称呼、邮箱），然后返回**设置密码链接**（`generatePasswordResetLink`）。老板把链接交给员工，员工自己设置密码。仍然没有公开注册。重复邀请不会产生重复账号。
- `manageMember` 改用 merge 写法，保留邮箱和称呼。停用成员时会吊销该账号的刷新令牌（`revokeRefreshTokens`）。
- 页面功能：成员列表、改岗位、停用/恢复（不能改自己）、邀请表单、链接复制。

### 菜单与成本发布
- 菜单和 BOM 现在有两个来源：随代码发布的版本，加上 Firestore 里由老板发布的版本 `menuVersions/{v}`、`bomVersions/{v}`。版本号格式为 `menu-YYYYMMDD-NN`，计数器在 `config/public`。
- 服务端统一通过 `loadMenu`/`loadBom` 读取版本（`functions/src/core/catalog.ts`），`createOrder`、离线补同步、待核对补入账、账本都使用这一处。
- `publishMenu`（只限老板）：
  - 基于当前生效版本修改价格、加料价、售罄。
  - 价格范围为 RM0.50–RM1000。
  - 有 Kosong 的规格必须是偶数 sen，Kosong 价由系统自动取半价。
  - 不允许全部售罄。
  - 如果基础版本已不是当前生效版本，返回 `STALE_VERSION`。
- `publishBom`（只限老板）：
  - 修改单位成本（0.1 sen 精度）。
  - 面球成本必须是偶数，半球取一半。
  - 可标记某项成本已校准。
  - 只影响之后的新订单。
- 领域函数在 `src/domain/catalog.ts`，前后端共用。
- 收银机通过 `useMenu(activeMenuVersion)` 自动切换到新菜单，并缓存到本机供离线使用。离线收据按成交时的菜单版本显示（`menuForVersion`）。
- 版本切换后，按旧价提交的在线订单返回 `MENU_CHANGED`，收银需要重新确认。离线期间按旧但有效的版本成交的单，补同步时仍按旧价入账，并记录 `menuVersionCurrent`（D09）。
- Rules：`menuVersions` 老板和收银可读，后厨不可读；`bomVersions` 只有老板可读。

### 新增 / 修改文件
- 新增：
  - `src/domain/catalog.ts`(+test)
  - `functions/src/core/catalog.ts`
  - `functions/src/commands/catalog.ts`
  - `functions/test/catalog.test.ts`
  - `src/app/i18n.ts`
  - `src/data/menu.ts`
  - `src/features/owner/SettingsPage.tsx`
  - `src/features/training/TrainingPage.tsx`
  - `scripts/settings-e2e.mjs`
- 修改：
  - `functions/src/commands/{admin,createOrder,offline,review,ledger}.ts`、`functions/src/index.ts`
  - `src/domain/lineItem.ts`（`lineNameEn`/`lineName`）
  - POS、KDS、设备、登录、页头、收款、餐牌、收据、同步页
  - `src/index.css`（打印规则只作用于收据）

### 验证
- 根目录：`tsc --noEmit` 退出码 0；`npm test` 58/58（新增 catalog 4 项）；`npm run build` 成功。
- Functions：typecheck 退出码 0；Rules 28/28；命令 + 离线 + 连接 + 财务 + 目录共 31/31（新增 catalog 4 项）。
  - catalog 4 项覆盖：菜单发布；旧版本离线单与 D09；BOM 只影响新单；邀请 → 链接设置密码 → 登录 → 停用。
- `node scripts/settings-e2e.mjs`（3 台无头 Chrome + 干净的 Emulator + 正式构建）：✅ 20/20，结果在 `docs/screenshots/settings/settings-e2e.json`。覆盖以下流程：
  1. 邀请后厨成员，用链接设置密码，新员工登录后直接进入后厨。
  2. 发布小份 RM8，并把干捞云吞设为售罄。收银机不刷新即显示「RM8 起」，售罄入口不可点。
  3. 切换英文后按 RM8 收款，订单记录了新菜单版本。
  4. KDS 英文显示正常。
  5. 图卡页中英文截图；打印预览；A4 单页 PDF；390 宽无横向溢出。
  6. 停用成员后，员工被登出、无法再进入。
  - 前两轮失败都是脚本问题：标题文字写错、正则、首单冷启动等待太短、停用后检查过早。另外发现 A4 打印为 2 页，这是真实问题，已把打印版面改为 6 列、缩小照片后变为 1 页。
- `node scripts/link-receipt-e2e.mjs` 回归（打印规则改动后，干净的 Emulator）：✅ 16/16（新增「打印时只显示收据」）。
- **未执行**：
  - 实体打印机打印图卡和收据。
  - 平板实机查看英文界面。
  - 真实邮件发送邀请（目前由老板手动转交链接，没有接邮件服务）。
  - `offline-e2e.mjs` 与 `owner-e2e.mjs` 本次没有重跑。这次对相关页面只改了文字，菜单加载改为 `useMenu`。

## 阶段 E：财务与日结

### 账本与口径
- **成本账本 `costEvents`**：每笔理论成本分配或反转单独记一条，带自己的营业日（`allocate` 在接单日，待做取消的 `reverse` 在取消日）。原来的 `orderCosts` 数组按营业日查不出来，所以新增这个集合；`orderCosts` 保留作订单明细。仅老板可读，已加入 Rules 和读取矩阵测试。
- **账本 → 财务事件**（`src/domain/ledger.ts`）：收款、退款、成本事件、损耗、支出、钱箱往来都映射到 `finance.LedgerEvent`，复用 `summarizePeriod` 与 `expectedCashDrawer`。前端预览和服务端关账用的是同一套函数。
- 作废的支出和损耗不计入。损耗关联的订单如果成本仍在账上（制作中取消、已出餐），自动标「已在订单成本中」：只记数量，不重复扣款（F04）。
- **统一写屏障 `markDayActivity`**：所有影响某营业日账本的命令（接单、取消、退款、支出、损耗、钱箱往来、离线补入）都写一次营业日文档。这样它们和关账在同一个文档上串行：关账先提交，这些命令重试后会被拒绝；它们先提交，就会被关账汇总包含（F11）。

### 新命令（全部仅老板）
| 命令 | 说明 |
|---|---|
| `recordExpense` | 进货 / 固定费用付款（房租等）/ 其他营业费用 / 资本设备。记录实际金额、是否已付、付款来源（钱箱 / 银行 / 老板自付）、归属日；可登记为某条已作废记录的更正（`correctionOf`，原记录必须先作废） |
| `voidLedgerEntry` | 作废支出或损耗，必须写原因；不硬删除 |
| `recordWastage` | 半面球、云吞、叉烧数量，原因，可关联订单；按 BOM 计成本 |
| `recordCashMovement` | 补入现金、取走现金、存入银行 |
| `closeBusinessDay` | 一个事务内读取该营业日全部账本，计算钱箱应有/实点/差额与 QR 账面/银行核对/差额，写入不可变版本 `dailyReports/{date}/versions/{n}`（含账本水位、例外清单、固定费用口径），营业日置为 closed。有未出餐单、待回收餐牌、应退款、离线待核对时，必须确认并写结转说明 |
| `restateBusinessDay` | 已关账日按当前账本重算，写版本 n+1（`restates: n`），旧版本保持不变；默认沿用原实点金额 |
| `resolveOfflineReview` | 处理离线待核对记录。**补入账**：原单号入账；一律只补历史账、不抢占当前餐牌锁；仍是人工单、不送厨；金额不符时按实收入账并记录 `priceVarianceSen`；QR 无核实依据必须勾选「已在银行端确认到账」；落在已关账日的计入「关账后待调整」。**不入账**：保留原记录与原因。菜单未知、配置非法、订单号冲突、作废序号只能选不入账 |

### 老板端页面（`/owner`，老板登录后默认进入）
- **概览**：今日 / 近 7 天 / 近 30 天，并与上一区间对比。
  - 四个指标：净收款、估算经营利润（注明未含工资税费、面薄与汤底成本待校准）、已出餐份数、8 分钟达标率（无样本显示「—」）。
  - 收款构成、出餐效率（平均 / 中位 / P90 / 分布，标明样本数与排除数）、畅销品 / 酱料 / 面种（只算已出餐份数）。
  - 经营估算与现金两本账并列；按估算利润的回本进度（允许负值，不沿用演示的 RM1,920）。
  - 离线待核对的未入账金额单独提示，不混进总额；一键导出 5 个 CSV。
- **收支**：支出、损耗、钱箱往来三个表单。快捷模板只预填说明，金额必须手填；面球按 0.5 递增；可按票号关联订单；按营业日列出记录，可作废并更正。
- **待核对**：逐条显示原因、未入账金额和处理建议，补入账或不入账都必须写核对说明。
- **日结**：
  - 关账前逐步核对 6 项：未出餐与待回收、同步与待核对、实点现金、QR、损耗、差额预览。差额用「实际比应有少 / 多 RM…」表示。
  - 关账并冻结；关账后显示「关账后待调整 N 项」，可生成更正版本；每个版本都可以单独导出 CSV。
- 手机 390 宽为底部四项导航（概览 / 收支 / 待核对 / 日结）。
- **CSV**：汇总、订单、收款退款、支出、损耗、日结差额分别成文件。UTF-8 BOM；金额列以 sen 为单位并在表头注明；时间带时区；自由文本有公式注入防护。

### 清理
- 删除 `src/legacy/`（原型 UI 与计算）。原型那 5 项测试随之删除，它们覆盖的规则已由领域测试覆盖。

### 验证中发现并修复
- **页面空白**：门店配置载入前营业日为空，收支页和日结页计算 `nextDay('')` 直接抛错，整页空白；概览页会用无效日期发起一次查询。现在三个页面在营业日确定前都不查询。由老板端端到端测试发现。
- **测试期望错误（2 处）**：关账后迟到单的 Emulator 测试中，实点现金没有包含那张断网单已收的现金；E2E 脚本中有两个元素选择器写错。为消除歧义，现金往来表单的标签改为「往来类型 / 往来原因」。

### 新增 / 修改文件
```
A src/domain/ledger.ts  src/domain/ledger.test.ts
A src/features/owner/{data.ts,ui.tsx,OverviewPage.tsx,FinancePage.tsx,ReviewPage.tsx,ClosePage.tsx}
M src/app/{App.tsx,router.ts,Shell.tsx}  src/data/firebase/{commands.ts,reasons.ts}
A functions/src/commands/{ledger.ts,close.ts,review.ts}  functions/test/finance.test.ts
M functions/src/core/{command.ts,store.ts,errors.ts,orderWrites.ts}  functions/src/commands/lifecycle.ts  functions/src/index.ts
M firestore.rules  functions/test/rules.test.ts（costEvents 仅老板）
A scripts/owner-e2e.mjs  M scripts/lib/cdp.mjs（Auth/Callable 辅助）  M scripts/offline-e2e.mjs（老板首页改为 /owner）
A docs/screenshots/owner/*（截图、CSV 样例、owner-e2e.json）
D src/legacy/
```

## O11–O13：后厨连接、跨营业日、收据

- **O11 后厨心跳与回执**
  - 新命令 `heartbeatDevice`：后厨、收银、老板设备都可以发；同一设备 10 秒内只写一次；返回服务器时间，前台据此测量时间偏移。
  - 后厨屏只在页面可见且联网时每 20 秒发一次心跳；切到后台或断网就停发，所以前台能看出后厨屏离线。
  - 判定规则在 `src/domain/kitchenLink.ts`：云端接单后不到 5 秒显示「正在送到后厨」；5 秒仍无回执显示「等待厨房确认」；15 秒仍无回执、且后厨心跳超过 45 秒没更新时，才显示醒目告警「后厨屏可能离线，请把纸单递给厨师」。
  - 后厨心跳正常时，即使 15 秒没回执也只显示「等待」，不夸大成故障；只有收到回执才显示「后厨已收到」。
  - POS 底栏常驻显示「后厨屏在线 / 后厨屏离线（最后 xx 前）/ 未连接」。
  - 新命令 `recordManualHandoff`：收银登记「已递纸单」，不改变制作状态和版本。后厨屏恢复后，卡片上醒目提示「收银已递纸单 · 先核对是否已做，避免做两份」。
- **O12 跨营业日**
  - 后厨查询本来就不按日期截断。前一营业日的未完成单在卡片上标「跨营业日 · MM-DD 的单（仍需完成）」。
  - 订单页顶部单列「跨营业日未完成」。这类单可以照常开始、出餐，营业日保持原日期；即使前一天已关账也不阻止出餐，因为出餐不是记账。
- **O13 收据**
  - 内容由 `src/domain/receipt.ts` 生成：只显示已经发生的出餐时间，未出餐显示当前状态。
  - 离线单标「本机接单 / 人工传单」；未同步时另标「尚未同步云端」，保留临时号；设备估计的时间标「（本机）」。不含成本和利润。
  - 支持 58mm / 80mm 两种纸宽，系统打印对话框。收据单独渲染到 `#print-root`，打印时只输出收据，纸高按内容测量（`@page size: 宽×实际高`）。
  - 第一次之后的打印都标「副本」，按本机记录的打印次数判断；打印失败只提示，订单已保存。
  - 入口：POS 接单后（在线 / 离线）、订单页每一行、同步中心的离线单。

**验证中发现并修复**：第一次导出的收据 PDF 是整张信纸、带米色背景。原因是 `@page size: 58mm auto` 无效，且隐藏的其他内容仍然占着版面。改成专用打印节点 + 实测高度后，PDF 正好是 58mm 宽的收据。

**限制**：「副本」按本机打印次数判断，换一台设备重印不会标副本；没有 ESC/POS 直连或自动切纸，属于后续硬件集成。

新增 / 修改文件：
```
A src/domain/kitchenLink.ts  src/domain/receipt.ts  src/domain/link-receipt.test.ts
A src/data/heartbeat.ts  src/features/receipt/ReceiptDialog.tsx
M src/data/offline/runtime.ts（serverOffsetMs / serverNow）  src/data/firebase/commands.ts
M src/features/pos/PosPage.tsx  src/features/kitchen/KitchenPage.tsx  src/features/orders/OrdersPage.tsx  src/features/sync/SyncPage.tsx  src/index.css
A functions/src/commands/kitchenLink.ts  functions/test/link.test.ts  M functions/src/index.ts  functions/package.json
A scripts/lib/cdp.mjs  scripts/link-receipt-e2e.mjs  docs/screenshots/link/*
```

## 阶段 D：离线营业

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
| O11–O13 完成后重跑 | ✅ typecheck 0、`npm test` 55/55、build 成功、functions typecheck 0、Rules 27/27、命令 + 离线 + 连接 23/23 |
| `node scripts/link-receipt-e2e.mjs`（两台独立无头 Chrome：收银 localhost / 后厨 127.0.0.1，干净的 Emulator） | ✅ 15/15，结果在 `docs/screenshots/link/link-receipt-e2e.json`；首轮 10/11 是脚本点错卡片且等待短于冷启动，已修正后重跑 |
| 阶段 E 完成后重跑 | ✅ typecheck 0、`npm test` 54/54（删原型 5 项、加账本 4 项）、build 成功、functions typecheck 0、Rules 28/28、命令 27/27（新增财务 4 项） |
| `node scripts/owner-e2e.mjs`（收银与老板两台无头 Chrome；离线记录通过真实补同步接口产生；干净的 Emulator） | ✅ 19/19，结果在 `docs/screenshots/owner/owner-e2e.json`；首轮 8/9 停在收支页空白（真实缺陷，已修复） |
| `node scripts/offline-e2e.mjs` 回归（老板首页改动后） | ✅ 20/20 |
| 英文/图卡/设置完成后重跑 | ✅ typecheck 0、`npm test` 58/58、build 成功、functions typecheck 0、Rules 28/28、命令 31/31 |
| `node scripts/settings-e2e.mjs`（老板 / 收银 / 新员工三台无头 Chrome，干净的 Emulator） | ✅ 20/20，结果在 `docs/screenshots/settings/settings-e2e.json` |
| `node scripts/link-receipt-e2e.mjs` 回归（打印规则改动后） | ✅ 16/16 |

**阶段 E Emulator 测试覆盖**：
- **F01–F06 整天账本**：现金 / QR 接单、制作中取消后退款、待做取消后退款、支出作废与更正、关联取消单的损耗与普通损耗、例外须确认。逐项核对关账数字：收款 2500 / 900、退款 1800、成本 11125 单位（待做取消已反转）、损耗只计 850、作废支出不计、利润公式、钱箱应有 = 10000 + 2500 − 1800 − 500 − 3000、现金差额 −200、QR 差额 0。关账后接单、记账、重复关账都被拒绝，但仍可出餐。
- **F11 并发**：3 轮「关账 ∥ 下单」，每轮新单要么在快照里、要么被拒绝，账本笔数与快照一致。
- **D13**：关账后迟到的离线单 → 老板补入账 → 待调整 1 → 更正版本 2 包含这笔，版本 1 保持原数字，钱箱差额归零。
- **待核对处理**：餐牌冲突只补历史账；依附事件必须在所属订单之后处理；金额不符按实收 RM6 入账并记录 −RM1 差额；QR 必须确认到账；菜单未知只能不入账；处理过的记录不能重复处理；收银越权被拒。

**老板端 E2E**：
- 收银接 3 单，补同步产生 2 条待核对。
- 概览：净收款 RM27（不含待核对金额），待核对提醒，达标率「—」。
- 待核对：两条补入账，按实收入账并记录差额，只补历史账。
- 收支：模板不预填金额，作废，0.5 递增的损耗，存银行。
- 日结：差额预览，带结转说明关账；收银随后下单被拒。
- 迟到单 → 待调整 1 项 → 更正版本 2，版本 1 保留。
- 真实下载 7 个 CSV 文件（含 BOM 与时区）；手机 390 无横向溢出。

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
| 在线 O01–O13 | ✅E O01、O02、O03、O05、O06、O07、O08；O01/O02/O06/O08/O10 另经浏览器验证；🟡 O04（服务端 ✅E；客户端已实现「核对结果」流程，但没有在浏览器中模拟响应丢失）、O09（撤回超时与关账只在领域层验证，牌被重新分配已 ✅E）、O10（✅D 合计 + 浏览器验证 KDS 界面）；✅ O11（领域 + ✅E + 两台浏览器：后厨关闭约 45 秒后 POS 显示离线，新单 5 秒「等待确认」、15 秒醒目告警，登记人工传单后后厨恢复可见提示）、O12（✅E + 浏览器：后厨与订单页都显示前一营业日的单，可出餐、营业日不变）、O13（领域 + 浏览器：收据内容、打印 PDF 只含收据、重印「副本」、打印不产生交易；实际热敏打印机未测） |
| 离线 D01–D14 | ✅ D01（E2E 真断网刷新 + IndexedDB 测试）、D02（IndexedDB 原子回滚测试）、D03（E2E + ✅E）、D04（✅E 每条重复 10 次 + E2E）、D05（✅E + E2E）、D07（✅E）、D08（✅E）、D09（✅E 旧但有效版本按旧价入账并记录当前版本；离线售罄照常入账；未知版本拒绝）、D11（✅D + ✅E + E2E）、D13（✅E）、D14（✅E 作废序号；客户端处理流程已实现，未在浏览器模拟响应丢失）；🟡 D06（服务端按 eventId 幂等 ✅E；未专门模拟「上传成功但页面在收到响应前关闭」）、D10（未来时间与超出 24 小时资格 ✅E；「回拨 10 分钟」「跨 04:00」未单独测）、D12（同 eventId 导入 ✅；单写端锁已实现，未做双标签自动化测试） |
| 财务 F01–F12 | ✅ F01–F06（✅D + ✅E 整天账本关账逐项核对）、F07–F10（✅D；F07 的「—」另经浏览器验证）、F11（✅E 3 轮并发 + 浏览器关账后拒绝下单）、F12（✅D + 浏览器真实下载的 CSV 含 BOM 与时区） |

## 已知限制 / 设计判断（可调整）

- 菜单与 BOM 可以由老板发布新版本，但只能改价格、加料价、售罄和单位成本。新增餐品、规格或图卡仍需要改代码。售罄只在 POS 入口禁用，培训图卡不显示售罄。
- 邀请链接需要老板手动转交（WhatsApp 等），系统不发邮件。链接有效期按 Firebase 默认设置。
- 英文只覆盖员工操作界面。老板端、订单页、同步页和收据是中文。
- 本机序号严格连续，只对收银机产生的 `createOrder`、`releaseToken` 生效；被拒绝的命令不消耗序号。`requestCancel` 不走序号。阶段 D 需要把在线与离线日志统一到同一序号流。
- 在线收款被服务器明确拒绝（例如餐牌冲突）：没有生成订单，收银修正后重新提交，界面提示勿再次收钱；被拒命令的序号会归还或作废。
- 老板端报表直接读账本并在浏览器计算，没有用汇总缓存（`dailyStats`）；回本进度会读取全部历史账本。数据量大了以后需要加可重建的汇总缓存。
- 关账只能看到云端的离线待核对；其他设备上尚未上传的本机记录，需要人工确认主收银机已同步（页面会提示本机未同步数）。
- 被「不入账」的离线收款不会进入账本，钱箱可能因此多出现金；处理方法是在日结里写明差额原因，或另记钱箱往来。
- 「固定费用付款」只计入现金账，经营利润按月度固定费用摊销（默认 RM900/月按日历日）；营业日分摊模式未做。
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

1. 阶段 F：准备测试云项目部署。需要你提供 staging 项目 ID、计费与 owner 账号，然后做：Hosting / Functions / Rules / 索引部署、App Check 监测、两台实体设备联调、一周模拟营业的用量核验、备份恢复演练。
2. 离线补测：D06 页面在收到响应前关闭、D10 时钟回拨与跨 04:00、D12 双标签自动化测试；实机拔网线测试。
3. 实际热敏打印机、A4 图卡打印与平板实机测试；订单页、同步页的英文（如需要）。
4. 性能：主包约 855KB（主要是 Firebase SDK），后续按页面拆分代码。
