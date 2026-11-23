import fs from 'node:fs';
import {
  DEFAULT_PRESET_ID,
  getPresetConfig,
  readActivePresetState,
} from './presets.mjs';

export const GUARD_CONFIG = Object.freeze(getPresetConfig(DEFAULT_PRESET_ID));

const STREAM_INTERRUPT_RE =
  /stream was interrupted|stream idle timeout|context deadline exceeded/i;

/**
 * 统计文本的行数与 UTF-8 字节数。
 * @param {string} text - 待统计文本
 * @returns {{ lines: number, bytes: number }} 行数与字节数
 */
export const measureText = (text) => {
  if (typeof text !== 'string' || text.length === 0) {
    return { lines: 0, bytes: 0 };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  // 末尾换行符不额外算作新的一行
  if (text.endsWith('\n')) {
    lines -= 1;
  }
  return { lines, bytes };
};

const formatKilobytes = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const formatTargetLabel = (filePath) => (filePath ? `「${filePath}」` : '目标文件');

const pickStringArg = (args, primaryKey, fallbackKey) => {
  const value = args?.[primaryKey] ?? args?.[fallbackKey];
  return typeof value === 'string' ? value : '';
};

const resolveRuntimeConfig = (options) =>
  options?.config ?? readActivePresetState({ configPath: options?.configPath }).config;

const isStreamInterruptEntry = (entry) =>
  entry.type === 'ERROR_MESSAGE' &&
  typeof entry.content === 'string' &&
  STREAM_INTERRUPT_RE.test(entry.content);

const isRecoveryMarkerEntry = (entry, recoveryMarker) =>
  entry.type === 'SYSTEM_MESSAGE' &&
  typeof entry.content === 'string' &&
  entry.content.includes(recoveryMarker);

const isHealthyProgressEntry = (entry) => {
  // 工具返回结果表示上一轮工具调用已正常落盘并执行完毕
  if (entry.type === 'GENERIC') {
    return true;
  }
  if (entry.type !== 'PLANNER_RESPONSE') {
    return false;
  }
  const hasTools = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
  const hasText = typeof entry.content === 'string' && entry.content.trim().length > 0;
  return hasTools || hasText;
};

/**
 * 从会话 transcript 尾部检测最近是否刚发生未恢复的流中断。
 * 倒序扫描尾部日志，在遇到有效进展或已注入标记前统计连续断流次数。
 * @param {string} transcriptPath - Antigravity 会话 transcript.jsonl 路径
 * @param {{ tailBytes?: number, recoveryMarker?: string }} [options] - 可选尾部读取字节上限与去重标记
 * @returns {{ interrupted: boolean, consecutiveInterrupts: number }} 断流检测结果
 */
export const detectRecentStreamInterruption = (transcriptPath, options = {}) => {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    return { interrupted: false, consecutiveInterrupts: 0 };
  }

  let chunk = '';
  let startOffset = 0;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) {
      return { interrupted: false, consecutiveInterrupts: 0 };
    }
    const maxBytes = options.tailBytes ?? GUARD_CONFIG.transcriptTailBytes;
    const readSize = Math.min(stat.size, maxBytes);
    startOffset = stat.size - readSize;

    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, startOffset);
      chunk = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { interrupted: false, consecutiveInterrupts: 0 };
  }

  const lines = chunk.split(/\r?\n/);
  // 非文件开头读取时丢弃首行，避免从多字节或半行 JSON 中间截断
  if (startOffset > 0 && lines.length > 0) {
    lines.shift();
  }

  const recoveryMarker = options.recoveryMarker ?? GUARD_CONFIG.recoveryMarker;
  let consecutiveInterrupts = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    if (isStreamInterruptEntry(entry)) {
      consecutiveInterrupts += 1;
      continue;
    }

    // 遇到已注入标记或有效进展时停止回溯，避免重复注入
    if (isRecoveryMarkerEntry(entry, recoveryMarker) || isHealthyProgressEntry(entry)) {
      break;
    }
  }

  return {
    interrupted: consecutiveInterrupts > 0,
    consecutiveInterrupts,
  };
};

const buildRecoverySystemMessage = (consecutiveInterrupts, config) => {
  const countNote =
    consecutiveInterrupts > 1
      ? `（已连续中断 ${consecutiveInterrupts} 次）`
      : '';
  return [
    `${config.recoveryMarker} 检测到上一轮发生流式中断${countNote}，通常由单次输出过长或超大 write_file / edit_file 参数引起。`,
    `当前档位为 ${config.label ?? `${config.softTargetLines} 行`}，本轮按以下方式续写：`,
    `1. 禁止一次性写入完整长文件，单次 write_file / edit_file 新内容控制在 ≤ ${config.recoveryTargetLines} 行以内；`,
    '2. 先用 write_file 写入骨架并落盘，再用 write_file(Append: true) 或多次局部 edit_file 按模块补齐。',
  ].join('\n');
};

/**
 * 处理 PreInvocation 事件：仅在检测到刚发生未恢复的流中断时注入一次分段写入恢复提醒。
 * @param {Record<string, unknown>} payload - Antigravity 传入的 stdin JSON
 * @param {{ config?: Record<string, unknown>, configPath?: string }} [options] - 可选配置覆盖
 * @returns {Record<string, unknown>} PreInvocation 响应对象
 */
export const handlePreInvocation = (payload, options = {}) => {
  const config = resolveRuntimeConfig(options);
  const transcriptPath =
    typeof payload?.transcriptPath === 'string' ? payload.transcriptPath : '';
  const { interrupted, consecutiveInterrupts } = detectRecentStreamInterruption(
    transcriptPath,
    {
      tailBytes: config.transcriptTailBytes,
      recoveryMarker: config.recoveryMarker,
    },
  );

  if (!interrupted) {
    return {};
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: buildRecoverySystemMessage(consecutiveInterrupts, config),
        },
      },
    ],
  };
};

const evaluateWriteFile = (args, config) => {
  const content = pickStringArg(args, 'Content', 'content');
  const filePath = pickStringArg(args, 'Path', 'path');
  const isAppend = Boolean(args?.Append ?? args?.append);
  const { lines, bytes } = measureText(content);

  if (lines <= config.maxWriteLines && bytes <= config.maxWriteBytes) {
    return { decision: 'allow' };
  }

  const modeLabel = isAppend ? 'write_file (Append)' : 'write_file';
  const targetLabel = formatTargetLabel(filePath);
  const nextStepHint = isAppend
    ? `请将追加内容拆分为多段调用 write_file(Append: true)，每次控制在 ≤ ${config.softTargetLines} 行以内。`
    : `请先用 write_file 写入骨架（≤ ${config.softTargetLines} 行），再通过多次 write_file(Append: true) 或 edit_file 按模块补齐。`;

  return {
    decision: 'deny',
    reason:
      `[chunked-write-guard] 已拦截超大 ${modeLabel} 写入 ${targetLabel}，` +
      `本次共 ${lines} 行 / ${formatKilobytes(bytes)}，` +
      `超过单次写入上限（${config.maxWriteLines} 行或 ${formatKilobytes(config.maxWriteBytes)}）。` +
      nextStepHint,
  };
};

const evaluateEditFile = (args, config) => {
  const replacement = pickStringArg(args, 'Replacement', 'replacement');
  const target = pickStringArg(args, 'Target', 'target');
  const filePath = pickStringArg(args, 'Path', 'path');
  const targetLabel = formatTargetLabel(filePath);
  const replacementStats = measureText(replacement);

  if (
    replacementStats.lines > config.maxWriteLines ||
    replacementStats.bytes > config.maxWriteBytes
  ) {
    return {
      decision: 'deny',
      reason:
        `[chunked-write-guard] 已拦截超大 edit_file 替换 ${targetLabel}，` +
        `Replacement 共 ${replacementStats.lines} 行 / ${formatKilobytes(replacementStats.bytes)}，` +
        `超过单次写入上限（${config.maxWriteLines} 行或 ${formatKilobytes(config.maxWriteBytes)}）。` +
        `请拆分为多个局部 edit_file 调用，每次替换控制在 ≤ ${config.softTargetLines} 行以内。`,
    };
  }

  // 允许纯删除（Replacement 为空）清理大段旧代码
  if (replacementStats.bytes === 0) {
    return { decision: 'allow' };
  }

  const targetStats = measureText(target);
  const combinedLines = targetStats.lines + replacementStats.lines;
  const combinedBytes = targetStats.bytes + replacementStats.bytes;
  if (
    combinedLines > config.maxEditCombinedLines ||
    combinedBytes > config.maxEditCombinedBytes
  ) {
    return {
      decision: 'deny',
      reason:
        `[chunked-write-guard] 已拦截全量覆盖式 edit_file ${targetLabel}，` +
        `Target + Replacement 合计 ${combinedLines} 行 / ${formatKilobytes(combinedBytes)}，` +
        `超过 edit_file 合计上限（${config.maxEditCombinedLines} 行或 ${formatKilobytes(config.maxEditCombinedBytes)}）。` +
        '请缩小 Target 锚点范围，拆分为多次局部编辑。',
    };
  }

  return { decision: 'allow' };
};

/**
 * 处理 PreToolUse 事件：按当前生效档位拦截超限的 write_file / edit_file 调用。
 * @param {Record<string, unknown>} payload - Antigravity 传入的 stdin JSON
 * @param {{ config?: Record<string, unknown>, configPath?: string }} [options] - 可选配置覆盖
 * @returns {{ decision: 'allow' | 'deny', reason?: string }} PreToolUse 决策对象
 */
export const handlePreToolUse = (payload, options = {}) => {
  const config = resolveRuntimeConfig(options);
  const toolCall = payload?.toolCall;
  const toolName = String(toolCall?.name ?? '').toLowerCase();
  const args = toolCall?.args ?? {};

  if (toolName === 'write_file') {
    return evaluateWriteFile(args, config);
  }
  if (toolName === 'edit_file') {
    return evaluateEditFile(args, config);
  }
  return { decision: 'allow' };
};
