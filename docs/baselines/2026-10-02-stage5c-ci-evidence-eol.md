# Stage 5C PR：Windows 证据换行兼容修复

日期：2026-10-02。交付范围仍为 5C 与已授权的旧 Builder 兼容性修复，未进入阶段 6。

## 失败与原因

[PR #9](https://github.com/qzwang07-debug/FlowCode/pull/9) 的首次
[Windows 基线检查](https://github.com/qzwang07-debug/FlowCode/actions/runs/37006737892/job/110836671674)
在用量与原始 Codex 证据 Hash 的绑定校验中失败。macOS/Ubuntu 同批检查通过。

- 原始 LF 证据 Hash：`f1110c2d93fd43a0016dbe3e300740e04f43f4d13ebd354b6c67ad438f96ec25`。
- Windows 自动 CRLF checkout 后 Hash：`2fc603c4d2d28b518e3d05fd6afbe15a8b9d9d16e75ee53d82eead26122af9f6`。
- 本地将原始 LF 数据转换为 CRLF 后复算，与失败日志中的 Hash 完全相同。
- 失败记录保留在原 Actions run；没有把失败校验改为 skip、忽略或比较宽松 Hash。

## 实现与回归

新增仓库 `.gitattributes`，仅把 `fixtures/legacy-builder/*.json` 固定为
`text eol=lf`。Windows 启用 `core.autocrlf=true` 也必须保留这批已记录证据的
原始 LF 字节。原 JSON 内容、模型试验、策略、Prompt、引用和证据 Hash 均未改写。

`evals/builder/codex-acceptance.test.ts` 新增 Git checkout 回归：

1. 在专属临时 Git 仓库中强制 `core.autocrlf=true`，暂存原证据，删除该临时副本后重新 checkout。
2. 无仓库属性的对照确实生成 CRLF，不能满足原始 Hash。
3. 使用真实仓库属性后 checkout 生成 LF，原始 Hash 与用量绑定逐字节一致。

测试覆盖的是实际 Git hydration，不使用仍在磁盘上的未改动文件或 index/stat 缓存
充当 checkout 验证。临时仓库由测试创建并清理，不改用户 Git 配置或工作目录。

本地修复后验证：证据专项 5/5、`typecheck:evals`、`build`、diff check 通过；
完整 `npm test` 为 35 个 5C + 309 个测试，**344/344**，零失败、零跳过。
PR 合并仍须等待修复提交对应的全部五项远端 CI；最新结论以 PR checks 为准。

原 Copilot 配额错误与 pending 状态、独立 Codex 两轮 20/20 记录仍分别保留。
此次仅修复证据文件的跨平台 checkout 兼容性，不进行额外模型调用或改变产品默认模型。
