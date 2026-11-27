import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const DEFAULT_CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'settings.json');
export const DEFAULT_RULES_PATH = path.join(PLUGIN_ROOT, 'rules', 'AGENTS.md');
export const DEFAULT_PENDING_DIR = path.join(PLUGIN_ROOT, 'config', 'pending');

const SHARED_WRITE_LIMITS = Object.freeze({
  reminderMarker: '[antigravity-rail:oversize-reminder]',
  pendingReminderTtlMs: 30 * 60 * 1000,
});

/**
 * 分段写入三档阈值预设（Hook 超限检测与 AGENTS.md 常驻规则均由此派生）。
 */
export const WRITE_PRESETS = Object.freeze({
  '300': Object.freeze({
    id: '300',
    label: '300 lines · Conservative',
    summary: 'Smaller writes per step for unstable networks or long contexts',
    softTargetLines: 300,
    warnWriteLines: 500,
    warnWriteBytes: 28 * 1024,
    warnEditCombinedLines: 600,
    warnEditCombinedBytes: 36 * 1024,
  }),
  '500': Object.freeze({
    id: '500',
    label: '500 lines · Standard',
    summary: 'Balanced default for typical source files with post-write reminders',
    softTargetLines: 500,
    warnWriteLines: 800,
    warnWriteBytes: 48 * 1024,
    warnEditCombinedLines: 900,
    warnEditCombinedBytes: 56 * 1024,
  }),
  '700': Object.freeze({
    id: '700',
    label: '700 lines · Relaxed',
    summary: 'Higher per-write target for stable networks and longer single files',
    softTargetLines: 700,
    warnWriteLines: 1100,
    warnWriteBytes: 64 * 1024,
    warnEditCombinedLines: 1200,
    warnEditCombinedBytes: 72 * 1024,
  }),
});

export const WRITE_PRESET_ORDER = Object.freeze(['700', '500', '300']);
export const DEFAULT_WRITE_PRESET_ID = '500';

/**
 * 响应汇报中途静默阈值三档预设。
 */
export const RESPONSIVE_PRESETS = Object.freeze({
  4: Object.freeze({
    threshold: 4,
    label: '4 calls · Sensitive',
    summary: 'Triggers after 4 consecutive silent tool calls to restore visibility faster',
  }),
  6: Object.freeze({
    threshold: 6,
    label: '6 calls · Standard',
    summary: 'Balanced default allowing brief read/search bursts before reminding',
  }),
  10: Object.freeze({
    threshold: 10,
    label: '10 calls · Relaxed',
    summary: 'Suited for deep investigations or large refactors with fewer interruptions',
  }),
});

export const RESPONSIVE_PRESET_ORDER = Object.freeze([4, 6, 10]);
export const DEFAULT_RESPONSIVE_THRESHOLD = 6;

export const DEFAULT_SETTINGS = Object.freeze({
  writeGuard: Object.freeze({
    enabled: true,
    presetId: DEFAULT_WRITE_PRESET_ID,
    hookEnabled: true,
  }),
  responsive: Object.freeze({
    enabled: true,
    silentThreshold: DEFAULT_RESPONSIVE_THRESHOLD,
    hookEnabled: true,
  }),
  toolLocale: Object.freeze({
    enabled: true,
    hookEnabled: true,
  }),
  updatedAt: null,
});

const cloneDefaultSettings = () => ({
  writeGuard: { ...DEFAULT_SETTINGS.writeGuard },
  responsive: { ...DEFAULT_SETTINGS.responsive },
  toolLocale: { ...DEFAULT_SETTINGS.toolLocale },
  updatedAt: null,
});

const resolveConfigPath = (options) =>
  options?.configPath || process.env.ANTIGRAVITY_RAIL_CONFIG_PATH || DEFAULT_CONFIG_PATH;

const normalizeSettings = (raw) => {
  const base = cloneDefaultSettings();
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const wg = raw.writeGuard;
  if (wg && typeof wg === 'object') {
    if (typeof wg.enabled === 'boolean') base.writeGuard.enabled = wg.enabled;
    const presetKey = String(wg.presetId ?? '');
    if (presetKey in WRITE_PRESETS) base.writeGuard.presetId = presetKey;
    if (typeof wg.hookEnabled === 'boolean') base.writeGuard.hookEnabled = wg.hookEnabled;
  }

  const resp = raw.responsive;
  if (resp && typeof resp === 'object') {
    if (typeof resp.enabled === 'boolean') base.responsive.enabled = resp.enabled;
    const threshold = Number(resp.silentThreshold);
    if (threshold in RESPONSIVE_PRESETS) base.responsive.silentThreshold = threshold;
    if (typeof resp.hookEnabled === 'boolean') base.responsive.hookEnabled = resp.hookEnabled;
  }

  const locale = raw.toolLocale;
  if (locale && typeof locale === 'object') {
    if (typeof locale.enabled === 'boolean') base.toolLocale.enabled = locale.enabled;
    if (typeof locale.hookEnabled === 'boolean') base.toolLocale.hookEnabled = locale.hookEnabled;
  }

  if (typeof raw.updatedAt === 'string' && raw.updatedAt) {
    base.updatedAt = raw.updatedAt;
  }
  return base;
};

/**
 * 根据分段写入档位 ID 与开关获取运行时完整阈值配置。
 * @param {string} [presetId] - 档位标识（'300' | '500' | '700'）
 * @param {{ enabled?: boolean, hookEnabled?: boolean }} [options] - 可选开关覆盖
 * @returns {Record<string, unknown>} 合并公共常量后的分段写入运行时配置
 */
export const getWriteGuardConfig = (presetId = DEFAULT_WRITE_PRESET_ID, options = {}) => {
  const key = String(presetId ?? DEFAULT_WRITE_PRESET_ID);
  const preset = WRITE_PRESETS[key] ?? WRITE_PRESETS[DEFAULT_WRITE_PRESET_ID];
  return {
    ...SHARED_WRITE_LIMITS,
    ...preset,
    enabled: typeof options.enabled === 'boolean' ? options.enabled : true,
    hookEnabled: typeof options.hookEnabled === 'boolean' ? options.hookEnabled : true,
  };
};

/**
 * 读取当前持久化的统一设置；文件缺失或损坏时回退至默认值。
 * @param {{ configPath?: string }} [options] - 可选配置文件路径覆盖
 * @returns {{ writeGuard: { enabled: boolean, presetId: string, hookEnabled: boolean }, responsive: { enabled: boolean, silentThreshold: number, hookEnabled: boolean }, toolLocale: { enabled: boolean, hookEnabled: boolean }, updatedAt: string | null }} 统一设置对象
 */
export const readSettings = (options = {}) => {
  const configPath = resolveConfigPath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return normalizeSettings(parsed);
  } catch {
    return cloneDefaultSettings();
  }
};

const renderWriteGuardSection = (writeGuard) => {
  const preset = getWriteGuardConfig(writeGuard.presetId, writeGuard);
  const writeKb = Math.round(preset.warnWriteBytes / 1024);
  const combinedKb = Math.round(preset.warnEditCombinedBytes / 1024);
  const lines = [
    '## Chunked Write Guard',
    '',
    'To avoid slow streaming responses and persist large edits incrementally, follow these limits when writing or editing files:',
    '',
    `1. **Target ≤ ${preset.softTargetLines} lines per write**: Keep new content in each \`write_file\` (including \`Append: true\`) or \`edit_file\` call within ${preset.softTargetLines} lines.`,
    `2. **Split large files across steps**: For files expected to exceed ${preset.softTargetLines} lines (e.g., single-file HTML prototypes, large components, long docs, or scripts), write them in chunks:`,
    `   - Step 1: write the skeleton and core structure with \`write_file\` (≤ ${preset.softTargetLines} lines).`,
    '   - Subsequent steps: fill in remaining sections incrementally with `write_file(Append: true)` or targeted `edit_file` calls.',
  ];

  if (writeGuard.hookEnabled) {
    lines.push(
      `3. **Oversize detection & post-write reminder**: Writes exceeding **${preset.warnWriteLines} lines** or **${writeKb} KB** (\`edit_file\` totaling over ${preset.warnEditCombinedLines} lines or ${combinedKb} KB) are never blocked, but the next turn will remind you to return to ≤ ${preset.softTargetLines}-line chunked writes.`,
    );
  }
  return lines.join('\n');
};

const renderResponsiveSection = () =>
  [
    '## Reply First, Report Progress',
    '',
    'The user is watching the live conversation and your #1 priority is to communicate with them quickly. Before you think or call any tool, respond IMMEDIATELY to what the user just said and let them know how you plan to look into it or tackle it. If you need to think first, let the user know and then think. Only then continue with thinking and tool use. Do this at the start of every turn, and again whenever the user sends a new message while you are working: answer them first, then resume.',
    '',
    'Saying what you are about to do before your first tool call is mandatory, and it comes first.',
    '',
    '- For simple questions you can answer directly, go straight to the answer.',
    '- Keep progress visible during multi-step work. Consecutive silent tool calls collapse in the UI, leaving the user in the dark. After finishing a phase, making a key finding, or changing direction, share an update on what you found and what you will do next alongside the next batch of tool calls.',
    '- Whenever you mention a real file in opening replies, mid-task progress updates, or summaries, format it as a clickable Markdown link (`[filename](file:///absolute/path/to/file)`, using forward slashes on Windows) instead of plain inline code.',
    '- End with a clear summary of what you found, what you did, and anything still needed from the user.',
  ].join('\n');

const renderToolLocaleSection = () =>
  [
    '## Match User\'s Language for Tool Summaries',
    '',
    '- Write `update_steps` step titles (`title`), `update_focus` status messages (`focus`), and `run_command` `toolSummary` values in the same language the user is using. Necessary code identifiers, paths, or CLI command names may stay in English (e.g., matching the user\'s language around `npm test` or `git status`).',
  ].join('\n');

/**
 * 根据统一配置渲染常驻规则文件（rules/AGENTS.md）；被关闭的模块章节会被彻底移除。
 * @param {ReturnType<typeof readSettings>} settings - 统一配置对象
 * @returns {string} 渲染后的 Markdown 文本
 */
export const renderAgentsRule = (settings) => {
  const normalized = normalizeSettings(settings);
  const sections = [];
  const summaryParts = [];

  if (normalized.writeGuard.enabled) {
    const preset = WRITE_PRESETS[normalized.writeGuard.presetId];
    summaryParts.push(
      `Write Guard: ${preset.label}${normalized.writeGuard.hookEnabled ? '' : ' (rules only)'}`,
    );
    sections.push(renderWriteGuardSection(normalized.writeGuard));
  }
  if (normalized.responsive.enabled) {
    summaryParts.push(
      `Responsive Mode: ${normalized.responsive.silentThreshold} calls${normalized.responsive.hookEnabled ? '' : ' (rules only)'}`,
    );
    sections.push(renderResponsiveSection());
  }
  if (normalized.toolLocale.enabled) {
    summaryParts.push(`Tool Locale: On${normalized.toolLocale.hookEnabled ? '' : ' (rules only)'}`);
    sections.push(renderToolLocaleSection());
  }

  if (sections.length === 0) {
    return '<!-- Antigravity Rail: all guardrail modules are disabled. Re-enable them in the Antigravity Rail side pane. -->\n';
  }

  return [
    '# Antigravity Rail',
    '',
    `<!-- Active modules: ${summaryParts.join(' | ')} (adjust in the Antigravity Rail side pane) -->`,
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
};

const writeFileAtomic = (targetPath, content) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
};

const settingsEqual = (a, b) =>
  a.writeGuard.enabled === b.writeGuard.enabled &&
  a.writeGuard.presetId === b.writeGuard.presetId &&
  a.writeGuard.hookEnabled === b.writeGuard.hookEnabled &&
  a.responsive.enabled === b.responsive.enabled &&
  a.responsive.silentThreshold === b.responsive.silentThreshold &&
  a.responsive.hookEnabled === b.responsive.hookEnabled &&
  a.toolLocale.enabled === b.toolLocale.enabled &&
  a.toolLocale.hookEnabled === b.toolLocale.hookEnabled;

const assertPlainObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Parameter "${name}" must be an object`);
  }
};

const applyBooleanField = (source, target, field, label) => {
  if (source[field] === undefined) return;
  if (typeof source[field] !== 'boolean') {
    throw new Error(`"${label}" must be a boolean`);
  }
  target[field] = source[field];
};

/**
 * 校验并持久化统一设置的部分更新，同时同步重写 rules/AGENTS.md。
 * 当目标设置与已持久化设置完全一致时跳过写盘，避免触发无意义的规则文件重载。
 * @param {Record<string, unknown>} patch - 待更新的模块字段
 * @param {{ configPath?: string, rulesPath?: string, forceWrite?: boolean }} [options] - 可选路径与强制写盘开关
 * @returns {{ changed: boolean, settings: ReturnType<typeof readSettings> }} 更新结果
 */
export const updateSettings = (patch, options = {}) => {
  const configPath = resolveConfigPath(options);
  const rulesPath = options.rulesPath ?? DEFAULT_RULES_PATH;
  const current = readSettings({ configPath });
  const next = {
    writeGuard: { ...current.writeGuard },
    responsive: { ...current.responsive },
    toolLocale: { ...current.toolLocale },
    updatedAt: current.updatedAt,
  };

  if (patch && typeof patch === 'object') {
    if (patch.writeGuard !== undefined) {
      assertPlainObject(patch.writeGuard, 'writeGuard');
      applyBooleanField(patch.writeGuard, next.writeGuard, 'enabled', 'writeGuard.enabled');
      applyBooleanField(patch.writeGuard, next.writeGuard, 'hookEnabled', 'writeGuard.hookEnabled');
      if (patch.writeGuard.presetId !== undefined) {
        const key = String(patch.writeGuard.presetId).trim();
        if (!(key in WRITE_PRESETS)) {
          throw new Error(
            `Invalid writeGuard preset "${key}", expected one of ${WRITE_PRESET_ORDER.join(' / ')}`,
          );
        }
        next.writeGuard.presetId = key;
      }
    }

    if (patch.responsive !== undefined) {
      assertPlainObject(patch.responsive, 'responsive');
      applyBooleanField(patch.responsive, next.responsive, 'enabled', 'responsive.enabled');
      applyBooleanField(patch.responsive, next.responsive, 'hookEnabled', 'responsive.hookEnabled');
      if (patch.responsive.silentThreshold !== undefined) {
        const threshold = Number(patch.responsive.silentThreshold);
        if (!(threshold in RESPONSIVE_PRESETS)) {
          throw new Error(
            `Invalid responsive silentThreshold "${patch.responsive.silentThreshold}", expected one of ${RESPONSIVE_PRESET_ORDER.join(' / ')}`,
          );
        }
        next.responsive.silentThreshold = threshold;
      }
    }

    if (patch.toolLocale !== undefined) {
      assertPlainObject(patch.toolLocale, 'toolLocale');
      applyBooleanField(patch.toolLocale, next.toolLocale, 'enabled', 'toolLocale.enabled');
      applyBooleanField(patch.toolLocale, next.toolLocale, 'hookEnabled', 'toolLocale.hookEnabled');
    }
  }

  if (!options.forceWrite && current.updatedAt !== null && settingsEqual(current, next)) {
    return { changed: false, settings: current };
  }

  next.updatedAt = new Date().toISOString();
  writeFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  writeFileAtomic(rulesPath, renderAgentsRule(next));
  return { changed: true, settings: next };
};

/**
 * 按当前持久化配置（首次安装时按默认配置）同步生成 settings.json 与 rules/AGENTS.md。
 * @param {{ configPath?: string, rulesPath?: string }} [options] - 可选路径覆盖
 * @returns {ReturnType<typeof readSettings>} 同步后的配置对象
 */
export const syncRulesFromSettings = (options = {}) => {
  const { settings } = updateSettings({}, { ...options, forceWrite: true });
  return settings;
};
