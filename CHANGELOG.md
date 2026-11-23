# Changelog

## [1.1.0] - 2026-11-23

### Added
- 新增 **Write Guard** 侧边栏 Sidecar 面板，支持在 `700` / `500` / `300` 三档写入预算间一键切换，自动适配 Antigravity 暗/亮宿主主题。
- 新增 `scripts/presets.mjs` 单一数据源模块，切换档位时原子持久化 `config/active-preset.json` 并同步重写 `rules/AGENTS.md`。
- 新增跨平台安装与卸载脚本（`scripts/install.ps1`、`scripts/install.sh`），升级时自动保留用户当前已选档位。

### Changed
- 默认规则目标提升至 **≤ 500 行**，避免常规源码文件触发不必要的拆分返工。
- 收紧 `edit_file` 双向合计（`Target + Replacement`）上限至 `1200 / 900 / 600` 行，与单次流式输出预算保持对齐。

## [1.0.0] - 2026-11-23

### Added
- 初始版本：包含常驻分段写入规则（`rules/AGENTS.md`）、`PreInvocation` 断流自愈 Hook、`PreToolUse` 超大写入兜底门禁及零依赖 Node 测试套件。
