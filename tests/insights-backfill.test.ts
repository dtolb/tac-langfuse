/**
 * Draws a real ConversationRelay call's Voice Insights Events (`fixtures/voice-insights-events.json`,
 * CA6e702727faa1cfb926deb093a536d2da, account SID and edge metadata stripped) under an already-ended
 * `conversation.voice` root, through `createInsightsBackfill`, into an in-memory exporter.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { startConversationSpan } from '../server/obs/spans.ts';
import { relayEvents, type InsightsClient } from '../server/twilio/cr-insights.ts';
import { createInsightsBackfill } from '../server/twilio/insights-backfill.ts';

const storage = new AsyncLocalStorage<Context>();
const contextManager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (ctx, fn, thisArg, ...args) => storage.run(ctx, () => fn.call(thisArg, ...args)),
  bind: (_ctx, target) => target,
  enable() {
    return this;
  },
  disable() {
    storage.disable();
    return this;
  },
};

const w3c = {
  fields: () => ['traceparent'],
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const sc = trace.getSpanContext(ctx);
    if (sc !== undefined) setter.set(carrier, 'traceparent', `00-${sc.traceId}-${sc.spanId}-01`);
  },
  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const [, traceId, spanId] = String(getter.get(carrier, 'traceparent') ?? '').split('-');
    if (traceId === undefined || spanId === undefined) return ctx;
    return trace.setSpanContext(ctx, { traceId, spanId, isRemote: true, traceFlags: TraceFlags.SAMPLED });
  },
};

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  setLangfuseTracerProvider(provider);
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(w3c);
});

afterAll(() => {
  setLangfuseTracerProvider(null);
  context.disable();
  propagation.disable();
});

const ms = (t: readonly [number, number]): number => Math.round(t[0] * 1000 + t[1] / 1e6);
const meta = (s: ReadableSpan, key: string): unknown => s.attributes[`langfuse.observation.metadata.${key}`];
const at = (iso: string): number => Date.parse(`2026-11-06T${iso}Z`);

const fixture = JSON.parse(readFileSync(new URL('./fixtures/voice-insights-events.json', import.meta.url), 'utf8')) as {
  callSid: string;
  events: Parameters<typeof relayEvents>[0];
};

test('a real call’s Voice Insights Events draw under the ended call root at Twilio’s timestamps', async () => {
  const root = startConversationSpan('conversation.voice', { conversationId: 'conv-1' });
  root.end();
  const rootSpan = exporter.getFinishedSpans().find((s) => s.name === 'conversation.voice') as ReadableSpan;

  const fetched: string[] = [];
  const insights: InsightsClient = {
    fetch: async (callSid) => {
      fetched.push(callSid);
      return { events: relayEvents(fixture.events), summary: null };
    },
  };
  const logged: string[] = [];
  const backfill = createInsightsBackfill({
    insights,
    delayMs: 0,
    logger: { info: (_f, msg) => logged.push(msg), warn: (_f, msg) => logged.push(msg) },
  });

  const result = await backfill.callEnded(fixture.callSid, { traceparent: root.traceparent, sessionId: 'conv-1', userId: 'mem_profile_1' });

  expect(fetched).toEqual([fixture.callSid]);
  expect(result).toEqual({ stt: 7, tts: 7, agentSpeech: 8, customerSpeech: 7, events: 4, wrappedUp: true });
  expect(logged).toHaveLength(1);

  const drawn = exporter.getFinishedSpans().filter((s) => s.name.startsWith('twilio.'));
  const count = (name: string): number => drawn.filter((s) => s.name === name).length;
  expect(count('twilio.interrupt')).toBe(3);
  expect(count('twilio.call_wrap_up')).toBe(1);
  expect(drawn.some((s) => /prompt_sent|first_token|final_token|configurations/.test(s.name))).toBe(false);
  for (const s of drawn) {
    expect(s.spanContext().traceId).toBe(rootSpan.spanContext().traceId);
    expect(s.parentSpanContext?.spanId).toBe(rootSpan.spanContext().spanId);
  }

  const tts = drawn.filter((s) => s.name === 'twilio.tts');
  for (const s of tts) expect(ms(s.endTime) - ms(s.startTime)).toBe(Number(meta(s, 'latency_ms')));
  const firstTts = tts.find((s) => meta(s, 'sequence_number') === '14') as ReadableSpan;
  expect([ms(firstTts.startTime), ms(firstTts.endTime)]).toEqual([at('20:44:16.829') - 175, at('20:44:16.829')]);

  const firstStt = drawn.find((s) => s.name === 'twilio.stt' && meta(s, 'sequence_number') === '10') as ReadableSpan;
  expect([ms(firstStt.startTime), ms(firstStt.endTime)]).toEqual([at('20:44:15.044') - 2470, at('20:44:15.044')]);

  const greeting = drawn.find((s) => s.name === 'twilio.agent_speech' && meta(s, 'start_sequence_number') === '4') as ReadableSpan;
  expect([ms(greeting.startTime), ms(greeting.endTime), meta(greeting, 'end_sequence_number')]).toEqual([at('20:44:00.543'), at('20:44:04.773'), '5']);

  const caller = drawn.find((s) => s.name === 'twilio.customer_speech' && meta(s, 'sequence_number') === '6') as ReadableSpan;
  expect([ms(caller.startTime), ms(caller.endTime)]).toEqual([at('20:44:06.104'), at('20:44:15.044') - 2470]);

  const wrapUp = drawn.find((s) => s.name === 'twilio.call_wrap_up') as ReadableSpan;
  expect([ms(wrapUp.startTime), ms(wrapUp.endTime), meta(wrapUp, 'end_status')]).toEqual([at('20:45:25.645'), at('20:45:25.645'), 'ended']);
});
