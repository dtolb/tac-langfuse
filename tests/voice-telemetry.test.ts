/**
 * THE PROOF FOR THE VOICE TIMELINE: a three-turn call, driven through the real handlers, asserted
 * against real OpenTelemetry spans.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS HARNESS CAN AND CANNOT SHOW, stated up front because the difference has bitten this
 * repo before.
 *
 * It CAN see every observation. `@langfuse/tracing` exports `setLangfuseTracerProvider`, and
 * `getLangfuseTracer()` reads that isolated provider in preference to the global one — so pointing
 * it at a `BasicTracerProvider` + `InMemorySpanExporter` puts every span our helpers create into a
 * list this file can read. No new dependency: `@opentelemetry/sdk-trace-base` is a direct one.
 *
 * It CANNOT show that those spans reach Langfuse. `LangfuseSpanProcessor` is not registered here,
 * and that processor FILTERS — see the header of `server/obs/spans.ts` for the failure mode, which
 * is a span that exists, is sampled, is visible to an in-memory exporter, and is then silently
 * dropped. `scripts/verify-telemetry.ts` is the diagnostic that closes that gap, against the live
 * stack. This file proves the timeline's SHAPE; that script proves it arrives.
 *
 * TWO PIECES OF THE SDK ARE REIMPLEMENTED HERE, both because they are transitive dependencies of
 * `@opentelemetry/sdk-node` rather than declared ones, and adding a dependency for a test is worse
 * than fifteen lines of it:
 *
 *  - a CONTEXT MANAGER. `@opentelemetry/api` defaults to `NoopContextManager`, whose `context.with`
 *    runs the callback and stores nothing and whose `active()` always returns `ROOT_CONTEXT`. With
 *    that in place NOTHING nests: `withTurnSpan`'s `context.with(parentCtx, …)` is discarded, so
 *    every span becomes its own trace root. Measured while writing this file — the first run reported
 *    six trace ids for one call. `NodeSDK` registers `AsyncLocalStorageContextManager` in production,
 *    and the fifteen lines below are the same mechanism over `node:async_hooks`.
 *  - a PROPAGATOR, because `propagation.inject` is a no-op without one and the traceparent is what
 *    carries the trace across turns.
 *
 * Both exercise our real `startConversationSpan` / `withTurnSpan` / `startSpanUnder` call sites; only
 * the plumbing under them is local.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
  type SpanContext,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import type { ObsEvent } from '../shared/events.ts';
import { createConversationRegistry } from '../server/obs/conversations.ts';
import { createVoiceTimeline } from '../server/obs/voice-timeline.ts';
import { handleVoiceDisconnect, handleVoiceInterrupt, handleVoicePrompt } from '../server/twilio/voice.ts';
import { fakeTurnDeps, recordingSender, silentLogger } from './helpers/fake-voice.ts';

// ─────────────────────────────────────────────────────────────────── the context manager, locally

const storage = new AsyncLocalStorage<Context>();

const asyncContextManager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with(ctx, fn, thisArg, ...args) {
    return storage.run(ctx, () => fn.call(thisArg, ...args));
  },
  // Only reached by SDK code that defers work onto a callback; nothing in this repo's span helpers
  // uses it. Implemented rather than stubbed so it cannot silently lose a context if that changes.
  bind(ctx, target) {
    if (typeof target !== 'function') return target;
    const bound = (...args: unknown[]): unknown =>
      storage.run(ctx, () => (target as (...a: unknown[]) => unknown)(...args));
    return bound as typeof target;
  },
  enable() {
    return this;
  },
  disable() {
    storage.disable();
    return this;
  },
};

// ─────────────────────────────────────────────────────────────────── the W3C propagator, locally

const TRACEPARENT = 'traceparent';
const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;

/**
 * Just enough of W3C Trace Context for `traceparent` to survive a round trip.
 *
 * `isRemote: true` on extract matters: the default sampler is `ParentBased(AlwaysOn)`, which
 * respects the parent's sampled flag — so a child of an extracted context is sampled because the
 * flag below says `01`, not because of anything this file asserts.
 */
const w3c = {
  fields: () => [TRACEPARENT],
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(ctx);
    if (spanContext === undefined) return;
    setter.set(
      carrier,
      TRACEPARENT,
      `00-${spanContext.traceId}-${spanContext.spanId}-0${spanContext.traceFlags & 1}`,
    );
  },
  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, TRACEPARENT);
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== 'string') return ctx;
    const [version, traceId, spanId, flags] = header.split('-');
    if (version !== '00' || traceId === undefined || spanId === undefined) return ctx;
    if (!HEX_TRACE_ID.test(traceId) || !HEX_SPAN_ID.test(spanId)) return ctx;
    const spanContext: SpanContext = {
      traceId,
      spanId,
      isRemote: true,
      traceFlags: flags === '01' ? TraceFlags.SAMPLED : TraceFlags.NONE,
    };
    return trace.setSpanContext(ctx, spanContext);
  },
};

// ─────────────────────────────────────────────────────────────────── span readers

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

/** HrTime (`[seconds, nanos]`) to epoch milliseconds, fractional. */
const ms = (t: readonly [number, number]): number => t[0] * 1000 + t[1] / 1e6;

interface Interval {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly parentSpanId: string | undefined;
  readonly spanId: string;
  readonly metadata: Record<string, string>;
}

const METADATA_PREFIX = 'langfuse.observation.metadata.';

const asInterval = (span: ReadableSpan): Interval => ({
  name: span.name,
  startMs: ms(span.startTime),
  endMs: ms(span.endTime),
  parentSpanId: span.parentSpanContext?.spanId,
  spanId: span.spanContext().spanId,
  metadata: Object.fromEntries(
    Object.entries(span.attributes)
      .filter(([key]) => key.startsWith(METADATA_PREFIX))
      .map(([key, value]) => [key.slice(METADATA_PREFIX.length), String(value)]),
  ),
});

const finished = (): Interval[] => exporter.getFinishedSpans().map(asInterval);
const named = (name: string): Interval[] => finished().filter((s) => s.name === name);
const only = (name: string): Interval => {
  const matches = named(name);
  expect(matches, `expected exactly one ${name} span, got ${matches.length}`).toHaveLength(1);
  return matches[0] as Interval;
};

/** The largest uncovered stretch inside `outer`, given a set of covering intervals. */
const largestGapMs = (outer: Interval, covering: readonly Interval[]): number => {
  const sorted = [...covering].sort((a, b) => a.startMs - b.startMs);
  let cursor = outer.startMs;
  let worst = 0;
  for (const interval of sorted) {
    if (interval.startMs > cursor) worst = Math.max(worst, interval.startMs - cursor);
    cursor = Math.max(cursor, interval.endMs);
  }
  return Math.max(worst, outer.endMs - cursor);
};

// ─────────────────────────────────────────────────────────────────── the call

const CONVERSATION_ID = 'conv_voice_timeline';
/**
 * Deliberately LONGER than the 300 ms slack the coverage assertion allows.
 *
 * That is what stops "no unexplained gap" from being a test that passes on a build with no
 * `caller.turn` spans at all: delete them and the two gaps become the largest uncovered stretch in
 * the root, at ~400 ms each. Verified by doing exactly that.
 */
const CALLER_GAP_MS = 400;
const INTERRUPT_AFTER_MS = 420;

const events: ObsEvent[] = [];
const timeline = createVoiceTimeline();
const conversations = createConversationRegistry({
  spanName: 'conversation.voice',
  // The same hook `server/twilio/tac.ts` installs. Passing it here is what puts requirement 6's
  // call-level statistics on the root span, and asserting them is what proves the hook fires.
  onClose: (conversationId) => timeline.forget(conversationId),
});

let interruptedUtterance = '';

beforeAll(async () => {
  setLangfuseTracerProvider(provider);
  context.setGlobalContextManager(asyncContextManager);
  propagation.setGlobalPropagator(w3c);
  exporter.reset();

  const speak = async (
    transcript: string,
    deltas: string[],
    over: { abort?: AbortController; onToken?: (chunk: string, index: number) => void } = {},
  ): Promise<void> => {
    const rec = recordingSender(over.onToken === undefined ? {} : { onToken: over.onToken });
    await handleVoicePrompt(
      {
        conversationId: CONVERSATION_ID,
        transcript,
        abortSignal: (over.abort ?? new AbortController()).signal,
        memory: undefined,
      },
      {
        turn: fakeTurnDeps(deltas, deltas.join(''), events, { deltaDelayMs: 8, firstDelayMs: 25 }),
        conversations,
        sender: rec.sender,
        timeline,
        logger: silentLogger,
      },
    );
  };

  // ---- turn 1: an ordinary streamed answer ----
  await speak('where is order A4721', ['Order ', 'A4721 ', 'has shipped.']);

  // ---- the caller listens, thinks, and speaks. This is what `caller.turn` has to cover. ----
  await new Promise((r) => void setTimeout(r, CALLER_GAP_MS));

  // ---- turn 2: another ordinary answer ----
  await speak('and when will it arrive', ['Tuesday ', 'the fourteenth.']);

  await new Promise((r) => void setTimeout(r, CALLER_GAP_MS));

  // ---- turn 3: the caller talks over us after the first token ----
  //
  // Driven from INSIDE the send, because that is the only place a barge-in can happen: TAC dispatches
  // `interrupt` on its own WebSocket frame while `sendStreamingResponse` is mid-`for await`, and it
  // has already aborted the stream task's controller by then. Both halves are reproduced here.
  const abort = new AbortController();
  await speak('actually, cancel it', ['Of course — ', 'let me check ', 'whether that is possible.'], {
    abort,
    onToken: (chunk, index) => {
      if (index !== 0) return;
      interruptedUtterance = chunk;
      abort.abort();
      handleVoiceInterrupt(
        {
          conversationId: CONVERSATION_ID,
          utteranceUntilInterrupt: chunk,
          durationUntilInterruptMs: INTERRUPT_AFTER_MS,
        },
        { turn: fakeTurnDeps([], '', events), timeline },
      );
    },
  });

  // ---- the caller hangs up ----
  handleVoiceDisconnect(
    { conversationId: CONVERSATION_ID },
    { turn: fakeTurnDeps([], '', events), conversations, timeline },
  );
  await provider.forceFlush();
});

afterAll(async () => {
  // Global state, so hand it back. Vitest isolates per file, but a leaked isolated provider would
  // make any later file in the same worker export spans into a shut-down exporter.
  setLangfuseTracerProvider(null);
  context.disable();
  await provider.shutdown();
});

test('one trace holds the whole call', () => {
  const root = only('conversation.voice');
  const traceIds = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
  // The property the traceparent round-trip exists for. Two trace ids would mean a span was created
  // with no parent context — which is exactly what a bare `startObservation` in a WebSocket handler
  // does, and the reason `caller.turn` and `tts.interrupted` are parented explicitly.
  expect(traceIds.size).toBe(1);
  expect(named('turn.voice')).toHaveLength(3);
  expect(root.spanId).toBeTruthy();
});

test('turn.voice and caller.turn cover the root end to end', () => {
  const root = only('conversation.voice');
  const covering = [...named('turn.voice'), ...named('caller.turn')];
  // Every covering span is a direct child of the root. `caller.turn` under a TURN would still cover
  // the timeline arithmetically while drawing a waterfall nobody can read.
  expect(covering.every((s) => s.parentSpanId === root.spanId)).toBe(true);
  // 300 ms of slack for the synchronous bookkeeping between `conversations.traceparentFor` (which
  // starts the root) and the first `promptAt`, and for the disconnect at the far end.
  expect(largestGapMs(root, covering)).toBeLessThan(300);
});

test('caller.turn spans the measured gap between turns', () => {
  const gaps = named('caller.turn');
  // Two, not three: the first turn of a call has no prior bot output to measure from, and inventing
  // one would back-date the span to the root and report the whole setup as caller time.
  expect(gaps).toHaveLength(2);
  for (const gap of gaps) {
    expect(gap.endMs - gap.startMs).toBeGreaterThanOrEqual(CALLER_GAP_MS);
  }
});

test('every completed turn carries turn.ttfa_ms', () => {
  const turns = named('turn.voice');
  // Including the interrupted one: it streamed a token before the barge-in, so the caller did hear
  // audio and the number is real. `markFirstToken` lives on the timeline rather than in the prompt
  // handler's closure precisely so the interrupt path can still report it.
  expect(turns.map((t) => t.metadata['turn.ttfa_ms'] !== undefined)).toEqual([true, true, true]);
});

test('turn.ttfa_ms is at least the model latency in front of the first token', () => {
  const first = named('turn.voice')[0] as Interval;
  // `firstDelayMs: 25` plus one 8 ms delta delay in the fake model. Asserted as a floor rather than a
  // window: the point is that the anchor is the FIRST TOKEN and not the turn start, which a zero
  // would silently claim.
  expect(Number(first.metadata['turn.ttfa_ms'])).toBeGreaterThanOrEqual(25);
});

test('turn.total_ms is re-anchored to prompt receipt, so ttfa never exceeds it', () => {
  // The invariant `run-turn.ts` documents at length, re-checked under the new anchor: its own
  // `turn.total_ms` measured the model stream, and the voice timeline overwrites it with
  // prompt-receipt → end-of-turn marker. A narrower total beside a turn-relative ttfa is what makes
  // "first token at 500 ms, response complete at 360 ms" reachable.
  for (const turn of named('turn.voice')) {
    const ttfa = Number(turn.metadata['turn.ttfa_ms']);
    const total = Number(turn.metadata['turn.total_ms']);
    expect(total).toBeGreaterThanOrEqual(ttfa);
  }
});

test('turn.total_ms equals the turn span it is written on', () => {
  // The re-anchor, stated as an identity: the timeline computes `boundary - promptAt` and ends the
  // span at `boundary` having started it at `promptAt`, so the two are the same number by
  // construction. `run-turn.ts` also writes this key, from a different pair of instants — the voice
  // write lands last because it is the LAST thing before the span is ended, and a post-end write is
  // dropped by OpenTelemetry whatever the ordering. (The premise here used to be "because the voice
  // write happens after `await done`", which is not true of the closers that await nothing.)
  for (const turn of named('turn.voice')) {
    expect(Number(turn.metadata['turn.total_ms'])).toBeCloseTo(turn.endMs - turn.startMs, 3);
  }
});

test('the interrupted turn keeps the metadata run-turn writes at drain', () => {
  // THE REGRESSION THIS PINS: the interrupt handler used to END the turn span at the interrupt
  // instant, which is before `done` resolves — so `tools.called`, `turn.total_model_ms` and the
  // observation output were all dropped by the SDK on exactly the ending that is normal operation on
  // a call. The boundary is parked now and the prompt handler closes the span after `await done`.
  const third = named('turn.voice')[2] as Interval;
  expect(third.metadata['turn.total_model_ms']).toBeDefined();
});

test('the interrupted turn still ends at the interrupt, not when the handler finished', () => {
  // The other half of the same trade: parking the boundary must not move the recorded end. The
  // `tts.interrupted` event was created AT the interrupt instant, so its start is that instant — and
  // the turn now ends there while having been closed later, by a different function.
  const third = named('turn.voice')[2] as Interval;
  expect(third.endMs).toBeCloseTo(only('tts.interrupted').startMs, 3);
});

test('tts.send covers first token to end of turn, inside its own turn', () => {
  const sends = named('tts.send');
  expect(sends).toHaveLength(3);
  const turns = named('turn.voice');
  for (const send of sends) {
    const parent = turns.find((t) => t.spanId === send.parentSpanId);
    expect(parent, 'tts.send must be a child of a turn.voice span').toBeDefined();
    expect(send.startMs).toBeGreaterThanOrEqual((parent as Interval).startMs);
    // Equal, not merely within: the turn ends AT the boundary that ends `tts.send`, which is the
    // whole reason `withTurnSpan` had to grow `endOnExit: false`.
    expect(send.endMs).toBeCloseTo((parent as Interval).endMs, 3);
  }
});

test('asr.final marks the start of each turn and is zero-duration', () => {
  const marks = named('asr.final');
  expect(marks).toHaveLength(3);
  for (const mark of marks) {
    expect(mark.endMs - mark.startMs).toBe(0);
  }
});

test('asr.final carries the transcript length but no lang today', () => {
  const first = named('asr.final')[0] as Interval;
  expect(first.metadata['transcriptChars']).toBe(String('where is order A4721'.length));
  // TAC 2.2.0 parses `lang` and then drops it before our callback, so the forwarded value is
  // undefined — and `createObservationAttributes` omits a null metadata value entirely rather than
  // recording it as null. This assertion is what will start failing the day TAC forwards it, which is
  // the notification we want.
  expect(first.metadata['lang']).toBeUndefined();
});

test('the interrupted turn carries tts.interrupted with a duration', () => {
  const interrupted = only('tts.interrupted');
  expect(interrupted.metadata['durationUntilInterruptMs']).toBe(String(INTERRUPT_AFTER_MS));
});

test('tts.interrupted records what the caller actually heard', () => {
  // The ground truth for the partial utterance, which history deliberately does not hold — see the
  // barge-in branch in `server/twilio/voice.ts`.
  expect(only('tts.interrupted').metadata['utteranceUntilInterrupt']).toBe(interruptedUtterance);
});

test('tts.interrupted is a child of the live turn, not a new trace root', () => {
  const interrupted = only('tts.interrupted');
  const third = named('turn.voice')[2] as Interval;
  expect(interrupted.parentSpanId).toBe(third.spanId);
});

test('the interrupted turn ends at the interrupt and is marked aborted', () => {
  const third = named('turn.voice')[2] as Interval;
  expect(third.metadata['turn.aborted']).toBe('true');
});

test('the interrupted turn records why it ended', () => {
  expect((named('turn.voice')[2] as Interval).metadata['turn.ending']).toBe('interrupt');
});

test('the root carries the call-level statistics', () => {
  const root = only('conversation.voice');
  expect(root.metadata['turns.count']).toBe('3');
});

test('the call-level statistics sit alongside closedBecause, not instead of it', () => {
  // The `onClose` hook merges into the same `update` as `closedBecause`. Losing that would make a
  // swept or evicted root indistinguishable from a hangup.
  expect(only('conversation.voice').metadata['closedBecause']).toBe('ended');
});

test('the root counts the aborted turn', () => {
  expect(only('conversation.voice').metadata['turns.aborted']).toBe('1');
});

test('the root sums the caller gaps', () => {
  const total = Number(only('conversation.voice').metadata['caller.turn_total_ms']);
  expect(total).toBeGreaterThanOrEqual(2 * CALLER_GAP_MS);
});

test('the root reports p50 and max ttfa across the call', () => {
  const root = only('conversation.voice');
  expect(Number(root.metadata['turn.ttfa_max_ms'])).toBeGreaterThanOrEqual(
    Number(root.metadata['turn.ttfa_p50_ms']),
  );
});

test('the timeline is empty once the call is over', () => {
  // A leaked entry holds a LIVE span handle, and an unended span reaches Langfuse not at all.
  expect(timeline.size()).toBe(0);
});
