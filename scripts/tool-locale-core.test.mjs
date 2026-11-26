import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateSettings } from './config.mjs';
import { readTriggerStats } from './stats.mjs';
import { REMINDER, handlePreInvocation } from './tool-locale-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = path.join(SCRIPT_DIR, 'tool-locale-hook.mjs');
const REMINDED = { injectSteps: [{ systemMessage: { systemMessage: REMINDER } }] };

const userInput = (text) => ({
  type: 'USER_INPUT',
  source: 'USER_EXPLICIT',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
});
const plannerResponse = (content = '', toolCalls = []) => ({
  type: 'PLANNER_RESPONSE',
  source: 'MODEL',
  content,
  tool_calls: toolCalls,
});
const toolResult = () => ({
  type: 'GENERIC',
  source: 'MODEL',
  content: 'Created At: 2026-11-26T09:31:11+08:00',
});
const systemMessage = (text) => ({
  type: 'SYSTEM_MESSAGE',
  source: 'SYSTEM',
  content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n${text}\n</SYSTEM_MESSAGE>`,
});

const createTempEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-locale-test-'));
  return {
    dir,
    configPath: path.join(dir, 'settings.json'),
    rulesPath: path.join(dir, 'AGENTS.md'),
    eventsPath: path.join(dir, 'events.jsonl'),
    writeTranscript: (steps) => {
      const p = path.join(dir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
      const lines = steps.map((step, index) => JSON.stringify({ step_index: index, status: 'DONE', ...step }));
      fs.writeFileSync(p, `${lines.join('\n')}\n`, 'utf8');
      return p;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

test('同轮检测到 toolSummary / update_focus / update_steps 纯英文时立即提醒，每轮最多一次', () => {
  const ws = createTempEnv();
  try {
    const freshTurn = ws.writeTranscript([userInput('跑测试')]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: freshTurn }, { configPath: ws.configPath }), {});

    const enSummary = ws.writeTranscript([
      userInput('跑测试'),
      plannerResponse('先跑测试。', [
        { name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run unit tests"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: enSummary }, { configPath: ws.configPath }), REMINDED);

    const enFocus = ws.writeTranscript([
      userInput('查认证'),
      plannerResponse('先查一下。', [
        { name: 'update_focus', args: { focus: '"Inspecting auth flow"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: enFocus }, { configPath: ws.configPath }), REMINDED);

    const enStep = ws.writeTranscript([
      userInput('合代码'),
      plannerResponse('列一下步骤。', [
        {
          name: 'update_steps',
          args: {
            steps: JSON.stringify([
              { title: '检查 Git 状态', status: 'done' },
              { title: 'Merge branch into main', status: 'in_progress' },
            ]),
          },
        },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: enStep }, { configPath: ws.configPath }), REMINDED);

    // 同一轮已提醒一次后不再重复提醒
    const alreadyReminded = ws.writeTranscript([
      userInput('跑测试'),
      plannerResponse('先跑测试。', [{ name: 'run_command', args: { toolSummary: '"Run tests"' } }]),
      toolResult(),
      systemMessage(REMINDER),
      plannerResponse('再查 diff。', [{ name: 'run_command', args: { toolSummary: '"Check diff"' } }]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: alreadyReminded }, { configPath: ws.configPath }), {});
  } finally {
    ws.cleanup();
  }
});

test('中文混排短语、新用户轮次重置、子 Agent、截断 JSON 与开关控制均正常', () => {
  const ws = createTempEnv();
  try {
    const mixedOk = ws.writeTranscript([
      userInput('跑测试'),
      plannerResponse('先跑。', [
        { name: 'update_focus', args: { focus: '"排查 config.mjs 配置加载"' } },
        { name: 'run_command', args: { toolSummary: '"运行 npm test 并检查 Git 状态"' } },
        {
          name: 'update_steps',
          args: { steps: JSON.stringify([{ title: '修改 config.mjs', status: 'done' }]) },
        },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: mixedOk }, { configPath: ws.configPath }), {});

    const subagent = ws.writeTranscript([
      systemMessage('Subagent'),
      plannerResponse('', [{ name: 'run_command', args: { toolSummary: '"Check diff"' } }]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: subagent }, { configPath: ws.configPath }), {});

    const brokenJson = ws.writeTranscript([
      userInput('列步骤'),
      plannerResponse('列一下。', [{ name: 'update_steps', args: { steps: '[{"title":"broken' } }]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: brokenJson }, { configPath: ws.configPath }), {});

    const violating = ws.writeTranscript([
      userInput('跑测试'),
      plannerResponse('先跑。', [{ name: 'run_command', args: { toolSummary: '"Run unit tests"' } }]),
      { type: 'GENERIC', source: 'MODEL', content: 'x'.repeat(4096) },
    ]);
    assert.deepEqual(
      handlePreInvocation({ transcriptPath: violating }, { configPath: ws.configPath, windowBytes: 1024 }),
      REMINDED,
    );

    // 关闭 Hook 开关或模块总开关后不提醒
    updateSettings(
      { toolLocale: { hookEnabled: false } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.deepEqual(handlePreInvocation({ transcriptPath: violating }, { configPath: ws.configPath }), {});

    updateSettings(
      { toolLocale: { enabled: false, hookEnabled: true } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.deepEqual(handlePreInvocation({ transcriptPath: violating }, { configPath: ws.configPath }), {});
  } finally {
    ws.cleanup();
  }
});

test('CLI tool-locale-hook 输出提醒并记录 tool_locale_reminder 统计，非法输入输出 {}', () => {
  const ws = createTempEnv();
  const env = {
    ...process.env,
    ANTIGRAVITY_RAIL_CONFIG_PATH: ws.configPath,
    ANTIGRAVITY_RAIL_EVENTS_PATH: ws.eventsPath,
  };
  try {
    const transcriptPath = ws.writeTranscript([
      userInput('跑测试'),
      plannerResponse('先跑。', [{ name: 'run_command', args: { toolSummary: '"Run unit tests"' } }]),
      toolResult(),
    ]);
    const ok = spawnSync(process.execPath, [HOOK_ENTRY], {
      input: JSON.stringify({ hookEventName: 'PreInvocation', transcriptPath }),
      env,
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0);
    assert.deepEqual(JSON.parse(ok.stdout), REMINDED);
    assert.equal(readTriggerStats({ eventsPath: ws.eventsPath }).toolLocaleReminderCount, 1);

    const bad = spawnSync(process.execPath, [HOOK_ENTRY], {
      input: 'not json',
      env,
      encoding: 'utf8',
    });
    assert.equal(bad.status, 0);
    assert.deepEqual(JSON.parse(bad.stdout), {});
  } finally {
    ws.cleanup();
  }
});
