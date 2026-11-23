import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const DEFAULT_CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'active-preset.json');
export const DEFAULT_RULES_PATH = path.join(PLUGIN_ROOT, 'rules', 'AGENTS.md');

export const SHARED_LIMITS = Object.freeze({
  transcriptTailBytes: 64 * 1024,
  recoveryMarker: '[chunked-write-guard:stream-recovery]',
});

/**
 * 三档阈值预设（单一数据源，Hook 判定与 AGENTS.md 规则均由此派生）。
 */
export const PRESETS = Object.freeze({
  '300': Object.freeze({
    id: '300',
    label: '300 行 · 稳妥档',
    summary: '适合网络波动较大或超长上下文会话，优先快速分段落盘',
    softTargetLines: 300,
    recoveryTargetLines: 200,
    maxWriteLines: 500,
    maxWriteBytes: 28 * 1024,
    maxEditCombinedLines: 600,
    maxEditCombinedBytes: 36 * 1024,
  }),
  '500': Object.freeze({
    id: '500',
    label: '500 行 · 标准档',
    summary: '日常开发默认推荐，常规源码文件一次写完不误拦，仅拦超大生成',
    softTargetLines: 500,
    recoveryTargetLines: 300,
    maxWriteLines: 800,
    maxWriteBytes: 48 * 1024,
    maxEditCombinedLines: 900,
    maxEditCombinedBytes: 56 * 1024,
  }),
  '700': Object.freeze({
    id: '700',
    label: '700 行 · 宽松档',
    summary: '适合网络稳定且经常生成较长单文件或完整组件时放宽预算',
    softTargetLines: 700,
    recoveryTargetLines: 400,
    maxWriteLines: 1100,
    maxWriteBytes: 64 * 1024,
    maxEditCombinedLines: 1200,
    maxEditCombinedBytes: 72 * 1024,
  }),
});

export const PRESET_ORDER = Object.freeze(['700', '500', '300']);
export const DEFAULT_PRESET_ID = '500';

/**
 * 根据档位 ID 获取完整的运行时阈值配置。
 * @param {string} [presetId] - 档位标识（'300' | '500' | '700'）
 * @returns {Record<string, unknown>} 合并公共常量后的配置对象
 */
export const getPresetConfig = (presetId = DEFAULT_PRESET_ID) => {
  const key = String(presetId ?? DEFAULT_PRESET_ID);
  const preset = PRESETS[key] ?? PRESETS[DEFAULT_PRESET_ID];
  return {
    ...SHARED_LIMITS,
    ...preset,
  };
};

/**
 * 读取当前持久化的生效档位状态；文件缺失或损坏时安全回退至默认 500 档。
 * @param {{ configPath?: string }} [options] - 可选配置文件路径覆盖
 * @returns {{ presetId: string, updatedAt: string | null, config: Record<string, unknown> }} 当前档位状态与完整配置
 */
export const readActivePresetState = (options = {}) => {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const rawId = String(parsed?.presetId ?? '');
    if (rawId in PRESETS) {
      return {
        presetId: rawId,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        config: getPresetConfig(rawId),
      };
    }
  } catch {
    // 配置尚未落盘或损坏时静默回退默认档位
  }
  return {
    presetId: DEFAULT_PRESET_ID,
    updatedAt: null,
    config: getPresetConfig(DEFAULT_PRESET_ID),
  };
};

/**
 * 从当前档位动态渲染常驻规则文件（rules/AGENTS.md），保证规则与 Hook 数值始终一致。
 * @param {Record<string, unknown>} preset - 档位配置对象
 * @returns {string} 渲染后的 Markdown 文本
 */
export const renderAgentsRule = (preset) => {
  const writeKb = Math.round(preset.maxWriteBytes / 1024);
  const combinedKb = Math.round(preset.maxEditCombinedBytes / 1024);
  return [
    '# 分段写入规范（Chunked Write Guard）',
    '',
    `<!-- 当前生效档位：${preset.label}（可在 Write Guard 侧边栏面板一键切换 700 / 500 / 300 档） -->`,
    '',
    '为避免单次输出过长触发模型流式超时（`The stream was interrupted`）并导致零进度重试循环，写入或大段修改文件时遵守以下预算：',
    '',
    `1. **单次写入目标 ≤ ${preset.softTargetLines} 行**：每次 \`write_file\`（含 \`Append: true\`）或 \`edit_file\` 的新内容尽量控制在 ${preset.softTargetLines} 行以内。`,
    `2. **长文件必须分步构建**：预计超过 ${preset.softTargetLines} 行的文件（尤其是单页 HTML 原型、大型组件、长文档或长脚本），必须拆成多步落盘：`,
    `   - 第 1 步用 \`write_file\` 写入精简骨架（框架结构、核心样式或接口声明，≤ ${preset.softTargetLines} 行）；`,
    '   - 后续按功能模块分次调用 `write_file(Append: true)` 或 `edit_file` 逐步补齐，使每次写入都快速落盘。',
    '3. **兜底门禁与断流自愈**：',
    `   - 本地 \`PreToolUse\` Hook 对单次写入设有硬兜底线（**${preset.maxWriteLines} 行**或 **${writeKb} KB**，以及 \`edit_file\` 合计超 ${preset.maxEditCombinedLines} 行 / ${combinedKb} KB）。若被拦截，请直接缩小粒度分段写入，不要原样重试。`,
    `   - 若收到断流自愈提示，本轮单次写入强制控制在 **≤ ${preset.recoveryTargetLines} 行**以内，确保先成功落盘。`,
    '',
  ].join('\n');
};

const writeFileAtomic = (targetPath, content) => {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
};

/**
 * 切换并持久化当前档位，同时原子同步更新 rules/AGENTS.md。
 * @param {string} presetId - 目标档位标识（'300' | '500' | '700'）
 * @param {{ configPath?: string, rulesPath?: string }} [options] - 可选路径覆盖
 * @returns {{ presetId: string, updatedAt: string, config: Record<string, unknown> }} 更新后的状态
 */
export const applyPreset = (presetId, options = {}) => {
  const key = String(presetId ?? '');
  if (!(key in PRESETS)) {
    throw new Error(`Unsupported presetId "${key}". Expected one of: ${PRESET_ORDER.join(', ')}`);
  }

  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const rulesPath = options.rulesPath ?? DEFAULT_RULES_PATH;
  const updatedAt = new Date().toISOString();
  const config = getPresetConfig(key);

  writeFileAtomic(
    configPath,
    `${JSON.stringify({ presetId: key, updatedAt }, null, 2)}\n`,
  );
  writeFileAtomic(rulesPath, renderAgentsRule(config));

  return {
    presetId: key,
    updatedAt,
    config,
  };
};
