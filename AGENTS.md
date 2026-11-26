# AGENTS.md

本仓库用于开发与发布 Antigravity 的 `antigravity-rail`（Antigravity Rail）三合一行为护栏插件：分段写入规范（700/500/300 档）、先回话与途中汇报规范（静默 4/6/10 档）、工具摘要中文规范（同轮立即纠偏），配套统一侧边栏 Sidecar 面板实时切换各模块开关与档位。

## 工程约束

- **单一配置与规则源**：三模块的阈值档位、默认开关及 `rules/AGENTS.md` 渲染模板只在 `scripts/config.mjs` 中维护；修改后运行 `node -e "import('./scripts/config.mjs').then(m => m.syncRulesFromSettings())"` 同步仓库内默认 `rules/AGENTS.md`（注意不要将临时生成的 `config/settings.json` 提交入库）。
- **提醒文案各有唯一来源**：超限写入提醒在 `scripts/write-guard-core.mjs`，响应/汇报纠偏在 `scripts/responsive-core.mjs` 的 `REMINDER`，摘要中文纠偏在 `scripts/tool-locale-core.mjs` 的 `REMINDER`。
- **安装与自更新白名单同步**：`scripts/install.ps1`、`scripts/install.sh` 与 `sidecars/panel/updater.mjs`（`REQUIRED_FILES`）必须保持运行时文件白名单一致；新增或删除运行时文件时三处同步更新，并在安装脚本里清理旧 `.mjs` 残留。`install.ps1` 保留 UTF-8 BOM。
- **零依赖与 `fail-open`**：保持纯 Node.js ESM（>= 20）零第三方运行时依赖；所有 Hook 入口遇到异常或非法输入一律输出 `{}` 放行。
- **Sidecar 运行约束**：`sidecar_sdk` 由宿主全局目录 `~/.gemini/config/node_modules/` 提供，端到端启动 Sidecar 面板验证须在已安装插件目录执行；宿主 `preload.js` 会内联覆盖 `body.style.padding = 0`，面板留白写在独立内层 `.page` 容器中。

## Agent skills

### Issue tracker

GitHub Issues on `Lynn-zy/antigravity-rail` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at repo root). See `docs/agents/domain.md`.
