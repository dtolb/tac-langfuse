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
import { startSpanUnder, withTurnSpan } from '../obs/spans.ts';
import type { ConversationRegistry } from '../obs/conversations.ts';
import type { TurnEnding, VoiceTimeline } from '../obs/voice-timeline.ts';
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
 * Deliberately still only TWO keys — and ⚠ THE REASON GIVEN HERE BEFORE WAS WRONG. It said TAC
 * defaults ElevenLabs TTS, Deepgram `nova-3-general`, `interruptible: 'any'`,
 * `interruptSensitivity: 'high'`, `speechTimeout: 'auto'` and `elevenlabsTextNormalization: 'off'`,
 * and that pinning them would freeze TAC's values on an upgrade. TAC defaults none of them.
 * `VoiceChannel.buildTwimlOptions` seeds exactly `welcomeGreeting: DEFAULT_WELCOME_GREETING` plus
 * `conversationConfiguration` when the orchestrator is on, then overlays `actionUrl`, the host
 * options and the per-call options. Every attribute above is only a schema field and a
 * `RELAY_ATTR_FIELDS` passthrough, and this repo sets none of them — so none is emitted on the
 * `<ConversationRelay>` element and whatever applies is TWILIO'S platform default, not TAC's.
 *
 * Which leaves a better reason for the same two keys: an attribute absent from the TwiML is one
 * Twilio can change under us, and pinning one here freezes it against a PLATFORM default we do not
 * control. Worth doing when a value has been measured to matter; not worth doing on spec. Per-call
 * overrides, if ever needed, belong on `voiceChannel.onInboundCallTwiml(...)`, a higher-precedence
 * layer.
 *
 * Note the type: `TwiMLOptions` declares this as the correct four-valued enum
 * (`none | dtmf | speech | any`). The sibling `ConversationRelayAttributes` type declares it as a
 * BOOLEAN, which is stale — do not reach for that one.
 */
export function buildVoiceTwimlOptions(publicDomain: string): {
  readonly reportInputDuringAgentSpeech: 'any';
  readonly actionUrl: string;
} {
  // Trailing slashes are STRIPPED, not merely tolerated. `../config.ts`'s `voiceSchema` rejects only a
  // scheme, so `example.ngrok.app/` is a legal configured value — and concatenating it with a path that
  // already starts with `/` yields `https://host//api/voice/relay-action`, which Fastify does not match.
  // Twilio would get a 404 on the action POST, which the caller experiences as a dropped transfer with
  // nothing in this process's log to explain it.
  const host = publicDomain.trim().replace(/\/+$/, '');
  if (host === '') {
    throw new Error(
      'buildVoiceTwimlOptions requires a non-empty publicDomain: an empty actionUrl silently deletes ' +
        'the action attribute without throwing, which drops every handoff',
    );
  }
  return {
    reportInputDuringAgentSpeech: 'any',
    // Scheme included, unlike `voicePublicDomain` — TAC builds `wss://` itself for the socket, but the
    // action URL is handed to Twilio verbatim.
    actionUrl: `https://${host}${VOICE_ACTION_PATH}`,
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
         * TAC's parked handoff frame — a COMPLETE `{type:'end', handoffData}` message, not raw data.
         * The handoff tool builds it as `{type: 'end', handoffData: JSON.stringify(payload)}` and
         * assigns it on the voice branch only.
         *
         * Read here rather than via a second `getConversationSession` lookup because TAC hands us the
         * LIVE object by reference, so the field its tool assigned is already visible on this payload.
         * MUTATED at drain time (deleted after sending), which is the one place this file writes to
         * TAC's state — deliberately, and for the same reason TAC's own drain does it
         * (`delete session.pendingHandoffData`, in `VoiceChannel.sendResponse`): a frame sent twice is
         * undefined behaviour. Hence NOT `readonly`.
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
  /**
   * The BCP-47 tag ConversationRelay says the utterance was recognised in.
   *
   * ⚠ TAC 2.2.0 NEVER SENDS THIS, and the forwarding in `./tac.ts` is wired anyway. `lang` is
   * genuinely on the wire and genuinely parsed — `PromptMessageSchema` declares
   * `lang: z.string().optional()` in the installed bundle — but `handlePromptMessage` reads only
   * `message.voicePrompt` and then spreads exactly `conversationId`, `transcript`, `abortSignal`,
   * `userMemory` and `session` into `voiceCallbacks.onPrompt`. So the field is validated and
   * dropped, and `data.lang` in `./tac.ts` is `undefined` today.
   *
   * It is forwarded rather than omitted because the alternative is patching or shadowing the vendor,
   * which this repo's "work WITH TAC" rule forbids: the forwarding costs one line, `BaseChannel.on`
   * types `data` as `any` so it compiles, and it starts carrying a value the day TAC widens that
   * spread. `asr.final` records it as null in the meantime — and see `spanAttributes` in
   * `../obs/spans.ts` for why a null metadata value means the attribute is simply ABSENT.
   */
  readonly lang?: string | undefined;
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
  /**
   * The per-call timeline. Shared by `handleVoicePrompt`, `handleVoiceInterrupt` and
   * `handleVoiceDisconnect`, which is exactly why it cannot live in a handler's closure: an
   * `interrupt` arrives on its own WebSocket frame, dispatched by TAC while the prompt handler is
   * still awaiting the send.
   */
  readonly timeline: VoiceTimeline;
  readonly logger: ToolLogger;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Enough of an utterance to recognise the turn in a console list. */
const preview = (text: string): string => (text.length <= 80 ? text : `${text.slice(0, 80)}…`);

/**
 * Pass-through generator that stamps the instant the first non-empty delta is handed on.
 *
 * ══ THIS IS THE `turn.ttfa_ms` ANCHOR, AND IT IS ONLY VALID BECAUSE IT ADDS NO AWAIT. ══
 *
 * `sendStreamingResponse` writes each chunk with `ws.send(JSON.stringify({type:'text', token: chunk,
 * last:false}))` SYNCHRONOUSLY inside its own `for await` (read in the installed 2.2.0 bundle), so
 * the moment this generator yields is the moment the frame goes out, to within microseconds. That is
 * the closest a server-side measurement can get to time-to-first-audio without owning the TTS.
 *
 * Calling this is synchronous: an async generator function returns its generator object without
 * executing a line of the body. That matters more than it looks — `run-turn.ts` gives the caller ONE
 * MACROTASK between `runTurn` resolving and the first `next()`, and an await inserted here would
 * silently null `ttftMs`/`totalMs` while the caller still hears the whole answer.
 *
 * Not `withFirstTokenMark` from `../obs/first-token.ts`: that reports ELAPSED ms from its own
 * construction, and aligning spans needs the absolute epoch instant.
 */
function markFirstTokenAt(
  tokens: AsyncIterable<string>,
  onFirstToken: (atMs: number) => void,
): AsyncIterable<string> {
  return (async function* () {
    let marked = false;
    for await (const delta of tokens) {
      if (!marked && delta.length > 0) {
        marked = true;
        onFirstToken(Date.now());
      }
      yield delta;
    }
  })();
}

/**
 * Speak one turn.
 *
 * NEVER THROWS. TAC would swallow it, so a throw here is silence with a log line.
 */
export async function handleVoicePrompt(params: VoicePrompt, deps: VoiceDeps): Promise<void> {
  /**
   * ══ THE EARLIEST INSTANT THIS PROCESS CAN OWN. FIRST LINE, BEFORE ANY AWAIT. ══
   *
   * Every span below is anchored to this, so it has to be handler entry rather than anywhere
   * convenient. And it is worth being precise about what it is NOT: it is not when the caller
   * stopped speaking, and it is not even when the `prompt` frame arrived.
   *
   * TAC's `handlePromptMessage` — read in the installed 2.2.0 bundle — reads `message.voicePrompt`,
   * starts its stream task, and then does `await this.retrieveMemoryIfEnabled(session, transcript)`
   * BEFORE calling `voiceCallbacks.onPrompt`. Voice runs `memoryMode: 'once'` (see `./tac.ts`), so on
   * turn 1 that await is a Conversation Orchestrator round-trip. There is no callback in front of it
   * and no span of ours can wrap it, so that Recall lands inside the PRECEDING `caller.turn` rather
   * than inside `turn.voice`. `caller.turn`'s comment says so, because a reader who assumes that span
   * is pure caller time will misattribute turn 1's worst number.
   *
   * TAC also serialises prompts per conversation through `promptQueues`, so a second utterance
   * arriving while turn N is still running waits here too.
   */
  const promptAt = Date.now();
  const { conversationId, transcript, abortSignal } = params;
  const { turn, conversations, sender, timeline, logger } = deps;

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

  /**
   * The bot-output boundary for THIS turn, and what put it there. Declared out here so the outer
   * `catch` — which speaks the fallback from OUTSIDE the turn span — can move the boundary on.
   */
  let boundaryAt: number | null = null;
  let ending: TurnEnding = 'no-output';
  let turnAborted = false;

  try {
    await withTurnSpan('turn.voice', traceparent, async (span) => {
      /**
       * The turn span is now live, so hand it to the timeline: this is what an inbound `interrupt`
       * frame reaches it through, and it is what closes it at the boundary instead of when this
       * callback settles.
       *
       * The return value is the PREVIOUS bot-output boundary, or null on the first turn of a call.
       *
       * ══ THIS LINE IS THE ONE STATEMENT OUTSIDE THE `try` BELOW, AND IT HAS TO BE. ══
       *
       * It is what makes the span reachable by anything that could end it, so nothing before it can
       * be covered by a `finally` that ends the turn. A throw from HERE would therefore leak an
       * unended `turn.voice` — which reaches Langfuse not at all. That is tolerable only because the
       * call is Map bookkeeping: see `../obs/voice-timeline.ts`.
       */
      const priorBotOutputAt = timeline.beginTurn(conversationId, span, promptAt);

      try {
        if (priorBotOutputAt !== null) {
          /**
           * `caller.turn` — the gap between us finishing and the caller finishing.
           *
           * ⚠ IT IS A BLEND, AND THE NAME IS THE MOST OPTIMISTIC READING OF IT. Four things live in
           * here and only one of them is the caller talking:
           *
           *  1. ConversationRelay still playing the audio we handed it. We know when the last token
           *     was SENT, never when it was HEARD — `tokens-played` appears in the ConversationRelay
           *     attribute table and nowhere in the websocket-messages reference, and TAC drops
           *     unrecognised inbound frames before dispatch anyway (see `endSession` above).
           *  2. the caller thinking, then speaking.
           *  3. STT endpointing: the silence the recogniser waits for before finalising the
           *     transcript is charged here. ⚠ AND THERE IS NOTHING IN THIS REPO TO TUNE IT WITH —
           *     this said "`speechTimeout: 'auto'` is TAC's default", which is not true of TAC.
           *     `speechTimeout` and `transcriptionProvider` are schema fields TAC passes through if
           *     you set them, and `buildVoiceTwimlOptions` sets neither, so no such attribute is
           *     emitted and the value in force is Twilio's platform default. Changing it means adding
           *     the attribute, not overriding a TAC default, and naming an STT engine here would be a
           *     guess.
           *  4. ON TURN 1 ONLY: TAC's Conversation Memory Recall, because `handlePromptMessage` awaits
           *     it before calling us. See the comment on `promptAt`.
           *
           * So it is the right span to look at when asking "why did that call feel slow?", and the
           * wrong one to quote as caller behaviour.
           *
           * Parented to the ROOT, not to this turn: it ends where the turn begins, so nesting it
           * would draw a child longer than its parent. `startSpanUnder` re-extracts the traceparent
           * for exactly that reason, even though the ambient context here is the turn span.
           */
          startSpanUnder(
            traceparent,
            'caller.turn',
            {
              metadata: {
                durationMs: promptAt - priorBotOutputAt,
                covers: 'bot playback + caller speech + ASR endpointing (+ memory recall on turn 1)',
              },
            },
            priorBotOutputAt,
          ).end(promptAt);
        }

        /**
         * `asr.final` — a zero-duration event at the instant the finalised transcript reached us.
         *
         * The transcript itself is already on the turn span's `input` (written by `runTurn`) and on
         * the `voice.transcript` obs event, so this carries only the length: it exists to put a
         * visible mark at the start of the turn in the waterfall, not to duplicate the words a third
         * time.
         */
        span.event(
          'asr.final',
          { metadata: { transcriptChars: transcript.length, lang: params.lang ?? null } },
          promptAt,
        );

        const { tokens, done } = await runTurn(
          {
            conversationId,
            channel: 'voice',
            userText: transcript,
            // ⚠ STALE COMMENT CORRECTED. This said "always null … voice runs `memoryMode: 'never'` at
            // T13, so TAC performs no Recall". T14 changed the channel to `memoryMode: 'once'` (see
            // `./tac.ts`) and `./memory-compose.ts` now uses the result, so on turn 1 this carries a
            // real `TACMemoryResponse` and on later turns TAC's cached one. The correction matters
            // here because `promptAt` above cites that Recall as the reason turn 1's `caller.turn`
            // is not pure caller time.
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
        //
        // `markFirstTokenAt` is the third thing on this line and it is still synchronous — see its
        // docblock. It stamps the `turn.ttfa_ms` anchor into the timeline, where the interrupt handler
        // can also read it; a local variable here would be unreachable from that handler.
        //
        // `span` is passed as the owner: the timeline is keyed by conversation id, and this handler can
        // outlive the start of the next turn on the same id. Without it, a straggler's first token
        // moves its SUCCESSOR's `tts.send` start. See `markFirstToken` in `../obs/voice-timeline.ts`.
        const spokenPromise = sender.sendStreamingResponse(
          conversationId,
          markFirstTokenAt(tokens, (atMs) => timeline.markFirstToken(conversationId, atMs, span)),
          { signal: abortSignal },
        );

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

        /**
         * ══ THE `last: true` ANCHOR. THE STATEMENT AFTER THE AWAIT, AND NOTHING BEFORE IT. ══
         *
         * `sendStreamingResponse` sends `{type:'text', token:'', last:true}` and then `return`s
         * `fullResponse`, so the resolution of that promise is within one microtask of the marker
         * leaving the socket.
         *
         * ⚠ A NON-EMPTY RETURN IS NOT ENOUGH, and the previous version of this comment claimed it was.
         * It said the disagreements between "non-empty return" and "the marker went out" were on paths
         * that set no boundary here. They are not: `sendStreamingResponse` does `fullResponse += chunk`
         * BEFORE `ws.send`, and both of its `break`s — `signal?.aborted` and `ws.readyState !== OPEN` —
         * fall through to `return fullResponse`. So a turn cut short mid-stream returns a non-empty
         * partial, and the old condition recorded `turn.ending: 'last-token'` for a turn whose marker
         * TAC never sent.
         *
         * THIS MIRRORS THE BUNDLE'S OWN CONDITION INSTEAD — `!signal?.aborted && hasSentTokens &&
         * ws.readyState === OPEN`, where `hasSentTokens` is true exactly when `fullResponse` is
         * non-empty. The socket is re-read rather than remembered because it is the same lookup TAC
         * makes, on the same map, one microtask earlier.
         *
         * What each disagreement now records: a BARGE-IN leaves the boundary unset here and the
         * interrupt handler's parked one wins (it is the right instant, and TAC sent the marker
         * itself); a SOCKET THAT CLOSED MID-STREAM leaves `ending: 'no-output'` at `Date.now()`, which
         * is honest — nothing closed that talk cycle, because there was nothing left to close it on.
         * A ZERO-TOKEN stream sends no marker either, which is why the empty-answer fallback further
         * down has to close the talk cycle itself.
         */
        const markerSent =
          spoken !== '' &&
          !abortSignal.aborted &&
          sender.getWebsocket(conversationId)?.readyState === WS_OPEN;
        if (markerSent) {
          boundaryAt = Date.now();
          ending = 'last-token';
        }

        const result = await done;
        // Read from `runTurn`'s result rather than from `abortSignal.aborted`, so the turn metadata
        // agrees with what run-turn published. On a real barge-in the interrupt handler has parked its
        // own `{aborted: true, ending: 'interrupt'}`, which the timeline prefers over this — so this
        // value is what a turn aborted by anything ELSE (a newer prompt, the socket closing) records.
        turnAborted = result.aborted;

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

        // ══ THE TRANSFER INTENT IS READ HERE, ABOVE THE EMPTY-ANSWER FALLBACK, AND THE ORDER IS A FIX. ══
        //
        // It used to be read below, and that produced TWO `{"type":"end"}` frames on one socket. TAC's
        // `sendResponse` drains `session.pendingHandoffData` ITSELF — it sends the parked frame and then
        // `delete`s it (read in the installed 2.2.0 bundle: `VoiceChannel.sendResponse`). So on a turn that
        // called `handoff` and then produced zero tokens — reachable, because `maxSteps` is 3 and a
        // search-then-transfer turn can exhaust it — the fallback `sendResponse` below would send the
        // parked frame as a side effect, and the drain further down would then find the intent, see
        // `parked === undefined`, and send a SECOND bare `{"type":"end"}`. The obs event also reported
        // `hadPayload: false` for a transfer that did carry one.
        //
        // Reading it first also gives the caller the better utterance: someone who has just asked for a
        // person should not hear "Sorry, I didn't catch that" and *then* be transferred.
        const handoffReason = consumeHandoffRequest(conversationId);

        // AN EMPTY ANSWER IS DEAD AIR, and not for the obvious reason. `sendStreamingResponse` emits
        // the `{token: '', last: true}` end-of-turn marker only if at least one token was sent, so a
        // zero-token stream closes nothing: ConversationRelay keeps waiting for us and the caller
        // hears an open line forever. Speaking real text is what ends the talk cycle.
        //
        // UNLESS A TRANSFER IS PENDING, in which case the end frame below closes the talk cycle instead —
        // and speaking here would both duplicate the frame (see above) and stall the transfer behind a
        // sentence the caller did not ask for. The silent zero-token transfer is still observable: the
        // `handoff` event below carries `farewell: ''`.
        if (spoken === '' && handoffReason === null) {
          turn.obs.publish({
            kind: 'error',
            summary: 'voice turn produced no tokens — spoke the fallback to close the talk cycle',
            channel: 'voice',
            conversationId,
            payload: { steps: result.steps, aborted: false },
          });
          await sender.sendResponse(conversationId, VOICE_FALLBACK_TEXT);
          // `sendResponse` sends its own end-of-turn marker, so THIS is the bot-output boundary for a
          // zero-token turn. Without it the next `caller.turn` would back-date to before the fallback
          // was spoken and charge the caller for our own dead air.
          boundaryAt = Date.now();
          ending = 'fallback';
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
           * lines sitting inside `VoiceChannel.sendResponse` — `ws.send(JSON.stringify(session.
           * pendingHandoffData))` followed by `delete session.pendingHandoffData`.
           * `sendStreamingResponse`, which is what this channel uses on every turn, has ZERO references
           * to the field; those, plus the `pendingHandoffData` declaration on TAC's session schema and
           * the handoff tool's assignment to it, are every mention in the bundle. So on a streaming app
           * the parked frame is never sent at all, and TAC's own streaming example never drains it
           * either. (Cited by symbol, not by line: grep the installed 2.2.0 `dist/index.js` for
           * `pendingHandoffData` and all four sites are in the output.)
           *
           * ⚠ WHAT THE `?? {type:'end'}` FALLBACK ACTUALLY DOES, corrected. It does NOT transfer. A bare
           * end produces an action POST with no `HandoffData`, and `../http/routes-voice-action.ts`'s
           * `buildActionTwiml` takes its `handoffData === undefined` branch and answers `<Hangup/>` — so
           * the fallback ends the call CLEANLY rather than reaching a human. (The claim here before was
           * written at Task 3 as a forward reference to a route that did not exist yet; Task 4 built it the
           * other way.) It is kept because a clean hangup is still better than an open line, but it is the
           * outcome the "TRANSFER WINS UNCONDITIONALLY" note above calls the worst available one.
           *
           * The path is now UNREACHABLE for the case that used to reach it: the only way the tool could
           * succeed and the frame be absent was TAC's own drain inside the fallback `sendResponse`, which
           * the hoisted `handoffReason` above no longer lets run. `parked` can still be `undefined` if TAC
           * ever stops parking a frame at all, which is what this fallback now covers.
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
      } catch (err) {
        /**
         * ══ THE ERROR MARKING ON THE TURN SPAN IS NOW OURS, AND THAT IS A CONSEQUENCE OF ENDING IT
         * OURSELVES. ══
         *
         * `@langfuse/tracing`'s `wrapPromise` is the only thing that used to mark a failed turn: on a
         * rejection it calls `span.setStatus({code: ERROR, message})` and then ends the span. The
         * `finally` below now ends it first, and OpenTelemetry's `Span.setStatus` returns early once
         * `_isSpanEnded()` — so the vendor's marking is dropped. Measured: a turn whose `prompts.get`
         * throws exported `status {code: 0}` (UNSET) where the same failure through the vendor's own
         * ending exported `{code: 2, message: 'boom'}`. A failed voice turn looked like a successful
         * one in the trace, with only the log line and the obs `error` event to say otherwise.
         *
         * `level` / `statusMessage` are the Langfuse-native pair for this and reach the exporter as
         * observation attributes (`createObservationAttributes` recognises both), so this restores the
         * marking on the sink that matters here. The OTel status code stays UNSET; nothing in this
         * stack reads it.
         *
         * Rethrown unchanged — the outer `catch` is what speaks the fallback line.
         */
        span.update({ level: 'ERROR', statusMessage: errorMessage(err) });
        throw err;
      } finally {
        /**
         * ══ THE TURN SPAN IS ENDED HERE, ON EVERY EXIT FROM THIS BLOCK INCLUDING THE THROW PATH. ══
         *
         * This is what makes `turn.voice` end at the `last: true` instant rather than whenever this
         * callback happens to settle, and it is why the call below passes `endOnExit: false`. There are
         * FOUR exits — the abort branch, the handoff branch, a normal fall-through and a throw — and a
         * missed one is not a wrong duration, it is an observation that never reaches Langfuse at all
         * (see `../obs/spans.ts`). Hence a `finally` rather than four call sites.
         *
         * "This block" is meant literally, and the previous wording ("every exit path") was too strong:
         * `timeline.beginTurn` runs above the `try` and a throw from there would leak the span. Its
         * docblock says why that is where the line has to be.
         *
         * `completeTurn` DOES NOTHING IF THE TURN IS NO LONGER LIVE, and it is passed `span` so that
         * "the turn" means this one. Two things rest on that, neither of which is the metadata overwrite
         * an earlier version of this comment described — a post-end `update` is dropped by the SDK, so
         * that could not happen. What it actually prevents is (1) a SECOND back-dated `tts.send` child
         * and a double count in `turns.count` / `turn.ttfa_p50_ms` on the root, plus a `diag.error` from
         * the second `end()`, on a path where something else already closed this turn; and (2) closing
         * the NEXT turn's span with this turn's boundary, when this handler outlived the arrival of the
         * next prompt on the same conversation id.
         *
         * `boundaryAt ?? Date.now()` covers the paths that sent nothing: a dead socket, or a turn that
         * threw before speaking. `now` is a worse anchor than a real send, but it keeps the next
         * `caller.turn` from absorbing this turn's whole duration. On a barge-in the interrupt handler
         * has parked the true boundary and the timeline prefers it over whatever is passed here.
         */
        timeline.completeTurn(
          conversationId,
          { atMs: boundaryAt ?? Date.now(), aborted: turnAborted, ending },
          span,
        );
      }
      // Anchored to `prompt` receipt, and held open past the callback — see the `finally` above.
    }, { startTimeMs: promptAt, endOnExit: false });
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
      // The fallback DID close the talk cycle, with `sendResponse`'s own end-of-turn marker, so the
      // boundary belongs here rather than a few milliseconds earlier. Skipping it would make the next
      // `caller.turn` start before we had finished speaking.
      //
      // The BOUNDARY only, deliberately: on every path that reaches here from inside the `try` above,
      // the turn span has already been ended by its `finally` and there is nothing left to annotate.
      // (`timeline.beginTurn` sits outside that `try`; a throw from there is the one exit with no turn
      // span in the trace at all, and this line is still the right thing to do.)
      timeline.markBotOutput(conversationId, Date.now());
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
 * No longer reporting only. TAC has already aborted the turn's signal by the time this runs and
 * Twilio's own documentation prescribes no server action, so nothing is SENT from here — but this is
 * the bot-output boundary, and it is the only place that knows it.
 *
 * ══ WHY THE INTERRUPT IS THE BOUNDARY, AND NOT ANYTHING WE SEND. ══
 *
 * `handleInterruptMessage` cancels the stream task and then, if tokens had already gone out, sends
 * `{type:'text', token:'', last:true}` ITSELF before invoking this callback (read in the installed
 * 2.2.0 bundle — the guard is `cancelled && wasStreaming`). So on a barge-in the end-of-turn marker
 * has already left the socket by the time we are called, and this instant is the only correct one.
 *
 * ⚠ WHAT DOES NOT FOLLOW, and an earlier version of this comment claimed it did: that
 * `handleVoicePrompt` "will never set a boundary of its own" because its `sendStreamingResponse`
 * skips the marker. Skipping the marker is not what that handler keys on — it keys on its own view of
 * the send, and `sendStreamingResponse` returns the PARTIAL response on the aborted path, so the
 * naive check produced a `last-token` boundary here too. It now re-tests the bundle's own marker
 * condition, `!aborted && spoken !== '' && socket OPEN`, which the abort fails; and the boundary
 * parked below wins over anything a closer passes in regardless. Two mechanisms, deliberately: the
 * second is the one that does not depend on the first staying right.
 *
 * ══ AND WHY THIS DOES NOT END THE SPAN. ══
 *
 * It used to, and that silently cost every barged-in turn its `langfuse.observation.output`,
 * `tools.called` and `turn.total_model_ms` — `../agent/run-turn.ts` writes those inside `done`, which
 * resolves AFTER this callback (TAC invokes it synchronously right after `cancelStreamTask`, while
 * `done` still needs the drain), and a post-end `setAttribute` is dropped by OpenTelemetry. So the
 * instant is parked and the prompt handler's `finally` — which has awaited `done` — does the closing.
 * See `recordBoundary` in `../obs/voice-timeline.ts`.
 *
 * `utteranceUntilInterrupt` is the one place the words the caller actually HEARD are available; it is
 * published and put on the event so the console and Langfuse can show it, and deliberately not
 * written back into history (see `handleVoicePrompt`).
 */
export function handleVoiceInterrupt(
  params: {
    conversationId: string;
    utteranceUntilInterrupt: string | undefined;
    durationUntilInterruptMs: number | undefined;
  },
  deps: Pick<VoiceDeps, 'turn' | 'timeline'>,
): void {
  // Before the publish, for the same reason `promptAt` is the first line of `handleVoicePrompt`.
  const interruptAt = Date.now();

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

  /**
   * The live turn span, reached through the timeline because this callback has NEITHER the prompt
   * handler's closure NOR an active OpenTelemetry context — TAC dispatches it from its own WebSocket
   * message handler. A bare `startObservation` here would become the root of a second trace.
   *
   * `null` is normal, not an error: ConversationRelay can send an `interrupt` when no turn is running
   * (the caller talking over the welcome greeting, which is Twilio's TwiML, not ours). It is also why
   * `recordBoundary` below is not reached in that case — there is no turn to attribute it to, and the
   * greeting is not something this process ever sent.
   */
  const live = deps.timeline.liveTurn(params.conversationId);
  if (live === null) return;

  live.event(
    'tts.interrupted',
    {
      metadata: {
        durationUntilInterruptMs: params.durationUntilInterruptMs ?? null,
        // The ground truth for what the caller HEARD, as opposed to what we generated. Scrubbed on
        // the way onto the span like every other field — see `scrubFields` in `../obs/spans.ts`.
        utteranceUntilInterrupt: params.utteranceUntilInterrupt ?? null,
      },
    },
    interruptAt,
  );

  // Parks the boundary and moves the next `caller.turn`'s origin to it. The span is ended by
  // `handleVoicePrompt`'s `finally`, at THIS instant, once `runTurn`'s `done` has had its say.
  deps.timeline.recordBoundary(params.conversationId, {
    atMs: interruptAt,
    aborted: true,
    ending: 'interrupt',
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
  deps: Pick<VoiceDeps, 'turn' | 'conversations' | 'timeline'>,
): void {
  const { conversationId } = params;
  deps.turn.obs.publish({
    kind: 'voice.disconnect',
    summary: 'call ended, websocket closed',
    channel: 'voice',
    conversationId,
  });
  /**
   * ORDER IS LOAD-BEARING, and it is the opposite of what reads naturally. `conversations.end` runs
   * the registry's `onClose` hook, which is where `./tac.ts` reads the timeline's call-level
   * statistics onto the root span — so forgetting the timeline first would silently produce a root
   * with `closedBecause` and nothing else.
   *
   * The `forget` after it is not redundant. `onClose` fires only if a registry entry EXISTS, and a
   * root already closed by the TTL sweep leaves `end` a no-op while a timeline entry survives. This is
   * what keeps the two maps the same size in the ordinary case.
   */
  deps.conversations.end(conversationId);
  deps.timeline.forget(conversationId);
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
