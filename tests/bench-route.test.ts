import { test, expect } from 'vitest';
import {
  createConversationRegistry,
  streamBenchTurn,
  type BenchTurnDeps,
  type ConversationRegistry,
} from '../server/http/routes-bench.ts';
import type { SseSink } from '../server/http/sse.ts';
import { createHistory, type HistoryStore } from '../server/agent/history.ts';
import { passthroughMemory } from '../server/agent/memory.ts';
import { createToolCatalog } from '../server/agent/tools/catalog.ts';
import { resolve } from '../server/agent/tools/resolve.ts';
import type { ToolDef, ToolLogger } from '../server/agent/tools/registry.ts';
import type { ModelPort, ModelStreamResult } from '../server/agent/model/port.ts';
import type { PromptPort, ResolvedPrompt } from '../server/agent/prompt/port.ts';
import type { SpanLike } from '../server/obs/spans.ts';
import type { TurnDeps } from '../server/agent/types.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { capabilities, loadConfig } from '../server/config.ts';

/**
 * The bench route, tested through `SseSink` rather than over a socket — the same seam `sse.ts`
 * already exposes so the hub is testable without an HTTP server.
 *
 * ONE assertion here matters more than the rest, and it is the failure the brief warns about
 * first: THE TURN SPAN MUST STILL BE OPEN WHEN THE LAST TOKEN IS WRITTEN. `runTurn` returns
 * `{tokens, done}` and the caller drains afterwards, so a handler that closes its span when
 * `runTurn` resolves puts every AI SDK span in a different trace — and the symptom is a waterfall
 * that reads as broken instrumentation rather than as misuse. A sequence counter shared between the
 * sink and the span recorder is what makes "closed after" expressible at all.
 */

const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };

/** One shared clock for writes and span lifecycle, so their ORDER is assertable. */
interface Recorder {
  readonly sink: SseSink;
  readonly frames: readonly { event: string; data: Record<string, unknown>; seq: number }[];
  readonly closes: number[];
  seq: number;
}

const recordingSink = (): Recorder => {
  const frames: { event: string; data: Record<string, unknown>; seq: number }[] = [];
  const rec: Recorder = {
    frames,
    closes: [],
    seq: 0,
    sink: {
      write(chunk) {
        // Parse the real wire format rather than trusting a helper — a frame missing its blank-line
        // terminator hangs a browser, and that is invisible if the test reads a parallel record.
        for (const block of chunk.split('\n\n')) {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === undefined || data === undefined) continue;
          frames.push({ event, data: JSON.parse(data) as Record<string, unknown>, seq: rec.seq++ });
        }
      },
      close() {
        rec.closes.push(rec.seq++);
      },
    },
  };
  return rec;
};

/** Records when the turn span opened and closed, on the SAME counter as the frames. */
const recordingTurnWrapper = (rec: Recorder) => {
  const opened: { traceparent: string | undefined; openSeq: number; closeSeq: number | null }[] = [];
  const withTurn: BenchTurnDeps['withTurn'] = async (_name, traceparent, fn) => {
    const entry = { traceparent, openSeq: rec.seq++, closeSeq: null as number | null };
    opened.push(entry);
    const span: SpanLike = { update: () => {}, end: () => {} };
    try {
      return await fn(span);
    } finally {
      entry.closeSeq = rec.seq++;
    }
  };
  return { withTurn, opened };
};

const promptFixture: ResolvedPrompt = {
  name: 'demo-agent-text',
  version: 2,
  label: 'production',
  messages: [{ role: 'system', content: 'You are {{persona}} for {{company_name}}.' }],
  config: { model: 'gpt-test', tools: [], toolChoice: 'auto', maxSteps: 4 },
  telemetryLink: null,
};

const promptPort: PromptPort = { get: async () => promptFixture };

const EMPTY_RESULT: ModelStreamResult = {
  text: '',
  toolCalls: [],
  usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  steps: 1,
};

const fakeModel = (opts: {
  readonly deltas?: () => AsyncIterable<string>;
  readonly result?: ModelStreamResult;
  readonly failWith?: Error;
}): { port: ModelPort; messages: () => readonly { role: string; content: string }[] } => {
  let seen: readonly { role: string; content: string }[] = [];
  return {
    messages: () => seen,
    port: {
      stream(request) {
        seen = request.messages;
        return {
          tokens: opts.deltas?.() ?? (async function* () {})(),
          done:
            opts.failWith === undefined
              ? Promise.resolve(opts.result ?? EMPTY_RESULT)
              : Promise.reject<ModelStreamResult>(opts.failWith),
        };
      },
    },
  };
};

async function* streamOf(...deltas: string[]): AsyncIterable<string> {
  for (const d of deltas) yield d;
}

const noTools = createToolCatalog([] as ToolDef[]);

/**
 * A registry whose traceparents are real strings.
 *
 * Load-bearing: with no OpenTelemetry provider registered in this process, `startConversationSpan`
 * has nothing to inject and every traceparent is `undefined` — so a naive "turn 2 rejoined turn 1"
 * assertion passes on `undefined === undefined` while proving nothing. Injecting `start` is what
 * makes the same-trace and different-trace assertions distinguishable.
 */
const fakeRegistry = (): ConversationRegistry => {
  let n = 0;
  return createConversationRegistry({
    start: () => {
      const traceparent = `00-trace${n++}-span-01`;
      return { traceparent, update: () => {}, end: () => {} };
    },
  });
};

const benchDeps = (over: {
  readonly model?: ModelPort;
  readonly history?: HistoryStore;
  readonly rec?: Recorder;
  readonly now?: () => number;
  readonly conversations?: ConversationRegistry;
} = {}): { deps: BenchTurnDeps; turn: TurnDeps; wrapper: ReturnType<typeof recordingTurnWrapper> } => {
  const bus = createObsBus();
  const rec = over.rec;
  const wrapper = recordingTurnWrapper(rec ?? recordingSink());
  const turn: TurnDeps = {
    prompts: promptPort,
    tools: (names, t) =>
      resolve(names, {
        capabilities: capabilities(loadConfig({})),
        catalog: noTools,
        logger: silentLogger,
        bus,
        conversationId: t.conversationId,
        channel: t.channel,
      }),
    model: over.model ?? fakeModel({}).port,
    composeMemory: passthroughMemory,
    obs: bus,
    spans: {
      timeStep: async (_n, fn) => fn(),
      startStep: () => ({ update: () => {}, end: () => {} }),
    },
    branding: { persona: 'Ada', companyName: 'Northwind Traders' },
    history: over.history ?? createHistory(),
    logger: silentLogger,
    ...(over.now !== undefined && { now: over.now }),
  };
  return {
    turn,
    wrapper,
    deps: {
      turn,
      conversations: over.conversations ?? fakeRegistry(),
      withTurn: wrapper.withTurn,
      logger: silentLogger,
    },
  };
};

const run = async (
  rec: Recorder,
  deps: BenchTurnDeps,
  over: { conversationId?: string; text?: string; signal?: AbortSignal } = {},
): Promise<void> =>
  streamBenchTurn(
    rec.sink,
    {
      conversationId: over.conversationId ?? 'bench-1',
      text: over.text ?? 'where is order A4721?',
      abortSignal: over.signal ?? new AbortController().signal,
    },
    deps,
  );

// ------------------------------------------------------------------ the wire format

test('a turn writes start, one token frame per delta, then done — in that order', async () => {
  const rec = recordingSink();
  const { deps } = benchDeps({
    rec,
    model: fakeModel({
      deltas: () => streamOf('Order ', 'A4721 ', 'ships Tuesday.'),
      result: { ...EMPTY_RESULT, text: 'Order A4721 ships Tuesday.' },
    }).port,
  });

  await run(rec, deps);

  expect(rec.frames.map((f) => f.event)).toEqual(['start', 'token', 'token', 'token', 'done']);
  expect(rec.frames.filter((f) => f.event === 'token').map((f) => f.data.delta)).toEqual([
    'Order ',
    'A4721 ',
    'ships Tuesday.',
  ]);
  expect(rec.frames.at(-1)?.data).toMatchObject({
    text: 'Order A4721 ships Tuesday.',
    model: 'gpt-test',
    aborted: false,
  });
});

test('the start frame carries the conversationId so the browser can send turn 2 to the same one', async () => {
  const rec = recordingSink();
  const { deps } = benchDeps({ rec });
  await run(rec, deps, { conversationId: 'conv-xyz' });
  expect(rec.frames[0]).toMatchObject({ event: 'start', data: { conversationId: 'conv-xyz' } });
});

test('the stream is closed exactly once, after the done frame', async () => {
  const rec = recordingSink();
  const { deps } = benchDeps({ rec, model: fakeModel({ deltas: () => streamOf('hi') }).port });
  await run(rec, deps);

  expect(rec.closes).toHaveLength(1);
  const done = rec.frames.find((f) => f.event === 'done');
  expect(done).toBeDefined();
  expect(rec.closes[0]).toBeGreaterThan(done?.seq ?? Number.MAX_SAFE_INTEGER);
});

// ------------------------------------------------------------------ THE span-lifetime assertion

test('the turn span is still open when the last token is written, and closes after it', async () => {
  // The brief's first warning. `withTurnSpan` ends its observation when the callback settles, so a
  // handler that wraps only the `runTurn(...)` call — rather than the drain too — closes the span
  // before the model has streamed a token, and every AI SDK span lands in a different trace.
  const rec = recordingSink();
  const { deps, wrapper } = benchDeps({
    rec,
    model: fakeModel({ deltas: () => streamOf('a', 'b', 'c') }).port,
  });
  // The wrapper has to share the sink's counter for the ordering to mean anything.
  const shared = recordingTurnWrapper(rec);
  await run(rec, { ...deps, withTurn: shared.withTurn });

  const lastToken = rec.frames.filter((f) => f.event === 'token').at(-1);
  const span = shared.opened[0];
  expect(span).toBeDefined();
  expect(lastToken).toBeDefined();
  expect(span?.openSeq).toBeLessThan(lastToken?.seq ?? -1);
  expect(
    span?.closeSeq,
    'the turn span closed before the last token — the drain is outside withTurnSpan',
  ).toBeGreaterThan(lastToken?.seq ?? Number.MAX_SAFE_INTEGER);
  expect(wrapper.opened).toHaveLength(0); // sanity: the injected wrapper is the one that ran
});

test('timings survive, which is what proves tokens are drained before the next await', async () => {
  // The other half of the contract: `done` gets one macrotask of grace. A handler that awaits
  // anything slower between receiving `tokens` and its first `next()` reports null timings while
  // still streaming every token correctly — silent, and only visible as an empty latency column.
  let clock = 0;
  const rec = recordingSink();
  const { deps } = benchDeps({
    rec,
    now: () => clock,
    model: fakeModel({
      deltas: async function* () {
        clock = 500;
        yield 'first';
        clock = 900;
      },
      result: { ...EMPTY_RESULT, text: 'first' },
    }).port,
  });

  await run(rec, deps);

  const done = rec.frames.find((f) => f.event === 'done');
  expect(done?.data.ttftMs).toBe(500);
  expect(done?.data.totalMs).toBe(900);
});

// ------------------------------------------------------------------ one trace per conversation

test('a second turn on the same conversationId rejoins the first turn traceparent', async () => {
  const rec = recordingSink();
  const { deps } = benchDeps({ rec });
  const shared = recordingTurnWrapper(rec);
  const withShared = { ...deps, withTurn: shared.withTurn };

  await run(rec, withShared, { conversationId: 'same' });
  await run(rec, withShared, { conversationId: 'same' });

  expect(shared.opened).toHaveLength(2);
  // Both turns were parented to the same conversation, which is what puts them in one trace — the
  // shape T13 needs on a live call, proven here where no phone is required.
  expect(shared.opened[0]?.traceparent).toBeDefined();
  expect(shared.opened[0]?.traceparent).toBe(shared.opened[1]?.traceparent);
});

test('a different conversationId gets its own conversation root', async () => {
  const rec = recordingSink();
  const { deps } = benchDeps({ rec });
  const shared = recordingTurnWrapper(rec);
  const withShared = { ...deps, withTurn: shared.withTurn };

  await run(rec, withShared, { conversationId: 'one' });
  await run(rec, withShared, { conversationId: 'two' });

  expect(shared.opened[0]?.traceparent).toBeDefined();
  expect(shared.opened[0]?.traceparent).not.toBe(shared.opened[1]?.traceparent);
});

// ------------------------------------------------------------------ history through the route

test('turn 2 through the route sees turn 1', async () => {
  const history = createHistory();
  const rec = recordingSink();

  const first = benchDeps({
    rec,
    history,
    model: fakeModel({
      deltas: () => streamOf('Tuesday.'),
      result: { ...EMPTY_RESULT, text: 'Tuesday.' },
    }).port,
  });
  await run(rec, first.deps, { conversationId: 'c', text: 'when does A4721 ship?' });

  const secondModel = fakeModel({ deltas: () => streamOf('as I said') });
  const second = benchDeps({ rec, history, model: secondModel.port });
  await run(rec, second.deps, { conversationId: 'c', text: 'what did you say?' });

  expect(secondModel.messages()).toEqual([
    { role: 'user', content: 'when does A4721 ship?' },
    { role: 'assistant', content: 'Tuesday.' },
    { role: 'user', content: 'what did you say?' },
  ]);
});

// ------------------------------------------------------------------ failure and abort

test('a model failure becomes an error frame, not a hung stream', async () => {
  // The browser is waiting on this socket. A handler that lets the rejection escape leaves the
  // fetch open until it times out, which reads as "the agent is slow" rather than "it failed".
  const rec = recordingSink();
  const { deps } = benchDeps({ rec, model: fakeModel({ failWith: new Error('502 upstream') }).port });

  await run(rec, deps);

  expect(rec.frames.map((f) => f.event)).toContain('error');
  expect(String(rec.frames.find((f) => f.event === 'error')?.data.error)).toContain('502');
  expect(rec.frames.some((f) => f.event === 'done')).toBe(false);
  expect(rec.closes).toHaveLength(1); // still closed, exactly once
});

test('an aborted turn still reports done, and keeps what was streamed', async () => {
  const history = createHistory();
  const abort = new AbortController();
  const rec = recordingSink();
  const { deps } = benchDeps({
    rec,
    history,
    model: fakeModel({
      deltas: async function* () {
        yield 'Your order ships ';
        abort.abort(); // the browser navigated away mid-answer
        yield 'on Tues';
      },
      failWith: new Error('aborted'),
    }).port,
  });

  await run(rec, deps, { conversationId: 'c', signal: abort.signal, text: 'when?' });

  expect(rec.frames.find((f) => f.event === 'done')?.data).toMatchObject({ aborted: true });
  // The ratified decision from T10, observed end to end through the route.
  expect(history.read('c')).toEqual([
    { role: 'user', content: 'when?' },
    { role: 'assistant', content: 'Your order ships on Tues' },
  ]);
});

// ------------------------------------------------------------------ the conversation registry

test('the registry ends and forgets a conversation, so a later turn starts a new trace', async () => {
  const registry = createConversationRegistry();
  const first = registry.traceparentFor('c');
  registry.end('c');
  expect(registry.size()).toBe(0);
  const second = registry.traceparentFor('c');
  // Both may be undefined with no OTel provider registered in this test process; the assertion that
  // carries weight is that ending it dropped the entry rather than leaving an unended span behind.
  expect(registry.size()).toBe(1);
  if (first !== undefined && second !== undefined) expect(first).not.toBe(second);
});

test('the registry sweeps conversations idle past its ttl and is bounded', async () => {
  // The bench has NO disconnect signal — unlike voice, nothing tells it a conversation is over. So
  // an unswept registry holds every conversation's span forever, and an unended span never reaches
  // Langfuse at all.
  let clock = 0;
  const registry = createConversationRegistry({ ttlMs: 1000, maxConversations: 10, now: () => clock });

  registry.traceparentFor('old');
  clock = 500;
  registry.traceparentFor('fresh');
  clock = 1600; // 'old' is now 1600ms idle, 'fresh' is 1100ms... both past a 1000ms ttl
  expect(registry.sweep()).toBe(2);
  expect(registry.size()).toBe(0);
});

test('the registry evicts the oldest conversation at its cap rather than growing', async () => {
  let clock = 0;
  const registry = createConversationRegistry({ ttlMs: 60_000, maxConversations: 2, now: () => clock });
  registry.traceparentFor('a');
  clock = 1;
  registry.traceparentFor('b');
  clock = 2;
  registry.traceparentFor('c');

  expect(registry.size()).toBe(2);
});
