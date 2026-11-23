#!/usr/bin/env bash
set -euo pipefail

# 将 Chunked Write Guard 插件安装或同步到本机 Antigravity 全局插件目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/chunked-write-guard"
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
    echo "[chunked-write-guard] 已卸载：${TARGET_DIR}"
  else
    echo "[chunked-write-guard] 未找到安装目录，无需卸载：${TARGET_DIR}"
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

FILES=(
  "plugin.json"
  "hooks.json"
  "assets/logo.svg"
  "rules/AGENTS.md"
  "scripts/presets.mjs"
  "scripts/hook-core.mjs"
  "scripts/write-guard-hook.mjs"
  "scripts/hook-core.test.mjs"
  "sidecars/panel/sidecar.json"
  "sidecars/panel/main.mjs"
  "sidecars/panel/panel-logic.mjs"
  "sidecars/panel/index.html"
)

for rel in "${FILES[@]}"; do
  cp -f "${REPO_ROOT}/${rel}" "${TARGET_DIR}/${rel}"
done

# 按当前持久化档位（若首次安装则初始化默认 500 档）同步生成 AGENTS.md
ACTIVE_LABEL="$(cd "${TARGET_DIR}" && node -e "import('./scripts/presets.mjs').then((m) => { const cur = m.readActivePresetState(); const applied = m.applyPreset(cur.presetId); console.log(applied.config.label); })")"
echo "[chunked-write-guard] 安装/更新完成：${TARGET_DIR}"
echo "[chunked-write-guard] 当前生效档位：${ACTIVE_LABEL}"
