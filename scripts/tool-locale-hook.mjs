import { recordTriggerEvent } from './stats.mjs';
import { handlePreInvocation } from './tool-locale-core.mjs';
import { runPreInvocationHook } from './transcript.mjs';

runPreInvocationHook(handlePreInvocation, () => recordTriggerEvent('tool_locale_reminder'));
