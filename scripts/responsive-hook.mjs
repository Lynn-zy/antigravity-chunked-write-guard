import { handlePreInvocation } from './responsive-core.mjs';
import { recordTriggerEvent } from './stats.mjs';
import { runPreInvocationHook } from './transcript.mjs';

runPreInvocationHook(handlePreInvocation, () => recordTriggerEvent('responsive_reminder'));
