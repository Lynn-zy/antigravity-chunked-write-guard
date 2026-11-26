<#
.SYNOPSIS
    将 Antigravity Rail 插件安装或同步到本机 Antigravity 全局插件目录。
.PARAMETER TargetDir
    自定义目标安装目录，默认为 ~/.gemini/config/plugins/antigravity-rail。
.PARAMETER Uninstall
    卸载目标目录中的已安装插件。
#>
param(
    [string]$TargetDir = (Join-Path $HOME ".gemini\config\plugins\antigravity-rail"),
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Uninstall) {
    if (Test-Path $TargetDir) {
        Remove-Item -Path $TargetDir -Recurse -Force
        Write-Host "[antigravity-rail] 已卸载：$TargetDir" -ForegroundColor Green
    } else {
        Write-Host "[antigravity-rail] 未找到安装目录，无需卸载：$TargetDir" -ForegroundColor Yellow
    }
    exit 0
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RequiredNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $RequiredNode) {
    throw "未检测到 Node.js，请先安装 Node.js >= 20 后重试。"
}

# 创建所需子目录（不覆盖已有的 config/settings.json 以保留用户偏好）
$SubDirs = @("assets", "rules", "scripts", "sidecars\panel")
foreach ($Sub in $SubDirs) {
    New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir $Sub) | Out-Null
}

# 清理旧版本遗留的脚本文件，确保安装目录与白名单一致
Get-ChildItem -Path (Join-Path $TargetDir "scripts") -Filter "*.mjs" -File -ErrorAction SilentlyContinue | Remove-Item -Force

$FilesToCopy = @(
    "plugin.json",
    "hooks.json",
    "CHANGELOG.md",
    "assets\logo.svg",
    "rules\AGENTS.md",
    "scripts\config.mjs",
    "scripts\stats.mjs",
    "scripts\transcript.mjs",
    "scripts\write-guard-core.mjs",
    "scripts\write-guard-hook.mjs",
    "scripts\responsive-core.mjs",
    "scripts\responsive-hook.mjs",
    "scripts\tool-locale-core.mjs",
    "scripts\tool-locale-hook.mjs",
    "sidecars\panel\sidecar.json",
    "sidecars\panel\main.mjs",
    "sidecars\panel\panel-logic.mjs",
    "sidecars\panel\updater.mjs",
    "sidecars\panel\index.html"
)

foreach ($RelPath in $FilesToCopy) {
    Copy-Item -Path (Join-Path $RepoRoot $RelPath) -Destination (Join-Path $TargetDir $RelPath) -Force
}

# 按当前持久化配置（首次安装时按默认三模块配置）同步生成 AGENTS.md
Push-Location $TargetDir
try {
    $Summary = node -e "import('./scripts/config.mjs').then((m) => { const s = m.syncRulesFromSettings(); const n = [s.writeGuard.enabled, s.responsive.enabled, s.toolLocale.enabled].filter(Boolean).length; console.log(n + '/3 模块已启用（写入 ' + s.writeGuard.presetId + ' 行档 / 静默 ' + s.responsive.silentThreshold + ' 次档）'); })"
    Write-Host "[antigravity-rail] 安装/更新完成：$TargetDir" -ForegroundColor Green
    Write-Host "[antigravity-rail] 当前状态：$Summary" -ForegroundColor Cyan
} finally {
    Pop-Location
}
