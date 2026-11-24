import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GUARD_CONFIG,
  handlePostToolUse,
  handlePreInvocation,
  measureText,
} from './hook-core.mjs';
import {
  DEFAULT_PRESET_ID,
  PRESETS,
  PRESET_ORDER,
  applyPreset,
  getPresetConfig,
  readActivePresetState,
  renderAgentsRule,
} from './presets.mjs';
import {
  recordTriggerEvent,
  readTriggerStats,
  resetTriggerStats,
} from './stats.mjs';
import {
  buildPanelState,
  handleResetStats,
  handleSetPreset,
  handleSetReminder,
  readChangelog,
} from '../sidecars/panel/panel-logic.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = path.join(SCRIPT_DIR, 'write-guard-hook.mjs');

const makeLines = (count, lineText = 'const x = 1;') =>
  Array.from({ length: count }, () => lineText).join('\n');

const createTempWorkspace = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunked-write-guard-test-'));
  return {
    tempDir,
    configPath: path.join(tempDir, 'active-preset.json'),
    rulesPath: path.join(tempDir, 'AGENTS.md'),
    eventsPath: path.join(tempDir, 'events.jsonl'),
    pendingDir: path.join(tempDir, 'pending'),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
};

test('measureText accurately counts lines and UTF-8 bytes', () => {
  assert.deepEqual(measureText(''), { lines: 0, bytes: 0 });
  assert.deepEqual(measureText('hello'), { lines: 1, bytes: 5 });
  assert.deepEqual(measureText('a\nb\n'), { lines: 2, bytes: 4 });
  assert.deepEqual(measureText('中文\n第二行'), {
    lines: 2,
    bytes: Buffer.byteLength('中文\n第二行', 'utf8'),
  });
});

test('default preset is 500 and preset order is 700 / 500 / 300', () => {
  assert.equal(DEFAULT_PRESET_ID, '500');
  assert.deepEqual(PRESET_ORDER, ['700', '500', '300']);
  assert.equal(GUARD_CONFIG.softTargetLines, 500);
  assert.equal(GUARD_CONFIG.warnWriteLines, 800);
  assert.equal(GUARD_CONFIG.warnWriteBytes, 48 * 1024);
  assert.equal(GUARD_CONFIG.warnEditCombinedLines, 900);
  assert.equal(GUARD_CONFIG.warnEditCombinedBytes, 56 * 1024);
});

test('PostToolUse detects oversize writes at exact 500-preset boundaries and queues reminder', () => {
  const ws = createTempWorkspace();
  try {
    const config = getPresetConfig('500');
    const opts = { config, pendingDir: ws.pendingDir, now: () => 1_000_000 };

    // 刚好在行数与字节警戒线上，不触发超限
    const atLineLimit = handlePostToolUse(
      {
        conversationId: 'conv-boundary',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/ok.js', Content: makeLines(800) },
        },
      },
      opts,
    );
    assert.equal(atLineLimit.oversize, false);
    assert.equal(atLineLimit.queued, false);

    const atByteLimit = handlePostToolUse(
      {
        conversationId: 'conv-boundary',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/ok.txt', Content: 'a'.repeat(48 * 1024) },
        },
      },
      opts,
    );
    assert.equal(atByteLimit.oversize, false);

    // 超过行数警戒线 -> 标记超限并排队事后提醒
    const overLines = handlePostToolUse(
      {
        conversationId: 'conv-boundary',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/huge.html', Content: makeLines(801) },
        },
      },
      opts,
    );
    assert.equal(overLines.oversize, true);
    assert.equal(overLines.queued, true);
    assert.equal(overLines.notice.lines, 801);

    const injected = handlePreInvocation({ conversationId: 'conv-boundary' }, opts);
    assert.equal(Array.isArray(injected.injectSteps), true);
    const msg = injected.injectSteps[0].systemMessage.systemMessage;
    assert.match(msg, /已放行落盘/);
    assert.match(msg, /801 行/);
    assert.match(msg, /≤ 500 行/);

    // 消费一次后再次进入 PreInvocation 不再重复注入
    assert.deepEqual(handlePreInvocation({ conversationId: 'conv-boundary' }, opts), {});

    // 超过字节警戒线同样触发
    const overBytes = handlePostToolUse(
      {
        conversationId: 'conv-bytes',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/minified.js', Content: 'x'.repeat(48 * 1024 + 1) },
        },
      },
      opts,
    );
    assert.equal(overBytes.oversize, true);
    const bytesMsg =
      handlePreInvocation({ conversationId: 'conv-bytes' }, opts).injectSteps[0].systemMessage
        .systemMessage;
    assert.match(bytesMsg, /48\.0 KB/);
  } finally {
    ws.cleanup();
  }
});

test('switching presets dynamically updates PostToolUse thresholds and syncs AGENTS.md', () => {
  const ws = createTempWorkspace();
  try {
    // 1. 切至 300 档（警戒线 500 行 / 28 KB）
    const res300 = handleSetPreset(
      { presetId: '300' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(res300.ok, true);
    assert.equal(res300.state.presetId, '300');
    const rule300 = fs.readFileSync(ws.rulesPath, 'utf8');
    assert.match(rule300, /单次写入目标 ≤ 300 行/);
    assert.match(rule300, /\*\*500 行\*\*或 \*\*28 KB\*\*/);

    const warnAt550 = handlePostToolUse(
      {
        conversationId: 'conv-switch',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/mid.html', Content: makeLines(550) },
        },
      },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(warnAt550.oversize, true);

    // 2. 切至 700 档（警戒线 1100 行 / 64 KB）：1050 行不超限，1101 行触发超限
    const res700 = handleSetPreset(
      { presetId: '700' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(res700.ok, true);
    assert.equal(res700.state.presetId, '700');
    assert.match(fs.readFileSync(ws.rulesPath, 'utf8'), /单次写入目标 ≤ 700 行/);

    const okAt1050 = handlePostToolUse(
      {
        conversationId: 'conv-switch-700',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/large.html', Content: makeLines(1050) },
        },
      },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(okAt1050.oversize, false);

    const warnAt1101 = handlePostToolUse(
      {
        conversationId: 'conv-switch-700',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/huge.html', Content: makeLines(1101) },
        },
      },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(warnAt1101.oversize, true);
  } finally {
    ws.cleanup();
  }
});

test('PostToolUse ignores failed tool calls, pure deletions, and handles Append and full-file edit_file', () => {
  const ws = createTempWorkspace();
  try {
    const config = getPresetConfig('500');
    const opts = { config, pendingDir: ws.pendingDir, now: () => 2_000_000 };

    // 工具执行失败（未落盘）不记超限
    const failedCall = handlePostToolUse(
      {
        conversationId: 'conv-edge',
        error: 'target string not found',
        toolCall: {
          name: 'edit_file',
          args: { Path: '/tmp/a.ts', Target: makeLines(600), Replacement: makeLines(600) },
        },
      },
      opts,
    );
    assert.equal(failedCall.oversize, false);

    // 纯删除（Replacement 为空）不记超限
    const pureDeletion = handlePostToolUse(
      {
        conversationId: 'conv-edge',
        toolCall: {
          name: 'edit_file',
          args: { Path: '/tmp/legacy.ts', Target: makeLines(1200), Replacement: '' },
        },
      },
      opts,
    );
    assert.equal(pureDeletion.oversize, false);

    // 合法合并行数（900 行以内）不记超限
    const okCombined = handlePostToolUse(
      {
        conversationId: 'conv-edge',
        toolCall: {
          name: 'edit_file',
          args: { Path: '/tmp/ok-edit.ts', Target: makeLines(450), Replacement: makeLines(450) },
        },
      },
      opts,
    );
    assert.equal(okCombined.oversize, false);

    // Append 超限与全量覆盖式 edit_file 超限在同一会话中合并为一条提醒
    const appendOver = handlePostToolUse(
      {
        conversationId: 'conv-edge',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/proto.html', Append: true, Content: makeLines(850) },
        },
      },
      opts,
    );
    assert.equal(appendOver.oversize, true);

    const hugeCombined = handlePostToolUse(
      {
        conversationId: 'conv-edge',
        toolCall: {
          name: 'edit_file',
          args: { Path: '/tmp/full.ts', Target: makeLines(500), Replacement: makeLines(450) },
        },
      },
      opts,
    );
    assert.equal(hugeCombined.oversize, true);

    // 另一会话不会串扰
    assert.deepEqual(handlePreInvocation({ conversationId: 'conv-other' }, opts), {});

    const merged = handlePreInvocation({ conversationId: 'conv-edge' }, opts);
    assert.equal(merged.injectSteps.length, 1);
    const text = merged.injectSteps[0].systemMessage.systemMessage;
    assert.match(text, /2 次超限写入已放行落盘/);
    assert.match(text, /write_file \(Append\)/);
    assert.match(text, /Target \+ Replacement 合计 950 行/);
    assert.match(text, /缩小 edit_file 的 Target 锚点范围/);
  } finally {
    ws.cleanup();
  }
});

test('PreInvocation drops expired pending notices and prunes stale files', () => {
  const ws = createTempWorkspace();
  try {
    const config = getPresetConfig('500');
    const t0 = 1_000_000;

    handlePostToolUse(
      {
        conversationId: 'conv-expire',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/old.ts', Content: makeLines(900) },
        },
      },
      { config, pendingDir: ws.pendingDir, now: () => t0 },
    );

    // 超过 30 分钟 TTL 后应丢弃不注入，并清理待提醒文件
    const afterTtl = handlePreInvocation(
      { conversationId: 'conv-expire' },
      { config, pendingDir: ws.pendingDir, now: () => t0 + 31 * 60 * 1000 },
    );
    assert.deepEqual(afterTtl, {});
    assert.equal(fs.readdirSync(ws.pendingDir).length, 0);
  } finally {
    ws.cleanup();
  }
});

test('panel-logic rejects invalid presetId and exposes presets in 700/500/300 order', () => {
  const ws = createTempWorkspace();
  try {
    const initial = buildPanelState({ configPath: ws.configPath, rulesPath: ws.rulesPath });
    assert.equal(initial.presetId, '500');
    assert.deepEqual(
      initial.presets.map((p) => p.id),
      ['700', '500', '300'],
    );

    const invalid = handleSetPreset(
      { presetId: '999' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 400);
    assert.equal(readActivePresetState({ configPath: ws.configPath }).presetId, '500');

    // 首次切换落盘，再次提交同一档位应短路跳过磁盘写入
    const first = handleSetPreset(
      { presetId: '300' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    const firstUpdatedAt = first.state.updatedAt;
    const firstMtime = fs.statSync(ws.rulesPath).mtimeMs;

    const repeat = handleSetPreset(
      { presetId: '300' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(repeat.ok, true);
    assert.equal(repeat.changed, false);
    assert.equal(repeat.state.updatedAt, firstUpdatedAt);
    assert.equal(fs.statSync(ws.rulesPath).mtimeMs, firstMtime);
  } finally {
    ws.cleanup();
  }
});

test('renderAgentsRule includes consistent metrics for every preset', () => {
  for (const id of PRESET_ORDER) {
    const rule = renderAgentsRule(PRESETS[id]);
    assert.match(rule, new RegExp(`≤ ${PRESETS[id].softTargetLines} 行`));
    assert.match(rule, new RegExp(`\\*\\*${PRESETS[id].warnWriteLines} 行\\*\\*`));
    assert.doesNotMatch(rule, /PreToolUse/);
    assert.doesNotMatch(rule, /断流恢复/);
  }
});

test('stats module records oversize/reminder events, skips corrupted lines, and resets cleanly', () => {
  const ws = createTempWorkspace();
  try {
    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      oversizeCount: 0,
      reminderCount: 0,
      lastTriggeredAt: null,
    });

    assert.equal(recordTriggerEvent('unknown', { eventsPath: ws.eventsPath }), false);
    assert.equal(
      recordTriggerEvent('oversize', {
        eventsPath: ws.eventsPath,
        timestamp: '2026-11-24T09:00:00.000Z',
      }),
      true,
    );
    fs.appendFileSync(ws.eventsPath, '{corrupted json line\n', 'utf8');
    assert.equal(
      recordTriggerEvent('reminder', {
        eventsPath: ws.eventsPath,
        timestamp: '2026-11-24T09:05:00.000Z',
      }),
      true,
    );

    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      oversizeCount: 1,
      reminderCount: 1,
      lastTriggeredAt: '2026-11-24T09:05:00.000Z',
    });

    const resetOnce = handleResetStats({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(resetOnce.changed, true);
    assert.deepEqual(resetOnce.state.stats, {
      oversizeCount: 0,
      reminderCount: 0,
      lastTriggeredAt: null,
    });

    const resetAgain = handleResetStats({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(resetAgain.changed, false);
    resetTriggerStats({ eventsPath: ws.eventsPath });
    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      oversizeCount: 0,
      reminderCount: 0,
      lastTriggeredAt: null,
    });
  } finally {
    ws.cleanup();
  }
});

test('CLI entrypoint runs post-tool-use -> pre-invocation loop, records stats, and fails open', () => {
  const ws = createTempWorkspace();
  const env = {
    ...process.env,
    CHUNKED_WRITE_GUARD_EVENTS_PATH: ws.eventsPath,
    CHUNKED_WRITE_GUARD_PENDING_DIR: ws.pendingDir,
  };
  try {
    // 1. 正常小文件写入：无统计写入，下一轮 PreInvocation 返回 {}
    const smallRun = spawnSync(process.execPath, [HOOK_ENTRY, 'post-tool-use'], {
      input: JSON.stringify({
        conversationId: 'conv-cli',
        toolCall: { name: 'write_file', args: { Path: '/tmp/small.js', Content: makeLines(10) } },
      }),
      env,
      encoding: 'utf8',
    });
    assert.equal(smallRun.status, 0);
    assert.deepEqual(JSON.parse(smallRun.stdout), {});
    assert.equal(fs.existsSync(ws.eventsPath), false);

    // 2. 超限大文件写入：输出 {} 不阻断落盘，同时记录 oversize 并排队
    const bigRun = spawnSync(process.execPath, [HOOK_ENTRY, 'post-tool-use'], {
      input: JSON.stringify({
        conversationId: 'conv-cli',
        toolCall: { name: 'write_file', args: { Path: '/tmp/big.html', Content: makeLines(1200) } },
      }),
      env,
      encoding: 'utf8',
    });
    assert.equal(bigRun.status, 0);
    assert.deepEqual(JSON.parse(bigRun.stdout), {});

    // 3. 下一轮 PreInvocation 消费提醒并记录 1 条 reminder
    const preRun = spawnSync(process.execPath, [HOOK_ENTRY, 'pre-invocation'], {
      input: JSON.stringify({ conversationId: 'conv-cli' }),
      env,
      encoding: 'utf8',
    });
    assert.equal(preRun.status, 0);
    const preOut = JSON.parse(preRun.stdout);
    assert.equal(Array.isArray(preOut.injectSteps), true);
    assert.match(preOut.injectSteps[0].systemMessage.systemMessage, /1200 行/);

    // 4. 再次调用 PreInvocation 返回 {}（去重生效）
    const preAgain = spawnSync(process.execPath, [HOOK_ENTRY, 'pre-invocation'], {
      input: JSON.stringify({ conversationId: 'conv-cli' }),
      env,
      encoding: 'utf8',
    });
    assert.equal(preAgain.status, 0);
    assert.deepEqual(JSON.parse(preAgain.stdout), {});

    const stats = readTriggerStats({ eventsPath: ws.eventsPath });
    assert.equal(stats.oversizeCount, 1);
    assert.equal(stats.reminderCount, 1);
    assert.equal(typeof stats.lastTriggeredAt, 'string');

    // 5. 非法 JSON 自动 fail-open 输出 {}
    const malformedRun = spawnSync(process.execPath, [HOOK_ENTRY, 'post-tool-use'], {
      input: '{invalid json',
      env,
      encoding: 'utf8',
    });
    assert.equal(malformedRun.status, 0);
    assert.deepEqual(JSON.parse(malformedRun.stdout), {});
  } finally {
    ws.cleanup();
  }
});

test('reminder toggle controls context injection, updates AGENTS.md, and survives preset switches', () => {
  const ws = createTempWorkspace();
  try {
    const initial = buildPanelState({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(initial.reminderEnabled, true);
    assert.match(initial.version, /^\d+\.\d+\.\d+$/);

    const invalid = handleSetReminder(
      { enabled: 'no' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 400);

    const turnedOff = handleSetReminder(
      { enabled: false },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(turnedOff.ok, true);
    assert.equal(turnedOff.changed, true);
    assert.equal(turnedOff.state.reminderEnabled, false);
    const rulesOff = fs.readFileSync(ws.rulesPath, 'utf8');
    assert.match(rulesOff, /超限事后提醒：已关闭/);
    assert.doesNotMatch(rulesOff, /超限检测与事后提醒/);

    // 重复提交相同开关状态时短路跳过写盘
    const repeatOff = handleSetReminder(
      { enabled: false },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(repeatOff.ok, true);
    assert.equal(repeatOff.changed, false);

    // 关闭状态下：PostToolUse 仍上报 oversize（用于统计），但不排队、不向模型上下文注入
    const detectedOff = handlePostToolUse(
      {
        conversationId: 'conv-toggle',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/big.ts', Content: makeLines(950) },
        },
      },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(detectedOff.oversize, true);
    assert.equal(detectedOff.queued, false);
    assert.deepEqual(
      handlePreInvocation(
        { conversationId: 'conv-toggle' },
        { configPath: ws.configPath, pendingDir: ws.pendingDir },
      ),
      {},
    );

    // 切换档位应保留已关闭的提醒开关
    const switched = handleSetPreset(
      { presetId: '300' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(switched.ok, true);
    assert.equal(switched.state.presetId, '300');
    assert.equal(switched.state.reminderEnabled, false);
    assert.doesNotMatch(fs.readFileSync(ws.rulesPath, 'utf8'), /超限检测与事后提醒/);

    // 重新开启后恢复正常提醒（按 300 档目标 ≤ 300 行提醒）
    const turnedOn = handleSetReminder(
      { enabled: true },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(turnedOn.ok, true);
    assert.equal(turnedOn.state.reminderEnabled, true);
    const detectedOn = handlePostToolUse(
      {
        conversationId: 'conv-toggle',
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/big2.ts', Content: makeLines(600) },
        },
      },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(detectedOn.oversize, true);
    assert.equal(detectedOn.queued, true);

    const out = handlePreInvocation(
      { conversationId: 'conv-toggle' },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(Array.isArray(out.injectSteps), true);
    assert.match(out.injectSteps[0].systemMessage.systemMessage, /≤ 300 行/);

    // 读取本地变更日志：文件存在返回内容，缺失时 fail-open 返回空字符串
    const changelog = readChangelog();
    assert.match(changelog.version, /^\d+\.\d+\.\d+$/);
    assert.match(changelog.markdown, /## \[1\.3\.0\]/);
    const missing = readChangelog({ changelogPath: path.join(ws.tempDir, 'MISSING.md') });
    assert.equal(missing.markdown, '');
  } finally {
    ws.cleanup();
  }
});

test('applyPreset falls back reminderEnabled to true when reading legacy config without reminderEnabled', () => {
  const ws = createTempWorkspace();
  try {
    fs.writeFileSync(
      ws.configPath,
      `${JSON.stringify({ presetId: '700', updatedAt: '2026-11-23T00:00:00.000Z' })}\n`,
      'utf8',
    );
    const state = readActivePresetState({ configPath: ws.configPath });
    assert.equal(state.presetId, '700');
    assert.equal(state.reminderEnabled, true);
    const applied = applyPreset(state.presetId, {
      configPath: ws.configPath,
      rulesPath: ws.rulesPath,
    });
    assert.equal(applied.reminderEnabled, true);
  } finally {
    ws.cleanup();
  }
});
