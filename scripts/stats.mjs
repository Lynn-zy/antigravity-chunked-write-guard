import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DEFAULT_EVENTS_PATH = path.join(PLUGIN_ROOT, 'config', 'events.jsonl');

export const RECENT_EVENTS_LIMIT = 3;

const EVENT_COUNTER_KEY = Object.freeze({
  write_oversize: 'writeOversizeCount',
  write_reminder: 'writeReminderCount',
  responsive_reminder: 'responsiveReminderCount',
  tool_locale_reminder: 'toolLocaleReminderCount',
});

const resolveEventsPath = (options) =>
  options?.eventsPath ||
  process.env.ANTIGRAVITY_RAIL_EVENTS_PATH ||
  DEFAULT_EVENTS_PATH;

const emptyStats = () => ({
  writeOversizeCount: 0,
  writeReminderCount: 0,
  responsiveReminderCount: 0,
  toolLocaleReminderCount: 0,
  recentEvents: [],
});

/**
 * 追加记录一次护栏触发事件（单行 JSONL，写失败自动静默跳过）。
 * @param {'write_oversize' | 'write_reminder' | 'responsive_reminder' | 'tool_locale_reminder'} type - 事件类型
 * @param {{ eventsPath?: string, timestamp?: string }} [options] - 可选路径与时间戳覆盖
 * @returns {boolean} 是否写入成功
 */
export const recordTriggerEvent = (type, options = {}) => {
  if (!Object.hasOwn(EVENT_COUNTER_KEY, type)) {
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
 * 读取累计触发统计（超限落盘、写入提醒、响应纠偏、摘要纠偏及最近 3 条触发记录，按时间倒序）。
 * @param {{ eventsPath?: string }} [options] - 可选事件日志路径覆盖
 * @returns {{ writeOversizeCount: number, writeReminderCount: number, responsiveReminderCount: number, toolLocaleReminderCount: number, recentEvents: Array<{ ts: string, type: 'write_oversize' | 'write_reminder' | 'responsive_reminder' | 'tool_locale_reminder' }> }} 统计结果
 */
export const readTriggerStats = (options = {}) => {
  const eventsPath = resolveEventsPath(options);
  let raw = '';
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return emptyStats();
  }

  const stats = emptyStats();
  const recent = [];

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
    const counterKey =
      entry && typeof entry === 'object' && Object.hasOwn(EVENT_COUNTER_KEY, entry.type)
        ? EVENT_COUNTER_KEY[entry.type]
        : null;
    if (!counterKey) {
      continue;
    }
    stats[counterKey] += 1;
    if (typeof entry.ts === 'string' && entry.ts) {
      recent.push({ ts: entry.ts, type: entry.type });
      if (recent.length > RECENT_EVENTS_LIMIT) {
        recent.shift();
      }
    }
  }

  stats.recentEvents = recent.reverse();
  return stats;
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
