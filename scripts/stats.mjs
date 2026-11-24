import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DEFAULT_EVENTS_PATH = path.join(PLUGIN_ROOT, 'config', 'events.jsonl');

const VALID_EVENT_TYPES = new Set(['oversize', 'reminder']);

const resolveEventsPath = (options) =>
  options?.eventsPath ||
  process.env.CHUNKED_WRITE_GUARD_EVENTS_PATH ||
  DEFAULT_EVENTS_PATH;

/**
 * 追加记录一次超限检测或事后提醒事件（单行 JSONL，写失败自动静默跳过）。
 * @param {'oversize' | 'reminder'} type - 事件类型（超限落盘或事后提醒）
 * @param {{ eventsPath?: string, timestamp?: string }} [options] - 可选路径与时间戳覆盖
 * @returns {boolean} 是否写入成功
 */
export const recordTriggerEvent = (type, options = {}) => {
  if (!VALID_EVENT_TYPES.has(type)) {
    return false;
  }
  const eventsPath = resolveEventsPath(options);
  const ts = options.timestamp ?? new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, `${JSON.stringify({ ts, type })}\n`, 'utf8');
    return true;
  } catch {
    // 统计写入失败不能阻断 Hook 主流程
    return false;
  }
};

/**
 * 读取累计触发统计（超限落盘次数、事后提醒次数与最近一次触发时间）。
 * @param {{ eventsPath?: string }} [options] - 可选事件日志路径覆盖
 * @returns {{ oversizeCount: number, reminderCount: number, lastTriggeredAt: string | null }} 统计结果
 */
export const readTriggerStats = (options = {}) => {
  const eventsPath = resolveEventsPath(options);
  let raw = '';
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return { oversizeCount: 0, reminderCount: 0, lastTriggeredAt: null };
  }

  let oversizeCount = 0;
  let reminderCount = 0;
  let lastTriggeredAt = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    if (entry.type === 'oversize') {
      oversizeCount += 1;
    } else if (entry.type === 'reminder') {
      reminderCount += 1;
    } else {
      continue;
    }
    if (typeof entry.ts === 'string' && entry.ts) {
      lastTriggeredAt = entry.ts;
    }
  }

  return { oversizeCount, reminderCount, lastTriggeredAt };
};

/**
 * 清零触发统计日志。
 * @param {{ eventsPath?: string }} [options] - 可选事件日志路径覆盖
 * @returns {void}
 */
export const resetTriggerStats = (options = {}) => {
  const eventsPath = resolveEventsPath(options);
  fs.rmSync(eventsPath, { force: true });
};
