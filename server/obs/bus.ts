/**
 * The observability bus.
 *
 * ONE rule governs this file: **publishing must never throw, and never let a subscriber's
 * failure reach the product path.** An event bus that can break a live phone call is worse
 * than no event bus. Every subscriber call is individually wrapped; a thrower is reported
 * once and then dropped from the subscriber list rather than being allowed to fail every
 * subsequent event.
 *
 * Modelled on flight-sandbox/src/observability/bus.ts, with the same intent.
 */
import {
  OBS_RING_BUFFER_SIZE,
  type ObsEvent,
  type ObsEventInput,
} from '../../shared/events.ts';
import { scrubObject } from './pii.ts';
import { childLogger } from '../logging.ts';

const log = childLogger('obs');

export type ObsSubscriber = (event: ObsEvent) => void;

export interface ObsBus {
  publish(input: ObsEventInput): void;
  subscribe(fn: ObsSubscriber): () => void;
  /** Events a late-joining browser missed. Oldest first. */
  recent(limit?: number): readonly ObsEvent[];
  subscriberCount(): number;
}

export function createObsBus(now: () => Date = () => new Date()): ObsBus {
  const subscribers = new Set<ObsSubscriber>();
  const ring: ObsEvent[] = [];
  let nextId = 1;

  const publish = (input: ObsEventInput): void => {
    let event: ObsEvent;
    try {
      event = {
        ...input,
        // Scrubbed HERE, once, at the boundary — so neither the SSE stream nor the ring
        // buffer can ever hold an unmasked transcript or phone number.
        ...(input.payload !== undefined && {
          payload: scrubObject(input.payload) as Record<string, unknown>,
        }),
        summary: input.summary,
        id: nextId++,
        at: now().toISOString(),
      };
    } catch (err) {
      // Constructing the event itself failed (a getter threw, a cycle in payload). Nothing
      // above us should care.
      log.warn({ err, kind: input.kind }, 'obs: could not build event');
      return;
    }

    if (ring.push(event) > OBS_RING_BUFFER_SIZE) ring.shift();

    for (const fn of [...subscribers]) {
      try {
        fn(event);
      } catch (err) {
        // Drop-on-throw. A subscriber that fails once will almost certainly fail on every
        // event; keeping it would turn one broken console tab into a permanent log of noise.
        subscribers.delete(fn);
        log.warn({ err }, 'obs: subscriber threw and was removed');
      }
    }
  };

  return {
    publish,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    recent(limit = OBS_RING_BUFFER_SIZE) {
      return limit >= ring.length ? [...ring] : ring.slice(ring.length - limit);
    },
    subscriberCount: () => subscribers.size,
  };
}

/** The process-wide bus. Tests build their own with `createObsBus()`. */
export const obsBus = createObsBus();
