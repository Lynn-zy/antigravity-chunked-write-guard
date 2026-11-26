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

export const WRITE_PRESET_ORDER = Object.freeze(['700', '500', '300']);
export const DEFAULT_WRITE_PRESET_ID = '500';

/**
 * 响应汇报中途静默阈值三档预设。
 */
export const RESPONSIVE_PRESETS = Object.freeze({
  4: Object.freeze({
    threshold: 4,
    label: '4 次 · 敏感档',
    summary: '中途连续 4 次无正文调用工具即判犯规，更快拉回可见性',
  }),
  6: Object.freeze({
    threshold: 6,
    label: '6 次 · 标准档',
    summary: '日常默认，允许单阶段连续读查，达 6 次无正文调工具后下一轮纠偏',
  }),
  10: Object.freeze({
    threshold: 10,
    label: '10 次 · 宽松档',
    summary: '适合深度排查或大型重构，减少中途静默触发纠偏',
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
    '## 分段写入规范',
    '',
    '为避免单次输出过长拖慢流式响应并让长文件改动尽早落盘，写入或修改文件时遵守以下限制：',
    '',
    `1. **单次写入目标 ≤ ${preset.softTargetLines} 行**：每次 \`write_file\`（含 \`Append: true\`）或 \`edit_file\` 的新内容控制在 ${preset.softTargetLines} 行以内。`,
    `2. **长文件分步写入**：预计超过 ${preset.softTargetLines} 行的文件（如单页 HTML 原型、大型组件、长文档或脚本），拆成多步完成。`,
    `   - 第 1 步用 \`write_file\` 写入骨架与核心结构（≤ ${preset.softTargetLines} 行）。`,
    '   - 后续按模块分次调用 `write_file(Append: true)` 或 `edit_file` 补齐，让每段改动尽快落盘。',
  ];

  if (writeGuard.hookEnabled) {
    lines.push(
      `3. **超限检测与事后提醒**：单次写入超过 **${preset.warnWriteLines} 行**或 **${writeKb} KB**（\`edit_file\` 合计超过 ${preset.warnEditCombinedLines} 行或 ${combinedKb} KB）时不会阻断落盘，但下一轮会提醒你回到 ≤ ${preset.softTargetLines} 行的分段写入。`,
    );
  }
  return lines.join('\n');
};

const renderResponsiveSection = () =>
  [
    '## 先回话，再动手',
    '',
    '用户正看着对话等你回应。每次收到用户的新消息，先用一两句话回复，再调用工具。',
    '',
    '- 说明你对任务的理解和第一步要做什么，例如"先看一下 `parseConfig` 的调用方，确认改签名会影响哪些地方。"',
    '- 需要先想清楚再动手时，就说一句"我先想一下"。',
    '- 简单问题能直接回答的，直接给出答案，不必先预告。',
    '- 这句话和随后的工具调用放在同一条回复里。说完不要停下来等用户，接着工作。',
    '- 工作途中也要让用户看到进展。连续的工具调用在界面上会折叠成一个步骤，用户只能从正文了解你做到了哪里。每完成一个阶段、有了关键发现或改变方向时，用一句话说明发现了什么、接下来做什么，和下一批工具调用放在同一条回复里。只说发现和下一步，"继续查看"这类没有信息的话不要写。',
    '- 工作途中收到用户的新消息，同样先回应这条消息，再继续原来的工作。',
    '- 最后的回复也一样：说清发现了什么、做了什么、还需要用户提供什么，说完就结束。',
  ].join('\n');

const renderToolLocaleSection = () =>
  [
    '## 工具状态与摘要保持中文',
    '',
    '- 调用 `update_steps` 的步骤标题（`title`）、`update_focus` 的状态说明（`focus`）以及 `run_command` 的 `toolSummary` 时，一律使用中文短语（可保留必要的英文术语或命令名，如"运行 `npm test`"、"检查 Git 状态"）。',
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
      `分段写入：${preset.label}${normalized.writeGuard.hookEnabled ? '' : '（仅规则）'}`,
    );
    sections.push(renderWriteGuardSection(normalized.writeGuard));
  }
  if (normalized.responsive.enabled) {
    summaryParts.push(
      `响应汇报：静默 ${normalized.responsive.silentThreshold} 次档${normalized.responsive.hookEnabled ? '' : '（仅规则）'}`,
    );
    sections.push(renderResponsiveSection());
  }
  if (normalized.toolLocale.enabled) {
    summaryParts.push(`摘要中文：已开启${normalized.toolLocale.hookEnabled ? '' : '（仅规则）'}`);
    sections.push(renderToolLocaleSection());
  }

  if (sections.length === 0) {
    return '<!-- Antigravity Rail：全部护栏模块已关闭，可在侧边栏面板重新开启 -->\n';
  }

  return [
    '# Antigravity Rail',
    '',
    `<!-- 当前生效模块：${summaryParts.join(' ｜ ')}（可在 Antigravity Rail 侧边栏面板调整） -->`,
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
    throw new Error(`参数 ${name} 必须是对象`);
  }
};

const applyBooleanField = (source, target, field, label) => {
  if (source[field] === undefined) return;
  if (typeof source[field] !== 'boolean') {
    throw new Error(`${label} 必须是布尔值`);
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
          throw new Error(`无效分段写入档位 "${key}"，仅支持 ${WRITE_PRESET_ORDER.join(' / ')}`);
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
            `无效静默阈值档位 "${patch.responsive.silentThreshold}"，仅支持 ${RESPONSIVE_PRESET_ORDER.join(' / ')}`,
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
