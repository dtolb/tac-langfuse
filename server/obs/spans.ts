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
import { startObservation, startActiveObservation } from '@langfuse/tracing';
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
  end(): void;
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
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  const parentCtx =
    traceparent === undefined
      ? context.active()
      : propagation.extract(context.active(), { [TRACEPARENT_KEY]: traceparent });

  return context.with(parentCtx, () =>
    startActiveObservation(name, async (observation) => {
      const span: SpanLike = {
        update: (fields) => observation.update(scrubFields(fields)),
        end: () => observation.end(),
      };
      // startActiveObservation ends the observation itself when the callback settles, so `fn`
      // must not call span.end() — the wrapper above exists for symmetry with startStep.
      return fn(span);
    }),
  ) as Promise<T>;
}

/**
 * A child observation for one measurable step (`prompt.fetch`, `tools.resolve`, `tts.handoff`).
 * Caller owns `end()`. Prefer `timeStep` unless you need to interleave.
 */
export function startStep(name: string, input?: Record<string, unknown>): SpanLike {
  const observation = startObservation(name, input === undefined ? {} : { input: scrubFields(input) });
  return {
    update: (fields) => observation.update(scrubFields(fields)),
    end: () => observation.end(),
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
