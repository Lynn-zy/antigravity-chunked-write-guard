# Antigravity Rail

零依赖的 Antigravity 综合行为护栏插件。将**分段写入**、**先回话与途中汇报**、**工具摘要中文化**三大护栏统一收口到同一个侧边栏 Sidecar 面板：每个模块均支持独立的**模块总开关**（关闭时连同 `rules/AGENTS.md` 对应章节一并移除）、**Hook 纠偏开关**与**触发档位**，并聚合展示四项累计触发统计。

## 三大护栏模块

### 1. 分段写入（`write-guard`）
防止模型在单次 `write_file` 或全量覆盖式 `edit_file` 里一口气输出上千行拖慢流式响应甚至中断。
- **三档阈值**：`700 行 · 宽松档` / `500 行 · 标准档（默认）` / `300 行 · 稳妥档`。
- **不阻断落盘**：`PostToolUse` 放行写入，仅在超限时记录统计并在开启 Hook 时按会话排队，由下一轮 `PreInvocation` 注入一次事后提醒（30 分钟过期，纯删除与报错调用跳过）。

| 档位 | 单次写入目标（`AGENTS.md`） | 单次写入警戒线（`PostToolUse`） | `edit_file` 合计警戒线（`Target + Replacement`） |
| :--- | :---: | :---: | :---: |
| 700 行 · 宽松档 | ≤ 700 行 | 1100 行 / 64 KB | 1200 行 / 72 KB |
| **500 行 · 标准档（默认）** | **≤ 500 行** | **800 行 / 48 KB** | **900 行 / 56 KB** |
| 300 行 · 稳妥档 | ≤ 300 行 | 500 行 / 28 KB | 600 行 / 36 KB |

### 2. 先回话与途中汇报（`responsive-mode`）
解决 Agent 接到任务闷头调工具或开场后连续十几步静默被折叠成 Exploring 的问题。
- **平时仅靠常驻规则约束**：会话首条消息不注入 Hook，遵守规则的多轮对话零干扰。
- **犯规后轮间纠偏**：仅当上一轮出现开场正文为空直接调用工具，或中途连续静默调工具达到设定档位（`4 次 · 敏感档` / `6 次 · 标准档（默认）` / `10 次 · 宽松档`）时，下一条用户消息后由 `PreInvocation` 注入一次 `<responsive-mode>` 提醒。子 Agent 会话与后台任务事件不注入。

### 3. 工具摘要中文短语（`tool-locale`）
以零二进制侵入的方式替代工具 Schema 汉化补丁，要求 `update_steps` 步骤标题（`title`）、`update_focus` 状态说明（`focus`）与 `run_command` 摘要（`toolSummary`）一律使用中文短语（允许保留必要英文术语或命令名，如「检查 Git 状态」「运行 npm test」）。
- **同轮立即纠偏**：当当前用户轮次内刚检测到上述字段出现纯英文短语，下一次模型调用前的 `PreInvocation` 立即注入一次 `<tool-locale>` 提醒（每用户轮次最多一次，不阻断命令、不触碰权限审批，子 Agent 会话不注入）。

## 侧边栏面板（Sidecar UI）

内置 **Antigravity Rail** 侧边栏面板，自动适配宿主暗色/浅色主题：
- 三标签切换「分段写入 / 响应汇报 / 摘要中文」，每个模块提供**模块总开关**、**Hook 开关**与**档位切换**；
- 底部统一展示四项统计计数（超限落盘、写入提醒、响应纠偏、摘要纠偏）及一键清零；
- 点击顶栏版本号可查看完整变更日志，点击「检查更新」可从 GitHub 拉取新版本原地更新并自动重载，同时保留本地 `config/settings.json` 偏好与统计日志。

## 安装

本机需先安装 Node.js >= 20 与 Antigravity。

### Windows (PowerShell)

```powershell
git clone https://github.com/Lynn-zy/antigravity-rail.git
cd antigravity-rail
.\scripts\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/Lynn-zy/antigravity-rail.git
cd antigravity-rail
bash ./scripts/install.sh
```

安装脚本将插件复制到 `~/.gemini/config/plugins/antigravity-rail`，不改动 Antigravity 的 `config.json`。再次运行脚本升级时，自动清理旧 `.mjs` 残留、保留 `config/settings.json` 中的用户偏好，并同步重渲染 `rules/AGENTS.md`。

### 卸载

```powershell
# Windows
.\scripts\install.ps1 -Uninstall
```

```bash
# macOS / Linux
bash ./scripts/install.sh --uninstall
```

## 目录结构

```text
.
├── plugin.json                     # Antigravity 插件清单
├── hooks.json                      # 三个独立 Hook 声明（write-guard / responsive-mode / tool-locale）
├── assets/logo.svg                 # 插件图标
├── rules/AGENTS.md                 # 动态渲染的常驻规则（与面板配置实时同步）
├── scripts/
│   ├── config.mjs                  # 统一三模块配置模型、档位预设与 AGENTS.md 渲染
│   ├── stats.mjs                   # 四项触发事件日志与统计清零
│   ├── transcript.mjs              # 公共会话记录窗口读取与 Hook CLI 兜底入口
│   ├── write-guard-core.mjs        # 分段写入落盘检测与事后提醒逻辑
│   ├── write-guard-hook.mjs        # write-guard Hook 入口
│   ├── responsive-core.mjs         # 先回话与途中汇报轮间犯规检测
│   ├── responsive-hook.mjs         # responsive-mode Hook 入口
│   ├── tool-locale-core.mjs        # 工具摘要中文短语同轮立即检测
│   ├── tool-locale-hook.mjs        # tool-locale Hook 入口
│   ├── install.ps1                 # Windows 安装与卸载脚本
│   ├── install.sh                  # macOS / Linux 安装与卸载脚本
│   └── *.test.mjs                  # 全套单元测试
└── sidecars/panel/
    ├── sidecar.json                # 侧边栏 Sidecar 面板声明
    ├── main.mjs                    # Sidecar HTTP 服务入口
    ├── panel-logic.mjs             # 面板状态查询、统一配置更新与统计清零
    ├── updater.mjs                 # 零依赖 GitHub 更新检测、校验与安全替换
    └── index.html                  # 三标签侧边栏面板页面（自适应宿主主题）
```

## 本地测试

```bash
npm test
```

## License

[MIT](./LICENSE)
