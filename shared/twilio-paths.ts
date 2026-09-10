/**
 * The single source of truth for which URL prefixes belong to whom.
 *
 * Both containers answer on one public host, split by path at Traefik. Adding a TAC route
 * and forgetting the matching `PathPrefix()` in the compose labels produces a 404 that
 * looks like a Twilio problem, so `tests/architecture.test.ts` reads docker-compose.yml as
 * text and asserts every prefix below appears in the right router rule.
 */

/**
 * Registered by TACServer, not by us. Each carries Twilio signature validation as a
 * Fastify preHandler (the `/ws` upgrade validates too, closing with 1008 on failure).
 *
 * Keep in sync with TAC's defaults: TWILIO_VOICE_WEBSOCKET_PATH (/ws),
 * TWILIO_VOICE_ACTION_PATH (/conversation-relay-callback) and
 * TWILIO_VOICE_CALL_EVENT_PATH (/twilio/call-events, which expands to /status, /amd,
 * /recording). If any of those env vars is overridden, this list must change with it.
 */
export const TAC_WEBHOOK_PATHS = [
  '/webhook',
  '/twiml',
  '/ws',
  '/conversation-relay-callback',
  '/twilio/call-events',
] as const;

/**
 * Ours, layered onto `server.fastify` before `start()`. These do NOT inherit TAC's
 * signature validation — it is scoped to TAC-registered routes only.
 */
export const APP_API_PATHS = ['/api', '/events', '/health'] as const;

export type TacWebhookPath = (typeof TAC_WEBHOOK_PATHS)[number];
export type AppApiPath = (typeof APP_API_PATHS)[number];

/** Server-sent events stream carrying the live observability feed to the operator console. */
export const SSE_PATH = '/events/stream';

/** The Twilio-free bench: drives a full turn without loading TAC at all. */
export const BENCH_TURN_PATH = '/api/bench/turn';
