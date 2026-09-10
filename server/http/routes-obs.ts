/**
 * The live observability feed the operator console consumes.
 *
 * Two endpoints, both read-only:
 *   GET /events/stream  — SSE, replays the ring buffer then streams live
 *   GET /events/recent  — the same buffer as plain JSON, for a page load or a curl
 *
 * These carry NO capability gate. They must work when nothing else does, because a
 * half-configured demo is exactly when you need to see what is happening.
 */
import type { App } from './types.ts';
import type { ObsBus } from '../obs/bus.ts';
import { createSseHub, SSE_HEADERS, formatSse, type SseHub } from './sse.ts';
import { SSE_PATH } from '../../shared/twilio-paths.ts';
import { childLogger } from '../logging.ts';

const log = childLogger('obs-http');

export interface ObsRoutes {
  hub: SseHub;
  /** Detach the bus→hub bridge and close every client. */
  shutdown(): void;
}

export function registerObsRoutes(app: App, bus: ObsBus): ObsRoutes {
  const hub = createSseHub();
  const unsubscribe = bus.subscribe((event) => void hub.broadcast(event));

  app.get(SSE_PATH, (request, reply) => {
    // Hijack so Fastify stops managing this response — otherwise it tries to serialise a body
    // and end the stream, and the connection closes as soon as the handler returns.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, SSE_HEADERS);

    const sink = {
      write: (chunk: string): void => {
        // A failed write is how a disconnect surfaces on SSE, so let it throw — the hub drops
        // the client on throw, which is the intended mechanism.
        res.write(chunk);
      },
      close: (): void => void res.end(),
    };

    // Replay first, so a console opened mid-call is not staring at an empty list. Sent before
    // attaching to the hub so ordering is preserved and nothing is duplicated.
    for (const event of bus.recent()) {
      try {
        res.write(formatSse('obs', event, event.id));
      } catch {
        return; // client vanished during replay
      }
    }

    const detach = hub.add(sink);
    // `close` fires for both a clean disconnect and a dropped connection.
    request.raw.on('close', () => {
      detach();
      log.debug({ clients: hub.clientCount() }, 'sse client left');
    });
    log.debug({ clients: hub.clientCount() }, 'sse client joined');
  });

  app.get('/events/recent', async () => ({
    events: bus.recent(),
    clients: hub.clientCount(),
  }));

  return {
    hub,
    shutdown() {
      unsubscribe();
      hub.shutdown();
    },
  };
}
