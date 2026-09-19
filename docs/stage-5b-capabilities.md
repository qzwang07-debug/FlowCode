# 5B 能力矩阵（2026-09-18）

本文记录生产录制能力，不扩大到 5C Analyzer 或阶段 6 项目运行。`通过`仅表示
列出的真实或确定性证据范围；`unknown` 不显示为支持。

验证组合：Windows 11 x64、Node 24.19.0、紫鸟 CLI 1.0.8、客户端
6.27.2.14、内核 142.0.7444.168。5A 的客户端 6.26.6.7 继续保留在兼容
列表；新客户端是在本轮真实录制后加入，不由版本号相似性推断。

| 能力 | 结果 | 证据与边界 |
|---|---|---|
| CLI 检测、分页搜索、精确 ID/名称绑定 | 通过 | 生产 `ZiniaoCliService`、错误名称/重名/账号切换测试；响应剥离 IP 等无关字段 |
| 可见店铺启动与状态复核 | 通过 | `store open` 不虚构 `--format`；超时或带复核标志的失败只查询状态、不盲目重发 |
| 冷内核下载/取消 | unknown | 当前内核已就绪，没有破坏本机环境伪造冷下载 |
| 客户端 6.27.2.14 / 内核身份端点 | 通过 | 新版本先被生产门槛拒绝，经候选探针、完整流程和修复后实测后加入 allowlist |
| Chrome / Edge 环境选择 | 回归通过 | 仍使用扩展 + Native Bridge；显式选择只激活对应通道，旧默认兼容 |
| 单店铺 Profile 与互斥 Lease | 通过 | 原子本地存储、冲突/释放/崩溃遗留过期测试；Renderer 不获得 endpoint/target/命令 |
| 两店同时打开不串事件 | 通过 | 实机存在 2 个主店铺进程；精确 profile/PID/owned listener/target 只产生 1 个 Ziniao source |
| 人工 click/fill/select/check/submit | 通过 | 用户在本地 Fixture 实际操作；13 click、5 fill、select/check/submit 各 1 |
| Popup / Tab 打开 | 通过 | 实际 Popup、关联 tab-open、Popup 内人工确认；Blueprint 生命周期结果校验 |
| Tab 关闭 | unknown | 本轮为保留用户页面未主动关闭标签；确定性 Schema/单元测试不替代真实关闭 |
| iframe / 开放 Shadow DOM / SPA | 通过 | 同源与跨源 iframe 均有 frame chain，人工 Shadow 点击，实际 history 导航 |
| 上传语义 | 通过 | 本地 Fixture 文件由用户选择；只保存数量、扩展名和媒体类型 |
| 下载语义通知 | 通过 | 生产 Adapter 收到 1 个浏览器下载通知；文件内容/允许目录沿用 5A 独立实测，不在 5B 重标 |
| 敏感输入阻断 | 通过（确定性回归） | 复用既有隐私函数、password/支付字段测试；5B Fixture 不要求用户输入真实敏感数据 |
| 页面消息/错误上下文注入 | 通过 | 隔离世界 binding、随机 token、context/frame/Origin 校验；页面 message 不作为通道 |
| 序号、去重、有界缓冲 | 通过 | host 序号、packet 去重、1024 持久化边界与 overflow Gap 测试 |
| Stop / Flush | 通过 | 完整流程 source flushed、0 dropped；修复后真实点击 gap=0 且 Flush 通过 |
| 断线自动重连 | 实现并确定性测试；真实断线 unknown | 重连前重新核对账号/店铺/endpoint/target；未人为杀真实店铺进程 |
| 单一采集通道 | 通过 | Coordinator 测试及实机单 source；Ziniao 不同时启用扩展通道 |
| 无模型 Evidence / Blueprint v2 | 通过 | 30 个真实事件、2 个 iframe context、1 popup、23 steps、3 results、Hash 校验 |
| Blueprint 导出脱敏 | 通过 | 导出包含 v2、timeline、Gap、Locator；不含 store ID、endpoint、target ID 或输入原值 |
| 保留原店铺与页面 | 通过 | 测试创建页单独管理；原页面与店铺保持打开，停止只释放连接/Lease |
| 登录失效、运行暂停、业务重试 | unknown / 未实现 | 属于阶段 6A/6B，不从录制连接推断 |

真实证据见 [Stage 5B fixtures](../fixtures/stage5b/README.md)，接入决策见
[ADR 0006](adr/0006-ziniao-production-recording.md)。完整流程保留 1 个修复前
契约 Gap；修复后的独立真实人工点击为零 Gap。两份证据同时保留，不能用后者覆盖前者。
