import fs from 'node:fs';

// 会话记录中位数约 340 KB、单行最长约 32 KB，读末尾 256 KB 通常就能覆盖最近一两轮
export const TAIL_WINDOW_BYTES = 256 * 1024;

/** @type {symbol} 评估函数返回该标记时，表示尾部窗口不足以判断，需要回退读取整份会话记录 */
export const NEED_FULL_TRANSCRIPT = Symbol('need_full_transcript');

/**
 * 解析 transcript.jsonl 中的单行 JSON；遇到半行或非法 JSON 时返回 null。
 * @param {string} line - 单行文本
 * @returns {Record<string, unknown> | null} 解析后的步骤对象或 null
 */
export const parseStep = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * 读取会话记录末尾指定字节窗口内的非空行；windowBytes 为 Infinity 时读取整份文件。
 * @param {string} transcriptPath - transcript.jsonl 路径
 * @param {number} windowBytes - 读取末尾的最大字节数
 * @returns {{ lines: string[], coversWholeFile: boolean }} 非空行数组及是否覆盖了整个文件
 */
export const readTranscriptLines = (transcriptPath, windowBytes) => {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - windowBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // 窗口没有从文件开头读起时，第一行可能只读到一半
    if (start > 0) lines.shift();
    return { lines: lines.filter((line) => line.trim() !== ''), coversWholeFile: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * 先在会话记录末尾窗口内执行评估函数，若返回 NEED_FULL_TRANSCRIPT 则回退读取整份文件再评估。
 * @template T
 * @param {string} transcriptPath - transcript.jsonl 路径
 * @param {(lines: string[], coversWholeFile: boolean) => T | symbol} evaluator - 行列表评估函数
 * @param {number} [windowBytes] - 优先读取的末尾字节数
 * @returns {T | null} 评估结果；若仍无法判定则返回 null
 */
export const evaluateTranscript = (transcriptPath, evaluator, windowBytes = TAIL_WINDOW_BYTES) => {
  const tail = readTranscriptLines(transcriptPath, windowBytes);
  let result = evaluator(tail.lines, tail.coversWholeFile);
  if (result === NEED_FULL_TRANSCRIPT) {
    result = evaluator(readTranscriptLines(transcriptPath, Infinity).lines, true);
  }
  return result === NEED_FULL_TRANSCRIPT ? null : result;
};

/**
 * 构造 PreInvocation 注入系统消息的响应对象。
 * @param {string} systemMessage - 注入给模型的系统消息文本
 * @returns {{ injectSteps: Array<{ systemMessage: { systemMessage: string } }> }} Hook 响应对象
 */
export const createReminderResponse = (systemMessage) => ({
  injectSteps: [{ systemMessage: { systemMessage } }],
});

/**
 * 读取 stdin 输入（带超时保护，避免无 EOF 时挂起）。
 * @param {number} [timeoutMs] - 超时毫秒数
 * @returns {Promise<string>} 读取到的原始文本
 */
export const readStdinAsync = (timeoutMs = 2_000) =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.resume();
  });

/**
 * 执行 PreInvocation Hook CLI 入口：读取 stdin JSON、调用处理函数、可选记录统计并输出结果。
 * 任何异常都输出 {}，确保提醒注入失败不会阻断宿主调用模型。
 * @param {(payload: Record<string, unknown>) => Record<string, unknown>} handler - 事件处理函数
 * @param {() => void} [onInject] - 实际注入提醒时的回调（用于统计记录）
 * @returns {Promise<void>} 无返回值，结果写入 stdout
 */
export const runPreInvocationHook = async (handler, onInject) => {
  let output = {};
  try {
    const raw = (await readStdinAsync()).replace(/^\uFEFF/, '');
    output = handler(raw ? JSON.parse(raw) : {});
    if (Array.isArray(output?.injectSteps) && output.injectSteps.length > 0) {
      onInject?.();
    }
  } catch {
    output = {};
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
};
