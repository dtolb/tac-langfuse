import { test, expect } from 'vitest';
import { z } from 'zod';
import { runTurn } from '../server/agent/run-turn.ts';
import { langfusePromptLink, toAiSdkTool, toolChoiceOption } from '../server/agent/model/openai.ts';
import { passthroughMemory } from '../server/agent/memory.ts';
import { createHistory, type HistoryStore } from '../server/agent/history.ts';
import type {
  MemoryComposePort,
  TurnDeps,
  TurnInput,
  TurnResult,
  TurnSpans,
} from '../server/agent/types.ts';
import type { ModelPort, ModelRequest, ModelStreamResult } from '../server/agent/model/port.ts';
import type { PromptPort, ResolvedPrompt } from '../server/agent/prompt/port.ts';
import { createToolCatalog } from '../server/agent/tools/catalog.ts';
import { resolve } from '../server/agent/tools/resolve.ts';
import type { ToolCtx, ToolDef, ToolLogger } from '../server/agent/tools/registry.ts';
import { createObsBus } from '../server/obs/bus.ts';
import type { SpanLike } from '../server/obs/spans.ts';
import type { ObsEvent } from '../shared/events.ts';
import { capabilities, loadConfig } from '../server/config.ts';

/**
 * No mocking library and no snapshots. `TurnDeps` is the seam, so everything below is a hand-built
 * fake — if one of these reaches for `vi.mock`, the seam is wrong.
 *
 * Two things are asserted here that cannot be asserted anywhere else:
 *
 *  1. THE SPAN TREE. `TurnSpans` is injected precisely so this is a unit test. Asserting a real
 *     OpenTelemetry tree would need a registered provider, a `SimpleSpanProcessor` exporting on a
 *     deferred tick, and a read of the exporter before `shutdown()` clears it.
 *  2. TTFT, on an INJECTED CLOCK. A TTFT assertion that tolerates ±50 ms cannot detect the bug it
 *     exists to catch, which is measuring the wrong chunk.
 */

// ------------------------------------------------------------------ fakes

/** A macrotask yield, so pending microtasks settle. Not a sleep — nothing here waits on real time. */
const tick = (): Promise<void> => new Promise((r) => void setImmediate(r));

const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };

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

interface RecordedStep {
  readonly name: string;
  readonly updates: Record<string, unknown>[];
  readonly startSeq: number;
  endSeq: number | null;
}

/**
 * A `TurnSpans` that records the tree instead of emitting it. `startSeq`/`endSeq` come from one
 * counter, which is what makes "these two overlapped" expressible: a step that starts before
 * another ends was concurrent with it.
 */
const recordingSpans = (): {
  spans: TurnSpans;
  steps: readonly RecordedStep[];
  names: () => readonly string[];
  step: (name: string) => RecordedStep;
} => {
  const steps: RecordedStep[] = [];
  let seq = 0;
  const open = (name: string): RecordedStep => {
    const step: RecordedStep = { name, updates: [], startSeq: seq++, endSeq: null };
    steps.push(step);
    return step;
  };
  const spans: TurnSpans = {
    async timeStep(name, fn, describe) {
      const step = open(name);
      try {
        const result = await fn();
        step.updates.push({ output: describe?.(result) ?? {} });
        return result;
      } finally {
        step.endSeq = seq++;
      }
    },
    startStep(name, input) {
      const step = open(name);
      if (input !== undefined) step.updates.push({ input });
      return {
        update: (fields) => void step.updates.push(fields),
        end: () => {
          step.endSeq = seq++;
        },
      };
    },
  };
  return {
    spans,
    steps,
    names: () => steps.map((s) => s.name),
    step: (name) => {
      const found = steps.find((s) => s.name === name);
      if (found === undefined) throw new Error(`no step named ${name}; saw ${steps.map((s) => s.name).join(', ')}`);
      return found;
    },
  };
};

/** The turn span the CALLER owns. `ends` is the assertion that `runTurn` keeps its hands off it. */
const recordingTurnSpan = (): {
  span: SpanLike;
  ends: () => number;
  metadata: () => Record<string, unknown>;
  updates: readonly Record<string, unknown>[];
} => {
  const updates: Record<string, unknown>[] = [];
  let ends = 0;
  return {
    span: {
      update: (fields) => void updates.push(fields),
      end: () => {
        ends += 1;
      },
    },
    ends: () => ends,
    updates,
    // Merged, because `runTurn` updates in two passes: the static facts before the model call and
    // the timings once the stream has drained.
    metadata: () =>
      Object.assign(
        {},
        ...updates.map((u) => (typeof u.metadata === 'object' && u.metadata !== null ? u.metadata : {})),
      ) as Record<string, unknown>,
  };
};

const promptFixture = (over: Partial<ResolvedPrompt> = {}): ResolvedPrompt => ({
  name: 'demo-agent-text',
  version: 2,
  label: 'production',
  messages: [{ role: 'system', content: 'You are {{persona}} for {{company_name}} on {{channel}}.' }],
  config: {
    model: 'gpt-test',
    temperature: 0.4,
    tools: ['lookup_widget'],
    toolChoice: 'auto',
    maxSteps: 4,
  },
  telemetryLink: JSON.stringify({ name: 'demo-agent-text', version: 2, isFallback: false }),
  ...over,
});

const promptPort = (prompt: ResolvedPrompt, gate?: Promise<void>, trace?: string[]): PromptPort => ({
  async get() {
    trace?.push('prompt:start');
    if (gate !== undefined) await gate;
    trace?.push('prompt:end');
    return prompt;
  },
});

const gatedMemory = (gate: Promise<void>, trace: string[]): MemoryComposePort => ({
  async compose() {
    trace.push('memory:start');
    await gate;
    trace.push('memory:end');
    return null;
  },
});

const EMPTY_RESULT: ModelStreamResult = {
  text: '',
  toolCalls: [],
  usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  steps: 1,
};

interface FakeModel {
  readonly port: ModelPort;
  readonly requests: readonly ModelRequest[];
}

/**
 * `deltas` is a generator factory rather than an array so a test can advance the injected clock
 * between chunks, which is how TTFT is pinned to an exact number.
 */
const fakeModel = (opts: {
  readonly deltas?: () => AsyncIterable<string>;
  readonly result?: ModelStreamResult;
  readonly failWith?: Error;
}): FakeModel => {
  const requests: ModelRequest[] = [];
  return {
    requests,
    port: {
      stream(request) {
        requests.push(request);
        const tokens = opts.deltas === undefined ? emptyStream() : opts.deltas();
        const done =
          opts.failWith === undefined
            ? Promise.resolve(opts.result ?? EMPTY_RESULT)
            : Promise.reject<ModelStreamResult>(opts.failWith);
        return { tokens, done };
      },
    },
  };
};

async function* emptyStream(): AsyncIterable<string> {
  // A model that produced no text at all is a legitimate outcome, not an error.
}

async function* streamOf(...deltas: string[]): AsyncIterable<string> {
  for (const d of deltas) yield d;
}

const lookupWidget: ToolDef<z.ZodObject<{ id: z.ZodString }>> = {
  name: 'lookup_widget',
  description: 'Look up a widget by id.',
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ found: true, id }),
};

const fixtureCatalog = createToolCatalog([lookupWidget as ToolDef]);

/** The real T8 resolver over a fixture catalog, so the `unknown` bucket is genuinely exercised. */
const realResolver = (
  bus: ReturnType<typeof createObsBus>,
  catalog = fixtureCatalog,
): TurnDeps['tools'] => (names, turn) =>
  resolve(names, {
    capabilities: capabilities(loadConfig({})),
    catalog,
    logger: silentLogger,
    bus,
    conversationId: turn.conversationId,
    channel: turn.channel,
  });

interface Harness {
  readonly deps: TurnDeps;
  readonly input: TurnInput;
  readonly events: readonly ObsEvent[];
  readonly kinds: () => readonly string[];
  readonly turnSpan: ReturnType<typeof recordingTurnSpan>;
  readonly spans: ReturnType<typeof recordingSpans>;
  readonly abort: AbortController;
}

const harness = (over: {
  readonly prompts?: PromptPort;
  readonly composeMemory?: MemoryComposePort;
  readonly model?: ModelPort;
  readonly now?: () => number;
  readonly catalog?: ReturnType<typeof createToolCatalog>;
  /** Shared between harnesses to drive a SECOND turn of the same conversation. */
  readonly history?: HistoryStore;
  readonly userText?: string;
  readonly conversationId?: string;
} = {}): Harness => {
  const bus = createObsBus();
  const events: ObsEvent[] = [];
  bus.subscribe((e) => void events.push(e));

  const turnSpan = recordingTurnSpan();
  const spans = recordingSpans();
  const abort = new AbortController();

  return {
    events,
    kinds: () => events.map((e) => e.kind),
    turnSpan,
    spans,
    abort,
    deps: {
      prompts: over.prompts ?? promptPort(promptFixture()),
      tools: realResolver(bus, over.catalog ?? fixtureCatalog),
      model: over.model ?? fakeModel({}).port,
      composeMemory: over.composeMemory ?? passthroughMemory,
      obs: bus,
      spans: spans.spans,
      branding: { persona: 'Ada', companyName: 'Northwind Traders' },
      history: over.history ?? createHistory(),
      logger: silentLogger,
      ...(over.now !== undefined && { now: over.now }),
    },
    input: {
      conversationId: over.conversationId ?? 'conv-1',
      channel: 'bench',
      userText: over.userText ?? 'where is order A4721?',
      memory: null,
      sessionMetadata: {},
      profileId: null,
      abortSignal: abort.signal,
      span: turnSpan.span,
    },
  };
};

/**
 * The one invariant that ties the reported durations together: they are all on the TURN origin, so
 * first token cannot land after the response completed.
 *
 * Asserted on EVERY turn this file drives, not in one dedicated test, because the bug it catches is
 * not a wrong number — it is two individually-correct numbers on different origins. `turn.ttft_ms`
 * measured from turn start beside a stream-relative `turn.total_ms` reported "first token at 500 ms,
 * response complete at 360 ms" whenever the preamble outlasted the stream, and every per-number
 * assertion in this file passed while it did.
 */
const expectTimingsMonotonic = (h: Harness, result: TurnResult): void => {
  if (result.ttftMs !== null && result.totalMs !== null) {
    expect(result.ttftMs, `ttftMs ${result.ttftMs} must not exceed totalMs ${result.totalMs}`)
      .toBeLessThanOrEqual(result.totalMs);
  }
  const ttft = h.turnSpan.metadata()['turn.ttft_ms'];
  const total = h.turnSpan.metadata()['turn.total_ms'];
  if (typeof ttft === 'number' && typeof total === 'number') {
    expect(ttft, `turn.ttft_ms ${ttft} must not exceed turn.total_ms ${total}`).toBeLessThanOrEqual(total);
  }
  // ...and the turn brackets the stream it contains.
  const turnEnd = h.events.find((e) => e.kind === 'turn.end')?.durationMs;
  if (typeof total === 'number' && turnEnd !== undefined) expect(total).toBeLessThanOrEqual(turnEnd);
  // ...and the console timeline is monotonic, which is where an operator actually reads the pair.
  const firstToken = h.events.find((e) => e.kind === 'llm.first_token')?.durationMs;
  const response = h.events.find((e) => e.kind === 'llm.response')?.durationMs;
  if (firstToken !== undefined && response !== undefined) {
    expect(firstToken, `llm.first_token at ${firstToken}ms must not follow llm.response at ${response}ms`)
      .toBeLessThanOrEqual(response);
  }
};

/** Drive a whole turn to completion the way a caller does: drain `tokens`, then read `done`. */
const drive = async (h: Harness): Promise<{ text: string; result: TurnResult }> => {
  const { tokens, done } = await runTurn(h.input, h.deps);
  let text = '';
  for await (const delta of tokens) text += delta;
  const result = await done;
  expectTimingsMonotonic(h, result);
  return { text, result };
};

// ------------------------------------------------------------------ 1. the span tree

test('the span tree: named child steps, fetch and recall concurrent, and the turn span is left alone', async () => {
  const h = harness({ model: fakeModel({ deltas: () => streamOf('hello') }).port });
  await drive(h);

  expect(h.spans.names()).toEqual([
    'prompt.fetch',
    'memory.recall',
    'prompt.compose',
    'tools.resolve',
    'llm.stream',
  ]);

  // Concurrency, expressed in the tree: recall began before fetch had ended.
  expect(h.spans.step('memory.recall').startSeq).toBeLessThan(h.spans.step('prompt.fetch').endSeq ?? -1);
  // Sequencing: compose cannot begin until both have finished, and resolve follows compose.
  expect(h.spans.step('prompt.compose').startSeq).toBeGreaterThan(h.spans.step('memory.recall').endSeq ?? -1);
  expect(h.spans.step('tools.resolve').startSeq).toBeGreaterThan(h.spans.step('prompt.compose').endSeq ?? -1);
  // Every child step this function opened, it also closed — including the one it hands to `done`.
  expect(h.spans.steps.filter((s) => s.endSeq === null)).toEqual([]);

  // THE constraint from the brief: `withTurnSpan` ends the turn span when the CALLER's callback
  // settles, so ending it here too is a silent double-end.
  expect(h.turnSpan.ends()).toBe(0);
});

// ------------------------------------------------------------------ 2. ttft on an injected clock

test('ttft is measured at the first NON-EMPTY delta, not at chunk one', async () => {
  // The shape a tool-calling turn actually has: the early chunks carry tool input and produce no
  // audible output. Counting chunk one would report 1000ms for a turn the caller experienced as
  // 1250ms — flattering, and wrong.
  let clock = 0;
  const h = harness({
    now: () => clock,
    model: fakeModel({
      deltas: async function* () {
        clock = 1000;
        yield ''; // tool-input chunk: nothing audible
        clock = 1250;
        yield 'On its ';
        clock = 1400;
        yield 'way.';
        clock = 1500;
      },
      result: { ...EMPTY_RESULT, text: 'On its way.', toolCalls: [{ name: 'lookup_widget', input: { id: 'A4721' } }], steps: 2 },
    }).port,
  });

  const { text, result } = await drive(h);

  expect(text).toBe('On its way.');
  expect(result.ttftMs).toBe(1250);
  expect(result.totalMs).toBe(1500);

  // And it is published the moment it happens, not at the end — the console strip reads this while
  // the call is still in progress.
  const firstToken = h.events.find((e) => e.kind === 'llm.first_token');
  expect(firstToken?.durationMs).toBe(1250);
  expect(h.kinds().indexOf('llm.first_token')).toBeLessThan(h.kinds().indexOf('llm.response'));
});

test('BOTH ttfts are reported, and the turn-relative one includes the work in front of the model', async () => {
  // The number this whole telemetry design exists to produce is the gap between the caller finishing
  // their sentence and the agent starting to speak — so a TTFT that starts at the model call quietly
  // omits the prompt fetch, the recall, the compose and the resolve that all sit inside that gap.
  // Here the prompt port burns 200ms of the injected clock, which a model-relative measurement cannot
  // see at all.
  let clock = 0;
  const slowPrompts: PromptPort = {
    async get() {
      clock = 200;
      return promptFixture();
    },
  };
  const h = harness({
    now: () => clock,
    prompts: slowPrompts,
    model: fakeModel({
      deltas: async function* () {
        clock = 500;
        yield 'Hi';
        clock = 560;
      },
      result: { ...EMPTY_RESULT, text: 'Hi' },
    }).port,
  });

  const { result } = await drive(h);

  // What the caller waited through: 500ms from turn start, of which 300ms was the model.
  expect(result.ttftMs).toBe(500);
  expect(result.modelTtftMs).toBe(300);
  // `totalMs` is on the SAME origin as `ttftMs`, which is the whole point of the pair. Reported
  // stream-relative — 360 — it sat BEFORE a first token at 500, and both numbers were correct.
  expect(result.totalMs).toBe(560);
  expect(result.modelTotalMs).toBe(360);
  // And the invariant itself, stated where the inversion used to be encoded. `drive` asserts it on
  // every turn in this file; repeated here because THIS is the case that violated it.
  expectTimingsMonotonic(h, result);

  expect(h.turnSpan.metadata()['turn.ttft_ms']).toBe(500);
  expect(h.turnSpan.metadata()['turn.ttft_model_ms']).toBe(300);
  expect(h.turnSpan.metadata()['turn.total_ms']).toBe(560);
  expect(h.turnSpan.metadata()['turn.total_model_ms']).toBe(360);
  // The console reads these two as one timeline: "first token at 500ms" then "complete at 360ms" is
  // read as broken instrumentation, and it is the same inversion one layer out.
  expect(h.events.find((e) => e.kind === 'llm.response')?.durationMs).toBe(560);

  // The live console strip reads the caller-experienced number, and both are in the payload so
  // neither has to be recomputed by a reader.
  const firstToken = h.events.find((e) => e.kind === 'llm.first_token');
  expect(firstToken?.durationMs).toBe(500);
  expect(firstToken?.payload).toMatchObject({ ttftMs: 500, modelTtftMs: 300, preambleMs: 200 });
  expect(h.events.find((e) => e.kind === 'turn.end')?.payload).toMatchObject({
    ttftMs: 500,
    modelTtftMs: 300,
  });
});

test('a turn with no text at all reports a null ttft rather than zero', async () => {
  const h = harness({ model: fakeModel({ deltas: () => streamOf('', '') }).port });
  const { result } = await drive(h);
  expect(result.ttftMs).toBeNull();
  expect(h.events.some((e) => e.kind === 'llm.first_token')).toBe(false);
});

// ------------------------------------------------------------------ 3. genuine overlap

test('prompt fetch and memory recall overlap rather than queue', async () => {
  // Proven with controllable deferreds, not a sleep: both must have STARTED before either was
  // allowed to finish. A sequential implementation cannot produce this ordering.
  const trace: string[] = [];
  const promptGate = deferred();
  const memoryGate = deferred();

  const h = harness({
    prompts: promptPort(promptFixture(), promptGate.promise, trace),
    composeMemory: gatedMemory(memoryGate.promise, trace),
    model: fakeModel({ deltas: () => streamOf('ok') }).port,
  });

  const running = drive(h);
  await tick();
  expect(trace).toEqual(['prompt:start', 'memory:start']);

  // Finish them in the reverse order for good measure: nothing downstream may depend on which won.
  memoryGate.resolve();
  promptGate.resolve();
  await running;

  expect(trace).toEqual(['prompt:start', 'memory:start', 'memory:end', 'prompt:end']);
});

// ------------------------------------------------------------------ 4. the turn.* attributes

test('every documented attribute is set on the turn span, under the exact names', async () => {
  // The names matter literally: the operator console and Langfuse filters key on them. They live
  // under `metadata` because @langfuse/tracing drops any other top-level key silently.
  let clock = 0;
  const h = harness({
    now: () => clock,
    model: fakeModel({
      deltas: async function* () {
        clock = 40;
        yield 'Hi';
        clock = 90;
      },
      result: { ...EMPTY_RESULT, text: 'Hi', toolCalls: [{ name: 'lookup_widget', input: { id: 'A1' } }], steps: 2 },
    }).port,
  });

  await drive(h);

  expect(h.turnSpan.metadata()).toEqual({
    'prompt.name': 'demo-agent-text',
    'prompt.version': 2,
    'prompt.label': 'production',
    channel: 'bench',
    model: 'gpt-test',
    'tools.offered': ['lookup_widget'],
    'tools.unknown': [],
    'tools.called': ['lookup_widget'],
    'turn.ttft_ms': 40,
    'turn.ttft_model_ms': 40,
    'turn.total_ms': 90,
    'turn.total_model_ms': 90,
    'turn.aborted': false,
  });
});

test('the turn span carries the prompt-version link, as a first-class key rather than metadata', async () => {
  // `prompt` is a key `createObservationAttributes` recognises, so it becomes
  // `langfuse.observation.prompt.{name,version}` rather than a metadata entry.
  //
  // This asserts OUR half only, and that distinction is real: Langfuse v4's OTel ingestion currently
  // discards prompt name/version for any observation whose type is not GENERATION, so the link does
  // not yet show up on the turn span in the UI. Verified against the live stack — see the comment at
  // the call site in `run-turn.ts`. Do not read a green test here as "the link works end to end".
  const h = harness({ model: fakeModel({ deltas: () => streamOf('ok') }).port });
  await drive(h);

  const linked = h.turnSpan.updates.filter((u) => 'prompt' in u);
  expect(linked).toHaveLength(1);
  expect(linked[0]?.prompt).toEqual({ name: 'demo-agent-text', version: 2, isFallback: false });
});

test('a fallback prompt links to NOTHING: there is no Langfuse version to attribute to', async () => {
  const h = harness({
    prompts: promptPort(promptFixture({ version: 'fallback', label: null, telemetryLink: null })),
    model: fakeModel({ deltas: () => streamOf('ok') }).port,
  });
  await drive(h);

  expect(h.turnSpan.updates.filter((u) => 'prompt' in u)).toEqual([]);
  // Still says WHICH prompt answered, so a degraded turn is visible rather than absent.
  expect(h.turnSpan.metadata()['prompt.version']).toBe('fallback');
});

test('the slot values reach the composed system prompt', async () => {
  const model = fakeModel({ deltas: () => streamOf('ok') });
  const h = harness({ model: model.port });
  await drive(h);

  // No `[[UNKNOWN SLOT]]` / `[[MISSING SLOT]]` marker may survive into what the model is sent: on a
  // phone call `{{persona}}` is inaudible and a marker is the only way anyone notices.
  const system = model.requests[0]?.system ?? '';
  expect(system).toBe('You are Ada for Northwind Traders on bench.');
});

// ------------------------------------------------------------------ 5. a prompt naming a dead tool

test('a prompt version naming an unknown tool still completes the turn, and says so', async () => {
  const model = fakeModel({ deltas: () => streamOf('ok') });
  const h = harness({
    prompts: promptPort(
      promptFixture({
        config: {
          model: 'gpt-test',
          temperature: 0.4,
          tools: ['lookup_widget', 'no_such_tool'],
          toolChoice: 'auto',
          maxSteps: 4,
        },
      }),
    ),
    model: model.port,
  });

  const { result } = await drive(h);

  expect(result.text).toBe('');
  expect(h.turnSpan.metadata()['tools.unknown']).toEqual(['no_such_tool']);
  expect(h.turnSpan.metadata()['tools.offered']).toEqual(['lookup_widget']);
  // The dead name never reaches the model.
  expect(model.requests[0]?.tools.map((t) => t.name)).toEqual(['lookup_widget']);
  expect(h.kinds()).toContain('tool.selection');
  expect(h.kinds()).not.toContain('error');
});

test('a prompt that resolves NO tools does not send a toolChoice the provider would reject', async () => {
  // `tool_choice: required` with an empty tool set is an opaque 400 from OpenAI mid-turn. Asserted
  // at the port, since that is where `runTurn`'s contribution ends.
  const model = fakeModel({ deltas: () => streamOf('ok') });
  const h = harness({
    prompts: promptPort(
      promptFixture({
        config: { model: 'gpt-test', tools: ['no_such_tool'], toolChoice: 'required', maxSteps: 4 },
      }),
    ),
    model: model.port,
  });
  await drive(h);
  expect(model.requests[0]?.tools).toEqual([]);
  expect(model.requests[0]?.toolChoice).toBe('required');
});

// ------------------------------------------------------------------ 6. barge-in

test('an abort mid-stream keeps its partial timings and is not an error', async () => {
  let clock = 0;
  const model: ModelPort = {
    stream: () => ({
      tokens: (async function* () {
        clock = 30;
        yield 'I can see ';
        clock = 55;
        yield 'that order';
        clock = 70;
      })(),
      // ai@7 rejects its result promises with the abort reason when no step completed.
      done: Promise.reject<ModelStreamResult>(new Error('The operation was aborted.')),
    }),
  };
  const h = harness({ now: () => clock, model });

  const { tokens, done } = await runTurn(h.input, h.deps);
  let heard = '';
  for await (const delta of tokens) {
    heard += delta;
    // The caller interrupts: exactly what a barge-in looks like from in here.
    h.abort.abort();
    break;
  }
  const result = await done;

  expect(heard).toBe('I can see ');
  expect(result.aborted).toBe(true);
  expect(result.ttftMs).toBe(30);
  expect(result.totalMs).not.toBeNull();
  expect(h.turnSpan.metadata()['turn.aborted']).toBe(true);
  // A barge-in is normal operation on a phone call, not a fault.
  expect(h.kinds()).not.toContain('error');
  expect(h.kinds()).toContain('turn.end');
});

// ------------------------------------------------------------------ 7. model failure

test('a model failure rejects `done`, publishes an error, and never throws synchronously', async () => {
  const boom = new Error('upstream 503');
  const h = harness({ model: fakeModel({ failWith: boom }).port });

  // The await itself must resolve. A synchronous throw is unhandleable by a voice caller that has
  // already committed to speaking — TAC's `sendResponse` has bitten this repo that way.
  const output = await runTurn(h.input, h.deps);
  expect(typeof output.done.then).toBe('function');

  for await (const _delta of output.tokens) void _delta;
  await expect(output.done).rejects.toThrow('upstream 503');

  const error = h.events.find((e) => e.kind === 'error');
  expect(error?.payload).toMatchObject({ stage: 'model', error: 'upstream 503' });
  // A failed turn still ended: the console tracks turns by that pair.
  expect(h.events.find((e) => e.kind === 'turn.end')?.payload).toMatchObject({ failed: true });
});

test('a failure while preparing the turn rejects, reports the stage, and still ENDS the turn', async () => {
  // `PromptPort` never rejects, but `composeMemory` can, and T13's TAC memory port is the realistic
  // case. The console tracks turns by the `turn.start`/`turn.end` pair, so a path that publishes only
  // `error` leaves a turn open in the UI for the rest of the demo.
  const h = harness({
    composeMemory: {
      compose: () => Promise.reject(new Error('memory service down')),
    },
  });
  await expect(runTurn(h.input, h.deps)).rejects.toThrow('memory service down');

  expect(h.kinds()).toEqual(['turn.start', 'error', 'turn.end']);
  expect(h.events.find((e) => e.kind === 'error')?.payload).toMatchObject({ stage: 'prepare' });
  expect(h.events.find((e) => e.kind === 'turn.end')?.payload).toMatchObject({
    failed: true,
    error: 'memory service down',
  });

  // And the span is attributable. The identity known before the parallel fetch is written before it,
  // so a prepare failure is not a bare `turn.bench` span with no channel, model or prompt on it.
  expect(h.turnSpan.metadata()).toEqual({ channel: 'bench' });
  expect(h.turnSpan.ends()).toBe(0);
});

test('a vendor failure racing a barge-in is DISCARDED — the documented tradeoff, pinned', async () => {
  // Deliberate, and it cuts both ways: the abort branch keys on `abortSignal.aborted`, not on what the
  // rejection says, so a genuine upstream failure that coincides with an interruption is reported as a
  // clean barge-in. On a voice call that is the right trade — the caller is already talking over us, so
  // a spoken error is worse than silence — and the alternative is sniffing vendor abort messages, which
  // breaks on a minor upgrade with nothing to notice. This test exists so changing it is a decision.
  const model: ModelPort = {
    stream: () => ({
      tokens: (async function* () {
        yield 'I can see ';
      })(),
      done: Promise.reject<ModelStreamResult>(new Error('upstream 503')),
    }),
  };
  const h = harness({ model });

  const { tokens, done } = await runTurn(h.input, h.deps);
  for await (const _delta of tokens) {
    void _delta;
    h.abort.abort();
    break;
  }
  // Resolves rather than rejecting: the real 503 is gone.
  const result = await done;

  expect(result.aborted).toBe(true);
  expect(result.text).toBe('');
  expect(result.steps).toBe(0);
  expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  expect(h.kinds()).not.toContain('error');
  expect(h.events.find((e) => e.kind === 'turn.end')?.payload).toMatchObject({ aborted: true });
});

test('a SLOW consumer still gets final timings: the vendor settling first must not cut the drain short', async () => {
  // The other half of the floor above, and the reason it is a floor rather than a deadline. The AI
  // SDK's result promises settle from a TEE'd copy on the MODEL's schedule — here, immediately — while
  // voice drains one chunk at a time behind a TTS handoff. A `done` that gave up waiting as soon as the
  // vendor was finished would report `totalMs: null` on exactly the turns that matter most.
  let clock = 0;
  const h = harness({
    now: () => clock,
    model: fakeModel({
      deltas: async function* () {
        clock = 100;
        yield 'one ';
        clock = 300;
        yield 'two';
        clock = 400;
      },
      result: { ...EMPTY_RESULT, text: 'one two' },
    }).port,
  });

  const { tokens, done } = await runTurn(h.input, h.deps);
  let heard = '';
  for await (const delta of tokens) {
    await tick(); // the handoff a real consumer does between chunks
    heard += delta;
  }
  const result = await done;

  expect(heard).toBe('one two');
  expect(result.ttftMs).toBe(100);
  expect(result.totalMs).toBe(400);
});

test('a caller that never touches `tokens` still ends the llm.stream span', async () => {
  // The sharp edge of `done` waiting on the drain. A caller that decides not to speak at all — a
  // session closed before we got here, a guard that rejects before the loop — used to leave `done`
  // pending forever and `llm.stream` UNENDED, and an unended span never reaches Langfuse AT ALL: a
  // missing observation with no error anywhere to explain it.
  const h = harness({
    model: fakeModel({
      deltas: () => streamOf('never heard'),
      result: { ...EMPTY_RESULT, text: 'never heard' },
    }).port,
  });

  const { done } = await runTurn(h.input, h.deps);
  const result = await done;

  expect(h.spans.step('llm.stream').endSeq).not.toBeNull();
  expect(h.spans.steps.filter((s) => s.endSeq === null)).toEqual([]);
  // The vendor's own result still arrives; the timings are null, which is honest — no token was ever
  // delivered to anyone.
  expect(result.text).toBe('never heard');
  expect(result.ttftMs).toBeNull();
  expect(result.modelTtftMs).toBeNull();
  expect(result.totalMs).toBeNull();
  expect(result.modelTotalMs).toBeNull();
  expect(h.kinds()).toContain('turn.end');
});

test('a caller that AWAITS before its loop still gets timings', async () => {
  // The sharp edge between the two tests above, and the one that is silent. `consuming` is set in the
  // generator BODY, which does not run until the first `next()`, while the race's `settled` branch is
  // registered before `runTurn` returns. So without a macrotask of grace the guarantee rests on the
  // caller's `for await` landing in the same continuation as `await runTurn(...)` resolving: `done`
  // settles early, `llm.stream` ends before the stream drains, and the timings report `null` while the
  // caller goes on to hear the entire answer.
  //
  // MEASURED, because the margin turned out to be one hop: with the grace removed, a single bare
  // `await Promise.resolve()` here still WINS (the caller is one microtask ahead by luck) and two lose.
  // So a `ready()` that awaits anything internally — the realistic shape, and what T13's voice handler
  // will be — is already over the line. Nothing today reaches it; that one-hop margin is the reason to
  // pin it rather than trust it.
  const sessionReady = async (): Promise<void> => {
    await Promise.resolve(); // a warm cache read: no I/O, still enough hops to lose the old race
  };
  let clock = 0;
  const h = harness({
    now: () => clock,
    model: fakeModel({
      deltas: async function* () {
        clock = 120;
        yield 'on its ';
        clock = 180;
        yield 'way';
        clock = 200;
      },
      result: { ...EMPTY_RESULT, text: 'on its way' },
    }).port,
  });

  const { tokens, done } = await runTurn(h.input, h.deps);
  await sessionReady(); // <- the whole test
  let heard = '';
  for await (const delta of tokens) heard += delta;
  const result = await done;

  expect(heard).toBe('on its way');
  expect(result.ttftMs).toBe(120);
  expect(result.totalMs).toBe(200);
  expect(h.turnSpan.metadata()['turn.total_ms']).toBe(200);
  expectTimingsMonotonic(h, result);
  // And the step span still closed exactly once, on the drain rather than ahead of it.
  expect(h.spans.step('llm.stream').endSeq).not.toBeNull();
});

// ------------------------------------------------------------------ 8. the prompt telemetry link

test('the prompt telemetry link is forwarded when a real version was served', async () => {
  const link = JSON.stringify({ name: 'demo-agent-text', version: 7, isFallback: false });
  const model = fakeModel({ deltas: () => streamOf('ok') });
  const h = harness({
    prompts: promptPort(promptFixture({ version: 7, telemetryLink: link })),
    model: model.port,
  });
  await drive(h);

  expect(model.requests[0]?.telemetry.promptLink).toBe(link);
  expect(model.requests[0]?.telemetry.functionId).toBe('turn.bench');
});

test('the key is ABSENT, not null, on a fallback prompt', async () => {
  // A fallback must not claim a version. `null` would be forwarded as a value and normalised into
  // nothing further downstream; absence is the honest signal, and it is what the port documents.
  const model = fakeModel({ deltas: () => streamOf('ok') });
  const h = harness({
    prompts: promptPort(promptFixture({ version: 'fallback', label: null, telemetryLink: null })),
    model: model.port,
  });
  await drive(h);

  const telemetry = model.requests[0]?.telemetry ?? { functionId: '' };
  expect('promptLink' in telemetry).toBe(false);
});

/**
 * The other half of case 8, and the half that fails silently.
 *
 * `@langfuse/vercel-ai-sdk@5`'s `normalizePrompt` requires a PLAIN OBJECT with `name` and `version`.
 * `ChatPromptClient.toJSON()` returns a JSON STRING, so forwarding it verbatim — the ≤v6 recipe —
 * drops the link with no warning anywhere, and the symptom is an empty Metrics tab on the prompt
 * version, which reads as a Langfuse problem rather than as a bug here.
 */
test('langfusePromptLink normalises what Langfuse actually serves', () => {
  expect(langfusePromptLink(JSON.stringify({ name: 'demo-agent-text', version: 2, isFallback: false }))).toEqual({
    name: 'demo-agent-text',
    version: 2,
    isFallback: false,
  });
  expect(langfusePromptLink({ name: 'demo-agent-voice', version: 5 })).toEqual({
    name: 'demo-agent-voice',
    version: 5,
  });
});

test('langfusePromptLink preserves isFallback, because dropping it MISATTRIBUTES', () => {
  // The integration's `normalizePrompt` defaults `isFallback` to `false`, so a link that declared
  // itself a fallback and lost the flag here would be attributed to a real prompt version — the one
  // error mode that corrupts the numbers rather than losing them. Nothing can reach it today (T7 nulls
  // `telemetryLink` on the fallback), which is exactly why it is worth pinning.
  expect(langfusePromptLink(JSON.stringify({ name: 'demo-agent-text', version: 2, isFallback: true }))).toEqual({
    name: 'demo-agent-text',
    version: 2,
    isFallback: true,
  });
  // Absent stays absent rather than becoming an invented `false`: the integration supplies its own
  // default, and an unstated fallback must stay distinguishable from a declared one.
  expect('isFallback' in (langfusePromptLink({ name: 'x', version: 1 }) ?? {})).toBe(false);
});

test('langfusePromptLink returns undefined rather than throwing on anything unusable', () => {
  // A broken link must not be able to end a phone call: a turn with an unlinked trace still answers.
  expect(langfusePromptLink(null)).toBeUndefined();
  expect(langfusePromptLink(undefined)).toBeUndefined();
  expect(langfusePromptLink('not json at all')).toBeUndefined();
  expect(langfusePromptLink(JSON.stringify({ name: 'x' }))).toBeUndefined();
  expect(langfusePromptLink(JSON.stringify({ version: 3 }))).toBeUndefined();
  expect(langfusePromptLink(JSON.stringify({ name: 'x', version: 'two' }))).toBeUndefined();
});

// ------------------------------------------------------------------ the model port's own guards

/**
 * These two cover `model/openai.ts` directly rather than through the port boundary. The turn tests
 * above can only assert what `runTurn` HANDS OVER; what the port then decides — whether to send a
 * `toolChoice` at all, how a `ToolDef` becomes an AI SDK tool — is invisible from there and was
 * otherwise exercised only by the live script.
 */
test('toolChoiceOption omits the key entirely when no tool survived resolution', () => {
  // `tool_choice: required` with an empty tool set is an opaque 400 from OpenAI in the MIDDLE of a
  // call, and a prompt version naming nothing but dead tools is how you get there. Omitted, not
  // `undefined`: the SDK forwards an explicit undefined.
  expect(toolChoiceOption(0, 'required')).toEqual({});
  expect('toolChoice' in toolChoiceOption(0, 'required')).toBe(false);
  expect('toolChoice' in toolChoiceOption(0, 'auto')).toBe(false);
  // With something to choose from, the prompt version's choice is passed through untouched.
  expect(toolChoiceOption(2, 'required')).toEqual({ toolChoice: 'required' });
  expect(toolChoiceOption(1, 'none')).toEqual({ toolChoice: 'none' });
  expect(toolChoiceOption(1, 'auto')).toEqual({ toolChoice: 'auto' });
});

test('toAiSdkTool converts a ToolDef and keeps its execute reachable, with our ctx bound', async () => {
  const seen: ToolCtx[] = [];
  const def: ToolDef<z.ZodObject<{ id: z.ZodString }>> = {
    name: 'lookup_widget',
    description: 'Look up a widget by id.',
    input: z.object({ id: z.string() }),
    execute: async ({ id }, ctx) => {
      seen.push(ctx);
      return { found: true, id };
    },
  };
  const ctx: ToolCtx = { conversationId: 'conv-1', logger: silentLogger };

  const sdkTool = toAiSdkTool(def as ToolDef, ctx);

  expect(sdkTool.description).toBe('Look up a widget by id.');
  // The Zod schema is passed straight through. NOT via `toJsonSchema()`: that projection exists for
  // TAC and the console and drops `additionalProperties: false`, which OpenAI's strict function
  // calling rejects as a mid-turn 400.
  expect(sdkTool.inputSchema).toBe(def.input);

  const output = await sdkTool.execute?.({ id: 'A1' }, { toolCallId: 't1', messages: [], context: undefined });
  expect(output).toEqual({ found: true, id: 'A1' });
  // The ctx is closed over rather than taken from the SDK's options, which is what lets a tool log
  // against the conversation it is running in.
  expect(seen[0]?.conversationId).toBe('conv-1');
});

// ------------------------------------------------------------------ tool execution reporting

/**
 * A model that actually executes the tools it was handed, which is what makes `runTurn`'s
 * instrumentation wrapper observable without an AI SDK in the loop.
 */
const toolCallingModel = (text: string): ModelPort => ({
  stream: (request) => ({
    tokens: (async function* () {
      for (const def of request.tools) {
        try {
          await def.execute({ id: 'A1' }, request.toolCtx);
        } catch {
          // The AI SDK feeds a tool failure back to the model, which then answers anyway.
        }
      }
      yield text;
    })(),
    done: Promise.resolve({ ...EMPTY_RESULT, text, steps: 2 }),
  }),
});

test('a tool that runs is reported on the bus with its own duration', async () => {
  // The clock advances INSIDE the tool body, so the duration the wrapper reports is the tool's own
  // and not the turn's.
  let clock = 10;
  const slow: ToolDef<z.ZodObject<{ id: z.ZodString }>> = {
    name: 'lookup_widget',
    description: 'Look up a widget by id.',
    input: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      clock = 25;
      return { found: true, id };
    },
  };
  const h = harness({
    now: () => clock,
    catalog: createToolCatalog([slow as ToolDef]),
    model: toolCallingModel('It shipped yesterday.'),
  });

  const { result } = await drive(h);
  expect(result.text).toBe('It shipped yesterday.');

  const executions = h.events.filter((e) => e.kind === 'tool.execution');
  expect(executions).toHaveLength(1);
  expect(executions[0]?.summary).toBe('lookup_widget ok');
  expect(executions[0]?.durationMs).toBe(15);
  expect(executions[0]?.payload).toMatchObject({ tool: 'lookup_widget', output: { found: true, id: 'A1' } });
});

test('a tool that throws is a failed EXECUTION, not a failed turn', async () => {
  const failing: ToolDef<z.ZodObject<{ id: z.ZodString }>> = {
    name: 'lookup_widget',
    description: 'Look up a widget by id.',
    input: z.object({ id: z.string() }),
    execute: async () => {
      throw new Error('widget service down');
    },
  };
  const h = harness({
    catalog: createToolCatalog([failing as ToolDef]),
    model: toolCallingModel('Sorry, I could not check that.'),
  });

  const { result } = await drive(h);

  // The turn answered. That is the whole point: a tool outage degrades the answer, it does not end
  // the call.
  expect(result.text).toBe('Sorry, I could not check that.');
  expect(h.events.find((e) => e.kind === 'tool.execution')?.summary).toBe(
    'lookup_widget FAILED: widget service down',
  );
  expect(h.kinds()).not.toContain('error');
});

// ------------------------------------------------------------------ event pairing and vocabulary

test('llm.request and llm.response share a correlationId, and the turn brackets everything', async () => {
  const h = harness({ model: fakeModel({ deltas: () => streamOf('hi') }).port });
  await drive(h);

  expect(h.kinds()).toEqual([
    'turn.start',
    'tool.selection',
    'llm.request',
    'llm.first_token',
    'llm.response',
    'turn.end',
  ]);

  const request = h.events.find((e) => e.kind === 'llm.request');
  const response = h.events.find((e) => e.kind === 'llm.response');
  expect(request?.correlationId).toBeDefined();
  expect(response?.correlationId).toBe(request?.correlationId);
});

test('runTurn does not publish prompt.fetch or tool.selection itself', async () => {
  // T7's prompt port and T8's resolver each publish their own event. Publishing here as well would
  // double every one of them in the console, and the fake prompt port used above publishes neither —
  // which is exactly why `tool.selection` appears (the REAL resolver is injected) and
  // `prompt.fetch` does not.
  const h = harness({ model: fakeModel({ deltas: () => streamOf('hi') }).port });
  await drive(h);
  expect(h.kinds().filter((k) => k === 'prompt.fetch')).toEqual([]);
  expect(h.kinds().filter((k) => k === 'tool.selection')).toHaveLength(1);
});

test('the model request carries the prompt version config verbatim', async () => {
  const model = fakeModel({ deltas: () => streamOf('hi') });
  const h = harness({ model: model.port });
  const { result } = await drive(h);

  const request = model.requests[0];
  expect(request?.model).toBe('gpt-test');
  expect(request?.maxSteps).toBe(4);
  expect(request?.temperature).toBe(0.4);
  expect(request?.toolChoice).toBe('auto');
  expect(request?.messages).toEqual([{ role: 'user', content: 'where is order A4721?' }]);
  expect(request?.toolCtx.conversationId).toBe('conv-1');
  // The caller needs these to attribute the answer; they are the same facts the span carries.
  expect(result.prompt).toEqual({ name: 'demo-agent-text', version: 2, label: 'production' });
  expect(result.model).toBe('gpt-test');
});

test('maxOutputTokens is omitted rather than passed as undefined when the version does not set it', async () => {
  const model = fakeModel({ deltas: () => streamOf('hi') });
  const h = harness({ model: model.port });
  await drive(h);
  expect('maxOutputTokens' in (model.requests[0] ?? {})).toBe(false);
});

// ------------------------------------------------------------------ 12. conversation history

/**
 * The amnesia tests. Every other test in this file drives ONE turn, which is precisely why an
 * amnesiac agent passed all of them: the defect is only observable across two.
 */

test('turn 2 sees turn 1 — and the pair arrives in order, after the few-shot examples', async () => {
  const history = createHistory();

  const first = fakeModel({
    deltas: () => streamOf('Order A4721 ships Tuesday.'),
    result: { ...EMPTY_RESULT, text: 'Order A4721 ships Tuesday.' },
  });
  await drive(harness({ history, model: first.port, userText: 'where is order A4721?' }));

  const second = fakeModel({ deltas: () => streamOf('Tuesday.') });
  await drive(harness({ history, model: second.port, userText: 'when did you say?' }));

  expect(second.requests[0]?.messages).toEqual([
    { role: 'user', content: 'where is order A4721?' },
    { role: 'assistant', content: 'Order A4721 ships Tuesday.' },
    { role: 'user', content: 'when did you say?' },
  ]);
});

test("a turn's own user message is not in its own request twice", async () => {
  // The obvious wrong wiring: append the user message BEFORE reading history, so `composeTurn`
  // appends it a second time. The model then sees the question duplicated, which reads as a
  // stuttering caller and is invisible in any single-turn test.
  const history = createHistory();
  const model = fakeModel({ deltas: () => streamOf('hi') });
  await drive(harness({ history, model: model.port, userText: 'only once please' }));

  const asked = (model.requests[0]?.messages ?? []).filter((m) => m.content === 'only once please');
  expect(asked).toHaveLength(1);
});

test('history is stored per conversation, so a second caller does not inherit the first', async () => {
  const history = createHistory();
  await drive(
    harness({
      history,
      conversationId: 'conv-A',
      userText: 'I am caller A',
      model: fakeModel({ deltas: () => streamOf('hello A'), result: { ...EMPTY_RESULT, text: 'hello A' } }).port,
    }),
  );

  const model = fakeModel({ deltas: () => streamOf('hello B') });
  await drive(harness({ history, conversationId: 'conv-B', userText: 'I am caller B', model: model.port }));

  expect(model.requests[0]?.messages).toEqual([{ role: 'user', content: 'I am caller B' }]);
});

test('a cleared conversation starts over', async () => {
  // T13 calls `clear` from `conversationEnded` and `webSocketDisconnected`. This is the assertion
  // that it actually detaches the transcript rather than only forgetting the id.
  const history = createHistory();
  await drive(
    harness({
      history,
      model: fakeModel({ deltas: () => streamOf('first'), result: { ...EMPTY_RESULT, text: 'first' } }).port,
      userText: 'turn one',
    }),
  );

  history.clear('conv-1');

  const model = fakeModel({ deltas: () => streamOf('fresh') });
  await drive(harness({ history, model: model.port, userText: 'turn two' }));
  expect(model.requests[0]?.messages).toEqual([{ role: 'user', content: 'turn two' }]);
});

test('an aborted turn keeps the words that were actually streamed', async () => {
  // DELIBERATE PRODUCT DECISION, ratified: a barge-in on voice means the caller HEARD the partial
  // sentence, so dropping it would let turn 2 contradict what the room remembers. Note this text
  // cannot come from `TurnResult.text` — ai@7 rejects its result promises on an abort with no
  // completed step, so `runTurn` reports `text: ''` there by design.
  const history = createHistory();
  const abortingHarness = harness({
    history,
    model: fakeModel({
      deltas: async function* () {
        yield 'Your order ships ';
        yield 'on Tues';
      },
      failWith: new Error('aborted'),
    }).port,
    userText: 'when does it ship?',
  });
  abortingHarness.abort.abort();

  const { tokens, done } = await runTurn(abortingHarness.input, abortingHarness.deps);
  for await (const _delta of tokens) void _delta;
  const result = await done;

  expect(result.aborted).toBe(true);
  expect(result.text).toBe(''); // unchanged, pinned behaviour
  expect(history.read('conv-1')).toEqual([
    { role: 'user', content: 'when does it ship?' },
    { role: 'assistant', content: 'Your order ships on Tues' },
  ]);
});

test('an abort before any token records the question but invents no answer', async () => {
  const history = createHistory();
  const h = harness({
    history,
    model: fakeModel({ deltas: () => emptyStream(), failWith: new Error('aborted') }).port,
    userText: 'never answered',
  });
  h.abort.abort();

  const { tokens, done } = await runTurn(h.input, h.deps);
  for await (const _delta of tokens) void _delta;
  await done;

  // An empty assistant message is worse than none: it is a turn the model would be told it took.
  expect(history.read('conv-1')).toEqual([{ role: 'user', content: 'never answered' }]);
});

test('a turn that fails outright leaves history untouched', async () => {
  const history = createHistory();
  const h = harness({
    history,
    model: fakeModel({ failWith: new Error('502 from the provider') }).port,
    userText: 'this will fail',
  });

  const { tokens, done } = await runTurn(h.input, h.deps);
  for await (const _delta of tokens) void _delta;
  await expect(done).rejects.toThrow('502');

  // The caller speaks a fallback line and the human almost always repeats themselves, so recording
  // a question that got no answer would put the same utterance in history twice.
  expect(history.read('conv-1')).toEqual([]);
});

test('history is appended only after the stream has drained', async () => {
  // Appending at the top of the turn would make the store lie for the whole duration of the model
  // call — and on voice that is seconds during which a barge-in could read it.
  const history = createHistory();
  const h = harness({
    history,
    model: fakeModel({ deltas: () => streamOf('an', 'swer'), result: { ...EMPTY_RESULT, text: 'answer' } }).port,
    userText: 'mid-flight check',
  });

  const { tokens, done } = await runTurn(h.input, h.deps);
  const seen: number[] = [];
  for await (const _delta of tokens) seen.push(history.read('conv-1').length);
  await done;

  expect(seen).toEqual([0, 0]); // nothing stored while streaming
  expect(history.read('conv-1')).toHaveLength(2); // both stored once it finished
});

test('the per-conversation cap keeps a long conversation from growing the prompt without bound', async () => {
  const history = createHistory({ maxMessages: 4, maxConversations: 10 });

  for (const q of ['q1', 'q2', 'q3']) {
    await drive(
      harness({
        history,
        userText: q,
        model: fakeModel({ deltas: () => streamOf(`a-${q}`), result: { ...EMPTY_RESULT, text: `a-${q}` } }).port,
      }),
    );
  }

  const model = fakeModel({ deltas: () => streamOf('hi') });
  await drive(harness({ history, model: model.port, userText: 'q4' }));

  // Four remembered messages plus the current question — the oldest exchange has aged out, so the
  // input token count for turn 20 is the same as for turn 4.
  expect(model.requests[0]?.messages).toEqual([
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a-q2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a-q3' },
    { role: 'user', content: 'q4' },
  ]);
});
