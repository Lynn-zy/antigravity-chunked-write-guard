import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const DEFAULT_CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'active-preset.json');
export const DEFAULT_RULES_PATH = path.join(PLUGIN_ROOT, 'rules', 'AGENTS.md');
export const DEFAULT_PENDING_DIR = path.join(PLUGIN_ROOT, 'config', 'pending');

const SHARED_LIMITS = Object.freeze({
  reminderMarker: '[chunked-write-guard:oversize-reminder]',
  pendingReminderTtlMs: 30 * 60 * 1000,
});

/**
 * 三档阈值预设（Hook 超限检测与 AGENTS.md 常驻规则均由此派生）。
 */
export const PRESETS = Object.freeze({
  '300': Object.freeze({
    id: '300',
    label: '300 行 · 稳妥档',
    summary: '网络波动大或上下文较长时使用，减小单次写入行数',
    softTargetLines: 300,
    warnWriteLines: 500,
    warnWriteBytes: 28 * 1024,
    warnEditCombinedLines: 600,
    warnEditCombinedBytes: 36 * 1024,
  }),
  '500': Object.freeze({
    id: '500',
    label: '500 行 · 标准档',
    summary: '日常默认，常规源码文件可一次写完，超限时事后提醒',
    softTargetLines: 500,
    warnWriteLines: 800,
    warnWriteBytes: 48 * 1024,
    warnEditCombinedLines: 900,
    warnEditCombinedBytes: 56 * 1024,
  }),
  '700': Object.freeze({
    id: '700',
    label: '700 行 · 宽松档',
    summary: '网络稳定且常写较长单文件时使用，放宽单次行数目标',
    softTargetLines: 700,
    warnWriteLines: 1100,
    warnWriteBytes: 64 * 1024,
    warnEditCombinedLines: 1200,
    warnEditCombinedBytes: 72 * 1024,
  }),
});

export const PRESET_ORDER = Object.freeze(['700', '500', '300']);
export const DEFAULT_PRESET_ID = '500';
const DEFAULT_REMINDER_ENABLED = true;

/**
 * 根据档位 ID 获取完整的运行时阈值配置。
 * @param {string} [presetId] - 档位标识（'300' | '500' | '700'）
 * @param {{ reminderEnabled?: boolean }} [options] - 可选事后提醒开关覆盖
 * @returns {Record<string, unknown>} 合并公共常量后的配置对象
 */
export const getPresetConfig = (presetId = DEFAULT_PRESET_ID, options = {}) => {
  const key = String(presetId ?? DEFAULT_PRESET_ID);
  const preset = PRESETS[key] ?? PRESETS[DEFAULT_PRESET_ID];
  const reminderEnabled =
    typeof options.reminderEnabled === 'boolean'
      ? options.reminderEnabled
      : DEFAULT_REMINDER_ENABLED;
  return {
    ...SHARED_LIMITS,
    ...preset,
    reminderEnabled,
  };
};

/**
 * 读取当前持久化的生效档位与超限事后提醒开关状态；文件缺失或损坏时回退至默认值。
 * @param {{ configPath?: string }} [options] - 可选配置文件路径覆盖
 * @returns {{ presetId: string, reminderEnabled: boolean, updatedAt: string | null, config: Record<string, unknown> }} 当前档位状态与完整配置
 */
export const readActivePresetState = (options = {}) => {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const rawId = String(parsed?.presetId ?? '');
    if (rawId in PRESETS) {
      const reminderEnabled =
        typeof parsed.reminderEnabled === 'boolean'
          ? parsed.reminderEnabled
          : DEFAULT_REMINDER_ENABLED;
      return {
        presetId: rawId,
        reminderEnabled,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        config: getPresetConfig(rawId, { reminderEnabled }),
      };
    }
  } catch {
    // 配置文件尚未生成或内容损坏时使用默认档位
  }
  return {
    presetId: DEFAULT_PRESET_ID,
    reminderEnabled: DEFAULT_REMINDER_ENABLED,
    updatedAt: null,
    config: getPresetConfig(DEFAULT_PRESET_ID),
  };
};

/**
 * 从档位配置渲染常驻规则文件（rules/AGENTS.md），保证规则与 Hook 警戒阈值一致。
 * @param {Record<string, unknown>} preset - 档位配置对象
 * @returns {string} 渲染后的 Markdown 文本
 */
export const renderAgentsRule = (preset) => {
  const writeKb = Math.round(preset.warnWriteBytes / 1024);
  const combinedKb = Math.round(preset.warnEditCombinedBytes / 1024);
  const reminderEnabled = preset.reminderEnabled !== false;
  const headerComment = reminderEnabled
    ? `<!-- 当前档位：${preset.label}（可在 Write Guard 侧边栏面板切换 700 / 500 / 300 档） -->`
    : `<!-- 当前档位：${preset.label}｜超限事后提醒：已关闭（可在 Write Guard 侧边栏面板调整） -->`;

  const lines = [
    '# 分段写入规范（Chunked Write Guard）',
    '',
    headerComment,
    '',
    '为避免单次输出过长拖慢流式响应并让长文件改动尽早落盘，写入或修改文件时遵守以下限制：',
    '',
    `1. **单次写入目标 ≤ ${preset.softTargetLines} 行**：每次 \`write_file\`（含 \`Append: true\`）或 \`edit_file\` 的新内容控制在 ${preset.softTargetLines} 行以内。`,
    `2. **长文件分步写入**：预计超过 ${preset.softTargetLines} 行的文件（如单页 HTML 原型、大型组件、长文档或脚本），拆成多步完成。`,
    `   - 第 1 步用 \`write_file\` 写入骨架与核心结构（≤ ${preset.softTargetLines} 行）。`,
    '   - 后续按模块分次调用 `write_file(Append: true)` 或 `edit_file` 补齐，让每段改动尽快落盘。',
  ];

  if (reminderEnabled) {
    lines.push(
      `3. **超限检测与事后提醒**：单次写入超过 **${preset.warnWriteLines} 行**或 **${writeKb} KB**（\`edit_file\` 合计超过 ${preset.warnEditCombinedLines} 行或 ${combinedKb} KB）时不会阻断落盘，但下一轮会提醒你回到 ≤ ${preset.softTargetLines} 行的分段写入。`,
    );
  }
  lines.push('');
  return lines.join('\n');
};

const writeFileAtomic = (targetPath, content) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
};

/**
 * 切换并持久化当前档位（可选覆盖事后提醒开关），同时同步更新 rules/AGENTS.md。
 * @param {string} presetId - 目标档位标识（'300' | '500' | '700'）
 * @param {{ configPath?: string, rulesPath?: string, reminderEnabled?: boolean }} [options] - 可选路径与开关覆盖
 * @returns {{ presetId: string, reminderEnabled: boolean, updatedAt: string, config: Record<string, unknown> }} 更新后的状态
 */
export const applyPreset = (presetId, options = {}) => {
  const key = String(presetId ?? '');
  if (!(key in PRESETS)) {
    throw new Error(`Unsupported presetId "${key}". Expected one of: ${PRESET_ORDER.join(', ')}`);
  }

  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const rulesPath = options.rulesPath ?? DEFAULT_RULES_PATH;
  const reminderEnabled =
    typeof options.reminderEnabled === 'boolean'
      ? options.reminderEnabled
      : readActivePresetState({ configPath }).reminderEnabled;
  const updatedAt = new Date().toISOString();
  const config = getPresetConfig(key, { reminderEnabled });

  writeFileAtomic(
    configPath,
    `${JSON.stringify({ presetId: key, reminderEnabled, updatedAt }, null, 2)}\n`,
  );
  writeFileAtomic(rulesPath, renderAgentsRule(config));

  return {
    presetId: key,
    reminderEnabled,
    updatedAt,
    config,
  };
};

/**
 * 切换并持久化超限事后提醒开关，保留当前档位并同步更新 rules/AGENTS.md。
 * @param {boolean} enabled - 是否在超限写入落盘后于下一轮注入提醒
 * @param {{ configPath?: string, rulesPath?: string }} [options] - 可选路径覆盖
 * @returns {{ presetId: string, reminderEnabled: boolean, updatedAt: string, config: Record<string, unknown> }} 更新后的状态
 */
export const setReminderEnabled = (enabled, options = {}) => {
  if (typeof enabled !== 'boolean') {
    throw new Error('reminderEnabled must be a boolean');
  }
  const current = readActivePresetState({ configPath: options.configPath });
  return applyPreset(current.presetId, { ...options, reminderEnabled: enabled });
};
