# Changelog

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
