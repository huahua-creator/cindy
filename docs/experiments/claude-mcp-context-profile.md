# Claude Code 新会话 MCP 上下文 A/B 入口

状态：源码实验入口；没有 GUI 开关，不是自动工具选择，不会改变现有安装版。

## 普通会话的可调用入口

支持本更新的 Cindy 会话可通过既有 `cindy_helper` 的
`list_tools({category:"handoff"})` 发现 `send_to_session`，再用 `call_tool`
调用。没有增加顶层 MCP 工具或打开 release 调试端口。
发现结果必须明确包含 `claude_excluded_mcp_servers`；旧包没有该字段时停止，
不要向旧工具猜传陌生参数后把“任务创建成功”当作筛选已经生效。

在已明确选好共享连接/模型、工作目录为目标 Vault 的**普通本机 Claude Code**控制会话中，
先后调用两个新任务（不要传 `target_session_id`）：

```json
{"name":"send_to_session","args":{"message":"不要调用任何工具，只回复OK。","title":"上下文对照 A","claude_excluded_mcp_servers":[]}}
```

```json
{"name":"send_to_session","args":{"message":"不要调用任何工具，只回复OK。","title":"上下文对照 B","claude_excluded_mcp_servers":["wwise-mcp"]}}
```

每次成功 create 立即投递该新任务的第一条消息；这不是预览命令，本次开发未执行真实调用。
等待 A 完成再发 B；不要重复创建、复用旧句柄或发送额外续接消息。通过支持的应用界面/工具
记录各子任务的真实 usage；控制会话自身的调度请求另计，不能宣称整个流程只有两次上游请求。

显式名单（包括 `[]`）禁止同时传执行配置覆盖、`working_dir` 或 `use_worktree=true`，
拒绝旧目标、缺少 dispatcher、远程、非 Claude、非 active、Bot/Review/Orca 或 Bot-linked 来源。
来源必须有显式 provider；继承目录、workspaceKind 和稳定的运行时模型连接、effort/Fast。
Host 固定新诊断任务为 ask 权限和 Plan 模式，不继承来源权限/Plan；来源权限/Plan 变化不使诊断失败。
Plan 本身会增加上下文，本轮 A 基线不必等于此前的 98.5K。缺省该字段的普通 handoff 保持原行为。

失败返回 `PRECONDITION_FAILED` 或 `CLEANUP_INCOMPLETE`，附 `target_session_id`、
`dispatch_started` 和 `draft_state`。`preserved-closed` 只证明未向模型派发且原句柄已关闭；
草稿和可能已保存的用户消息保留在创建账号，可能刷新后才显示。`cleanup-incomplete` 表示
关闭或派发无法确认，不要盲目重试。不删除/归档草稿；用户以后仍可修改或恢复，并非永久只读沙箱。

返回的 `claude_excluded_mcp_servers` 是去重后的**启动请求名单**，不是观测到的工具数。
核对返回的 model/provider/effort/fast 与本次对照条件；不一致即标记对照无效并停止，不改 Key
或切来源重试。真实 token、缓存、保留工具与必要规则仍需验收。此入口不包含 Codex Memory
写入验收，也不切 defaultProvider。

普通本机新建 Claude Code 会话时，调用方可在既有 `vendorOptions` 中显式提供：

```ts
vendorOptions: { claudeExcludedMcpServers: ['wwise-mcp'] }
```

这是服务器**精确名称**，不是工具名称或匹配模式。最多 32 项，每项 1–64 个 ASCII
字母、数字、连字符或单下划线，不接受双下划线、空白和通配符。缺省保持普通路径；显式空数组是诊断基线，也受新会话边界约束。
列表启动时复制、去重并冻结；修改原数组或调用 `setVendorOptions` 不会热切工具集合。
远端、伙伴、review、初始 resume 会话不能使用显式列表（包括空数组），启动副作用前直接拒绝。

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

## A/B工具入口审查与离线验证（2026-10-09，v8）

独立 reviewer `context_pre_review`（`gpt-5.6-sol` / medium）初轮后审为 NO-GO：
来源权限/Plan漂移可留下高权限空任务，成功回传使用落库行而非最终运行路由。
方案收窄后独立前审有条件 GO：诊断目标固定 ask＋Plan；预存安全草稿，
用 owner/app generation、精确Session对象/instanceId、runtime generation和provider revision
绑定路由；失败保留草稿，只有精确句柄确认关闭才返回 preserved-closed。
Host-only beforeVendorDispatch 在授权刷新后执行，缺省不增加await，不转交vendor。
启动捕获回调之前的失败无法证明运行时关闭，保守返回 cleanup-incomplete。

实现自查修正了核心失败时 turn generation 回滚后的关闭判据，并增加实际Session联动回归。
定向离线测试：Host生产函数/adapter55、执行配置15、Maker125、origin62、排除17、重建4、
MCP传输34，共312项通过；docs合同10项通过。Desktop类型检查、maker-core build通过。
完整MCP包类型检查仍有HEAD相同的10条旧测试诊断（sessionControlTools、submitGithubIssueTool、
computerMcpServer）；排序字符串契约仍为HEAD相同的6项失败，无新增失败，未弱化旧断言。
最终实际复审：`context_pre_review` / `gpt-5.6-sol` medium 给出 GO，无剩余P0/P1；
reviewer独立复跑Host55/55通过。P1修复后最终Desktop incremental typecheck exit0。
源码入口离线验收完成；未换装或进行真实模型/Memory验收。

影响边界：新增字段只在工具渐进发现后暴露，可能增加控制任务的发现上下文；A/B首轮
固定Plan也有上下文成本。冻结排除列表及缺省发送路径保持原有机制，核心事件转换未改。
离线测试证明派发时序和参数传递，不证明真实缓存率、延迟或98.5K下降，留待换装后的双验收。

后审发现与处理：P1指出诊断catch提前返回绕过灵动岛preview rollback；已在未派发分支撤回
临时卡片/rollback token，不删除草稿和消息，来源漂移与真实Session失败回归覆盖该行为。
P2保留为计量局限：最终来源行、Bot关联和目标行是分次读取，不是同一DB快照；仅落库的
并发归档/关联变化可能发生在对应读取后。运行时owner/实例/route检查不等价于DB事务隔离。
本入口仅用于受控、顺序执行的短句A/B，不作为安全隔离；验收时来源任务及关联保持不变，
观察到任何并发改动则作废该组。不为一次性计量引入跨模块DB锁；真实采样仍待验收。
