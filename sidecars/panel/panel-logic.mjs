import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_RULES_PATH,
  PRESETS,
  PRESET_ORDER,
  applyPreset,
  readActivePresetState,
} from '../../scripts/presets.mjs';

const formatPresetSummary = (preset) => ({
  id: preset.id,
  label: preset.label,
  summary: preset.summary,
  softTargetLines: preset.softTargetLines,
  recoveryTargetLines: preset.recoveryTargetLines,
  maxWriteLines: preset.maxWriteLines,
  maxWriteKb: Math.round(preset.maxWriteBytes / 1024),
  maxEditCombinedLines: preset.maxEditCombinedLines,
  maxEditCombinedKb: Math.round(preset.maxEditCombinedBytes / 1024),
});

/**
 * 构建侧边栏面板所需的完整状态快照。
 * @param {{ configPath?: string, rulesPath?: string }} [options] - 可选路径覆盖
 * @returns {Record<string, unknown>} 面板展示状态 JSON
 */
export const buildPanelState = (options = {}) => {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const rulesPath = options.rulesPath ?? DEFAULT_RULES_PATH;
  const active = readActivePresetState({ configPath });

  return {
    presetId: active.presetId,
    updatedAt: active.updatedAt,
    active: formatPresetSummary(active.config),
    presets: PRESET_ORDER.map((id) => formatPresetSummary(PRESETS[id])),
    configPath,
    rulesPath,
  };
};

/**
 * 处理面板提交的档位切换请求，进行边界校验并同步更新配置与规则文件。
 * @param {Record<string, unknown>} body - 客户端提交的 JSON 对象
 * @param {{ configPath?: string, rulesPath?: string }} [options] - 可选路径覆盖
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, status: number, error: string }} 执行结果
 */
export const handleSetPreset = (body, options = {}) => {
  const presetId = String(body?.presetId ?? '').trim();
  if (!(presetId in PRESETS)) {
    return {
      ok: false,
      status: 400,
      error: `无效的档位 "${presetId}"，仅支持：${PRESET_ORDER.join(' / ')}`,
    };
  }

  applyPreset(presetId, options);
  return {
    ok: true,
    state: buildPanelState(options),
  };
};
