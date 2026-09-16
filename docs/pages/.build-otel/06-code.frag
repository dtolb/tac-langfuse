  <!-- ============ 02 THE CODE ============ -->
  <section id="code">
    <h2><span class="num">02</span> <b>Five layers of code</b> &middot; and which of them actually ran</h2>

    <p class="lede-sm">The order matters. Layer 1 must run before anything imports the library, layer 3 is
    the one readers get wrong, and layer 5 exists only because a barge-in closes a turn from a different
    callback than the one that opened it. Two facts govern all five, and both are readable in the shipped
    bundle rather than in any document: the bundle contains no OpenTelemetry code at all, so every span
    below is created by the host application, and the library never invokes a tool, because
    <code>TACTool.implementation</code> is read only in the class constructor and inside the optional
    Agents-SDK adapter's <code>execute</code>.</p>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">What verified means on this page</p>
      <p>Every block below compiled under <code>strict</code>,
      <code>exactOptionalPropertyTypes</code> and <code>noUncheckedIndexedAccess</code>, and the compiler
      was re-run to confirm exit code 0. Compiling is not running. Each layer says which of the two it got,
      and the difference is load-bearing for layers 1, 2 and 4. Two layers are executed and three are
      compiled, and the split is not arbitrary: the parts drivable without a phone call, meaning context
      propagation and the barge-in boundary bookkeeping, are the parts whose failure modes are silent, and
      therefore the parts where running the code buys something. The compiled-only parts, meaning provider
      registration, callback decoration and tool wrapping, are the parts where a wrong answer announces
      itself immediately as no spans at all, a callback that stops firing, or a tool that throws.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Layer 1.
    Exporter and provider, and why registration order beats every other setup question</h3>

    <pre class="wide">import { trace } from '@opentelemetry/api';
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
          process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map((pair) =&gt; {
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

  process.once('beforeExit', () =&gt; {
    void sdk.shutdown().catch(() =&gt; undefined);
  });
}

export async function flushTelemetry(): Promise&lt;void&gt; {
  const provider = trace.getTracerProvider() as {
    getDelegate?: () =&gt; { forceFlush?: () =&gt; Promise&lt;void&gt; };
  };
  await provider.getDelegate?.()?.forceFlush?.();
}</pre>

    <p class="lede-sm">Load this file with <code>node --import ./telemetry.ts ./index.ts</code>, not with an
    <code>import './telemetry.ts'</code> at the top of your entry point. ECMAScript modules hoist and
    evaluate all imports of a module before its body runs, so a top-of-file import still evaluates
    interleaved with the modules it is supposed to have patched first. The preload is the only placement
    that guarantees the provider exists before the library, the AI client and any HTTP instrumentation are
    loaded. This is a property of module evaluation order rather than anything specific to Agent
    Connect.</p>

    <p class="lede-sm">The <code>flushTelemetry</code> shape is not decoration.
    <code>trace.getTracerProvider()</code> returns a <code>ProxyTracerProvider</code>, which has no
    <code>forceFlush</code> of its own, so the natural-looking
    <code>trace.getTracerProvider().forceFlush?.()</code> is an optional call on a method that does not
    exist and therefore a silent no-op. The symptom is an empty backend with no error anywhere, which reads
    as a backend problem. Reaching the delegate is what actually flushes, and it flushes without tearing
    the provider down, so spans ended after the flush still export.</p>

    <p class="lede-sm">Register <code>beforeExit</code> and resist adding a <code>SIGTERM</code> handler
    here. A preload's signal listener runs before the application's own, because Node dispatches listeners
    in registration order, so a <code>SIGTERM</code> handler calling <code>sdk.shutdown()</code> races the
    application's own graceful close. In the scaffold this was measured as a loss: whichever side won, the
    conversation root spans were ended after the provider had been torn down, and a span ended on a dead
    provider is dropped in silence. Flush from the application's shutdown path instead, and order it so the
    roots are ended before the flush rather than after.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Layer 1 was typechecked, not executed</p>
      <p>In the verification workspace <code>@opentelemetry/exporter-trace-otlp-http</code> was not a direct
      dependency; it was present only transitively, so the compiler resolved it through a path alias and an
      attempt to actually run the file failed at module resolution. Install
      <code>@opentelemetry/api</code>, <code>@opentelemetry/sdk-node</code>,
      <code>@opentelemetry/sdk-trace-base</code> and
      <code>@opentelemetry/exporter-trace-otlp-http</code> explicitly before you expect this to boot. Treat
      the endpoint, the batching and the flush path as compiled and reasoned, and prove them against your
      own collector.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Layer 2.
    Decorating the callbacks without touching their return contracts</h3>

    <p class="lede-sm">There are three application-level callbacks and every one of them is a single-slot
    setter rather than a subscription. Registering twice replaces the first registration silently, and
    registering a channel causes the library's own internal forwarders to take the <code>error</code>,
    <code>messageReceived</code>, <code>prompt</code>, <code>interrupt</code> and
    <code>conversationEnded</code> slots. Setting your own listener on one of those five after registering
    a channel therefore stops the corresponding application callback firing at all, with no error. Decide
    once whether the library owns a channel's events or you do.</p>

    <pre class="wide">import { SpanStatusCode } from '@opentelemetry/api';
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
      return async (params) =&gt; {
        registry.sweep();
        const root = registry.ensure(params.conversationId, `conversation.${params.channel}`, {
          'gen_ai.agent.name': agentName,
          'tac.channel': params.channel,
        });

        return withTurnSpan(
          `turn.${params.channel}`,
          root.traceparent,
          async (span) =&gt; {
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
      return async (params) =&gt; {
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
      return async (params) =&gt; {
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
}</pre>

    <p class="lede-sm">The return contract is the whole difficulty of this layer.
    <code>MessageReadyCallback</code> returns
    <code>Promise&lt;string | null | void&gt; | string | null | void</code>, and those three cases mean
    three different things. <code>handleMessageReady</code> checks
    <code>typeof response === 'string'</code> and, when it is, calls the channel's
    <code>sendResponse</code>, which emits one frame with <code>last: true</code>. Return
    <code>null</code> or <code>void</code> and the library sends nothing, which is what you want when your
    own code is streaming tokens back through the channel. So a decorator must pass the inner value through
    untouched and must never normalise <code>void</code> into <code>null</code>. The block above narrows
    with <code>typeof result === 'string'</code> purely to read a length off the string, and returns
    <code>result</code> unchanged on every path.</p>

    <p class="lede-sm">Notice what is missing from the decorator: it does not swallow errors. It cannot
    usefully do so, because the library already catches anything thrown out of these three callbacks and
    only logs it. A throw inside your handler is therefore invisible to the caller and to the transport,
    and if you do not mark the span yourself the failed turn exports as a successful one. The optional
    chain on <code>params.abortSignal</code> is not defensive habit either: on the message-ready callback
    that signal is optional in the declared type, where on the voice prompt payload it is required.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Layer 2 was typechecked, not executed</p>
      <p>The three signatures, including the <code>string | null | void</code> union and the optional
      <code>abortSignal</code>, come from the installed type declarations, and the compiler accepted the
      decorators as drop-in replacements. Whether the library's auto-send behaves as the type suggests when
      handed each of the three return values was not exercised against a live channel.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Layer 3. Context
    propagation, which is a serialised traceparent and not AsyncLocalStorage</h3>

    <p class="lede-sm">This is the layer that decides whether you get one trace per conversation or one
    trace per turn, and the failure mode is quiet enough to survive review. A voice conversation is minutes
    of independent WebSocket frames. There is no async call stack spanning them, so there is no
    <code>AsyncLocalStorage</code> context to hold open across a turn boundary; anything that tries becomes
    a context you have to keep alive for the length of a phone call. The mechanism that works is the W3C
    trace context: start the conversation root, immediately <code>propagation.inject</code> its span
    context into a carrier, keep the resulting <code>traceparent</code> string in a registry keyed by
    conversation id, and rehydrate it with <code>propagation.extract</code> at the start of every turn.
    <code>AsyncLocalStorage</code> still matters, but only inside a turn, where it carries context from
    your handler down into whatever library produces the model spans.</p>

    <pre class="wide">import {
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
  const carrier: Record&lt;string, string&gt; = {};
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

export async function withTurnSpan&lt;T&gt;(
  name: string,
  traceparent: string | undefined,
  fn: (span: Span) =&gt; Promise&lt;T&gt;,
  options: TurnSpanOptions = {},
): Promise&lt;T&gt; {
  const parentCtx = parentContextFrom(traceparent);
  const span = tracer.startSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      ...(options.startTimeMs !== undefined &amp;&amp; { startTime: options.startTimeMs }),
      ...(options.attributes !== undefined &amp;&amp; { attributes: options.attributes }),
    },
    parentCtx,
  );

  try {
    return await context.with(trace.setSpan(parentCtx, span), () =&gt; fn(span));
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
    { kind: SpanKind.INTERNAL, attributes, ...(startTimeMs !== undefined &amp;&amp; { startTime: startTimeMs }) },
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
    { kind: SpanKind.INTERNAL, attributes, ...(startTimeMs !== undefined &amp;&amp; { startTime: startTimeMs }) },
    trace.setSpan(context.active(), parent),
  );
}</pre>

    <p class="lede-sm">The registry that holds the carrier has to be bounded and swept, because neither
    channel gives a reliable end signal for every case. The version below evicts by idle time and by count,
    and ends the root span on the way out so that a conversation which simply stops talking still exports a
    root whose duration covers its children.</p>

    <pre class="wide">interface Entry {
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
  const entries = new Map&lt;string, Entry&gt;();

  const close = (id: string, entry: Entry, attributes: Attributes): void =&gt; {
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
      while (entries.size &gt; maxConversations) {
        const oldest = entries.entries().next();
        if (oldest.done === true) break;
        close(oldest.value[0], oldest.value[1], { 'conversation.closed_because': 'evicted' });
      }
      return started;
    },

    traceparentFor: (conversationId) =&gt; entries.get(conversationId)?.trace.traceparent,

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
        if (nowMs - entry.lastSeenAt &gt; idleTtlMs) {
          close(id, entry, { 'conversation.closed_because': 'idle' });
        }
      }
    },
  };
}</pre>

    <p class="lede-sm">Two design choices there are worth stating because the obvious alternatives fail.
    Keep the carrier in your own registry rather than in the library's session metadata: the session
    survives until the conversation is marked closed upstream, while your registry sweeps on a TTL and ends
    the root span, so reading from session metadata after a sweep rehydrates turn N plus one as a child of
    a root that has already ended and already exported, and the result is a root whose duration does not
    cover its children. And observe that <code>startConversationSpan</code> injects the carrier and then
    deliberately does not hold the root span active, because holding it active for the length of a call is
    exactly the context lifetime you were trying to avoid.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">The failure mode: a trace that looks complete and is not</p>
      <p>Get this layer wrong and you do not get an error. You get spans carrying the right names, the right
      attributes and the right durations, in a viewer that renders each one as a plausible root. Two
      distinct mistakes produce that, and both were measured.</p>
      <p>The first is starting a span from a callback with no ambient context. The interrupt callback is the
      clearest case, because the library dispatches it from its own WebSocket message handler with nothing
      on the stack from your prompt handler. A bare <code>tracer.startSpan</code> there becomes the root of
      a brand new trace, so every barge-in mints a second trace for the same call. In an executed run, one
      conversation that created its root correctly and then started one span the correct way and one span
      the naive way exported two distinct trace ids, with the naive span reported as
      <code>parent=ROOT</code>. The fix is <code>startSpanUnder</code>, which extracts the serialised
      parent explicitly rather than trusting the ambient context.</p>
      <p>The second is a span whose parent was never ended. In the same run a span was started under a
      correctly extracted parent and never ended, and the exporter received three spans; the unended one was
      absent entirely. An unended span does not arrive late and does not arrive as an open interval. It does
      not arrive. That is the trap, because the trace you are looking at is complete for every span you can
      see, and the missing one leaves no trace of its absence.</p>
      <p>A third variant catches people who verify with a test harness. A bare
      <code>BasicTracerProvider</code> with no context manager makes <code>context.with</code> a no-op, so
      the propagation you are testing silently does nothing. When the scaffold's voice telemetry suite was
      first assembled that way, one simulated call reported six trace ids. Install a context manager and a
      propagator in the harness, and assert on the count of distinct trace ids rather than eyeballing the
      shape.</p>
    </div>

    <pre class="wide">import { context, propagation, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());</pre>

    <p class="lede-sm">One more property changes what a turn boundary means. Turn N plus one is chained
    behind turn N: the voice channel keeps a per-conversation promise queue and, on each inbound prompt
    frame, does <code>previousPrompt.then(() =&gt; this.handlePromptMessage(...))</code> before storing the
    resulting promise back under the same conversation id. That was read in the installed bundle and the
    queue map is written in exactly that one place. Your prompt listener's returned promise is therefore
    the turn boundary, so a listener that returns <code>void</code> and starts work in the background lets
    turn N plus one begin while turn N is still streaming and the serialisation evaporates. Any latency you
    add inside the handler is added to the head of the line for the next turn, not just to this one. And
    the instant you record as the start of a turn is a floor rather than the caller's stop, because the
    prompt handler awaits its memory retrieval before invoking your callback.</p>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">Layer 3 was executed</p>
      <p>Both harness programs ran to completion with exit code 0. The correct path produced one distinct
      trace id across a two-turn conversation with every span parented as intended, and the two failure
      modes reproduced as described. The import paths in the harness block are the one thing changed from
      the verified files: the workspace resolved
      <code>@opentelemetry/context-async-hooks</code> and <code>@opentelemetry/core</code> through
      transitive paths because neither was a direct dependency, and they were rewritten to package names
      after confirming both packages export the symbols shown. Install both explicitly.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Layer 4. A tool
    decorator that leaves tool authoring alone</h3>

    <p class="lede-sm">There is no tool middleware to hook. The library exposes no <code>onToolCall</code>,
    no tool context plumbing, and it never calls a tool implementation on the dispatch path at all.
    <code>toOpenAIFormat</code> and <code>toAnthropicFormat</code> emit schema only, so the model runtime
    is what invokes your function. That leaves one clean seam: rebuild each <code>TACTool</code> around its
    own implementation.</p>

    <pre class="wide">import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { TACTool, defineTool, type JSONSchema, type ToolFunction } from 'twilio-agent-connect';
import { tracer } from './trace-context.ts';

export function traceTool&lt;TParams, TResult&gt;(tool: TACTool&lt;TParams, TResult&gt;): TACTool&lt;TParams, TResult&gt; {
  const inner: ToolFunction&lt;TParams, TResult&gt; = tool.implementation;

  const traced: ToolFunction&lt;TParams, TResult&gt; = async (params: TParams): Promise&lt;TResult&gt; =&gt; {
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
      return await context.with(trace.setSpan(context.active(), span), () =&gt; inner(params));
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

  return new TACTool&lt;TParams, TResult&gt;(tool.name, tool.description, tool.parameters, traced);
}

export function defineTracedTool&lt;TParams = unknown, TResult = unknown&gt;(
  name: string,
  description: string,
  parameters: JSONSchema,
  implementation: ToolFunction&lt;TParams, TResult&gt;,
): TACTool&lt;TParams, TResult&gt; {
  return traceTool(defineTool&lt;TParams, TResult&gt;(name, description, parameters, implementation));
}</pre>

    <p class="lede-sm">Nothing about how a tool is authored changes. <code>defineTracedTool</code> has the
    same four-parameter shape as <code>defineTool</code>, so existing definitions swap the factory name and
    are done, and <code>traceTool</code> handles the tools you did not author, since the platform factories
    all return a <code>TACTool</code> and are therefore all wrappable. The generic parameters flow through
    so a typed implementation stays typed.</p>

    <p class="lede-sm">The attribute names come from the GenAI conventions rather than anything
    vendor-specific. <code>execute_tool</code> is the specified span name form, and
    <code>gen_ai.operation.name</code> plus <code>gen_ai.tool.name</code> are its two required attributes,
    with <code>gen_ai.tool.type</code> recommended and <code>function</code> a well-known value. Two
    caveats. You are targeting an untagged development registry that changes week to week. And if you have
    a conversation id available at tool-execution time, <code>gen_ai.conversation.id</code> on a tool span
    became conditionally required only very recently, which is a good illustration of how much of this
    surface is still moving. Set <code>gen_ai.tool.name</code> at span creation rather than afterwards, as
    the block does: the conventions mark the agent name on tool spans as sampling-relevant, meaning a
    sampler may read it, and a sampler runs when the span is created.</p>

    <div class="callout" style="--acc:var(--app)">
      <p class="dtitle">Layer 4 was typechecked, not executed</p>
      <p>The compiler accepted reading <code>tool.implementation</code> and reconstructing the class through
      its public four-argument constructor with the generics preserved. Nothing here has been run against a
      model runtime actually dispatching a tool call, so the timing attribute and the error path are
      compiled rather than observed.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">Layer 5.
    Barge-in, where the span boundary and the span close live in different callbacks</h3>

    <p class="lede-sm">The naive version ends the turn span in the interrupt handler, and it costs you
    exactly the attributes you care about on the one ending that is ordinary operation on a phone call. The
    interrupt handler runs promptly after the stream task is cancelled, while your prompt handler is still
    waiting for its stream to drain, and the attributes describing the turn's result are written after that
    drain completes. Once a span has ended, <code>setAttribute</code> and <code>setStatus</code> return
    early rather than throwing. So the naive version loses the output, the called-tools list and the
    model-relative total duration, and it loses them in silence. In the scaffold this showed up as a
    barged-in turn that exported with no output text and no tool list. Ending the span in your own handler
    rather than letting a wrapper end it also transfers error marking to you: a turn whose prompt fetch
    threw exported with an unset status where the wrapper's own ending had exported an error status with a
    message.</p>

    <p class="lede-sm">The mechanism has three pieces. A registry both callbacks can reach, because the
    interrupt arrives on its own frame and cannot see the prompt handler's closure. An interrupt handler
    that parks a boundary and closes nothing. And a prompt handler whose <code>finally</code> closes the
    span after the drain, preferring the parked boundary if one exists.</p>

    <pre class="wide">import type { Attributes, Span } from '@opentelemetry/api';
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
  const entries = new Map&lt;string, Entry&gt;();

  const blank = (): Entry =&gt; ({
    live: null,
    lastBotOutputAt: null,
    turns: 0,
    aborted: 0,
    callerTurnMs: 0,
    ttfaMs: [],
  });

  const closeLive = (live: LiveTurn, close: TurnClose): { atMs: number; ttfaMs: number | null; aborted: boolean } =&gt; {
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

  const complete = (entry: Entry, close: TurnClose): void =&gt; {
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
      if (boundary === null || boundary &gt;= atMs) return null;
      entry.callerTurnMs += atMs - boundary;
      return boundary;
    },

    markFirstToken(conversationId, atMs, ownerSpan) {
      const live = entries.get(conversationId)?.live;
      if (live === undefined || live === null) return;
      if (live.span !== ownerSpan) return;
      if (live.firstTokenAt === null) live.firstTokenAt = atMs;
    },

    liveTurn: (conversationId) =&gt; entries.get(conversationId)?.live?.span ?? null,

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
}</pre>

    <p class="lede-sm">Three details in there are not stylistic. <code>recordBoundary</code> returns early
    when a boundary is already parked, so the first interrupt wins and a second interrupt frame changes
    nothing. It also moves <code>lastBotOutputAt</code> immediately rather than waiting for the close, so
    that a next prompt arriving before the straggling handler's <code>finally</code> still measures the
    caller gap from the interrupt instant. And <code>completeTurn</code> and <code>markFirstToken</code>
    both take the owning span and compare it by identity against the live turn, because the registry is
    keyed by conversation id and a handler can outlive the next turn's start. When the scaffold was
    exercised with two overlapping handlers on one id, the straggler's <code>finally</code> closed the
    wrong turn: the second turn exported at ten milliseconds carrying the first turn's timing, and its own
    close silently did nothing. The identity check is what makes a late <code>finally</code> a no-op
    instead of corruption.</p>

    <p class="lede-sm">The wiring side follows, with the local payload interfaces spelled out because
    <code>on</code> types its callback as accepting any arguments and therefore typechecks nothing at the
    call site.</p>

    <pre class="wide">import { SpanStatusCode } from '@opentelemetry/api';
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
  readonly tokens: AsyncIterable&lt;string&gt;;
  readonly done: Promise&lt;{ aborted: boolean }&gt;;
}

export interface VoiceAgent {
  runTurn(input: {
    conversationId: string;
    userText: string;
    memory: TACMemoryResponse | null;
    profileId: string | null;
    abortSignal: AbortSignal;
  }): Promise&lt;AgentTurn&gt;;
}

async function* markFirstTokenAt(
  tokens: AsyncIterable&lt;string&gt;,
  onFirstToken: (atMs: number) =&gt; void,
): AsyncGenerator&lt;string, void, undefined&gt; {
  let stamped = false;
  for await (const chunk of tokens) {
    if (!stamped &amp;&amp; chunk !== '') {
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
  <i>// Returns the promise: the channel's per-conversation prompt queue uses it as the turn</i>
  <i>// boundary, so a fire-and-forget handler lets turn N+1 start while turn N is streaming.</i>
  voiceChannel.on('prompt', (data: PromptPayload): Promise&lt;void&gt; =&gt;
    handleVoicePrompt(data, voiceChannel, agent, registry, timeline));

  voiceChannel.on('interrupt', (data: InterruptPayload) =&gt; {
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

  voiceChannel.on('webSocketDisconnected', (data: { conversationId: ConversationId }) =&gt; {
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
): Promise&lt;void&gt; {
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
    async (span) =&gt; {
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
          markFirstTokenAt(tokens, (atMs) =&gt; timeline.markFirstToken(conversationId, atMs, span)),
          { signal: abortSignal },
        );

        let spoken = '';
        try {
          spoken = await spokenPromise;
        } catch {
          spoken = '';
        }

        const markerSent =
          spoken !== '' &amp;&amp;
          !abortSignal.aborted &amp;&amp;
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
}</pre>

    <p class="lede-sm">The <code>markerSent</code> condition mirrors the channel's own end-of-turn test,
    and it has to. <code>sendStreamingResponse</code> sends its final <code>last: true</code> marker only
    when the signal is not aborted, at least one token went out, and the socket is still open, and it
    accumulates each chunk into its return value before writing it to the socket. Both of its loop exits
    fall through to returning that accumulation, so a barged-in turn returns a non-empty partial string.
    Checking only for a non-empty return therefore records a normal ending for a marker the channel never
    sent, which is the bug this three-part condition replaces.</p>

    <div class="callout" style="--acc:var(--plat)">
      <p class="dtitle">The abort behaviour that means you can forget to wire an abort and not notice</p>
      <p>The streaming send breaks its <code>for await</code> when the signal is aborted, and the interrupt
      handler cancels the stream task and, if any tokens had already gone out, sends the
      <code>last: true</code> finalisation itself before invoking your interrupt callback. All of that was
      read in the installed bundle. Together they mean your local prompt handler does return on a barge-in
      even with no abort wiring at all, because the signal the send falls back to when you omit
      <code>options.signal</code> is the active stream task's own controller signal.</p>
      <p>That is a comfortable-looking property and it hides a real cost. If you have added a network hop
      inside the turn, the thing that keeps running is your upstream request, and the risk of an
      unforwarded abort is a runaway generation you are still paying for rather than a stuck queue you
      would notice. Forward the signal into your outbound request, not because the local loop needs it, but
      because nothing else stops the remote side.</p>
    </div>

    <div class="callout" style="--acc:var(--obs)">
      <p class="dtitle">Layer 5 splits on verification</p>
      <p>The timeline is executed. A two-turn simulated conversation ran to completion with exit code 0,
      one distinct trace id, the first turn closing with a normal ending and the second closing at the
      parked interrupt boundary rather than at the handler's own instant, and a second parked boundary
      correctly ignored.</p>
      <p>The wiring module is typechecked only. It has not been run against a live channel. The signatures
      of <code>sendStreamingResponse</code> and <code>getWebsocket</code> were re-verified against the
      shipped type declarations before either call was presented. <b class="warn">The barge-in branch has
      not been observed on real traffic:</b> both real calls in the record show zero aborted turns and no
      interrupt event, so the interrupt path is proven by harness and diagnostic rather than by a caller
      talking over the agent.</p>
    </div>

    <h3 style="font-family:var(--display);font-size:19px;font-weight:600;margin:34px 0 8px">What this
    instrumentation measured, with the caveats attached</h3>

    <p class="lede-sm">On one real call the conversation root was fully tiled by alternating caller-gap and
    turn spans with zero milliseconds between every consecutive pair, across eleven boundaries. That is a
    single call, a single caller and a single direction, so it demonstrates that the tiling closes rather
    than establishing a distribution. The caller-gap spans accounted for 65 percent of that call, and that
    figure must never be read as how long the caller talked. The per-turn token-streaming spans ran between
    150 and 804 milliseconds across the six turns of that same one call, which is what shows the 65 percent
    is not your streaming. The first-audio proxy landed within zero to three milliseconds of the model's
    first-token time on all six turns.</p>

    <p class="lede-sm">If you want a number for what this instrumentation costs, the framework preamble
    ahead of the model stream measured at most 84 milliseconds. That is a ceiling from the worst single
    turn observed, with the range running from 0 to 84 across every turn measured on one day with one
    caller and one model, and it is only meaningful alongside the statement that everything else in a turn
    is model time. For comparison, a healthy turn with no tool call ran 586 to 801 milliseconds of model
    time to first chunk, again over a handful of turns on one day with one caller and one model rather than
    a benchmark. The full latency waterfall and the twelve-row component table are on
    <a href="https://pages-4296.twil.io/agent-scaffold-architecture">agent-scaffold-architecture</a>.</p>
  </section>
