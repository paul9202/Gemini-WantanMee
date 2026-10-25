# AI 记成本 · 设计与开发交接

2026-10-25。用户已确定：Claude 默认、DeepSeek 备用；图片或自然语言输入后，允许编辑 AI 结果，再一键确认入账 / 入库。

交付内容：

- [方案概览](SOLUTION.md)：用法、页面、架构、分段交付及调用成本控制。
- [产品及账务设计](../superpowers/specs/2026-10-25-ai-cost-entry-design.md)。
- [落地实施计划](../superpowers/plans/2026-10-25-ai-cost-entry-implementation.md)：接口、文件分工、测试及上线条件。
- [UI / UX 设计](UIUX.md)：页面、流程、状态、响应式和文案。
- [可点击原型](mockup/index.html)：可直接打开；无需登录或安装依赖。
- [截图目录](screenshots/)：桌面、手机、收据差额及分析画面。
- [Claude 开发 prompt](CLAUDE-IMPLEMENTATION-PROMPT.md)：交给当前项目中的 Claude 执行。

当前交付是设计和交接材料。原型为演示、使用内存数据，不调用模型、Firebase 或云端记账接口。Claude API / DeepSeek API 的实际识别效果、时延和费用仍需要在密钥安全配置后实测。

优先实现可完整验收的三个增量：文字草稿与一次性保存 → 私有收据上传与主备识别 → 基于真实统计的成本分析。三个增量属于同一功能的前后依赖；可以逐段验证，正式启用前须完成整套验收。

原型评审：从首页输入示例，点「帮我整理」；或者点上传收据后使用示例票据。顶部场景选择器可直接看差额、备用与失败状态，它不属于正式产品。

原型验证脚本：在项目根目录运行 `node docs/ai-cost-assistant-2026-10-25/verify-prototype.mjs`，使用本机 Chrome 生成截图及 `prototype-verification.json`。这是原型检查，不是正式功能的 API／Emulator 验收。

官方接入资料（实现时再次核对当前账号及模型支持）：[Claude 视觉](https://platform.claude.com/docs/en/build-with-claude/vision)、[Claude 结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)、[DeepSeek 视觉](https://api-docs.deepseek.com/guides/vision/)、[DeepSeek JSON](https://api-docs.deepseek.com/guides/json_mode/)。本设计不承诺固定模型价格或识别准确率。
