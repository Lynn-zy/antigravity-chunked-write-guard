import { handlePreInvocation, handlePreToolUse } from './hook-core.mjs';
import { recordTriggerEvent } from './stats.mjs';

const readStdinAsync = (timeoutMs = 2_000) =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
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

const main = async () => {
  const mode = process.argv[2];
  const raw = (await readStdinAsync()).replace(/^\uFEFF/, '');
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  if (mode === 'pre-invocation') {
    const out = handlePreInvocation(payload);
    if (Array.isArray(out.injectSteps) && out.injectSteps.length > 0) {
      recordTriggerEvent('recovery');
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (mode === 'pre-tool-use') {
    const out = handlePreToolUse(payload);
    if (out.decision === 'deny') {
      recordTriggerEvent('deny');
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  process.stdout.write('{}\n');
};

main().catch(() => {
  // fail-open：Hook 自身异常不能阻断正常对话流程
  const mode = process.argv[2];
  process.stdout.write(mode === 'pre-tool-use' ? '{"decision":"allow"}\n' : '{}\n');
});
