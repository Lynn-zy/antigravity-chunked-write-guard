import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  RESPONSIVE_PRESET_ORDER,
  WRITE_PRESET_ORDER,
  readSettings,
  renderAgentsRule,
  syncRulesFromSettings,
} from './config.mjs';
import { readTriggerStats, recordTriggerEvent, resetTriggerStats } from './stats.mjs';
import {
  buildPanelState,
  handleResetStats,
  handleUpdateSettings,
  readChangelog,
  removeSidecarPidFile,
  writeSidecarPidFile,
} from '../sidecars/panel/panel-logic.mjs';

const createTempWorkspace = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-panel-test-'));
  return {
    tempDir,
    configPath: path.join(tempDir, 'settings.json'),
    rulesPath: path.join(tempDir, 'AGENTS.md'),
    eventsPath: path.join(tempDir, 'events.jsonl'),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
};

test('buildPanelState exposes all three modules, preset orders, and version', () => {
  const ws = createTempWorkspace();
  try {
    const state = buildPanelState({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.match(state.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(
      state.writePresets.map((p) => p.id),
      WRITE_PRESET_ORDER,
    );
    assert.deepEqual(
      state.responsivePresets.map((p) => p.threshold),
      RESPONSIVE_PRESET_ORDER,
    );
    assert.equal(state.settings.writeGuard.enabled, true);
    assert.equal(state.settings.writeGuard.presetId, '500');
    assert.equal(state.settings.responsive.silentThreshold, 6);
    assert.equal(state.settings.toolLocale.hookEnabled, true);
  } finally {
    ws.cleanup();
  }
});

test('handleUpdateSettings validates input, syncs AGENTS.md sections, and skips redundant disk writes', () => {
  const ws = createTempWorkspace();
  const opts = { configPath: ws.configPath, rulesPath: ws.rulesPath, eventsPath: ws.eventsPath };
  try {
    assert.equal(handleUpdateSettings({}, opts).ok, false);
    assert.equal(handleUpdateSettings({ unknown: {} }, opts).ok, false);
    assert.equal(handleUpdateSettings({ writeGuard: { presetId: '999' } }, opts).ok, false);
    assert.equal(handleUpdateSettings({ responsive: { silentThreshold: 7 } }, opts).ok, false);
    assert.equal(handleUpdateSettings({ toolLocale: { enabled: 'yes' } }, opts).ok, false);

    // 1. 切换分段写入为 300 档，关闭响应汇报模块，关闭摘要中文 Hook
    const first = handleUpdateSettings(
      {
        writeGuard: { presetId: '300' },
        responsive: { enabled: false },
        toolLocale: { hookEnabled: false },
      },
      opts,
    );
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);

    const rules = fs.readFileSync(ws.rulesPath, 'utf8');
    assert.match(rules, /## Chunked Write Guard/);
    assert.match(rules, /Target ≤ 300 lines per write/);
    assert.doesNotMatch(rules, /## Reply First, Report Progress/);
    assert.match(rules, /## Match User's Language for Tool Summaries/);
    assert.doesNotMatch(rules, /[\u4e00-\u9fff]/);

    // 2. 重复提交相同配置不重写文件
    const mtimeBefore = fs.statSync(ws.rulesPath).mtimeMs;
    const repeat = handleUpdateSettings({ writeGuard: { presetId: '300' } }, opts);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.changed, false);
    assert.equal(fs.statSync(ws.rulesPath).mtimeMs, mtimeBefore);

    // 3. 关闭全部三个模块时，AGENTS.md 仅保留极简注释，彻底清空规则正文
    const allOff = handleUpdateSettings(
      {
        writeGuard: { enabled: false },
        responsive: { enabled: false },
        toolLocale: { enabled: false },
      },
      opts,
    );
    assert.equal(allOff.ok, true);
    const minimalRules = fs.readFileSync(ws.rulesPath, 'utf8');
    assert.match(minimalRules, /all guardrail modules are disabled/);
    assert.doesNotMatch(minimalRules, /## /);

    // 4. syncRulesFromSettings 保留已有配置不重置
    const synced = syncRulesFromSettings(opts);
    assert.equal(synced.writeGuard.presetId, '300');
    assert.equal(synced.writeGuard.enabled, false);
    assert.equal(readSettings({ configPath: ws.configPath }).toolLocale.hookEnabled, false);
  } finally {
    ws.cleanup();
  }
});

test('renderAgentsRule includes all three sections by default and omits oversize hook item when hookEnabled=false', () => {
  const full = renderAgentsRule(DEFAULT_SETTINGS);
  assert.match(full, /## Chunked Write Guard/);
  assert.match(full, /Oversize detection & post-write reminder/);
  assert.match(full, /## Reply First, Report Progress/);
  assert.match(full, /clickable Markdown link/);
  assert.match(full, /## Match User's Language for Tool Summaries/);
  assert.doesNotMatch(full, /[\u4e00-\u9fff]/);

  const noWriteHook = renderAgentsRule({
    ...DEFAULT_SETTINGS,
    writeGuard: { ...DEFAULT_SETTINGS.writeGuard, hookEnabled: false },
  });
  assert.match(noWriteHook, /## Chunked Write Guard/);
  assert.doesNotMatch(noWriteHook, /Oversize detection & post-write reminder/);
});

test('stats records all four event types, keeps latest 3 recent events newest-first, skips corrupted lines, and resets cleanly', () => {
  const ws = createTempWorkspace();
  try {
    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      writeOversizeCount: 0,
      writeReminderCount: 0,
      responsiveReminderCount: 0,
      toolLocaleReminderCount: 0,
      recentEvents: [],
    });

    assert.equal(recordTriggerEvent('invalid', { eventsPath: ws.eventsPath }), false);
    recordTriggerEvent('write_oversize', { eventsPath: ws.eventsPath, timestamp: '2026-11-26T10:00:00Z' });
    fs.appendFileSync(ws.eventsPath, '{bad json\n', 'utf8');
    recordTriggerEvent('write_reminder', { eventsPath: ws.eventsPath, timestamp: '2026-11-26T10:01:00Z' });
    recordTriggerEvent('responsive_reminder', { eventsPath: ws.eventsPath, timestamp: '2026-11-26T10:02:00Z' });
    recordTriggerEvent('tool_locale_reminder', { eventsPath: ws.eventsPath, timestamp: '2026-11-26T10:03:00Z' });

    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      writeOversizeCount: 1,
      writeReminderCount: 1,
      responsiveReminderCount: 1,
      toolLocaleReminderCount: 1,
      recentEvents: [
        { ts: '2026-11-26T10:03:00Z', type: 'tool_locale_reminder' },
        { ts: '2026-11-26T10:02:00Z', type: 'responsive_reminder' },
        { ts: '2026-11-26T10:01:00Z', type: 'write_reminder' },
      ],
    });

    const resetOnce = handleResetStats({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(resetOnce.changed, true);
    assert.equal(resetOnce.state.stats.toolLocaleReminderCount, 0);
    assert.deepEqual(resetOnce.state.stats.recentEvents, []);

    const resetAgain = handleResetStats({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(resetAgain.changed, false);
    resetTriggerStats({ eventsPath: ws.eventsPath });

    const changelog = readChangelog();
    assert.match(changelog.markdown, /## \[3\.0\.0\]/);
    assert.equal(readChangelog({ changelogPath: path.join(ws.tempDir, 'MISSING.md') }).markdown, '');
  } finally {
    ws.cleanup();
  }
});

test('writeSidecarPidFile and removeSidecarPidFile guard against deleting a newer process PID', () => {
  const ws = createTempWorkspace();
  const pidPath = path.join(ws.tempDir, 'config', 'sidecar.pid');
  try {
    assert.equal(writeSidecarPidFile({ pidPath, pid: 0 }), false);
    assert.equal(writeSidecarPidFile({ pidPath, pid: 12345, startedAt: 1700000000000 }), true);

    const written = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    assert.deepEqual(written, { pid: 12345, startedAt: 1700000000000 });

    // 另一进程接管 PID 文件后，旧进程退出不能误删
    assert.equal(removeSidecarPidFile({ pidPath, pid: 99999 }), false);
    assert.equal(fs.existsSync(pidPath), true);

    // 仅 PID 匹配时删除
    assert.equal(removeSidecarPidFile({ pidPath, pid: 12345 }), true);
    assert.equal(fs.existsSync(pidPath), false);

    // 文件缺失时幂等返回 false
    assert.equal(removeSidecarPidFile({ pidPath, pid: 12345 }), false);
  } finally {
    ws.cleanup();
  }
});
