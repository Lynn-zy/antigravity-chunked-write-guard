import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GUARD_CONFIG,
  detectRecentStreamInterruption,
  handlePreInvocation,
  handlePreToolUse,
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
  handleSetRecovery,
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
    transcriptPath: path.join(tempDir, 'transcript.jsonl'),
    eventsPath: path.join(tempDir, 'events.jsonl'),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
};

const writeTranscript = (filePath, entries) => {
  const body = entries.map((item) => JSON.stringify(item)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
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
  assert.equal(GUARD_CONFIG.maxWriteLines, 800);
  assert.equal(GUARD_CONFIG.maxWriteBytes, 48 * 1024);
  assert.equal(GUARD_CONFIG.recoveryTargetLines, 300);
});

test('PreToolUse allows and denies at exact 500-preset boundaries (800 lines / 48 KB)', () => {
  const config = getPresetConfig('500');

  const atLineLimit = handlePreToolUse(
    {
      toolCall: {
        name: 'write_file',
        args: { Path: '/tmp/ok.js', Content: makeLines(800) },
      },
    },
    { config },
  );
  assert.equal(atLineLimit.decision, 'allow');

  const atByteLimit = handlePreToolUse(
    {
      toolCall: {
        name: 'write_file',
        args: { Path: '/tmp/ok.txt', Content: 'a'.repeat(48 * 1024) },
      },
    },
    { config },
  );
  assert.equal(atByteLimit.decision, 'allow');

  const overLines = handlePreToolUse(
    {
      toolCall: {
        name: 'write_file',
        args: { Path: '/tmp/huge.html', Content: makeLines(801) },
      },
    },
    { config },
  );
  assert.equal(overLines.decision, 'deny');
  assert.match(overLines.reason, /801 行/);
  assert.match(overLines.reason, /≤ 500 行/);

  const overBytes = handlePreToolUse(
    {
      toolCall: {
        name: 'write_file',
        args: { Path: '/tmp/minified.js', Content: 'x'.repeat(48 * 1024 + 1) },
      },
    },
    { config },
  );
  assert.equal(overBytes.decision, 'deny');
  assert.match(overBytes.reason, /48\.0 KB/);
});

test('switching presets dynamically changes PreToolUse thresholds and syncs AGENTS.md', () => {
  const ws = createTempWorkspace();
  try {
    // 1. 切至 300 档（硬兜底 500 行）
    const res300 = handleSetPreset(
      { presetId: '300' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(res300.ok, true);
    assert.equal(res300.state.presetId, '300');
    assert.match(fs.readFileSync(ws.rulesPath, 'utf8'), /单次写入目标 ≤ 300 行/);
    assert.match(fs.readFileSync(ws.rulesPath, 'utf8'), /\*\*500 行\*\*或 \*\*28 KB\*\*/);

    const denyAt550 = handlePreToolUse(
      {
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/mid.html', Content: makeLines(550) },
        },
      },
      { configPath: ws.configPath },
    );
    assert.equal(denyAt550.decision, 'deny');

    // 2. 切至 700 档（硬兜底 1100 行）：同一份 550 行和 1050 行都直接放行，1101 行拦截
    const res700 = handleSetPreset(
      { presetId: '700' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(res700.ok, true);
    assert.equal(res700.state.presetId, '700');
    assert.match(fs.readFileSync(ws.rulesPath, 'utf8'), /单次写入目标 ≤ 700 行/);
    assert.match(fs.readFileSync(ws.rulesPath, 'utf8'), /≤ 400 行/);

    const allowAt1050 = handlePreToolUse(
      {
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/large.html', Content: makeLines(1050) },
        },
      },
      { configPath: ws.configPath },
    );
    assert.equal(allowAt1050.decision, 'allow');

    const denyAt1101 = handlePreToolUse(
      {
        toolCall: {
          name: 'write_file',
          args: { Path: '/tmp/huge.html', Content: makeLines(1101) },
        },
      },
      { configPath: ws.configPath },
    );
    assert.equal(denyAt1101.decision, 'deny');
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

test('PreToolUse handles Append, edit_file pure deletion, and full-file overwrite', () => {
  const config = getPresetConfig('500');

  const appendOver = handlePreToolUse(
    {
      toolCall: {
        name: 'write_file',
        args: { Path: '/tmp/proto.html', Append: true, Content: makeLines(850) },
      },
    },
    { config },
  );
  assert.equal(appendOver.decision, 'deny');
  assert.match(appendOver.reason, /write_file \(Append\)/);

  const pureDeletion = handlePreToolUse(
    {
      toolCall: {
        name: 'edit_file',
        args: { Path: '/tmp/legacy.ts', Target: makeLines(1200), Replacement: '' },
      },
    },
    { config },
  );
  assert.equal(pureDeletion.decision, 'allow');

  const hugeCombined = handlePreToolUse(
    {
      toolCall: {
        name: 'edit_file',
        args: { Path: '/tmp/full.ts', Target: makeLines(500), Replacement: makeLines(450) },
      },
    },
    { config },
  );
  assert.equal(hugeCombined.decision, 'deny');
  assert.match(hugeCombined.reason, /全量覆盖式 edit_file/);
  assert.match(hugeCombined.reason, /900 行/);

  const okCombined = handlePreToolUse(
    {
      toolCall: {
        name: 'edit_file',
        args: { Path: '/tmp/ok-edit.ts', Target: makeLines(450), Replacement: makeLines(450) },
      },
    },
    { config },
  );
  assert.equal(okCombined.decision, 'allow');
});

test('PreInvocation uses active preset recovery target and deduplicates injections', () => {
  const ws = createTempWorkspace();
  try {
    applyPreset('700', { configPath: ws.configPath, rulesPath: ws.rulesPath });
    writeTranscript(ws.transcriptPath, [
      { step_index: 1, type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'update_focus' }] },
      { step_index: 2, type: 'ERROR_MESSAGE', content: 'Error: The stream was interrupted. Please continue.' },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: '', tool_calls: [] },
      { step_index: 4, type: 'ERROR_MESSAGE', content: 'Error: The stream was interrupted. Please continue.' },
      { step_index: 5, type: 'USER_INPUT', content: '<USER_REQUEST>continue</USER_REQUEST>' },
    ]);

    const out = handlePreInvocation(
      { transcriptPath: ws.transcriptPath },
      { configPath: ws.configPath },
    );
    assert.equal(Array.isArray(out.injectSteps), true);
    const msg = out.injectSteps[0].systemMessage.systemMessage;
    assert.match(msg, /已连续中断 2 次/);
    assert.match(msg, /≤ 400 行/);

    // 注入去重标记后不再重复注入
    fs.appendFileSync(
      ws.transcriptPath,
      `${JSON.stringify({ step_index: 6, type: 'SYSTEM_MESSAGE', content: msg })}\n`,
      'utf8',
    );
    assert.deepEqual(
      handlePreInvocation({ transcriptPath: ws.transcriptPath }, { configPath: ws.configPath }),
      {},
    );
  } finally {
    ws.cleanup();
  }
});

test('detectRecentStreamInterruption handles large transcript tail slicing safely', () => {
  const ws = createTempWorkspace();
  try {
    const paddingEntries = Array.from({ length: 40 }, (_, i) => ({
      step_index: i,
      type: 'GENERIC',
      content: `padding-${i}-${'z'.repeat(250)}`,
    }));
    writeTranscript(ws.transcriptPath, [
      ...paddingEntries,
      { step_index: 99, type: 'ERROR_MESSAGE', content: 'Error: The stream was interrupted.' },
    ]);
    const res = detectRecentStreamInterruption(ws.transcriptPath, { tailBytes: 512 });
    assert.deepEqual(res, { interrupted: true, consecutiveInterrupts: 1 });
  } finally {
    ws.cleanup();
  }
});

test('renderAgentsRule includes consistent metrics for every preset', () => {
  for (const id of PRESET_ORDER) {
    const rule = renderAgentsRule(PRESETS[id]);
    assert.match(rule, new RegExp(`≤ ${PRESETS[id].softTargetLines} 行`));
    assert.match(rule, new RegExp(`\\*\\*${PRESETS[id].maxWriteLines} 行\\*\\*`));
    assert.match(rule, new RegExp(`≤ ${PRESETS[id].recoveryTargetLines} 行`));
  }
});

test('stats module records deny/recovery events, skips corrupted lines, and resets cleanly', () => {
  const ws = createTempWorkspace();
  try {
    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      denyCount: 0,
      recoveryCount: 0,
      lastTriggeredAt: null,
    });

    assert.equal(recordTriggerEvent('unknown', { eventsPath: ws.eventsPath }), false);
    assert.equal(
      recordTriggerEvent('deny', { eventsPath: ws.eventsPath, timestamp: '2026-11-23T09:00:00.000Z' }),
      true,
    );
    fs.appendFileSync(ws.eventsPath, '{corrupted json line\n', 'utf8');
    assert.equal(
      recordTriggerEvent('recovery', { eventsPath: ws.eventsPath, timestamp: '2026-11-23T09:05:00.000Z' }),
      true,
    );

    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      denyCount: 1,
      recoveryCount: 1,
      lastTriggeredAt: '2026-11-23T09:05:00.000Z',
    });

    const resetOnce = handleResetStats({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(resetOnce.changed, true);
    assert.deepEqual(resetOnce.state.stats, {
      denyCount: 0,
      recoveryCount: 0,
      lastTriggeredAt: null,
    });

    const resetAgain = handleResetStats({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(resetAgain.changed, false);
    resetTriggerStats({ eventsPath: ws.eventsPath });
    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      denyCount: 0,
      recoveryCount: 0,
      lastTriggeredAt: null,
    });
  } finally {
    ws.cleanup();
  }
});

test('CLI entrypoint records only deny/recovery events and fails open on invalid JSON', () => {
  const ws = createTempWorkspace();
  const env = { ...process.env, CHUNKED_WRITE_GUARD_EVENTS_PATH: ws.eventsPath };
  try {
    // 正常放行不写入统计日志
    const allowRun = spawnSync(process.execPath, [HOOK_ENTRY, 'pre-tool-use'], {
      input: JSON.stringify({
        toolCall: { name: 'write_file', args: { Path: '/tmp/small.js', Content: makeLines(10) } },
      }),
      env,
      encoding: 'utf8',
    });
    assert.equal(allowRun.status, 0);
    assert.equal(JSON.parse(allowRun.stdout).decision, 'allow');
    assert.equal(fs.existsSync(ws.eventsPath), false);

    // 超限拦截写入 1 条 deny
    const denyRun = spawnSync(process.execPath, [HOOK_ENTRY, 'pre-tool-use'], {
      input: JSON.stringify({
        toolCall: { name: 'write_file', args: { Path: '/tmp/big.html', Content: makeLines(1200) } },
      }),
      env,
      encoding: 'utf8',
    });
    assert.equal(denyRun.status, 0);
    assert.equal(JSON.parse(denyRun.stdout).decision, 'deny');

    // 断流恢复写入 1 条 recovery
    writeTranscript(ws.transcriptPath, [
      { step_index: 1, type: 'ERROR_MESSAGE', content: 'Error: The stream was interrupted.' },
    ]);
    const recRun = spawnSync(process.execPath, [HOOK_ENTRY, 'pre-invocation'], {
      input: JSON.stringify({ transcriptPath: ws.transcriptPath }),
      env,
      encoding: 'utf8',
    });
    assert.equal(recRun.status, 0);
    assert.equal(Array.isArray(JSON.parse(recRun.stdout).injectSteps), true);

    const stats = readTriggerStats({ eventsPath: ws.eventsPath });
    assert.equal(stats.denyCount, 1);
    assert.equal(stats.recoveryCount, 1);
    assert.equal(typeof stats.lastTriggeredAt, 'string');

    const malformedRun = spawnSync(process.execPath, [HOOK_ENTRY, 'pre-tool-use'], {
      input: '{invalid json',
      env,
      encoding: 'utf8',
    });
    assert.equal(malformedRun.status, 0);
    assert.deepEqual(JSON.parse(malformedRun.stdout), { decision: 'allow' });
  } finally {
    ws.cleanup();
  }
});

test('recovery toggle disables PreInvocation injection, updates AGENTS.md, and survives preset switches', () => {
  const ws = createTempWorkspace();
  try {
    const initial = buildPanelState({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(initial.recoveryEnabled, true);
    assert.match(initial.version, /^\d+\.\d+\.\d+$/);

    const invalid = handleSetRecovery(
      { enabled: 'no' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 400);

    const turnedOff = handleSetRecovery(
      { enabled: false },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(turnedOff.ok, true);
    assert.equal(turnedOff.changed, true);
    assert.equal(turnedOff.state.recoveryEnabled, false);
    const rulesOff = fs.readFileSync(ws.rulesPath, 'utf8');
    assert.match(rulesOff, /断流恢复提示：已关闭/);
    assert.doesNotMatch(rulesOff, /收到断流恢复提示时/);

    // 重复提交相同开关状态时短路跳过写盘
    const repeatOff = handleSetRecovery(
      { enabled: false },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(repeatOff.ok, true);
    assert.equal(repeatOff.changed, false);

    // 断流后关闭状态绝不向模型上下文注入提醒
    writeTranscript(ws.transcriptPath, [
      { step_index: 1, type: 'ERROR_MESSAGE', content: 'Error: The stream was interrupted.' },
    ]);
    assert.deepEqual(
      handlePreInvocation({ transcriptPath: ws.transcriptPath }, { configPath: ws.configPath }),
      {},
    );

    // 切换档位应保留已关闭的断流恢复开关
    const switched = handleSetPreset(
      { presetId: '300' },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(switched.ok, true);
    assert.equal(switched.state.presetId, '300');
    assert.equal(switched.state.recoveryEnabled, false);
    assert.doesNotMatch(fs.readFileSync(ws.rulesPath, 'utf8'), /收到断流恢复提示时/);

    // 重新开启后恢复正常注入
    const turnedOn = handleSetRecovery(
      { enabled: true },
      { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath },
    );
    assert.equal(turnedOn.ok, true);
    assert.equal(turnedOn.state.recoveryEnabled, true);
    const out = handlePreInvocation(
      { transcriptPath: ws.transcriptPath },
      { configPath: ws.configPath },
    );
    assert.equal(Array.isArray(out.injectSteps), true);
    assert.match(out.injectSteps[0].systemMessage.systemMessage, /≤ 200 行/);
  } finally {
    ws.cleanup();
  }
});
