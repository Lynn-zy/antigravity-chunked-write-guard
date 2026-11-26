#!/usr/bin/env bash
set -euo pipefail

# 将 Antigravity Rail 插件安装或同步到本机 Antigravity 全局插件目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/antigravity-rail"
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --target)
      TARGET_DIR="$2"
      shift 2
      ;;
    *)
      echo "未知参数: $1" >&2
      echo "用法: $0 [--target <dir>] [--uninstall]" >&2
      exit 1
      ;;
  esac
done

if [[ "${UNINSTALL}" -eq 1 ]]; then
  if [[ -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "[antigravity-rail] 已卸载：${TARGET_DIR}"
  else
    echo "[antigravity-rail] 未找到安装目录，无需卸载：${TARGET_DIR}"
  fi
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js >= 20 后重试。" >&2
  exit 1
fi

mkdir -p \
  "${TARGET_DIR}/assets" \
  "${TARGET_DIR}/rules" \
  "${TARGET_DIR}/scripts" \
  "${TARGET_DIR}/sidecars/panel"

# 清理旧版本遗留的脚本文件，确保安装目录与白名单一致
rm -f "${TARGET_DIR}/scripts/"*.mjs

FILES=(
  "plugin.json"
  "hooks.json"
  "CHANGELOG.md"
  "assets/logo.svg"
  "rules/AGENTS.md"
  "scripts/config.mjs"
  "scripts/stats.mjs"
  "scripts/transcript.mjs"
  "scripts/write-guard-core.mjs"
  "scripts/write-guard-hook.mjs"
  "scripts/responsive-core.mjs"
  "scripts/responsive-hook.mjs"
  "scripts/tool-locale-core.mjs"
  "scripts/tool-locale-hook.mjs"
  "sidecars/panel/sidecar.json"
  "sidecars/panel/main.mjs"
  "sidecars/panel/panel-logic.mjs"
  "sidecars/panel/updater.mjs"
  "sidecars/panel/index.html"
)

for rel in "${FILES[@]}"; do
  cp -f "${REPO_ROOT}/${rel}" "${TARGET_DIR}/${rel}"
done

# 按当前持久化配置（首次安装时按默认三模块配置）同步生成 AGENTS.md
SUMMARY="$(cd "${TARGET_DIR}" && node -e "import('./scripts/config.mjs').then((m) => { const s = m.syncRulesFromSettings(); const n = [s.writeGuard.enabled, s.responsive.enabled, s.toolLocale.enabled].filter(Boolean).length; console.log(n + '/3 模块已启用（写入 ' + s.writeGuard.presetId + ' 行档 / 静默 ' + s.responsive.silentThreshold + ' 次档）'); })")"
echo "[antigravity-rail] 安装/更新完成：${TARGET_DIR}"
echo "[antigravity-rail] 当前状态：${SUMMARY}"
