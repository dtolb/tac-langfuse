import { test, expect } from 'vitest';
import { buildApp } from '../server/http/app.ts';
import { capabilities, loadConfig } from '../server/config.ts';
import { createHistory } from '../server/agent/history.ts';
import { passthroughMemory } from '../server/agent/memory.ts';
import { createToolCatalog } from '../server/agent/tools/catalog.ts';
import { resolve } from '../server/agent/tools/resolve.ts';
import type { ToolDef, ToolLogger } from '../server/agent/tools/registry.ts';
import type { ModelPort } from '../server/agent/model/port.ts';
import type { PromptPort } from '../server/agent/prompt/port.ts';
import type { TurnDeps } from '../server/agent/types.ts';
import { createObsBus } from '../server/obs/bus.ts';
import { BENCH_TURN_PATH } from '../shared/twilio-paths.ts';

/**
 * The bench route over a REAL SOCKET.
 *
 * This file exists because of a bug the `SseSink` unit tests structurally could not catch. Those
 * pass an `AbortSignal` straight in, so they exercise `streamBenchTurn` and skip the Fastify
 * adapter — and the adapter is where the defect was: it wired client-disconnect to
 * `request.raw.on('close')`, copying the pattern that is correct in `routes-obs.ts`.
 *
 * MEASURED: on a POST, `request.raw 'close'` fires when the REQUEST BODY STREAM is consumed
 * (+3 ms), not when the client goes away. On a GET it fires at the end of the response (+906 ms),
 * which is why the same line is correct for the obs stream and wrong here. Every bench turn
 * therefore aborted before its first token: `aborted: true`, no tokens, `ttftMs: null` — while the
 * HTTP request itself looked completely healthy.
 *
 * The lesson is the test, not the fix: anything that depends on Fastify's request/response
 * lifecycle has to be driven over a socket.
 */

const silentLogger: ToolLogger = { debug: () => {}, warn: () => {}, error: () => {} };

const promptPort: PromptPort = {
  get: async () => ({
    name: 'demo-agent-text',
    version: 2,
    label: 'production',
    messages: [{ role: 'system', content: 'You are {{persona}}.' }],
    config: { model: 'gpt-test', tools: [], toolChoice: 'auto', maxSteps: 4 },
    telemetryLink: null,
  }),
};

const fakeTurnDeps = (deltas: string[], text: string): TurnDeps => {
  const bus = createObsBus();
  const model: ModelPort = {
    stream: () => ({
      tokens: (async function* () {
        for (const d of deltas) {
          // A real macrotask between deltas, so the response genuinely streams over time rather
          // than arriving in one write — which is the condition the abort bug needed to show up.
          await new Promise((r) => void setTimeout(r, 15));
          yield d;
        }
      })(),
      done: Promise.resolve({
        text,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        steps: 1,
      }),
    }),
  };
  return {
    prompts: promptPort,
    tools: (names, t) =>
      resolve(names, {
        capabilities: capabilities(loadConfig({})),
        catalog: createToolCatalog([] as ToolDef[]),
        logger: silentLogger,
        bus,
        conversationId: t.conversationId,
        channel: t.channel,
      }),
    model,
    composeMemory: passthroughMemory,
    obs: bus,
    spans: {
      timeStep: async (_n, fn) => fn(),
      startStep: () => ({ update: () => {}, end: () => {} }),
    },
    branding: { persona: 'Ada', companyName: 'Northwind Traders' },
    history: createHistory(),
    logger: silentLogger,
  };
};

interface Frame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

const parseFrames = (body: string): Frame[] => {
  const frames: Frame[] = [];
  for (const block of body.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event === undefined || data === undefined) continue;
    frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return frames;
};

/** A listening app on an ephemeral port. Closed by the caller. */
const serve = async (turn?: TurnDeps) => {
  // A key value is enough to make `capabilities.llm` true; the model port is injected, so nothing
  // ever calls OpenAI. This is what lets the whole HTTP path be tested on a bare machine.
  const config = loadConfig({ OPENAI_API_KEY: 'sk-test-not-used', APP_NAME: 'bench-test' });
  const built = buildApp({ config, caps: capabilities(config), ...(turn !== undefined && { turn }) });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const address = built.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      built.bench.shutdown();
      built.obs.shutdown();
      await built.app.close();
    },
  };
};

test('a POST streams token frames and does NOT report itself aborted', async () => {
  // The regression test for the request.raw/reply.raw bug. `aborted: false` is the whole assertion:
  // before the fix this came back `true` with zero tokens, and the HTTP status was still 200.
  const server = await serve(fakeTurnDeps(['Order ', 'A4721 ', 'ships Tuesday.'], 'Order A4721 ships Tuesday.'));
  try {
    const res = await fetch(`${server.url}${BENCH_TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'where is order A4721?' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // The header that stops an nginx in the path buffering the whole "live" stream into one lump.
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const frames = parseFrames(await res.text());
    expect(frames.map((f) => f.event)).toEqual(['start', 'token', 'token', 'token', 'done']);
    expect(frames.filter((f) => f.event === 'token').map((f) => f.data.delta).join('')).toBe(
      'Order A4721 ships Tuesday.',
    );

    const done = frames.at(-1)?.data;
    expect(done?.aborted, 'the turn aborted itself — see this file header').toBe(false);
    expect(done?.text).toBe('Order A4721 ships Tuesday.');
    // Non-null timings prove the drain happened inside the span and promptly enough.
    expect(done?.ttftMs).not.toBeNull();
    expect(done?.totalMs).not.toBeNull();
  } finally {
    await server.close();
  }
});

test('the start frame gives the browser a conversationId it can reuse for turn 2', async () => {
  const server = await serve(fakeTurnDeps(['hi'], 'hi'));
  try {
    const first = await fetch(`${server.url}${BENCH_TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const started = parseFrames(await first.text())[0];
    expect(started?.event).toBe('start');
    const conversationId = started?.data.conversationId;
    expect(typeof conversationId).toBe('string');

    const second = await fetch(`${server.url}${BENCH_TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'again', conversationId }),
    });
    expect(parseFrames(await second.text())[0]?.data.conversationId).toBe(conversationId);
  } finally {
    await server.close();
  }
});

test('an empty message is rejected as a bad request rather than sent to the model', async () => {
  const server = await serve(fakeTurnDeps(['hi'], 'hi'));
  try {
    const res = await fetch(`${server.url}${BENCH_TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('bad_request');
  } finally {
    await server.close();
  }
});

test('with no OPENAI_API_KEY the route answers 503 naming the variable, not 404', async () => {
  // The house degradation contract: the page stays inspectable and says what is missing.
  const config = loadConfig({});
  const built = buildApp({ config, caps: capabilities(config) });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const address = built.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${BENCH_TURN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; missing: unknown };
    expect(body.error).toBe('not_configured');
    expect(JSON.stringify(body.missing)).toContain('OPENAI_API_KEY');
  } finally {
    built.bench.shutdown();
    built.obs.shutdown();
    await built.app.close();
  }
});
