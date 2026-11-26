import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateSettings } from './config.mjs';
import { REMINDER, handlePreInvocation } from './responsive-core.mjs';
import { readTriggerStats } from './stats.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = path.join(SCRIPT_DIR, 'responsive-hook.mjs');
const REMINDED = { injectSteps: [{ systemMessage: { systemMessage: REMINDER } }] };

const userInput = (text) => ({
  type: 'USER_INPUT',
  source: 'USER_EXPLICIT',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
});
const plannerResponse = (content = '', toolCalls = [{ name: 'list_dir' }]) => ({
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

const silentSteps = (count) =>
  Array.from({ length: count }, () => [plannerResponse(''), toolResult()]).flat();

const violatingPrevTurn = () => [
  userInput('先看一下报错'),
  plannerResponse(''),
  toolResult(),
  plannerResponse('看完了。', []),
];

const createTempEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-responsive-test-'));
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

test('首条用户消息与合规上一轮不触发提醒，开场空正文调用工具触发提醒', () => {
  const ws = createTempEnv();
  try {
    const firstTurn = ws.writeTranscript([userInput('修一下登录页的报错')]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: firstTurn }, { configPath: ws.configPath }), {});

    const compliant = ws.writeTranscript([
      userInput('读一下 a.txt'),
      plannerResponse('先读一下 a.txt。'),
      toolResult(),
      ...silentSteps(5),
      plannerResponse('内容是 hello', []),
      userInput('再读一下 b.txt'),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: compliant }, { configPath: ws.configPath }), {});

    const openerBad = ws.writeTranscript([
      userInput('读一下 a.txt'),
      plannerResponse('   '),
      toolResult(),
      plannerResponse('hello', []),
      userInput('再读一下 b.txt'),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: openerBad }, { configPath: ws.configPath }), REMINDED);
  } finally {
    ws.cleanup();
  }
});

test('中途静默阈值档位（4 / 6 / 10）与模块/Hook 开关实时生效', () => {
  const ws = createTempEnv();
  try {
    const fourSilent = ws.writeTranscript([
      userInput('排查卡顿'),
      plannerResponse('我先查播放器代码。'),
      toolResult(),
      ...silentSteps(4),
      plannerResponse('查完了。', []),
      userInput('继续'),
    ]);

    // 默认 6 次档：连续 4 次不触发
    assert.deepEqual(handlePreInvocation({ transcriptPath: fourSilent }, { configPath: ws.configPath }), {});

    // 切换至 4 次敏感档：连续 4 次触发
    updateSettings(
      { responsive: { silentThreshold: 4 } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.deepEqual(handlePreInvocation({ transcriptPath: fourSilent }, { configPath: ws.configPath }), REMINDED);

    // 切换至 10 次宽松档：连续 6 次不触发，连续 10 次触发
    updateSettings(
      { responsive: { silentThreshold: 10 } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    const sixSilent = ws.writeTranscript([
      userInput('排查卡顿'),
      plannerResponse('我先查。'),
      toolResult(),
      ...silentSteps(6),
      plannerResponse('查完了。', []),
      userInput('继续'),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: sixSilent }, { configPath: ws.configPath }), {});

    const tenSilent = ws.writeTranscript([
      userInput('排查卡顿'),
      plannerResponse('我先查。'),
      toolResult(),
      ...silentSteps(10),
      plannerResponse('查完了。', []),
      userInput('继续'),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: tenSilent }, { configPath: ws.configPath }), REMINDED);

    // 关闭 Hook 开关或模块总开关后直接放行
    updateSettings(
      { responsive: { hookEnabled: false } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.deepEqual(handlePreInvocation({ transcriptPath: tenSilent }, { configPath: ws.configPath }), {});

    updateSettings(
      { responsive: { enabled: false, hookEnabled: true } },
      { configPath: ws.configPath, rulesPath: ws.rulesPath },
    );
    assert.deepEqual(handlePreInvocation({ transcriptPath: tenSilent }, { configPath: ws.configPath }), {});
  } finally {
    ws.cleanup();
  }
});

test('中途有正文汇报打断静默计数、去重、后台任务、子 Agent 与窗口回退均正确', () => {
  const ws = createTempEnv();
  try {
    const brokenStreak = ws.writeTranscript([
      userInput('排查卡顿'),
      plannerResponse('先查代码。'),
      toolResult(),
      ...silentSteps(5),
      plannerResponse('定位到音频管线，继续看配置。'),
      toolResult(),
      ...silentSteps(5),
      plannerResponse('完成。', []),
      userInput('改一下'),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: brokenStreak }, { configPath: ws.configPath }), {});

    const dedup = ws.writeTranscript([
      ...violatingPrevTurn(),
      userInput('修报错'),
      systemMessage(REMINDER),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: dedup }, { configPath: ws.configPath }), {});

    const bgTask = ws.writeTranscript([
      userInput('跑测试'),
      plannerResponse('已启动'),
      systemMessage('Background task finished'),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: bgTask }, { configPath: ws.configPath }), {});

    const subagent = ws.writeTranscript([systemMessage('You are a subagent.')]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: subagent }, { configPath: ws.configPath }), {});

    const outsideWindow = ws.writeTranscript([
      ...violatingPrevTurn(),
      userInput('看日志'),
      systemMessage('x'.repeat(4096)),
    ]);
    assert.deepEqual(
      handlePreInvocation({ transcriptPath: outsideWindow }, { configPath: ws.configPath, windowBytes: 1024 }),
      REMINDED,
    );
  } finally {
    ws.cleanup();
  }
});

test('CLI responsive-hook 输出提醒并记录 responsive_reminder 统计，非法输入输出 {}', () => {
  const ws = createTempEnv();
  const env = {
    ...process.env,
    ANTIGRAVITY_RAIL_CONFIG_PATH: ws.configPath,
    ANTIGRAVITY_RAIL_EVENTS_PATH: ws.eventsPath,
  };
  try {
    const transcriptPath = ws.writeTranscript([...violatingPrevTurn(), userInput('继续修')]);
    const ok = spawnSync(process.execPath, [HOOK_ENTRY], {
      input: JSON.stringify({ hookEventName: 'PreInvocation', transcriptPath }),
      env,
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0);
    assert.deepEqual(JSON.parse(ok.stdout), REMINDED);
    assert.equal(readTriggerStats({ eventsPath: ws.eventsPath }).responsiveReminderCount, 1);

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
