# 旧 Automation Builder 兼容性修复

状态：实现和确定性回归已完成；**真实模型全量复验未完成**。Copilot 返回
`You have exceeded your monthly quota` 后停止模型调用，没有充值、购买额度、
切换付费 Provider 或调用 DeepSeek。不得把本报告视为 Builder 全局模型验收通过。

## 基线、范围与交付

- 工作目录 `D:\code\FlowCode`；开始时工作树干净，HEAD 为 5C 本地提交 `42c24d1`。
- 阅读并保留 2026-09-05 v1.1 设计、实施文档和紫鸟接入说明；阶段 0–5C 的交付记录保留。
- 最小基线 `npm test`：35 个 5C 测试 + 278 个原测试，全部通过、零跳过。
- 原始 Builder 证据 `fixtures/stage5c/legacy-builder-eval.json` 仍是 **5/10**，未改写。
- 分支 `codex/fix-legacy-builder-eval`，从原 5C 提交派生。交付终点为本地提交，不推送/PR/合并。
- 只修复旧 Scout Automation Builder 的计划与评分。没有实现 FlowCode 阶段 6
  Playwright 项目 Builder、目标索引、环境 Runner、业务确认或自动修复执行流程。
- 无依赖、IPC/持久化 Schema、SDK 权限、旧 Describer 或已批准路线图变更。

## 验收项 → 实现/证据 → 结果 → 剩余问题

| 验收项 | 对应实现/证据 | 验证结果 | 剩余问题 |
|---|---|---|---|
| 格式识别，不放松评分 | `evals/builder/score.ts`；大小写/Markdown/空白归一、正向工具引用、URL/扩展名/否定语句排除 | PASS；原 10 个场景、所有 required/forbidden 组保留 | 确定性英文文本规则不是通用语义评审 |
| 防止 `gh` 掩盖浏览器回退 | `native-tool-policy.ts`；识别 browser/Chrome/导航及 `gh --web/-w`，每个远端 GitHub 动作注明匹配 CLI | PASS，专项与保留计划离线重评 | 不验证每条生成命令都能在任意用户设备运行 |
| PR 评论及已发现查询错误 | 明确 `gh pr comment`；校验 review qualifier、年龄占位符、PR milestone flag、unassigned 查询与 reviewer JSON 字段 | PASS，原语法失败反例被拒绝；本机 CLI help 和官方文档核查 | 其他 CLI/查询语法仍需实际运行环境验证 |
| 表格、网页、目录、邮件、收据和 Azure 工具选择 | 明确 `xlsx/web_fetch/workiq_*`、`view`、`az`；保留真正 UI-only 的发票/报销/CRM 路径和文件定位 | PASS，手工编写的 10 个原场景修正 Fixture 全部通过评分及真实提议工具 handler | Fixture 不等于真实模型或业务 E2E；网站认证/文件格式/CLI 安装是运行前置 |
| 不新增未经批准的写操作 | 拒绝未经批准的清空表格/Git push；修订指导强调保留数据与显式写动作 | PASS，否定授权及越界反例被拒绝 | 仅有限静态检查，不构成业务权限系统或安全沙箱 |
| 计划先校验再显示，编辑后再次校验 | `tools.ts` 拒绝无效草案并清空 candidate；`builder.ts` 在导出前重查 | PASS，失败不发布/不覆盖旧文件；合法 reviewed tiles 原样导出 | 旧不合规计划仍可读取，但重新导出前需要修订；新增写动作先修订批准意图 |
| 不丢失或伪造模型证据 | `run.ts` 保存模型/Prompt/评分/策略版本、源码/系统 Prompt/语料 Hash、拒绝诊断和耗时；`fixtures/legacy-builder/` 保留 5 轮结果 | PASS，自动测试逐项离线重评分且错误不算通过 | Copilot 费用不可用，不记为 0 |
| 旧 Describer 回归 | 原实现未修改；真实 `npm run eval -- --model=gpt-6.1-sol --keep` | **9/9 PASS**，按原 ≥80% 门槛；报销场景 91%，步骤数检查未过的细节保留 | 不宣称每项检查都是 100% |
| Builder 最终真实模型复验 | 两轮同模型、同版本的全量尝试及所有开发轮次完整保留 | **未完成**：两轮均 9 个计划返回，最后的 CRM 场景因 quota ERROR | 之后的最后加固版本还未双跑；不能宣称 10/10 或 20/20 |
| 全局工程回归 | `npm test/typecheck/typecheck:evals/typecheck:stage5c/build/check:lockfile` | PASS，详见下节 | 未重新执行实店铺业务操作、UI 人工操作或阶段 6 E2E |

## 实际模型记录（全部保留，不挑选最佳结果）

Provider 均为既有 GitHub Copilot，模型固定 `gpt-6.1-sol`；每轮原样运行 10 个
场景，一轮一试/场景（单次有界 Agent turn 内允许修订被拒绝的草案）。没有在
配额错误后重试。共 50 次 Builder 场景尝试，48 次返回计划，2 次 ERROR；另外
9 次未修改 Describer 的回归。只读/提议工具运行，不执行评论、部署或店铺操作。

| 原报告时间 UTC | Prompt / 校验策略 | 当时原报告结果 | 用最终策略离线重评 | 说明 |
|---|---|---|---|---|
| 13:08:31 | `.2` / `.1` | 10/10 | 8/10 | 开发轮，后续发现的查询语法/工具缺口未消失 |
| 13:13:35 | `.3` / `.2` | 9/10 | 6/10 | Windows 健康检查错误回退浏览器；保留失败 |
| 13:20:34 | `.4` / `.3` | 10/10 | 9/10 | 暴露 PR `--milestone` 错误；随后修复 |
| 13:28:37 | `.5` / `.4` | 9 返回 + 1 quota ERROR | 8/10 | CRM 未完成；并发现未经批准的 push |
| 13:28:30 | `.5` / `.4` | 9 返回 + 1 quota ERROR | 6/10 | CRM 未完成；并发现 unassigned/reviewer 字段错误 |

离线重评不是再次调用模型，不能代替最终真实复验。最新版本为
`legacy-automation.6` / `legacy-native-tools.5` / `native-tools.2`，其全部 10 场景
真实试验次数是 **0**。最后发现的问题已补确定性反例及实现，不能据此虚构模型通过。

`fixtures/legacy-builder/repair-eval.json` 绑定当前源码与原场景 Hash；每个独立
attempt 文件保留原判定、实际计划、拒绝诊断、最新离线判定。原完整报告保留在
忽略的 `evals/results/`；公开副本投影为计划/评分/诊断，并移除本机临时根路径和 Request ID。
原 5C 5/10 报告及批准的三份文档不变。

## 确定性与构建结果

- 专项：25/25，通过；包括手工编写的 10 场景工具映射（不是模型结果）、提议/导出、旧文件保留、反例和证据一致性。
- `npm test`：35 个 5C 测试 + 303 个测试 = **338/338**，零失败、零跳过。
- `npm run typecheck`、`typecheck:evals`、`typecheck:stage5c`：PASS。
- `npm run build`：PASS，包含紫鸟 Sensor、Chrome/Edge 扩展和 catalogue bundle boundary。
- `npm run check:lockfile`、`git diff --check`：PASS；没有依赖/锁文件修改。
- 合法计划实际导出到测试专属临时目录，导出与审阅步骤相同；无效编辑不会覆盖原文件。

## 继续验收入口

恢复 Copilot 额度后，在同一最终源码/模型/Prompt/语料上重新进行两轮全量
`npm run eval:builder -- --model=gpt-6.1-sol --keep`。保留所有结果和拒绝诊断，
按每个场景检查，不拼接不同轮次的最佳样本。更新 receipt 的版本、Hash 和状态，
再次运行证据测试；只有两轮全部完成且通过才能移除 `real-eval-incomplete` 标记。
若换 Provider/模型，需新的用户选择/费用授权，并作为不同模型记录，不能冒充
原 Copilot 的兼容性复验。本次不新增定时监控、自动充值或其他阶段工作。

## 工具语法核查来源

- [GitHub CLI PR comment](https://cli.github.com/manual/gh_pr_comment)：存在非交互 PR 评论能力。
- [GitHub CLI PR list](https://cli.github.com/manual/gh_pr_list)：支持 `--search`，没有 PR `--milestone` flag；JSON 字段包括 `reviewRequests`。
- [GitHub 搜索语法](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)：review qualifier 与 `no:assignee`。
- 本机 `gh pr list --help`、`gh pr comment --help`、`gh issue list --help`；没有实际查询/修改 GitHub 或执行部署。
