# AGENTS.md

本仓库用于开发与发布 Antigravity 的 `chunked-write-guard` 插件（三档分段写入规则、断流恢复与超限拦截 Hook、侧边栏 Sidecar 面板）。

## 工程约束

- **单一阈值源**：修改三档数值或常驻规则文案时，只编辑 `scripts/presets.mjs`（`PRESETS` 与 `renderAgentsRule`），随后重渲染 `rules/AGENTS.md` 保持一致。
- **安装白名单同步**：`scripts/install.ps1` 与 `scripts/install.sh` 仅复制白名单内的插件运行时文件到 `~/.gemini/config/plugins/chunked-write-guard`。新增运行时文件须同步更新两份脚本；仓库根级 `AGENTS.md` 与 `docs/` 保留在源码仓内，不随插件安装。
- **零依赖与 `fail-open`**：保持纯 Node.js ESM（>= 20）零第三方运行时依赖；`scripts/write-guard-hook.mjs` 在任何异常或非法输入下必须放行（`pre-tool-use` 输出 `{"decision":"allow"}`，`pre-invocation` 输出 `{}`）。
- **Sidecar 运行约束**：`sidecar_sdk` 由宿主全局目录 `~/.gemini/config/node_modules/` 提供，端到端启动 Sidecar 面板验证须在已安装插件目录执行；宿主 `preload.js` 会内联覆盖 `body.style.padding = 0`，面板留白写在独立内层 `.page` 容器中。

## Agent skills

### Issue tracker

GitHub Issues on `Lynn-zy/antigravity-chunked-write-guard` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at repo root). See `docs/agents/domain.md`.
