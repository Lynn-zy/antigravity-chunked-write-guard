import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PENDING_DIR,
  DEFAULT_WRITE_PRESET_ID,
  getWriteGuardConfig,
  readSettings,
} from './config.mjs';

export const GUARD_CONFIG = Object.freeze(getWriteGuardConfig(DEFAULT_WRITE_PRESET_ID));

const STALE_PENDING_CLEANUP_MS = 24 * 60 * 60 * 1000;
const NO_OVERSIZE = Object.freeze({ oversize: false, queued: false, notice: null });

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

const formatTargetLabel = (filePath) => (filePath ? `"${filePath}"` : 'the target file');

const pickStringArg = (args, primaryKey, fallbackKey) => {
  const value = args?.[primaryKey] ?? args?.[fallbackKey];
  return typeof value === 'string' ? value : '';
};

const resolveRuntimeConfig = (options) => {
  if (options?.config) {
    return options.config;
  }
  const { writeGuard } = readSettings({ configPath: options?.configPath });
  return getWriteGuardConfig(writeGuard.presetId, writeGuard);
};

const resolveNow = (options) =>
  typeof options?.now === 'function' ? options.now() : Date.now();

const resolvePendingDir = (options) =>
  options?.pendingDir ||
  process.env.ANTIGRAVITY_RAIL_PENDING_DIR ||
  DEFAULT_PENDING_DIR;

const resolvePendingFilePath = (conversationId, options) => {
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    return null;
  }
  const digest = crypto
    .createHash('sha256')
    .update(conversationId.trim())
    .digest('hex')
    .slice(0, 24);
  return path.join(resolvePendingDir(options), `${digest}.jsonl`);
};

const pruneStalePendingFiles = (pendingDir, nowMs) => {
  try {
    for (const name of fs.readdirSync(pendingDir)) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = path.join(pendingDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (nowMs - stat.mtimeMs > STALE_PENDING_CLEANUP_MS) {
          fs.rmSync(filePath, { force: true });
        }
      } catch {
        // 并发清理时忽略已消失的文件
      }
    }
  } catch {
    // 清理异常不影响 Hook 主流程
  }
};

const inspectWriteFile = (args, config) => {
  const content = pickStringArg(args, 'Content', 'content');
  const filePath = pickStringArg(args, 'Path', 'path');
  const isAppend = Boolean(args?.Append ?? args?.append);
  const { lines, bytes } = measureText(content);

  if (lines <= config.warnWriteLines && bytes <= config.warnWriteBytes) {
    return null;
  }

  return {
    toolName: isAppend ? 'write_file (Append)' : 'write_file',
    kind: 'write',
    filePath,
    lines,
    bytes,
    limitLines: config.warnWriteLines,
    limitBytes: config.warnWriteBytes,
  };
};

const inspectEditFile = (args, config) => {
  const replacement = pickStringArg(args, 'Replacement', 'replacement');
  const target = pickStringArg(args, 'Target', 'target');
  const filePath = pickStringArg(args, 'Path', 'path');
  const replacementStats = measureText(replacement);

  // 纯删除（Replacement 为空）不触发超限提醒
  if (replacementStats.bytes === 0) {
    return null;
  }

  if (
    replacementStats.lines > config.warnWriteLines ||
    replacementStats.bytes > config.warnWriteBytes
  ) {
    return {
      toolName: 'edit_file',
      kind: 'edit-replacement',
      filePath,
      lines: replacementStats.lines,
      bytes: replacementStats.bytes,
      limitLines: config.warnWriteLines,
      limitBytes: config.warnWriteBytes,
    };
  }

  const targetStats = measureText(target);
  const combinedLines = targetStats.lines + replacementStats.lines;
  const combinedBytes = targetStats.bytes + replacementStats.bytes;
  if (
    combinedLines > config.warnEditCombinedLines ||
    combinedBytes > config.warnEditCombinedBytes
  ) {
    return {
      toolName: 'edit_file',
      kind: 'edit-combined',
      filePath,
      lines: combinedLines,
      bytes: combinedBytes,
      limitLines: config.warnEditCombinedLines,
      limitBytes: config.warnEditCombinedBytes,
    };
  }

  return null;
};

const appendPendingNotice = (conversationId, notice, options, nowMs) => {
  const pendingPath = resolvePendingFilePath(conversationId, options);
  if (!pendingPath) {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.appendFileSync(pendingPath, `${JSON.stringify({ ...notice, ts: nowMs })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
};

/**
 * 处理 PostToolUse 事件：在 write_file / edit_file 落盘成功后检测是否超限，
 * 不阻断写入；模块关闭时直接跳过，提醒开关关闭时仅上报超限统计不排队提醒。
 * @param {Record<string, unknown>} payload - Antigravity 传入的 stdin JSON
 * @param {{ config?: Record<string, unknown>, configPath?: string, pendingDir?: string, now?: () => number }} [options] - 可选配置覆盖
 * @returns {{ oversize: boolean, queued: boolean, notice: Record<string, unknown> | null }} 检测结果
 */
export const handlePostToolUse = (payload, options = {}) => {
  // 工具自身执行报错时未成功落盘，不记超限也不排队提醒
  if (typeof payload?.error === 'string' && payload.error.trim().length > 0) {
    return NO_OVERSIZE;
  }

  const toolCall = payload?.toolCall;
  const toolName = String(toolCall?.name ?? '').toLowerCase();
  if (toolName !== 'write_file' && toolName !== 'edit_file') {
    return NO_OVERSIZE;
  }

  const config = resolveRuntimeConfig(options);
  if (config.enabled === false) {
    return NO_OVERSIZE;
  }

  const args = toolCall?.args ?? {};
  const notice =
    toolName === 'write_file' ? inspectWriteFile(args, config) : inspectEditFile(args, config);
  if (!notice) {
    return NO_OVERSIZE;
  }

  const queued =
    config.hookEnabled !== false &&
    appendPendingNotice(payload?.conversationId, notice, options, resolveNow(options));

  return { oversize: true, queued, notice };
};

const formatSingleNoticeLine = (item) => {
  const targetLabel = formatTargetLabel(item.filePath);
  const scopeLabel =
    item.kind === 'edit-combined'
      ? `Target + Replacement: ${item.lines} lines / ${formatKilobytes(item.bytes)}`
      : `${item.lines} lines / ${formatKilobytes(item.bytes)}`;
  const limitLabel = `${item.limitLines} lines / ${formatKilobytes(item.limitBytes)}`;
  return `${item.toolName} to ${targetLabel} (${scopeLabel}, limit ${limitLabel})`;
};

const buildOversizeReminderMessage = (notices, config) => {
  const hasCombinedEdit = notices.some((item) => item.kind === 'edit-combined');
  const detailText =
    notices.length === 1
      ? `The previous ${formatSingleNoticeLine(notices[0])} was allowed to finish, but exceeded the warning limit for the ${config.label} preset.`
      : [
          `The previous ${notices.length} oversize writes were allowed to finish, but exceeded the warning limit for the ${config.label} preset:`,
          ...notices.map((item) => `- ${formatSingleNoticeLine(item)}`),
        ].join('\n');

  const advice = hasCombinedEdit
    ? `For subsequent edits to large files, keep each write within ≤ ${config.softTargetLines} lines and narrow your edit_file Target anchor to avoid slow or interrupted streaming.`
    : `For subsequent large files, split writes into ≤ ${config.softTargetLines}-line chunks (write the skeleton first, then fill in via write_file(Append: true) or targeted edit_file) to avoid slow or interrupted streaming.`;

  return `${config.reminderMarker} ${detailText}\n${advice}`;
};

const parsePendingNotices = (raw, ttlMs, nowMs) => {
  const valid = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }
    const ts = Number(parsed.ts);
    if (!Number.isFinite(ts) || nowMs - ts > ttlMs) {
      continue;
    }
    valid.push(parsed);
  }
  return valid;
};

/**
 * 处理 PreInvocation 事件：仅当分段写入模块与事后提醒开关均启用且存在未过期超限记录时，
 * 读取并删除记录，注入一条事后提醒；其余场景直接返回 {}。
 * @param {Record<string, unknown>} payload - Antigravity 传入的 stdin JSON
 * @param {{ config?: Record<string, unknown>, configPath?: string, pendingDir?: string, now?: () => number }} [options] - 可选配置覆盖
 * @returns {Record<string, unknown>} PreInvocation 响应对象
 */
export const handlePreInvocation = (payload, options = {}) => {
  const pendingPath = resolvePendingFilePath(payload?.conversationId, options);
  if (!pendingPath) {
    return {};
  }

  // 快路径：正常轮次无待提醒文件，单次读取 ENOENT 直接退出不读配置
  let raw = '';
  try {
    raw = fs.readFileSync(pendingPath, 'utf8');
  } catch {
    return {};
  }

  // 读取后立即删除，确保每批超限记录最多注入一次
  try {
    fs.rmSync(pendingPath, { force: true });
  } catch {}

  const nowMs = resolveNow(options);
  const config = resolveRuntimeConfig(options);
  const notices = parsePendingNotices(raw, config.pendingReminderTtlMs, nowMs);
  pruneStalePendingFiles(path.dirname(pendingPath), nowMs);

  if (config.enabled === false || config.hookEnabled === false || notices.length === 0) {
    return {};
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: buildOversizeReminderMessage(notices, config),
        },
      },
    ],
  };
};
