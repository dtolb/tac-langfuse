/**
 * Server-sent events, the house transport for server→browser push.
 *
 * SSE rather than a WebSocket, deliberately: the flow is one-directional, it survives proxies
 * and reconnects on its own, and the browser side is four lines of EventSource. The only
 * WebSocket in this app is the one Twilio's ConversationRelay dials into, and that one belongs
 * to TAC.
 *
 * Transport-agnostic on purpose — `SseSink` is the minimum a writable needs to look like — so
 * the hub is unit-testable without standing up an HTTP server.
 */
import { SSE_HEARTBEAT_MS, type ObsEvent } from '../../shared/events.ts';
import { childLogger } from '../logging.ts';

const log = childLogger('sse');

export interface SseSink {
  write(chunk: string): void;
  close?(): void;
}

/** One `data:` frame. The blank line terminates the event — omitting it hangs the client. */
export const formatSse = (event: string, data: unknown, id?: number): string => {
  const lines = [`event: ${event}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(data)}`, '', '');
  return lines.join('\n');
};

/**
 * A comment frame. Carries no event, exists only to put bytes on the wire so an idle
 * connection is not reaped by a proxy — Traefik and nginx both close silent connections.
 */
export const formatSseComment = (note: string): string => `: ${note}\n\n`;

/** Headers required for SSE to actually stream rather than buffer. */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Without this, an nginx in the path buffers the whole response and the "live" feed
  // arrives in one lump when the call ends. Harmless when nothing is buffering.
  'x-accel-buffering': 'no',
};

export interface SseHub {
  /** Attach a client. Returns a detach function. */
  add(sink: SseSink): () => void;
  /** Fan an event out to every attached client. Never throws. */
  broadcast(event: ObsEvent): number;
  clientCount(): number;
  /** Stop the heartbeat and close every client. */
  shutdown(): void;
}

export function createSseHub(heartbeatMs: number = SSE_HEARTBEAT_MS): SseHub {
  const sinks = new Set<SseSink>();

  const drop = (sink: SseSink): void => {
    sinks.delete(sink);
    try {
      sink.close?.();
    } catch {
      /* already gone — nothing useful to do */
    }
  };

  const heartbeat = setInterval(() => {
    const frame = formatSseComment('keep-alive');
    for (const sink of [...sinks]) {
      try {
        sink.write(frame);
      } catch {
        // A write failure IS the disconnect notification for SSE — there is no other signal.
        drop(sink);
      }
    }
  }, heartbeatMs);
  // Do not hold the process open. Without unref, `pnpm test` hangs after the last assertion.
  heartbeat.unref?.();

  return {
    add(sink) {
      sinks.add(sink);
      return () => drop(sink);
    },

    broadcast(event) {
      const frame = formatSse('obs', event, event.id);
      let delivered = 0;
      for (const sink of [...sinks]) {
        try {
          sink.write(frame);
          delivered++;
        } catch {
          drop(sink);
        }
      }
      return delivered;
    },

    clientCount: () => sinks.size,

    shutdown() {
      clearInterval(heartbeat);
      for (const sink of [...sinks]) drop(sink);
      log.info('sse hub shut down');
    },
  };
}
