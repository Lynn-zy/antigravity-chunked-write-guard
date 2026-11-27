import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateSettings } from './config.mjs';
import { readTriggerStats } from './stats.mjs';
import {
  REMINDER,
  detectNonLatinScript,
  extractUserRequestText,
  handlePreInvocation,
} from './tool-locale-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = path.join(SCRIPT_DIR, 'tool-locale-hook.mjs');
const REMINDED = { injectSteps: [{ systemMessage: { systemMessage: REMINDER } }] };

const userInput = (text, extraMeta = '') => ({
  type: 'USER_INPUT',
  source: 'USER_EXPLICIT',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>${extraMeta ? `\n<ADDITIONAL_METADATA>\n${extraMeta}\n</ADDITIONAL_METADATA>` : ''}`,
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

test('extractUserRequestText 与 detectNonLatinScript 剥离元数据/代码块并识别 9 大非拉丁脚本', () => {
  assert.doesNotMatch(REMINDER, /[\u4e00-\u9fff]/);

  // 剥离 ADDITIONAL_METADATA 与代码片段，防止英文用户被引用标题或代码注释误判
  const enWithMetaAndCode =
    '<USER_REQUEST>\nPlease fix this snippet:\n```js\n// 中文注释\nconst a = 1;\n```\nand check `汉字`.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nTitle: 中文对话标题\n</ADDITIONAL_METADATA>';
  const cleaned = extractUserRequestText(enWithMetaAndCode);
  assert.equal(detectNonLatinScript(cleaned), null);

  assert.equal(detectNonLatinScript('请帮我跑一下单元测试')?.id, 'chinese');
  assert.equal(detectNonLatinScript('テストを実行してください')?.id, 'japanese');
  assert.equal(detectNonLatinScript('테스트를 실행해 주세요')?.id, 'korean');
  assert.equal(detectNonLatinScript('Запусти модульные тесты')?.id, 'cyrillic');
  assert.equal(detectNonLatinScript('شغل اختبارات الوحدة')?.id, 'arabic');
  assert.equal(detectNonLatinScript('ช่วยรันเทสต์ให้หน่อย')?.id, 'thai');
  assert.equal(detectNonLatinScript('कृपया यूनिट टेस्ट चलाएँ')?.id, 'devanagari');
  assert.equal(detectNonLatinScript('תריץ את הבדיקות בבקשה')?.id, 'hebrew');
  assert.equal(detectNonLatinScript('Τρέξε τα tests παρακαλώ')?.id, 'greek');
  assert.equal(detectNonLatinScript('Please run the unit tests'), null);
  assert.equal(detectNonLatinScript('Ejecuta las pruebas unitarias por favor'), null);
});

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

test('多语种自动匹配：日/韩/俄/阿等非拉丁脚本正确检测与放行，英文与拉丁语系静默不误报', () => {
  const ws = createTempEnv();
  try {
    // 英文对话：英文摘要完全静默
    const enChat = ws.writeTranscript([
      userInput('Run the tests and check git status', 'Conversation: 中文标题'),
      plannerResponse('Running tests now.', [
        { name: 'run_command', args: { toolSummary: '"Run unit tests"' } },
        { name: 'update_focus', args: { focus: '"Running unit tests"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: enChat }, { configPath: ws.configPath }), {});

    // 西班牙语（拉丁字母）对话：Hook 静默不误报，由常驻规则兜底
    const esChat = ws.writeTranscript([
      userInput('Por favor revisa los errores en auth.ts'),
      plannerResponse('Revisando auth.ts.', [
        { name: 'run_command', args: { toolSummary: '"Check git status"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: esChat }, { configPath: ws.configPath }), {});

    // 日文对话：日文/汉字混排摘要放行，纯英文摘要纠偏
    const jaOk = ws.writeTranscript([
      userInput('テストを実行してください'),
      plannerResponse('テストを実行します。', [
        { name: 'run_command', args: { toolSummary: '"npm test を実行"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: jaOk }, { configPath: ws.configPath }), {});

    const jaBad = ws.writeTranscript([
      userInput('テストを実行してください'),
      plannerResponse('テストを実行します。', [
        { name: 'run_command', args: { toolSummary: '"Run npm test"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: jaBad }, { configPath: ws.configPath }), REMINDED);

    // 韩文对话：谚文放行，纯英文纠偏
    const koOk = ws.writeTranscript([
      userInput('테스트를 실행해 주세요'),
      plannerResponse('실행합니다.', [
        { name: 'update_focus', args: { focus: '"npm test 실행 중"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: koOk }, { configPath: ws.configPath }), {});

    const koBad = ws.writeTranscript([
      userInput('테스트를 실행해 주세요'),
      plannerResponse('실행합니다.', [
        { name: 'update_focus', args: { focus: '"Running npm test"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: koBad }, { configPath: ws.configPath }), REMINDED);

    // 俄文（西里尔）对话：西里尔文放行，纯英文纠偏
    const ruOk = ws.writeTranscript([
      userInput('Проверь статус git и запусти тесты'),
      plannerResponse('Проверяю.', [
        { name: 'run_command', args: { toolSummary: '"Проверка git status"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: ruOk }, { configPath: ws.configPath }), {});

    const ruBad = ws.writeTranscript([
      userInput('Проверь статус git и запусти тесты'),
      plannerResponse('Проверяю.', [
        { name: 'run_command', args: { toolSummary: '"Check git status"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(handlePreInvocation({ transcriptPath: ruBad }, { configPath: ws.configPath }), REMINDED);
  } finally {
    ws.cleanup();
  }
});

test('纯拉丁短回复（ok / continue）自动回溯近期用户消息语言，跨尾部窗口仍能准确触发', () => {
  const ws = createTempEnv();
  try {
    const shortFollowUp = ws.writeTranscript([
      userInput('帮我排查一下登录超时问题'),
      plannerResponse('先看登录模块。', []),
      { type: 'GENERIC', source: 'MODEL', content: 'x'.repeat(4096) },
      userInput('continue'),
      plannerResponse('继续排查。', [
        { name: 'update_focus', args: { focus: '"Inspecting login timeout"' } },
      ]),
      toolResult(),
    ]);
    assert.deepEqual(
      handlePreInvocation({ transcriptPath: shortFollowUp }, { configPath: ws.configPath, windowBytes: 1024 }),
      REMINDED,
    );
  } finally {
    ws.cleanup();
  }
});

test('中文混排短语、子 Agent、截断 JSON 与开关控制均正常', () => {
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
