/**
 * One inbound SMS → one `runTurn` → the reply string TAC sends back.
 *
 * Split from `./tac.ts` so the per-turn logic reads on its own, the same way `routes-bench.ts` keeps
 * `streamBenchTurn` separate from the route wiring. `params` is our own narrow interface rather than
 * TAC's `MessageReadyCallback` argument — structurally compatible, but it keeps this file readable
 * without the vendor's types and means the turn logic states exactly which seven fields it uses.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FUNCTION MUST NEVER THROW AND MUST NEVER RETURN ''.
 *
 * TAC catches whatever escapes an `onMessageReady` handler and only logs it, and it treats a returned
 * empty string as "nothing to send" (logging `Callback returned empty string, skipping auto-send`).
 * Both outcomes are the same thing from the customer's side: they texted a number and got silence,
 * the webhook already answered 200, and the only trace is one line in the agent log. So every exit
 * from here is a non-empty string.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { collect } from '../obs/first-token.ts';
import { maskPhone } from '../obs/pii.ts';
import { withTurnSpan } from '../obs/spans.ts';
import type { ConversationRegistry } from '../obs/conversations.ts';
import { runTurn } from '../agent/run-turn.ts';
import type { TurnDeps } from '../agent/types.ts';
import type { ToolLogger } from '../agent/tools/registry.ts';

/**
 * How long an SMS turn may run before we give up on it.
 *
 * A compile-time constant rather than an env var, following `AGENT_PORT`'s precedent: nothing outside
 * this process needs to agree on it. It exists because SMS gets **no `abortSignal` from TAC** — only
 * the voice `prompt` path supplies one — and `TurnInput.abortSignal` is required. An unbounded turn
 * against a hung model would leave the `llm.stream` span unended, and an unended span never reaches
 * Langfuse at all, so the symptom would be a missing observation rather than a slow one.
 *
 * Generous, because SMS latency is not perceptual the way voice is: the point is to bound the turn,
 * not to race it.
 */
export const SMS_TURN_TIMEOUT_MS = 30_000;

/** Said out loud when a turn cannot answer. Non-empty by contract — see the header. */
export const SMS_FALLBACK_TEXT =
  "Sorry — I couldn't get to that just now. Please try sending your message again.";

/**
 * What TAC hands `onMessageReady`, narrowed to what this function reads.
 *
 * `memory` is deliberately typed `unknown`: it is a `TACMemoryResponse` class instance with getters
 * (so `JSON.stringify` yields `{}`), it is passed straight through to `composeMemory` which is the
 * only thing that knows its shape, and typing it here would drag the vendor into this file.
 */
export interface InboundMessage {
  readonly conversationId: string;
  readonly message: string;
  /** The customer's E.164 on inbound. Can be the literal string `unknown`. */
  readonly author: string;
  readonly profileId: string | undefined;
  readonly memory: unknown;
  /** TAC's per-conversation session. Mutable, and the same object reference on every turn. */
  readonly session: { metadata?: Record<string, unknown> } | undefined;
}

export interface MessagingDeps {
  readonly turn: TurnDeps;
  readonly conversations: ConversationRegistry;
  readonly logger: ToolLogger;
  /** Injected by tests so the timeout is exact rather than a real 30-second wait. */
  readonly timeoutMs?: number;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function handleInboundMessage(
  params: InboundMessage,
  deps: MessagingDeps,
): Promise<string> {
  const { conversationId, message, author } = params;
  const { turn, conversations, logger } = deps;

  // Masked in the SUMMARY specifically. `bus.publish` scrubs `payload` but copies `summary`
  // verbatim, and SMS is the channel whose summaries most naturally carry a phone number.
  turn.obs.publish({
    kind: 'sms.inbound',
    summary: `${maskPhone(author)}: ${message.slice(0, 80)}`,
    channel: 'sms',
    conversationId,
    payload: { author, message, profileId: params.profileId, hasMemory: params.memory != null },
  });

  // Opportunistic, like the bench: a timer would need `unref` and there is nothing to sweep while
  // nobody is texting. The registry is the sole traceparent carrier for SMS — see its header for why
  // `session.metadata` is deliberately not consulted.
  conversations.sweep();
  const traceparent = conversations.traceparentFor(conversationId);

  try {
    const reply = await withTurnSpan('turn.sms', traceparent, async (span) => {
      const { tokens, done } = await runTurn(
        {
          conversationId,
          channel: 'sms',
          userText: message,
          // T12 runs `memoryMode: 'never'`, so this is always null and `composeMemory` is the
          // passthrough. T14 turns Conversation Memory on with a real compose port.
          memory: params.memory ?? null,
          // Empty by design: the traceparent was already applied by `withTurnSpan` above, and SMS
          // carries it in the registry rather than here.
          sessionMetadata: {},
          profileId: params.profileId ?? null,
          abortSignal: AbortSignal.timeout(deps.timeoutMs ?? SMS_TURN_TIMEOUT_MS),
          span,
        },
        turn,
      );

      // ══ NOTHING MAY BE AWAITED BETWEEN `runTurn` RESOLVING AND THIS LINE. ══
      // `done` gets one macrotask of grace before it decides nobody is listening. `collect` satisfies
      // that by construction: calling it enters the generator body synchronously, so `consuming` is
      // set before the promise is even awaited. Get this wrong and the reply is still correct while
      // `ttftMs`/`totalMs` come back null — silent, and visible only as an empty latency column.
      const streamed = await collect(tokens);
      const result = await done;

      if (result.aborted) {
        // On SMS `aborted` can ONLY mean our own timeout fired — there is no barge-in here. Two
        // consequences, both deliberate:
        //
        // 1. We must say so out loud. `runTurn` treats every abort as normal operation (it is, on
        //    voice) and publishes no `error`, so a timed-out SMS turn would otherwise look like a
        //    clean turn that happened to answer nothing.
        // 2. We must NOT send the partial. `runTurn` keeps a partial answer in history because on
        //    voice the caller already heard those words — that reasoning does not transfer. Nothing
        //    was delivered here, so sending `streamed` would text the customer a sentence that stops
        //    mid-word.
        turn.obs.publish({
          kind: 'error',
          summary: `sms turn timed out after ${deps.timeoutMs ?? SMS_TURN_TIMEOUT_MS}ms`,
          channel: 'sms',
          conversationId,
          payload: { timeoutMs: deps.timeoutMs ?? SMS_TURN_TIMEOUT_MS, partialChars: streamed.length },
        });
        return SMS_FALLBACK_TEXT;
      }

      // Same rule `run-turn.ts` uses to decide what to store in history, so what the customer
      // received and what turn 2 remembers cannot disagree. They differ only on a multi-step tool
      // turn, where `result.text` is the final step's text while the stream carried every step's.
      return result.text !== '' ? result.text : streamed;
    });

    const outbound = reply === '' ? SMS_FALLBACK_TEXT : reply;
    turn.obs.publish({
      kind: 'sms.outbound',
      summary: `→ ${maskPhone(author)}: ${outbound.slice(0, 80)}`,
      channel: 'sms',
      conversationId,
      payload: { text: outbound, chars: outbound.length, fallback: outbound === SMS_FALLBACK_TEXT },
    });
    return outbound;
  } catch (err) {
    // `runTurn` has already published its own `error` and `turn.end`. This is here so the customer
    // gets a sentence rather than silence — TAC would swallow this throw and only log it.
    logger.error({ err, conversationId }, 'sms: turn failed');
    turn.obs.publish({
      kind: 'sms.outbound',
      summary: `→ ${maskPhone(author)}: (fallback after failure)`,
      channel: 'sms',
      conversationId,
      payload: { text: SMS_FALLBACK_TEXT, fallback: true, error: errorMessage(err) },
    });
    return SMS_FALLBACK_TEXT;
  }
}
