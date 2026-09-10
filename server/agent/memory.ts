/**
 * The passthrough `MemoryComposePort`: no memory, no added context.
 *
 * This is what the bench harness (T11) and SMS-without-orchestration run on, and it is the reason
 * a complete turn can be driven with zero Twilio credentials. T13 adds the TAC-backed sibling
 * beside it, wrapping `MemoryPromptBuilder` — which is why this is a port at all rather than an
 * `if (memory === null)` inside `run-turn.ts`.
 *
 * Returns `null` rather than `''`: an empty string would be appended to the system prompt as a
 * blank paragraph, and "no memory" should be indistinguishable from "no memory port".
 */
import type { MemoryComposePort } from './types.ts';

export const passthroughMemory: MemoryComposePort = {
  compose: () => Promise.resolve(null),
};
