import { DEFAULT_RESPONSIVE_THRESHOLD, readSettings } from './config.mjs';
import {
  NEED_FULL_TRANSCRIPT,
  TAIL_WINDOW_BYTES,
  createReminderResponse,
  evaluateTranscript,
  parseArgValue,
  parseStep,
} from './transcript.mjs';

// 注入提醒的标签，同时用来在会话记录里识别本 Hook 注入过的提醒
const REMINDER_TAG = 'responsive-mode';
const FILE_LINK_REMINDER_TAG = 'responsive-file-links';

const FILE_TOOL_NAMES = new Set(['read_file', 'edit_file', 'write_file']);
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const MARKDOWN_LINK_RE = /\[[^\]]*\]\([^)]+\)/g;
const DOUBLE_BACKTICK_CODE_RE = /``[^\r\n]+?``/g;
const INLINE_CODE_RE = /`([^`\r\n]+)`/g;
const FILE_URL_RE = /file:\/\/\/([^)\s#>"']+)/gi;
const LINE_SUFFIX_RE = /(?:#L\d+(?:-L?\d+)?|:\d+(?:-\d+)?)$/i;

/** @type {string} 上一轮未先回话或长时间静默时注入的纠偏提醒 */
export const REMINDER = `<${REMINDER_TAG}>
Respond right away to what the user just said before any thinking or tool use, without opening with a generic one-word acknowledgment, and tell them directly what you plan to do next (or let them know first if you need to think). Then continue the work, and whenever you finish a phase or make a key finding, share with the user what you found and what you plan to do next before the next batch of tool calls.
</${REMINDER_TAG}>`;

/**
 * 构造同轮文件链接漏加提醒，直接点出刚以纯反引号出现的已知文件名。
 * @param {string[]} files - 未写成可点击链接的已知文件名列表
 * @returns {string} 注入给模型的系统提醒文本
 */
export const buildFileLinkReminder = (files) => {
  const examples = files
    .slice(0, 3)
    .map((name) => `\`${name}\``)
    .join(', ');
  return `<${FILE_LINK_REMINDER_TAG}>
A recent reply referenced workspace files in plain backticks (${examples}) instead of clickable links. Format real files as \`[filename](file:///absolute/path)\` (forward slashes on Windows) in subsequent progress updates and summaries.
</${FILE_LINK_REMINDER_TAG}>`;
};

const hasReminderTag = (step, tag) =>
  step?.type === 'SYSTEM_MESSAGE' &&
  typeof step.content === 'string' &&
  step.content.includes(`<${tag}>`);

const hasVisibleText = (step) =>
  typeof step?.content === 'string' && step.content.trim() !== '';

const isSilentToolCall = (step) =>
  !hasVisibleText(step) && Array.isArray(step?.tool_calls) && step.tool_calls.length > 0;

const hasResponsiveViolation = (responses, silentThreshold) => {
  if (responses.length === 0) return false;
  if (isSilentToolCall(responses[0])) return true;

  let silentStreak = 0;
  for (const response of responses) {
    if (isSilentToolCall(response)) {
      silentStreak += 1;
      if (silentStreak >= silentThreshold) return true;
    } else if (hasVisibleText(response)) {
      silentStreak = 0;
    }
  }
  return false;
};

const addKnownPathKeys = (rawPath, keySet) => {
  const normalized = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized) return;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return;

  const basename = segments[segments.length - 1];
  // 仅收录带扩展名点号的文件名，避免无后缀普通词或纯点文件（如 .gitignore）误报
  if (basename.lastIndexOf('.') <= 0) return;

  const maxDepth = Math.min(segments.length, 4);
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    keySet.add(segments.slice(segments.length - depth).join('/').toLowerCase());
  }
};

const collectKnownFileKeys = (steps) => {
  const keys = new Set();
  for (const step of steps) {
    if (!step) continue;

    if (step.type === 'PLANNER_RESPONSE' && Array.isArray(step.tool_calls)) {
      for (const toolCall of step.tool_calls) {
        const name = String(toolCall?.name ?? '').toLowerCase();
        if (!FILE_TOOL_NAMES.has(name)) continue;
        const args = toolCall?.args;
        const rawPath = parseArgValue(args?.Path ?? args?.path);
        if (typeof rawPath === 'string') {
          addKnownPathKeys(rawPath, keys);
        }
      }
    }

    if (
      (step.type === 'PLANNER_RESPONSE' || step.type === 'USER_INPUT') &&
      typeof step.content === 'string' &&
      step.content.includes('file:///')
    ) {
      for (const match of step.content.matchAll(FILE_URL_RE)) {
        try {
          addKnownPathKeys(decodeURIComponent(match[1]), keys);
        } catch {
          addKnownPathKeys(match[1], keys);
        }
      }
    }
  }
  return keys;
};

/**
 * 从单段回复正文中提取疑似行内反引号文件引用（自动剥离代码块、已有 Markdown 链接与双反引号转义示例）。
 * @param {unknown} content - PLANNER_RESPONSE 的可见正文
 * @returns {Array<{ raw: string, normalizedKey: string }>} 候选反引号项列表
 */
export const extractBacktickFileCandidates = (content) => {
  if (typeof content !== 'string' || !content.includes('`')) return [];
  const stripped = content
    .replace(FENCED_CODE_RE, ' ')
    .replace(MARKDOWN_LINK_RE, ' ')
    .replace(DOUBLE_BACKTICK_CODE_RE, ' ');
  const results = [];

  for (const match of stripped.matchAll(INLINE_CODE_RE)) {
    const raw = match[1].trim();
    // 跳过命令片段或不含扩展名点号的标识符
    if (!raw || /\s/.test(raw) || !raw.includes('.')) continue;
    const withoutLine = raw.replace(LINE_SUFFIX_RE, '');
    const normalizedKey = withoutLine
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();
    if (!normalizedKey) continue;
    results.push({ raw, normalizedKey });
  }
  return results;
};

const findUnlinkedKnownFiles = (latestResponse, allSteps) => {
  const candidates = extractBacktickFileCandidates(latestResponse?.content);
  if (candidates.length === 0) {
    return { matched: [], hasCandidates: false };
  }

  const knownKeys = collectKnownFileKeys(allSteps);
  const seen = new Set();
  const matched = [];
  for (const item of candidates) {
    if (!knownKeys.has(item.normalizedKey) || seen.has(item.normalizedKey)) continue;
    seen.add(item.normalizedKey);
    matched.push(item.raw);
  }
  return { matched, hasCandidates: true };
};

const createEvaluator = (silentThreshold) => (lines, coversWholeFile) => {
  const steps = lines.map(parseStep);

  // 1. 扫描当前用户轮次：区分“轮首未回复”与“轮中已回复”
  let latestUserIndex = -1;
  let alreadyRemindedTurn = false;
  let alreadyRemindedLinks = false;
  let latestTurnResponse = null;

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step) continue;
    if (hasReminderTag(step, FILE_LINK_REMINDER_TAG)) {
      alreadyRemindedLinks = true;
      continue;
    }
    if (hasReminderTag(step, REMINDER_TAG)) {
      alreadyRemindedTurn = true;
      continue;
    }
    if (step.type === 'PLANNER_RESPONSE') {
      if (!latestTurnResponse) {
        latestTurnResponse = step;
      }
      continue;
    }
    if (step.type === 'USER_INPUT') {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex === -1) {
    return coversWholeFile ? null : NEED_FULL_TRANSCRIPT;
  }

  // 2. 轮中分支：仅检查最近刚发出的那一条回复，避免翻同轮更早步骤（如 ask_question 前）的旧账
  if (latestTurnResponse) {
    if (alreadyRemindedLinks) return null;
    const { matched, hasCandidates } = findUnlinkedKnownFiles(latestTurnResponse, steps);
    if (matched.length > 0) {
      return buildFileLinkReminder(matched);
    }
    // 窗口内有疑似反引号文件名但未命中已知集合时，回退读全文件确认早期操作过的文件
    if (hasCandidates && !coversWholeFile) {
      return NEED_FULL_TRANSCRIPT;
    }
    return null;
  }

  // 3. 轮首分支：本轮已提醒过直接放行，否则检查上一轮开场空正文或中途连续静默
  if (alreadyRemindedTurn) return null;

  let prevUserIndex = -1;
  const prevTurnResponses = [];
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step) continue;
    if (step.type === 'USER_INPUT') {
      prevUserIndex = index;
      break;
    }
    if (step.type === 'PLANNER_RESPONSE') {
      prevTurnResponses.push(step);
    }
  }
  if (prevUserIndex === -1) {
    return coversWholeFile ? null : NEED_FULL_TRANSCRIPT;
  }

  prevTurnResponses.reverse();
  return hasResponsiveViolation(prevTurnResponses, silentThreshold) ? REMINDER : null;
};

const resolveResponsiveConfig = (options) => {
  if (options?.config) {
    return options.config;
  }
  return readSettings({ configPath: options?.configPath }).responsive;
};

/**
 * 处理 responsive-mode 的 PreInvocation 事件：模块或 Hook 开关关闭时直接放行；
 * 轮首检查上一轮是否开场空正文或中途连续静默达阈值，轮中检查是否把已知工作区文件
 * 写成纯反引号而非可点击链接，违规时注入对应纠偏提醒（每类每轮最多一次）。
 * @param {Record<string, unknown>} payload - Antigravity 通过 stdin 传入的 PreInvocation JSON
 * @param {{ windowBytes?: number, configPath?: string, config?: { enabled?: boolean, hookEnabled?: boolean, silentThreshold?: number } }} [options] - 可选覆盖项
 * @returns {{ injectSteps?: Array<{ systemMessage: { systemMessage: string } }> }} PreInvocation 响应对象
 */
export const handlePreInvocation = (payload, options = {}) => {
  const transcriptPath = payload?.transcriptPath;
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return {};

  const cfg = resolveResponsiveConfig(options);
  if (cfg.enabled === false || cfg.hookEnabled === false) return {};

  const threshold = cfg.silentThreshold ?? DEFAULT_RESPONSIVE_THRESHOLD;
  const reminder = evaluateTranscript(
    transcriptPath,
    createEvaluator(threshold),
    options.windowBytes ?? TAIL_WINDOW_BYTES,
  );
  return typeof reminder === 'string' && reminder ? createReminderResponse(reminder) : {};
};
