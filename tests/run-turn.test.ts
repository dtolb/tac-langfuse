import { test, expect } from 'vitest';
import { z } from 'zod';
import { runTurn } from '../server/agent/run-turn.ts';
import { langfusePromptLink } from '../server/agent/model/openai.ts';
import { passthroughMemory } from '../server/agent/memory.ts';
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
import type { ToolDef, ToolLogger } from '../server/agent/tools/registry.ts';
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
      logger: silentLogger,
      ...(over.now !== undefined && { now: over.now }),
    },
    input: {
      conversationId: 'conv-1',
      channel: 'bench',
      userText: 'where is order A4721?',
      memory: null,
      sessionMetadata: {},
      profileId: null,
      abortSignal: abort.signal,
      span: turnSpan.span,
    },
  };
};

/** Drive a whole turn to completion the way a caller does: drain `tokens`, then read `done`. */
const drive = async (h: Harness): Promise<{ text: string; result: TurnResult }> => {
  const { tokens, done } = await runTurn(h.input, h.deps);
  let text = '';
  for await (const delta of tokens) text += delta;
  return { text, result: await done };
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
    'turn.total_ms': 90,
    'turn.aborted': false,
  });
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

test('a failure while preparing the turn rejects the returned promise and reports the stage', async () => {
  const h = harness({
    composeMemory: {
      compose: () => Promise.reject(new Error('memory service down')),
    },
  });
  await expect(runTurn(h.input, h.deps)).rejects.toThrow('memory service down');
  expect(h.events.find((e) => e.kind === 'error')?.payload).toMatchObject({ stage: 'prepare' });
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
  });
  expect(langfusePromptLink({ name: 'demo-agent-voice', version: 5 })).toEqual({
    name: 'demo-agent-voice',
    version: 5,
  });
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
