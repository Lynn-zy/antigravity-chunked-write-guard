import { recordTriggerEvent } from './stats.mjs';
import { readStdinAsync } from './transcript.mjs';
import { handlePostToolUse, handlePreInvocation } from './write-guard-core.mjs';

const main = async () => {
  const mode = process.argv[2];
  const raw = (await readStdinAsync()).replace(/^\uFEFF/, '');
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  if (mode === 'post-tool-use') {
    const result = handlePostToolUse(payload);
    if (result.oversize) {
      recordTriggerEvent('write_oversize');
    }
    process.stdout.write('{}\n');
    return;
  }

  if (mode === 'pre-invocation') {
    const out = handlePreInvocation(payload);
    if (Array.isArray(out.injectSteps) && out.injectSteps.length > 0) {
      recordTriggerEvent('write_reminder');
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  process.stdout.write('{}\n');
};

main().catch(() => {
  process.stdout.write('{}\n');
});
