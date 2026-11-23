<#
.SYNOPSIS
    将 Chunked Write Guard 插件安装或同步到本机 Antigravity 全局插件目录。
.PARAMETER TargetDir
    自定义目标安装目录，默认为 ~/.gemini/config/plugins/chunked-write-guard。
.PARAMETER Uninstall
    卸载目标目录中的已安装插件。
#>
param(
    [string]$TargetDir = (Join-Path $HOME ".gemini\config\plugins\chunked-write-guard"),
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Uninstall) {
    if (Test-Path $TargetDir) {
        Remove-Item -Path $TargetDir -Recurse -Force
        Write-Host "[chunked-write-guard] 已卸载：$TargetDir" -ForegroundColor Green
    } else {
        Write-Host "[chunked-write-guard] 未找到安装目录，无需卸载：$TargetDir" -ForegroundColor Yellow
    }
    exit 0
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RequiredNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $RequiredNode) {
    throw "未检测到 Node.js，请先安装 Node.js >= 20 后重试。"
}

# 创建所需子目录（不覆盖已有的 config/active-preset.json 以保留用户档位偏好）
$SubDirs = @("assets", "rules", "scripts", "sidecars\panel")
foreach ($Sub in $SubDirs) {
    New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir $Sub) | Out-Null
}

$FilesToCopy = @(
    "plugin.json",
    "hooks.json",
    "assets\logo.svg",
    "rules\AGENTS.md",
    "scripts\presets.mjs",
    "scripts\stats.mjs",
    "scripts\hook-core.mjs",
    "scripts\write-guard-hook.mjs",
    "scripts\hook-core.test.mjs",
    "sidecars\panel\sidecar.json",
    "sidecars\panel\main.mjs",
    "sidecars\panel\panel-logic.mjs",
    "sidecars\panel\index.html"
)

foreach ($RelPath in $FilesToCopy) {
    Copy-Item -Path (Join-Path $RepoRoot $RelPath) -Destination (Join-Path $TargetDir $RelPath) -Force
}

# 按当前持久化档位（若首次安装则初始化默认 500 档）同步生成 AGENTS.md
Push-Location $TargetDir
try {
    $Result = node -e "import('./scripts/presets.mjs').then((m) => { const cur = m.readActivePresetState(); const applied = m.applyPreset(cur.presetId); console.log(applied.config.label); })"
    Write-Host "[chunked-write-guard] 安装/更新完成：$TargetDir" -ForegroundColor Green
    Write-Host "[chunked-write-guard] 当前生效档位：$Result" -ForegroundColor Cyan
} finally {
    Pop-Location
}
