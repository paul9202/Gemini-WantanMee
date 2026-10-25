# AI 记成本 · 配置、上线与验收操作说明

2026-10-25。对应实现：`functions/src/aiCost/*`、`functions/src/commands/aiCost.ts`、`src/features/owner/aiCost/*`、`storage.rules`。
本文写给部署维护者。**不要把任何 API Key 发到聊天、写进仓库、写进 `VITE_*` 变量或日志。**

## 1. 组成与数据

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 识别 / 解读 | Callable `analyzeCostDraftCmd`、`getCostAnalysisCmd`（120 秒，512 MiB，绑定两个 Secret） | 默认 Claude，符合条件才顺序交给 DeepSeek；每次最多各一次 |
| 草稿与入账 | `createCostDraftCmd`、`updateCostDraftCmd`、`commitCostDraftCmd`、`completePurchaseUsageCmd`、`setAiCostEnabledCmd` | 普通账务规则（关账、月租唯一槽、工资启用、幂等、审计）照旧 |
| 定时清理 | `cleanupCostDraftsDaily`（每天 05:00 马来西亚时间） | 30 天未动、未入账的草稿 → expired，删除其图片；已入账收据保留 |
| Firestore | `stores/{store}/costDrafts`（含 `attempts` 子集合）、`costReceipts`、`purchaseDetails`、`costAnalysis`、`aiUsage`、`config/aiCost` | 只有本店老板可读；客户端不能写 |
| Storage | `stores/{store}/ai-cost-drafts/{draftId}/{uuid}.{jpg,png,webp}` | 只有本店老板能向「可上传的收据草稿」新建图片；不可覆盖 / 删除 / 列目录；不生成公开下载链接 |

## 2. 变量名

**Secrets（Functions Secret Manager）**

| 名称 | 用途 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude（默认） |
| `DEEPSEEK_API_KEY` | DeepSeek（备用） |

值为空或为 `unset` 时视为未配置：识别 / 解读返回「未配置」，手动录入、统计与其他账务照常。

**部署参数（有默认值，可在 `functions/.env.<projectId>` 覆盖；该文件被 `.gitignore` 的 `.env*` 忽略）**

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `AI_CLAUDE_MODEL` | `claude-opus-5-5` | Claude 模型 ID |
| `AI_CLAUDE_EFFORT` | `medium` | `low` / `medium` / `high` |
| `AI_CLAUDE_SERVER_FALLBACK` | `false` | 设为 `true` 时发送 `fallbacks: "default"` 与 beta `server-side-fallback-2026-07-01`，只在 Claude 自身安全拒绝时换 Anthropic 推荐模型（网络 / 限流 / 5xx 仍由本系统交给 DeepSeek）。**尚未用真实账号验收，默认关闭**；第 6 节验收确认账号支持后再开启。开启后若账号不支持，Claude 会返回 400，而 400 不会转给备用 |
| `AI_DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容地址 |
| `AI_DEEPSEEK_MODEL` | `deepseek-flash` | 文字与解读 |
| `AI_DEEPSEEK_VISION_MODEL` | `deepseek-flash` | 收据图片备用；**留空 = 备用不处理图片**（不会把图片路径当文字假装识图） |
| `AI_DAILY_ATTEMPT_LIMIT` | `100` | 每店每天识别 + 解读尝试上限（一次主备算一次）；`config/aiCost.dailyLimit` 可再调低 |
| `AI_TOTAL_TIMEOUT_MS` | `75000` | 一次请求总时限（上限 100000） |
| `AI_PROVIDER_TIMEOUT_MS` | `30000` | 单家时限（上限 60000） |

前端只新增 `VITE_FIREBASE_STORAGE_BUCKET`（默认 `<projectId>.appspot.com`，按项目实际 bucket 填，是公开配置，不是密钥）。本地第二套 Emulator 可用 `VITE_EMULATOR_{AUTH,FIRESTORE,FUNCTIONS,STORAGE}_PORT` 覆盖端口。

2026-10-25 核对：Claude 默认 `claude-opus-5-5`，结构化输出 `output_config.format`（官方 SDK `@anthropic-ai/sdk` 1.3.0）；DeepSeek 官方文档写明 `deepseek-flash` 接受 base64 图片（`image_url` data URL）并支持 `response_format: {type: "json_object"}`。**两家的模型可用性、视觉能力与账号权限仍需用真实 Key 验证（见第 6 节）。**

## 3. 交互式配置密钥（不经聊天）

在自己的终端里执行，命令会提示输入，输入内容不回显、不进 shell 历史：

```bash
npx firebase functions:secrets:set ANTHROPIC_API_KEY --project wantan-staging
```

```bash
npx firebase functions:secrets:set DEEPSEEK_API_KEY --project wantan-staging
```

暂时没有某一家的 Key：同样执行并输入 `unset`（部署要求 Secret 存在）。查看是否已配置（不显示值）：

```bash
npx firebase functions:secrets:describe ANTHROPIC_API_KEY --project wantan-staging
```

更换 Key 后重新部署函数，旧版本可用 `functions:secrets:destroy` 清理。

## 4. 账号权限与预算

- 项目需为 Blaze 计费方案（Secret Manager、对外网络请求、Cloud Storage、定时函数）。
- 启用 Secret Manager API、Cloud Scheduler API；`firebase deploy` 会给函数运行服务账号授予所绑定 Secret 的 `secretAccessor`。
- Cloud Storage：在 Firebase 控制台初始化默认 bucket；首次部署 `storage.rules` 时按提示允许 Storage Rules 读取 Firestore（跨服务规则需要）。
- 预算：在 Anthropic Console 设置月度花费上限；DeepSeek 采用预充值，保持小额余额；Google Cloud 设置账单预算提醒。系统内另有每日尝试上限，超出时不调用、也不借备用绕过，手动录入照常。
- 计量：每次尝试的供应商、模型、耗时、token、错误类别写在 `costDrafts/{id}/attempts`；不记录密钥和收据原图内容。按实际模型的官方价格核算费用。

## 5. 上线顺序（只在有明确部署指令时执行）

PowerShell：

```bash
$env:FUNCTIONS_DISCOVERY_TIMEOUT='60'; npx firebase deploy --only firestore:rules,firestore:indexes,storage --project wantan-staging --non-interactive
```

```bash
$env:FUNCTIONS_DISCOVERY_TIMEOUT='60'; npx firebase deploy --only functions --project wantan-staging --non-interactive
```

```bash
npx vite build --mode staging; npx firebase deploy --only hosting --project wantan-staging --non-interactive
```

1. 先配置 Secrets（第 3 节），再部署规则 / 索引 / Storage，然后函数，最后前端。
2. 默认每家门店 `config/aiCost.enabled` 不存在 = 关闭。老板在「AI 记成本」页点「开启 AI 整理」（或调用 `setAiCostEnabled`）才会调用模型；先只给试用门店开启。
3. 检查：匿名调用新函数被拒；收银 / 后厨账号调用返回 FORBIDDEN、不产生 `attempts`；浏览器 JS 包不含 `api.anthropic.com`、`api.deepseek.com`、Key 名称；函数日志中没有 Key。

## 6. 真实 API 验收（需要真实 Key，本次未执行）

在 `wantan-staging` 用一家试用门店、小样本：

1. 文字：中文 / 英文 / 马来文各几句，含「都付了」「赊账」「没说付款」、混合食材与煤气、昨天 / 今天。逐项人工对照金额、分类、付款与「没说清楚留空」。
2. 收据：清晰、反光、长收据（多张）、有折扣、有税、有找零、混合私人用品。核对差额提示、折扣只记一次、找零不成支出。
3. Claude 正常时 `attempts.calls` 只有一条 claude；DeepSeek 调用数为 0。
4. 备用（DeepSeek）：**不要改动真实 `ANTHROPIC_API_KEY`**。用受限、限时的「备用验收模式」：只让指定老板账号在这一家门店的 AI 请求跳过 Claude、直接走 DeepSeek，其他账号 / 门店照常 Claude 优先，到期自动恢复（最长 120 分钟）。步骤见下方「备用验收模式」。验收时确认界面显示「DeepSeek（备用）」，`costDrafts/{id}/attempts` 里 `acceptanceMode: backup_only`、`calls` 只有 deepseek、`primaryIssue: acceptance_skip`；文字、收据、开销解读各做一次。
5. 两家都不可用：不在线上改 Secret 制造故障。这一路径已在 Emulator 用模拟传输验证（原话含 `#mock:all-down`：保留原话 / 图片、不入账、可手动填写）；线上只在首次配置密钥之前顺便确认「AI 服务尚未配置」提示与手动录入可用。
6. 开销分析：问「这个月花在哪」「比上月多花在哪里」「有哪些待付款」，确认引用都是真实记录、金额与统计卡一致；改一笔付款后旧解读显示过期。
7. 记录实际延迟；若收据识别常超过 30 秒，再调整 `AI_PROVIDER_TIMEOUT_MS` / `AI_CLAUDE_EFFORT`，不要无限加长。
8. （可选）验证 Claude 服务端换模型：在 `functions/.env.wantan-staging` 设 `AI_CLAUDE_SERVER_FALLBACK=true` 后重新部署，跑一次文字与收据识别，确认没有 400；有 400 就改回 `false`。

### 备用验收模式（DeepSeek）

维护者在自己的终端执行（使用本机 `gcloud auth application-default login` 的凭据；脚本只接受本店有效老板的 UID，期限 1–120 分钟，必须写原因）：

```bash
npm --prefix functions run ai:acceptance -- --project wantan-staging --uid <老板UID> --minutes 30 --reason "DeepSeek 备用验收"
```

```bash
npm --prefix functions run ai:acceptance -- --project wantan-staging --status
```

验收结束（或任何时候想恢复）：

```bash
npm --prefix functions run ai:acceptance -- --project wantan-staging --clear
```

- 设置写在 `stores/<门店>/config/aiCost.acceptance`，客户端不能写（Firestore Rules 拒绝），Callable 也不会改它；`--store` 可指定门店，默认 `hao-pontian-main`。
- 只影响名单内的老板账号；同一门店其他账号、其他门店不受影响。即使忘记清除，到期也会自动恢复 Claude 优先。
- 开销解读在验收模式下使用独立缓存，不会把之前 Claude 的解读当成 DeepSeek 的结果。
- 本机演练：Emulator 运行时加 `--emulator`，并使用 `--project demo-hao-wantan`。

**不要预先宣称识别准确率**；以上验收结果单独记录，区分模拟验证与真实模型验证。

## 7. 回退

- 识别故障：老板端关闭「AI 整理」（`config/aiCost.enabled=false`），手动录入、已保存账目、采购记录与统计照常。
- 函数回退：重新部署上一版函数即可；新集合中的账目与凭证保留，不删除、不回滚；旧版页面不读取新集合，账本（`expenses`）口径不变。
- 不要清空 `costReceipts`、`purchaseDetails`、Storage 收据目录或 `expenses`；更正一律走作废 / 重新记录。

## 8. 本地验证命令

```bash
npm run check
```

```bash
npm run test:rules
```

```bash
npm run test:emulator
```

浏览器端到端（Emulator + 已 seed + `VITE_USE_EMULATORS=true` 的前端；脚本使用 Emulator 模拟传输，不调用真实 API）：

```bash
node scripts/ai-cost-e2e.mjs
```

Emulator 内没有真实 Key 时（demo- 项目）自动使用 `functions/src/aiCost/mockTransport.ts`；生产环境永远不会启用它。Functions Emulator 会尝试从 Secret Manager 读 Secret 并打印 403 警告，可忽略；如要在本机用真实 Key 试验，在 `functions/.secret.local` 写入（已在 `.gitignore` 中排除，仍不要提交或分享）。
