import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateSettings } from './config.mjs';
import {
  REMINDER,
  buildFileLinkReminder,
  extractBacktickFileCandidates,
  handlePreInvocation,
} from './responsive-core.mjs';
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
  assert.doesNotMatch(REMINDER, /[\u4e00-\u9fff]/);
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

test('同轮检测已知工作区文件使用纯反引号时立即提醒改用可点击链接，同轮去重且对代码/链接/泛指文件名零误报', () => {
  const ws = createTempEnv();
  try {
    // 1. 刚编辑过 config.mjs 与 updater.mjs，途中汇报却用了纯反引号 -> 立即提醒并点名漏链文件
    const unlinked = ws.writeTranscript([
      userInput('帮我国际化一下面板'),
      plannerResponse('已完成 `config.mjs` 与 `sidecars/panel/updater.mjs` 的修改，继续改前端。', [
        { name: 'edit_file', args: { Path: JSON.stringify('D:\\private\\antigravity-rail\\scripts\\config.mjs') } },
        { name: 'edit_file', args: { Path: JSON.stringify('D:\\private\\antigravity-rail\\sidecars\\panel\\updater.mjs') } },
      ]),
      toolResult(),
    ]);
    const reminded = handlePreInvocation({ transcriptPath: unlinked }, { configPath: ws.configPath });
    const expectedMsg = buildFileLinkReminder(['config.mjs', 'sidecars/panel/updater.mjs']);
    assert.deepEqual(reminded, { injectSteps: [{ systemMessage: { systemMessage: expectedMsg } }] });
    assert.match(expectedMsg, /<responsive-file-links>/);
    assert.match(expectedMsg, /`config\.mjs`, `sidecars\/panel\/updater\.mjs`/);

    // 2. 同轮已经提醒过一次后不再重复注入
    const dedup = ws.writeTranscript([
      userInput('帮我国际化一下面板'),
      plannerResponse('刚改了 `updater.mjs`。', [
        { name: 'edit_file', args: { Path: JSON.stringify('D:\\repo\\sidecars\\panel\\updater.mjs') } },
      ]),
      toolResult(),
      systemMessage(buildFileLinkReminder(['updater.mjs'])),
      plannerResponse('又改了 `updater.mjs`。', []),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: dedup }, { configPath: ws.configPath }), {});

    // 3. 零误报：已有 Markdown 链接、反引号包在链接内、围栏代码块、命令片段、代码属性及未接触过的泛指文件名
    const clean = ws.writeTranscript([
      userInput('检查一下面板'),
      plannerResponse(
        [
          '已更新 [updater.mjs](file:///D:/repo/sidecars/panel/updater.mjs) 与 [`index.html`](file:///D:/repo/sidecars/panel/index.html)。',
          '检查了 `res.json`、`state.version`、`node scripts/updater.mjs` 以及未生成的 `config/settings.json`。',
          '```js',
          '// `updater.mjs` inside code fence should be ignored',
          '```',
        ].join('\n'),
        [
          { name: 'edit_file', args: { Path: JSON.stringify('D:\\repo\\sidecars\\panel\\updater.mjs') } },
          { name: 'read_file', args: { Path: JSON.stringify('D:\\repo\\sidecars\\panel\\index.html') } },
        ],
      ),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: clean }, { configPath: ws.configPath }), {});

    // 4. 早期轮次读过的文件跨越尾部窗口时，回退读全文件依然能精准捕获
    const crossWindow = ws.writeTranscript([
      userInput('先读一下配置'),
      plannerResponse('先读。', [
        { name: 'read_file', args: { Path: JSON.stringify('D:\\repo\\scripts\\config.mjs') } },
      ]),
      { type: 'GENERIC', source: 'MODEL', content: 'x'.repeat(4096) },
      plannerResponse('读完了。', []),
      userInput('改一下'),
      plannerResponse('接下来改 `config.mjs:196` 的规则模板。', [{ name: 'list_dir', args: {} }]),
      toolResult(),
    ]);
    const crossOut = handlePreInvocation(
      { transcriptPath: crossWindow },
      { configPath: ws.configPath, windowBytes: 1024 },
    );
    assert.equal(
      crossOut.injectSteps[0].systemMessage.systemMessage,
      buildFileLinkReminder(['config.mjs:196']),
    );

    // 5. 同轮前面旧消息（例如 ask_question 之前的方案讨论）含反引号，但最近一条已全部用链接 -> 不翻旧账
    const noOldGrudge = ws.writeTranscript([
      userInput('给我看看方案'),
      plannerResponse('比如讨论里的 `updater.mjs` 举例。', [{ name: 'ask_question', args: {} }]),
      toolResult(),
      plannerResponse('已更新 [updater.mjs](file:///D:/repo/sidecars/panel/updater.mjs)。', [
        { name: 'edit_file', args: { Path: JSON.stringify('D:\\repo\\sidecars\\panel\\updater.mjs') } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: noOldGrudge }, { configPath: ws.configPath }), {});

    // 6. extractBacktickFileCandidates 校验链接、命令与双反引号转义示例过滤
    assert.deepEqual(
      extractBacktickFileCandidates('看 [a.mjs](file:///a.mjs)、`` `updater.mjs` ``、`node a.mjs` 和 `b.mjs`'),
      [{ raw: 'b.mjs', normalizedKey: 'b.mjs' }],
    );
  } finally {
    ws.cleanup();
  }
});
