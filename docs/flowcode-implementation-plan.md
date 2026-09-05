# FlowCode 阶段实施文档（供 AI 开发 Agent 使用）

> 本文是 FlowCode 的执行级开发契约。AI 开发 Agent 必须一次只执行一个阶段，不得把路线图当成单次任务全部实现。
> 产品与架构来源：`docs/flowcode-design.md`
> 基线提交：`c7f2fe4402527a0eb7f4fc1b653bf438229bac61`
> 第一目标平台：Windows 11；已完成基线支持 Chrome/Edge，阶段 5 起增加紫鸟。
> 唯一 Coding Harness：OpenCode
> 路线图版本：1.1（2026-09-05）；阶段 0–4 已完成，主线基线 `ded81c8`。

阶段 0–4 的章节（第 4–8 节）保留为历史执行契约，不增加任务或修改验收。后续共享 Schema、录制与 Runner 的演进全部计入阶段 5 及之后。原历史清单不用于重新要求完成阶段 0–4。

后续按明确子阶段执行：`5A → 5B → 5C → 6A → 6B → 7A → 9A` 构成首版交付路径；7B 数据批次、8 深度证据与 9B 本地 Web UI 单独验收。用户只指定“继续开发”时，从第一个未完成子阶段开始，一次不跨越多个子阶段。

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

每个阶段或明确子阶段结束时，Agent 必须输出并写入 PR/提交说明；阶段 5 起还需记录浏览器能力矩阵、契约/确认版本和下一子阶段入口：

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

## 9. 阶段 5：执行契约、紫鸟语义录制与 OpenCode Analyzer

### 9.1 目标、范围与顺序

在阶段 4 基线上补齐代码生成契约，接入紫鸟店铺语义录制，再通过 OpenCode 完成只读分析和 Blueprint 审阅。按 **5A → 5B → 5C** 分别实施、验证和报告，不把三个子阶段作为一次开发任务。

必须阅读：

- 本文、设计文档，以及 [紫鸟接入说明](ziniao-integration.md)。
- `common/blueprint.ts`、`common/evidence.ts`、`common/browser.ts`、`common/project-run.ts`。
- `electron/evidence/`、`electron/browser-bridge/`、`apps/browser-extension/` 及对应测试。
- 当前 Describer、敏感扫描/帧脱敏路径和已有 Eval。

阶段 0–4 的工作项和验收保持原样。下列对共享模块、Schema 和录制来源的扩展属于阶段 5，不回填为已完成阶段的遗漏项。

### 9.2 阶段 5A：公共契约与接入可行性

工作项：

- [ ] 为后续执行新增版本化 Blueprint 契约，兼容读取 v1；新增派生版本，不就地重写历史 Blueprint 或事件。
- [ ] 保留审阅中断言的步骤关联，明确 `beforeStepId/afterStepId`、页面引用、frame 定位链和等待条件。
- [ ] 明确 Tab/Popup 生命周期、触发动作与结果事件关联；输入变量/提取结果使用可校验引用，未支持动作保留人工处理状态。
- [ ] 定义 Blueprint revision、内容 Hash、来源 Session、证据版本和确认记录；参数、断言、目标或代码基线变化使对应确认失效。
- [ ] 定义 `ProjectTarget`、只读 `ProjectContext`、`BrowserEnvironmentProfile`、`BrowserSessionLease`、`BrowserCapabilities` 和后续 Run 请求契约。
- [ ] 定义 provider 与 source 身份，兼容现有 Chrome/Edge 枚举、状态和历史会话；紫鸟使用独立身份，不伪装成 Chrome。
- [ ] 固定 OpenCode 版本并关闭自动升级；保存 OpenAPI Fixture，建立 Fake Server 契约测试和固定版本真实服务烟雾验证。
- [ ] 验证 OpenCode 配置合并、项目/全局配置、插件、MCP、自定义工具和 Agent 权限的实际加载结果，不能把设置配置目录视为自动隔离。
- [ ] 形成 Windows 执行隔离 ADR，实测文件、进程、网络和凭据边界；权限提示、`shell: false`、受控命令名和 Git Worktree 都不能替代进程隔离。
- [ ] 隔离方案未达到约定边界时，保留只读分析/导出，但不得宣称可以自动执行未经审阅的代码。
- [ ] 检测本机紫鸟 CLI、客户端及内核；以 `@ziniao-open/cli@1.0.8` 为初始验证基线，保存版本与能力结果，依赖采用检测用户已安装 CLI 的策略。
- [ ] 建立 `ZiniaoCliService` 的白名单命令、响应 Schema、超时、取消及脱敏 Fixture；验证店铺列表/精确解析和账号配置身份。
- [ ] 在指定测试环境验证店铺启动、内核准备状态、页面身份与 CDP 端点获取；不虚构 `prepare-agent` 参数或端点字段。
- [ ] 根据紫鸟接入说明，实测扩展 + Native Messaging 与必要的 CDP 备选，选择一条首版语义录制路径并写 ADR。
- [ ] 验证该内核的 Playwright 连接及已有上下文复用；录制能力、运行能力、Trace/上传/下载分别记录，不以一项成功推定全部可用。

验收：

- v1 Fixture 保持可读，v2 能表达“提交 → 成功断言 → 跳转”、iframe、Popup、变量引用和人工步骤；非法或悬空引用被拒绝。
- 固定版本 OpenCode 服务能够启动、认证、调用受限测试 MCP、提交结构化结果并停止。
- 紫鸟已有一条有实际证据支持的录制接入路径和明确的项目运行连接方案；尚未实现生产录制 UI。
- Windows 隔离与紫鸟能力矩阵结论可复核；未知能力不能写成已支持。

### 9.3 阶段 5B：紫鸟店铺选择与语义录制

前置：5A 完成，采用其选定接入路径；不同时建设两套紫鸟采集实现。

- [ ] Project Studio/HUD 增加 Chrome、Edge、紫鸟环境选择和紫鸟店铺分页搜索。
- [ ] 通过返回的精确 `storeId` 与非敏感账号引用绑定环境；重名、名称变化或配置切换时重新核对，不按名称猜 ID。
- [ ] 建立单店铺录制租约；只捕获选定店铺、允许的页面/Popup 和 Origin，其他店铺不能混入 Session。
- [ ] 实现可见店铺启动、就绪状态、权限/能力提示、断线恢复；保持紫鸟的代理、指纹、登录态和原有页面。
- [ ] 复用现有 Locator、防抖、敏感字段处理和 Evidence Fusion 的接口，新增版本化采集 Adapter。
- [ ] 采集真实人工 click/fill/select/check/submit/navigate/tab/popup/upload/download，支持已授权 iframe、开放 Shadow DOM 与 SPA。
- [ ] 实现来源时钟、序号、有界缓冲、Start/Stop/Flush 和 Gap；每个会话只有一个语义采集通道。
- [ ] 区分人工操作与自动执行来源；不能把 CLI 截图、临时快照 ref 或轮询记录当成人工动作序列。
- [ ] 停止录制释放采集连接，不默认关闭用户店铺或既有标签页。
- [ ] 在模型关闭时显示紫鸟浏览器步骤、Locator、桌面上下文和 Marker，并导出合法 Blueprint。

专项测试：

- CLI 不可用、客户端未登录、错误账号/店铺、重名店铺、内核准备和用户中途关闭店铺。
- 两个店铺同时打开时不串事件；刷新/导航/Popup/跨域 iframe 后身份和顺序正确。
- 页面伪造消息或调用暴露接口不能注入可信事件；敏感输入阻断。
- 断线补发、重复事件、Stop 超时产生 Gap；Chrome/Edge 录制回归。

验收：在指定紫鸟测试环境人工录制一个含输入、提交、Popup/iframe 和文件操作的流程，FlowCode 生成可审阅证据和确定性 Blueprint。无模型参与；缺失能力必须明确显示并处理，不能以桌面录像代替紫鸟语义录制验收。

### 9.4 阶段 5C：OpenCodeService、Provider 与 Evidence MCP

OpenCodeService：

- [ ] 仅使用文档化 `serve`、OpenAPI、MCP 与权限能力，不解析 TUI 彩色文本。
- [ ] 绑定 `127.0.0.1` 随机端口，使用随机强密码。
- [ ] 每个项目/活动会话隔离工作和配置范围，落实 5A 的加载面及隔离决策。
- [ ] 启动、健康检查、取消、空闲退出、崩溃恢复；流式事件断线后去重，不能重复提交 Blueprint。
- [ ] 持久化 append-only AgentRun 日志、Prompt/Schema/模型版本；Token、费用和耗时可用时记录。

Provider：

- [ ] 设置页配置 Provider、Base URL、Model ID；模型 API Key 进入 Windows Credential Manager。
- [ ] 最小环境变量仅注入 OpenCode；项目验证进程不继承模型 Key。
- [ ] 检测 Tool Calling、Vision、结构化输出；没有 Vision 时标记降级，没有必要 Tool Calling 能力时不能进入 Analyzer。
- [ ] 连接测试与错误日志不输出 Key；设置 Token/时间/费用上限。

Evidence MCP：

- [ ] Run 绑定 Session、Project、Blueprint revision、授权等级和随机 Token。
- [ ] 工具执行行数、字节数、图片数、时间窗口上限，全部输出经过敏感扫描。
- [ ] 模型发送前预览数据类别和脱敏结果；脱敏失败拒绝发送，取消/撤权后令牌失效。
- [ ] 页面、DOM、剪贴板、网络和工具返回的文本均是不可信证据；加入 Prompt Injection 测试语料。
- [ ] 暴露受控的 `project_get_context`，只返回绑定目标的脱敏文件/符号/断言摘要；不允许任意路径。
- [ ] 目标索引尚未由 6A 建立时返回能力状态；5C 验收覆盖只分析和新建目标，已有目标精确对齐在 6A/6B 验收。
- [ ] `recording_submit_blueprint` 同时校验 Schema、引用、来源权限和基础 revision；提交候选，不自动获得用户确认。

### 9.5 Analyzer、步骤整理与生成前体检

- [ ] edit/shell/web/subagent 全部 deny；只访问本次允许的 Evidence MCP 和只读 ProjectContext。
- [ ] 先读确定性时间线，按能力按需取帧/DOM/网络，最终提交合法 Blueprint。
- [ ] 支持用户反馈修订与版本比较，保留已确认的意图和断言，不把 AI 建议自动确认为事实。
- [ ] 审阅 UI 支持删除误操作、合并重复输入、固定值/参数选择、标记人工步骤；只修改派生 Blueprint。
- [ ] 编辑步骤后重新校验断言位置、页面上下文、变量依赖与证据引用。
- [ ] 汇总 Gap、缺失/非唯一 Locator、未知动作、缺失参数、未确认断言、敏感审阅和浏览器能力不匹配，输出具体待办。
- [ ] 分开表示“Schema 合法”“可继续审阅”“满足生成条件”，不能以存在 JSON 文件代表已可生成。

### 9.6 质量与迁移门槛

- [ ] 使用现有 Describer Eval 加固定的至少 12 个浏览器/电商场景双跑 Copilot/OpenCode；记录 Provider、模型、Prompt、样本数、重复次数、耗时和费用。
- [ ] 最终提交 Schema 合法率、引用合法率和已确认断言保留率达到 100%；敏感泄露、跨店铺取证和权限扩大为 0。
- [ ] 意图、步骤顺序和证据依据达到冻结的 Copilot 基线；除平均分外检查每个关键场景，不能以高总分掩盖关键失败。
- [ ] 满足门槛后才切换默认 Analyzer；此阶段不删除 Copilot。
- [ ] Chrome/Edge/紫鸟的确定性处理 Fixture 不调用模型，模型 Eval 单独声明成本。

验收：用户可整理三种浏览器来源的 Blueprint、查看生成前待办、配置模型并完成只读分析；失败保留证据与审阅版本。尚不允许 Builder 写代码。

## 10. 阶段 6：运行准备、OpenCode Builder 与项目持续修改

### 10.1 目标与顺序

按 **6A → 6B** 实施。先让受控模板在选定运行环境中执行，再接入自动生成和有限修复。最小目标/断言索引、参数表单、人工登录和报告属于 6A，不等待阶段 7。

### 10.2 阶段 6A：目标索引、环境与 Worktree Runner

必须阅读 `electron/projects/`、`common/project-runtime.ts`、两种 `templates/`、紫鸟接入 ADR 及其测试。

- [ ] 建立 ProjectTarget 的稳定 ID、入口文件、测试/Workflow 名称和关联 Page Object/Fixture。
- [ ] 建立最小 Assertion Index：已知断言、稳定 ID、代码位置和未知项；普通等待单独标记，不算业务断言。
- [ ] 向 Analyzer/Builder 提供绑定目标的只读 ProjectContext，附代码 Hash 和已知断言，禁止读取完整敏感 Session。
- [ ] 版本化 Run 请求支持 `targetId/worktreeId/environmentProfileId`、经 Schema 校验的参数及 Blueprint revision；Renderer 不传任意 cwd、命令或 CDP URL。
- [ ] Agent 验证强制使用其 Worktree，普通用户运行可解析主项目；日志、元数据和产物记录实际执行的代码版本。
- [ ] 受控准备 Worktree 依赖与锁文件/浏览器运行条件；安装、网络与脚本权限明确，禁止隐式复用可污染主项目的依赖目录。
- [ ] 建立运行环境配置：站点地址、Chrome/Edge/紫鸟、可见模式、登录方式、凭据引用、输入/输出目录和版本信息。
- [ ] 普通浏览器支持专用环境手工登录与后续运行；登录态导出独立确认，保存在 gitignored/受控加密路径，不送模型。
- [ ] 紫鸟使用 5A 验证的连接方案与店铺租约，保留原有登录态；不把空白 Playwright 浏览器作为紫鸟运行替代。
- [ ] 两种模板提供统一 Browser Runtime/Fixture 与项目内 CLI 入口，代码依赖逻辑页面引用，不硬编码店铺 ID、端口和账号。
- [ ] Workflow 参数 Schema 以静态 JSON 或受控辅助进程读取，不能在 Electron 主进程直接 import 未审阅 Workflow 获取元数据。
- [ ] 生成基础参数表单；Secret 通过受控通道注入执行进程，不进入命令行、明文持久化、模型请求或普通日志。
- [ ] 增加 waiting-user/paused/interrupted 等执行阶段和持久化检查点；人工登录、验证码/MFA 交给用户，恢复前复核环境与页面。
- [ ] 同一紫鸟店铺互斥录制/运行；CLI 账号切换、租约过期或店铺身份不符时停止继续动作。
- [ ] Run 结束释放本次连接和资源，保留用户原有浏览器、标签页、代理和指纹配置。

运行场景：无需生成代码，用户能在隔离 Worktree 运行受控示例测试或参数化 Workflow，并选择 Chrome、Edge 或紫鸟；输入参数、手工登录、暂停/继续、停止及店铺归属均有实际结果。

### 10.3 阶段 6A：基础报告与有效通过

- [ ] 每个 Run 有独立日志、JSON 结果、截图/Trace/下载产物目录，不能让下一次运行覆盖上一次证据。
- [ ] 实际运行目标匹配请求，报告包含测试发现数、执行数、失败步骤和断言覆盖信息。
- [ ] 未发现目标、零测试、全部跳过、只通过模板元数据 smoke、只做 typecheck 都不能算业务验证通过。
- [ ] 使用 Playwright JSON/受控 Reporter 关联步骤和断言 ID；JUnit 可提供汇总，但不能据其虚构步骤级或断言级结果。
- [ ] 本地首次失败也保留 Trace；不能在本地重试次数为 0 时仅配置 `on-first-retry`。
- [ ] HTML Report/Trace 可通过外部查看入口打开；高级测试树留到 7A。
- [ ] Worktree 接受、拒绝或清理前，将必要 Diff、验证结果和产物保存在受控 Run/AgentRun 存储，删除 Worktree 不得丢失审计。
- [ ] 紫鸟的 Trace/视频等不支持项按能力显示；实际业务验证仍须有可复核步骤、断言与失败证据。

6A 验收：上述运行场景在三种浏览器环境完成；目标/Worktree/参数正确，基础报告能证明业务目标与确认断言实际执行，本地首次失败有证据，Run 历史不会因再次运行或 Worktree 清理丢失。

### 10.4 阶段 6B：Builder、数据流与持续修改

Builder 输入：

- 已确认 Blueprint revision/Hash、Evidence 版本和隐私审阅。
- 项目类型、模板版本、唯一 Target 和现有代码/断言索引。
- Base HEAD、目标文件 Hash、允许修改路径与验证目标。
- 运行环境能力、参数 Schema、允许的命令与网络范围。
- Evidence MCP 和受控 ProjectContext；不提供原始 Session 路径、CLI 凭据或店铺 CDP 端点给模型。

工作项：

- [ ] 创建 `flowcode-builder` 权限，先输出结构化 Change Plan，用户确认后在 Worktree Edit。
- [ ] 一次录制只更新一个 Target；修改共享 Page Object/Fixture 时列出影响目标并执行相关回归。
- [ ] 确认记录绑定 Blueprint、计划、目标和代码 Hash；内容或基线变化后重新比较，不沿用失效确认。
- [ ] 实现页面数据提取 → 类型校验 → 变量绑定 → 后续步骤输入，支持 JSON/CSV 结果和下载文件产物。
- [ ] 上传映射到用户选择的文件引用，下载遵循紫鸟允许目录与受控导入，不接受任意输出路径。
- [ ] 人工步骤与业务写步骤有执行前影响摘要、暂停、继续和取消；恢复时核对店铺、页面和已完成动作。
- [ ] 明确只读、可重复和不可确定提交的重试策略；订单创建、发布、改价、发货等不能全流程盲重跑。
- [ ] 首轮执行格式化、typecheck、lint、目标业务验证和受影响回归。
- [ ] 测试失败允许有限修复，默认最多 3 轮且受时间/Token/费用上限约束；达到上限保留现场并请求反馈。
- [ ] 禁止通过删除已确认断言、添加 skip/only、吞异常或放宽业务期望获得通过；改变期望必须形成新的用户审阅 Patch。
- [ ] 自动验证使用本地 Fixture/测试环境；真实店铺业务操作由用户在审阅代码后发起，明确显示店铺和操作范围。
- [ ] 展示文件 Diff、命令、报告、断言覆盖与 Agent 轨迹。
- [ ] 接受后由 FlowCode 生成本地提交，默认沿用已有 HEAD/dirty 检查与 fast-forward 接受；其他合并方式独立实现和验收，不隐式处理冲突。
- [ ] 拒绝后清理受控 Worktree，保留 Blueprint/审计；Git 回滚不代表撤销远端业务操作。
- [ ] 支持已有项目追加录制、复用公共页面对象、保留人工代码；局部失败补录的完整交互在 7A 完成。

### 10.5 权限与恢复专项测试

- 项目外路径、符号链接逃逸、原始 Session、凭据与未批准网络被实际边界阻断，不能只测试权限配置字符串。
- 拒绝 `git push`、任意 CLI/API/页面脚本入口；模型 API Key 不进入测试进程。
- 页面 Prompt Injection 不能改变店铺、路径、命令或授权范围。
- Worktree/目标/参数解析正确；测试确实运行在预期 Worktree，而不是主项目。
- 确认后 Blueprint 或代码改变、共享文件影响多个目标、原 HEAD 变化、应用崩溃后恢复。
- 紫鸟店铺互斥、错店铺/账号切换、用户已有页面保留、内核启动超时。
- CLI 超时但业务已执行、下载已产生、提交结果未知时不重复执行。
- 假通过：零测试、全部跳过、删除断言、减弱期望、只运行模板 smoke 都无法通过门槛。

### 10.6 验收场景

- 从 Chrome/Edge/紫鸟的 Blueprint 生成一个真正执行用户确认断言的 POM 测试。
- 生成一个参数化 Workflow，完成“读取页面结果 → 后续输入 → 输出文件/JSON”。
- 在紫鸟测试店铺使用既有登录态运行，正确处理人工暂停及上传/下载，并保留用户原有环境。
- 对已有测试追加步骤并保留人工代码；共享组件变更有受影响回归。
- 故意生成错误、触发重试上限和中断恢复，均不污染主工作树、不重复业务提交。

## 11. 阶段 7：项目维护体验、局部补录与数据批次

### 11.1 目标与顺序

**7A** 完成维护、断言与报告体验，作为首版闭环；**7B** 增加显式数据批次和多店铺队列。6A 已实现的基础索引/参数表单/人工确认/报告在此扩展，不重复重建。

### 11.2 阶段 7A：Monaco、断言与报告

- [ ] 虚拟化文件树，限制 Project Root；Monaco 高亮、搜索、跳转和轻量编辑，保存前 Diff。
- [ ] 二进制、大文件、敏感文件不打开；外部修改触发冲突提示和索引重建。
- [ ] 扩展 TypeScript AST 对 `expect/expect.soft/expect.poll`、Playwright Matcher 和 `test/describe/step` 的理解。
- [ ] 支持 `@flowcode-assertion-id`、步骤 ID 和自定义 Helper 注释；动态代码标 unknown，等待与业务断言分开显示。
- [ ] UI 修改断言生成版本化 Blueprint Patch，经 OpenCode + Diff 更新代码；重新生成索引，保留用户确认与代码 Hash 关系。
- [ ] 完善 Playwright JSON/JUnit、Test Suite/Test/Step/Assertion 树、代码位置、运行状态和 Artifact 关联。
- [ ] 完善 HTML Report、Trace Viewer、截图、视频和错误堆栈浏览；按能力显示紫鸟产物。
- [ ] Run 与 Commit、Blueprint revision、数据批次、CLI/浏览器内核版本关联，历史结果可复核。

### 11.3 阶段 7A：失败步骤局部补录

- [ ] 从失败 Run 定位原 Target、Blueprint 版本、失败步骤和证据。
- [ ] 用户选择替换范围，并在同一授权环境补录；页面结构变化不自动重生成整个项目。
- [ ] 比较新增/替换/保留的步骤，校验参数依赖和断言锚点，生成 Blueprint Patch。
- [ ] 新 Worktree 修改代码、执行目标/相关回归、展示 Diff，保留人工代码和原断言。
- [ ] 新补录不可用或定位冲突时保留原项目和原运行历史。

7A 验收：用户可编辑并审阅代码、查看关联代码与产物的断言/报告；改变测试站点一个 Locator 后，仅补录失效步骤即可得到可审阅的局部修改并通过原有确认断言。

### 11.4 阶段 7B：数据驱动运行与店铺队列

- [ ] 导入 JSON/CSV，按 Workflow 参数 Schema 预览列映射、校验类型、必填字段和文件引用。
- [ ] 首版数据批次固定一个已绑定店铺；行 ID、输入摘要、状态、检查点、产物和错误独立保存。
- [ ] 支持暂停批次、继续未完成行、重试允许重试的失败行；已完成提交不能重复运行。
- [ ] 增加显式多店铺队列，用户选择精确店铺与数据映射，执行前逐店核对账号/店铺/站点和参数。
- [ ] 首版同店铺串行、跨店铺也采用有界串行队列；后续并发需单独验证配置、登录态、限流和租约隔离。
- [ ] 人工确认只适用于当前店铺/行/步骤，不自动授权剩余店铺；失败或验证码只暂停受影响工作。
- [ ] 批次摘要展示逐行/逐店结果，不把部分成功显示为全部成功。
- [ ] 输出 JSON/CSV 和文件清单，支持运行历史比较；不添加后台定时任务或无人值守发布，除非另立需求。

验收：同一 Workflow 用多组数据运行，部分失败后续跑不重复成功行；显式选择两个测试店铺运行时，输入、断言、确认、日志和文件不串店。

## 12. 阶段 8：CDP 深度证据

### 12.1 范围

基础隐私、发送预览、Prompt Injection 和执行隔离已经在阶段 5/6 验收。紫鸟 Standard 录制所需的 CDP 连接也已在 5A/5B 处理。本阶段只扩展深度证据，按 **8A Enhanced → 8B Full Debug** 实施，不阻塞首版 Standard 闭环。

### 12.2 阶段 8A：Enhanced

- [ ] Chrome/Edge 可选 `debugger` 权限、会话 Attach/Detach、DevTools 抢占和 Tab 关闭恢复。
- [ ] 紫鸟复用经验证的采集连接，新增数据类别前单独确认，不因已有 CDP 连接默认开放全部能力。
- [ ] Network 元数据与动作因果关联、最小 DOM 摘要、Console/PageError、经过允许的响应结构。
- [ ] 不支持的浏览器/内核能力明确降级；不默认完整 DOM Snapshot。
- [ ] Header、Query、Body、DOM 和日志统一脱敏，执行截断、类型白名单、配额和保留期。
- [ ] Evidence MCP 按授权隐藏工具或字段，新增字段进入发送预览和删除控制。

### 12.3 阶段 8B：Full Debug

- [ ] 请求正文、响应正文、DOM Snapshot 分别有开关与会话级确认。
- [ ] 登录态导出使用独立授权和存储流程，复用紫鸟登录环境不隐含允许导出。
- [ ] 采集权限撤销后停止新采集并使相关工具授权失效；删除控制覆盖派生缓存和导出副本。
- [ ] 增加真实大小响应、复杂敏感字段、恶意网页/网络内容和脱敏失败语料。

禁止默认抓取 Cookie/Authorization，禁止永久默认 Debugger、页面触发额外授权，禁止脱敏失败后发送原始数据。

验收：三种浏览器按能力逐级采集、脱敏、审阅和撤权，Standard 录制与阶段 6 的运行闭环继续可用。

## 13. 阶段 9：Windows 分发与本地 Web UI

### 13.1 子阶段依赖

**9A** 是 Windows 打包与内测/开源分发，前置为 **5A–5C、6A–6B、7A**；可先于 7B、8 和 9B 交付。**9B** 单独建设本地 Web UI。按依赖调度，不要求为了出安装包先完成所有增强项。

### 13.2 阶段 9A：Windows 打包与开源分发

- [ ] FlowCode ProductName、App ID、图标、安装目录和 Windows x64。
- [ ] Chrome/Edge Native Messaging Bridge 安装/卸载、精确 Host Registry 注册与清理。
- [ ] 紫鸟按 5A 选定路径分发必要 FlowCode 组件；不臆造紫鸟注册表键，不修改现有 Chrome/Edge 注册。
- [ ] 扩展、CLI、紫鸟客户端/内核、OpenCode 兼容矩阵和 Doctor；缺失、版本不支持、登录缺失分别引导。
- [ ] OpenCode 安装/检测策略沿用 5A 决策和固定版本，不在此首次决定接入方式。
- [ ] 紫鸟 CLI 默认检测用户已安装版本，核查二进制来源和版本；再分发须另有明确策略，不自动把标为 UNLICENSED 的包放入安装包。
- [ ] 安装与升级不删除项目、录制、凭据、运行环境绑定和未完成 Worktree；失败可恢复。
- [ ] ARM64 留待已有 CI 能持续验证，不增加首版门槛。
- [ ] README、架构、隐私、威胁模型、贡献指南、Skill Recorder 归属和第三方 Notices。
- [ ] Playwright/OpenCode/紫鸟集成方式、依赖与许可状态说明，扩展权限清单和数据表。
- [ ] 可复现构建、Release Hash、安全披露渠道和无真实账号数据的 Demo/Fixture。
- [ ] Windows 干净环境验证安装、CLI 检测、Chrome/Edge/紫鸟引导、录制到项目运行及升级保留数据。

发布、签名上传、推送远端仍需对应用户授权；完成本地安装包与验收证据后再执行发布步骤。

### 13.3 阶段 9B：本地 Web UI

- [ ] 抽象 Electron IPC 与 Local API Transport，复用同一 React UI。
- [ ] 仅绑定 `127.0.0.1` 随机端口，随机会话认证、严格 Origin/CORS/CSP。
- [ ] “在浏览器打开”不把长期 Token 放 URL 查询串。
- [ ] Browser UI 与 Electron UI 在已交付功能范围内一致，支持断线和恢复。
- [ ] Web UI 只能访问受控 Project/Run/Browser Lease API，不暴露原始紫鸟 CDP、CLI、凭据或任意路径。

验收：本地浏览器可管理已有项目、录制和运行，权限与 Desktop 保持一致；不是远程服务器或跨设备控制能力。

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

阶段 5 起新增的共同门槛：

- 已完成阶段的 Chrome/Edge 与历史 Session/Blueprint Fixture 继续通过；新增紫鸟能力不改变既有默认行为。
- 紫鸟验收使用明确测试环境，Fixture 不保存真实店铺/凭据/IP；区分 CLI 查询、录制、项目运行三种证据。
- 录制/运行不能串店铺，确认不能跨版本或跨店铺复用，业务提交不能因重试或恢复而重复。
- Schema/配置测试不能替代真实 OpenCode 契约、Windows 隔离和紫鸟录制/运行 E2E。
- 文档修订只执行与修改相关的文档检查；功能阶段仍执行以上构建、测试与专项验收。

## 15. AI Agent 单阶段提示词模板

下面模板用于启动每个阶段的开发任务：

```markdown
你正在开发 FlowCode。阶段 0–4 已完成，不增加其任务或验收。
只实现“阶段/子阶段 N：<名称>”（例如 5A），按依赖检查其前置结果。

开始前完整阅读：
1. docs/flowcode-design.md
2. docs/flowcode-implementation-plan.md
3. 阶段 N 指定的现有源码与测试
4. 涉及紫鸟时阅读 docs/ziniao-integration.md 和已完成的接入 ADR

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

## 17. 当前推荐开发入口

阶段 0–4 已完成。下一次功能开发从阶段 5A 开始：

```text
只完成阶段 5A：版本化 Blueprint 执行契约、OpenCode 实际接入/隔离验证、
紫鸟 CLI 与录制/运行可行性验证。保留 v1 和 Chrome/Edge 行为；
产出契约 Fixture、能力矩阵和接入 ADR。
不实现 5B 生产录制 UI、5C Analyzer 或阶段 6 Builder，不删除 Copilot。
```

5A 验收通过后进入 5B。若特定紫鸟版本不支持必要能力，先解决连接方案并记录证据，不能删去紫鸟目标、假定已支持或把任务回填给阶段 0–4。
