import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG_PATH,
  PRESETS,
  PRESET_ORDER,
  applyPreset,
  readActivePresetState,
  setRecoveryEnabled,
} from '../../scripts/presets.mjs';
import {
  readTriggerStats,
  resetTriggerStats,
} from '../../scripts/stats.mjs';

const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(PANEL_DIR, '..', '..');
const DEFAULT_MANIFEST_PATH = path.join(PLUGIN_ROOT, 'plugin.json');
const DEFAULT_CHANGELOG_PATH = path.join(PLUGIN_ROOT, 'CHANGELOG.md');

const readPluginVersion = (manifestPath = DEFAULT_MANIFEST_PATH) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return typeof parsed?.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

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
 * 构建侧边栏面板所需的状态、版本号、断流恢复开关与触发统计快照。
 * @param {{ configPath?: string, eventsPath?: string, manifestPath?: string }} [options] - 可选路径覆盖
 * @returns {Record<string, unknown>} 面板展示状态 JSON
 */
export const buildPanelState = (options = {}) => {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const active = readActivePresetState({ configPath });

  return {
    version: readPluginVersion(options.manifestPath),
    presetId: active.presetId,
    recoveryEnabled: active.recoveryEnabled,
    updatedAt: active.updatedAt,
    active: formatPresetSummary(active.config),
    presets: PRESET_ORDER.map((id) => formatPresetSummary(PRESETS[id])),
    stats: readTriggerStats({ eventsPath: options.eventsPath }),
  };
};

/**
 * 校验面板提交的档位切换请求，档位有变化时同步更新配置与规则文件。
 * @param {Record<string, unknown>} body - 客户端提交的 JSON 对象
 * @param {{ configPath?: string, rulesPath?: string, eventsPath?: string, manifestPath?: string }} [options] - 可选路径覆盖
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

/**
 * 校验面板提交的断流恢复开关请求，状态变化时持久化配置并同步规则文件。
 * @param {Record<string, unknown>} body - 客户端提交的 JSON 对象
 * @param {{ configPath?: string, rulesPath?: string, eventsPath?: string, manifestPath?: string }} [options] - 可选路径覆盖
 * @returns {{ ok: true, changed: boolean, state: Record<string, unknown> } | { ok: false, status: number, error: string }} 执行结果
 */
export const handleSetRecovery = (body, options = {}) => {
  if (typeof body?.enabled !== 'boolean') {
    return {
      ok: false,
      status: 400,
      error: '参数 enabled 必须是布尔值',
    };
  }

  const current = readActivePresetState({ configPath: options.configPath });
  if (current.recoveryEnabled === body.enabled && current.updatedAt !== null) {
    return {
      ok: true,
      changed: false,
      state: buildPanelState(options),
    };
  }

  setRecoveryEnabled(body.enabled, options);
  return {
    ok: true,
    changed: true,
    state: buildPanelState(options),
  };
};

/**
 * 清零触发统计日志并返回最新面板状态。
 * @param {{ configPath?: string, eventsPath?: string }} [options] - 可选路径覆盖
 * @returns {{ ok: true, changed: boolean, state: Record<string, unknown> }} 执行结果
 */
export const handleResetStats = (options = {}) => {
  const current = readTriggerStats({ eventsPath: options.eventsPath });
  if (current.denyCount === 0 && current.recoveryCount === 0 && current.lastTriggeredAt === null) {
    return {
      ok: true,
      changed: false,
      state: buildPanelState(options),
    };
  }

  resetTriggerStats({ eventsPath: options.eventsPath });
  return {
    ok: true,
    changed: true,
    state: buildPanelState(options),
  };
};

/**
 * 读取插件根目录的 CHANGELOG.md 内容与当前版本号，文件缺失时返回空内容。
 * @param {{ changelogPath?: string, manifestPath?: string }} [options] - 可选路径覆盖
 * @returns {{ version: string, markdown: string }} 版本号与原始 Markdown 变更日志
 */
export const readChangelog = (options = {}) => {
  const changelogPath = options.changelogPath ?? DEFAULT_CHANGELOG_PATH;
  let markdown = '';
  try {
    markdown = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n').trim();
  } catch {
    markdown = '';
  }
  return {
    version: readPluginVersion(options.manifestPath),
    markdown,
  };
};
