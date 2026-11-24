# Chunked Write Guard

零依赖的 Antigravity 插件，通过三档分段写入规范与落盘后事后提醒，让模型拆分写入长文件。

## 解决什么问题

模型在一次 `write_file` 或全量覆盖式 `edit_file` 中直接生成上千行代码时，流式输出耗时长，更容易中途中断。如果等参数生成完再硬拦截（`deny`），已经生成的代码会被丢弃，模型只能重新生成一遍。

本插件由三个部分配合处理这一问题：

1. **常驻规则（`rules/AGENTS.md`）**：在模型生成代码前约定单次写入目标。长文件先写骨架，再分次调用 `write_file(Append: true)` 或局部 `edit_file` 按模块补齐。
2. **落盘后检测与事后提醒（`PostToolUse` + `PreInvocation` Hook，可在面板关闭）**：
   - `PostToolUse` 只匹配 `write_file|edit_file`，在文件落盘后检查写入行数和字节数，不阻断写入。纯删除和执行报错的调用直接跳过。
   - 超过当前档位警戒线时，Hook 记录一次超限统计；开启「超限事后提醒」时，还会按 `conversationId` 写入一条待提醒记录。下一轮 `PreInvocation` 读取并删除该记录，向模型注入一条事后提醒（30 分钟未触发自动过期），避免模型后续继续写出超长内容。
   - 没有超限写入时，`PreInvocation` 直接返回 `{}`，不影响 Prompt Cache。脚本异常时自动 `fail-open` 放行。
3. **侧边栏面板（Sidecar UI）**：内置 Write Guard 面板，可在 `700`、`500`（默认）、`300` 三档间切换，开关「超限事后提醒」，查看或清零累计超限落盘与事后提醒次数。点击顶栏版本号可查看变更日志，点击「检查更新」可从 GitHub 拉取新版本升级并自动重载，同时保留本地档位、开关与统计日志。切换配置后 Hook 立即生效，`rules/AGENTS.md` 同步重写。

## 三档阈值

| 档位 | 单次写入目标（`AGENTS.md`） | 单次写入警戒线（`PostToolUse`） | `edit_file` 合计警戒线（`Target + Replacement`） |
| :--- | :---: | :---: | :---: |
| 700 行 · 宽松档 | ≤ 700 行 | 1100 行 / 64 KB | 1200 行 / 72 KB |
| **500 行 · 标准档（默认）** | **≤ 500 行** | **800 行 / 48 KB** | **900 行 / 56 KB** |
| 300 行 · 稳妥档 | ≤ 300 行 | 500 行 / 28 KB | 600 行 / 36 KB |

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

安装脚本将插件复制到 `~/.gemini/config/plugins/chunked-write-guard`，不改动 Antigravity 的 `config.json`。再次运行脚本升级时，保留 `config/active-preset.json` 中已选的档位与提醒开关，并同步更新 `rules/AGENTS.md`。安装完成后 Antigravity 会自动发现并启用插件，在侧边栏打开 Write Guard 面板即可切换档位。

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
├── hooks.json                   # PostToolUse 与 PreInvocation Hook 声明
├── assets/logo.svg              # 插件图标
├── rules/AGENTS.md              # 常驻分段写入规范（与当前档位同步）
├── scripts/
│   ├── presets.mjs              # 三档配置与规则渲染
│   ├── stats.mjs                # 超限与提醒事件追加日志与统计清零
│   ├── hook-core.mjs            # 落盘后超限检测与事后提醒消费逻辑
│   ├── write-guard-hook.mjs     # Hook CLI 入口（fail-open）
│   ├── hook-core.test.mjs       # Hook 与面板状态单元测试
│   ├── updater.test.mjs         # 面板内更新器单元测试
│   ├── install.ps1              # Windows 安装与卸载脚本
│   └── install.sh               # macOS / Linux 安装与卸载脚本
└── sidecars/panel/
    ├── sidecar.json             # 侧边栏 Sidecar 面板声明
    ├── main.mjs                 # Sidecar HTTP 服务入口
    ├── panel-logic.mjs          # 面板状态查询、档位与提醒开关逻辑
    ├── updater.mjs              # 零依赖 GitHub 更新检测、下载校验与安全替换
    └── index.html               # 侧边栏面板页面（自适应宿主主题）
```

## 本地测试

```bash
npm test
```

## License

[MIT](./LICENSE)
