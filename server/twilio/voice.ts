/**
 * One ConversationRelay turn → one `runTurn` → tokens spoken as they arrive.
 *
 * The voice sibling of `./messaging.ts`, and split from `./tac.ts` for the same reason: the per-turn
 * logic reads on its own. `VoicePrompt` and `VoiceSender` are our own narrow shapes rather than TAC's
 * types — structurally compatible, but they state exactly what this file touches.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ON VOICE, EVERY FAILURE MODE IS SILENCE. That is what makes this file different from the bench.
 *
 * TAC catches whatever escapes a `prompt` handler and only logs it — measured: a throwing handler
 * left the call up, fired `on('error')`, and turn 2 still ran, while the caller heard nothing at
 * all. Nothing here may rely on a throw reaching anybody. Every exit path either speaks or is
 * deliberately, documented-ly silent.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three things in here are load-bearing and were each verified against the installed
 * `twilio-agent-connect@2.2.0` bundle rather than reasoned about. Do not "simplify" any of them.
 */
import { maskPhone } from '../obs/pii.ts';
import { withTurnSpan } from '../obs/spans.ts';
import type { ConversationRegistry } from '../obs/conversations.ts';
import { runTurn } from '../agent/run-turn.ts';
import type { TurnDeps } from '../agent/types.ts';
import type { ToolLogger } from '../agent/tools/registry.ts';

/**
 * Conversation-registry bounds for voice. Tighter than SMS on both axes, because a phone call is
 * minutes long where an SMS thread is hours: `conversation.voice` roots are normally ended by
 * `handleVoiceDisconnect` the moment the socket closes, and this TTL only has to cover the case
 * where that signal never arrives.
 *
 * It genuinely can not arrive. In the ws `close` handler, if orchestrated initialization is still
 * pending and later *rejects*, neither branch reaches `handleWebSocketDisconnect` and no disconnect
 * callback fires at all. An unended root span does not reach Langfuse AT ALL (see
 * `../obs/conversations.ts`), so the sweep is what turns that from a missing trace into a late one.
 */
export const VOICE_CONVERSATION_TTL_MS = 30 * 60_000;
export const VOICE_MAX_CONVERSATIONS = 50;

/**
 * Spoken when a turn cannot answer. Short and plain on purpose — it is heard, not read, and it is
 * said at the exact moment the caller is already confused.
 */
export const VOICE_FALLBACK_TEXT =
  "Sorry, I didn't catch that. Could you say it again?";

/**
 * TwiML applied to every call, via `VoiceChannelConfig.defaultTwimlOptions`.
 *
 * ONE SETTING, AND IT IS NOT OPTIONAL: `reportInputDuringAgentSpeech`. Its default changed from
 * `any` to `none` in May 2025, and `none` means the caller can interrupt us — `interruptible`
 * defaults to `any`, so the audio does stop and an `interrupt` message does arrive — but **the words
 * that caused the interruption are never delivered as a `prompt`**. The agent stops talking and then
 * cannot hear, which on a live call is indistinguishable from a crash. Every ConversationRelay
 * example written before May 2025 assumes the old default and therefore omits this line.
 *
 * Deliberately the only key. TAC's remaining defaults are good ones (ElevenLabs TTS, Deepgram
 * `nova-3-general`, `interruptible: 'any'`, `interruptSensitivity: 'high'`, `speechTimeout: 'auto'`,
 * `elevenlabsTextNormalization: 'off'` which matters for latency), and pinning them here would
 * silently freeze them at 2.2.0's values on the next upgrade. Per-call overrides, if ever needed,
 * belong on `voiceChannel.onInboundCallTwiml(...)`, which is a higher-precedence layer.
 *
 * Note the type: `TwiMLOptions` declares this as the correct four-valued enum
 * (`none | dtmf | speech | any`). The sibling `ConversationRelayAttributes` type declares it as a
 * BOOLEAN, which is stale — do not reach for that one.
 */
export const VOICE_TWIML_OPTIONS = {
  reportInputDuringAgentSpeech: 'any',
} as const;

/**
 * What TAC's `prompt` callback hands us, narrowed to what this file reads.
 *
 * `memory` is `unknown` for the same reason as in `./messaging.ts`: it is a class instance with
 * getters, only `composeMemory` knows its shape, and typing it here would drag the vendor in.
 *
 * There is no `profileId` on this payload — voice does not get one, so the turn passes `null`. And
 * only three of the five keys are guaranteed: `userMemory` and `session` are *conditionally spread*
 * by TAC, so under `memoryMode: 'never'` the key is absent rather than undefined.
 */
export interface VoicePrompt {
  readonly conversationId: string;
  /** The caller's utterance, already finalised by STT. */
  readonly transcript: string;
  /**
   * TAC's per-conversation abort controller, created at the top of its prompt handling. Aborted on
   * exactly three events: a barge-in, a newer prompt for the same conversation, and the socket
   * closing. This is the only channel that supplies one — SMS has to synthesize its own.
   */
  readonly abortSignal: AbortSignal;
  readonly memory: unknown;
}

/**
 * The two send methods this file uses. Method syntax, so `VoiceChannel` — whose signatures take
 * TAC's branded `ConversationId` — stays assignable.
 *
 * `sendResponse` is declared to return a promise but is NOT an `async` function in the bundle, so
 * its closed-socket guard **throws synchronously**: a bare `.catch()` on it misses, and the escaping
 * exception is uncaught. `sendStreamingResponse` IS async and therefore rejects. Every call to
 * either one in this file sits inside a `try`, which is the only form that covers both.
 */
export interface VoiceSender {
  sendStreamingResponse(
    conversationId: string,
    stream: AsyncIterable<string>,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  sendResponse(conversationId: string, message: string): Promise<void>;
}

export interface VoiceDeps {
  readonly turn: TurnDeps;
  readonly conversations: ConversationRegistry;
  readonly sender: VoiceSender;
  readonly logger: ToolLogger;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Enough of an utterance to recognise the turn in a console list. */
const preview = (text: string): string => (text.length <= 80 ? text : `${text.slice(0, 80)}…`);

/**
 * Speak one turn.
 *
 * NEVER THROWS. TAC would swallow it, so a throw here is silence with a log line.
 */
export async function handleVoicePrompt(params: VoicePrompt, deps: VoiceDeps): Promise<void> {
  const { conversationId, transcript, abortSignal } = params;
  const { turn, conversations, sender, logger } = deps;

  turn.obs.publish({
    kind: 'voice.transcript',
    summary: preview(transcript),
    channel: 'voice',
    conversationId,
    payload: { transcript, hasMemory: params.memory != null },
  });

  // Opportunistic, exactly like the bench and SMS. The registry is the sole traceparent carrier —
  // see its header for why `session.metadata` is deliberately not consulted even though it is the
  // only thing TAC persists across turns.
  conversations.sweep();
  const traceparent = conversations.traceparentFor(conversationId);

  try {
    await withTurnSpan('turn.voice', traceparent, async (span) => {
      const { tokens, done } = await runTurn(
        {
          conversationId,
          channel: 'voice',
          userText: transcript,
          // Always null while `composeMemory` is the passthrough — voice runs `memoryMode: 'never'`
          // at T13, so TAC performs no Recall. T14 owns turning Conversation Memory on.
          memory: params.memory ?? null,
          // Empty by design: `withTurnSpan` above already applied the traceparent, and voice carries
          // it in the registry rather than in TAC's session.
          sessionMetadata: {},
          // Not on the voice prompt payload at all — unlike SMS, which gets one from Orchestrator.
          profileId: null,
          abortSignal,
          span,
        },
        turn,
      );

      // ══ NOTHING MAY BE AWAITED BETWEEN `runTurn` RESOLVING AND THE NEXT LINE. ══
      //
      // `run-turn.ts` names THIS handler as the expected victim, and the budget is one macrotask.
      // `sendStreamingResponse` satisfies it because everything before its `for await` is
      // synchronous — the socket lookup, the readyState check, the signal resolution. Insert an
      // awaited readiness check, an awaited publish, or a memory fetch above it and the caller still
      // hears the whole answer while `ttftMs`/`totalMs` come back null: a silent loss of exactly the
      // number this channel exists to measure.
      //
      // ══ AND `{ signal }` IS MANDATORY, NOT DEFENSIVE. ══
      //
      // `sendStreamingResponse` resolves its signal as `options?.signal ?? activeTask?.controller.
      // signal`, and TAC's `cancelStreamTask` aborts the controller AND THEN DELETES the map entry.
      // So on a barge-in the fallback resolves to `undefined`, `signal?.aborted` is falsy forever,
      // and the loop runs to completion — the caller is talked over with the answer they just
      // interrupted. Verified in the 2.2.0 bundle. Passing our own signal is what makes barge-in work
      // at all.
      const spokenPromise = sender.sendStreamingResponse(conversationId, tokens, {
        signal: abortSignal,
      });

      // Both are awaited, and `done` is awaited even when the send rejected. `done` is what ends the
      // `llm.stream` span, and an unended span never reaches Langfuse — so skipping it on the error
      // path would lose the observation that explains the error.
      let sendFailure: unknown = null;
      let spoken = '';
      try {
        spoken = await spokenPromise;
      } catch (err) {
        sendFailure = err;
      }
      const result = await done;

      if (result.aborted) {
        // A barge-in is NORMAL OPERATION on a call, which is why this branch is the opposite of
        // `./messaging.ts`'s. There, `aborted` can only be our own timeout, so it speaks a fallback
        // and publishes an `error`. Here both would be wrong: the caller interrupted us on purpose,
        // and TAC has already sent the end-of-turn marker itself if any token went out — sending
        // another creates the spurious empty turn its own source comment warns about.
        //
        // Note `turn.voice` is still a complete, correct span, and history still keeps the partial
        // answer. KNOWN LIMIT, accepted deliberately: that partial is what we GENERATED, which is
        // more than the caller HEARD. The ground truth is `utteranceUntilInterrupt` on the interrupt
        // callback, which arrives after `history.append` has already run.
        logger.debug({ conversationId }, 'voice: turn interrupted by the caller');
        return;
      }

      if (sendFailure !== null) throw sendFailure;

      // AN EMPTY ANSWER IS DEAD AIR, and not for the obvious reason. `sendStreamingResponse` emits
      // the `{token: '', last: true}` end-of-turn marker only if at least one token was sent, so a
      // zero-token stream closes nothing: ConversationRelay keeps waiting for us and the caller
      // hears an open line forever. Speaking real text is what ends the talk cycle.
      if (spoken === '') {
        turn.obs.publish({
          kind: 'error',
          summary: 'voice turn produced no tokens — spoke the fallback to close the talk cycle',
          channel: 'voice',
          conversationId,
          payload: { steps: result.steps, aborted: false },
        });
        await sender.sendResponse(conversationId, VOICE_FALLBACK_TEXT);
      }
    });
  } catch (err) {
    // The whole point of this catch: TAC swallows what escapes and the caller gets silence.
    logger.error({ err, conversationId }, 'voice: turn failed');
    turn.obs.publish({
      kind: 'error',
      summary: `voice turn failed: ${errorMessage(err)}`,
      channel: 'voice',
      conversationId,
      payload: { error: errorMessage(err), spokeFallback: true },
    });
    try {
      await sender.sendResponse(conversationId, VOICE_FALLBACK_TEXT);
    } catch (sayErr) {
      // Nothing left to try — the socket is gone, which is also why the turn failed. Logged rather
      // than rethrown so one dead socket cannot take the process with it.
      logger.error({ err: sayErr, conversationId }, 'voice: could not even speak the fallback');
    }
  }
}

/**
 * `setup` — the first thing that happens on a call, and free: TAC never consumes this slot.
 *
 * Publishes the only PII-bearing voice event, so the numbers are masked in the summary the same way
 * `./messaging.ts` masks them: `bus.publish` scrubs `payload` but copies `summary` verbatim.
 *
 * Deliberately does NOT start the conversation root span. `traceparentFor` does that lazily on the
 * first turn, which keeps one rule for all three channels and avoids opening a root for a call that
 * hangs up before saying anything.
 *
 * TAC hands over only four of the eleven fields its own schema parses — `direction`, `callStatus`,
 * `callerName`, `sessionId` and the rest are dropped before the callback. Use `<Parameter>` custom
 * parameters if one of them is ever needed.
 */
export function handleVoiceSetup(
  params: { callSid: string; from: string; to: string },
  deps: Pick<VoiceDeps, 'turn'>,
): void {
  deps.turn.obs.publish({
    kind: 'voice.setup',
    summary: `call from ${maskPhone(params.from)} to ${maskPhone(params.to)}`,
    channel: 'voice',
    payload: { callSid: params.callSid, from: params.from, to: params.to },
  });
}

/**
 * `interrupt` — the caller talked over us.
 *
 * Reporting only. TAC has already aborted the turn's signal by the time this runs, and Twilio's own
 * documentation prescribes no server action here. `utteranceUntilInterrupt` is the one place the
 * words the caller actually HEARD are available; it is published so the console and Langfuse can
 * show it, and deliberately not written back into history (see `handleVoicePrompt`).
 */
export function handleVoiceInterrupt(
  params: {
    conversationId: string;
    utteranceUntilInterrupt: string | undefined;
    durationUntilInterruptMs: number | undefined;
  },
  deps: Pick<VoiceDeps, 'turn'>,
): void {
  deps.turn.obs.publish({
    kind: 'voice.interrupt',
    summary: `caller interrupted after ${params.durationUntilInterruptMs ?? '?'}ms`,
    channel: 'voice',
    conversationId: params.conversationId,
    ...(params.durationUntilInterruptMs !== undefined && {
      durationMs: params.durationUntilInterruptMs,
    }),
    payload: {
      heard: params.utteranceUntilInterrupt ?? null,
      durationUntilInterruptMs: params.durationUntilInterruptMs ?? null,
    },
  });
}

/**
 * `webSocketDisconnected` — the call is over, so end the trace root and forget the transcript.
 *
 * THIS IS THE END SIGNAL FOR VOICE, and `conversationEnded` is NOT — which is the opposite of SMS.
 * In orchestrated mode every one of TAC's `endConversation` paths is gated on
 * `!isOrchestratorEnabled()` except the Conversation Orchestrator `CLOSED` webhook, so a hangup
 * fires no `conversationEnded` at all. Waiting for CLOSED would mean waiting on the configuration's
 * `statusTimeouts` — minutes after the caller has gone, and possibly on a different instance.
 *
 * `history.clear` is here rather than anywhere else because this is the moment the conversation is
 * genuinely over. It is also a privacy boundary: Orchestrator reuses a conversation id for a
 * profile, so a transcript left reachable could surface in the next call from the same person.
 */
export function handleVoiceDisconnect(
  params: { conversationId: string },
  deps: Pick<VoiceDeps, 'turn' | 'conversations'>,
): void {
  const { conversationId } = params;
  deps.turn.obs.publish({
    kind: 'voice.disconnect',
    summary: 'call ended, websocket closed',
    channel: 'voice',
    conversationId,
  });
  deps.conversations.end(conversationId);
  deps.turn.history.clear(conversationId);
}
