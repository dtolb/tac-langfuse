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
import { context, propagation, trace, type Context } from '@opentelemetry/api';
import {
  LangfuseOtelSpanAttributes,
  propagateAttributes,
  startObservation,
  startActiveObservation,
  type LangfuseSpan,
} from '@langfuse/tracing';
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
 * time we know what they mean — `tts.interrupted` is stamped at the interrupt receipt, from a handler
 * that has no reference to the turn's own context.
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

/** The Langfuse trace identity a conversation root is opened with. */
export interface RootIdentity {
  /** Langfuse `sessionId`: the conversation id. Also the key `rootContextFor` finds the root by. */
  readonly sessionId: string;
  /** Langfuse `userId`, when already known. Never a phone number. */
  readonly userId?: string | undefined;
  /** Trace tags set on the root at start. */
  readonly tags?: readonly string[];
  /** Root metadata set at start. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Start the per-conversation root span and immediately serialise its context.
 *
 * NOT held open as an active context — see the module comment. The returned handle must be
 * `end()`ed on `webSocketDisconnected` / `conversationEnded`, and callers should also sweep on a
 * timeout: a dropped WebSocket that never fires `close` would otherwise leak an unended span
 * forever, and an unended span never reaches Langfuse at all.
 *
 * @param input root input, when known at start.
 * @param identity session, user and tags for the trace. With it, the root is registered so that
 *   every span later created under its traceparent inherits the ids, `annotateTrace` can update it,
 *   and `rootContextFor` can find it until `ROOT_RETENTION_MS` after it ends.
 */
export function startConversationSpan(
  name: string,
  input?: Record<string, unknown>,
  identity?: RootIdentity,
): ConversationSpan {
  const fields = {
    ...(input !== undefined && { input: scrubFields(input) }),
    ...(identity?.metadata !== undefined && { metadata: scrubFields(identity.metadata) }),
  };
  const observation =
    identity === undefined
      ? startObservation(name, fields)
      : propagateAttributes(
          {
            sessionId: identity.sessionId,
            traceName: name,
            ...(identity.userId !== undefined && { userId: identity.userId }),
            ...(identity.tags !== undefined && { tags: [...identity.tags] }),
          },
          () => startObservation(name, fields),
        );

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

  const traceparent = carrier[TRACEPARENT_KEY];
  const root =
    identity === undefined || traceparent === undefined ? undefined : registerRoot(observation, traceparent, identity);

  return {
    traceparent,
    update: (fields) => observation.update(scrubFields(fields)),
    end: () => {
      observation.end();
      if (root !== undefined) root.endedAt = Date.now();
    },
  };
}

/** How long an ended root stays retrievable through `rootContextFor`. */
export const ROOT_RETENTION_MS = 15 * 60_000;
const MAX_ROOTS = 500;

interface RootRecord {
  readonly traceparent: string;
  readonly sessionId: string;
  readonly observation: LangfuseSpan;
  readonly tags: Set<string>;
  userId: string | undefined;
  hasInput: boolean;
  endedAt: number | null;
}

const rootsByTraceId = new Map<string, RootRecord>();
const traceIdByKey = new Map<string, string>();

const pruneRoots = (now: number): void => {
  for (const [traceId, root] of rootsByTraceId) {
    const expired = root.endedAt !== null && now - root.endedAt > ROOT_RETENTION_MS;
    if (expired || rootsByTraceId.size > MAX_ROOTS) rootsByTraceId.delete(traceId);
  }
  for (const [key, traceId] of traceIdByKey) if (!rootsByTraceId.has(traceId)) traceIdByKey.delete(key);
};

function registerRoot(observation: LangfuseSpan, traceparent: string, identity: RootIdentity): RootRecord {
  pruneRoots(Date.now());
  const traceId = observation.otelSpan.spanContext().traceId;
  const root: RootRecord = {
    traceparent,
    sessionId: identity.sessionId,
    observation,
    tags: new Set(identity.tags ?? []),
    userId: identity.userId,
    hasInput: false,
    endedAt: null,
  };
  rootsByTraceId.set(traceId, root);
  traceIdByKey.set(identity.sessionId, traceId);
  return root;
}

const traceIdOf = (traceparent: string): string | undefined => traceparent.split('-')[1];

/**
 * Makes the root behind `traceparent` findable by `rootContextFor(key)` as well as by its session id.
 * A no-op for an unregistered root or an undefined key.
 */
export function aliasRoot(traceparent: string | undefined, key: string | undefined): void {
  if (traceparent === undefined || key === undefined || key === '') return;
  const traceId = traceIdOf(traceparent);
  if (traceId !== undefined && rootsByTraceId.has(traceId)) traceIdByKey.set(key, traceId);
}

/** A conversation root as `rootContextFor` reports it. */
export interface RootContext {
  readonly traceparent: string;
  readonly sessionId: string;
  readonly userId: string | undefined;
}

/**
 * The root registered under `key` — its session id or an alias such as a voice call's CallSid — while
 * it is open and for `ROOT_RETENTION_MS` after it ends. Never opens a root.
 */
export function rootContextFor(key: string): RootContext | undefined {
  pruneRoots(Date.now());
  const traceId = traceIdByKey.get(key);
  const root = traceId === undefined ? undefined : rootsByTraceId.get(traceId);
  if (root === undefined) return undefined;
  return { traceparent: root.traceparent, sessionId: root.sessionId, userId: root.userId };
}

/** What `annotateTrace` can write onto a trace. */
export interface TraceAnnotation {
  /** Written onto the active span and the root; spans created under the trace afterwards inherit it. */
  readonly userId?: string | null;
  /** Root input. Only the first value per trace is kept. */
  readonly input?: string;
  /** Root output. The latest value wins. */
  readonly output?: string;
  /** Added to the root's trace tags. */
  readonly tags?: readonly string[];
}

/**
 * Annotates the trace of the ACTIVE span. A no-op when there is no active span or its trace has no
 * open registered root (`userId` still lands on the active span).
 */
export function annotateTrace(fields: TraceAnnotation): void {
  const active = trace.getActiveSpan();
  if (active === undefined) return;
  const userId = fields.userId ?? undefined;
  if (userId !== undefined && userId !== '') active.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, userId);

  const root = rootsByTraceId.get(active.spanContext().traceId);
  if (root === undefined || root.endedAt !== null) return;
  const otelSpan = root.observation.otelSpan;
  if (userId !== undefined && userId !== '') {
    root.userId = userId;
    otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, userId);
  }
  if (fields.input !== undefined && !root.hasInput) {
    root.hasInput = true;
    root.observation.update(spanAttributes({ input: fields.input }));
  }
  if (fields.output !== undefined) root.observation.update(spanAttributes({ output: fields.output }));
  if (fields.tags !== undefined && fields.tags.length > 0) {
    for (const tag of fields.tags) root.tags.add(tag);
    otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, [...root.tags]);
  }
}

/**
 * Runs `fn` in `parentCtx` with the parent's trace id claimed in the `langfuse_trace_id` baggage
 * entry, and with the session and user ids of that trace's registered root propagated, so every span
 * created inside lands in the trace (even after its root has ended) carrying those ids.
 */
function inTrace<T>(parentCtx: Context, fn: () => T): T {
  const traceId = trace.getSpanContext(parentCtx)?.traceId;
  if (traceId === undefined) return context.with(parentCtx, fn);
  const baggage = propagation.getBaggage(parentCtx) ?? propagation.createBaggage();
  const claimed = propagation.setBaggage(parentCtx, baggage.setEntry('langfuse_trace_id', { value: traceId }));
  const root = rootsByTraceId.get(traceId);
  return context.with(claimed, () =>
    root === undefined
      ? fn()
      : propagateAttributes(
          { sessionId: root.sessionId, ...(root.userId !== undefined && { userId: root.userId }) },
          fn,
        ),
  );
}

/** `context.active()` parented to `traceparent`, or `context.active()` itself without one. */
const parentContextOf = (traceparent: string | undefined): Context =>
  traceparent === undefined
    ? context.active()
    : propagation.extract(context.active(), { [TRACEPARENT_KEY]: traceparent });

/**
 * Runs `fn` so every span created inside it carries the session and user ids of the active span's
 * trace. Used around calls whose spans are created by a library (the AI SDK).
 */
export function withTraceIdentity<T>(fn: () => T): T {
  return inTrace(context.active(), fn);
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
  // `end()`, which is what lets a child be created from an instant in the past.
  const parentSpanContext = observation.otelSpan.spanContext();
  return {
    update: (fields) => void observation.update(spanAttributes(fields)),
    end: (endTimeMs) => observation.end(endTimeMs),
    event: (name, fields, atMs) => {
      inTrace(trace.setSpanContext(context.active(), parentSpanContext), () =>
        startObservation(name, spanAttributes(fields), {
          asType: 'event',
          parentSpanContext,
          ...(atMs !== undefined && { startTime: new Date(atMs) }),
        }),
      );
    },
    child: (name, fields, startedAtMs) => {
      const child = inTrace(trace.setSpanContext(context.active(), parentSpanContext), () =>
        startObservation(name, spanAttributes(fields), {
          parentSpanContext,
          ...(startedAtMs !== undefined && { startTime: new Date(startedAtMs) }),
        }),
      );
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
  return inTrace(parentContextOf(traceparent), () =>
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
  const observation = inTrace(parentContextOf(traceparent), () =>
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
 * Draw a finished child of the ACTIVE span from `startMs` to `endMs` (epoch ms), carrying the
 * trace's session and user ids.
 */
export function recordStep(
  name: string,
  fields: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number,
): void {
  inTrace(context.active(), () =>
    startObservation(name, spanAttributes(fields), { startTime: new Date(startMs) }),
  ).end(endMs);
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

/**
 * Draws a span named `name` under the serialised parent `traceparent`, from `startMs` to `endMs`
 * (epoch ms), carrying the trace's session and user ids. The parent may already have ended.
 */
export function drawUnder(
  traceparent: string | undefined,
  name: string,
  fields: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number,
): void {
  startSpanUnder(traceparent, name, fields, startMs).end(endMs);
}

/**
 * Records a zero-duration event named `name` at `atMs` (epoch ms) under the serialised parent
 * `traceparent`, carrying the trace's session and user ids. The parent may already have ended.
 */
export function eventUnder(
  traceparent: string | undefined,
  name: string,
  fields: Record<string, unknown> | undefined,
  atMs: number,
): void {
  inTrace(parentContextOf(traceparent), () =>
    startObservation(name, spanAttributes(fields), { asType: 'event', startTime: new Date(atMs) }),
  );
}
