/**
 * TAC boot. THE ONLY FILE IN THE REPO THAT IMPORTS `twilio-agent-connect`.
 *
 * Imported DYNAMICALLY by `server/index.ts`, and that matters twice over: a process with no Twilio
 * credentials never loads TAC at all, and a failure in here degrades instead of killing the server.
 *
 * ONE function boots BOTH channels, because there can only be one `TACServer` — it owns `listen()`.
 * SMS and voice gate independently (`caps.sms` / `caps.voice`), so this has to cope with either one
 * alone as well as both.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ORDER IS LOAD-BEARING IN FOUR PLACES, and every one of them fails quietly.
 *
 * 1. `await app.register(gracefulShutdown, …)` MUST come before `new TACServer(...)`, and the
 *    `await` is part of the requirement — see `TAC_SHUTDOWN_TIMEOUT_MS`.
 *
 * 2. `registerChannel(smsChannel)` MUST happen before `new TACServer(...)`. The constructor
 *    SNAPSHOTS channels and `setupRoutes` only registers the conversation webhook
 *    `if (webhookChannels.length > 0)`. Get it wrong and inbound SMS 404s, with nothing in the log
 *    but "No channels configured for webhook processing".
 *
 * 3. The voice channel is the mirror image: it is passed to `TACServer` and MUST NOT be registered.
 *    `registerChannel` installs TAC's own forwarders into the single-slot `prompt`, `interrupt`,
 *    `error` and `conversationEnded` setters, so ours would be silently replaced — confirmed against
 *    2.2.0 in spike S4. Passing it as `config.voiceChannel` wires every voice route just the same
 *    (`config.voiceChannel ?? tac.getChannel('voice')`) while leaving all eight slots ours.
 *
 * 4. Our routes must already be on the Fastify instance before `start()`. They are: `buildApp()` ran
 *    long before this file is reached. TAC adds its own routes inside `start()`, so ours are first.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `TACServer.start()` calls `listen()` ITSELF, so `server/index.ts` must not also call it. That is
 * why this returns a handle whose `start()` is the thing that binds the port.
 */
import type { FastifyInstance } from 'fastify';
import gracefulShutdown from 'fastify-graceful-shutdown';
import type { z } from 'zod';
import {
  SMSChannel,
  TAC,
  TACConfig,
  TACConfigSchema,
  TACServer,
  VoiceChannel,
} from 'twilio-agent-connect';
import { AGENT_PORT } from '../../shared/ports.ts';
import type { AppConfig, Capabilities } from '../config.ts';
import { childLogger, tacLogger } from '../logging.ts';
import { createConversationRegistry, type ConversationRegistry } from '../obs/conversations.ts';
import type { TurnDeps } from '../agent/types.ts';
import type { App } from '../http/types.ts';
import { handleInboundMessage } from './messaging.ts';
import {
  handleVoiceDisconnect,
  handleVoiceInterrupt,
  handleVoicePrompt,
  handleVoiceSetup,
  VOICE_CONVERSATION_TTL_MS,
  VOICE_MAX_CONVERSATIONS,
  VOICE_TWIML_OPTIONS,
} from './voice.ts';

const log = childLogger('tac');

/** SMS conversations are long-lived and asynchronous, so both bounds are looser than the bench's. */
export const SMS_CONVERSATION_TTL_MS = 2 * 60 * 60_000;
export const SMS_MAX_CONVERSATIONS = 200;

/**
 * How long the shutdown watchdog waits before hard-killing the process — and why we own it.
 *
 * `fastify-graceful-shutdown` arms `setTimeout(() => process.exit(1), timeout)` the instant a signal
 * arrives, runs every registered handler with `Promise.all`, and only THEN calls `fastify.close()`.
 * TAC registers that plugin with **no options**, so the deadline is the plugin's 10 s default — while
 * TAC's own handler awaits `waitForWebSocketsToClose(timeoutMs = 3e4)`, i.e. up to 30 seconds.
 *
 * Our `preClose` hook — the ONLY telemetry flush, because the plugin always leaves via
 * `process.exit` and `beforeExit` therefore never fires — lives inside `fastify.close()`. So with one
 * open ConversationRelay socket at SIGTERM the arithmetic is: watchdog at 10 s, WebSocket wait until
 * 30 s, `fastify.close()` never reached, flush never runs, and the whole call is missing from
 * Langfuse. Docker reports the SIGTERM as a crash. SMS never exposed this because it opens no
 * sockets; voice does, on every call.
 *
 * 45 s is 30 s of WebSocket wait plus headroom for the flush. Finite on purpose: `0` would silently
 * become 10000 (the plugin uses `||`), and `Infinity` makes Node clamp the timer to 1 ms, which is
 * worse than the default.
 *
 * TAC's guard is `if (!this.fastify.hasDecorator('gracefulShutdown'))`, so registering first is what
 * makes ours win — and registering SECOND is not merely useless, it throws
 * `FST_ERR_DEC_ALREADY_PRESENT`.
 */
export const TAC_SHUTDOWN_TIMEOUT_MS = 45_000;

export interface TacHandle {
  /** Binds the port — TAC owns `listen()`. */
  start(): Promise<void>;
  /** End every open conversation root span, on both channels. Called from the `preClose` hook. */
  shutdown(): void;
}

export interface TacDeps {
  readonly app: App;
  readonly config: AppConfig;
  readonly caps: Capabilities;
  readonly turn: TurnDeps;
}

/**
 * Wire TAC for whichever channels are configured. Throws on anything the caller should degrade
 * from — see `server/index.ts`.
 *
 * Reachable only once `caps.sms || caps.voice`, either of which guarantees `config.twilio` is
 * non-null and that the corresponding channel-specific value passed our own Zod validation. That is
 * what makes the `TACConfig` construction below safe.
 */
export async function bootTac(deps: TacDeps): Promise<TacHandle> {
  const { app, config, caps, turn } = deps;
  if (config.twilio === null || (!caps.sms && !caps.voice)) {
    // Unreachable through `index.ts`, which gates on capabilities first. Explicit because the
    // alternative is a confusing ZodError from inside the vendor.
    throw new Error('bootTac requires config.twilio and at least one of caps.sms / caps.voice');
  }

  /**
   * Built from our already-validated config, NOT `TACConfig.fromEnv()`.
   *
   * `fromEnv()` reads `process.env` directly, which would make it a SECOND place the environment is
   * read and break the rule that `server/config.ts` is the only one. It also reports just the first
   * missing variable, where our config reports all of them with what each one costs.
   */
  // Annotated as the SCHEMA INPUT, not `TACConfigData`. The constructor takes a union of the two, and
  // TypeScript resolves to `TACConfigData` — which demands `voiceWebsocketPath`, `voiceActionPath`,
  // `voiceCallEventPath` and `memoryConfig` outright. Those all have defaults in the schema, and
  // hard-coding TAC's current defaults here would silently pin them if a future version changed one.
  const tacConfigInput: z.input<typeof TACConfigSchema> = {
    accountSid: config.twilio.accountSid,
    authToken: config.twilio.authToken,
    apiKey: config.twilio.apiKey,
    apiSecret: config.twilio.apiSecret,
    phoneNumber: config.twilio.phoneNumber,
    ...(config.conversationConfigurationId !== null && {
      conversationConfigurationId: config.conversationConfigurationId,
    }),
    ...(config.studioHandoffFlowSid !== null && { studioHandoffFlowSid: config.studioHandoffFlowSid }),
    // Required whenever a voice channel exists: `TACServer`'s CONSTRUCTOR throws
    // "Voice channel is configured but TACConfig.voicePublicDomain is not set" — and because that
    // construction is shared, the throw would take SMS down with it rather than just disabling voice.
    // Scheme-less; TAC builds `wss://${domain}${voiceWebsocketPath}` itself.
    ...(config.voice !== null && { voicePublicDomain: config.voice.publicDomain }),
    // `undefined` MEANS "use TAC's default" and is the honest way to say it. Each of these three is
    // declared `z.ZodType<string, unknown>` — a `z.preprocess` wrapping a `.default()` — so the input
    // type is `unknown` and the key is required even though a value is not. The preprocessor maps
    // undefined (and '') onto the default, giving /ws, /conversation-relay-callback and
    // /twilio/call-events. We use those as-is; `shared/twilio-paths.ts` documents that overriding any
    // of them silently desynchronises the Traefik PathPrefix labels.
    voiceWebsocketPath: undefined,
    voiceActionPath: undefined,
    voiceCallEventPath: undefined,
  };
  const tacConfig = new TACConfig(tacConfigInput);

  // NETWORK CALL. With a conversation configuration id set, `TAC.create` GETs that configuration and
  // rethrows on failure — so this is the one boot step that can fail because of something outside the
  // process. The caller catches it; see `server/index.ts`.
  const tac = await TAC.create({ config: tacConfig, logger: tacLogger() });

  /**
   * OURS, FIRST, AND AWAITED. See `TAC_SHUTDOWN_TIMEOUT_MS` for the 10-s-vs-30-s arithmetic this
   * exists to fix.
   *
   * The `await` is not stylistic. `register()` only queues the plugin; without awaiting it,
   * `hasDecorator('gracefulShutdown')` is still false when `start()` runs, TAC registers its own
   * copy, and the second `fastify.decorate` of the same name throws
   * `FST_ERR_DEC_ALREADY_PRESENT` — from an avvio microtask, which makes it an uncatchable
   * `uncaughtException` rather than something `index.ts`'s try/catch can degrade from. A working boot
   * becomes a hard crash.
   *
   * Registered here rather than in `buildApp()` because `buildApp` is synchronous, and only the TAC
   * path wants it: the no-Twilio path in `index.ts` owns its own SIGTERM/SIGINT handling, and this
   * plugin installs its own listeners (warning loudly if it finds any already there).
   */
  await app.register(gracefulShutdown, { timeout: TAC_SHUTDOWN_TIMEOUT_MS });

  /** Ended in `shutdown()`. Voice's is also ended per-call on `webSocketDisconnected`. */
  const registries: ConversationRegistry[] = [];
  /** Non-null only when voice is configured; `shutdown()` must clean it up itself. See below. */
  let voiceChannel: VoiceChannel | null = null;

  if (caps.sms) {
    /**
     * `memoryMode: 'never'` — deliberately NOT the plan's `'always'`.
     *
     * With `'always'`, TAC calls Recall scoped to the CURRENT conversation and folds the result into
     * a `## Recent Message History` block of `User:`/`Assistant:` lines. `server/agent/history.ts`
     * already puts that same exchange into the model's messages, so the model would see this
     * conversation twice, in two formats — actively worse answers, not merely wasted work.
     *
     * T14 turns memory on properly, using `MemoryPromptBuilder` and excluding the current
     * conversation from communications.
     */
    const smsChannel = new SMSChannel(tac, { memoryMode: 'never' });
    tac.registerChannel(smsChannel); // BEFORE new TACServer — see the header.

    const conversations = createConversationRegistry({
      spanName: 'conversation.sms',
      ttlMs: SMS_CONVERSATION_TTL_MS,
      maxConversations: SMS_MAX_CONVERSATIONS,
      logger: log,
    });
    registries.push(conversations);

    /**
     * Single-slot and GLOBAL across channels — `onMessageReady` lives on TAC, not on the channel, so
     * registering twice silently discards the first handler. Voice does NOT come through here: it is
     * unregistered by design and owns its own `prompt` slot, which is exactly what keeps this
     * handler SMS-only and free of a `channel` branch.
     */
    tac.onMessageReady(async ({ conversationId, message, author, profileId, memory, session }) =>
      handleInboundMessage(
        { conversationId, message, author, profileId, memory, session },
        { turn, conversations, logger: log },
      ),
    );

    /**
     * Via TAC, never `smsChannel.on('conversationEnded', …)` — the channel's `.on` is a single-slot
     * setter and TAC has already installed its own forwarder there.
     *
     * Fires when Conversation Orchestrator marks the conversation CLOSED, which arrives as a
     * `CONVERSATION_UPDATED` webhook rather than a distinct CLOSED event type. Measured: 300 s after
     * creation with `statusTimeouts.closed: 5`. The registry's TTL sweep is the real backstop.
     */
    tac.onConversationEnded(({ session }) => {
      conversations.end(session.conversationId);
    });
  }

  if (caps.voice) {
    const conversations = createConversationRegistry({
      spanName: 'conversation.voice',
      ttlMs: VOICE_CONVERSATION_TTL_MS,
      maxConversations: VOICE_MAX_CONVERSATIONS,
      logger: log,
    });
    registries.push(conversations);

    /**
     * `memoryMode: 'never'`, which DEVIATES from the plan's `'once'` — a decision, not an oversight.
     *
     * `'once'` would Recall on turn 1 and cache it on the session. But `composeMemory` is still the
     * passthrough (`server/agent/deps.ts`), so the response is fetched and then discarded: the only
     * effect available today is a Conversation Orchestrator round-trip sitting in front of the first
     * spoken word, which is the single most latency-sensitive moment on the whole channel. T14 owns
     * turning memory on together with a real compose port, and should revisit `'once'` then.
     *
     * `defaultTwimlOptions` is the static TwiML layer. See `VOICE_TWIML_OPTIONS` — the one key in it
     * is the difference between a caller being able to interrupt us and the agent going deaf.
     */
    voiceChannel = new VoiceChannel(tac, {
      memoryMode: 'never',
      defaultTwimlOptions: VOICE_TWIML_OPTIONS,
    });

    // NOT `tac.registerChannel(voiceChannel)` — see rule 3 in the header. These four slots stay ours
    // precisely because we never registered; TAC's own forwarders would have taken `prompt` and
    // `interrupt` on registration, silently.
    voiceChannel.on('setup', (data) => {
      handleVoiceSetup(data, { turn });
    });
    voiceChannel.on('prompt', async (data) =>
      handleVoicePrompt(
        {
          conversationId: data.conversationId,
          transcript: data.transcript,
          abortSignal: data.abortSignal,
          memory: data.userMemory,
          // Forwarded from T14 on. TAC spreads `session` gated on its own existence rather than on
          // `memoryMode`, so this has been available on every turn since T13 and was being dropped —
          // and `session.profileId` is what Conversation Memory and the memory-retrieval tool need.
          session: data.session,
        },
        { turn, conversations, sender: voiceChannel as VoiceChannel, logger: log },
      ),
    );
    voiceChannel.on('interrupt', (data) => {
      handleVoiceInterrupt(data, { turn });
    });
    voiceChannel.on('webSocketDisconnected', (data) => {
      handleVoiceDisconnect(data, { turn, conversations });
    });
  }

  const server = new TACServer(tac, {
    // Ours, already carrying `loggerInstance: rootLogger` and `trustProxy` — neither of which can be
    // set after construction, which is exactly why we hand the instance over instead of letting TAC
    // build one.
    //
    // The cast is unavoidable and `http/app.ts`'s header already predicted it: constructing with
    // `loggerInstance` makes the instance's logger generic pino's `Logger` instead of Fastify's
    // `FastifyBaseLogger`, and under `exactOptionalPropertyTypes` the two are not assignable in either
    // direction. Structurally identical at runtime — it is the same object TAC would have built.
    fastifyInstance: app as unknown as FastifyInstance,
    port: AGENT_PORT,
    // Passed, never registered. Note `messagingChannels` is deliberately NOT passed alongside it:
    // that option is a WHOLE-ARRAY override of `[sms, rcs, chat, whatsapp].filter(...)`, not an
    // addition, so supplying it here would drop the registered SMS channel out of the `/webhook`
    // fan-out and inbound texts would stop being answered.
    ...(voiceChannel !== null && { voiceChannel }),
  });

  return {
    start: async () => {
      await server.start();
      log.info(
        {
          port: AGENT_PORT,
          phoneNumber: config.twilio?.phoneNumber,
          sms: caps.sms,
          voice: caps.voice,
          voicePublicDomain: config.voice?.publicDomain ?? null,
          memoryMode: 'never',
          shutdownTimeoutMs: TAC_SHUTDOWN_TIMEOUT_MS,
        },
        `tac: listening (${[caps.sms && 'sms', caps.voice && 'voice'].filter(Boolean).join(' + ')})`,
      );
    },
    shutdown: () => {
      for (const registry of registries) registry.shutdown();
      // Ours to call, because `tac.shutdown()` iterates REGISTERED channels only — and the voice
      // channel deliberately is not one. Without this its WebSocket map, prompt queues and
      // callSid index survive the shutdown.
      voiceChannel?.shutdown();
    },
  };
}
