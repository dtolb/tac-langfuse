/**
 * Builds the Fastify instance and everything mounted on it.
 *
 * Split out from `index.ts` for the reason aci-quality-poc and nw-poc both landed on: the
 * entry point should do nothing but resolve config and listen, while `buildApp(deps)` is a
 * pure function of its dependencies and therefore testable by passing a literal config.
 *
 * It also gives us ONE exported `App` type. Because the instance is constructed with
 * `loggerInstance: rootLogger`, its logger generic is pino's `Logger` rather than Fastify's
 * default `FastifyBaseLogger`, and the two are not assignable — so route modules that take the
 * instance need this exact type, not a bare `FastifyInstance`.
 */
import Fastify from 'fastify';
import type { AppConfig, Capabilities } from '../config.ts';
import { rootLogger } from '../logging.ts';
import { obsBus } from '../obs/bus.ts';
import { registerObsRoutes, type ObsRoutes } from './routes-obs.ts';
import { registerBenchRoutes, type BenchRoutes } from './routes-bench.ts';
import { registerVoiceActionRoutes } from './routes-voice-action.ts';
import { registerHandoffRoutes, type HandoffRoutes } from './routes-handoff.ts';
import { APP_API_PATHS, BENCH_TURN_PATH, TAC_WEBHOOK_PATHS } from '../../shared/twilio-paths.ts';
import type { TurnDeps } from '../agent/types.ts';
import type { App } from './types.ts';

export interface AppDeps {
  readonly config: AppConfig;
  readonly caps: Capabilities;
  /**
   * The agent's dependencies, injected ONLY by tests.
   *
   * Left undefined in production, where `registerBenchRoutes` builds the live ports from config on
   * first use. The seam exists because the HTTP layer has failure modes that no unit test can see —
   * `tests/bench-http.test.ts` was written after one of them shipped — and driving it over a real
   * socket must not require an OpenAI key.
   */
  readonly turn?: TurnDeps;
}

export function buildApp(deps: AppDeps): {
  app: App;
  obs: ObsRoutes;
  bench: BenchRoutes;
  handoff: HandoffRoutes;
} {
  const { config, caps } = deps;

  const app = Fastify({
    // trustProxy so request.ip and the X-Forwarded-* headers reflect Traefik rather than the
    // bridge network. Note TAC rebuilds the signed webhook URL from X-Forwarded-Proto, which is
    // why compose forces that header to `https` — see docker-compose.yml.
    trustProxy: true,
    loggerInstance: rootLogger,
    /**
     * Without this, `fastify.close()` waits for every open connection and shutdown can hang.
     *
     * It matters because TAC registers `fastify-graceful-shutdown` with no options, so a 10-second
     * watchdog `process.exit(1)`s the process — and our `preClose` cleanup (which ends spans and
     * flushes OpenTelemetry) would never run. Two things reliably hold `close()` open past 10s: an
     * attached `/events/stream` SSE client, and `keepAliveTimeout` (72s by default) on any idle
     * socket, which Next's dev-mode rewrite proxy creates on every `/bench` visit.
     *
     * Note the `'idle'` default does NOT help: fastify only wires up `closeIdleConnections` when a
     * `serverFactory` is supplied, which we do not do.
     */
    forceCloseConnections: true,
  });

  /** Always 200, even with nothing configured. That is the entire point of it. */
  app.get('/health', async () => ({
    status: 'ok',
    appName: config.appName,
    capabilities: caps,
    missing: config.missing.map((m) => m.name),
    wired: {
      tac: [caps.sms && 'sms', caps.voice && 'voice'].filter(Boolean).join('+') || 'none',
      voice: caps.voice ? 'ready' : 'not configured',
      agent: 'done',
      bench: BENCH_TURN_PATH,
    },
    paths: { app: APP_API_PATHS, tac: TAC_WEBHOOK_PATHS },
  }));

  /**
   * The webhook diagnostic — the highest-value fifteen lines in this file.
   *
   * The most likely way the first live SMS fails is a 403 on Twilio signature validation, and TAC
   * reports that as ONE `log.warn` with no obs event at all. From the outside it looks exactly like a
   * Twilio outage. This hook makes the two distinguishable at a glance:
   *
   *   - nothing on the bus  → Conversation Orchestrator is not calling us. The CO configuration's
   *                           statusCallbacks URL or SMS captureRules are wrong; the code is fine.
   *   - 403 with a URL      → signature mismatch, and the URL says which half is wrong.
   *
   * `url` is rebuilt the way TAC's own `getWebhookUrl` does it — `X-Forwarded-Proto` (defaulting to
   * https when absent, which is TAC's behaviour too), then `X-Forwarded-Host` or `Host`, first
   * comma-separated value of each. It is the signed string, so if it does not match what Twilio signed,
   * this is the line that shows it. Registered here, before TAC's `start()`, so it wraps TAC's routes.
   *
   * The approved plan schedules this for T15's Traefik work; it is pulled forward because the first
   * failure happens here, on a tunnel, not there.
   */
  const first = (v: string | string[] | undefined): string | undefined =>
    (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();

  /**
   * Which channel a TAC path belongs to, so a voice call's webhooks do not all report as SMS.
   *
   * `/webhook` is the honest exception and is left as `sms`: it is the Conversation Orchestrator
   * envelope endpoint, and once voice is orchestrated too, CO pushes voice conversation events
   * through the very same route (the voice channel joins `webhookChannels`). Telling them apart means
   * reading the envelope, which is more than an `onResponse` hook should do — and `/webhook` is
   * still SMS's actual inbound path, whereas voice's is the WebSocket. Mislabelled voice CO events
   * are the accepted cost; `payload.eventType` is the tiebreaker when it matters.
   *
   * Note this hook CANNOT see `/ws` at all: `@fastify/websocket` hijacks the reply on a successful
   * upgrade, so `onResponse` never fires for it. A signature rejection there is a WS `close(1008)`
   * after the 101, visible only as one TAC `log.warn` — so silence from `/ws` here is expected, and
   * is not evidence the socket is healthy.
   */
  const pathChannel = (url: string): 'sms' | 'voice' =>
    url.startsWith('/webhook') ? 'sms' : 'voice';

  app.addHook('onResponse', async (request, reply) => {
    if (!TAC_WEBHOOK_PATHS.some((p) => request.url.startsWith(p))) return;
    const proto = first(request.headers['x-forwarded-proto']) ?? 'https';
    const host = first(request.headers['x-forwarded-host']) ?? first(request.headers.host) ?? '';
    obsBus.publish({
      kind: 'webhook.inbound',
      summary: `${request.method} ${request.url} → ${reply.statusCode}`,
      channel: pathChannel(request.url),
      payload: {
        // Exactly the string TAC validates the signature against.
        signedUrl: `${proto}://${host}${request.url}`,
        statusCode: reply.statusCode,
        hasSignature: request.headers['x-twilio-signature'] !== undefined,
        eventType: (request.body as { eventType?: unknown } | undefined)?.eventType ?? null,
      },
    });
  });

  /**
   * Emits a synthetic turn's worth of events.
   *
   * Exists so the operator console can be built and demoed before the agent lands, and so the
   * SSE path is verifiable with neither Twilio nor a model. The shape deliberately mirrors what
   * a real voice turn publishes, so a console built against it needs no rework.
   */
  app.post('/api/dev/emit-turn', async () => {
    const correlationId = `dev-${Date.now()}`;
    const emit = (
      kind: Parameters<typeof obsBus.publish>[0]['kind'],
      summary: string,
      extra: Record<string, unknown> = {},
    ): void =>
      obsBus.publish({
        kind,
        summary,
        channel: 'bench',
        conversationId: correlationId,
        correlationId,
        ...extra,
      });

    emit('turn.start', 'caller: where is my order A4721?');
    emit('prompt.fetch', 'agent.system v1 (production, cached)', { durationMs: 2 });
    emit('tool.selection', '2 of 3 tools resolved', {
      payload: {
        // The real catalog (`server/agent/tools/catalog.ts`), so this fixture teaches the tools a
        // reader will actually find. `handoff` became a REAL tool at T14b; it is still the right
        // fixture for the `unavailable` bucket because it is the one tool that genuinely lands there
        // on a process with no Studio flow SID configured.
        // Same four keys `resolve()` publishes, in the same shape — T19 builds the console against
        // this endpoint, so a fixture missing half the payload teaches half a contract.
        considered: ['lookup_order', 'get_store_hours', 'handoff'],
        resolved: ['lookup_order', 'get_store_hours'],
        unknown: [],
        unavailable: ['handoff'],
      },
    });
    emit('llm.request', 'gpt-5.4-mini, 2 tools offered');
    emit('llm.first_token', 'time to first token', { durationMs: 412 });
    emit('tool.execution', 'lookup_order', { durationMs: 88 });
    emit('llm.response', 'Order A4721 has shipped — it should arrive Friday.', { durationMs: 1840 });
    emit('turn.end', 'turn complete', { durationMs: 1932 });
    return { emitted: 8, correlationId };
  });

  // The live feed. No capability gate — it has to work when nothing else does, because that is
  // precisely when you need to see what is happening.
  const obs = registerObsRoutes(app, obsBus);

  // The Twilio-free bench. Registered unconditionally so the route can answer 503 with the missing
  // variable named rather than 404 — `POST /api/turn`'s 501 placeholder is gone, replaced by the real
  // thing at `BENCH_TURN_PATH`. Note this module must never import TAC; that rule is what makes the
  // bench a runtime proof that `runTurn` is channel-agnostic, and `tests/architecture.test.ts`
  // enforces it (verified by deliberately breaking it).
  const bench = registerBenchRoutes(app, {
    config,
    caps,
    bus: obsBus,
    ...(deps.turn !== undefined && { turn: deps.turn }),
  });

  // Registered unconditionally and with no capability gate — Twilio is mid-call by the time it POSTs
  // here, so a 404 or a 503 is a dropped call. See the route's own header. It is the only route in this
  // file that takes no `caps`, precisely because it has nothing to gate on.
  registerVoiceActionRoutes(app, { config, bus: obsBus });

  // Registered unconditionally too, but for a different reason: the token route is capability-GATED and
  // answers 503 naming the variable, while the screen pop always answers 200. The minter arrives later
  // via `handoff.setMintToken` — see the route module's header on why it cannot be passed in here.
  const handoff = registerHandoffRoutes(app, { config, caps });

  return { app, obs, bench, handoff };
}

export type { App } from './types.ts';
