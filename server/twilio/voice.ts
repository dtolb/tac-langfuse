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
import { consumeEndCallRequest, forgetEndCallRequest } from '../agent/tools/end-call.ts';
import { VOICE_ACTION_PATH, type HandoffTranscriptTurn } from '../../shared/handoff.ts';
import { consumeHandoffRequest, forgetHandoffRequest } from './handoff.ts';
import { recordHandoffSnapshot } from '../handoff/snapshots.ts';

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
 * A FUNCTION rather than a constant since T14b, because the second key depends on the public host.
 *
 * ── `actionUrl`, AND WHY IT IS NOT OPTIONAL ───────────────────────────────────────────────────────
 *
 * This is the `<Connect action>` URL: where Twilio POSTs when the ConversationRelay session ends, and
 * therefore the only place a handoff can be routed. Left unset, TAC's `resolveActionUrl`
 * (`dist/index.js:5447-5460`) falls through to Studio when a flow SID is configured, or to its own
 * derived `/conversation-relay-callback`. BOTH are wrong for a handoff:
 *
 *  - TAC's own route answers `{status: 200, content: 'OK', contentType: 'text/plain'}`
 *    (`handleConversationRelayCallback`, `dist/index.js:5618`) — never TwiML. And its
 *    `ConversationRelayCallbackPayloadSchema` (`dist/index.js:1020-1051`) has no `HandoffData` field;
 *    being a plain non-strict `z.object` it STRIPS it. So the POST arrives, the handoff is silently
 *    discarded, and the call is dropped.
 *  - Studio's own handoff webhook works but takes the routing decision away from this process, so the
 *    zero-Studio-setup path (`<Dial><Client>`) becomes unreachable.
 *
 * `defaultTwimlOptions` is layer 2 of the five `resolveActionUrl` checks, and nothing sits between it
 * and Studio: layer 1 is the `onInboundCallTwiml` customizer, which this repo never registers, and
 * layer 3 is the calling host's per-call options, which is always undefined inbound because `TACServer`
 * calls `handleIncomingCall(twimlRequest)` with no second argument (`dist/index.js:6757`). So pinning
 * here wins over Studio, which is what makes `POST /api/voice/relay-action` reachable at all.
 *
 * MEASURED against 2.2.0, both directions, with `studioHandoffFlowSid` set: this builder's value emits
 * `<Connect action="https://…/api/voice/relay-action">`, and the same channel with `actionUrl` omitted
 * emits `<Connect action="https://webhooks.twilio.com/v1/Accounts/…/Flows/FW…?Trigger=incomingCall">`.
 * The precedence is not inferred from the source; it was driven through `handleIncomingCall`.
 *
 * ── THE THROW IS THE POINT ────────────────────────────────────────────────────────────────────────
 *
 * `TwiMLOptionsSchema` declares `actionUrl: z.string().min(1, 'actionUrl must not be empty')`, but
 * `VoiceChannelConfig` is a plain INTERFACE, so that validation never runs for `defaultTwimlOptions` —
 * `resolveActionUrl` reads the field straight off it. Read in the 2.2.0 bundle: `generateTwiml` emits
 * `response.connect(options.actionUrl ? { action: options.actionUrl } : {})` (`dist/index.js:5901`), so
 * an empty string is falsy, the attribute is simply absent, and nothing throws anywhere. An empty
 * public domain would therefore delete end-of-call routing in silence — so this asserts at boot, where
 * it is one loud line, rather than on a live call, where it is a dropped transfer.
 *
 * ── AND THE KEY THAT WAS ALREADY HERE ─────────────────────────────────────────────────────────────
 *
 * `reportInputDuringAgentSpeech` is unchanged. Its default changed from
 * `any` to `none` in May 2025, and `none` means the caller can interrupt us — `interruptible`
 * defaults to `any`, so the audio does stop and an `interrupt` message does arrive — but **the words
 * that caused the interruption are never delivered as a `prompt`**. The agent stops talking and then
 * cannot hear, which on a live call is indistinguishable from a crash. Every ConversationRelay
 * example written before May 2025 assumes the old default and therefore omits this line.
 *
 * Deliberately still only TWO keys. TAC's remaining defaults are good ones (ElevenLabs TTS, Deepgram
 * `nova-3-general`, `interruptible: 'any'`, `interruptSensitivity: 'high'`, `speechTimeout: 'auto'`,
 * `elevenlabsTextNormalization: 'off'` which matters for latency), and pinning them here would
 * silently freeze them at 2.2.0's values on the next upgrade. Per-call overrides, if ever needed,
 * belong on `voiceChannel.onInboundCallTwiml(...)`, which is a higher-precedence layer.
 *
 * Note the type: `TwiMLOptions` declares this as the correct four-valued enum
 * (`none | dtmf | speech | any`). The sibling `ConversationRelayAttributes` type declares it as a
 * BOOLEAN, which is stale — do not reach for that one.
 */
export function buildVoiceTwimlOptions(publicDomain: string): {
  readonly reportInputDuringAgentSpeech: 'any';
  readonly actionUrl: string;
} {
  if (publicDomain.trim() === '') {
    throw new Error(
      'buildVoiceTwimlOptions requires a non-empty publicDomain: an empty actionUrl silently deletes ' +
        'the action attribute without throwing, which drops every handoff',
    );
  }
  return {
    reportInputDuringAgentSpeech: 'any',
    // Scheme included, unlike `voicePublicDomain` — TAC builds `wss://` itself for the socket, but the
    // action URL is handed to Twilio verbatim.
    actionUrl: `https://${publicDomain}${VOICE_ACTION_PATH}`,
  };
}

/**
 * What TAC's `prompt` callback hands us, narrowed to what this file reads.
 *
 * `memory` is `unknown` for the same reason as in `./messaging.ts`: it is a class instance with
 * getters, only `composeMemory` knows its shape, and typing it here would drag the vendor in.
 *
 * ⚠ CORRECTED AT T14, and the old wording was wrong in a way that cost us a feature. It said *"there
 * is no `profileId` on this payload — voice does not get one"* and that `session` is absent under
 * `memoryMode: 'never'`. Only the first half of the second claim is true. TAC's emit site
 * (`packages/core/src/channels/voice.ts:726-742`; dist `index.js:5167-5176`) spreads
 * `...userMemory !== undefined && { userMemory }` and `...session !== undefined && { session }` — so
 * `userMemory` is memory-mode gated but **`session` is gated only on its own existence**, and a
 * session always exists by the time TAC dispatches a prompt. The session was therefore reachable on
 * every turn since T13 and was simply being discarded, `profileId` along with it.
 *
 * `session.profileId` is what makes Conversation Memory and TAC's memory-retrieval tool work on this
 * channel: the tool takes the profile as a constructor argument and throws
 * "No profile ID available for memory retrieval" without one.
 */
export interface VoicePrompt {
  readonly conversationId: string;
  /** The caller's utterance, already finalised by STT. */
  readonly transcript: string;
  /**
   * TAC's per-conversation session. Optional because TAC declares it so — a defensive `?.` on
   * `profileId` is cheaper than an assumption that would fail as silence on a live call.
   *
   * Narrowed to the three fields this file touches. TAC's `getConversationSession` returns the LIVE
   * object by reference, not a copy, so this is TAC's own state — and since T14b one field of it is
   * WRITTEN here rather than only read. See `pendingHandoffData` below.
   *
   * ⚠ THIS SHAPE IS NOT CHECKED AT THE REAL CALL SITE, so the test is what pins it. `BaseChannel.on`
   * is declared `on(event: string, callback: (...args: any[]) => void)` (`dist/index.d.ts:3696`), so
   * `data` in `./tac.ts`'s `voiceChannel.on('prompt', …)` is `any` and every field forwarded from it is
   * unchecked. `tests/voice.test.ts` therefore passes a real `ConversationSession` — which is why each
   * member below is written to accept TAC's own optionality (`string | undefined`, never `null`) rather
   * than a convenient local shape that would compile and then miss on a live call.
   */
  readonly session?:
    | {
        readonly profileId?: string | undefined;
        /**
         * The caller's address — a phone number on this channel. Read at drain time so the screen pop
         * can correlate on it, which is the only correlator the Studio path leaves us: its
         * `connect-call-to` widget cannot pass parameters to a client, and dialling a client mints a
         * new call leg with a new CallSid.
         */
        readonly authorInfo?: { readonly address?: string } | undefined;
        /**
         * TAC's parked handoff frame — a COMPLETE `{type:'end', handoffData}` message, not raw data
         * (`dist/index.js:6485-6490`).
         *
         * Read here rather than via a second `getConversationSession` lookup because TAC hands us the
         * LIVE object by reference, so the field its tool assigned is already visible on this payload.
         * MUTATED at drain time (deleted after sending), which is the one place this file writes to
         * TAC's state — deliberately, and for the same reason TAC's own drain does it
         * (`delete session.pendingHandoffData`, `dist/index.js:5249`): a frame sent twice is undefined
         * behaviour. Hence NOT `readonly`.
         */
        pendingHandoffData?: { readonly type: string; readonly handoffData: string } | undefined;
      }
    | undefined;
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
  /**
   * The raw socket, so we can send the one ConversationRelay frame TAC has no method for — see
   * `endSession` below. Public on `VoiceChannel`, so this needs no vendor internals.
   */
  getWebsocket(conversationId: string): VoiceSocket | null;
}

/** Just the two members `endSession` touches. `ws`'s WebSocket satisfies it. */
export interface VoiceSocket {
  send(data: string): void;
  readonly readyState: number;
}

/** `WebSocket.OPEN`. Spelled out rather than imported, so this file needs no `ws` dependency. */
const WS_OPEN = 1;

/**
 * End the ConversationRelay session, which is how a voice agent hangs up.
 *
 * `{"type":"end"}` is Twilio's documented server→ConversationRelay message: *"End the session and
 * return control of the call to Twilio through Conversation Relay."* `handoffData` is optional per
 * Twilio (TAC's own schema for it requires the field, but that schema is for Studio handoff, not
 * this), so a plain end carries nothing.
 *
 * WHY WE SEND THE FRAME OURSELVES. TAC exposes no "end session" method. It builds this exact frame
 * for Studio handoff and parks it on `session.pendingHandoffData` — but that is drained ONLY inside
 * `sendResponse`, never inside `sendStreamingResponse`, so on a streaming channel like ours a parked
 * frame would never be sent at all. `getWebsocket()` is public, so writing the documented frame is
 * both simpler and less coupled than reaching into session state.
 *
 * WHAT IT DOES NOT DO: hang up. The session ends and control returns to Twilio, which then requests
 * the `<Connect action>` URL — with `CallStatus: in-progress`. TAC answers that route with `"OK"` as
 * **text/plain, not TwiML**, so Twilio gets nothing actionable and drops the call. That is the
 * hangup, and it is a side effect of TAC's response rather than something we asked for; expect a
 * TwiML warning in the Twilio debugger, and if a clean disposition ever matters, the fix is to return
 * real `<Hangup/>` TwiML from that route rather than to change this frame.
 *
 * HONEST LIMIT: there is no documented way to know that audio already sent has finished playing to
 * the caller. `tokens-played` is named in the ConversationRelay attribute table but appears nowhere
 * in the websocket-messages reference, and TAC drops unrecognised inbound frames before dispatch
 * anyway. So this relies on ConversationRelay draining what it has been given when it ends the
 * session, which is the sanctioned mechanism but not a promise in writing. A timing-based hangup was
 * the alternative and it is strictly worse: it guesses.
 */
function sendFrame(
  sender: VoiceSender,
  conversationId: string,
  frame: object,
  logger: ToolLogger,
): boolean {
  const ws = sender.getWebsocket(conversationId);
  if (ws === null || ws.readyState !== WS_OPEN) {
    // Normal, not an error: the caller may have hung up during the goodbye.
    logger.debug({ conversationId }, 'voice: no open socket to end — the call is already gone');
    return false;
  }
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch (err) {
    logger.warn({ err, conversationId }, 'voice: could not send the end frame');
    return false;
  }
}

/**
 * A bare end, carrying nothing. The `end_call` case.
 *
 * `sendFrame` was generalised out of this at T14b because handoff and `end_call` differ ONLY in the
 * payload: `{"type":"end"}` alone for a hangup, `{"type":"end","handoffData":"<json>"}` for a transfer.
 * Both end the session and return control of the call to Twilio, which then requests the
 * `<Connect action>` URL — the entire difference is in what that route is told.
 */
const endSession = (sender: VoiceSender, conversationId: string, logger: ToolLogger): boolean =>
  sendFrame(sender, conversationId, { type: 'end' }, logger);

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
          // From TAC's session, which is on the prompt payload in EVERY memory mode — see the
          // corrected note on `VoicePrompt`. `null` when Orchestrator resolved no customer, which is
          // a real state (an unrecognised caller), not an error.
          profileId: params.session?.profileId ?? null,
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
        // And they are evidently NOT done, so drop any hangup the model had queued. Interrupting the
        // goodbye is exactly how a caller says "wait, one more thing", and honouring the pending
        // end_call here would hang up on them mid-sentence.
        forgetEndCallRequest(conversationId);
        // Same argument for the transfer: interrupting the "putting you through" line is how a caller
        // says "wait, no". Honouring a queued transfer here would send them to a human mid-objection.
        //
        // ⚠ This clears the INTENT and leaves `session.pendingHandoffData` parked, and the asymmetry is
        // correct rather than a leak: the frame is inert unless something sends it, TAC's own drain in
        // `sendResponse` would legitimately send it if a later turn took that path, and the tool has
        // already set the conversation INACTIVE — so the parked frame is the one thing still able to
        // release the call cleanly. Do not "fix" this by deleting it.
        forgetHandoffRequest(conversationId);
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

      // ══ THE TRANSFER AND THE HANGUP, IN THAT ORDER, AND THEY MUST BE LAST. ══
      //
      // Both tools only recorded an intent — see `../agent/tools/end-call.ts` and `./handoff.ts` for
      // why neither can act where it stands. By here the farewell has been streamed and its
      // `last: true` marker sent, so ending the session is the next thing the caller should
      // experience. Doing this any earlier truncates the goodbye; doing it inside a tool truncates it
      // before it is even written.
      //
      // ══ TRANSFER WINS UNCONDITIONALLY. ══
      //
      // Two `{"type":"end"}` frames on one socket is undefined behaviour, so exactly one goes out.
      // Hanging up on someone who has just asked for a human is the worst available outcome, so the
      // handoff is checked FIRST and a pending `end_call` is dropped, not queued.
      const handoffReason = consumeHandoffRequest(conversationId);
      if (handoffReason !== null) {
        forgetEndCallRequest(conversationId);

        /**
         * SNAPSHOT BEFORE THE FRAME GOES OUT, and this is the only moment it can be taken.
         *
         * `handleVoiceDisconnect` calls `history.clear()` when the socket closes, and the socket closes
         * BECAUSE we are about to send this frame. Taking it here rather than inside the tool is also
         * what makes it complete: `../agent/run-turn.ts` appends the user+assistant pair at the END of
         * the turn, before `done` resolves, so by this line history holds the caller's request AND the
         * farewell. Inside the tool it would hold neither.
         *
         * A snapshot failure must NOT block the transfer — the screen pop degrades to reason-only,
         * which is still a working handoff. Hence the try/catch around the store and not around the
         * send. `system` turns are dropped rather than trusted to be absent: they are the compiled
         * prompt, and a human agent's screen is not a place to leak it.
         */
        try {
          const transcript: HandoffTranscriptTurn[] = turn.history
            .read(conversationId)
            .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
            .map((m) => ({ role: m.role, text: m.content }));
          recordHandoffSnapshot({
            conversationId,
            reason: handoffReason,
            from: params.session?.authorInfo?.address ?? null,
            at: new Date().toISOString(),
            transcript,
          });
        } catch (err) {
          logger.warn({ err, conversationId }, 'voice: could not snapshot the transcript for the screen pop');
        }

        /**
         * THE FIVE LINES TAC OMITS HERE.
         *
         * `session.pendingHandoffData` is already a complete frame, and TAC's own drain for it is five
         * lines sitting inside `sendResponse` (`dist/index.js:5246-5250`). `sendStreamingResponse`
         * (`dist/index.js:5278`) — which is what this channel uses on every turn — has ZERO references
         * to the field; those three, plus the schema declaration at `dist/index.js:263` and the tool's
         * assignment at `6490`, are every mention in the bundle. So on a streaming app the parked frame
         * is never sent at all, and TAC's own streaming example never drains it either.
         *
         * Falling back to a plain `{type:'end'}` is deliberate: if the tool succeeded but the frame is
         * somehow absent, ending the session still returns control to Twilio and our action route still
         * answers, so the caller reaches a human without the payload rather than sitting on a dead line.
         */
        const parked = params.session?.pendingHandoffData;
        const sent = sendFrame(sender, conversationId, parked ?? { type: 'end' }, logger);
        if (parked !== undefined && params.session !== undefined) {
          // Exactly what TAC's drain does, and for the same reason: a frame sent twice is undefined
          // behaviour, and Orchestrator reuses a conversation id per profile.
          delete params.session.pendingHandoffData;
        }

        turn.obs.publish({
          kind: 'handoff',
          summary: sent
            ? `transferred to a human: ${handoffReason}`
            : `tried to transfer but the socket was gone: ${handoffReason}`,
          channel: 'voice',
          conversationId,
          payload: {
            reason: handoffReason,
            frameSent: sent,
            hadPayload: parked !== undefined,
            farewell: spoken,
          },
        });
        return;
      }

      const endReason = consumeEndCallRequest(conversationId);
      if (endReason !== null) {
        const sent = endSession(sender, conversationId, logger);
        turn.obs.publish({
          kind: 'voice.end',
          summary: sent ? `agent ended the call: ${endReason}` : `agent tried to end the call but the socket was gone: ${endReason}`,
          channel: 'voice',
          conversationId,
          payload: { reason: endReason, frameSent: sent, farewell: spoken },
        });
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
  // Normally already consumed by the turn that hung up. This covers the other endings — the caller
  // hung up first, or the socket dropped between the tool call and the goodbye — so an intent cannot
  // survive to be acted on by a later call that reuses the conversation id.
  forgetEndCallRequest(conversationId);
  // The INTENT only. The SNAPSHOT deliberately survives — this handler fires the moment the socket
  // closes, which on a transfer is seconds BEFORE a human presses answer, so clearing it here would
  // make the screen pop reliably empty on the one path it exists for. `../handoff/snapshots.ts` bounds
  // its lifetime by eviction instead, and says so in `forgetHandoffSnapshot`'s header.
  forgetHandoffRequest(conversationId);
}
