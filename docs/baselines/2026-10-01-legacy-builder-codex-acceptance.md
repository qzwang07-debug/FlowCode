# 旧 Automation Builder：独立 Codex 替代模型验收

日期：2026-10-01。范围仅为旧 Scout Automation Builder 的提议与导出兼容性；FlowCode 阶段 6 未启动。原 [Copilot 修复报告](2026-10-01-legacy-builder-repair.md)及五份 attempt 保持历史记录，原始 5C Copilot 基线仍为 **5/10**，最新 Copilot 全量真实复验仍为 **pending**。本报告的 PASS 只适用于下述 Codex 替代路径。

## 身份、模型与边界

- 本机官方 Codex `codex.exe`：`codex-cli 0.159.0`。`codex.exe login status` 返回 `Logged in using ChatGPT`；app-server `account/read` 返回 `type: chatgpt`、`planType: pro`。启动前检查 `OPENAI_API_KEY`、`CODEX_API_KEY` 和 `CODEX_ACCESS_TOKEN` 均未设置；app-server 的 `thread/start` 回报 `modelProvider: openai`，真实完成的 20 个 turn 均回报 `model: gpt-6-sol`。模型固定为 `gpt-6-sol`、`effort: medium`，未按不同场景换模型。
- 官方 [认证说明](https://learn.chatgpt.com/docs/auth)区分 ChatGPT 订阅登录与 API Key 计费；[Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)说明 `account/read`、`model/list`、动态工具与线程事件；[非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)说明保存的 CLI 登录可供本地自动运行复用。本次只调用已登录的 Codex，不读取、复制或导出 OAuth token，也不改动登录配置。
- 测试专用入口 `evals/builder/codex-run.ts` 将原 `AUTOMATION_BUILDER_INSTRUCTIONS` 与 Scout automation catalogue 组合后作为 Codex app-server 的 `developerInstructions`。每个场景单独创建只读、`approvalPolicy: never` 的 Codex 线程，调用生产 `createReadTools` 的 `get_analysis/get_timeline` 处理器及生产 `createAutomationBuilderTools` 的 `propose_automation_plan` 处理器。接受后的计划又经生产 `AutomationBuilder.create()` 和 `renderAutomationJson()` 导出到忽略的测试目录。工具事件核查结果：20/20 均读取分析和时间线、均实际调用提议处理器，**0** 个额外命令、MCP、浏览器、文件改动或子 Agent 工具事件。
- 替换边界：模型循环、基础指令和工具传输来自 Codex app-server，不是应用内 `AutomationBuilder.build()` 所用的 Copilot SDK；Copilot 的 `systemMessage: append` 在此映射到 Codex `developerInstructions`，两者基础上下文不等价。Codex 的 `dynamicTools` 仍是实验性接口。生产工具 handler、固定场景、Zod schema、本地工具策略、原 required/forbidden 评分组及确定性导出复用。它是**外部 Codex 模型验收**，不是产品内 Copilot 集成验收，也没有把 Codex 加为第二个产品 Coding Harness。
- 所有场景为合成分析和时间线。没有执行生成计划中的 GitHub 评论、邮件、部署、报销、CRM 或真实店铺动作；没有将导出包导入并运行 Scout。目标设备的 macOS/Windows 能力只按场景时间线建模，未在对应目标系统实测每条命令。

## 审查、修复与历史证据

独立审查先为三个漏判补反例并看到测试失败，再局部修复：GitHub 查询不能借同一步的 `CHANGELOG.md` 绕过 gh 命令要求；收据读取不能借无关步骤的 `view` 过关；缺少分析的会话不能用任意编辑计划直接导出。历史 `built-automation.json` 仍可读取，编辑后无效计划仍不能覆盖已导出文件。

一轮七场景的开发尝试期间又发现 `expense-report` 技能实际只适用于内部 Dynamics 365，而旧策略允许拿它做 Expensify；另有私有 Amex 对账单被规划为 `web_fetch` 或笼统读取。该尝试被中断，保存在 `fixtures/legacy-builder/codex-development-interrupted.json`，**不计入本次两轮验收**。补反例后，当前 Prompt 为 `legacy-automation.7`，策略为 `legacy-native-tools.7`，评分器仍为 `native-tools.2`。五份 Copilot attempt JSON 均未改写；`repair-eval.json` 分开标记旧 `.5` 重评与当前 `.7` 离线重评，旧配额错误仍为错误。旧 Describer 未修改，本次没有调用其 Copilot 模型；此前 9/9 的真实复测记录保持原样。

## 固定语料两轮结果

两轮都按原十场景相同顺序运行；每个场景只取该轮最终接受计划，拒绝草案全部保留。不按场景从不同轮次挑最好的一份。

| 原场景 | 第 1 轮 | 第 2 轮 | 拒绝草案 |
|---|---:|---:|---:|
| github-issue-triage | PASS · 37.1 s | PASS · 39.6 s | 0 / 0 |
| github-stale-pr-nudge | PASS · 65.3 s | PASS · 49.4 s | 0 / 0 |
| web-to-spreadsheet | PASS · 39.7 s | PASS · 35.0 s | 0 / 0 |
| invoice-extract | PASS · 49.7 s | PASS · 34.7 s | 0 / 0 |
| research-compile | PASS · 61.3 s | PASS · 52.9 s | 0 / 0 |
| directory-lookup | PASS · 64.7 s | PASS · 138.4 s | 0 / 1 |
| expense-report | PASS · 45.0 s | PASS · 53.6 s | 0 / 1 |
| release-notes | PASS · 128.9 s | PASS · 91.3 s | 2 / 1 |
| windows-deploy | PASS · 34.0 s | PASS · 122.1 s | 0 / 0 |
| lead-to-crm | PASS · 45.5 s | PASS · 48.6 s | 0 / 0 |
| **整轮** | **10/10** | **10/10** | **2 / 3** |

五次拒绝的原草案和诊断在逐场景 `toolTrace` 中：发布计划的 GitHub 步骤未注明 gh、目录计划擅自清空表格、费用计划在读取收据的步骤漏写 `view`。工具失败没有被当作 PASS；模型在同一有界 turn 内修订并重新调用真实提议 handler。20 个最终计划均通过原评分 required/forbidden 组、当前生产策略、Zod 解析、以及测试目录的生产导出检查。10 个场景的两轮各自独立通过。

## 证据 Hash 与用量

- 原始 app-server 验收投影：`fixtures/legacy-builder/codex-acceptance-2026-10-01.json`，SHA-256 `f1110c2d93fd43a0016dbe3e300740e04f43f4d13ebd354b6c67ad438f96ec25`。包含每轮每场景计划、评分、策略问题、工具参数/返回 Hash、拒绝文本、导出 Hash、耗时、线程和模型。`evals/results/` 下的本地原始副本与该文件逐字节相同。
- 系统 Prompt（Builder 指令 + Scout catalogue）SHA-256：`34d591ee76bbc13b89c31cb2a89d92036d24f455e18a1a9cb89388064cbc72c8`；十场景语料 SHA-256：`a020a4cbcfadea5835993afc2e91ba137e12b7c111beb5f5b1fb59f643a30675`；catalogue 版本：`2026-07-26`。生产及驱动源码的逐文件 Hash 在验收投影的 `sourceHashes` 中；证据测试逐项比对当前文件。
- app-server 实时事件中的 `tokenUsage.last` 是最后一次模型请求，不代表整个场景。用量补充文件 `fixtures/legacy-builder/codex-usage-2026-10-01.json`（SHA-256 `72da1c8f6fa7e3846cdcc736dc5fc8559dcb6771fd5d94134599f68f7981b919`）仅从 20 个对应本机 Codex rollout 的最终 `token_count.total_token_usage` 提取用量字段，保存各 rollout Hash，并绑定上述原始证据 Hash；没有复制会话正文或认证信息。

| 用量 | 第 1 轮 | 第 2 轮 | 合计 |
|---|---:|---:|---:|
| 总 Token | 1,000,129 | 1,021,554 | 2,021,683 |
| 输入 Token | 983,435 | 1,006,307 | 1,989,742 |
| 其中缓存输入 | 878,848 | 876,416 | 1,755,264 |
| 输出 Token | 16,694 | 15,247 | 31,941 |
| 其中推理输出 | 6,570 | 5,412 | 11,982 |
| 场景耗时合计 | 571.3 s | 665.6 s | 1,236.9 s |

账户侧实际金额不可用，不能填零。Token 为 Codex 报告的用量计数，不换算或臆测账单费用。

## 验收项 → 实现/证据 → 结果 → 剩余问题

| 验收项 | 实现/证据 | 结果 | 剩余问题 |
|---|---|---|---|
| Schema、提议拒绝、编辑后导出、历史读取 | `tools.ts`、`builder.ts`、`native-tool-policy.test.ts`；20 个真实计划的生产 handler 与导出 Hash | PASS | Scout 导入与执行未实测 |
| 十场景原 required/forbidden 工具选择规则 | 原 `scenarios.ts`/`native-tool-scenarios.ts`、`score.ts`；两轮完整模型结果 | 10/10 + 10/10 PASS | 规则是有界的英文静态检查，不能证明每条 CLI 在目标设备可运行 |
| 反例拒绝与历史证据保全 | 当前策略、19 个专项单测、五份旧 Copilot attempt、七场景中断尝试 | PASS；五次真实拒绝留存 | Copilot 真实全量复验 pending |
| Chrome/Edge/紫鸟、历史 Session/Blueprint 确定性回归 | `npm test`、`test:browser-extension`、`test:stage5b` | PASS：343/343、44/44、29/29 | 此次未操作真实紫鸟店铺或重新做人机 E2E |
| 类型、构建与依赖锁文件 | `typecheck`、`typecheck:evals`、`typecheck:stage5c`、`build`、`check:lockfile` | PASS | 无依赖变更 |

本结果不改变默认模型或原 Copilot 入口。阶段 6 的项目 Builder、Runner、目标索引和店铺业务运行仍在各自路线图范围内，未由本次验收替代。
