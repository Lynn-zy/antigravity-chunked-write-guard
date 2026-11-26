import { DEFAULT_RESPONSIVE_THRESHOLD, readSettings } from './config.mjs';
import {
  NEED_FULL_TRANSCRIPT,
  TAIL_WINDOW_BYTES,
  createReminderResponse,
  evaluateTranscript,
  parseStep,
} from './transcript.mjs';

// 注入提醒的标签，同时用来在会话记录里识别本 Hook 注入过的提醒
const REMINDER_TAG = 'responsive-mode';

/** @type {string} 上一轮未先回话或长时间静默时注入的纠偏提醒 */
export const REMINDER = `<${REMINDER_TAG}>
用户刚发来消息，正在等你回应。先用一两句话回复这条消息，说明你的理解和第一步要做什么；能直接回答的就直接回答。然后在同一条回复里接着调用工具，不要说完这句就停下。之后每完成一个阶段或有了关键发现，也用一句话告诉用户发现了什么、接下来做什么，再接着调用工具。
</${REMINDER_TAG}>`;

const classifyStep = (step) => {
  if (step?.type === 'USER_INPUT') return 'user';
  if (step?.type === 'PLANNER_RESPONSE') return 'model';
  if (
    step?.type === 'SYSTEM_MESSAGE' &&
    typeof step.content === 'string' &&
    step.content.includes(`<${REMINDER_TAG}>`)
  ) {
    return 'reminded';
  }
  return null;
};

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

const createEvaluator = (silentThreshold) => (lines, coversWholeFile) => {
  let latestUserIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const step = parseStep(lines[index]);
    if (!step) continue;
    const marker = classifyStep(step);
    if (marker === 'model' || marker === 'reminded') return false;
    if (marker === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex === -1) {
    return coversWholeFile ? false : NEED_FULL_TRANSCRIPT;
  }

  let prevUserIndex = -1;
  const prevTurnResponses = [];
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const step = parseStep(lines[index]);
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
    return coversWholeFile ? false : NEED_FULL_TRANSCRIPT;
  }

  prevTurnResponses.reverse();
  return hasResponsiveViolation(prevTurnResponses, silentThreshold);
};

const resolveResponsiveConfig = (options) => {
  if (options?.config) {
    return options.config;
  }
  return readSettings({ configPath: options?.configPath }).responsive;
};

/**
 * 处理 responsive-mode 的 PreInvocation 事件：模块或 Hook 开关关闭时直接放行；
 * 开启时仅当最近轮次标记是用户消息，且上一轮模型开场空正文直接调用工具，
 * 或中途连续达到当前静默阈值次无正文调用工具时，注入提醒纠偏。
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
  const shouldRemind = evaluateTranscript(
    transcriptPath,
    createEvaluator(threshold),
    options.windowBytes ?? TAIL_WINDOW_BYTES,
  );
  return shouldRemind ? createReminderResponse(REMINDER) : {};
};
