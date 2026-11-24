# Chunked Write Guard

零依赖的 Antigravity 插件，用于避免单次 `write_file` 或 `edit_file` 输出过长触发流式超时（`The stream was interrupted`）并反复零进度重试。

## 解决什么问题

当模型试图在一次 `write_file` 里直接生成上千行单页原型、大型组件或长文档时，很容易在参数流式输出中途达到约 10 分钟连接超时而断流。因为工具调用没有闭合，磁盘上不会写入任何内容。系统自动重试或用户发送 `continue` 后，模型又会从头生成同一份文件，再次超时。

本插件由四个部分配合处理这一问题：

1. **常驻规则（`rules/AGENTS.md`）**：约定单次写入目标。长文件先写骨架，再通过多次 `write_file(Append: true)` 或 `edit_file` 按模块补齐。
2. **断流恢复（`PreInvocation` Hook，可在面板关闭）**：扫描 `transcript.jsonl` 尾部。仅在开关启用且上一轮出现未恢复的 `stream was interrupted` 或流超时记录时注入一次续写提醒，并附带去重标记。关闭后不再向模型上下文注入额外提醒；正常对话直接返回 `{}`，不影响 Prompt Cache。
3. **超大写入拦截（`PreToolUse` Hook）**：匹配 `write_file|edit_file`，拦截超过单次写入上限的写入和超过合计上限的全量替换，并返回拆分建议。纯删除旧代码（`Replacement` 为空）直接放行，脚本异常时自动 `fail-open` 放行。
4. **侧边栏面板（Sidecar UI）**：内置 Write Guard 面板，支持在 `700`、`500`（默认）、`300` 三档间切换，随时开关断流恢复提示，查看或清零触发统计。点击顶栏版本号可查看完整变更日志；点击「检查更新」可直接从 GitHub 拉取新版本替换升级并自动重载，同时保留本地档位、开关与统计日志。切换配置后 Hook 立即生效，`rules/AGENTS.md` 同步重写。

## 三档阈值

| 档位 | 单次写入目标（`AGENTS.md`） | 单次写入上限（`PreToolUse`） | `edit_file` 合计上限（`Target + Replacement`） | 断流恢复上限 |
| :--- | :---: | :---: | :---: | :---: |
| 700 行 · 宽松档 | ≤ 700 行 | 1100 行 / 64 KB | 1200 行 / 72 KB | ≤ 400 行 |
| **500 行 · 标准档（默认）** | **≤ 500 行** | **800 行 / 48 KB** | **900 行 / 56 KB** | **≤ 300 行** |
| 300 行 · 稳妥档 | ≤ 300 行 | 500 行 / 28 KB | 600 行 / 36 KB | ≤ 200 行 |

## 安装

本机需先安装 Node.js >= 20 与 Antigravity。

### Windows (PowerShell)

```powershell
git clone https://github.com/Lynn-zy/antigravity-chunked-write-guard.git
cd antigravity-chunked-write-guard
.\scripts\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/Lynn-zy/antigravity-chunked-write-guard.git
cd antigravity-chunked-write-guard
bash ./scripts/install.sh
```

安装脚本将插件复制到 `~/.gemini/config/plugins/chunked-write-guard`，不改动 Antigravity 的 `config.json`。再次运行脚本升级时，会保留 `config/active-preset.json` 中已选的档位并同步更新 `rules/AGENTS.md`。安装完成后 Antigravity 会自动发现并启用插件，在侧边栏打开 Write Guard 面板即可切换档位。

### 卸载

```powershell
# Windows
.\scripts\install.ps1 -Uninstall

# macOS / Linux
bash ./scripts/install.sh --uninstall
```

## 目录结构

```text
.
├── plugin.json                  # Antigravity 插件清单
├── hooks.json                   # PreInvocation 与 PreToolUse Hook 声明
├── assets/logo.svg              # 插件图标
├── rules/AGENTS.md              # 常驻分段写入规范（与当前档位同步）
├── scripts/
│   ├── presets.mjs              # 三档配置与规则渲染
│   ├── stats.mjs                # 触发事件追加日志与统计清零
│   ├── hook-core.mjs            # 阈值判定与断流检测逻辑
│   ├── write-guard-hook.mjs     # Hook CLI 入口（fail-open）
│   ├── hook-core.test.mjs       # Hook 与面板状态单元测试
│   ├── updater.test.mjs         # 面板内更新器单元测试
│   ├── install.ps1              # Windows 安装与卸载脚本
│   └── install.sh               # macOS / Linux 安装与卸载脚本
└── sidecars/panel/
    ├── sidecar.json             # 侧边栏 Sidecar 面板声明
    ├── main.mjs                 # Sidecar HTTP 服务入口
    ├── panel-logic.mjs          # 面板状态查询、档位与开关逻辑
    ├── updater.mjs              # 零依赖 GitHub 更新检测、下载校验与安全替换
    └── index.html               # 侧边栏面板页面（自适应宿主主题）
```

## 本地测试

```bash
npm test
```

## License

[MIT](./LICENSE)
