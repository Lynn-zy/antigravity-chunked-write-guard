import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WRITE_PRESET_ID,
  WRITE_PRESET_ORDER,
  getWriteGuardConfig,
  updateSettings,
} from './config.mjs';
import { readTriggerStats } from './stats.mjs';
import {
  GUARD_CONFIG,
  handlePostToolUse,
  handlePreInvocation,
  measureText,
} from './write-guard-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = path.join(SCRIPT_DIR, 'write-guard-hook.mjs');

const makeLines = (count, lineText = 'const x = 1;') =>
  Array.from({ length: count }, () => lineText).join('\n');

const createTempWorkspace = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-write-guard-test-'));
  return {
    tempDir,
    configPath: path.join(tempDir, 'settings.json'),
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

test('default write preset is 500 and order is 700 / 500 / 300', () => {
  assert.equal(DEFAULT_WRITE_PRESET_ID, '500');
  assert.deepEqual(WRITE_PRESET_ORDER, ['700', '500', '300']);
  assert.equal(GUARD_CONFIG.softTargetLines, 500);
  assert.equal(GUARD_CONFIG.warnWriteLines, 800);
  assert.equal(GUARD_CONFIG.warnWriteBytes, 48 * 1024);
  assert.equal(GUARD_CONFIG.warnEditCombinedLines, 900);
  assert.equal(GUARD_CONFIG.warnEditCombinedBytes, 56 * 1024);
});

test('PostToolUse detects oversize writes at exact 500-preset boundaries and queues reminder', () => {
  const ws = createTempWorkspace();
  try {
    const config = getWriteGuardConfig('500');
    const opts = { config, pendingDir: ws.pendingDir, now: () => 1_000_000 };

    assert.equal(
      handlePostToolUse(
        {
          conversationId: 'conv-boundary',
          toolCall: { name: 'write_file', args: { Path: '/tmp/ok.js', Content: makeLines(800) } },
        },
        opts,
      ).oversize,
      false,
    );

    assert.equal(
      handlePostToolUse(
        {
          conversationId: 'conv-boundary',
          toolCall: { name: 'write_file', args: { Path: '/tmp/ok.txt', Content: 'a'.repeat(48 * 1024) } },
        },
        opts,
      ).oversize,
      false,
    );

    const overLines = handlePostToolUse(
      {
        conversationId: 'conv-boundary',
        toolCall: { name: 'write_file', args: { Path: '/tmp/huge.html', Content: makeLines(801) } },
      },
      opts,
    );
    assert.equal(overLines.oversize, true);
    assert.equal(overLines.queued, true);

    const injected = handlePreInvocation({ conversationId: 'conv-boundary' }, opts);
    const msg = injected.injectSteps[0].systemMessage.systemMessage;
    assert.match(msg, /was allowed to finish/);
    assert.match(msg, /801 lines/);
    assert.match(msg, /≤ 500-line/);
    assert.doesNotMatch(msg, /[\u4e00-\u9fff]/);

    // 消费一次后再次进入 PreInvocation 不再重复注入
    assert.deepEqual(handlePreInvocation({ conversationId: 'conv-boundary' }, opts), {});
  } finally {
    ws.cleanup();
  }
});

test('PostToolUse ignores failed calls, pure deletions, and merges Append + combined edit_file', () => {
  const ws = createTempWorkspace();
  try {
    const config = getWriteGuardConfig('500');
    const opts = { config, pendingDir: ws.pendingDir, now: () => 2_000_000 };

    assert.equal(
      handlePostToolUse(
        {
          conversationId: 'conv-edge',
          error: 'target not found',
          toolCall: { name: 'edit_file', args: { Path: '/tmp/a.ts', Target: makeLines(600), Replacement: makeLines(600) } },
        },
        opts,
      ).oversize,
      false,
    );

    assert.equal(
      handlePostToolUse(
        {
          conversationId: 'conv-edge',
          toolCall: { name: 'edit_file', args: { Path: '/tmp/legacy.ts', Target: makeLines(1200), Replacement: '' } },
        },
        opts,
      ).oversize,
      false,
    );

    assert.equal(
      handlePostToolUse(
        {
          conversationId: 'conv-edge',
          toolCall: { name: 'write_file', args: { Path: '/tmp/proto.html', Append: true, Content: makeLines(850) } },
        },
        opts,
      ).oversize,
      true,
    );

    assert.equal(
      handlePostToolUse(
        {
          conversationId: 'conv-edge',
          toolCall: { name: 'edit_file', args: { Path: '/tmp/full.ts', Target: makeLines(500), Replacement: makeLines(450) } },
        },
        opts,
      ).oversize,
      true,
    );

    assert.deepEqual(handlePreInvocation({ conversationId: 'conv-other' }, opts), {});

    const merged = handlePreInvocation({ conversationId: 'conv-edge' }, opts);
    const text = merged.injectSteps[0].systemMessage.systemMessage;
    assert.match(text, /2 oversize writes were allowed to finish/);
    assert.match(text, /write_file \(Append\)/);
    assert.match(text, /Target \+ Replacement: 950 lines/);
  } finally {
    ws.cleanup();
  }
});

test('module enabled and hookEnabled switches control detection and injection dynamically', () => {
  const ws = createTempWorkspace();
  try {
    // 1. 模块关闭：不记超限、不排队
    updateSettings(
      { writeGuard: { enabled: false } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    const whenModuleOff = handlePostToolUse(
      {
        conversationId: 'conv-sw',
        toolCall: { name: 'write_file', args: { Path: '/tmp/big.ts', Content: makeLines(1200) } },
      },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(whenModuleOff.oversize, false);
    assert.equal(whenModuleOff.queued, false);

    // 2. 模块开启但 Hook 关闭：仅报超限统计，不排队、不注入
    updateSettings(
      { writeGuard: { enabled: true, hookEnabled: false, presetId: '300' } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    const whenHookOff = handlePostToolUse(
      {
        conversationId: 'conv-sw',
        toolCall: { name: 'write_file', args: { Path: '/tmp/mid.ts', Content: makeLines(550) } },
      },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.equal(whenHookOff.oversize, true);
    assert.equal(whenHookOff.queued, false);
    assert.deepEqual(
      handlePreInvocation({ conversationId: 'conv-sw' }, { configPath: ws.configPath, pendingDir: ws.pendingDir }),
      {},
    );

    // 3. 重新开启 Hook：按 300 档提醒
    updateSettings(
      { writeGuard: { hookEnabled: true } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.equal(
      handlePostToolUse(
        {
          conversationId: 'conv-sw',
          toolCall: { name: 'write_file', args: { Path: '/tmp/mid2.ts', Content: makeLines(550) } },
        },
        { configPath: ws.configPath, pendingDir: ws.pendingDir },
      ).queued,
      true,
    );
    const out = handlePreInvocation(
      { conversationId: 'conv-sw' },
      { configPath: ws.configPath, pendingDir: ws.pendingDir },
    );
    assert.match(out.injectSteps[0].systemMessage.systemMessage, /≤ 300-line/);
  } finally {
    ws.cleanup();
  }
});

test('PreInvocation drops expired pending notices and prunes stale files', () => {
  const ws = createTempWorkspace();
  try {
    const config = getWriteGuardConfig('500');
    const t0 = 1_000_000;
    handlePostToolUse(
      {
        conversationId: 'conv-expire',
        toolCall: { name: 'write_file', args: { Path: '/tmp/old.ts', Content: makeLines(900) } },
      },
      { config, pendingDir: ws.pendingDir, now: () => t0 },
    );
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

test('CLI write-guard-hook runs post-tool-use -> pre-invocation, records stats, and fails open', () => {
  const ws = createTempWorkspace();
  const env = {
    ...process.env,
    ANTIGRAVITY_RAIL_CONFIG_PATH: ws.configPath,
    ANTIGRAVITY_RAIL_EVENTS_PATH: ws.eventsPath,
    ANTIGRAVITY_RAIL_PENDING_DIR: ws.pendingDir,
  };
  try {
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

    const preRun = spawnSync(process.execPath, [HOOK_ENTRY, 'pre-invocation'], {
      input: JSON.stringify({ conversationId: 'conv-cli' }),
      env,
      encoding: 'utf8',
    });
    assert.equal(preRun.status, 0);
    assert.match(JSON.parse(preRun.stdout).injectSteps[0].systemMessage.systemMessage, /1200 lines/);

    const stats = readTriggerStats({ eventsPath: ws.eventsPath });
    assert.equal(stats.writeOversizeCount, 1);
    assert.equal(stats.writeReminderCount, 1);

    const malformed = spawnSync(process.execPath, [HOOK_ENTRY, 'post-tool-use'], {
      input: '{invalid json',
      env,
      encoding: 'utf8',
    });
    assert.equal(malformed.status, 0);
    assert.deepEqual(JSON.parse(malformed.stdout), {});
  } finally {
    ws.cleanup();
  }
});
