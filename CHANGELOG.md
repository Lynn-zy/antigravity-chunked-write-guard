# Changelog

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
