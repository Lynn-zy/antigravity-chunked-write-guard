import { readSettings } from './config.mjs';
import {
  NEED_FULL_TRANSCRIPT,
  TAIL_WINDOW_BYTES,
  createReminderResponse,
  evaluateTranscript,
  parseStep,
} from './transcript.mjs';

// 注入提醒的标签，同时用来在当前用户轮次内去重（每轮最多提醒一次）
const REMINDER_TAG = 'tool-locale';

/** @type {string} 当前轮次检测到工具摘要使用英文后注入的同轮纠偏提醒 */
export const REMINDER = `<${REMINDER_TAG}>
刚才调用 \`update_steps\` 的步骤标题、\`update_focus\` 或 \`toolSummary\` 时使用了英文。接下来的调用请一律改用中文短语（可保留必要的英文术语或命令名）。
</${REMINDER_TAG}>`;

// Antigravity 在 transcript.jsonl 里会把 tool_calls[].args 的字段值序列化成 JSON 字符串
const parseArgValue = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const isEnglishOnlyLabel = (text) =>
  typeof text === 'string' && !/[\u4e00-\u9fff]/.test(text) && /[A-Za-z]/.test(text);

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

const hasEnglishToolLabel = (step) => {
  if (step?.type !== 'PLANNER_RESPONSE' || !Array.isArray(step.tool_calls)) return false;
  return step.tool_calls.some((toolCall) => extractToolLabels(toolCall).some(isEnglishOnlyLabel));
};

const isLocaleReminderStep = (step) =>
  step?.type === 'SYSTEM_MESSAGE' &&
  typeof step.content === 'string' &&
  step.content.includes(`<${REMINDER_TAG}>`);

const evaluateLines = (lines, coversWholeFile) => {
  let foundEnglishLabel = false;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const step = parseStep(lines[index]);
    if (!step) continue;
    // 当前用户轮次内已经提醒过，直接放行，避免同轮反复刷屏
    if (isLocaleReminderStep(step)) return false;
    if (step.type === 'USER_INPUT') return foundEnglishLabel;
    if (!foundEnglishLabel && hasEnglishToolLabel(step)) {
      foundEnglishLabel = true;
    }
  }

  // 窗口内未找到本轮 USER_INPUT：若未读全文件则回退，否则说明是无用户消息的子 Agent 会话
  return coversWholeFile ? false : NEED_FULL_TRANSCRIPT;
};

const resolveLocaleConfig = (options) => {
  if (options?.config) {
    return options.config;
  }
  return readSettings({ configPath: options?.configPath }).toolLocale;
};

/**
 * 处理 tool-locale 的 PreInvocation 事件（同轮立即纠偏）：
 * 模块或 Hook 开关关闭时直接放行；开启时若当前用户轮次内刚有模型调用把
 * `update_steps` 步骤标题、`update_focus` 或 `toolSummary` 写成纯英文，
 * 即在下一次模型调用前立即注入一次提醒（同一用户轮次内最多一次）。
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
