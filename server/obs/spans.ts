/**
 * Span helpers.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE ONE THING TO KNOW: never create a span with a raw OpenTelemetry tracer.
 *
 * `LangfuseSpanProcessor` only forwards spans that pass its `isLangfuseSpan` / `isGenAISpan`
 * filters. A span from `trace.getTracer(x).startActiveSpan(...)` is created perfectly well — an
 * in-memory exporter sees it, it has a real sampled trace id — and is then SILENTLY DROPPED on
 * the way to Langfuse. Measured during spike S1: a `turn.voice` span vanished while the AI SDK's
 * own spans arrived, so the waterfall showed the model call with nothing around it.
 *
 * Everything here therefore goes through `@langfuse/tracing`'s `startObservation` /
 * `startActiveObservation`. This module exists so no call site has to remember that.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * The second non-obvious thing is how a trace survives across turns. A voice conversation is
 * minutes of independent WebSocket frames, so there is no async context to hold open. Instead the
 * conversation span is started and immediately serialised to a W3C `traceparent` string, which
 * rides on `session.metadata` — the only cross-turn carrier TAC offers, since it persists nothing
 * itself. Each turn rehydrates from it.
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { startObservation, startActiveObservation, type LangfuseSpan } from '@langfuse/tracing';
import { childLogger } from '../logging.ts';
import { scrubObject } from './pii.ts';

const log = childLogger('spans');

/**
 * Scrub anything we attach to a span.
 *
 * Logs and obs events were already scrubbed at their own boundaries; span payloads were not,
 * and a span `input` of `{from: '+15551234567'}` reached Langfuse verbatim during T6 verification.
 * Same treatment here makes masking uniform across all three sinks.
 *
 * HONEST LIMIT: this covers only the spans WE create. The AI SDK's model spans
 * (`invoke_agent`, `chat <model>`) are built by the Langfuse integration and carry the full
 * prompt and completion — so real transcripts DO reach Langfuse. That is largely the point of
 * having traces, and the stack is self-hosted per demo, but it is a deliberate decision rather
 * than an oversight: do not describe this app as keeping PII out of Langfuse.
 */
const scrubFields = (fields: Record<string, unknown>): Record<string, unknown> =>
  scrubObject(fields) as Record<string, unknown>;

/** Key under which the serialised trace context rides on `session.metadata`. */
export const TRACEPARENT_KEY = 'traceparent';

export interface SpanLike {
  update(fields: Record<string, unknown>): void;
  /**
   * @param endTimeMs epoch milliseconds. Omitted means "now", which is what every caller outside
   *   `server/twilio/voice.ts` wants.
   *
   * AN EXPLICIT END TIME IS SUPPORTED, and knowing that saves reinventing it. `@langfuse/tracing`'s
   * `LangfuseBaseObservation.end` is declared `end(endTime?: TimeInput): void` (read in
   * `node_modules/@langfuse/tracing/dist/index.d.ts`), and OpenTelemetry's `timeInputToHrTime`
   * treats a bare number larger than `performance.timeOrigin` as epoch ms — so a `Date.now()` value
   * passes straight through. That is why the voice timeline does NOT need to hold a span open until
   * the instant it wants to record: it back-dates with `startTime` (below) and closes with this.
   */
  end(endTimeMs?: number): void;
}

/**
 * A span that can also mint back-dated children.
 *
 * Needed because voice's timeline is reconstructed from instants that have already passed by the
 * time we know what they mean — the `tts.send` window is only complete once the `last: true` marker
 * has gone out, and `asr.final` is a point in time we recorded before the turn span existed.
 *
 * Both methods parent EXPLICITLY, by span context, rather than relying on the ambient
 * OpenTelemetry context. That is the load-bearing part: TAC dispatches `interrupt` from its own
 * WebSocket message handler, with no active context at all, so a bare `startObservation` there
 * becomes the root of its OWN trace — a second trace per barge-in, which reads as the
 * instrumentation half-working. `@langfuse/tracing`'s `StartObservationOptions.parentSpanContext`
 * is what avoids it, and `createParentContext` in that bundle turns it into
 * `trace.setSpanContext(context.active(), …)`, so the child lands under this span wherever it is
 * created from.
 */
export interface TimelineSpan extends SpanLike {
  /**
   * A zero-duration child observation at `atMs`. `asType: 'event'` is what makes it zero-duration:
   * `LangfuseEvent`'s constructor calls `this.otelSpan.end(params.timestamp)` with the same
   * timestamp the span was started at, so start and end coincide by construction.
   */
  event(name: string, fields?: Record<string, unknown>, atMs?: number): void;
  /** A child span starting at `startedAtMs`. The caller owns `end(endTimeMs)`. */
  child(name: string, fields?: Record<string, unknown>, startedAtMs?: number): SpanLike;
}

/** A started-but-not-held conversation root. */
export interface ConversationSpan {
  /** Put this on `session.metadata[TRACEPARENT_KEY]` so later turns can rejoin the trace. */
  readonly traceparent: string | undefined;
  update(fields: Record<string, unknown>): void;
  end(): void;
}

/**
 * Start the per-conversation root span and immediately serialise its context.
 *
 * NOT held open as an active context — see the module comment. The returned handle must be
 * `end()`ed on `webSocketDisconnected` / `conversationEnded`, and callers should also sweep on a
 * timeout: a dropped WebSocket that never fires `close` would otherwise leak an unended span
 * forever, and an unended span never reaches Langfuse at all.
 */
export function startConversationSpan(
  name: string,
  input?: Record<string, unknown>,
): ConversationSpan {
  const observation = startObservation(name, input === undefined ? {} : { input: scrubFields(input) });

  // `.otelSpan` is the underlying span; fall back to the wrapper for forward compatibility.
  const otelSpan = (observation as { otelSpan?: unknown }).otelSpan ?? observation;
  const carrier: Record<string, string> = {};
  try {
    propagation.inject(
      trace.setSpan(context.active(), otelSpan as Parameters<typeof trace.setSpan>[1]),
      carrier,
    );
  } catch (err) {
    // Without a registered provider there is nothing to inject. Not fatal: the demo runs, it
    // just isn't traced, which is exactly the documented degradation for a missing Langfuse.
    log.debug({ err }, 'no trace context to serialise');
  }

  return {
    traceparent: carrier[TRACEPARENT_KEY],
    update: (fields) => observation.update(scrubFields(fields)),
    end: () => observation.end(),
  };
}

/**
 * The vendor-facing attribute bag, cast once so no call site has to.
 *
 * `createObservationAttributes` destructures a FIXED set of keys (input, output, metadata, level,
 * statusMessage, version, environment, and the generation-only ones) and drops everything else
 * silently — so `{ 'turn.ttfa_ms': 4 }` at the top level reaches nothing. Everything custom goes
 * under `metadata`, which is flattened one level into `langfuse.observation.metadata.<key>`.
 *
 * ⚠ A `null` OR EMPTY-STRING METADATA VALUE IS DROPPED, not recorded as null. Read in the 5.11
 * bundle: `_flattenAndSerializeMetadata` keeps a key only `if (serialized)`, and `_serialize(null)`
 * returns undefined. `false` and `0` survive (they serialise to the truthy strings `"false"` /
 * `"0"`). So an absent optional value shows up as a MISSING attribute — do not write an assertion
 * that expects the literal null.
 */
const spanAttributes = (fields: Record<string, unknown> | undefined): Parameters<LangfuseSpan['update']>[0] =>
  scrubFields(fields ?? {}) as Parameters<LangfuseSpan['update']>[0];

/** Wrap a vendor observation in our narrow, PII-scrubbing handle. */
function toTimelineSpan(observation: LangfuseSpan): TimelineSpan {
  // Read ONCE, eagerly: `spanContext()` is a plain getter on the OTel span and stays valid after
  // `end()`, which is what lets `completeTurn` create `tts.send` from an instant in the past.
  const parentSpanContext = observation.otelSpan.spanContext();
  return {
    update: (fields) => void observation.update(spanAttributes(fields)),
    end: (endTimeMs) => observation.end(endTimeMs),
    event: (name, fields, atMs) => {
      startObservation(name, spanAttributes(fields), {
        asType: 'event',
        parentSpanContext,
        ...(atMs !== undefined && { startTime: new Date(atMs) }),
      });
    },
    child: (name, fields, startedAtMs) => {
      const child = startObservation(name, spanAttributes(fields), {
        parentSpanContext,
        ...(startedAtMs !== undefined && { startTime: new Date(startedAtMs) }),
      });
      return {
        update: (updated) => void child.update(spanAttributes(updated)),
        end: (endTimeMs) => child.end(endTimeMs),
      };
    },
  };
}

export interface TurnSpanOptions {
  /**
   * Back-date the span's start to this epoch-ms instant. Supported natively:
   * `StartObservationOptions.startTime?: Date` is threaded into
   * `tracer.startActiveSpan(name, { startTime }, …)` by the 5.11 bundle.
   */
  readonly startTimeMs?: number;
  /**
   * `false` keeps the observation OPEN after the callback settles, so the caller can end it at an
   * instant it owns. THE CALLER THEN OWNS `end()` ON EVERY EXIT PATH INCLUDING THE THROW PATH — an
   * unended span does not reach Langfuse at all (see this module's header), so a missed path is a
   * silently missing observation rather than a visibly broken one.
   *
   * ⚠ MEASURED, so nobody overstates this: with the default of `true` and a caller that ends the span
   * itself, the recorded TIMES are IDENTICAL. `wrapPromise` in the 5.11 bundle calls `span.end()`
   * after the callback, and OpenTelemetry's `Span.end` answers a second call with
   * `diag.error('… You can only call end() on a span once.')` and returns — the first end time
   * stands. A mutation run confirmed the whole telemetry suite still passes with this option removed.
   *
   * It is still the right flag to pass: it stops one `diag.error` per turn (silent today only because
   * this app registers no diag logger), and it makes the end time ours by construction rather than by
   * the SDK choosing to ignore a later call.
   *
   * ⚠ WHAT THAT MEASUREMENT DOES NOT COVER — THE ERROR STATUS. `wrapPromise`'s rejection path is
   * `span.setStatus({code: ERROR, message})` and only THEN the conditional `end()`, and `setStatus`
   * is also dropped once the span is ended. So a caller that ends the span in its own `finally` takes
   * over the marking of a FAILED observation whether or not it passes this flag; measured, a rejecting
   * callback under that shape exports `status {code: 0}` (UNSET) instead of `{code: 2, message}`.
   * `server/twilio/voice.ts` writes `level: 'ERROR'` / `statusMessage` itself for exactly this reason.
   * Any new caller of `endOnExit: false` owes the same.
   *
   * Omitted, the vendor default of `true` applies and behaviour is exactly what it was before this
   * option existed — which is what keeps SMS, the bench and `scripts/verify-telemetry.ts` unchanged.
   */
  readonly endOnExit?: boolean;
}

/**
 * Run `fn` inside a turn span parented to the conversation, rehydrated from the stashed
 * traceparent.
 *
 * The callback must wrap the ENTIRE handler including any await on sending the response —
 * otherwise the AI SDK's own spans are created outside this context and land in a different
 * trace, which looks like the instrumentation half-working rather than being misused.
 */
export async function withTurnSpan<T>(
  name: string,
  traceparent: string | undefined,
  fn: (span: TimelineSpan) => Promise<T>,
  options?: TurnSpanOptions,
): Promise<T> {
  const parentCtx =
    traceparent === undefined
      ? context.active()
      : propagation.extract(context.active(), { [TRACEPARENT_KEY]: traceparent });

  return context.with(parentCtx, () =>
    startActiveObservation(
      name,
      async (observation) =>
        // Unless `endOnExit: false` was passed, startActiveObservation ends the observation itself
        // when the callback settles, so `fn` must not call `span.end()`.
        fn(toTimelineSpan(observation)),
      {
        ...(options?.endOnExit !== undefined && { endOnExit: options.endOnExit }),
        ...(options?.startTimeMs !== undefined && { startTime: new Date(options.startTimeMs) }),
      },
    ),
  ) as Promise<T>;
}

/**
 * A span parented to a SERIALISED parent — the conversation root — rather than to the ambient
 * context, and optionally back-dated.
 *
 * This is what `caller.turn` needs. It is created from inside a turn handler (where the ambient
 * context is the TURN span) but belongs beside the turns, under the root: the gap it describes ends
 * where the turn begins, so nesting it inside that turn would draw a child longer than its parent.
 *
 * HONEST LIMIT: with `traceparent === undefined` there is nothing to parent to, so this falls back
 * to `context.active()` — under the turn span when called from inside one, or a fresh root when
 * called from a WebSocket handler. That case means tracing is off (no provider, so no traceparent
 * was ever produced), which is the documented degradation for a missing Langfuse.
 */
export function startSpanUnder(
  traceparent: string | undefined,
  name: string,
  fields?: Record<string, unknown>,
  startTimeMs?: number,
): SpanLike {
  const parentCtx =
    traceparent === undefined
      ? context.active()
      : propagation.extract(context.active(), { [TRACEPARENT_KEY]: traceparent });

  const observation = context.with(parentCtx, () =>
    startObservation(name, spanAttributes(fields), {
      ...(startTimeMs !== undefined && { startTime: new Date(startTimeMs) }),
    }),
  );
  return {
    update: (updated) => void observation.update(spanAttributes(updated)),
    end: (endTimeMs) => observation.end(endTimeMs),
  };
}

/**
 * A child observation for one measurable step (`prompt.fetch`, `tools.resolve`, `tts.handoff`).
 * Caller owns `end()`. Prefer `timeStep` unless you need to interleave.
 */
export function startStep(name: string, input?: Record<string, unknown>): SpanLike {
  const observation = startObservation(name, input === undefined ? {} : { input: scrubFields(input) });
  return {
    update: (fields) => void observation.update(spanAttributes(fields)),
    // Forwarded rather than dropped, so `SpanLike` means the same thing everywhere. Every current
    // caller omits it.
    end: (endTimeMs) => observation.end(endTimeMs),
  };
}

/**
 * Time an async step and record its output. Ends the span on both paths — an error is recorded
 * and rethrown, because a step that failed is the most interesting thing in the waterfall and
 * swallowing it here would hide it.
 */
export async function timeStep<T>(
  name: string,
  fn: () => Promise<T>,
  describe?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const span = startStep(name);
  const startedAt = Date.now();
  try {
    const result = await fn();
    span.update({
      output: describe?.(result) ?? {},
      metadata: { durationMs: Date.now() - startedAt },
    });
    return result;
  } catch (err) {
    span.update({
      level: 'ERROR',
      statusMessage: err instanceof Error ? err.message : String(err),
      metadata: { durationMs: Date.now() - startedAt },
    });
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Force every finished span out to Langfuse.
 *
 * Must go through `.getDelegate()`. `trace.getTracerProvider()` returns a `ProxyTracerProvider`
 * which has NO `forceFlush`, so the tempting `trace.getTracerProvider().forceFlush?.()` is a
 * silent no-op — and the symptom is an empty Langfuse with no error anywhere, which reads as a
 * broken integration rather than a missed flush. Cost me real time during spike S1.
 */
export async function flushTelemetry(): Promise<void> {
  try {
    const provider = trace.getTracerProvider() as {
      getDelegate?: () => { forceFlush?: () => Promise<void> };
    };
    await provider.getDelegate?.()?.forceFlush?.();
  } catch (err) {
    log.debug({ err }, 'flush skipped (no provider registered)');
  }
}
