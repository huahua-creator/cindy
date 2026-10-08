# Claude Code 新会话 MCP 上下文 A/B 入口

状态：源码实验入口；没有 GUI 开关，不是自动工具选择，不会改变现有安装版。

普通本机新建 Claude Code 会话时，调用方可在既有 `vendorOptions` 中显式提供：

```ts
vendorOptions: { claudeExcludedMcpServers: ['wwise-mcp'] }
```

这是服务器**精确名称**，不是工具名称或匹配模式。最多 32 项，每项 1–64 个 ASCII
字母、数字、连字符或单下划线，不接受双下划线、空白和通配符。缺省或空数组保持原行为。
列表启动时复制、去重并冻结；修改原数组或调用 `setVendorOptions` 不会热切工具集合。
远端、伙伴、review、初始 resume 会话不能使用非空列表，启动副作用前直接拒绝。

排除来源有两层：host provider 在 `isEnabled` 和 factory 调用之前跳过；原生设置来源
通过 SDK `disallowedTools` 移除出站工具定义。规则、system prompt、基础工具、审批回调、
其余服务器和 Tool Search 路由策略不变。它减少工具暴露，不是沙箱或通用权限隔离。

同一 live handle 的取消、fork、目录授权和 invalid-resume 内部重建复用冻结列表。
本入口不写用户配置、数据库或全局 MCP；关闭句柄或重启应用后不会持久恢复。
重新 `startSession` 时由调用方重新指定。恢复默认只需创建不带该选项的新会话。
不要把此一次性诊断入口当作可恢复的产品工具配置；跨应用恢复需要另案设计。

## 可复现实验

```powershell
node scripts/context-tools-probe.mjs
node scripts/context-tools-probe.mjs --large
```

使用仓内 CLI 2.1.280 / SDK 0.2.112、临时 Windows 配置根、假 key、本地假 API、合成
MCP；不调用真实 MCP 或共享模型。子进程环境采用白名单，不继承真实认证或代理变量。
禁用非必要流量不等于 OS 级断网。输出只保存合成工具名、schema 字节、规则哨兵及聚合结果；
临时根保留供回读，不扫描、复制或删除真实用户数据。

2026-10-08 实测：

- 单用 `disallowedTools`：项目 stdio MCP 有效；SDK in-process MCP 无效。
- 双层筛选：合成 host + project 各 114 项，工具总数 **258 → 30**，`tools` JSON
  **182,358 → 88,532 字节**；基础 Read、规则哨兵、近似名保留工具均保留。
- 上述是合成协议参数实验，不是 Wwise 的真实 schema，也不是 token、缓存或延迟数据。
- 实际共享连接约 98.5K 输入的下降尚未验证。换装和真实 A/B 前须协调运行实例，不能
  为本实验强停/覆盖客户端。实际 A/B 应使用同连接同模型的两个新会话，分别记录输入、
  缓存读取、首字延迟及保留工具的只读调用结果；不得把假 API usage 当真实指标。

## 审查与验证记录

前审：`context_pre_review`，模型 `gpt-5.6-sol` / medium，方案 v4 有条件 GO；已落实早期
校验、独立冻结、provider 求值前过滤、禁止项合并和重建/恢复边界。此前原生参数探针已
获前审及事后 GO，reviewer 独立重复 9 组得到相同结果。

正式代码事后审查：同一 reviewer 对实际 diff、调用路径、测试及合成 summary 给出 GO，无 P0/P1，独立复跑直接相关测试 47/47 通过。主代理 153 项定向单测、12 组原生矩阵、114×2 大组、docs 合同 10 项及 diff-check 通过。新增/helper/test lint 通过；index.ts 的三个未使用变量错误用 HEAD 版本 stdin 复现。maker-core 的 tsc --noEmit 实际执行未通过：未修改的 pi-compaction-memory.test.ts:252/253 两处 TS2352，未将其伪报通过，也未修改无关代码。


## 构建阻塞窄修复核（2026-10-08）

为继续验证源码，补齐既有两处类型检查错误：浏览器 SQLite 使用已有 namespace，Pi 测试用 spyOn 替代错误结构强转。独立 reviewer `context_pre_review` / gpt-5.6-sol medium 前审与实际后审均 GO。snapshot 合成测试 44 通过、1 个既有平台 skip；Pi 12 通过；maker-core build 与 Desktop typecheck 均通过，diff-check 通过。没有访问或复制真实浏览器 profile。

安装版仍未替换。优先使用文档支持的同区域 shared/passive/preserve-running 开发预览验证；它会添加两个测试任务并可正常续期登录态，不是全局只读。不得强停 primary，不得复制凭证绕过启动门禁。真实 A/B 结果尚待执行。
