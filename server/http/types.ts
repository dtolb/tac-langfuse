/**
 * The concrete Fastify instance type, in its own module so `app.ts` and the route modules it
 * mounts can both refer to it without importing each other.
 *
 * It must be spelled out rather than inferred. The instance is constructed with
 * `loggerInstance: rootLogger`, which pins the logger generic to pino's `Logger`; a bare
 * `FastifyInstance` defaults that slot to `FastifyBaseLogger`, and under
 * `exactOptionalPropertyTypes` the two are not assignable — the error surfaces as an
 * unreadable wall of route-generic mismatches a long way from the cause.
 */
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Logger } from 'pino';

export type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
