# Section 2. The code

Five layers, each paste-able on its own. The order matters: layer 1 must run before anything imports the SDK, layer 3 is the one readers get wrong, and layer 5 exists only because a barge-in closes a turn from a different callback than the one that opened it.

Two facts about the SDK govern all five layers, and both are readable in the shipped bundle rather than in any document. The bundle contains no OpenTelemetry code at all, so every span below is created by the host application and none by the SDK. And the SDK never invokes a tool: `TACTool.implementation` is read only in the class constructor and inside `toOpenAIAgentsSDKTool`'s `execute`, so the model runtime dispatches tools and the SDK is not in that path. Both statements come from reading `twilio-agent-connect` 2.2.0's `dist/index.js` and `dist/index.d.ts` as installed.

A note on what "verified" means on this page. Every block below compiled under `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, and I re-ran the compiler myself to confirm exit code 0. Compiling is not running. Each layer says which of the two it got, and the difference is load-bearing for layers 1, 2 and 4.

## Layer 1. Exporter and provider, and why registration order beats every other setup question

```ts
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

if (endpoint === undefined || endpoint === '') {
  process.stderr.write('[otel] no OTLP endpoint configured, tracing disabled\n');
} else {
  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS === undefined
      ? {}
      : Object.fromEntries(
          process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map((pair) => {
            const eq = pair.indexOf('=');
            return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
          }),
        ),
    timeoutMillis: 5_000,
  });

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'tac-agent',
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  sdk.start();
  process.stderr.write(`[otel] exporting spans to ${endpoint}\n`);

  process.once('beforeExit', () => {
    void sdk.shutdown().catch(() => undefined);
  });
}

export async function flushTelemetry(): Promise<void> {
  const provider = trace.getTracerProvider() as {
    getDelegate?: () => { forceFlush?: () => Promise<void> };
  };
  await provider.getDelegate?.()?.forceFlush?.();
}
```

Load this file with `node --import ./telemetry.ts ./index.ts`, not with an `import './telemetry.ts'` at the top of your entry point. ECMAScript modules hoist and evaluate all imports of a module before its body runs, so a top-of-file import still evaluates interleaved with the modules it is supposed to have patched first. The `--import` preload is the only placement that guarantees the provider exists before the SDK, the AI client and any HTTP instrumentation are loaded. This is a property of module evaluation order rather than something specific to Agent Connect, and it is the reason the shipped scaffold this code was extracted from uses a preload rather than an import.

The `flushTelemetry` shape is not decoration. `trace.getTracerProvider()` returns a `ProxyTracerProvider`, which has no `forceFlush` of its own, so the natural-looking `trace.getTracerProvider().forceFlush?.()` is an optional call on a method that does not exist and therefore a silent no-op. The symptom is an empty backend with no error anywhere, which reads as a backend problem. Reaching the delegate is what actually flushes, and it flushes without tearing the provider down, so spans ended after the flush still export.

Register `beforeExit` and resist adding a `SIGTERM` handler here. A preload's signal listener runs before the application's own, because Node dispatches listeners in registration order, so a `SIGTERM` handler that calls `sdk.shutdown()` races the application's own graceful close. In the scaffold this was measured as a loss: whichever side won, the conversation root spans were ended after the provider had been torn down, and a span ended on a dead provider is dropped in silence. Flush from the application's shutdown path instead, and order it so the roots are ended before the flush rather than after.

This layer was typechecked, not executed. In the verification workspace `@opentelemetry/exporter-trace-otlp-http` was not a direct dependency; it was present only transitively, so the compiler resolved it through a path alias and an attempt to actually run the file failed at module resolution. Install `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-base` and `@opentelemetry/exporter-trace-otlp-http` explicitly before you expect this to boot. Treat the endpoint, the batching and the flush path as compiled and reasoned, and prove them against your own collector.

## Layer 2. Decorating the callbacks without touching their return contracts

There are three application-level callbacks, and every one of them is a single-slot setter rather than a subscription. Registering twice replaces the first registration silently, and registering a channel with the SDK causes the SDK's own internal forwarders to take the `error`, `messageReceived`, `prompt`, `interrupt` and `conversationEnded` slots. Setting your own listener on one of those five after registering a channel therefore stops the corresponding application callback from firing at all, with no error. Decide once whether the SDK owns a channel's events or you do.

```ts
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  ConversationEndedCallback,
  InterruptCallback,
  MessageReadyCallback,
} from 'twilio-agent-connect';
import {
  createConversationTraceRegistry,
  startSpanUnder,
  withTurnSpan,
  type ConversationTraceRegistry,
} from './trace-context.ts';

export interface TracedCallbacks {
  readonly registry: ConversationTraceRegistry;
  messageReady(inner: MessageReadyCallback): MessageReadyCallback;
  interrupt(inner: InterruptCallback): InterruptCallback;
  conversationEnded(inner: ConversationEndedCallback): ConversationEndedCallback;
}

export function createTracedCallbacks(
  options: { agentName?: string; registry?: ConversationTraceRegistry } = {},
): TracedCallbacks {
  const agentName = options.agentName ?? 'tac-agent';
  const registry = options.registry ?? createConversationTraceRegistry();

  return {
    registry,

    messageReady(inner) {
      return async (params) => {
        registry.sweep();
        const root = registry.ensure(params.conversationId, `conversation.${params.channel}`, {
          'gen_ai.agent.name': agentName,
          'tac.channel': params.channel,
        });

        return withTurnSpan(
          `turn.${params.channel}`,
          root.traceparent,
          async (span) => {
            span.setAttributes({
              'gen_ai.operation.name': 'invoke_agent',
              'gen_ai.agent.name': agentName,
              'gen_ai.conversation.id': params.conversationId,
              'tac.channel': params.channel,
              'tac.turn.author': params.author,
              'tac.turn.input_chars': params.message.length,
              'tac.turn.has_memory': params.memory !== undefined,
              'tac.turn.has_profile': params.profileId !== undefined,
            });

            const result = await inner(params);

            if (typeof result === 'string') {
              span.setAttributes({
                'tac.turn.output_chars': result.length,
                'tac.turn.auto_sent': result !== '',
              });
            } else {
              span.setAttribute('tac.turn.auto_sent', false);
            }
            span.setAttribute('tac.turn.aborted', params.abortSignal?.aborted ?? false);
            return result;
          },
          { attributes: { 'gen_ai.conversation.id': params.conversationId } },
        );
      };
    },

    interrupt(inner) {
      return async (params) => {
        const traceparent = registry.traceparentFor(params.conversationId);
        const at = Date.now();
        const event = startSpanUnder(
          traceparent,
          'tts.interrupted',
          {
            'gen_ai.conversation.id': params.conversationId,
            'tac.interrupt.duration_until_interrupt_ms': params.durationUntilInterruptMs ?? -1,
            'tac.interrupt.utterance_chars': params.utteranceUntilInterrupt?.length ?? 0,
          },
          at,
        );
        event.end(at);
        await inner(params);
      };
    },

    conversationEnded(inner) {
      return async (params) => {
        try {
          await inner(params);
        } catch (err) {
          registry.update(params.session.conversationId, {
            'conversation.error': err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          registry.end(params.session.conversationId, {
            'tac.channel': params.session.channel,
          });
        }
      };
    },
  };
}
```

The return contract is the whole difficulty of this layer. `MessageReadyCallback` returns `Promise<string | null | void> | string | null | void`, and those three cases mean three different things to the SDK. `TAC.handleMessageReady` checks `typeof response === 'string'` and, when it is, calls the channel's `sendResponse`, which emits one frame with `last: true`. Return `null` or `void` and the SDK sends nothing, which is what you want when your own code is streaming tokens back through the channel. So a decorator must pass the inner value through untouched and must never normalise `void` into `null`, or the meaning survives but only by luck. The block above narrows with `typeof result === 'string'` purely to read a length off the string, and returns `result` unchanged on every path.

Notice what is missing from the decorator: it does not swallow errors. It cannot usefully do so, because the SDK already catches anything thrown out of these three callbacks and only logs it. That means a throw inside your handler is invisible to the caller and to the transport, and if you do not mark the span yourself the failed turn exports as a successful one.

The optional chain on `params.abortSignal` is not defensive habit. On the message-ready callback `abortSignal` is optional in the declared type, whereas on the voice `prompt` payload it is required. Any mitigation you write around aborts on the messaging path has to cope with its absence.

This layer was typechecked against the real exported callback types and not executed. The three signatures, including the `string | null | void` union and the optional `abortSignal`, come from `dist/index.d.ts` as installed and the compiler accepted the decorators as drop-in replacements. Whether the SDK's auto-send behaves as the type suggests when handed each of the three return values was not exercised here.

## Layer 3. Context propagation, which is a serialised traceparent and not AsyncLocalStorage

This is the layer that decides whether you get one trace per conversation or one trace per turn, and the failure mode is quiet enough that it survives review.

A voice conversation is minutes of independent WebSocket frames. There is no async call stack spanning them, so there is no `AsyncLocalStorage` context to hold open across a turn boundary; anything that tries becomes a context you have to keep alive for the length of a phone call. The mechanism that does work is the W3C trace context: start the conversation root, immediately `propagation.inject` its span context into a carrier, keep the resulting `traceparent` string in a registry keyed by conversation id, and rehydrate it with `propagation.extract` at the start of every turn. `AsyncLocalStorage` still matters, but only inside a turn, where it carries the context from your handler down into whatever library produces the model spans.

```ts
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

export const tracer = trace.getTracer('tac-otel', '0.1.0');

export const TRACEPARENT_KEY = 'traceparent';

export interface ConversationTrace {
  readonly traceparent: string | undefined;
  readonly span: Span;
}

export function startConversationSpan(name: string, attributes: Attributes = {}): ConversationTrace {
  const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes });
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), carrier);
  return { traceparent: carrier[TRACEPARENT_KEY], span };
}

export function parentContextFrom(traceparent: string | undefined) {
  return traceparent === undefined
    ? context.active()
    : propagation.extract(context.active(), { [TRACEPARENT_KEY]: traceparent });
}

export interface TurnSpanOptions {
  readonly startTimeMs?: number;
  readonly endOnExit?: boolean;
  readonly attributes?: Attributes;
}

export async function withTurnSpan<T>(
  name: string,
  traceparent: string | undefined,
  fn: (span: Span) => Promise<T>,
  options: TurnSpanOptions = {},
): Promise<T> {
  const parentCtx = parentContextFrom(traceparent);
  const span = tracer.startSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      ...(options.startTimeMs !== undefined && { startTime: options.startTimeMs }),
      ...(options.attributes !== undefined && { attributes: options.attributes }),
    },
    parentCtx,
  );

  try {
    return await context.with(trace.setSpan(parentCtx, span), () => fn(span));
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    if (options.endOnExit !== false) span.end();
  }
}

export function startSpanUnder(
  traceparent: string | undefined,
  name: string,
  attributes: Attributes = {},
  startTimeMs?: number,
): Span {
  return tracer.startSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes, ...(startTimeMs !== undefined && { startTime: startTimeMs }) },
    parentContextFrom(traceparent),
  );
}

export function childOfSpan(
  parent: Span,
  name: string,
  attributes: Attributes = {},
  startTimeMs?: number,
): Span {
  return tracer.startSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes, ...(startTimeMs !== undefined && { startTime: startTimeMs }) },
    trace.setSpan(context.active(), parent),
  );
}
```

The registry that holds the carrier has to be bounded and swept, because neither channel gives a reliable end signal for every case. The version below evicts by idle time and by count, and ends the root span on the way out so that a conversation which simply stops talking still exports a root whose duration covers its children.

```ts
interface Entry {
  readonly trace: ConversationTrace;
  lastSeenAt: number;
}

export interface ConversationTraceRegistry {
  ensure(conversationId: string, name: string, attributes?: Attributes): ConversationTrace;
  traceparentFor(conversationId: string): string | undefined;
  update(conversationId: string, attributes: Attributes): void;
  end(conversationId: string, attributes?: Attributes): void;
  sweep(nowMs?: number): void;
}

export function createConversationTraceRegistry(
  options: { idleTtlMs?: number; maxConversations?: number } = {},
): ConversationTraceRegistry {
  const idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
  const maxConversations = options.maxConversations ?? 200;
  const entries = new Map<string, Entry>();

  const close = (id: string, entry: Entry, attributes: Attributes): void => {
    entry.trace.span.setAttributes(attributes);
    entry.trace.span.end();
    entries.delete(id);
  };

  return {
    ensure(conversationId, name, attributes = {}) {
      const existing = entries.get(conversationId);
      if (existing !== undefined) {
        existing.lastSeenAt = Date.now();
        return existing.trace;
      }
      const started = startConversationSpan(name, {
        'gen_ai.conversation.id': conversationId,
        ...attributes,
      });
      entries.set(conversationId, { trace: started, lastSeenAt: Date.now() });
      while (entries.size > maxConversations) {
        const oldest = entries.entries().next();
        if (oldest.done === true) break;
        close(oldest.value[0], oldest.value[1], { 'conversation.closed_because': 'evicted' });
      }
      return started;
    },

    traceparentFor: (conversationId) => entries.get(conversationId)?.trace.traceparent,

    update(conversationId, attributes) {
      entries.get(conversationId)?.trace.span.setAttributes(attributes);
    },

    end(conversationId, attributes = {}) {
      const entry = entries.get(conversationId);
      if (entry === undefined) return;
      close(conversationId, entry, { 'conversation.closed_because': 'ended', ...attributes });
    },

    sweep(nowMs = Date.now()) {
      for (const [id, entry] of entries) {
        if (nowMs - entry.lastSeenAt > idleTtlMs) {
          close(id, entry, { 'conversation.closed_because': 'idle' });
        }
      }
    },
  };
}
```

Two design choices in that registry are worth stating because the obvious alternatives fail. Keep the carrier in your own registry rather than in the SDK's session metadata: the session survives until the conversation is marked closed upstream, while your registry sweeps on a TTL and ends the root span, so reading from session metadata after a sweep rehydrates turn N+1 as a child of a root that has already ended and already exported. The result is a root whose duration does not cover its children. And observe that `startConversationSpan` injects the carrier and then deliberately does not hold the root span active, because holding it active for the length of a call is exactly the context lifetime you were trying to avoid.

### The failure mode: a trace that looks complete and is not

Get this layer wrong and you do not get an error. You get spans that carry the right names, the right attributes and the right durations, in a viewer that renders each one as a plausible root. Two distinct mistakes produce that, and I measured both.

The first is starting a span from a callback that has no ambient context. The interrupt callback is the clearest case, because the SDK dispatches it from its own WebSocket message handler with nothing on the stack from your prompt handler. A bare `tracer.startSpan` there becomes the root of a brand new trace, so every barge-in mints a second trace for the same call. In a run I executed, one conversation that created its root correctly and then started one span the correct way and one span the naive way exported two distinct trace ids, with the naive span reported as `parent=ROOT`. The fix is `startSpanUnder`, which extracts the serialised parent explicitly rather than trusting the ambient context.

The second is a span whose parent was never ended. In the same run I started a span under a correctly extracted parent and never ended it, and the exporter received three spans; the unended one was absent entirely. An unended span does not arrive late, and it does not arrive as an open interval. It does not arrive. That is the trap, because the trace you are looking at is complete for every span you can see, and the missing one leaves no trace of its absence.

A third variant catches people who verify with a test harness. A bare `BasicTracerProvider` with no context manager makes `context.with` a no-op, so the propagation you are testing silently does nothing. When the scaffold's voice telemetry suite was first assembled that way, one simulated call reported six trace ids. Install a context manager and a propagator in the harness, and check the count of distinct trace ids as an assertion rather than eyeballing the shape:

```ts
import { context, propagation, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
```

### The head-of-line property that changes what a turn boundary means

Turn N+1 is chained behind turn N. The voice channel keeps a per-conversation promise queue and, on each inbound prompt frame, does `previousPrompt.then(() => this.handlePromptMessage(conversationId, message))` before storing the resulting promise back under the same conversation id. I read this in the installed bundle and confirmed the queue map is written in exactly that one place. Three consequences follow, and all three matter to anyone adding a network hop inside a turn.

Your prompt listener's returned promise is the turn boundary. If you register a listener that returns `void` and starts work in the background, turn N+1 begins while turn N is still streaming, and the serialisation the SDK is offering you evaporates. Return the promise.

Because the boundary is your promise, any latency you add inside the handler is added to the head of the line for the next turn, not just to this one. A remote model hop does not merely make this answer slower; it delays the point at which the next caller utterance can even begin processing.

And the instant you record as the start of a turn is a floor rather than the caller's stop. The prompt handler awaits its memory retrieval before invoking your callback, so on the first turn of a conversation an upstream memory round trip lands before your first timestamp. Whatever you name that first stamp, do not describe it as the moment the caller stopped speaking.

This layer was executed. Both harness programs ran to completion with exit code 0. The correct path produced one distinct trace id across a two-turn conversation with every span parented as intended, and the two failure modes reproduced as described above. The import paths in the harness block are the one thing I changed from the verified files: the workspace resolved `@opentelemetry/context-async-hooks` and `@opentelemetry/core` through transitive paths because neither was a direct dependency, and I have rewritten them to package names after confirming that both packages export the symbols shown. Install both explicitly.

## Layer 4. A tool decorator that leaves tool authoring alone

There is no tool middleware to hook. The SDK exposes no `onToolCall`, no tool context plumbing, and it never calls a tool implementation on the dispatch path at all. `toOpenAIFormat` and `toAnthropicFormat` emit schema only, so the model runtime is what invokes your function. That leaves one clean seam: rebuild each `TACTool` around its own implementation.

```ts
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { TACTool, defineTool, type JSONSchema, type ToolFunction } from 'twilio-agent-connect';
import { tracer } from './trace-context.ts';

export function traceTool<TParams, TResult>(tool: TACTool<TParams, TResult>): TACTool<TParams, TResult> {
  const inner: ToolFunction<TParams, TResult> = tool.implementation;

  const traced: ToolFunction<TParams, TResult> = async (params: TParams): Promise<TResult> => {
    const span = tracer.startSpan(
      `execute_tool ${tool.name}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': tool.name,
          'gen_ai.tool.type': 'function',
        },
      },
      context.active(),
    );

    const startedAt = Date.now();
    try {
      return await context.with(trace.setSpan(context.active(), span), () => inner(params));
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.setAttribute('error.type', err instanceof Error ? err.name : 'unknown');
      throw err;
    } finally {
      span.setAttribute('tac.tool.duration_ms', Date.now() - startedAt);
      span.end();
    }
  };

  return new TACTool<TParams, TResult>(tool.name, tool.description, tool.parameters, traced);
}

export function defineTracedTool<TParams = unknown, TResult = unknown>(
  name: string,
  description: string,
  parameters: JSONSchema,
  implementation: ToolFunction<TParams, TResult>,
): TACTool<TParams, TResult> {
  return traceTool(defineTool<TParams, TResult>(name, description, parameters, implementation));
}
```

Nothing about how a tool is authored changes. `defineTracedTool` has the same four-parameter shape as `defineTool`, so existing definitions swap the factory name and are done, and `traceTool` handles the tools you did not author, since the platform factories all return a `TACTool` and are therefore all wrappable. The generic parameters flow through so a typed implementation stays typed.

The attribute names come from the GenAI conventions rather than from anything vendor-specific. `execute_tool` is the specified span name form and `gen_ai.operation.name` plus `gen_ai.tool.name` are its two required attributes, with `gen_ai.tool.type` recommended and `function` a well-known value. Two caveats on that. The conventions moved out of the main semantic-conventions repository into a dedicated GenAI repository, where nothing is tagged and every `gen_ai.*` attribute is badged Development, so you are targeting an untagged development registry that changes week to week. And if you have a conversation id available at tool-execution time, `gen_ai.conversation.id` on a tool span became conditionally required only very recently, which is a good illustration of how much of this surface is still moving.

Set `gen_ai.tool.name` at span creation rather than afterwards, as the block does. The conventions mark the agent name on tool spans as sampling-relevant, meaning a sampler may read it, and a sampler runs when the span is created.

This layer was typechecked, not executed. The compiler accepted reading `tool.implementation` and reconstructing the class through its public four-argument constructor with the generics preserved, and the two-read-sites claim about `implementation` comes from grepping the shipped bundle. Nothing here has been run against a model runtime actually dispatching a tool call, so the timings and the error path are compiled rather than observed.

## Layer 5. Barge-in, where the span boundary and the span close live in different callbacks

The naive version ends the turn span in the interrupt handler, and it costs you exactly the attributes you care about on the one ending that is ordinary operation on a phone call.

Here is why. The interrupt handler runs promptly after the stream task is cancelled, while your prompt handler is still waiting for its stream to drain, and the attributes that describe the turn's result are written after that drain completes. Once a span has ended, `setAttribute` and `setStatus` return early rather than throwing. So the naive version loses `output`, the called-tools list, and the model-relative total duration, and it loses them in silence. In the scaffold this showed up as a barged-in turn that exported with no output text and no tool list. Ending the span in your own handler rather than letting a wrapper end it also transfers error marking to you: a turn whose prompt fetch threw exported with an unset status where the wrapper's own ending had exported an error status with a message.

The mechanism has three pieces. A registry both callbacks can reach, because the interrupt arrives on its own frame and cannot see the prompt handler's closure. An interrupt handler that parks a boundary and does not close anything. And a prompt handler whose `finally` closes the span after the drain, preferring the parked boundary if one exists.

```ts
import type { Attributes, Span } from '@opentelemetry/api';
import { childOfSpan } from './trace-context.ts';

export type TurnEnding = 'last-token' | 'interrupt' | 'no-output' | 'evicted';

export interface TurnClose {
  readonly atMs: number;
  readonly aborted: boolean;
  readonly ending: TurnEnding;
}

interface LiveTurn {
  readonly span: Span;
  readonly promptAt: number;
  firstTokenAt: number | null;
  recordedClose: TurnClose | null;
}

interface Entry {
  live: LiveTurn | null;
  lastBotOutputAt: number | null;
  turns: number;
  aborted: number;
  callerTurnMs: number;
  readonly ttfaMs: number[];
}

export interface VoiceTimeline {
  beginTurn(conversationId: string, span: Span, atMs: number): number | null;
  markFirstToken(conversationId: string, atMs: number, ownerSpan: Span): void;
  liveTurn(conversationId: string): Span | null;
  recordBoundary(conversationId: string, close: TurnClose): void;
  completeTurn(conversationId: string, close: TurnClose, ownerSpan: Span): void;
  markBotOutput(conversationId: string, atMs: number): void;
  forget(conversationId: string): Attributes | undefined;
}

export function createVoiceTimeline(): VoiceTimeline {
  const entries = new Map<string, Entry>();

  const blank = (): Entry => ({
    live: null,
    lastBotOutputAt: null,
    turns: 0,
    aborted: 0,
    callerTurnMs: 0,
    ttfaMs: [],
  });

  const closeLive = (live: LiveTurn, close: TurnClose): { atMs: number; ttfaMs: number | null; aborted: boolean } => {
    const effective = live.recordedClose ?? close;
    const atMs = Math.max(effective.atMs, live.promptAt);
    const ttfaMs = live.firstTokenAt === null ? null : Math.max(0, live.firstTokenAt - live.promptAt);

    if (live.firstTokenAt !== null) {
      const tts = childOfSpan(
        live.span,
        'tts.send',
        { 'tac.tts.started_because': 'first text token sent' },
        live.firstTokenAt,
      );
      tts.setAttributes({
        'tac.tts.duration_ms': atMs - live.firstTokenAt,
        'tac.turn.ending': effective.ending,
      });
      tts.end(atMs);
    }

    live.span.setAttributes({
      'tac.turn.ttfa_ms': ttfaMs ?? -1,
      'tac.turn.total_ms': atMs - live.promptAt,
      'tac.turn.aborted': effective.aborted,
      'tac.turn.ending': effective.ending,
    });
    live.span.end(atMs);
    return { atMs, ttfaMs, aborted: effective.aborted };
  };

  const complete = (entry: Entry, close: TurnClose): void => {
    const live = entry.live;
    if (live === null) return;
    const closed = closeLive(live, close);
    entry.live = null;
    entry.turns += 1;
    if (closed.aborted) entry.aborted += 1;
    if (closed.ttfaMs !== null) entry.ttfaMs.push(closed.ttfaMs);
    entry.lastBotOutputAt = Math.max(entry.lastBotOutputAt ?? 0, closed.atMs);
  };

  return {
    beginTurn(conversationId, span, atMs) {
      let entry = entries.get(conversationId);
      if (entry === undefined) {
        entry = blank();
        entries.set(conversationId, entry);
      }
      complete(entry, { atMs, aborted: true, ending: 'no-output' });
      entry.live = { span, promptAt: atMs, firstTokenAt: null, recordedClose: null };

      const boundary = entry.lastBotOutputAt;
      if (boundary === null || boundary >= atMs) return null;
      entry.callerTurnMs += atMs - boundary;
      return boundary;
    },

    markFirstToken(conversationId, atMs, ownerSpan) {
      const live = entries.get(conversationId)?.live;
      if (live === undefined || live === null) return;
      if (live.span !== ownerSpan) return;
      if (live.firstTokenAt === null) live.firstTokenAt = atMs;
    },

    liveTurn: (conversationId) => entries.get(conversationId)?.live?.span ?? null,

    recordBoundary(conversationId, close) {
      const entry = entries.get(conversationId);
      const live = entry?.live;
      if (entry === undefined || live === undefined || live === null) return;
      if (live.recordedClose !== null) return;
      live.recordedClose = close;
      entry.lastBotOutputAt = Math.max(entry.lastBotOutputAt ?? 0, Math.max(close.atMs, live.promptAt));
    },

    completeTurn(conversationId, close, ownerSpan) {
      const entry = entries.get(conversationId);
      if (entry === undefined || entry.live === null) return;
      if (entry.live.span !== ownerSpan) return;
      complete(entry, close);
    },

    markBotOutput(conversationId, atMs) {
      const entry = entries.get(conversationId);
      if (entry === undefined) return;
      entry.lastBotOutputAt = Math.max(entry.lastBotOutputAt ?? 0, atMs);
    },

    forget(conversationId) {
      const entry = entries.get(conversationId);
      if (entry === undefined) return undefined;
      complete(entry, { atMs: Date.now(), aborted: true, ending: 'no-output' });
      const stats: Attributes = {
        'tac.turns.count': entry.turns,
        'tac.turns.aborted': entry.aborted,
        'tac.caller_turn.total_ms': entry.callerTurnMs,
      };
      entries.delete(conversationId);
      return stats;
    },
  };
}
```

Three details in there are not stylistic. `recordBoundary` returns early when a boundary is already parked, so the first interrupt wins and a second interrupt frame changes nothing. It also moves `lastBotOutputAt` immediately rather than waiting for the close, so that a next prompt arriving before the straggling handler's `finally` still measures the caller gap from the interrupt instant. And `completeTurn` and `markFirstToken` both take the owning span and compare it by identity against the live turn, because the registry is keyed by conversation id and a handler can outlive the next turn's start. When the scaffold was exercised with two overlapping handlers on one id, the straggler's `finally` closed the wrong turn: the second turn exported at ten milliseconds carrying the first turn's timing, and its own close silently did nothing. The identity check is what makes a late `finally` a no-op instead of corruption.

The wiring side, with the local payload interfaces spelled out because `on` types its callback as accepting any arguments and therefore typechecks nothing at the call site:

```ts
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  ConversationId,
  ConversationSession,
  TACMemoryResponse,
  VoiceChannel,
} from 'twilio-agent-connect';
import { startSpanUnder, withTurnSpan, type ConversationTraceRegistry } from './trace-context.ts';
import type { TurnEnding, VoiceTimeline } from './voice-timeline.ts';

const WS_OPEN = 1;

interface PromptPayload {
  conversationId: ConversationId;
  transcript: string;
  abortSignal: AbortSignal;
  userMemory?: TACMemoryResponse;
  session?: ConversationSession;
}

interface InterruptPayload {
  conversationId: ConversationId;
  utteranceUntilInterrupt: string | undefined;
  durationUntilInterruptMs: number | undefined;
}

export interface AgentTurn {
  readonly tokens: AsyncIterable<string>;
  readonly done: Promise<{ aborted: boolean }>;
}

export interface VoiceAgent {
  runTurn(input: {
    conversationId: string;
    userText: string;
    memory: TACMemoryResponse | null;
    profileId: string | null;
    abortSignal: AbortSignal;
  }): Promise<AgentTurn>;
}

async function* markFirstTokenAt(
  tokens: AsyncIterable<string>,
  onFirstToken: (atMs: number) => void,
): AsyncGenerator<string, void, undefined> {
  let stamped = false;
  for await (const chunk of tokens) {
    if (!stamped && chunk !== '') {
      stamped = true;
      onFirstToken(Date.now());
    }
    yield chunk;
  }
}

export function instrumentVoiceChannel(
  voiceChannel: VoiceChannel,
  agent: VoiceAgent,
  registry: ConversationTraceRegistry,
  timeline: VoiceTimeline,
): void {
  // Returns the promise: the channel's per-conversation prompt queue uses it as the turn
  // boundary, so a fire-and-forget handler lets turn N+1 start while turn N is streaming.
  voiceChannel.on('prompt', (data: PromptPayload): Promise<void> =>
    handleVoicePrompt(data, voiceChannel, agent, registry, timeline));

  voiceChannel.on('interrupt', (data: InterruptPayload) => {
    const interruptAt = Date.now();
    const live = timeline.liveTurn(data.conversationId);
    if (live === null) return;

    const event = startSpanUnder(
      registry.traceparentFor(data.conversationId),
      'tts.interrupted',
      {
        'tac.interrupt.duration_until_interrupt_ms': data.durationUntilInterruptMs ?? -1,
        'tac.interrupt.utterance_chars': data.utteranceUntilInterrupt?.length ?? 0,
      },
      interruptAt,
    );
    event.end(interruptAt);

    timeline.recordBoundary(data.conversationId, {
      atMs: interruptAt,
      aborted: true,
      ending: 'interrupt',
    });
  });

  voiceChannel.on('webSocketDisconnected', (data: { conversationId: ConversationId }) => {
    const stats = timeline.forget(data.conversationId);
    if (stats !== undefined) registry.update(data.conversationId, stats);
    registry.end(data.conversationId);
  });
}

async function handleVoicePrompt(
  data: PromptPayload,
  voiceChannel: VoiceChannel,
  agent: VoiceAgent,
  registry: ConversationTraceRegistry,
  timeline: VoiceTimeline,
): Promise<void> {
  const promptAt = Date.now();
  const { conversationId, transcript, abortSignal } = data;

  registry.sweep();
  const root = registry.ensure(conversationId, 'conversation.voice', { 'tac.channel': 'voice' });

  let boundaryAt: number | null = null;
  let ending: TurnEnding = 'no-output';
  let turnAborted = false;

  await withTurnSpan(
    'turn.voice',
    root.traceparent,
    async (span) => {
      const priorBotOutputAt = timeline.beginTurn(conversationId, span, promptAt);

      try {
        span.setAttributes({
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.conversation.id': conversationId,
          'tac.channel': 'voice',
          'tac.turn.input_chars': transcript.length,
        });

        if (priorBotOutputAt !== null) {
          const gap = startSpanUnder(
            root.traceparent,
            'caller.turn',
            {
              'tac.caller_turn.duration_ms': promptAt - priorBotOutputAt,
              'tac.caller_turn.covers':
                'bot playback + caller speech + ASR endpointing (+ memory recall on turn 1)',
            },
            priorBotOutputAt,
          );
          gap.end(promptAt);
        }

        const asrFinal = startSpanUnder(
          root.traceparent,
          'asr.final',
          { 'tac.asr.transcript_chars': transcript.length },
          promptAt,
        );
        asrFinal.end(promptAt);

        const { tokens, done } = await agent.runTurn({
          conversationId,
          userText: transcript,
          memory: data.userMemory ?? null,
          profileId: data.session?.profileId ?? null,
          abortSignal,
        });

        const spokenPromise = voiceChannel.sendStreamingResponse(
          conversationId,
          markFirstTokenAt(tokens, (atMs) => timeline.markFirstToken(conversationId, atMs, span)),
          { signal: abortSignal },
        );

        let spoken = '';
        try {
          spoken = await spokenPromise;
        } catch {
          spoken = '';
        }

        const markerSent =
          spoken !== '' &&
          !abortSignal.aborted &&
          voiceChannel.getWebsocket(conversationId)?.readyState === WS_OPEN;
        if (markerSent) {
          boundaryAt = Date.now();
          ending = 'last-token';
        }

        const result = await done;
        turnAborted = result.aborted;
        span.setAttribute('tac.turn.output_chars', spoken.length);
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        timeline.completeTurn(
          conversationId,
          { atMs: boundaryAt ?? Date.now(), aborted: turnAborted, ending },
          span,
        );
      }
    },
    { startTimeMs: promptAt, endOnExit: false },
  );
}
```

The `markerSent` condition mirrors the channel's own end-of-turn test, and it has to. `sendStreamingResponse` sends its final `last: true` marker only when the signal is not aborted, at least one token went out, and the socket is still open, and it accumulates each chunk into its return value before writing it to the socket. Both of its loop exits fall through to returning that accumulation, so a barged-in turn returns a non-empty partial string. Checking only for a non-empty return therefore records a normal ending for a marker the channel never sent, which is the bug this three-part condition replaces.

### The abort behaviour that means you can forget to wire an abort and not notice

The streaming send breaks its `for await` when the signal is aborted, and the interrupt handler cancels the stream task and, if any tokens had already gone out, sends the `last: true` finalisation itself before invoking your interrupt callback. I read all of this in the installed bundle. Together they mean your local prompt handler does return on a barge-in even with no abort wiring at all, because the signal the send falls back to when you omit `options.signal` is the active stream task's own controller signal.

That is a comfortable-looking property and it hides a real cost. If you have added a network hop inside the turn, the thing that keeps running is your upstream request, and the risk of an unforwarded abort is a runaway generation you are still paying for rather than a stuck queue you would notice. So forward the signal into your outbound request, not because the local loop needs it, but because nothing else stops the remote side.

### What this instrumentation measured, with the caveats attached

On one real call, the conversation root was fully tiled by alternating caller-gap and turn spans with zero milliseconds between every consecutive pair, across eleven boundaries. That is a single call, a single caller and a single direction, so it demonstrates that the tiling closes rather than establishing a distribution. The caller-gap spans accounted for sixty-five percent of that call, and that figure must never be read as how long the caller talked: the span is a blend of bot audio playback, caller speech, speech-recognition endpointing, and an upstream memory round trip on the first turn. The per-turn token-streaming spans ran between one hundred fifty and eight hundred four milliseconds across the six turns of that same one call, which is what shows the sixty-five percent is not your streaming.

The turn's first-audio proxy landed within zero to three milliseconds of the model's first-token time on all six turns of that call. That is a useful negative and nothing more: it shows nothing queues between the model and the socket, because the send writes each chunk synchronously inside the same loop iteration. It cannot see speech synthesis or the media leg, so do not present it as time to first audio.

If you want a number for what this instrumentation costs, the framework preamble ahead of the model stream measured at most eighty-four milliseconds. That is a ceiling from the worst single turn observed, with the range running from zero to eighty-four across every turn measured on one day with one caller and one model, and it is only meaningful alongside the statement that everything else in a turn is model time. For comparison, a healthy turn with no tool call ran five hundred eighty-six to eight hundred one milliseconds of model time to first chunk, again over a handful of turns on one day with one caller and one model rather than a benchmark.

Layer 5 splits on verification. The timeline is executed: a two-turn simulated conversation ran to completion with exit code 0, one distinct trace id, the first turn closing with a normal ending and the second closing at the parked interrupt boundary rather than at the handler's own instant, and a second parked boundary correctly ignored. The wiring module is typechecked only. It has not been run against a live channel, and I re-verified that `sendStreamingResponse` takes a conversation id, an `AsyncIterable<string>` and an optional object with a `signal`, returning `Promise<string>`, and that `getWebsocket` returns a socket or null, before presenting either call. The barge-in branch of this instrumentation has not been observed on real traffic: both real calls in the record show zero aborted turns and no interrupt event, so the interrupt path is proven by harness and diagnostic rather than by a caller talking over the agent.

## What this leaves you

Two layers are executed and three are compiled, and the split is not arbitrary. The parts I could drive without a phone call, meaning context propagation and the barge-in boundary bookkeeping, are the parts where the failure modes are silent and therefore where running the code actually buys something. The parts that are compiled only, meaning provider registration, callback decoration and tool wrapping, are the parts where a wrong answer announces itself immediately: no spans at all, a callback that stops firing, a tool that throws. Compiling those against the real declared types catches the mistake that would otherwise cost you an afternoon, which is a signature that drifted, and it catches nothing else.

## Citations

- https://github.com/open-telemetry/semantic-conventions-genai
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/manifest.yaml
- https://github.com/open-telemetry/semantic-conventions-genai/pull/518
- https://github.com/open-telemetry/semantic-conventions-genai/pull/495
- https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.44.0
- https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md
- https://opentelemetry.io/docs/specs/otel/context/api-propagators/
- https://www.w3.org/TR/trace-context/
- https://opentelemetry.io/docs/languages/js/context/
- https://nodejs.org/api/cli.html#--importmodule
- https://nodejs.org/api/esm.html
- MessageReadyCallback, InterruptCallback, ConversationEndedCallback, ToolFunction, JSONSchema, TACTool, defineTool, VoiceChannel, ConversationId, ConversationSession, TACMemoryResponse (type and value exports read from the shipped twilio-agent-connect 2.2.0 bundle's dist/index.d.ts)
- VoiceChannel.sendStreamingResponse, VoiceChannel.getWebsocket, VoiceChannel.on, TAC.handleMessageReady, TAC.registerChannel, TAC.setupChannelEventListeners (signatures read from the shipped twilio-agent-connect 2.2.0 bundle)
- VoiceChannel promptQueues, handlePromptMessage, handleInterruptMessage, startStreamTask, cancelStreamTask, completeStreamTask (implementation read from the shipped twilio-agent-connect 2.2.0 bundle's dist/index.js)
- TACTool.implementation, TACTool.toOpenAIFormat, TACTool.toAnthropicFormat, TACTool.toOpenAIAgentsSDKTool (read from the shipped twilio-agent-connect 2.2.0 bundle)

## Unverified

- Layer 1 was never executed. The OTLP exporter package was not a direct dependency of the verification workspace, so the compiler resolved it through a path alias and an attempt to run the file failed at module resolution. The endpoint construction, the header parsing, the batching and the flush-through-the-delegate path are compiled and reasoned, not observed against a collector.
- The claim that a top-of-file import evaluates too late to patch the SDK is reasoning about ECMAScript module evaluation order plus the shipped scaffold's use of a preload for that stated reason. I did not construct an experiment in which a top-of-file import demonstrably misses spans that a preload catches.
- The SIGTERM-versus-beforeExit ordering hazard is transcribed from the scaffold's recorded measurement, not re-measured in this pass. I did not reproduce a shutdown race in which root spans end after provider teardown.
- Layer 2 was typechecked only. Whether the SDK's auto-send actually behaves as the declared string / null / void union suggests when handed each of the three return values was not exercised against a live channel.
- The callback-slot clobbering hazard, meaning that registering a channel takes the error, messageReceived, prompt, interrupt and conversationEnded slots, follows from on() being a setter and from setupChannelEventListeners calling on(). I did not run both registration orderings to observe the silent failure.
- Layer 4 was typechecked only. The tool decorator has never been run with a model runtime dispatching a real tool call, so its timing attribute and its error path are compiled rather than observed.
- The claim that TACTool.implementation is read in exactly two places in the bundle comes from a prior grep of the shipped bundle reported in the research set, and a later independent check found the string 'implementation' in seven places, which is consistent with but does not establish the two-read-sites count. Someone should confirm the two read sites by name.
- The voice wiring module was typechecked only, not run against a live channel. Its signature usage against sendStreamingResponse and getWebsocket was re-verified against the shipped type declarations in this pass.
- The barge-in branch of this instrumentation is unproven on real traffic. Both real calls in the record show zero aborted turns and no interrupt event, so the interrupt path rests on a harness run and a diagnostic. One call in which somebody talks over the agent would close this.
- The measured attribute loss in the naive barge-in version, meaning the dropped output, called-tools list and model-relative total, is transcribed from the scaffold's recorded measurement rather than reproduced here. The underlying mechanism, that setAttribute and setStatus return early after a span ends, is a specified API behaviour I did not re-demonstrate.
- The overlapping-handler corruption that motivates the owner-span identity check is transcribed from a recorded measurement, not reproduced in this pass.
- Every latency figure quoted comes from one day of traffic with one caller and one model, transcribed rather than re-measured. The eighty-four millisecond preamble is a ceiling from a single worst-case turn. The tiling coverage, the sixty-five percent caller-gap share, the per-turn streaming range and the first-audio-proxy agreement all rest on a single call.
- The import paths for the context manager and the propagator were rewritten from transitive paths to package names after confirming both packages export the named symbols. Neither package was a direct dependency of the verification workspace, so a reader installing them fresh is on a path that was not exercised.
- The GenAI semantic conventions were read at a single commit on an untagged development registry with no releases. Every gen_ai attribute used above is badged Development and the registry changed within a day of being read. Re-check the attribute names before publishing, particularly the recently added conversation id on tool spans.
- Whether the first turn's memory retrieval genuinely lands inside the preceding caller-gap span on live traffic was inferred from the bundle's ordering, where the prompt handler awaits retrieval before invoking the application callback, rather than observed in a trace during this pass.
