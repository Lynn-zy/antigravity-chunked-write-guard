import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG_PATH,
  RESPONSIVE_PRESETS,
  RESPONSIVE_PRESET_ORDER,
  WRITE_PRESETS,
  WRITE_PRESET_ORDER,
  readSettings,
  updateSettings,
} from '../../scripts/config.mjs';
import {
  readTriggerStats,
  resetTriggerStats,
} from '../../scripts/stats.mjs';

const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(PANEL_DIR, '..', '..');
const DEFAULT_MANIFEST_PATH = path.join(PLUGIN_ROOT, 'plugin.json');
const DEFAULT_CHANGELOG_PATH = path.join(PLUGIN_ROOT, 'CHANGELOG.md');

const ALLOWED_MODULE_KEYS = new Set(['writeGuard', 'responsive', 'toolLocale']);

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

const formatWritePresetSummary = (preset) => ({
  id: preset.id,
  label: preset.label,
  summary: preset.summary,
  softTargetLines: preset.softTargetLines,
  warnWriteLines: preset.warnWriteLines,
  warnWriteKb: Math.round(preset.warnWriteBytes / 1024),
  warnEditCombinedLines: preset.warnEditCombinedLines,
  warnEditCombinedKb: Math.round(preset.warnEditCombinedBytes / 1024),
});

const formatResponsivePresetSummary = (preset) => ({
  threshold: preset.threshold,
  label: preset.label,
  summary: preset.summary,
});

/**
 * 构建侧边栏面板所需的完整状态快照（版本号、三模块配置与档位列表、累计触发统计）。
 * @param {{ configPath?: string, eventsPath?: string, manifestPath?: string }} [options] - 可选路径覆盖
 * @returns {Record<string, unknown>} 面板展示状态 JSON
 */
export const buildPanelState = (options = {}) => {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const { updatedAt, ...moduleSettings } = readSettings({ configPath });
  const activeWritePreset = WRITE_PRESETS[moduleSettings.writeGuard.presetId];
  const activeResponsivePreset = RESPONSIVE_PRESETS[moduleSettings.responsive.silentThreshold];

  return {
    version: readPluginVersion(options.manifestPath),
    updatedAt,
    settings: moduleSettings,
    activeWritePreset: formatWritePresetSummary(activeWritePreset),
    activeResponsivePreset: formatResponsivePresetSummary(activeResponsivePreset),
    writePresets: WRITE_PRESET_ORDER.map((id) => formatWritePresetSummary(WRITE_PRESETS[id])),
    responsivePresets: RESPONSIVE_PRESET_ORDER.map((t) =>
      formatResponsivePresetSummary(RESPONSIVE_PRESETS[t]),
    ),
    stats: readTriggerStats({ eventsPath: options.eventsPath }),
  };
};

/**
 * 校验并应用面板提交的模块配置变更（模块总开关、Hook 开关或档位），有变化时落盘并重写 AGENTS.md。
 * @param {unknown} body - 客户端提交的 JSON 对象
 * @param {{ configPath?: string, rulesPath?: string, eventsPath?: string, manifestPath?: string }} [options] - 可选路径覆盖
 * @returns {{ ok: true, changed: boolean, state: Record<string, unknown> } | { ok: false, status: number, error: string }} 执行结果
 */
export const handleUpdateSettings = (body, options = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object' };
  }

  const keys = Object.keys(body);
  if (keys.length === 0) {
    return { ok: false, status: 400, error: 'Specify at least one module field to update' };
  }
  for (const key of keys) {
    if (!ALLOWED_MODULE_KEYS.has(key)) {
      return { ok: false, status: 400, error: `Unsupported settings module: "${key}"` };
    }
  }

  try {
    const { changed } = updateSettings(body, options);
    return {
      ok: true,
      changed,
      state: buildPanelState(options),
    };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err?.message ?? 'Invalid settings payload',
    };
  }
};

/**
 * 清零触发统计日志并返回最新面板状态。
 * @param {{ configPath?: string, eventsPath?: string, manifestPath?: string }} [options] - 可选路径覆盖
 * @returns {{ ok: true, changed: boolean, state: Record<string, unknown> }} 执行结果
 */
export const handleResetStats = (options = {}) => {
  const current = readTriggerStats({ eventsPath: options.eventsPath });
  if (
    current.writeOversizeCount === 0 &&
    current.writeReminderCount === 0 &&
    current.responsiveReminderCount === 0 &&
    current.toolLocaleReminderCount === 0 &&
    current.recentEvents.length === 0
  ) {
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
