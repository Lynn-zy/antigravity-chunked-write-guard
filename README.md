# Chunked Write Guard

一款零依赖的 **Antigravity** 插件，用于防止模型在单次 `write_file` / `edit_file` 中生成超大文本触发流式超时（`The stream was interrupted`）并陷入“零进度重试死循环”。

## 解决什么问题

当模型试图在一次 `write_file` 里一口气输出上千行单页原型、大型组件或长文档时，很容易在参数流式生成中途耗满约 10 分钟连接超时而断流。因为工具调用未闭合，磁盘上不会落盘任何内容，重试或发送 `continue` 后又会从头生成同一份巨型文件，反复超时。

本插件通过三层配合打破这一问题：

1. **事前约束（Rules）**：常驻规则 `rules/AGENTS.md` 约定单次写入目标，引导模型对长文件采用“先写骨架、再分次 `Append` / `edit_file` 补齐”。
2. **断流自愈（`PreInvocation` Hook）**：仅在检测到 `transcript.jsonl` 尾部刚出现未恢复的 `stream was interrupted` / 流超时记录时注入一次分段续写提醒（带去重标记）；正常对话返回 `{}`，不污染上下文、不破坏 Prompt Cache。
3. **高阈值兜底（`PreToolUse` Hook）**：匹配 `write_file|edit_file`，拦截超过硬兜底线的巨型单次写入或全量覆盖式替换，并返回可执行的拆分指引；纯删除旧代码（`Replacement` 为空）直接放行；脚本异常自动 `fail-open` 放行。
4. **侧边栏三档面板（Sidecar UI）**：内置 **Write Guard** 侧边栏面板，可在 `700` / `500`（默认）/ `300` 三档之间一键切换——Hook 阈值即时生效，`rules/AGENTS.md` 同步更新。

## 三档阈值

| 档位 | 规则目标（`AGENTS.md`） | `PreToolUse` 单次兜底线 | `edit_file` 双向合计上限（`Target + Replacement`） | 断流自愈强制上限 |
| :--- | :---: | :---: | :---: | :---: |
| **700 行 · 宽松档** | ≤ 700 行 | 1100 行 / 64 KB | 1200 行 / 72 KB | ≤ 400 行 |
| **500 行 · 标准档（默认）** | **≤ 500 行** | **800 行 / 48 KB** | **900 行 / 56 KB** | **≤ 300 行** |
| **300 行 · 稳妥档** | ≤ 300 行 | 500 行 / 28 KB | 600 行 / 36 KB | ≤ 200 行 |

## 安装

前置要求：本机已安装 **Node.js >= 20** 与 **Antigravity**。

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

脚本会将插件安装到 `~/.gemini/config/plugins/chunked-write-guard`（升级时自动保留你通过面板保存的 `config/active-preset.json` 档位偏好，且不修改 Antigravity 的 `config.json`）。安装后 Antigravity 会自动发现并启用该插件，可在侧边栏打开 **Write Guard** 面板切换档位。

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
├── hooks.json                   # PreInvocation + PreToolUse Hook 声明
├── assets/logo.svg              # 插件图标
├── rules/AGENTS.md              # 常驻分段写入规范（与当前档位同步）
├── scripts/
│   ├── presets.mjs              # 三档配置单一数据源与规则渲染
│   ├── hook-core.mjs            # 阈值判定与断流检测核心逻辑
│   ├── write-guard-hook.mjs     # Hook CLI 入口（fail-open）
│   ├── hook-core.test.mjs       # Node 原生单元测试
│   ├── install.ps1              # Windows 安装 / 同步 / 卸载脚本
│   └── install.sh               # macOS / Linux 安装 / 同步 / 卸载脚本
└── sidecars/panel/
    ├── sidecar.json             # 侧边栏 Sidecar 面板声明
    ├── main.mjs                 # Sidecar HTTP 服务入口
    ├── panel-logic.mjs          # 面板状态查询与档位切换逻辑
    └── index.html               # 侧边栏 Web UI（自适应宿主主题）
```

## 本地测试

```bash
npm test
```

## License

[MIT](./LICENSE)
