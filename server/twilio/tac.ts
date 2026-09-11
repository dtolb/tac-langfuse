/**
 * TAC boot. THE ONLY FILE IN THE REPO THAT IMPORTS `twilio-agent-connect`.
 *
 * Imported DYNAMICALLY by `server/index.ts`, and that matters twice over: a process with no Twilio
 * credentials never loads TAC at all (which is what keeps the Twilio-free bench a runtime proof rather
 * than a static claim), and a failure in here degrades instead of killing the server.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ORDER IS LOAD-BEARING IN TWO PLACES, and both fail quietly.
 *
 * 1. `registerChannel(smsChannel)` MUST happen before `new TACServer(...)`. The constructor
 *    SNAPSHOTS channels (`messagingChannels ?? [tac.getChannel('sms'), …]`) and `setupRoutes` only
 *    registers the conversation webhook `if (webhookChannels.length > 0)`. Get it wrong and inbound
 *    SMS 404s, with nothing in the log but "No channels configured for webhook processing".
 *
 * 2. Our routes must already be on the Fastify instance before `start()`. They are: `buildApp()` ran
 *    long before this file is reached. TAC adds its own routes inside `start()`, so ours are first and
 *    a path collision would surface as a Fastify duplicate-route error out of `start()`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `TACServer.start()` calls `listen()` ITSELF, so `server/index.ts` must not also call it. That is why
 * this returns a handle whose `start()` is the thing that binds the port.
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { SMSChannel, TAC, TACConfig, TACConfigSchema, TACServer } from 'twilio-agent-connect';
import { AGENT_PORT } from '../../shared/ports.ts';
import type { AppConfig } from '../config.ts';
import { childLogger, tacLogger } from '../logging.ts';
import { createConversationRegistry, type ConversationRegistry } from '../obs/conversations.ts';
import type { TurnDeps } from '../agent/types.ts';
import type { App } from '../http/types.ts';
import { handleInboundMessage } from './messaging.ts';

const log = childLogger('tac');

/** SMS conversations are long-lived and asynchronous, so both bounds are looser than the bench's. */
export const SMS_CONVERSATION_TTL_MS = 2 * 60 * 60_000;
export const SMS_MAX_CONVERSATIONS = 200;

export interface TacHandle {
  /** Binds the port — TAC owns `listen()`. */
  start(): Promise<void>;
  /** End every open conversation root span. Called from the `preClose` hook. */
  shutdown(): void;
  readonly conversations: ConversationRegistry;
}

export interface TacDeps {
  readonly app: App;
  readonly config: AppConfig;
  readonly turn: TurnDeps;
}

/**
 * Wire TAC for SMS. Throws on anything the caller should degrade from — see `server/index.ts`.
 *
 * Reachable only once `capabilities().sms` is true, which guarantees `config.twilio` is non-null AND
 * `config.conversationConfigurationId` matches TAC's own shape for it. That is what makes the
 * `TACConfig` construction below safe.
 */
export async function bootTacSms(deps: TacDeps): Promise<TacHandle> {
  const { app, config, turn } = deps;
  if (config.twilio === null || config.conversationConfigurationId === null) {
    // Unreachable through `index.ts`, which gates on capabilities first. Explicit because the
    // alternative is a confusing ZodError from inside the vendor.
    throw new Error('bootTacSms requires config.twilio and a valid conversationConfigurationId');
  }

  /**
   * Built from our already-validated config, NOT `TACConfig.fromEnv()`.
   *
   * `fromEnv()` reads `process.env` directly, which would make it a SECOND place the environment is
   * read and break the rule that `server/config.ts` is the only one. It also reports just the first
   * missing variable, where our config reports all of them with what each one costs. Since the five
   * values below have already been through Zod in `config.ts`, this construction cannot fail on them.
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
    conversationConfigurationId: config.conversationConfigurationId,
    ...(config.studioHandoffFlowSid !== null && { studioHandoffFlowSid: config.studioHandoffFlowSid }),
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
   * `memoryMode: 'never'` — deliberately NOT the plan's `'always'`, and this is the one substantive
   * product decision in this file.
   *
   * With `'always'`, TAC calls Recall scoped to the CURRENT conversation and folds the result into a
   * `## Recent Message History` block of `User:`/`Assistant:` lines. `server/agent/history.ts` already
   * puts that same exchange into the model's messages, so the model would see this conversation twice,
   * in two formats — actively worse answers, not merely wasted work.
   *
   * Note the round-trip is NOT the reason: TAC performs the Recall before invoking our callback either
   * way, so discarding it would cost exactly the same. Only `'never'` avoids the call.
   *
   * T14 turns memory on properly, alongside the built-in memory tools, using `MemoryPromptBuilder`
   * (which also supplies the profile-traits section a hand-rolled fold would drop) and excluding the
   * current conversation from communications.
   */
  const smsChannel = new SMSChannel(tac, { memoryMode: 'never' });
  tac.registerChannel(smsChannel); // BEFORE new TACServer — see the header.

  const conversations = createConversationRegistry({
    spanName: 'conversation.sms',
    ttlMs: SMS_CONVERSATION_TTL_MS,
    maxConversations: SMS_MAX_CONVERSATIONS,
    logger: log,
  });

  /**
   * Single-slot and GLOBAL across channels — `onMessageReady` lives on TAC, not on the channel, so
   * registering twice silently discards the first handler and voice would share this one. T13 must
   * branch on `channel` here rather than adding a second registration.
   */
  tac.onMessageReady(async ({ conversationId, message, author, profileId, memory, session }) =>
    handleInboundMessage(
      { conversationId, message, author, profileId, memory, session },
      { turn, conversations, logger: log },
    ),
  );

  /**
   * Via TAC, never `smsChannel.on('conversationEnded', …)` — the channel's `.on` is a single-slot
   * setter and TAC has already installed its own forwarder there, so ours would silently replace it
   * and nothing would fire.
   *
   * Fires ONLY when Conversation Orchestrator marks the conversation CLOSED; INACTIVE does not end it.
   * Whether CLOSED ever arrives depends on the CO configuration's `statusTimeouts`, which is why the
   * registry's TTL sweep is the real backstop and this is the tidy path.
   */
  tac.onConversationEnded(({ session }) => {
    conversations.end(session.conversationId);
  });

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
  });

  return {
    start: async () => {
      await server.start();
      log.info(
        { port: AGENT_PORT, phoneNumber: config.twilio?.phoneNumber, memoryMode: 'never' },
        'tac: SMS channel registered and listening',
      );
    },
    shutdown: () => conversations.shutdown(),
    conversations,
  };
}
