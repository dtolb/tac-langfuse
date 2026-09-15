/**
 * Agent process entry point. Resolves config, reports it, listens. Nothing else — everything
 * mounted on the server lives in `http/app.ts`, which is a pure function of its dependencies
 * and therefore testable without a socket.
 *
 * Two rules this file must never break:
 *
 * 1. It calls listen() UNCONDITIONALLY and binds 0.0.0.0. No `if (argv[1].endsWith(...))`
 *    run-guard — that guard is false in a container, so the process would load its modules,
 *    run nothing, and exit 0 — which any restarting policy masks as a silent crash loop with
 *    empty logs. (Compose now sets `restart: "no"`, for an unrelated exposure reason, so today
 *    that failure would present as a container which merely exits. The run-guard is still the
 *    thing to avoid: exit-0-with-no-output is undiagnosable either way.)
 * 2. It boots with nothing configured. Missing credentials produce loud, itemised warnings and
 *    a 503 naming the variable — never a crash. The page stays inspectable and /health keeps
 *    answering, which is what makes a half-configured demo debuggable instead of dead.
 *
 * Once T6 lands, run with:
 *   node --import ./server/obs/instrumentation.ts --env-file-if-exists=.env server/index.ts
 * OpenTelemetry must be registered before the modules it instruments are imported, and Next's
 * `instrumentation.ts` convention is the wrong process for it — every model call happens here.
 */
import { AGENT_PORT } from '../shared/ports.ts';
import { loadConfig, capabilities } from './config.ts';
import { childLogger } from './logging.ts';
import { buildApp } from './http/app.ts';
import { flushTelemetry } from './obs/spans.ts';
import { preflightDefaultPromptTools } from './agent/tools/resolve.ts';

const config = loadConfig(process.env);
const caps = capabilities(config);
const log = childLogger('boot');

// Loud, itemised, one line per missing variable — naming the variable AND what it costs. A
// single "config incomplete" line would be useless at demo time.
for (const m of config.missing) {
  log.warn({ variable: m.name, feature: m.feature }, `not configured: ${m.breaks}`);
}
log.info({ appName: config.appName, capabilities: caps }, 'capabilities resolved');
if (config.appName === 'scaffold') {
  log.warn(
    { appName: 'scaffold' },
    'APP_NAME is still the default — Traefik router names are global on the dev box, so two clones using it will fight over webhooks. Set APP_NAME before deploying.',
  );
}

// The loud half of "fail loud at boot, degrade quiet at runtime": ERROR per tool name in a
// compiled-in default that the catalog does not have. Importing it is also what builds the catalog,
// so a duplicate or ill-formed tool name from a clone's own edit throws HERE rather than arriving
// as an opaque 400 from OpenAI in the middle of a call.
preflightDefaultPromptTools();

const { app, obs, bench, handoff } = buildApp({ config, caps });

/** Set once TAC boots, so cleanup can end its conversation roots too. */
let tacShutdown: (() => void) | null = null;

/**
 * ALL cleanup, in one `preClose` hook — and `preClose` specifically, not `onClose`.
 *
 * This is the single most easily-got-wrong thing in this file, so the reasoning is written out.
 * Fastify runs `preClose` hooks FIFO, inside its own internal `onClose`, and crucially BEFORE
 * `server.close()`. An `onClose` hook would be wrong twice over:
 *
 *  1. avvio's `onClose` queue is LIFO (`_closeQ.unshift`), and fastify registers its own
 *     server-closing hook LATER than anything we add here — so ours would run LAST, after
 *     `server.close()`. But `obs.shutdown()` is what ends the SSE responses that `server.close()`
 *     is waiting on, so it would deadlock against itself.
 *  2. Once TAC owns the instance, `fastify-graceful-shutdown` arms a 10-second watchdog that
 *     `process.exit(1)`s regardless. Anything queued behind a stalled `server.close()` never runs,
 *     so the telemetry flush would be silently skipped — and an unflushed span never reaches
 *     Langfuse at all.
 *
 * The ORDER inside is also deliberate and unchanged from before TAC existed: end conversation roots
 * BEFORE flushing, because an unended span does not reach Langfuse either — flushing first would ship
 * every turn while dropping the conversation they hang from, leaving a tree with no root.
 */
app.addHook('preClose', async () => {
  obs.shutdown(); // close SSE clients first, so they get a clean end rather than a severed socket
  bench.shutdown();
  tacShutdown?.();
  await flushTelemetry();
});

/**
 * Two boot paths, because TAC's `start()` calls `listen()` ITSELF — so exactly one of these may run.
 *
 * The import is DYNAMIC on purpose. `server/twilio/tac.ts` is the only file that imports
 * `twilio-agent-connect`, and a static import here would load TAC into every process, including the
 * ones that have no Twilio credentials. That would quietly demote the Twilio-free bench from a runtime
 * proof to a claim about import strings.
 *
 * The try/catch is what keeps "boot never hard-fails" true now that a network call sits on the boot
 * path: `TAC.create` GETs the Conversation Orchestrator configuration and rethrows, so a Twilio blip, a
 * corporate TLS proxy, or a CO id that is well-formed but does not exist would otherwise take down
 * /health and /bench along with SMS. Degrading instead also makes the stronger TAC-free check
 * runnable — credentials present, TAC unresolvable, bench still serving.
 */
if (caps.sms || caps.voice) {
  try {
    const { bootTac } = await import('./twilio/tac.ts');
    const tac = await bootTac({ app, config, caps, turn: bench.turnDeps() });
    tacShutdown = tac.shutdown;

    /**
     * The softphone's minter, injected on the SUCCESS PATH ONLY — a failed boot must leave
     * `POST /api/voice/token` answering 503 rather than handing out a token from a process that cannot
     * answer the call the token is for.
     *
     * Dynamic, exactly like the `bootTac` import above it and for the same reason: a process with no
     * Twilio credentials must never load the `twilio` SDK.
     *
     * `config.twilio` is non-null in this branch by construction — `caps.sms` and `caps.voice` both
     * require it — but a capability flag carries no type information, so the narrowing is re-done here
     * rather than asserted away.
     */
    const twilioConfig = config.twilio;
    if (twilioConfig !== null) {
      const { mintVoiceToken } = await import('./twilio/voice-token.ts');
      handoff.setMintToken((identity) =>
        mintVoiceToken({
          accountSid: twilioConfig.accountSid,
          apiKey: twilioConfig.apiKey,
          apiSecret: twilioConfig.apiSecret,
          identity,
        }),
      );
    }

    await tac.start(); // binds the port
  } catch (err) {
    log.error(
      { err },
      'tac: boot FAILED — the agent is still serving /health and /bench, but no call or text will be answered. Check TWILIO_CONVERSATION_CONFIGURATION_ID exists on this account and that Twilio is reachable.',
    );
    await app.listen({ host: '0.0.0.0', port: AGENT_PORT });
  }
} else {
  // No Twilio: we own the socket, and we own the signals. TAC would otherwise register
  // fastify-graceful-shutdown and its own SIGTERM/SIGINT handling, and a second pair here would mean
  // two shutdown paths racing (footgun #9).
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    await app.close(); // runs the preClose hook above
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: AGENT_PORT });
}
