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
    assert.match(rules, /## 分段写入规范/);
    assert.match(rules, /单次写入目标 ≤ 300 行/);
    assert.doesNotMatch(rules, /## 先回话，再动手/);
    assert.match(rules, /## 工具状态与摘要保持中文/);

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
    assert.match(minimalRules, /全部护栏模块已关闭/);
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
  assert.match(full, /## 分段写入规范/);
  assert.match(full, /超限检测与事后提醒/);
  assert.match(full, /## 先回话，再动手/);
  assert.match(full, /## 工具状态与摘要保持中文/);

  const noWriteHook = renderAgentsRule({
    ...DEFAULT_SETTINGS,
    writeGuard: { ...DEFAULT_SETTINGS.writeGuard, hookEnabled: false },
  });
  assert.match(noWriteHook, /## 分段写入规范/);
  assert.doesNotMatch(noWriteHook, /超限检测与事后提醒/);
});

test('stats records all four event types, skips corrupted lines, and resets cleanly', () => {
  const ws = createTempWorkspace();
  try {
    assert.deepEqual(readTriggerStats({ eventsPath: ws.eventsPath }), {
      writeOversizeCount: 0,
      writeReminderCount: 0,
      responsiveReminderCount: 0,
      toolLocaleReminderCount: 0,
      lastTriggeredAt: null,
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
      lastTriggeredAt: '2026-11-26T10:03:00Z',
    });

    const resetOnce = handleResetStats({ configPath: ws.configPath, eventsPath: ws.eventsPath });
    assert.equal(resetOnce.changed, true);
    assert.equal(resetOnce.state.stats.toolLocaleReminderCount, 0);

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
