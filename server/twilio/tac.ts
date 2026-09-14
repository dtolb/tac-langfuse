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
import { createToolCatalog, SHIPPED_TOOLS } from '../agent/tools/catalog.ts';
import { resolve } from '../agent/tools/resolve.ts';
import type { TurnDeps } from '../agent/types.ts';
import type { App } from '../http/types.ts';
import { adaptBuiltInTools } from './builtin-tools.ts';
import { createTacMemoryPort } from './memory-compose.ts';
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
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * THE TAC-FLAVOURED DEPENDENCIES. ONE OBJECT, SHARED BY BOTH CHANNELS.
   *
   * `createTurnDeps` built the caller's `turn` with `passthroughMemory` and the three shipped tools,
   * and that object is what `/bench` keeps using. Here we derive a second one that also knows about
   * TAC. Four properties this shape buys, each of which an alternative loses:
   *
   *  1. No TAC import escapes `server/twilio/`. `tests/architecture.test.ts` needs no new rule.
   *  2. No mutation of the module-level `toolCatalog`. It stays exactly what the bench and every test
   *     see, and `createToolCatalog`'s duplicate-name throw keeps its meaning — a SECOND catalog is
   *     built and the first is untouched.
   *  3. **The bench keeps the passthrough port and the three shipped tools BY CONSTRUCTION**, with no
   *     `if (channel === 'bench')` anywhere. T11's TAC-free property survives as a consequence of the
   *     wiring rather than as a rule someone has to remember.
   *  4. It is a plain spread, so adding a genuinely per-channel difference later is one line.
   *
   * ONE object rather than one per channel, which CORRECTS the T14 design (§4). That section argued
   * per-channel deps were forced because voice has to plumb `profileId` — but `profileId` rides on
   * `TurnInput`, which is per-TURN, while `TurnDeps` is per-PROCESS. `composeMemory` already receives
   * `channel` on every call, so anything channel-specific belongs inside the port.
   *
   * Rejected: a settable holder in `server/agent/` that this function fills in. It makes
   * `composeMemory` time-dependent — a turn racing boot silently gets the passthrough — and puts a
   * mutable global on the seam whose whole purpose is injection.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  // `knowledgeBaseId` is passed EXPLICITLY because it is not reachable through `tac`: `TAC.create`
  // reads exactly one field off the fetched Conversation Orchestrator configuration —
  // `memoryStoreId` — and never a knowledge base. Discovered while building the adapters.
  const builtInTools = adaptBuiltInTools({ tac, knowledgeBaseId: config.knowledgeBaseId });
  const catalog = createToolCatalog([...SHIPPED_TOOLS, ...builtInTools]);
  const turnDeps: TurnDeps = {
    ...turn,
    // T8's resolver, re-bound to the AUGMENTED catalog. `caps` rather than a fresh
    // `capabilities(config)` call, and `turn.obs` rather than the module-level bus, so this stays the
    // same partial application `server/agent/deps.ts` does — just over more tools.
    tools: (names, turnCtx) =>
      resolve(names, {
        capabilities: caps,
        catalog,
        bus: turn.obs,
        conversationId: turnCtx.conversationId,
        channel: turnCtx.channel,
      }),
    composeMemory: createTacMemoryPort(tac, { bus: turn.obs }),
  };
  log.info(
    {
      shippedTools: SHIPPED_TOOLS.map((t) => t.name),
      builtInTools: builtInTools.map((t) => t.name),
      catalog: catalog.names,
    },
    `tac: tool catalog augmented with ${builtInTools.length} TAC built-in(s)`,
  );

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
     * `memoryMode: 'always'` since T14 — a Recall per inbound message.
     *
     * ⚠ THE REASON RECORDED HERE AT T12 FOR CHOOSING `'never'` WAS FACTUALLY WRONG, and it is worth
     * stating rather than deleting, because it was specific enough to be believed. It said that with
     * `'always'` TAC "folds the result into a `## Recent Message History` block" that duplicates
     * `server/agent/history.ts`. **TAC folds nothing.** `MemoryPromptBuilder` has ZERO callers
     * anywhere inside TAC (grep it and `.compose(` across `packages/` at 2.2.0). `memoryMode` decides
     * exactly one thing: whether, and how often, Recall is called. The `TACMemoryResponse` is handed
     * to our callback and what reaches the model is entirely `composeMemory`'s decision.
     *
     * So the duplication was never going to happen on its own. It would happen only if our port
     * passed the communications through, and `./memory-compose.ts` makes that structurally
     * impossible — its input schema has no `communications` key, so zod strips them, and the response
     * it hands the renderer is constructed with `communications: []`. That also covers the case a
     * config value cannot: on a Recall failure TAC falls back to `listCommunications(conversationId)`
     * with no limit, and renders THIS conversation.
     *
     * `'always'` over `'once'` on this channel because it passes the caller's utterance as a semantic
     * QUERY, so observations come back ranked by relevance to what was just asked; `'once'` Recalls
     * with no query and returns them unranked. The cost is one Recall per message, and SMS latency is
     * not perceptual — the same trade that makes `'once'` right for voice, inverted.
     */
    const smsChannel = new SMSChannel(tac, { memoryMode: 'always' });
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
        { turn: turnDeps, conversations, logger: log },
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
     * `memoryMode: 'once'` since T14 — one Recall per conversation, cached on the session, with TAC
     * handling the re-fetch when Orchestrator marks the conversation INACTIVE.
     *
     * T13 chose `'never'` for a reason that was correct AT THE TIME and no longer applies:
     * `composeMemory` was still `passthroughMemory`, so a Recall was fetched and then discarded, and
     * the only observable effect was a Conversation Orchestrator round-trip in front of the first
     * spoken word. Now that `./memory-compose.ts` exists the response is actually used, so the
     * round-trip buys something.
     *
     * `'once'` rather than SMS's `'always'`, and the asymmetry is the point: this cost lands on turn
     * 1 only, where the caller is still hearing the welcome greeting, instead of in front of every
     * answer. What it gives up is ranking — `'once'` Recalls with no query, so observations come back
     * unranked, where `'always'` would pass the utterance as a semantic query. On a channel whose
     * every failure mode is silence, predictable latency beats better ordering.
     *
     * ⚠ UNMEASURED as of this commit. T13 measured a cold first turn at 2405 ms with no Recall in
     * front of it; the Recall is awaited inside TAC BEFORE our handler is called
     * (`packages/core/src/channels/voice.ts`), so no span of ours can see it and only a real call can
     * price it. If turn 1 becomes unacceptable, the escape hatch is `'never'` plus recalling inside
     * our own port, where it would at least be visible.
     *
     * `defaultTwimlOptions` is the static TwiML layer. See `VOICE_TWIML_OPTIONS` — the one key in it
     * is the difference between a caller being able to interrupt us and the agent going deaf.
     */
    voiceChannel = new VoiceChannel(tac, {
      memoryMode: 'once',
      defaultTwimlOptions: VOICE_TWIML_OPTIONS,
    });

    // NOT `tac.registerChannel(voiceChannel)` — see rule 3 in the header. These four slots stay ours
    // precisely because we never registered; TAC's own forwarders would have taken `prompt` and
    // `interrupt` on registration, silently.
    voiceChannel.on('setup', (data) => {
      handleVoiceSetup(data, { turn: turnDeps });
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
        { turn: turnDeps, conversations, sender: voiceChannel as VoiceChannel, logger: log },
      ),
    );
    voiceChannel.on('interrupt', (data) => {
      handleVoiceInterrupt(data, { turn: turnDeps });
    });
    voiceChannel.on('webSocketDisconnected', (data) => {
      handleVoiceDisconnect(data, { turn: turnDeps, conversations });
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
          memoryMode: { sms: caps.sms ? 'always' : null, voice: caps.voice ? 'once' : null },
          knowledge: caps.knowledge,
          tools: catalog.names,
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
