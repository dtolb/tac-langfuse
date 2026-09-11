/**
 * `end_call` — the tool that lets the agent hang up, and the reason it is a two-step mechanism.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS TOOL DOES NOT END THE CALL. IT RECORDS AN INTENT.
 *
 * Tools run INSIDE the model loop, before the final text of the turn is generated, let alone
 * streamed and spoken. A tool that hung up where it stands would cut the caller off before the
 * goodbye — often before the model had even written it. So `execute` only records "this conversation
 * asked to end", and `server/twilio/voice.ts` acts on it AFTER the farewell has been streamed.
 *
 * The tool's return value is written for the model, not for a log: it says the call is ending and
 * that a short goodbye is the next thing to produce. That is what turns one tool call into
 * "goodbye, then silence" rather than "goodbye" with the line still open.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Why an intent store rather than a return value the caller inspects: `runTurn` gives its caller
 * `TurnResult.toolCalls`, which carries names and INPUTS but not outputs, and the voice handler would
 * have to re-derive intent by string-matching a tool name. Keyed state is explicit, and it also
 * survives the multi-step loop — the model calls this on step 1 and speaks on step 2.
 */
import { z } from 'zod';
import type { ToolDef } from './registry.ts';

/**
 * Bounded, because a leak here is possible: `consume` is only ever called by the voice handler, so a
 * prompt that named this tool on a channel that ignores it would add entries nothing removes. Small,
 * since the only legitimate entries are calls currently saying goodbye.
 */
const MAX_PENDING = 100;

/** conversationId → the reason the model gave. */
const pending = new Map<string, string>();

const EndCallInput = z.object({
  reason: z
    .string()
    .min(1)
    // Reaches the model through the generated schema, so it doubles as guidance on WHEN to call.
    .describe(
      'Why the call is ending, in a few words — for example "caller said goodbye", "caller confirmed they had everything they needed", or "caller asked to end the call".',
    ),
});

export const endCallTool: ToolDef<typeof EndCallInput> = {
  name: 'end_call',
  description:
    'Hang up the phone call. Call this only when the caller has clearly finished — they said goodbye, said they have everything they need, or asked to end the call. After calling it, say one short goodbye and nothing else. Never call it while a question is unanswered, and never call it to avoid answering something.',
  input: EndCallInput,
  /**
   * Voice-only, and `requires` is the honest way to say so: on a process with no voice configured the
   * resolver puts it in the `unavailable` bucket, which logs at debug and leaves the turn otherwise
   * intact. The real gate is still the prompt — only `demo-agent-voice` names it — but a capability
   * makes a misuse degrade instead of silently doing nothing.
   */
  requires: 'voice',
  async execute({ reason }, ctx) {
    if (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next();
      if (oldest.done !== true) pending.delete(oldest.value);
    }
    pending.set(ctx.conversationId, reason);
    ctx.logger.debug(
      { tool: 'end_call', reason, conversationId: ctx.conversationId },
      'end_call: hangup requested; the channel will end the session after this turn is spoken',
    );

    // Addressed to the model. Saying "already ending" is what stops it asking a closing question it
    // will never hear the answer to.
    return {
      ending: true,
      instruction:
        'The call is ending now. Say one short goodbye — no questions, no offers of further help.',
    };
  },
};

/**
 * Read and clear the intent for one conversation. Returns the reason, or `null` if none was set.
 *
 * Clearing on read is deliberate: it makes the hangup fire exactly once even if a later turn somehow
 * runs, and it means the store self-empties on the happy path.
 */
export function consumeEndCallRequest(conversationId: string): string | null {
  const reason = pending.get(conversationId);
  if (reason === undefined) return null;
  pending.delete(conversationId);
  return reason;
}

/** Drop any intent for a conversation that ended some other way — a hangup, a sweep, a shutdown. */
export function forgetEndCallRequest(conversationId: string): void {
  pending.delete(conversationId);
}
