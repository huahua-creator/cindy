# 方案：无版本号包侧栏显示官方 Cindy 基线（开工前 r2）

日期：2026-10-08
对象：extra `feat/host-readonly-xdt-facade-on-0.1.97` HEAD `3cfe760885beb85369660fa343ac5abd8585a83b`
官方基线（本刀显式受信输入，不是 `git describe`）：tag `v0.1.97` → commit `88e224475a6183f7b31218a7499be956a4bf2667`（已核是 HEAD 祖先）
生产安装仍：`e0041fc0877756723409544cae7c2693923dab0d`，FileVersion `0.0.0`，侧栏 `CN · 0.0.0 Beta`
开工前拷问：Orca Worker `versionless-display-pre` / `gpt-5.6-sol` / OpenAI / medium → **NO-GO**。本 r2 吸收其 3 条 P1。

## 目标

1. 打 `3cfe76088` 的 **0.0.0 / versionless / cn** 包并静默换装（会杀 Cindy）。
2. 侧栏/关于页编号体现当前官方 Cindy 版本（本刀 `v0.1.97` → 显示 `0.1.97`），不再只显示 `0.0.0`。
3. 换装后本 vault **新开 Codex** 验 `cindy_memory` 写入。

## 非目标 / 硬边界

- 不改 `updateService` 放行 0.0.0 热更。
- 不把 PE / `app.getVersion()` / `APP_VERSION` 打成 `0.1.97`（会打开热更，官方包覆盖 extra）。
- 不伪造 `config/log-upload.json`，不打有版本号发布包。
- 不 push Cindy `origin/main`，不开 makecindy PR，不改 `install.ps1`。
- 不把 owner `defaultProvider` 切到 xdt；不声称默认 memory provider 已切 xdt。
- 本刀不扩 rewind / descendant forget。
- Pack 与 install 两步；公司 vault 脏 main 不是 commit cwd。
- 不做通用「任意本地 tag 即官方」发现。本刀只接受显式受信 tag。

## 已验证事实

- 打包省略 `--version` → `VERSIONLESS_VERSION='0.0.0'`；NSIS/rcedit 只接受纯数字段。
- `isVersionlessAppVersion`：`version === '0.0.0' || version.startsWith('0.0.0-')`。启动热更与 `doCheckForUpdate` 都对 0.0.0 短路。
- 侧栏 `UserInfoSection`：`CN · ${appDisplayVersion}` + 独立 Beta 徽章。`appDisplayVersion` 来自 preload 同步 IPC `get-app-display-version-info` → `getAppDisplayVersionInfo()`。
- **打包后** `getAppDisplayVersionInfo` 直接返回 `app.getVersion()`，所以显示 `0.0.0`。未打包才拼 `branch@sha`。
- `cindy-source.json` 由 `forge.config.ts` `stageCindySourceMetadata()` 在 prePackage 写入，extraResource 打进 `resources/cindy-source.json`。现字段：`sourceCommit`、`builtAt`。Cindy Make `retainPersonalVersion` 只校验这两项，多字段可兼容。
- 有版本打包缺 `config/log-upload.json` 会失败（本机无该文件）。历史私有 `0.0.1` 会被官方 `v0.1.93+` 覆盖并丢掉 extra。
- `appDisplayVersion` 消费点只有侧栏、关于页、preload；**不参与热更比较**。热更只认 `app.getVersion()`。
- Reviewer 已排除：display 不会漏进 `updateService` / `windowsInstallationVersion`（那些直接读 `app.getVersion()`）；Cindy Make 未知字段不触发严格 schema。
- 现网 `cindy-unversioned-Setup.exe`（2026-10-08 10:29，247100801 bytes）对应已安装 `e0041fc08`。换装会覆盖该路径，故必须先拷走当回退介质。
- NSIS `allowToChangeInstallationDirectory: false`，固定装到 `%LOCALAPPDATA%\Programs\Cindy`。旧脚本 `replace-install-20260926.ps1` 先杀进程再 `/S`，失败只 exit，**不能恢复旧安装**。

## 方案

包仍 0.0.0（热更短路）。显示层读打包时烘焙的**显式受信**官方 tag。

### 1. 烘焙 `upstreamTag`（显式受信，不 describe）

`stageCindySourceMetadata()` 增加可选字段 `upstreamTag`。本刀唯一合法来源：

```
CINDY_UPSTREAM_TAG=v0.1.97
```

解析规则（抽出可测纯函数，forge.config import）：

1. 环境变量缺省 / 空 → **省略** `upstreamTag`（dev 脏树仍能打 versionless 包）。
2. 须匹配 `^v\d+\.\d+\.\d+(?:-beta(?:\.[0-9A-Za-z.-]+)?)?$`，否则 **打包失败**（显式传了却非法，不能静默显示错号）。
3. `git rev-parse <tag>^{commit}` 必须等于本刀钉死的 `88e224475a6183f7b31218a7499be956a4bf2667`（防止本地同名 tag 被挪到别的 commit）。不等则 **打包失败**。
4. `git merge-base --is-ancestor <resolved-commit> HEAD` 必须成功，否则 **打包失败**。
5. 通过后才写入 `upstreamTag: "v0.1.97"`。

禁止：`git describe`、任意本地最近 tag、网络拉 GitHub latest。本刀不把「官方」语义绑到未核验的本地名字。

`package-desktop.mjs`：versionless + `--region cn` 的本刀命令显式带 `CINDY_UPSTREAM_TAG=v0.1.97`。`verifyPackagedSourceMetadata`：

- 仍强制 `sourceCommit`/`builtAt`。
- 本刀期望 `upstreamTag === 'v0.1.97'`（命令传了 env 就必须出现在产物里）。
- 非法 tag 形态 / 与 env 不一致 → 打包失败。

不抽通用 `resolveOfficialUpstreamTag(describe)`。函数名用 `resolvePinnedUpstreamTag({ tag, expectedCommit, head })`。

### 2. 显示

从 `bootstrap-electron.ts` 抽出纯函数 `formatAppDisplayVersionInfo`（IPC 包装留在 bootstrap，**同步路径全程 try/catch，任何抛都回退 `app.getVersion()`，不得让 preload 挂**）：

合法 metadata 定义为：JSON 对象 + `sourceCommit` 为 40 位 hex + `builtAt` 可解析日期 +（若有）`upstreamTag` 符合上列正则。`sourceCommit` 畸形但 tag 碰巧合法 → **不显示官方号**，回退 `0.0.0`。

| 场景 | display | detail |
|---|---|---|
| 未打包 | 维持现状 `version · branch@sha` | 同 display |
| 打包且非 0.0.0 | `app.getVersion()` | 同 display（忽略 metadata 里的 tag） |
| 打包且 0.0.0，合法完整 metadata 且有 `upstreamTag` | 去掉 `v` 前缀，如 `0.1.97` | `0.1.97 · <sourceCommit 7 位>` |
| 打包且 0.0.0，无 tag / 非法 / 坏 JSON / 缺文件 / sourceCommit 畸形 | `0.0.0` | 仅当 sourceCommit 合法时 `0.0.0 · <7 位>`，否则 `0.0.0` |

读文件：`path.join(process.resourcesPath, 'cindy-source.json')`。

侧栏结果（cn + enableBeta）：`CN · 0.1.97 Beta`。关于页国内版同一 `appDisplayVersion`。不改 UserInfoSection 拼装（现有 hover 测试钉死模板）。

**禁止**：用 display 字符串参与 `isVersionlessAppVersion` / manifest 比较 / Windows 安装版本同步。那些继续用 `app.getVersion()`。`get-app-version` IPC 仍返回 `app.getVersion()`。

### 3. 测试

- `formatAppDisplayVersionInfo`：上表各行 + 非法 tag + 有版本包忽略 tag + 坏 JSON 不抛 + sourceCommit 畸形不显示官方号。
- `resolvePinnedUpstreamTag`：env 缺省省略；非法名失败；resolved commit ≠ 钉死 SHA 失败；非祖先失败；`v0.1.97` + `88e224475…` + ancestor 成功。
- `versionStore`：旧 fixture 无 `upstreamTag` 仍能 `retainPersonalVersion`；新 fixture 带 `upstreamTag` 也能 retain。
- 不改 `updateService.ts` / 其测试；确认本刀 diff 不碰该文件。
- 不要求改 Windows 安装版本同步测试（0.0.0 已短路）。

### 4. 打包 / 换装 / 验收 / 回退介质

换装**前**（杀 Cindy **之前**）必须先有可执行回退：

1. extra 工作树除本刀显示改动外干净；HEAD 基线仍是 `3cfe76088`。显示改动本地 commit，不 push origin。
2. 把现网安装器拷到回退介质（不得覆盖即将打的新包）：
   - 源：`apps/desktop/release/artifacts/cn/unversioned/win32-x64/cindy-unversioned-Setup.exe`
   - 目标：`apps/desktop/release/rollback/e0041fc08/cindy-unversioned-Setup.exe`
   - 拷前核源：size `247100801`，SHA-256 `6da74aaccc9b0dbab215b47b71b53211e369f5fd9a452b542157e6411bedf2a0`，当前安装 `cindy-source.json.sourceCommit === e0041fc08…`
   - 拷后核目标与源 SHA-256 相等。缺拷贝或校验失败 → **禁止换装**。
3. PowerShell：
   ```
   $env:CINDY_UPSTREAM_TAG = 'v0.1.97'
   try {
     Set-Location D:\AI\Claude\cindy\apps\desktop
     node scripts/package-desktop.mjs --region cn --no-sign --skip-smoke
   } finally { Remove-Item Env:CINDY_UPSTREAM_TAG -ErrorAction SilentlyContinue }
   ```
   （`--skip-smoke` 只跳过打包机启动；换装后的可见验收另做，见下。）
4. 核新产物 `cindy-source.json`：`sourceCommit=3cfe76088…`，`upstreamTag=v0.1.97`。核完之前不得覆盖 rollback 目录。metadata 核验失败 = 换装失败，走 rollback（本步尚未杀 Cindy 则停止即可）。
5. 新写 `apps/desktop/scripts/release/replace-install-20261008.ps1`（勿改 20260926 历史脚本；`release/` 被 gitignore）：
   - 任何 `Start-Process` 之前确认 rollback 介质存在且 SHA 匹配。
   - 杀 Cindy → `/S` 装新包。
   - **先判 installer exit code**；非 0 立刻用 rollback 介质再 `/S`，再核旧 `sourceCommit=e0041fc08…`。恢复失败明确报告，不得 launch 半装状态。
   - 新装成功才核：`sourceCommit=3cfe76088…`、`upstreamTag=v0.1.97`、FileVersion 仍 `0.0.0`。metadata 核验失败同样走 rollback。
   - 可见验收（缺一不算换装完成，Lead 未见核验不得宣称完成）：侧栏 `CN · 0.1.97 Beta`；关于页 `0.1.97`（detail 含 7 位 commit）；`get-app-version` / FileVersion 仍 `0.0.0`；应用内更新对当前 0.0.0 仍 unsupported / no-op。
   - 可见验收失败同样走 rollback 介质恢复旧安装并复核旧 sourceCommit。
6. 本会话可能随 Cindy 被杀中断。换装+可见验收通过后，请在本 vault **新开 Codex** 对生产 UUID `dc703d5e-1ce0-4543-be4d-014cfa3a1955` 做 `cindy_memory` create/update。成功只证明 Host extra 槽位+override；不声称 owner defaultProvider=xdt。

## 回退

不是热更。versionless 不产 hotfix ZIP。失败路径：用步骤 2 的 `rollback/e0041fc08` 安装器覆盖装回，复核 `sourceCommit`。显示改动只影响文案；热更路径不变。需要丢掉 extra 显示 commit 时 checkout 掉本刀 commit 再打 0.0.0。

没有 rollback 介质 = 不得换装。

## 审查请质询（r2）

上一轮 3 条 P1 是否已变成可执行约束。新风险：钉死 SHA 是否过严（本刀故意过严）；可见验收若 Cindy 被本会话杀掉如何完成（允许换装后由用户/新会话核侧栏，但 Lead 不得在未见核验前宣称完成）。
