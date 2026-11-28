# Changelog

## [3.0.1] - 2026-11-28

### Changed
- 优化 `responsive-file-links` 文件链接 Hook 的注入提醒文案：明确仅对真实本地/工作区文件要求使用 `file:///` 可点击链接，提及远程、外部或泛指文件名时直接忽略该提醒，避免误导模型。
- 互换中英文 README，仓库默认展示简体中文文档。

## [3.0.0] - 2026-11-27

### Added
- 合并 `responsive-mode` 与 `tool-locale` 能力，整体升级为三合一护栏插件 **Antigravity Rail**（插件 ID：`antigravity-rail`）。
- 新增「先回话与途中汇报」模块（`responsive-mode`）：支持 `4 / 6 / 10` 次三档中途静默阈值、模块总开关、轮间节奏纠偏 Hook 与同轮已知工作区文件可点击链接（`file:///`）纠偏。
- 新增「工具摘要语言匹配」模块（`tool-locale`）：覆盖 `update_steps` 步骤标题（`title`）、`update_focus` 状态（`focus`）与 `run_command` 摘要（`toolSummary`），自动识别 9 种非拉丁文字脚本并支持纯拉丁短回复回溯，提供同轮立即纠偏 Hook（每用户轮次最多一次，允许混排 `npm test` 等技术标识）。
- 侧边栏面板升级为中英双语三标签布局（「分段写入 / 响应汇报 / 摘要语言」），每个模块提供独立的模块总开关（关闭时自动从 `rules/AGENTS.md` 移除对应章节）与 Hook 开关；底部统一展示四项累计触发统计（超限落盘、写入提醒、响应纠偏、摘要纠偏）及最近 3 条带时间戳触发记录，支持一键清零。
- 安装与卸载脚本（`scripts/install.ps1`、`scripts/install.sh`）支持通过 `config/sidecar.pid` 在升级或卸载时自动重启/停止运行中的侧边栏 Sidecar 进程。

### Changed
- 统一配置持久化至 `config/settings.json`（`scripts/config.mjs`），Hook 入口拆分为 `write-guard-hook.mjs`、`responsive-hook.mjs`、`tool-locale-hook.mjs` 并共享 `scripts/transcript.mjs`。
- 面板接口收口为 `POST /api/settings`，更新器与安装脚本同步切换至 `antigravity-rail` 并在安装前清理旧 `.mjs` 脚本残留。
- 重写中英文 README，补充安装前后实拍对比、暗黑/明亮双模式真实侧边栏面板截图与 Mermaid 架构图。

### Fixed
- 修复面板点击「清零」后触发状态未及时刷新的问题，并确保新事件到达时自动收起残留提示。

## [2.0.2] - 2026-11-24

### Changed
- 将侧边栏面板的缓存提示移至顶部说明文字下方、档位卡片上方，切换档位前可直接看到。

## [2.0.1] - 2026-11-24

### Added
- 侧边栏面板新增缓存提示，说明在对话中途切换档位或开关会重写 `AGENTS.md` 并导致下一轮前缀缓存失效重算。

### Fixed
- 修复从 `v1.3.x` 热升级期间旧会话仍调用 `pre-tool-use` 返回 `{}` 被宿主拒绝写入的问题；遇到 `pre-tool-use` 或 `PreToolUse` 事件时自动 `fail-open` 输出 `{"decision":"allow"}`。

## [2.0.0] - 2026-11-24

### Changed
- 将超大写入处理由 `PreToolUse` 硬拦截改为 `PostToolUse` 落盘后检测加下一轮 `PreInvocation` 事后提醒，不再阻断写入或丢弃已生成代码。
- 待提醒记录按 `conversationId` 哈希隔离存放在 `config/pending/`，读取一次后立即删除并附带 30 分钟过期丢弃；没有超限写入时 `PreInvocation` 直接返回 `{}`。
- 侧边栏面板同步升级：档位卡片展示单次写入目标、单次写入警戒线与 `edit_file` 合计警戒线，开关改为「超限事后提醒」（接口 `/api/reminder`），统计改为「超限落盘」与「事后提醒」。
- 重写 `rules/AGENTS.md` 常驻规则，与新的警戒线和事后提醒开关保持一致。

### Removed
- 移除 `PreToolUse` 硬拦截，避免模型完成流式输出后因拦截被迫重新生成。
- 移除基于 `transcript.jsonl` 的断流恢复 Hook 与对应开关，避免把用户手动停止或上游 10 分钟无响应误判为大文件超时。

## [1.3.1] - 2026-11-24

### Added
- 点击顶栏版本号可打开完整的本地变更日志弹窗，并将 `CHANGELOG.md` 纳入安装与自更新白名单。
- 更新弹窗与变更日志弹窗均改用零依赖纯 DOM Markdown 渲染，支持标题、列表、行内代码、加粗与安全链接。

### Changed
- 更新安装完成后切换为极简不可关闭的成功弹窗，自动倒计时 3 秒重新加载面板。
- 统一更新弹窗底部「关闭」与主操作按钮尺寸，并放大变更日志弹窗整体字号与行高。

### Fixed
- 修复 Windows 下宿主占用 `sidecars/panel` 目录句柄导致自更新删除目录触发 `EBUSY` 及回滚失效的问题，改为按文件级就地替换与幂等回滚。
- 修复命中 `api.github.com` 匿名限流回退公开通道后缺少更新说明的问题，自动从 `raw.githubusercontent.com` 提取对应版本变更日志。

## [1.3.0] - 2026-11-24

### Added
- 侧边栏面板新增「检查更新」功能，支持从 GitHub 检查最新版本、查看更新说明并一键下载替换升级，升级时保留本地档位、开关与触发统计，失败自动回滚。
- 侧边栏面板新增「断流恢复提示」开关；关闭后不再向模型上下文注入断流恢复提醒，并同步更新 `rules/AGENTS.md`。
- 顶栏展示当前插件版本号，新增 GitHub Actions 自动发布流程（推送 `v*` 标签自动测试、校验版本号并创建 Release）。

### Changed
- 断流恢复提醒文案明确限定仅对本轮续写生效，避免影响后续轮次或摘要。

## [1.2.0] - 2026-11-23

### Added
- 新增轻量触发统计，通过单行追加日志 `config/events.jsonl` 仅记录超限拦截（`deny`）与断流恢复（`recovery`）事件，正常放行不写盘。
- 在 Write Guard 侧边栏面板底部展示累计拦截次数、断流恢复次数、最近触发时间与「清零」按钮，切回面板时自动刷新计数。

### Fixed
- 面板重复点击当前激活档位时不再发请求或重写磁盘文件。

## [1.1.0] - 2026-11-23

### Added
- 新增 Write Guard 侧边栏面板，可在 `700`、`500`、`300` 三档之间切换写入限制，自动适配 Antigravity 暗色与浅色主题。
- 切换档位后，Hook 阈值立即生效，常驻规则文件 `rules/AGENTS.md` 同步更新，档位保存在 `config/active-preset.json`。
- 新增 Windows 与 macOS / Linux 安装和卸载脚本（`scripts/install.ps1`、`scripts/install.sh`），升级时保留已选档位。

### Changed
- 默认单次写入目标调整为 ≤ 500 行，常规源码文件不必拆成多次写入。
- 将 `edit_file` 合计上限（`Target + Replacement`）收紧为 `1200 / 900 / 600` 行，与单次流式输出上限保持接近。

## [1.0.0] - 2026-11-23

### Added
- 提供常驻分段写入规则（`rules/AGENTS.md`）、`PreInvocation` 断流恢复 Hook、`PreToolUse` 超大写入拦截与 Node 单元测试。
