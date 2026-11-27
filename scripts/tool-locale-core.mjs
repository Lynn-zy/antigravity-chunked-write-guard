import { readSettings } from './config.mjs';
import {
  NEED_FULL_TRANSCRIPT,
  TAIL_WINDOW_BYTES,
  createReminderResponse,
  evaluateTranscript,
  parseArgValue,
  parseStep,
} from './transcript.mjs';

// 注入提醒的标签，同时用来在当前用户轮次内去重（每轮最多提醒一次）
const REMINDER_TAG = 'tool-locale';

// 当前用户消息为纯拉丁短回复（如 "ok" / "continue"）时，最多回溯的历史用户消息条数
const MAX_USER_LOOKBACK = 5;

/** @type {string} 当前轮次检测到工具摘要与用户语言不匹配后注入的同轮纠偏提醒 */
export const REMINDER = `<${REMINDER_TAG}>
A recent \`update_steps\` title, \`update_focus\` status, or \`toolSummary\` was written in English instead of the user's language. Match the user's language in subsequent tool summaries (necessary code identifiers or command names may remain in English).
</${REMINDER_TAG}>`;

// 支持自动识别的非拉丁文字脚本家族（日语假名、韩语谚文优先于共用汉字的中文）
const NON_LATIN_SCRIPTS = Object.freeze([
  {
    id: 'japanese',
    detect: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
    labelMatches: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  },
  { id: 'korean', detect: /\p{Script=Hangul}/u },
  { id: 'chinese', detect: /\p{Script=Han}/u },
  { id: 'cyrillic', detect: /\p{Script=Cyrillic}/u },
  { id: 'arabic', detect: /\p{Script=Arabic}/u },
  { id: 'thai', detect: /\p{Script=Thai}/u },
  { id: 'devanagari', detect: /\p{Script=Devanagari}/u },
  { id: 'hebrew', detect: /\p{Script=Hebrew}/u },
  { id: 'greek', detect: /\p{Script=Greek}/u },
]);

const LATIN_LETTER_RE = /[A-Za-z]/;
const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;
const ADDITIONAL_METADATA_RE = /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]*`/g;

/**
 * 提取用户消息的实际自然语言正文：剥离宿主附加的英文元数据与代码块噪音。
 * @param {unknown} rawContent - USER_INPUT 步骤的 content 字段
 * @returns {string} 清洗后的用户请求文本
 */
export const extractUserRequestText = (rawContent) => {
  if (typeof rawContent !== 'string' || rawContent === '') return '';
  const matched = USER_REQUEST_RE.exec(rawContent);
  const body = matched ? matched[1] : rawContent.replace(ADDITIONAL_METADATA_RE, '');
  return body.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ').trim();
};

/**
 * 根据自然语言文本识别非拉丁文字脚本家族；英文及其他拉丁语系返回 null。
 * @param {string} text - 用户消息正文
 * @returns {{ id: string, detect: RegExp, labelMatches: RegExp } | null} 命中的脚本定义或 null
 */
export const detectNonLatinScript = (text) => {
  if (typeof text !== 'string' || text === '') return null;
  for (const script of NON_LATIN_SCRIPTS) {
    if (script.detect.test(text)) {
      return script;
    }
  }
  return null;
};

const extractToolLabels = (toolCall) => {
  const args = toolCall?.args;
  if (!args || typeof args !== 'object') return [];
  const labels = [];

  if (toolCall.name === 'update_steps' && args.steps != null) {
    const steps = parseArgValue(args.steps);
    if (Array.isArray(steps)) {
      for (const item of steps) {
        if (typeof item?.title === 'string') labels.push(item.title);
      }
    }
  }

  if (toolCall.name === 'update_focus' && args.focus != null) {
    const focus = parseArgValue(args.focus);
    if (typeof focus === 'string') labels.push(focus);
  }

  if (args.toolSummary != null) {
    const summary = parseArgValue(args.toolSummary);
    if (typeof summary === 'string') labels.push(summary);
  }

  return labels;
};

const collectStepLabels = (step, out) => {
  if (step?.type !== 'PLANNER_RESPONSE' || !Array.isArray(step.tool_calls)) return;
  for (const toolCall of step.tool_calls) {
    for (const label of extractToolLabels(toolCall)) {
      out.push(label);
    }
  }
};

const isLocaleReminderStep = (step) =>
  step?.type === 'SYSTEM_MESSAGE' &&
  typeof step.content === 'string' &&
  step.content.includes(`<${REMINDER_TAG}>`);

const isMismatchedLabel = (label, script) =>
  LATIN_LETTER_RE.test(label) && !(script.labelMatches ?? script.detect).test(label);

const evaluateLines = (lines, coversWholeFile) => {
  const currentTurnLabels = [];
  let currentUserIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const step = parseStep(lines[index]);
    if (!step) continue;
    // 当前用户轮次内已经提醒过，直接放行，避免同轮反复刷屏
    if (isLocaleReminderStep(step)) return false;
    if (step.type === 'USER_INPUT') {
      currentUserIndex = index;
      break;
    }
    collectStepLabels(step, currentTurnLabels);
  }

  if (currentUserIndex === -1) {
    // 窗口内未找到本轮 USER_INPUT：若未读全文件则回退，否则说明是无用户消息的子 Agent 会话
    return coversWholeFile ? false : NEED_FULL_TRANSCRIPT;
  }

  // 快路径：本轮没有包含拉丁字母的工具摘要时无需回溯用户语言
  if (!currentTurnLabels.some((label) => LATIN_LETTER_RE.test(label))) {
    return false;
  }

  // 从本轮 USER_INPUT 起往前最多回溯 MAX_USER_LOOKBACK 条用户消息推断非拉丁脚本
  let detectedScript = null;
  let inspectedUsers = 0;
  for (let index = currentUserIndex; index >= 0 && inspectedUsers < MAX_USER_LOOKBACK; index -= 1) {
    const step = parseStep(lines[index]);
    if (!step || step.type !== 'USER_INPUT') continue;
    inspectedUsers += 1;
    const script = detectNonLatinScript(extractUserRequestText(step.content));
    if (script) {
      detectedScript = script;
      break;
    }
  }

  if (!detectedScript) {
    // 当前窗口内还没回溯满上限，回退读全文件确认早期历史是否有非拉丁脚本
    if (!coversWholeFile && inspectedUsers < MAX_USER_LOOKBACK) {
      return NEED_FULL_TRANSCRIPT;
    }
    return false;
  }

  return currentTurnLabels.some((label) => isMismatchedLabel(label, detectedScript));
};

const resolveLocaleConfig = (options) => {
  if (options?.config) {
    return options.config;
  }
  return readSettings({ configPath: options?.configPath }).toolLocale;
};

/**
 * 处理 tool-locale 的 PreInvocation 事件（同轮立即纠偏）：
 * 模块或 Hook 开关关闭时直接放行；开启时从本轮及近期用户消息识别非拉丁文字脚本，
 * 若当前用户轮次内刚有模型调用把 `update_steps` 步骤标题、`update_focus` 或 `toolSummary`
 * 写成纯拉丁英文、不含目标脚本文字，即在下一次模型调用前立即注入一次提醒（每轮最多一次）。
 * 英文及拉丁字母语系由常驻规则约束，Hook 保持静默不误报。
 * @param {Record<string, unknown>} payload - Antigravity 通过 stdin 传入的 PreInvocation JSON
 * @param {{ windowBytes?: number, configPath?: string, config?: { enabled?: boolean, hookEnabled?: boolean } }} [options] - 可选覆盖项
 * @returns {{ injectSteps?: Array<{ systemMessage: { systemMessage: string } }> }} PreInvocation 响应对象
 */
export const handlePreInvocation = (payload, options = {}) => {
  const transcriptPath = payload?.transcriptPath;
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return {};

  const cfg = resolveLocaleConfig(options);
  if (cfg.enabled === false || cfg.hookEnabled === false) return {};

  const shouldRemind = evaluateTranscript(
    transcriptPath,
    evaluateLines,
    options.windowBytes ?? TAIL_WINDOW_BYTES,
  );
  return shouldRemind ? createReminderResponse(REMINDER) : {};
};
