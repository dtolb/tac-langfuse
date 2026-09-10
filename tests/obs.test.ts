import { test, expect } from 'vitest';
import { createObsBus } from '../server/obs/bus.ts';
import { createSseHub, formatSse, formatSseComment, SSE_HEADERS } from '../server/http/sse.ts';
import { OBS_EVENT_KINDS, KIND_TONE, OBS_RING_BUFFER_SIZE } from '../shared/events.ts';

const fixedNow = (): Date => new Date('2026-09-09T12:00:00.000Z');

// ------------------------------------------------------------------ vocabulary

test('every event kind has a tone, and there are no orphan tones', () => {
  // KIND_TONE is an exhaustive Record, so a new kind without a colour is a compile error.
  // This catches the reverse: a tone left behind after a kind is removed.
  expect(Object.keys(KIND_TONE).sort()).toEqual([...OBS_EVENT_KINDS].sort());
});

test('event kinds are unique', () => {
  expect(new Set(OBS_EVENT_KINDS).size).toBe(OBS_EVENT_KINDS.length);
});

// ------------------------------------------------------------------ the bus

test('publish reaches every subscriber and stamps id + time', () => {
  const bus = createObsBus(fixedNow);
  const seen: unknown[] = [];
  bus.subscribe((e) => seen.push(e));
  bus.subscribe((e) => seen.push(e));

  bus.publish({ kind: 'turn.start', summary: 'turn began', channel: 'voice' });

  expect(seen).toHaveLength(2);
  expect(seen[0]).toMatchObject({
    kind: 'turn.start',
    summary: 'turn began',
    id: 1,
    at: '2026-09-09T12:00:00.000Z',
  });
});

test('ids increment so the console can order and de-duplicate', () => {
  const bus = createObsBus(fixedNow);
  bus.publish({ kind: 'turn.start', summary: 'a' });
  bus.publish({ kind: 'turn.end', summary: 'b' });
  expect(bus.recent().map((e) => e.id)).toEqual([1, 2]);
});

test('a throwing subscriber is dropped and the others still receive the event', () => {
  // The whole point of the bus: one broken console tab must not break a live call.
  const bus = createObsBus(fixedNow);
  const good: string[] = [];
  bus.subscribe(() => {
    throw new Error('boom');
  });
  bus.subscribe((e) => good.push(e.summary));

  expect(() => bus.publish({ kind: 'turn.start', summary: 'first' })).not.toThrow();
  expect(good).toEqual(['first']);
  expect(bus.subscriberCount()).toBe(1); // the thrower is gone

  bus.publish({ kind: 'turn.end', summary: 'second' });
  expect(good).toEqual(['first', 'second']);
});

test('publish never throws even when the payload is hostile', () => {
  const bus = createObsBus(fixedNow);
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  expect(() => bus.publish({ kind: 'error', summary: 'cyclic', payload: cyclic })).not.toThrow();

  const throwing = {
    get boom(): string {
      throw new Error('getter');
    },
  };
  expect(() =>
    bus.publish({ kind: 'error', summary: 'getter', payload: throwing as unknown as Record<string, unknown> }),
  ).not.toThrow();
});

test('payloads are PII-scrubbed at the bus boundary, once', () => {
  // Scrubbing here rather than at each publish site means neither the SSE stream nor the ring
  // buffer can ever hold an unmasked transcript.
  const bus = createObsBus(fixedNow);
  let got: Record<string, unknown> | undefined;
  bus.subscribe((e) => {
    got = e.payload;
  });
  bus.publish({
    kind: 'voice.transcript',
    summary: 'caller spoke',
    payload: { from: '+15551234567', text: 'email me at dan@example.com' },
  });
  expect(got).toEqual({ from: '+1***4567', text: 'email me at d***@example.com' });
});

test('unsubscribe stops delivery', () => {
  const bus = createObsBus(fixedNow);
  const seen: string[] = [];
  const off = bus.subscribe((e) => seen.push(e.summary));
  bus.publish({ kind: 'turn.start', summary: 'a' });
  off();
  bus.publish({ kind: 'turn.end', summary: 'b' });
  expect(seen).toEqual(['a']);
});

test('the ring buffer is bounded and keeps the newest events', () => {
  // A browser joining mid-call needs context, but an unbounded buffer is a slow leak across a
  // long demo.
  const bus = createObsBus(fixedNow);
  for (let i = 0; i < OBS_RING_BUFFER_SIZE + 25; i++) {
    bus.publish({ kind: 'turn.start', summary: `e${i}` });
  }
  const recent = bus.recent();
  expect(recent).toHaveLength(OBS_RING_BUFFER_SIZE);
  expect(recent.at(-1)?.summary).toBe(`e${OBS_RING_BUFFER_SIZE + 24}`);
  expect(bus.recent(5)).toHaveLength(5);
});

// ------------------------------------------------------------------ SSE framing

test('an SSE frame is well-formed and terminated', () => {
  const frame = formatSse('obs', { a: 1 }, 7);
  expect(frame).toBe('event: obs\nid: 7\ndata: {"a":1}\n\n');
  // The trailing blank line is what tells the client the event is complete. Without it the
  // browser waits forever and the feed looks dead.
  expect(frame.endsWith('\n\n')).toBe(true);
});

test('a comment frame carries no event', () => {
  expect(formatSseComment('keep-alive')).toBe(': keep-alive\n\n');
});

test('SSE headers defeat proxy buffering', () => {
  expect(SSE_HEADERS['content-type']).toBe('text/event-stream');
  // Without x-accel-buffering an nginx in the path delivers the whole "live" feed in one lump
  // when the call ends.
  expect(SSE_HEADERS['x-accel-buffering']).toBe('no');
});

// ------------------------------------------------------------------ the hub

const sink = () => {
  const chunks: string[] = [];
  return { chunks, write: (c: string) => void chunks.push(c) };
};

test('broadcast reaches every client and reports the count', () => {
  const hub = createSseHub(60_000);
  const a = sink();
  const b = sink();
  hub.add(a);
  hub.add(b);

  const delivered = hub.broadcast({ id: 1, at: 'now', kind: 'turn.start', summary: 'hi' });
  expect(delivered).toBe(2);
  expect(a.chunks[0]).toContain('"summary":"hi"');
  expect(b.chunks).toHaveLength(1);
  hub.shutdown();
});

test('a client whose write throws is dropped — that IS the disconnect signal', () => {
  const hub = createSseHub(60_000);
  const dead = {
    write: () => {
      throw new Error('EPIPE');
    },
  };
  const alive = sink();
  hub.add(dead);
  hub.add(alive);

  const delivered = hub.broadcast({ id: 1, at: 'now', kind: 'turn.start', summary: 'hi' });
  expect(delivered).toBe(1);
  expect(hub.clientCount()).toBe(1);
  expect(alive.chunks).toHaveLength(1);
  hub.shutdown();
});

test('detaching removes the client and calls close', () => {
  const hub = createSseHub(60_000);
  let closed = false;
  const off = hub.add({ write: () => {}, close: () => void (closed = true) });
  expect(hub.clientCount()).toBe(1);
  off();
  expect(hub.clientCount()).toBe(0);
  expect(closed).toBe(true);
  hub.shutdown();
});

test('the heartbeat writes a comment frame on the interval', async () => {
  const hub = createSseHub(15); // ms, for the test only
  const s = sink();
  hub.add(s);
  await new Promise((r) => setTimeout(r, 50));
  hub.shutdown();
  expect(s.chunks.length).toBeGreaterThanOrEqual(1);
  expect(s.chunks[0]).toBe(': keep-alive\n\n');
});

test('shutdown closes every client', () => {
  const hub = createSseHub(60_000);
  let closed = 0;
  hub.add({ write: () => {}, close: () => void closed++ });
  hub.add({ write: () => {}, close: () => void closed++ });
  hub.shutdown();
  expect(closed).toBe(2);
  expect(hub.clientCount()).toBe(0);
});

test('bus and hub compose: publishing streams to a client', () => {
  const bus = createObsBus(fixedNow);
  const hub = createSseHub(60_000);
  const s = sink();
  hub.add(s);
  bus.subscribe((e) => void hub.broadcast(e));

  bus.publish({ kind: 'llm.first_token', summary: 'ttft 412ms', durationMs: 412 });

  expect(s.chunks[0]).toContain('"kind":"llm.first_token"');
  expect(s.chunks[0]).toContain('"durationMs":412');
  hub.shutdown();
});
