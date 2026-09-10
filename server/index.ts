/**
 * Agent process entry point. Resolves config, reports it, listens. Nothing else — everything
 * mounted on the server lives in `http/app.ts`, which is a pure function of its dependencies
 * and therefore testable without a socket.
 *
 * Two rules this file must never break:
 *
 * 1. It calls listen() UNCONDITIONALLY and binds 0.0.0.0. No `if (argv[1].endsWith(...))`
 *    run-guard — that guard is false in a container, so the process would load its modules,
 *    run nothing, and exit 0, which `restart: unless-stopped` then masks as a silent crash
 *    loop with empty logs.
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

const { app, obs } = buildApp({ config, caps });

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  obs.shutdown(); // close SSE clients before the server, so they get a clean end
  // Flush BEFORE closing: the last turn of a demo is usually the one being asked about, and an
  // unflushed span never reaches Langfuse at all.
  await flushTelemetry();
  await app.close();
  process.exit(0);
};
// TAC registers fastify-graceful-shutdown and its own signal handling once TACServer owns this
// instance (T12). At that point this moves into TAC's shutdown callback so OTel is flushed
// exactly once rather than twice.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: AGENT_PORT });
