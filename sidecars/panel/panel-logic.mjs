import {
  DEFAULT_CONFIG_PATH,
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
 * 构建侧边栏面板所需的状态快照。
 * @param {{ configPath?: string }} [options] - 可选配置文件路径覆盖
 * @returns {Record<string, unknown>} 面板展示状态 JSON
 */
export const buildPanelState = (options = {}) => {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const active = readActivePresetState({ configPath });

  return {
    presetId: active.presetId,
    updatedAt: active.updatedAt,
    active: formatPresetSummary(active.config),
    presets: PRESET_ORDER.map((id) => formatPresetSummary(PRESETS[id])),
  };
};

/**
 * 校验面板提交的档位切换请求，档位有变化时同步更新配置与规则文件。
 * @param {Record<string, unknown>} body - 客户端提交的 JSON 对象
 * @param {{ configPath?: string, rulesPath?: string }} [options] - 可选路径覆盖
 * @returns {{ ok: true, changed: boolean, state: Record<string, unknown> } | { ok: false, status: number, error: string }} 执行结果
 */
export const handleSetPreset = (body, options = {}) => {
  const presetId = String(body?.presetId ?? '').trim();
  if (!(presetId in PRESETS)) {
    return {
      ok: false,
      status: 400,
      error: `无效档位 "${presetId}"，仅支持 ${PRESET_ORDER.join(' / ')}`,
    };
  }

  const current = readActivePresetState({ configPath: options.configPath });
  // 目标档位已持久化生效时跳过写盘，避免触发无意义的规则文件重载
  if (current.presetId === presetId && current.updatedAt !== null) {
    return {
      ok: true,
      changed: false,
      state: buildPanelState(options),
    };
  }

  applyPreset(presetId, options);
  return {
    ok: true,
    changed: true,
    state: buildPanelState(options),
  };
};
