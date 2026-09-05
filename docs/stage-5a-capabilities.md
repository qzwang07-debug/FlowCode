# 5A 能力矩阵（2026-09-05）

这是可行性验证结果，不是 5B/5C/6 的生产功能清单。`通过` 只覆盖对应证据中实际运行的范围；未测试、无法建立或仅有契约的能力均不视为支持。

验证组合：Windows 11 x64 `10.0.26200`、Node `24.19.0`、OpenCode `1.18.29`、紫鸟 CLI `1.0.8` / 客户端 `6.26.6.7` / 内核 `142.0.7444.168`、Playwright `1.62.1`。

| 能力 | 结果 | 实际证据 / 边界 |
|---|---|---|
| v1 Blueprint / 历史 Session 读取 | 通过 | 旧测试与 v1 Fixture；迁移函数不写文件 |
| v2 执行语义、引用和 Hash | 通过 | 前后断言锚点、frame、Popup、变量生产者、人工步骤及非法引用测试 |
| 确认内容变化后失效 | 通过 | Blueprint/断言、参数、Target、代码、计划、环境 Hash 变化测试 |
| OpenCode 固定版本启动/认证/停止 | 通过 | 真实可执行文件及 Hash；未认证 401，停止后端口不可访问 |
| OpenCode 受限 MCP / 结构化提交 | 通过 | 真实 OpenCode + 本地确定性 Provider，实际 MCP 调用一次、两轮工具交互 |
| OpenCode 配置/插件/工具加载面 | 通过 | 七种 Agent 来源、实际插件/工具 canary；隔离配置下全部排除 |
| 商业 Provider、模型质量、Vision | 未验证 | 属于 5C；本轮没有云模型调用或模型质量声明 |
| Windows 文件 / Junction 边界 | 通过 | .NET 和 Node 实进程；允许目录正常，外部 canary 读写被拒绝 |
| Windows 进程 / 网络边界 | 通过 | Job 拒绝子进程；可达正对照与 AppContainer 网络拒绝；宿主进程访问拒绝 |
| Windows 凭据边界 | 通过 | 合成 Credential Manager 记录隔离；凭据环境变量不继承 |
| 完整 OpenCode/Playwright 自动执行沙箱 | 未实现 / 保持关闭 | 5A 只运行固定 canary。完整模块、进程树与代理通道须在后续 Runner 集成时实测 |
| 紫鸟 CLI 检测 / 分页 / 精确绑定 | 通过 | 真实版本、列表、解析、状态查询；不保留 IP 等无关字段 |
| CLI 账号配置身份 | 通过（限定范围） | 当前 profile + 配置文件指纹；真实复核、配置变化和切换 Fixture |
| `resolve --expected-name` 自带校验 | 不可靠 | 真实调用可回显错误名称；FlowCode 增加独立列表核对，真实错名拒绝通过 |
| 紫鸟店铺启动 | 通过 | 首次调用超时后查询确认已运行，未盲目重发 |
| 冷内核下载/准备/取消 | 未验证 | 当前已具备可运行内核，不人为删内核或改环境来伪造场景 |
| 紫鸟扩展动态加载 | 当前启动方式不可用 | `Extensions.loadUnpacked` 实际返回 `Method not available` |
| 紫鸟 Native Messaging | 未验证 | 未建立可测试的扩展链路，不修改/猜测注册表键 |
| 精确进程所属 CDP 端点发现 | 通过 | `chrome_<storeId>`、唯一 PID、该 PID 的监听端口与内核版本核对 |
| 人工输入 / 点击语义采集 | 通过 | 用户实际操作，独立 `ziniao-manual-capture.json` 记录 |
| click/fill/select/check/submit/upload | 通过（可行性探针） | 真实内核中的 trusted 输入事件，复用 Locator / 隐私函数 |
| iframe / 开放 Shadow DOM / SPA | 通过（本地 Fixture） | 同源及不同端口的跨源 frame、Shadow 按钮、SPA 与文档导航 |
| Popup / 下载通知 | 通过 | 实际 Popup、下载事件；生产统一事件映射属于 5B |
| 停止 Flush / 导航后重注入 | 通过 | 最终探针收到所有活动采集上下文的 Flush，0 Gap |
| 页面伪造消息 / 密码阻断 | 通过（已测试攻击面） | 主世界不可访问 binding；非 trusted dispatch 排除；密码未进入事件 |
| 多店铺恶意串流 / 重连 / 故障恢复 | 未完整验证 | 当前绑定、单进程/页面范围已核查；完整双测试店铺及恢复 E2E 属于 5B |
| Playwright / 已有上下文复用 | 通过 | `connectOverCDP` 使用既有默认上下文，原页面与店铺保留 |
| 测试文件上传 / 下载及导入 | 通过 | `noDefaults`、浏览器原有下载策略、CLI 允许目录内真实文件及内容校验、受控副本导入；测试后默认策略恢复 |
| Playwright Trace / 截图 | 通过（限定范围） | actions-only Trace、Fixture 截图；Trace 网络字节和资源数均为 0 |
| 完整 Trace / 视频 | 未验证 | 不从当前连接能力推断，也没有导出其他页面或登录态 |
| 登录失效 / 人工暂停恢复 / 提交重试 | 未验证 | Run/Checkpoint 契约已定义，真实运行流程属于 6A/6B |
| Chrome / Edge 既有行为 | 回归通过 | 现有扩展、Native Bridge、Session、Evidence 测试与构建保持通过；本轮没有修改其实现 |

机器可复核证据见 [fixtures/stage5a/evidence](../fixtures/stage5a/evidence)，复现入口见 [Fixture README](../fixtures/stage5a/README.md)。
接入路径采用 [ADR 0005](adr/0005-ziniao-cdp-recording-and-runtime.md)；执行边界采用 [ADR 0004](adr/0004-windows-execution-isolation.md)。
