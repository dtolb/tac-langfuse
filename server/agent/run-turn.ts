/**
 * `runTurn` — the agent. One channel-agnostic function; voice, SMS and the bench harness all call
 * it and only the ports differ. There is no framework agent object above this.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHO OWNS THE TURN SPAN: THE CALLER. `runTurn` NEVER CREATES IT AND NEVER ENDS IT.
 *
 * This is forced, not a preference. `withTurnSpan(name, traceparent, fn)` ends the observation when
 * `fn` settles, and `runTurn` returns `{tokens, done}` for the caller to drain AFTERWARDS. A turn
 * span created in here would therefore close before the model had streamed a single token, and
 * every AI SDK span (`invoke_agent <model>`, `step N`, `chat <model>`) would land outside it.
 *
 * So the caller — `routes-bench.ts` at T11, the voice handler at T13 — calls `withTurnSpan(...)` and
 * does EVERYTHING inside that callback, including awaiting the send of the response. `runTurn`
 * receives the resulting `SpanLike` on `TurnInput.span`, writes attributes onto it, and creates its
 * own child steps through the injected `TurnSpans`, which nest correctly because they pick up the
 * ambient OpenTelemetry context. Calling `span.end()` here would be a silent double-end.
 *
 * The symptom of getting this wrong is a waterfall where the model call sits outside its own turn,
 * which reads as broken instrumentation rather than as misuse.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ZERO vendor imports: not `ai`, not `twilio-agent-connect`, not `@langfuse/client`.
 * `tests/architecture.test.ts` enforces it statically and the bench harness proves it at run time.
 */
import { randomUUID } from 'node:crypto';
import { childLogger } from '../logging.ts';
import { withFirstTokenMark } from '../obs/first-token.ts';
import type { SpanLike } from '../obs/spans.ts';
import { CHANNEL_PROMPT } from './prompt/defaults.ts';
import type { ResolvedPrompt } from './prompt/port.ts';
import { compose, type Slots } from './prompt/slots.ts';
import type { ToolCtx, ToolDef, ToolLogger } from './tools/registry.ts';
import type { ModelRequest, ModelStreamResult } from './model/port.ts';
import type {
  TurnBranding,
  TurnDeps,
  TurnInput,
  TurnMessage,
  TurnOutput,
  TurnResult,
  TurnUsage,
} from './types.ts';

const log = childLogger('turn');

/** Enough of the utterance to recognise the turn in a console list; not the whole transcript. */
const PREVIEW_CHARS = 80;
const preview = (text: string): string =>
  text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The date the model is told. Fixed locale and explicit UTC, so one epoch renders one string on any
 * host — a date that shifts with the container's TZ is a support call nobody can reproduce. The
 * format matches what `scripts/verify-prompts.ts` established ("Thursday 10 September 2026").
 */
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const EMPTY_USAGE: TurnUsage = { inputTokens: null, outputTokens: null, totalTokens: null };

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
};

interface ComposedTurn {
  readonly system: string;
  readonly messages: readonly TurnMessage[];
}

/**
 * Slot substitution, then the split into `system` + `messages` the model port wants.
 *
 * A Langfuse chat prompt may carry more than one `system` message and may carry few-shot
 * user/assistant pairs; those keep their order and lead the conversation. Folded memory is appended
 * to the system text rather than injected as a message, so it cannot be mistaken for something the
 * caller said.
 */
function composeTurn(
  prompt: ResolvedPrompt,
  slots: Slots,
  memoryContext: string | null,
  userText: string,
): ComposedTurn {
  const composed = compose(prompt.messages, slots);

  const systemParts = composed.filter((m) => m.role === 'system').map((m) => m.content);
  if (memoryContext !== null && memoryContext !== '') systemParts.push(memoryContext);

  const examples: TurnMessage[] = composed
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    system: systemParts.join('\n\n'),
    messages: [...examples, { role: 'user', content: userText }],
  };
}

const slotsFor = (branding: TurnBranding, input: TurnInput, atMs: number): Slots => ({
  persona: branding.persona,
  company_name: branding.companyName,
  channel: input.channel,
  current_date: DATE_FORMAT.format(new Date(atMs)),
});

/**
 * Drive one turn.
 *
 * Never throws synchronously — it is `async`, so every failure is a rejection the caller can turn
 * into a spoken fallback line. That matters: silence on a voice call is a confirmed dead-air bug
 * that a previous demo shipped and then fixed, and this repo has already been bitten by TAC's
 * `sendResponse` throwing synchronously.
 */
export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnOutput> {
  const now = deps.now ?? Date.now;
  const logger: ToolLogger = deps.logger ?? log;
  const { channel, conversationId, span } = input;
  const startedAt = now();
  const correlationId = randomUUID();

  const fail = (err: unknown, stage: string): void => {
    deps.obs.publish({
      kind: 'error',
      summary: `turn failed at ${stage}: ${errorMessage(err)}`,
      channel,
      conversationId,
      correlationId,
      payload: { stage, error: errorMessage(err) },
    });
    logger.error({ err, stage, conversationId, channel }, `turn: failed at ${stage}`);
  };

  deps.obs.publish({
    kind: 'turn.start',
    summary: `${channel}: ${preview(input.userText)}`,
    channel,
    conversationId,
    payload: {
      userText: input.userText,
      profileId: input.profileId,
      hasMemory: input.memory !== null,
    },
  });

  // Only what `done` still needs once this function has returned is hoisted out of the try.
  let prompt: ResolvedPrompt;
  let streamed: { tokens: AsyncIterable<string>; done: Promise<ModelStreamResult> };
  let llmSpan: SpanLike | null = null;

  try {
    // ---- 1. prompt fetch and memory recall, genuinely concurrent ----
    // Independent, and both sit in front of the first spoken word on a live call, so they overlap
    // rather than queue. Each gets its own timed step so the two are separately visible in the
    // waterfall. Neither publishes an obs event from here: T7's prompt port publishes `prompt.fetch`
    // itself and T13's TAC memory port will publish `memory.recall` the same way — the port that
    // does the work owns its event, this function owns the span.
    const [fetched, memoryContext] = await Promise.all([
      deps.spans.timeStep(
        'prompt.fetch',
        () => deps.prompts.get(CHANNEL_PROMPT[channel]),
        (p) => ({ name: p.name, version: p.version, label: p.label }),
      ),
      deps.spans.timeStep(
        'memory.recall',
        () => deps.composeMemory.compose({ memory: input.memory, conversationId, channel }),
        (m) => ({ chars: m === null ? 0 : m.length }),
      ),
    ]);
    prompt = fetched;

    // ---- 2. compose the system prompt ----
    const composed = await deps.spans.timeStep(
      'prompt.compose',
      async () => composeTurn(prompt, slotsFor(deps.branding, input, startedAt), memoryContext, input.userText),
      (c) => ({ systemChars: c.system.length, messages: c.messages.length }),
    );

    // ---- 3. resolve the tool names this prompt version asked for ----
    const resolution = await deps.spans.timeStep(
      'tools.resolve',
      async () => deps.tools(prompt.config.tools, { conversationId, channel }),
      (r) => ({
        resolved: r.resolved.map((t) => t.name),
        unknown: r.unknown,
        unavailable: r.unavailable,
      }),
    );
    const offered = resolution.resolved;

    // Attributes go under `metadata`, NOT at the top level, and that is forced. @langfuse/tracing's
    // `createObservationAttributes` destructures a fixed set of keys (input, output, metadata, level,
    // statusMessage, version, environment) and drops every other key — silently. A top-level
    // `'prompt.version'` never reaches the OTel span and never reaches Langfuse, with no error
    // anywhere. Metadata keys land as `langfuse.observation.metadata.<key>`, so the names below are
    // what the operator console and Langfuse filters actually see.
    //
    // `tools.unknown` is the one that matters beyond debugging: it is how a prompt version naming a
    // dead tool shows up in that version's Metrics tab rather than only in a log line.
    span.update({
      input: { userText: input.userText },
      metadata: {
        'prompt.name': prompt.name,
        'prompt.version': prompt.version,
        'prompt.label': prompt.label,
        channel,
        model: prompt.config.model,
        'tools.offered': offered.map((t) => t.name),
        'tools.unknown': resolution.unknown,
      },
    });

    // ---- 4. the model call ----
    const toolCtx: ToolCtx = { conversationId, logger };
    const request: ModelRequest = {
      model: prompt.config.model,
      system: composed.system,
      messages: composed.messages,
      tools: offered.map((def) => instrument(def, deps, input, now)),
      toolChoice: prompt.config.toolChoice,
      maxSteps: prompt.config.maxSteps,
      ...(prompt.config.temperature !== undefined && { temperature: prompt.config.temperature }),
      ...(prompt.config.maxOutputTokens !== undefined && {
        maxOutputTokens: prompt.config.maxOutputTokens,
      }),
      abortSignal: input.abortSignal,
      toolCtx,
      telemetry: {
        // One id per channel, so voice and SMS are separable in Langfuse.
        functionId: `turn.${channel}`,
        // Omitted entirely on the compiled fallback: a fallback must not claim a prompt version.
        ...(prompt.telemetryLink !== null && { promptLink: prompt.telemetryLink }),
      },
    };

    deps.obs.publish({
      kind: 'llm.request',
      summary: `${prompt.config.model}, ${offered.length} tool(s), maxSteps ${prompt.config.maxSteps}`,
      channel,
      conversationId,
      correlationId,
      payload: {
        model: prompt.config.model,
        promptVersion: prompt.version,
        tools: offered.map((t) => t.name),
        toolChoice: prompt.config.toolChoice,
        maxSteps: prompt.config.maxSteps,
        systemChars: composed.system.length,
      },
    });
    // Started here, not earlier: this step must cover the model call and the drain of its stream,
    // not the prompt fetch in front of them. Its `end()` is owned by `done` below — the one place
    // `startStep` earns its place in `TurnSpans` over `timeStep`, because the step outlives the call
    // that created it.
    llmSpan = deps.spans.startStep('llm.stream', {
      model: prompt.config.model,
      tools: offered.map((t) => t.name),
    });

    streamed = deps.model.stream(request);
  } catch (err) {
    fail(err, 'prepare');
    llmSpan?.update({ level: 'ERROR', statusMessage: errorMessage(err) });
    llmSpan?.end();
    throw err;
  }
  const stepSpan = llmSpan;

  /**
   * Handlers attached NOW, synchronously, and folded into a never-rejecting result.
   *
   * The vendor's `done` can reject at any point while our consumer is still draining `tokens`, and
   * `done` below does not await it until the drain finishes. An unhandled rejection in that window
   * terminates the process by Node's default — dead air on a live call, from the error-reporting
   * path itself.
   */
  const settled = streamed.done.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const { stream: marked, marks } = withFirstTokenMark(
    streamed.tokens,
    (elapsedMs) => {
      // Published the MOMENT it happens rather than at the end: the live console strip exists to
      // show this number while the call is still in progress.
      deps.obs.publish({
        kind: 'llm.first_token',
        summary: `first token in ${elapsedMs}ms`,
        channel,
        conversationId,
        correlationId,
        durationMs: elapsedMs,
      });
      span.update({ metadata: { 'turn.ttft_ms': elapsedMs } });
    },
    now,
  );

  // One more generator around the marked stream, and it is load-bearing. `marks` is mutated as the
  // stream drains — `totalMs` is written in `withFirstTokenMark`'s own `finally` — while the AI SDK
  // settles its result promises from a TEE'd copy on the model's schedule (`consumeStream()` in
  // ai/dist/index.js). So the vendor's `done` can resolve while our consumer is still draining, and
  // a `done` gated only on the vendor would read `totalMs: null` on a fast turn. This `finally` runs
  // after the inner one, so by the time `done` reads `marks` they are final. It also fires when the
  // consumer breaks out mid-stream, which is what a voice barge-in looks like from in here.
  const drained = deferred();
  async function* observed(): AsyncIterable<string> {
    try {
      yield* marked;
    } finally {
      drained.resolve();
    }
  }

  const done: Promise<TurnResult> = (async (): Promise<TurnResult> => {
    // The drain first, then the model's own outcome — see the comment on `observed` for why the
    // order matters to the timings.
    await drained.promise;
    const outcome = await settled;

    let result: ModelStreamResult;
    if (outcome.ok) {
      result = outcome.value;
    } else if (input.abortSignal.aborted) {
      // ai@7 rejects its result promises with the abort reason when no step completed. A barge-in is
      // normal operation on a phone call, so it must NOT surface as an error event — and
      // `withFirstTokenMark` already kept the partial timings in its `finally` for exactly this.
      logger.debug({ conversationId, channel }, 'turn: aborted mid-stream');
      result = { text: '', toolCalls: [], usage: EMPTY_USAGE, steps: 0 };
    } else {
      fail(outcome.error, 'model');
      stepSpan.update({ level: 'ERROR', statusMessage: errorMessage(outcome.error) });
      stepSpan.end();
      deps.obs.publish({
        kind: 'turn.end',
        summary: `${channel} turn failed after ${now() - startedAt}ms`,
        channel,
        conversationId,
        durationMs: now() - startedAt,
        payload: { failed: true, error: errorMessage(outcome.error) },
      });
      throw outcome.error;
    }

    const aborted = input.abortSignal.aborted;
    const called = [...new Set(result.toolCalls.map((c) => c.name))];

    span.update({
      output: { text: result.text, toolCalls: called },
      metadata: {
        'tools.called': called,
        'turn.ttft_ms': marks.ttftMs,
        'turn.total_ms': marks.totalMs,
        'turn.aborted': aborted,
      },
    });
    stepSpan.update({
      output: { chars: marks.chars, deltas: marks.deltas, steps: result.steps },
      metadata: { ttftMs: marks.ttftMs, totalMs: marks.totalMs, aborted },
    });
    stepSpan.end();

    deps.obs.publish({
      kind: 'llm.response',
      summary: `${result.steps} step(s), ${called.length} tool call(s), ${marks.chars} chars${aborted ? ' (aborted)' : ''}`,
      channel,
      conversationId,
      correlationId,
      ...(marks.totalMs !== null && { durationMs: marks.totalMs }),
      payload: {
        text: result.text,
        toolCalls: result.toolCalls.map((c) => c.name),
        usage: result.usage,
        steps: result.steps,
        ttftMs: marks.ttftMs,
        aborted,
      },
    });
    deps.obs.publish({
      kind: 'turn.end',
      summary: `${channel} turn in ${now() - startedAt}ms (ttft ${marks.ttftMs ?? '-'}ms)${aborted ? ', aborted' : ''}`,
      channel,
      conversationId,
      durationMs: now() - startedAt,
      payload: { ttftMs: marks.ttftMs, totalMs: marks.totalMs, aborted, steps: result.steps },
    });

    return {
      text: result.text,
      toolCalls: result.toolCalls,
      usage: result.usage,
      steps: result.steps,
      ttftMs: marks.ttftMs,
      totalMs: marks.totalMs,
      aborted,
      prompt: { name: prompt.name, version: prompt.version, label: prompt.label },
      model: prompt.config.model,
    };
  })();

  // Marks `done` as handled without swallowing it: the caller awaiting `done` still receives the
  // rejection, but Node no longer sees an unhandled one. That matters more than it looks — Node's
  // default for an unhandled rejection is to terminate the process, which on a live call is the
  // dead-air failure this whole file is written to avoid. The AI SDK does the same thing internally
  // (`markPromiseAsHandled`).
  void done.catch(() => {});

  return { tokens: observed(), done };
}

/**
 * A `ToolDef` that reports its own execution on the obs bus.
 *
 * Wrapped here rather than in `model/openai.ts` so `tool.execution` — with a real duration — stays
 * vendor-neutral and unit-testable against a fake model port.
 *
 * A tool that throws is published as a FAILED execution, not as an `error` event: the AI SDK feeds
 * the failure back to the model, which usually apologises and carries on, so the turn has not
 * failed. `error` is reserved for a turn that cannot answer at all.
 */
function instrument(
  def: ToolDef,
  deps: TurnDeps,
  input: TurnInput,
  now: () => number,
): ToolDef {
  const name = def.name;
  return {
    name,
    description: def.description,
    input: def.input,
    ...(def.requires !== undefined && { requires: def.requires }),
    async execute(args, ctx) {
      const at = now();
      try {
        const output = await def.execute(args, ctx);
        deps.obs.publish({
          kind: 'tool.execution',
          summary: `${name} ok`,
          channel: input.channel,
          conversationId: input.conversationId,
          durationMs: now() - at,
          payload: { tool: name, args, output },
        });
        return output;
      } catch (err) {
        deps.obs.publish({
          kind: 'tool.execution',
          summary: `${name} FAILED: ${errorMessage(err)}`,
          channel: input.channel,
          conversationId: input.conversationId,
          durationMs: now() - at,
          payload: { tool: name, args, error: errorMessage(err) },
        });
        throw err;
      }
    },
  };
}
