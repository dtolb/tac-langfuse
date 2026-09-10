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
import { unavailable } from '../config.ts';
import { rootLogger } from '../logging.ts';
import { obsBus } from '../obs/bus.ts';
import { registerObsRoutes, type ObsRoutes } from './routes-obs.ts';
import { APP_API_PATHS, TAC_WEBHOOK_PATHS } from '../../shared/twilio-paths.ts';
import type { App } from './types.ts';

export interface AppDeps {
  readonly config: AppConfig;
  readonly caps: Capabilities;
}

export function buildApp(deps: AppDeps): { app: App; obs: ObsRoutes } {
  const { config, caps } = deps;

  const app = Fastify({
    // trustProxy so request.ip and the X-Forwarded-* headers reflect Traefik rather than the
    // bridge network. Note TAC rebuilds the signed webhook URL from X-Forwarded-Proto, which is
    // why compose forces that header to `https` — see docker-compose.yml.
    trustProxy: true,
    loggerInstance: rootLogger,
  });

  /** Always 200, even with nothing configured. That is the entire point of it. */
  app.get('/health', async () => ({
    status: 'ok',
    appName: config.appName,
    capabilities: caps,
    missing: config.missing.map((m) => m.name),
    wired: { tac: 'T12/T13', agent: 'T9', bench: 'T11' },
    paths: { app: APP_API_PATHS, tac: TAC_WEBHOOK_PATHS },
  }));

  /**
   * Stand-in for the real agent route (T9/T11). Demonstrates the degradation contract every
   * capability-gated route follows: 503 with the offending variables named.
   */
  app.post('/api/turn', async (_req, reply) => {
    if (!caps.llm) return reply.code(503).send(unavailable(config, 'agent'));
    return reply.code(501).send({ error: 'not_implemented', note: 'the agent core lands at T9' });
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
        // reader will actually find. `handoff` is a stand-in for one of T14's TAC built-ins, NOT a
        // catalog tool: it is here so the console's `unavailable` rendering has something to render.
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

  return { app, obs };
}

export type { App } from './types.ts';
