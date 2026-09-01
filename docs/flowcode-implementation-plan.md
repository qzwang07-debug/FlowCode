# FlowCode 阶段实施文档（供 AI 开发 Agent 使用）

> 本文是 FlowCode 的执行级开发契约。AI 开发 Agent 必须一次只执行一个阶段，不得把路线图当成单次任务全部实现。
> 产品与架构来源：`docs/flowcode-design.md`
> 基线提交：`c7f2fe4402527a0eb7f4fc1b653bf438229bac61`
> 第一目标平台：Windows 11 + Chrome + Edge
> 唯一 Coding Harness：OpenCode

## 1. Agent 开始工作前必须执行

1. 完整阅读：

   - `docs/flowcode-design.md`
   - 本文
   - 当前阶段关联的现有源码和测试

2. 检查仓库状态：

   ```powershell
   git status --short --branch
   git remote -v
   git log -5 --oneline
   ```

3. 如果存在不属于本阶段的用户修改：

   - 不覆盖。
   - 不清理。
   - 不 Reset。
   - 明确列出并绕开；无法绕开时停止并请求用户决定。

4. 只为当前阶段创建计划，计划必须包含验证步骤。
5. 修改前运行当前阶段要求的最小基线测试并记录结果。

## 2. 全局工程约束

### 2.1 不可违反的规则

- 不运行 `git reset --hard`、`git checkout -- <path>` 或其他会破坏用户修改的命令。
- 不自动执行 `git push`、发布扩展或发布安装包。
- 不把 API Key、Cookie、Token、`storageState` 或录制敏感数据提交到 Git。
- 不允许模型直接获得任意会话目录或项目外路径。
- 不通过字符串拼接执行用户输入的 Shell 命令。
- 不跳过 Zod/JSON Schema 校验。
- 不通过降低测试、禁用类型检查或删除安全逻辑来让 CI 通过。
- 不在同一阶段同时进行大规模目录迁移和核心行为改造。
- 不复制整个 Playwright 或 OpenCode 仓库源码。
- 不引入第二个 Coding Harness。

### 2.2 技术基线

- TypeScript 7。
- Node.js `>=24.19.0 <25`。
- npm `>=11.17.0`。
- Electron 43。
- React 19、Vite 8。
- Zod 作为运行时 Schema。
- Node Test Runner 保持为主单元测试框架。
- Playwright 用于模板项目和新 E2E。
- OpenCode 使用固定版本、Headless Server/OpenAPI、MCP 与权限配置。

### 2.3 依赖规则

引入依赖前必须回答：

1. 标准库或现有依赖能否完成？
2. 是否为运行时必需，还是只需开发依赖？
3. 许可证是否兼容？
4. 是否包含 install script、原生二进制或远程代码？
5. 是否需要加入 `allowScripts`、`asarUnpack` 或合规策略？

修改依赖后必须运行：

```powershell
npm install
npm run check:lockfile
npm run compliance:licenses
npm run typecheck
npm test
```

### 2.4 每次提交范围

一个提交只应承担一个可描述目标。推荐提交前缀：

```text
feat(projects): ...
feat(extension): ...
feat(evidence): ...
feat(opencode): ...
feat(studio): ...
test(...): ...
docs(...): ...
refactor(...): ...
```

## 3. 阶段完成报告模板

每个阶段结束时，Agent 必须输出并写入 PR/提交说明：

```markdown
## 阶段结果

- 阶段：
- 完成的用户能力：
- 新增/修改的公共 Schema：
- 数据或权限变化：
- 主要文件：

## 验证

- [ ] npm run typecheck
- [ ] npm test
- [ ] npm run build
- [ ] 阶段专项测试

## 未完成与后续

- 明确未实现的内容：
- 已知风险：
- 下一阶段入口：
```

不得只说“应该工作”；必须给出执行过的命令和结果。

## 4. 阶段 0：基线、品牌与上游同步

### 4.1 目标

在不改变录制行为的前提下，把仓库转为可持续开发的 FlowCode 基线。

### 4.2 必须阅读

- `README.md`
- `package.json`
- `common/config.ts`
- `common/events.ts`
- `electron/main.ts`
- `electron/recorder/controller.ts`
- `electron/describer/describer.ts`
- `electron/builders/agent-builder.ts`
- `scripts/compliance.mjs`

### 4.3 工作项

- [ ] 将包名、描述、产品名、App ID、日志名和 UI 品牌逐步改为 FlowCode。
- [ ] 保留 Skill Recorder 来源、MIT License 和 Third-Party Notices。
- [ ] 确认 `origin` 为 FlowCode，`upstream` 为 Microsoft Skill Recorder，禁止 upstream push。
- [ ] 增加上游同步说明。
- [ ] 建立 FlowCode Architecture Decision Record 目录。
- [ ] 记录现有 Eval 得分与测试耗时作为回归基线。
- [ ] 增加 Windows CI 的最小 Typecheck/Test/Build Job。
- [ ] 不删除 `@github/copilot-sdk`。

### 4.4 禁止事项

- 不实现扩展。
- 不迁移目录。
- 不改 Session Schema。
- 不改分析器行为。

### 4.5 验收

```powershell
npm ci
npm run typecheck
npm run typecheck:evals
npm test
npm run build
```

应用能启动，现有录制、分析、Skill 与 Automation 界面无回归。

## 5. 阶段 1：共享契约与项目核心

### 5.1 目标

建立 FlowProject、Template、Blueprint、AgentRun、ProjectRun 的 Schema 和项目 Registry，但暂不调用浏览器扩展或 OpenCode。

### 5.2 允许修改/新增

```text
common/project.ts
common/blueprint.ts
common/project-run.ts
common/ipc.ts
electron/projects/
electron/templates/
src/projects/
templates/
```

如果目标目录尚未存在可以创建；不要移动现有录制目录。

### 5.3 工作项

- [ ] 定义带 `schemaVersion` 的 Zod Schema。
- [ ] 实现 `%LOCALAPPDATA%/FlowCode/project-registry.json` 原子读写。
- [ ] 路径归一化并拒绝 Project Root 穿越。
- [ ] 实现模板 Manifest、版本和完整性 Hash。
- [ ] 创建 POM 测试模板。
- [ ] 创建浏览器自动化模板。
- [ ] 实现“创建项目”到临时目录、校验、原子移动。
- [ ] 创建 `.flowcode/project.json` 和必要 `.gitignore`。
- [ ] 如果目标目录不是 Git 仓库，初始化本地 Git；不添加远端、不 push。
- [ ] 添加 Project List/Create/Open IPC。
- [ ] 添加基础 Project Studio 项目列表和新建向导。

### 5.4 测试

- Schema round-trip。
- 重复项目 ID、丢失目录、损坏 Registry。
- 模板复制后 Hash 与必需文件。
- 目标目录已存在时不覆盖。
- 路径穿越和符号链接逃逸。
- 项目创建失败不留半成品。

### 5.5 验收场景

用户可以创建两种项目，在 Project Studio 看到项目，磁盘结构符合设计文档，模板执行 `npm install` 后能通过 typecheck；尚不要求录制写代码。

## 6. 阶段 2：Git Worktree、Runner 与基础 Project Studio

### 6.1 目标

在接入 Agent 前先完成安全写入与项目运行基础设施。

### 6.2 工作项

- [ ] 实现 Git 仓库状态读取。
- [ ] 实现 `flowcode/run/<id>` 分支和隔离 Worktree。
- [ ] 记录 Base HEAD、dirty 状态和创建原因。
- [ ] 实现 Worktree 接受、回滚、清理和崩溃恢复。
- [ ] 禁止对 dirty 原工作树做隐式操作。
- [ ] 实现受控子进程 Runner：命令数组、无 Shell 拼接、超时、取消、流式日志。
- [ ] 测试模板接入 `test/typecheck/lint/report`。
- [ ] 自动化模板接入 `workflow/smoke/typecheck/lint`。
- [ ] Project Studio 增加文件树、运行按钮、日志面板和最近 Run。
- [ ] 代码查看器先只读；编辑能力延后到阶段 7。

### 6.3 测试

- 临时 Git 仓库 Worktree 生命周期。
- dirty 工作树保护。
- 命令参数注入。
- 超时、取消、进程树清理。
- 大输出截断与落盘。
- 应用崩溃后的孤立 Worktree 发现。

### 6.4 验收场景

无需 AI，用户能创建项目、打开代码、点击运行模板自带测试或烟雾脚本、查看日志，并创建/删除一个隔离 Worktree。

## 7. 阶段 3：浏览器扩展与 Native Bridge

### 7.1 目标

实现 Chrome/Edge 普通模式语义事件采集，与 Desktop 同步 Start/Stop/Flush。

### 7.2 首批事件

```text
browser.document
browser.navigate
browser.click
browser.fill
browser.select
browser.check
browser.submit
browser.tab-open
browser.tab-close
browser.popup
browser.upload
browser.download
```

### 7.3 工作项

- [ ] 创建 Manifest V3 扩展构建。
- [ ] 使用 Optional Host Permission，不默认持有所有站点数据。
- [ ] 实现休眠 Content Script 与会话激活。
- [ ] 实现 `event.isTrusted`、输入防抖和密码字段阻断。
- [ ] 实现 Locator 多候选、唯一性与评分。
- [ ] 支持已授权 iframe、开放 Shadow DOM、Tab 和 Popup。
- [ ] 实现 Service Worker 本地有界缓冲与序号。
- [ ] 实现 Native Messaging Host Manifest 和 Windows 注册脚本。
- [ ] 实现 Chrome/Edge `allowed_origins` 分离配置。
- [ ] 实现 Bridge Schema、消息长度、心跳和 Desktop 唤醒。
- [ ] Desktop HUD/Doctor 显示 Chrome、Edge、权限和丢包状态。
- [ ] Stop 等待 `browser.flushed`，超时产生 Gap 而非静默完成。

### 7.4 安全测试

- 密码字段、信用卡启发式字段不含 Value。
- 网页伪造 `postMessage` 不能注入事件。
- Content Script 消息全部被 Service Worker 校验。
- 未授权 Origin 不注入。
- 扩展 ID 不匹配时 Native Host 拒绝。
- 超大消息和畸形 JSON 拒绝。

### 7.5 E2E

使用本地测试站点覆盖 Chrome 和 Edge：

- click/fill/select/check/submit。
- 同源和跨域 iframe。
- Popup 和新 Tab。
- SPA 导航。
- 上传、下载。
- 浏览器中途启动、断线重连和停止 Flush。

## 8. 阶段 4：Evidence Fusion、Blueprint 与断言 Marker

### 8.1 目标

将桌面和浏览器事件融合为确定性证据，在不调用 AI 的情况下导出基础 Blueprint。

### 8.2 工作项

- [ ] 升级事件包络但保持旧 Session 可读。
- [ ] 实现 Source 时钟握手、偏移估计、同源顺序和去重。
- [ ] 实现动作→导航→网络/页面变化的因果关联。
- [ ] 实现剪贴板 Hash 与浏览器 Fill 的跨应用关联。
- [ ] 创建 `evidence-index.json`。
- [ ] 创建 Deterministic Blueprint Builder。
- [ ] 增加“只分析/分析并编写”Session Link。
- [ ] HUD 增加断言 Marker 和自然语言输入。
- [ ] 录制后允许把 Marker 关联到步骤、截图和 DOM Target。
- [ ] 实现 Blueprint 审阅、变量类型、敏感标签和断言确认。
- [ ] 实现 Blueprint 导出包。

### 8.3 兼容性

- 旧 `events.jsonl` 继续可读。
- 新 Browser Event 未出现时，原 Skill Recorder 分析路径继续工作。
- Session Schema 升级必须有迁移测试，禁止就地破坏原始事件。

### 8.4 验收场景

在不开启模型的情况下录制网页操作，Project Studio 能显示桌面步骤、浏览器动作、Locator 和人工断言，并导出合法 Blueprint。

## 9. 阶段 5：Evidence MCP 与 OpenCode Analyzer

### 9.1 目标

以 OpenCode 为唯一 Harness，实现只读分析 Agent 和自定义模型 Provider。

### 9.2 版本与契约

- [ ] 选择并固定 OpenCode 版本。
- [ ] 保存目标 OpenAPI Schema 的测试 Fixture。
- [ ] 创建 Fake OpenCode Server 契约测试。
- [ ] 只使用 `serve`、OpenAPI、MCP 和文档权限能力。
- [ ] 不解析 TUI 彩色文本。

### 9.3 OpenCodeService

- [ ] 绑定 `127.0.0.1` 随机端口。
- [ ] 使用随机强密码保护本地 Server。
- [ ] 每个项目/活动会话隔离工作目录和配置目录。
- [ ] 启动、健康检查、取消、空闲退出、崩溃恢复。
- [ ] 流式接收 Agent 事件并写入 append-only AgentRun 日志。
- [ ] Token、费用和模型信息可用时持久化。

### 9.4 Provider 配置

- [ ] FlowCode 设置页配置 Provider、Base URL、Model ID。
- [ ] API Key 进入 Windows Credential Manager。
- [ ] 子进程仅通过最小环境变量获得 Key。
- [ ] 检测 Tool Calling、Vision 和结构化输出能力。
- [ ] 连接测试不能把 Key 写入日志。

### 9.5 Evidence MCP

- [ ] 每次 Run 绑定 Session、Project、授权等级和随机 Token。
- [ ] 工具执行大小/行数/图片数上限。
- [ ] 所有输出执行敏感扫描。
- [ ] 页面内容视为不可信数据。
- [ ] `recording_submit_blueprint` 执行 Zod 校验。

### 9.6 Analyzer Agent

- [ ] edit/shell/web/subagent 全部 deny。
- [ ] 只能访问 Evidence MCP。
- [ ] 先读确定性时间线，按需取帧/DOM/网络。
- [ ] 最终必须提交 Blueprint。
- [ ] 支持用户反馈修订。

### 9.7 迁移门槛

使用现有 Describer Eval 和新增浏览器场景双跑 Copilot/OpenCode。OpenCode 在意图、步骤顺序、证据引用、敏感数据和结构合法性达到门槛后，才切换默认 Analyzer。此阶段不删除 Copilot。

## 10. 阶段 6：OpenCode Builder 与项目持续修改

### 10.1 目标

用户确认 Blueprint 后，OpenCode 在隔离 Worktree 中编写一个目标并验证。

### 10.2 Builder 输入

- 已确认 Blueprint。
- 项目类型和模板版本。
- 当前目标文件与现有断言索引。
- 允许修改的路径。
- 验证命令。
- Evidence MCP。

不得把完整 Session 目录路径直接放入 Prompt。

### 10.3 工作项

- [ ] 创建 `flowcode-builder` Agent 权限。
- [ ] 先生成结构化 Change Plan，用户确认后再 Edit。
- [ ] 一次录制只允许一个 Target。
- [ ] 只在 Worktree 中写入。
- [ ] 运行格式化、typecheck、lint 和相关测试。
- [ ] 测试失败时允许有限次数修复；受 Token/时间上限约束。
- [ ] 展示文件 Diff、命令、测试结果和 Agent 轨迹。
- [ ] 接受后生成本地提交并由用户选择合并方式。
- [ ] 拒绝后删除 Worktree，保留审计和 Blueprint。
- [ ] 支持在已有项目上追加录制。

### 10.4 权限测试

- 读取项目外路径被拒绝。
- `.env`、Credential Manager 和原始敏感 Session 被拒绝。
- `git push` 被拒绝。
- 未批准的网络和依赖安装被拒绝。
- 网页 Prompt Injection 不能改变权限。

### 10.5 验收场景

- 从 Blueprint 生成一个可通过的 POM 测试。
- 从 Blueprint 生成一个可运行的参数化 Workflow。
- 对已有测试追加步骤并保留人工代码。
- 故意让模型写错后，测试失败不会污染主工作树。

## 11. 阶段 7：代码查看、断言同步与报告

### 11.1 目标

完成用户要求的基础项目 IDE 体验和测试闭环。

### 11.2 Monaco 与文件树

- [ ] 虚拟化文件树。
- [ ] 限制在 Project Root。
- [ ] Monaco 语法高亮、搜索、跳转和轻量编辑。
- [ ] 保存前 Diff。
- [ ] 二进制、大文件和敏感文件不打开。
- [ ] 外部文件变化检测。

### 11.3 Assertion Index

- [ ] TypeScript AST 提取 `expect`、Playwright Matcher、显式等待。
- [ ] 识别 `test/describe/step` 上下文。
- [ ] 支持 `@flowcode-assertion-id`。
- [ ] 支持自定义 Helper 注释。
- [ ] 无法静态理解的断言标记 unknown。
- [ ] UI 修改断言生成 Blueprint Patch，经 OpenCode + Diff 更新代码。

### 11.4 Reports

- [ ] Playwright JSON/JUnit 解析。
- [ ] Test Suite/Test/Step/Assertion 树。
- [ ] 断言关联代码位置、运行状态和 Artifact。
- [ ] HTML Report 打开。
- [ ] Trace Viewer 打开。
- [ ] 截图、视频和错误堆栈展示。
- [ ] Run 与 Commit/Blueprint/浏览器版本关联。

### 11.5 自动化运行 UI

- [ ] 读取 Workflow 参数 Schema。
- [ ] 自动生成参数表单。
- [ ] Secret 输入不持久化明文。
- [ ] Run/Stop、实时步骤、日志、截图和输出文件。
- [ ] 人工确认点暂停与继续。

## 12. 阶段 8：CDP Enhanced/Full Debug 与隐私加固

### 12.1 目标

在 Standard 模式稳定后，按次提供网络、DOM、Console 和页面错误深度证据。

### 12.2 工作项

- [ ] `debugger` 权限设为可选并在使用时解释。
- [ ] Attach/Detach、DevTools 抢占和 Tab 关闭恢复。
- [ ] Network 元数据与动作因果关联。
- [ ] Enhanced DOM 摘要，不默认完整 Snapshot。
- [ ] Console/PageError 采集。
- [ ] Full Debug 单独开关请求/响应正文、DOM Snapshot 和登录态。
- [ ] Header、Query、Body、DOM 统一脱敏。
- [ ] 大响应截断、类型白名单和磁盘配额。
- [ ] Evidence MCP 按授权隐藏工具或字段。
- [ ] 数据发送预览和删除控制。
- [ ] Prompt Injection 测试语料。

### 12.3 禁止事项

- 不默认抓取 Cookie、Authorization。
- 不把 Debugger 权限变成永久默认。
- 不允许页面内容触发额外权限申请。
- 不因 OCR/脱敏失败发送原始数据。

## 13. 阶段 9：本地 Web UI、打包与开源发布

### 13.1 本地 Web UI

- [ ] 抽象 Electron IPC 与 Local API Transport。
- [ ] 仅绑定 `127.0.0.1` 随机端口。
- [ ] 随机会话认证、严格 Origin/CORS/CSP。
- [ ] “在浏览器打开”不把长期 Token 放入 URL 查询串。
- [ ] Browser UI 与 Electron UI 功能一致。

### 13.2 Windows 打包

- [ ] FlowCode ProductName、App ID、图标、安装目录。
- [ ] Native Messaging Bridge 安装与卸载。
- [ ] Chrome/Edge Host Registry 注册与清理。
- [ ] 扩展缺失引导和版本兼容检查。
- [ ] OpenCode 安装/检测策略和固定版本。
- [ ] 升级不删除项目、录制、凭据和未完成 Worktree。
- [ ] Windows x64；ARM64 进入后续版本，除非现有 CI 可持续验证。

### 13.3 开源发布

- [ ] README、架构、隐私、威胁模型、贡献指南。
- [ ] Skill Recorder 上游归属。
- [ ] Playwright/OpenCode 使用与许可证说明。
- [ ] 扩展权限清单和数据表。
- [ ] 可复现构建与 Release Hash。
- [ ] 安全披露渠道。
- [ ] 首个端到端 Demo 和 Fixture，不使用真实账号数据。

## 14. 跨阶段质量门槛

任何阶段不得破坏：

- 原 Skill Recorder Start/Stop/Discard。
- Windows 窗口和 URL 采集。
- Clipboard Preview 限制。
- 1fps 屏幕帧与视频。
- Narration 本地转写。
- Sensitive Scan 和 Frame Redaction。
- Session 恢复、删除和 Debug Bundle。
- 现有 Skill/Automation Builder，直到替代路径验收完成。

每个阶段至少运行：

```powershell
npm run typecheck
npm test
npm run build
```

修改 Eval 时还要运行：

```powershell
npm run typecheck:evals
npm run eval
npm run eval:builder
```

模型 Eval 可能产生费用，运行前必须明确 Provider、模型和预计场景数量。

## 15. AI Agent 单阶段提示词模板

下面模板用于启动每个阶段的开发任务：

```markdown
你正在开发 FlowCode。只实现“阶段 N：<名称>”。

开始前完整阅读：
1. docs/flowcode-design.md
2. docs/flowcode-implementation-plan.md
3. 阶段 N 指定的现有源码与测试

约束：
- 不实现后续阶段。
- 不覆盖用户现有修改。
- 不删除或弱化原 Skill Recorder 的隐私与合规逻辑。
- 所有新跨进程输入必须有 Zod Schema。
- 文件操作限制在仓库和明确的临时测试目录。
- 不自动 push。

执行：
1. 检查 git 状态并汇报基线。
2. 写一个仅覆盖本阶段的计划。
3. 先补测试，再做最小实现。
4. 运行阶段专项测试和全局质量门槛。
5. 汇报 Diff、测试结果、遗留风险和下一阶段入口。

完成定义以阶段 N 的“验收”小节为准。
```

## 16. 上下文恢复规则

如果 Agent 在阶段中断、上下文压缩或由另一 Agent 接手：

1. 不重新开始已完成工作。
2. 阅读最新 Git Diff、测试输出和阶段报告。
3. 检查阶段验收项逐项状态。
4. 只继续第一个未完成项。
5. 无法确认来源的修改视为用户修改，不覆盖。
6. 阶段未满足全部验收条件时不得标记完成。

## 17. 推荐首个开发任务

从阶段 0 开始，不要直接开发扩展。首个任务应当是：

```text
完成 FlowCode 品牌与仓库基线；保留所有 Skill Recorder 行为；
建立 CI、上游同步说明和现有测试/Eval 基线；
不删除 Copilot、不改 Session Schema、不进行目录重排。
```

阶段 0 验收通过后，才进入项目核心与模板。
